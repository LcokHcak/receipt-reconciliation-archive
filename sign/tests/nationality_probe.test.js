'use strict';

// 国籍探针(0728 拍板:打码遮罩上露出国籍)行为锁:
// ①MRZ 本地解析优先且确定性(模型只抄字)②直答三字码兜底、自由文本拒收
// ③成功才缓存、缓存按 mtime+bbox 失效 ④无 key/HTTP 失败 → 空值不抛(调用方回退全遮)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { readPassportNationality, nationalityFromMrz2, NAT_CACHE_SUFFIX } = require('../lib/qwen_ocr/nationality_probe');
const { buildMaskOverlaySvg } = require('../lib/passport_mask');

test('nationalityFromMrz2:TD3 chars 11-13 确定性解析;残行/坏行回空', () => {
  assert.equal(nationalityFromMrz2('EJ47977165VNM9001255F3101017<<<<<<<<<<<<<<02'), 'VNM');
  assert.equal(nationalityFromMrz2('E123456785CHN8001010M2501012<<<<<<<<<<<<<<04'), 'CHN');
  assert.equal(nationalityFromMrz2('E12345'), '', '残行回空不硬凑');
  assert.equal(nationalityFromMrz2(''), '');
  assert.equal(nationalityFromMrz2('E1234567851239001255F3101017'), '', '数字占位不是国籍码');
});

async function makeImage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'combined.jpg');
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 240, g: 240, b: 240 } } })
    .jpeg().toFile(p);
  return p;
}

function fakeFetch(payload) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  });
}

test('探针:MRZ 抄写→本地解析;成功写缓存,二次调用零 fetch;直答三字码兜底', async (t) => {
  const img = await makeImage(t);
  let calls = 0;
  const fetchImpl = async (...args) => { calls += 1; return fakeFetch({ mrz2: 'EJ47977165VNM9001255F3101017<<<<<<<<<<<<<<02', nationality: '' })(...args); };
  const opts = { bbox: [0.5, 0, 1, 1], apiKey: 'k', baseUrl: 'http://fake', fetchImpl };

  const r1 = await readPassportNationality(img, opts);
  assert.deepEqual({ n: r1.nationality, s: r1.source }, { n: 'VNM', s: 'mrz' });
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(`${img}${NAT_CACHE_SUFFIX}`), '成功结果落缓存');

  const r2 = await readPassportNationality(img, opts);
  assert.deepEqual({ n: r2.nationality, s: r2.source }, { n: 'VNM', s: 'cache' });
  assert.equal(calls, 1, '缓存命中不再调 API');

  // bbox 变 → 缓存失效重调;直答兜底路径(mrz2 坏、nationality 三字码)
  const r3 = await readPassportNationality(img, {
    ...opts,
    bbox: [0.4, 0, 1, 1],
    fetchImpl: fakeFetch({ mrz2: 'garbage', nationality: 'chn' }),
  });
  assert.deepEqual({ n: r3.nationality, s: r3.source }, { n: 'CHN', s: 'direct' });
});

test('探针失败语义:无 key/HTTP 错/自由文本国籍 → 空值不抛,且失败不缓存', async (t) => {
  const img = await makeImage(t);
  const noKey = await readPassportNationality(img, { bbox: [0.5, 0, 1, 1], apiKey: '', baseUrl: '' });
  assert.deepEqual(noKey, { nationality: '', source: '' });

  const httpErr = await readPassportNationality(img, {
    bbox: [0.5, 0, 1, 1], apiKey: 'k', baseUrl: 'http://fake',
    fetchImpl: async () => ({ ok: false, text: async () => 'boom' }),
  });
  assert.equal(httpErr.nationality, '');
  assert.ok(!fs.existsSync(`${img}${NAT_CACHE_SUFFIX}`), '失败不缓存,下次导出还有机会');

  const freeText = await readPassportNationality(img, {
    bbox: [0.5, 0, 1, 1], apiKey: 'k', baseUrl: 'http://fake',
    fetchImpl: fakeFetch({ mrz2: '', nationality: '中国' }),
  });
  assert.equal(freeText.nationality, '', '自由文本国籍拒收(只认三位大写字母)');
});

test('遮罩渲染:带国籍时国籍行为主位大字;不带时保持 v1 单行;文字都在黑底上', () => {
  const withNat = buildMaskOverlaySvg({ width: 600, height: 400, nationalityText: '국적/Nationality: VNM' });
  assert.match(withNat, /국적\/Nationality: VNM/);
  assert.match(withNat, /PASSPORT MASKED/);
  assert.match(withNat, /fill="#fbbf24" [^>]*font-size="(\d+)" font-weight="bold"/, '国籍行大号琥珀加粗');
  const natSize = Number(withNat.match(/font-size="(\d+)" font-weight="bold"/)[1]);
  const baseSize = Number(withNat.match(/fill="#9ca3af" [^>]*font-size="(\d+)"/)[1]);
  assert.ok(natSize > baseSize, '国籍字号必须大于水印字号');
  const v1 = buildMaskOverlaySvg({ width: 600, height: 400 });
  assert.ok(!v1.includes('Nationality:'), '无国籍时不渲染国籍行');
  assert.match(v1, /PASSPORT MASKED/);
});

test('接线契约:交付包打码前读国籍、印在遮罩上、回执带 shown/missing 计数', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/lotte_dept_delivery_export_service.js'), 'utf8');
  assert.match(src, /readPassportNationality\(entry\.sourcePath, \{ bbox: entry\.maskBbox \}\)/);
  assert.match(src, /nationalityText: nat\.nationality \? `국적\/Nationality: \$\{nat\.nationality\}` : ''/);
  assert.match(src, /nationalityShown/);
  assert.match(src, /nationalityMissingSamples/);
});
