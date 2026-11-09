'use strict';

// /storage-preview(0727反馈#11「图片缓冲不出来」):缩放缓存出图。
// 行为锁:①出图确实变小且可解码 ②二次命中磁盘缓存 ③路径逃逸/非图片/不存在 404
// ④sharp 失败回退原图直出(宁慢勿断)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const sharp = require('sharp');

const { createStoragePreviewHandler, PREVIEW_DIR } = require('../server/storage_preview');

async function makeApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-preview-'));
  const batchDir = path.join(root, 'batch_x', 'source');
  fs.mkdirSync(batchDir, { recursive: true });
  // 生成一张 3000px 大图(高斯噪声防纯色压缩过小;background 是 create 的必填项)
  await sharp({
    create: {
      width: 3000, height: 2000, channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  }).jpeg({ quality: 95 }).toFile(path.join(batchDir, 'big.jpg'));
  fs.writeFileSync(path.join(batchDir, 'note.txt'), 'not an image');

  const app = express();
  app.use('/storage-preview', createStoragePreviewHandler({ batchesRoot: root }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, root };
}

test('预览出图:确实缩小可解码;二次请求命中磁盘缓存;原图不动', async (t) => {
  const { base, root } = await makeApp(t);
  const original = fs.statSync(path.join(root, 'batch_x', 'source', 'big.jpg'));

  const r1 = await fetch(`${base}/storage-preview/batch_x/source/big.jpg`);
  assert.equal(r1.status, 200);
  const buf = Buffer.from(await r1.arrayBuffer());
  assert.ok(buf.length < original.size, `预览(${buf.length})必须小于原图(${original.size})`);
  const meta = await sharp(buf).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1600, '长边不超 1600');

  // 缓存已落盘;二次请求返回同字节
  const cacheDir = path.join(root, 'batch_x', PREVIEW_DIR);
  const cached = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.jpg'));
  assert.equal(cached.length, 1, '预览缓存落在 <批次>/.previews/');
  const r2 = await fetch(`${base}/storage-preview/batch_x/source/big.jpg`);
  assert.equal(Buffer.from(await r2.arrayBuffer()).length, buf.length);
});

test('安全与边界:路径逃逸/非图片/不存在一律 404', async (t) => {
  const { base } = await makeApp(t);
  assert.equal((await fetch(`${base}/storage-preview/batch_x/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await fetch(`${base}/storage-preview/batch_x/source/note.txt`)).status, 404, '非图片没有预览语义');
  assert.equal((await fetch(`${base}/storage-preview/batch_x/source/none.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/storage-preview/`)).status, 404);
});

test('sharp 失败回退原图直出(宁慢勿断):伪 jpg(坏字节)也 200 出原字节', async (t) => {
  const { base, root } = await makeApp(t);
  const bogus = path.join(root, 'batch_x', 'source', 'broken.jpg');
  fs.writeFileSync(bogus, 'not really a jpeg');
  const r = await fetch(`${base}/storage-preview/batch_x/source/broken.jpg`);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'not really a jpeg');
});

// ── 0731:整张原图那一档(edge=2400)+ 已在档内就不重编码 ────────────────────
// 由来:0730 的 P1 主态翻转把审核台默认视图换成整张原图,那条路径当时直接用 /storage 裸 URL,
// 既没有上限也没有缓存,把 0727#11 的修法绕过去了。补这一档时实测发现:40 张真实库存图走
// 2400 档重编码,有 24 张**反而更大**(入库已按 q82 压过一轮)。所以档内图必须原样送。

test('⭐edge=2400 档:超档的大图按 2400 缩;档内的图原样送不重编码(重编码会更大)', async (t) => {
  const { base, root } = await makeApp(t);
  const dir = path.join(root, 'batch_x', 'source');
  // 已在档内的图:1200px、小体积 —— 这类图重编码是净亏,必须原字节返回
  await sharp({
    create: {
      width: 1200, height: 900, channels: 3,
      background: { r: 90, g: 120, b: 150 },
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  }).jpeg({ quality: 82 }).toFile(path.join(dir, 'small.jpg'));

  // ① 3000px 大图走 2400 档 → 缩到 2400
  const big = await fetch(`${base}/storage-preview/batch_x/source/big.jpg?edge=2400`);
  assert.equal(big.status, 200);
  const bigMeta = await sharp(Buffer.from(await big.arrayBuffer())).metadata();
  assert.equal(Math.max(bigMeta.width, bigMeta.height), 2400, '超档要缩到 2400,不是 1600');

  // ② 同一张图不带参数 → 仍是 1600 档(切片/缩略的老行为不许被这次改动带偏)
  const dflt = await fetch(`${base}/storage-preview/batch_x/source/big.jpg`);
  const dfltMeta = await sharp(Buffer.from(await dflt.arrayBuffer())).metadata();
  assert.equal(Math.max(dfltMeta.width, dfltMeta.height), 1600, '默认档不变');

  // ③ 1200px 小图走 2400 档 → 原字节返回(不重编码)
  const onDisk = fs.readFileSync(path.join(dir, 'small.jpg'));
  const small = await fetch(`${base}/storage-preview/batch_x/source/small.jpg?edge=2400`);
  const smallBuf = Buffer.from(await small.arrayBuffer());
  assert.ok(smallBuf.equals(onDisk),
    `档内的图应原样送,实际字节数 ${smallBuf.length} vs 磁盘 ${onDisk.length}`);

  // ④ 非白名单档位 → 退回默认 1600,不许外部随便点菜(否则缓存目录被撑爆 + 白送 CPU)
  const weird = await fetch(`${base}/storage-preview/batch_x/source/big.jpg?edge=9999`);
  const weirdMeta = await sharp(Buffer.from(await weird.arrayBuffer())).metadata();
  assert.equal(Math.max(weirdMeta.width, weirdMeta.height), 1600, '非白名单档位退回 1600');

  // ⑤ 两档各自落缓存,互不覆盖(缓存键含档位)
  const cacheFiles = fs.readdirSync(path.join(root, 'batch_x', PREVIEW_DIR));
  assert.ok(cacheFiles.length >= 2, `1600 与 2400 应各有缓存,实际:${cacheFiles.join(',')}`);
});
