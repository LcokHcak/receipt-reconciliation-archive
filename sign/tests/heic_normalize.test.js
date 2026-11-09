const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { isHeicUpload, normalizeHeicUploads, normalizeUploadImages } = require('../lib/heic_normalize');

test('入库压缩:超大图压到 2400px/jpg;小图原样;坏文件不因压缩丢失', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 4000x3000 大图(模拟手机原片,>1.2MB 不必要——超边长即触发)
  const big = path.join(dir, 'big_upload');
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .jpeg({ quality: 95 }).toFile(big);
  // 小图(800px,几十KB)→ 不动
  const small = path.join(dir, 'small_upload.png');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .png().toFile(small);

  const files = [
    { path: big, originalname: 'IMG_9999.jpeg', mimetype: 'image/jpeg', size: fs.statSync(big).size },
    { path: small, originalname: 'shot.png', mimetype: 'image/png', size: fs.statSync(small).size },
  ];
  const beforeBig = fs.statSync(big).size;
  const kept = await normalizeUploadImages(files);
  assert.equal(kept.length, 2);

  const compressed = kept.find((f) => f.originalname === 'IMG_9999.jpg');
  assert.ok(compressed, '大图应被压缩并改名 .jpg');
  const meta = await sharp(compressed.path).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok(Math.max(meta.width, meta.height) <= 2400, `最长边应≤2400,实际 ${meta.width}x${meta.height}`);
  assert.ok(compressed.size < beforeBig, '体积必须变小');

  const untouched = kept.find((f) => f.originalname === 'shot.png');
  assert.ok(untouched && untouched.path === small, '小图不动(不重复劣化)');
});

test('isHeicUpload 按扩展名或 MIME 判定 heic/heif', () => {
  assert.equal(isHeicUpload({ originalname: 'a.heic' }), true);
  assert.equal(isHeicUpload({ originalname: 'a.HEIF' }), true);
  assert.equal(isHeicUpload({ originalname: 'noext', mimetype: 'image/heic' }), true);
  assert.equal(isHeicUpload({ originalname: 'a.jpg', mimetype: 'image/jpeg' }), false);
  assert.equal(isHeicUpload({ originalname: 'a.webp', mimetype: 'image/webp' }), false);
});

test('normalizeHeicUploads 把 heic 转 jpg,非 heic 原样通过,坏文件丢弃', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-norm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 造一张真图当 "heic"(靠 mimetype 触发转码;sharp 按内容读,验证改写/落盘链路)
  const heicLike = path.join(dir, 'upload_heic');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png().toFile(heicLike);
  // 普通 jpg(非 heic,应原样通过)
  const jpg = path.join(dir, 'upload_jpg.jpg');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg().toFile(jpg);
  // 坏 heic(垃圾字节,sharp 解不了)
  const bad = path.join(dir, 'bad.heic');
  fs.writeFileSync(bad, Buffer.from('not an image'));

  const files = [
    { path: heicLike, originalname: 'IMG_1.HEIC', mimetype: 'image/heic' },
    { path: jpg, originalname: 'photo.jpg', mimetype: 'image/jpeg' },
    { path: bad, originalname: 'bad.heic', mimetype: 'image/heic' },
  ];
  const kept = await normalizeHeicUploads(files);

  // 坏文件被丢弃 → 只剩 2 个
  assert.equal(kept.length, 2);
  // heic 那个被转成 jpg
  const converted = kept.find((f) => f.originalname === 'IMG_1.jpg');
  assert.ok(converted, 'heic 应转成 IMG_1.jpg');
  assert.equal(converted.mimetype, 'image/jpeg');
  assert.ok(converted.path.endsWith('.jpg'));
  const meta = await sharp(converted.path).metadata();
  assert.equal(meta.format, 'jpeg');
  // 非 heic 的 jpg 原样通过(path 不变)
  const passthrough = kept.find((f) => f.originalname === 'photo.jpg');
  assert.ok(passthrough && passthrough.path === jpg);
  // 坏文件临时文件已清掉
  assert.equal(fs.existsSync(bad), false);
});

test('normalizeUploadImages 并行化后保持上传顺序,HEIC 一步压到入库口径', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 3 个普通 jpg(小图,不触压缩)+ 1 个"坏 heic"(丢弃)交错,断言顺序不乱
  const files = [];
  for (let i = 0; i < 3; i += 1) {
    const p1 = path.join(dir, `img${i}.jpg`);
    await sharp({ create: { width: 60, height: 40, channels: 3, background: '#3355ff' } }).jpeg().toFile(p1);
    files.push({ path: p1, originalname: `img${i}.jpg`, mimetype: 'image/jpeg' });
  }
  const bad = path.join(dir, 'broken.heic');
  fs.writeFileSync(bad, 'not-a-real-heic');
  files.splice(1, 0, { path: bad, originalname: 'broken.heic', mimetype: 'image/heic' });

  const { normalizeUploadImages } = require('../lib/heic_normalize');
  const kept = await normalizeUploadImages(files);
  // 坏 heic 被丢弃,其余保持原顺序(切图/任务命名依赖顺序,乱序=串图前科)
  assert.deepEqual(kept.map((f) => f.originalname), ['img0.jpg', 'img1.jpg', 'img2.jpg']);
});

