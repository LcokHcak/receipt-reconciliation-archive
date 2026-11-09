'use strict';

/**
 * 按框重读票面字段(P2-b)。
 *
 * 这条路只有在**自动切分错了**的时候才会被走到 —— 人画框的前提就是机器切错了。
 * 所以它的失败模式必须是"读不出",不能是"抛异常把审核台搞挂",
 * 也不能是"编一个看起来对的答案"。下面按这两条写。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { rereadRegionFields, normalizeBbox, cachePathFor } = require('../lib/qwen_ocr/region_reread');

let tmpDir;
let imagePath;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'region-reread-'));
  imagePath = path.join(tmpDir, 'photo.jpg');
  // 800x600 的纯色图:内容无所谓,这条链路要验的是裁切几何 + 缓存 + 失败姿势
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cccccc' } })
    .jpeg().toFile(imagePath);
});

test.after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ⚠️ 每个用例必须用**自己的图**。缓存是写在图片旁边的 sidecar,
// 共用一张图 + 同一个框,后面的用例会命中前面写下的缓存 ——
// 于是"未配置 apiKey"那条其实走了缓存拿到真字段(那是**对的**行为:
// 缓存数据依然有效),而 prompt 那条压根没发出请求、sentBody 是 null。
// 第一版就是这么假红的:两条失败看着是两个 bug,其实是同一个测试污染。
let seq = 0;
async function freshImage() {
  const p = path.join(tmpDir, `img-${seq += 1}.jpg`);
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cccccc' } })
    .jpeg().toFile(p);
  return p;
}

function okResponse(fields) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(fields) } }] }),
  };
}

test('normalizeBbox:顺序颠倒能纠正,退化框判非法', () => {
  assert.deepEqual(normalizeBbox([0.6, 0.7, 0.2, 0.3]), [0.2, 0.3, 0.6, 0.7], '反着画的框要纠正');
  assert.equal(normalizeBbox([0.2, 0.2, 0.205, 0.9]), null, '窄到 0.5% 的框=手抖误触,不该发请求');
  assert.equal(normalizeBbox([0.2, 0.2, 0.9]), null, '长度不对');
  assert.equal(normalizeBbox(null), null);
  assert.equal(normalizeBbox([0.1, 0.1, NaN, 0.9]), null, 'NaN 不能混进裁切参数');
});

test('正常路:裁框 → 读回字段,并且发出去的确实是裁过的小图', async () => {
  let sentBody = null;
  const res = await rereadRegionFields(imagePath, {
    bbox: [0.1, 0.1, 0.5, 0.5],
    apiKey: 'k', baseUrl: 'https://example.invalid/v1',
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return okResponse({ store: 'THE SHILLA', receiptNo: '03-261-635-0022-9', purchaseDate: '2026-01-24', amount: '680,000' });
    },
  });
  assert.equal(res.source, 'qwen');
  assert.deepEqual(res.fields, {
    store: 'THE SHILLA', receiptNo: '03-261-635-0022-9',
    purchaseDate: '2026-01-24', amount: '680,000',
  });
  const img = sentBody.messages[1].content.find((c) => c.type === 'image_url').image_url.url;
  assert.match(img, /^data:image\/jpeg;base64,/);
  // 裁的是 40%×40%,编码后必须明显小于整图 —— 否则说明 extract 根本没生效,
  // 那就退化成"整图读"了,而整图读正是这个功能要绕开的东西。
  const whole = await sharp(imagePath).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
  assert.ok(img.length < whole.toString('base64').length,
    '发出去的应是裁片,不是整图');
});

test('prompt 不许问票面上没有的字段(团号/代理/收票日期=幻觉重灾区)', async () => {
  let sentBody = null;
  await rereadRegionFields(await freshImage(), {
    bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x.invalid/v1',
    fetchImpl: async (_u, init) => { sentBody = JSON.parse(init.body); return okResponse({}); },
  });
  const prompt = JSON.stringify(sentBody.messages);
  for (const banned of ['团号', '代理', '收票日期']) {
    assert.ok(!prompt.includes(banned),
      `prompt 里不该出现「${banned}」—— 它不在票面上,问了模型就会编`);
  }
  assert.ok(/绝不猜/.test(prompt), 'prompt 要明确禁止猜');
});

test('缓存:同图同框第二次不再发请求;换个框就重新读', async () => {
  const img2 = path.join(tmpDir, 'photo2.jpg');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#dddddd' } })
    .jpeg().toFile(img2);
  let calls = 0;
  const opts = {
    apiKey: 'k', baseUrl: 'https://x.invalid/v1',
    fetchImpl: async () => { calls += 1; return okResponse({ store: 'LOTTE', receiptNo: '', purchaseDate: '', amount: '' }); },
  };
  const a = await rereadRegionFields(img2, { bbox: [0.1, 0.1, 0.5, 0.5], ...opts });
  assert.equal(a.source, 'qwen');
  assert.equal(calls, 1);

  const b = await rereadRegionFields(img2, { bbox: [0.1, 0.1, 0.5, 0.5], ...opts });
  assert.equal(b.source, 'cache', '同图同框应命中缓存');
  assert.equal(calls, 1, '命中缓存就不该再发请求');
  assert.equal(b.fields.store, 'LOTTE');

  const c = await rereadRegionFields(img2, { bbox: [0.2, 0.2, 0.6, 0.6], ...opts });
  assert.equal(c.source, 'qwen', '改了框必须重新读 —— 缓存键含 bbox');
  assert.equal(calls, 2);
  assert.ok(fs.existsSync(cachePathFor(img2)));
});

test('全空结果不写缓存(别把一次失败固化成"这张就是读不出")', async () => {
  const img3 = path.join(tmpDir, 'photo3.jpg');
  await sharp({ create: { width: 400, height: 400, channels: 3, background: '#eeeeee' } })
    .jpeg().toFile(img3);
  let calls = 0;
  const opts = {
    apiKey: 'k', baseUrl: 'https://x.invalid/v1',
    fetchImpl: async () => { calls += 1; return okResponse({ store: '', receiptNo: '', purchaseDate: '', amount: '' }); },
  };
  await rereadRegionFields(img3, { bbox: [0.1, 0.1, 0.9, 0.9], ...opts });
  await rereadRegionFields(img3, { bbox: [0.1, 0.1, 0.9, 0.9], ...opts });
  assert.equal(calls, 2, '上一次全空 → 这次还要真读');
  assert.equal(fs.existsSync(cachePathFor(img3)), false);
});

test('⭐失败姿势:任何一环出问题都返回空字段,绝不抛', async () => {
  const cases = [
    ['未配置 apiKey', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: '', baseUrl: 'https://x/v1', fetchImpl: async () => okResponse({ store: 'X' }) }],
    ['未配置 baseUrl', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: '', fetchImpl: async () => okResponse({ store: 'X' }) }],
    ['框非法', { bbox: [0.5, 0.5, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x/v1', fetchImpl: async () => okResponse({ store: 'X' }) }],
    ['HTTP 非 200', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x/v1', fetchImpl: async () => ({ ok: false, status: 500 }) }],
    ['网络抛错', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x/v1', fetchImpl: async () => { throw new Error('ECONNRESET') } }],
    ['返回的不是 JSON', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x/v1', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '不是JSON' } }] }) }) }],
    ['图不存在', { bbox: [0.1, 0.1, 0.5, 0.5], apiKey: 'k', baseUrl: 'https://x/v1', fetchImpl: async () => okResponse({ store: 'X' }) }],
  ];
  for (const [name, opts] of cases) {
    const target = name === '图不存在' ? path.join(tmpDir, 'nope.jpg') : await freshImage();
    const r = await rereadRegionFields(target, opts);
    assert.deepEqual(r.fields, { store: '', receiptNo: '', purchaseDate: '', amount: '' }, name);
    assert.equal(r.source, '', name);
  }
});
