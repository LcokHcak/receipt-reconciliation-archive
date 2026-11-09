'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const HEIC_EXTS = new Set(['.heic', '.heif']);
const HEIC_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

function isHeicUpload(file = {}) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return HEIC_EXTS.has(ext) || HEIC_MIMES.has(mime);
}

// 把上传的 HEIC/HEIF(iPhone 默认格式)就地转成 jpg。原因:浏览器和审核台用 <img> 显示,
// 不能渲染 heic;intake 切图落盘也写不了 .heic。转在上传后、intake 处理前做,下游全程只见 jpg,
// 切图/预处理逻辑零改动。转换失败(损坏/不支持的变体)→ 丢弃该文件,不毒化整批。
// 返回处理后的 files(可能变短);每个 heic 元素被原地改写(path/originalname/mimetype)。
async function normalizeHeicUploads(files = []) {
  const list = Array.isArray(files) ? files : [];
  const kept = [];
  for (const file of list) {
    if (!file || !isHeicUpload(file)) {
      if (file) kept.push(file);
      continue;
    }
    const jpgPath = `${file.path}.jpg`;
    try {
      // rotate() 无参 = 按 EXIF 方向自动旋正(手机竖拍常见)。
      // 2026-07-10 提速:转码时顺手压到入库口径(≤2400px/q82)——原来先 q92 全尺寸转出,
      // 再被 compressLargeUpload 第二次解码压缩,大 HEIC 白解一遍;现在一次解码全搞定,
      // 转出后天然低于压缩阈值,压缩器自动跳过。
      await sharp(file.path)
        .rotate()
        .resize({ width: COMPRESS_MAX_SIDE, height: COMPRESS_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: COMPRESS_JPEG_QUALITY, mozjpeg: true })
        .toFile(jpgPath);
      try { await fs.promises.rm(file.path, { force: true }); } catch { /* 原文件删不掉不致命 */ }
      const base = path.basename(
        String(file.originalname || 'image'),
        path.extname(String(file.originalname || '')),
      ) || 'image';
      file.path = jpgPath;
      file.originalname = `${base}.jpg`;
      file.mimetype = 'image/jpeg';
      try { file.size = (await fs.promises.stat(jpgPath)).size; } catch { /* size 非必需 */ }
      kept.push(file);
    } catch (_error) {
      // 无法解码的 heic:清掉临时文件,丢弃该文件(不加入 kept),不阻断整批其它图。
      try { await fs.promises.rm(jpgPath, { force: true }); } catch { /* ignore */ }
      try { await fs.promises.rm(file.path, { force: true }); } catch { /* ignore */ }
    }
  }
  return kept;
}

// ── 入库压缩(2026-07-04 存储治理)────────────────────────────────
// 手机原片 3-6MB/4000px+,OCR 与人审 2400px 足够(小票是印刷体;实测 5.5MB→0.2MB 全字段清晰)。
// 超限才压:已经小的图(微信压过的)原样保留,不重复劣化;压完反而更大也不换。
// rotate() 顺手把 EXIF 方向烘进像素(与切图转正口径一致,下游再 rotate() 是无害空转)。
// ⚠️ 这三个常量是全系统图片压缩的唯一真相源:上传入库(本文件)、切图写盘(qwen_split_service)、
// 存量回填(scripts/compress_stock_images.js)都引用这里。实测 5.5MB→0.2MB 全字段清晰(2026-07-04)。
const COMPRESS_MAX_SIDE = 2400;
const COMPRESS_JPEG_QUALITY = 82;
const COMPRESS_MIN_BYTES = 1.2 * 1024 * 1024; // 超过 1.2MB 或超边长才动手

async function compressLargeUpload(file) {
  try {
    const before = await fs.promises.stat(file.path);
    const meta = await sharp(file.path).metadata();
    const maxSide = Math.max(Number(meta.width || 0), Number(meta.height || 0));
    if (before.size <= COMPRESS_MIN_BYTES && maxSide <= COMPRESS_MAX_SIDE) return;
    const outPath = `${file.path}.cmp.jpg`;
    await sharp(file.path)
      .rotate()
      .resize({ width: COMPRESS_MAX_SIDE, height: COMPRESS_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: COMPRESS_JPEG_QUALITY, mozjpeg: true })
      .toFile(outPath);
    const after = await fs.promises.stat(outPath);
    if (after.size >= before.size) {
      await fs.promises.rm(outPath, { force: true }); // 压不小就保留原件
      return;
    }
    await fs.promises.rm(file.path, { force: true });
    const base = path.basename(
      String(file.originalname || 'image'),
      path.extname(String(file.originalname || '')),
    ) || 'image';
    file.path = outPath;
    file.originalname = `${base}.jpg`;
    file.mimetype = 'image/jpeg';
    file.size = after.size;
  } catch {
    // 解码/压缩失败 → 原文件原样入库(压缩是优化不是闸门,绝不因此丢图)
  }
}

// 有界并行 map(保序):HEIC 解码/压缩是 CPU 密集,串行跑十张 HEIC 要半分钟——
// 2026-07-10 生产实锤:HEIC 放开当天上传 p50 828ms→1720ms、p90 2s→6.9s、最慢 35s。
// 并发 3(4 核机,给 qwen 识别管道留头);结果按原始下标归位,文件顺序不变
// (切图/任务命名依赖上传顺序,乱序=串图,前科在案)。
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// 上传归一化总入口:HEIC→jpg + 大图压缩。三个上传路径(建档/追加/批次导入)统一走这里。
async function normalizeUploadImages(files = []) {
  const list = Array.isArray(files) ? files : [];
  const processed = await mapLimit(list, 3, async (file) => {
    if (!file) return null;
    if (isHeicUpload(file)) {
      // 单文件走 heic 转换(转失败返回空数组 → 丢弃该文件,不阻断整批)
      const kept = await normalizeHeicUploads([file]);
      return kept[0] || null;
    }
    if (file.path) await compressLargeUpload(file);
    return file;
  });
  return processed.filter(Boolean);
}

module.exports = {
  COMPRESS_JPEG_QUALITY,
  COMPRESS_MAX_SIDE,
  COMPRESS_MIN_BYTES,
  isHeicUpload,
  normalizeHeicUploads,
  normalizeUploadImages,
};
