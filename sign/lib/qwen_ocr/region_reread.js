'use strict';

// 按**人画的框**重读票面字段(P2-b,0731)。
//
// 为什么要裁了再读,而不是像正常路那样"整张原图读字段":
//   正常路是一次 qwen 调用同时出「切分框 + 分类 + 字段」,字段读的是整张原图 ——
//   那是给**切对了**的情况设计的。而人会去画框,前提恰恰是自动切分错了:
//   一张照片上两张票、或者票被切掉一半。这种图整张读出来的字段本来就是混的
//   (模型不知道你要哪一张)。裁出人指的那一块再读,才是在回答"这张票是什么"。
//
// 分辨率上也有增益,但**别夸大**:0731 拿本地真金标图量过,同一张票
// 「整图缩到 1600」和「裁出来再缩到 1600」相比,增益 11% / 13% / 50%(三张图),
// 不是我一开始写的"400px → 1600px"那种量级 —— 因为这些原图本身只有
// 1800~2400 宽(生产原图中位数 1920),裁片压根到不了 1600 上限。
// 所以这功能的主要价值是**隔离**(模型只看见该看的那一张),不是分辨率;
// 分辨率只在票占画面比例很小时才明显(上面那张 0.33 占比的拿到了 50%)。
//
// 范式抄 nationality_probe.js:同样是裁 bbox → 聚焦 prompt → 按
// mtime+size+bbox+版本 做缓存(补拍换图 / 改框都自动失效)。
// 同样**绝不抛**:读不出就返回空字段,由调用方决定怎么提示,
// 不能因为一次重读失败把审核台整页搞挂。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const REREAD_VERSION = 'rr1';
const CACHE_SUFFIX = '.regionread.json';

// 裁切外扩:框是人手画的,边缘容易压着字。给一点余量,但别多到把邻票也框进来。
const PAD_PCT = 0.012;

function cachePathFor(imagePath) {
  return path.join(path.dirname(imagePath), `${path.basename(imagePath)}${CACHE_SUFFIX}`);
}

function cacheKeyOf(stat, bbox, docType) {
  return `${REREAD_VERSION}|${stat.mtimeMs}|${stat.size}|${(bbox || []).join(',')}|${docType}`;
}

/** bbox = 原图归一化 [x1,y1,x2,y2]。非法/退化框返回 null(调用方按"读不出"处理)。 */
function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const nums = bbox.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const x1 = Math.min(nums[0], nums[2]);
  const x2 = Math.max(nums[0], nums[2]);
  const y1 = Math.min(nums[1], nums[3]);
  const y2 = Math.max(nums[1], nums[3]);
  // 太小的框读不出东西,也多半是误触(手抖点一下)。1% 边长打底。
  if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return null;
  return [Math.max(0, x1), Math.max(0, y1), Math.min(1, x2), Math.min(1, y2)];
}

async function cropRegionBase64(imagePath, bbox, { maxEdge = 1600 } = {}) {
  const meta = await sharp(imagePath).metadata();
  // .rotate() 会按 EXIF 摆正,所以宽高要用**摆正后**的;metadata 给的是文件里的原始值。
  const rotated = (meta.orientation || 1) >= 5;
  const W = rotated ? (meta.height || 0) : (meta.width || 0);
  const H = rotated ? (meta.width || 0) : (meta.height || 0);
  if (!W || !H) return '';
  const left = Math.max(0, Math.round((bbox[0] - PAD_PCT) * W));
  const top = Math.max(0, Math.round((bbox[1] - PAD_PCT) * H));
  const right = Math.min(W, Math.round((bbox[2] + PAD_PCT) * W));
  const bottom = Math.min(H, Math.round((bbox[3] + PAD_PCT) * H));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return '';
  const buf = await sharp(imagePath).rotate()
    .extract({ left, top, width, height })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// 只问票面上**真有**的东西。团号/代理/收票日期不在票面上(来自团号表和建档),
// 问了只会让模型编 —— 这类"问了就有答案"的字段是幻觉重灾区。
const RECEIPT_PROMPT = '你是小票抄写员。图中是**一张**小票(已按人工框裁出)。'
  + '只输出 JSON:{"store":"免税店/百货店名,票面原文","receiptNo":"小票号或交易编号,原样含杠",'
  + '"purchaseDate":"购买日期 YYYY-MM-DD","amount":"金额,只要数字和逗号"}。'
  + '看不清或票面没有的字段留空字符串,**绝不猜、绝不推断**。';

function pickString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 按框重读票面字段。
 * @returns {{fields: {store,receiptNo,purchaseDate,amount}, source: 'cache'|'qwen'|''}}
 *   source='' 表示没读成(未配置 / 框非法 / 调用失败),fields 全空。绝不抛。
 */
async function rereadRegionFields(imagePath, {
  bbox,
  docType = 'receipt',
  apiKey = process.env.DASHSCOPE_API_KEY,
  baseUrl = process.env.QWEN_BASE_URL,
  model = process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
  fetchImpl = globalThis.fetch,
  timeoutMs = 45000,
  maxEdge = Number(process.env.QWEN_REGION_MAX_EDGE) || 1600,
} = {}) {
  const empty = { store: '', receiptNo: '', purchaseDate: '', amount: '' };
  try {
    const box = normalizeBbox(bbox);
    if (!box) return { fields: { ...empty }, source: '' };

    const stat = await fsp.stat(imagePath);
    const key = cacheKeyOf(stat, box, docType);
    const cachePath = cachePathFor(imagePath);
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && cached.key === key && cached.fields) {
        return { fields: { ...empty, ...cached.fields }, source: 'cache' };
      }
    } catch { /* 无缓存/坏缓存 → 现读 */ }

    if (!apiKey || !baseUrl || typeof fetchImpl !== 'function') {
      return { fields: { ...empty }, source: '' }; // 未配置 → 静默回退,不是错误
    }

    const imageBase64Url = await cropRegionBase64(imagePath, box, { maxEdge });
    if (!imageBase64Url) return { fields: { ...empty }, source: '' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload;
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: RECEIPT_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: '照抄这张票的门店/票号/购买日期/金额,仅输出 JSON。' },
                { type: 'image_url', image_url: { url: imageBase64Url } },
              ],
            },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res || !res.ok) return { fields: { ...empty }, source: '' };
      payload = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const raw = payload?.choices?.[0]?.message?.content;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const fields = {
      store: pickString(parsed.store),
      receiptNo: pickString(parsed.receiptNo),
      purchaseDate: pickString(parsed.purchaseDate),
      amount: pickString(parsed.amount),
    };
    // 全空就别写缓存:下次还该真读一次,而不是把一次失败固化成"这张就是读不出"
    if (Object.values(fields).some(Boolean)) {
      try {
        fs.writeFileSync(cachePathFor(imagePath), JSON.stringify({ key, fields }), 'utf8');
      } catch { /* 缓存写不进不影响本次结果 */ }
    }
    return { fields, source: 'qwen' };
  } catch {
    return { fields: { ...empty }, source: '' };
  }
}

module.exports = { rereadRegionFields, normalizeBbox, cachePathFor, REREAD_VERSION };
