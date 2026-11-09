'use strict';

// 护照国籍聚焦探针(2026-07-28 用户拍板:打码遮罩上必须露出国籍)。
//
// 场景:乐天百货交付包的同框图打码——护照区整体涂黑后,把国籍以文字印在遮罩上
// (信息露出且零位置泄漏风险;比"开窗露国籍行"稳:不怕旋转/版式漂移露出邻行)。
// 国籍值在既有持久化数据里不存在(sidecar 不存 MRZ 行),故导出打码时按需做一次
// **聚焦调用**:只把护照 bbox 裁片发给 qwen,要它照抄 MRZ 第二行,国籍由本地
// parse(chars 11-13)确定性解出——模型只负责"抄字",语义判断不交给它。
//
// 成本控制:仅乐天同框图打码路径调用(小流量);结果缓存 <图>.nat.json
// (键含 mtime+bbox+版本,补拍换图自动失效),重复导出零 API 成本。
// 失败语义:无 key/超时/解析不出 → { nationality: '' },调用方回退"全遮不印字"
// 并把该张列进 nationalityMissing 名单(可见,不阻断导出)。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const sharp = require('sharp');

const { cleanMrz } = require('./mrz_parser');
const { parseJsonLoose } = require('./qwen_client');

const NAT_CACHE_SUFFIX = '.nat.json';
const PROBE_VERSION = 1;

// MRZ 第二行 chars 11-13 = 国籍三字码(TD3);模型直答 nationality 仅作兜底,
// 且只认三位大写字母(防模型答"中国/China"这类自由文本)。
function nationalityFromMrz2(mrz2) {
  const l2 = cleanMrz(mrz2);
  if (l2.length < 13) return '';
  const nat = l2.slice(10, 13).replace(/</g, '');
  return /^[A-Z]{3}$/.test(nat) ? nat : '';
}

function normalizeDirectNationality(value) {
  const v = String(value || '').toUpperCase().trim();
  return /^[A-Z]{3}$/.test(v) ? v : '';
}

function cachePathFor(imagePath) {
  return `${imagePath}${NAT_CACHE_SUFFIX}`;
}

function cacheKeyOf(stat, bbox) {
  return `${PROBE_VERSION}|${stat.mtimeMs}|${stat.size}|${(bbox || []).join(',')}`;
}

async function cropPassportRegionBase64(imagePath, bbox) {
  const meta = await sharp(imagePath).metadata();
  let W = Number(meta.width || 0);
  let H = Number(meta.height || 0);
  if (Number(meta.orientation) >= 5) [W, H] = [H, W]; // rotate() 后宽高互换(与裁片服务同口径)
  if (!W || !H) return '';
  const pad = 0.02;
  const left = Math.max(0, Math.round((Number(bbox[0]) - pad) * W));
  const top = Math.max(0, Math.round((Number(bbox[1]) - pad) * H));
  const width = Math.min(W, Math.round((Number(bbox[2]) + pad) * W)) - left;
  const height = Math.min(H, Math.round((Number(bbox[3]) + pad) * H)) - top;
  if (width < 32 || height < 32) return '';
  const buf = await sharp(imagePath).rotate()
    .extract({ left, top, width, height })
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * 读同框图护照区的国籍。返回 { nationality, source } —— nationality=''(读不出)时
 * 调用方自行回退;绝不抛(导出打码链路宁可少印一行字,不许因探针挂掉)。
 * source: 'cache' | 'mrz' | 'direct' | ''(失败)
 */
async function readPassportNationality(imagePath, {
  bbox,
  apiKey = process.env.DASHSCOPE_API_KEY,
  baseUrl = process.env.QWEN_BASE_URL,
  model = process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  try {
    const stat = await fsp.stat(imagePath);
    const key = cacheKeyOf(stat, bbox);
    const cachePath = cachePathFor(imagePath);
    // 缓存命中(键含 mtime+size+bbox+版本:补拍换图/换框自动失效)
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && cached.key === key) {
        return { nationality: String(cached.nationality || ''), source: 'cache' };
      }
    } catch { /* 无缓存/坏缓存 → 现读 */ }

    if (!apiKey || !baseUrl) return { nationality: '', source: '' }; // 未配置 → 静默回退

    const imageBase64Url = await cropPassportRegionBase64(imagePath, bbox);
    if (!imageBase64Url) return { nationality: '', source: '' };

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: '你是护照机读区(MRZ)抄写器。图中是护照资料页(或其局部)。'
            + '只输出 JSON:{"mrz2":"机读区第二行,原样照抄含<","nationality":"国籍三字码,如CHN/VNM"}。'
            + '读不清的字段留空字符串,绝不猜。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '照抄 MRZ 第二行并给出国籍三字码,仅输出 JSON。' },
            { type: 'image_url', image_url: { url: imageBase64Url } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    };
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { nationality: '', source: '' };
    const json = await res.json();
    const parsed = parseJsonLoose(json?.choices?.[0]?.message?.content || '{}');
    // MRZ 本地解析优先(模型只抄字,语义判断在本地确定性完成);直答三字码兜底
    const fromMrz = nationalityFromMrz2(parsed.mrz2);
    const nationality = fromMrz || normalizeDirectNationality(parsed.nationality);
    const source = fromMrz ? 'mrz' : (nationality ? 'direct' : '');
    // 只缓存成功结果:失败不缓存,下次导出还有机会读出来(临时网络问题不该被钉死)
    if (nationality) {
      try {
        await fsp.writeFile(cachePathFor(imagePath), JSON.stringify({ key, nationality, source }));
      } catch { /* 缓存写失败不影响返回 */ }
    }
    return { nationality, source };
  } catch {
    return { nationality: '', source: '' };
  }
}

module.exports = { readPassportNationality, nationalityFromMrz2, NAT_CACHE_SUFFIX, PROBE_VERSION };
