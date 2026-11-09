'use strict';

// /storage-preview/<batchId>/<relpath> — 缩放缓存出图(0727反馈#11「图片缓冲不出来」根治)。
//
// 根因:/storage 直出手机原图(5-12MB/张),部署线路窄(T6 实测跨境上行 0.1-0.8Mbps,
// 下行同样紧),一张图半分钟起步;审核台还预取后两组,进一步抢当前图的带宽——
// 观感就是"图片缓冲不出来"。
//
// 方案:审核台默认走本端点(1600px q78 ≈ 200-400KB),「查看原图」仍走
// /storage 原图。首次访问用 sharp 缩放并落盘缓存(<批次>/.previews/<hash>.jpg),
// 之后直接 sendFile 缓存;缓存键含 mtime+size,原图被替换(重拍补图)后旧预览自动失效。
// sharp 失败(格式怪)→ 回退原图直出,宁慢勿断。鉴权与 /storage 完全同链
// (authenticateToken + storageAccessMiddleware),不开新口子。
//
// 2026-07-31(P1 主态翻转的回归修补):审核台默认改成看**整张原图**后,那条路径直接
// 用了 /storage 裸 URL —— 既不过本端点的上限和缓存,也不在 ReviewView 的预取名单里
// (预取热的是切片 URL,与实际加载的第三个 URL 对不上),0727#11 的两半修法都被绕过去了。
// 现在原图那档也走本端点,但用 ?edge=2400:1600 对"放大到框上"不够(票常只占照片 1/3 宽)。
// 配套加了「已经在档内就原样送、不重编码」的短路 —— 实测 40 张真实库存图,2400 档重编码
// 有 24 张反而更大(入库已按 q82 压过一轮)。于是这一档对入库之后的图等于纯上限,零开销。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

// 入库压缩的阈值单源(那边注释明写自己是"全系统图片压缩的唯一真相源")
const { COMPRESS_MIN_BYTES } = require('../lib/heic_normalize');

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const PREVIEW_DIR = '.previews';
const PREVIEW_MAX_EDGE = 1600;
const PREVIEW_QUALITY = 78;
// 看整张原图那一档(0731):P1 主态翻转后审核台默认看原图并自动放大到框上,1600 不够用——
// 一张票常只占照片 1/3 宽,1600 档下那块只有 ~530px,拉到屏幕 1000px 是 1.9 倍放大,糊。
// 2400 = 入库压缩上限(lib/heic_normalize COMPRESS_MAX_SIDE),所以对**入库之后**的图
// 这一档等于不缩,只是给存量大图和将来的例外兜一个上限。
const VIEW_MAX_EDGE = 2400;
const ALLOWED_EDGES = new Set([PREVIEW_MAX_EDGE, VIEW_MAX_EDGE]);

function createStoragePreviewHandler({ batchesRoot }) {
  if (!batchesRoot) throw new Error('storage_preview: batchesRoot required');
  const root = path.resolve(batchesRoot);

  return async function storagePreviewHandler(req, res, next) {
    try {
      const rel = decodeURIComponent(String(req.path || '')).replace(/^\/+/, '');
      if (!rel) return res.status(404).end();
      const abs = path.resolve(root, rel);
      // 路径逃逸锁(与 /storage 静态服务同级纪律):解析后必须仍在批次根内
      if (!abs.startsWith(root + path.sep)) return res.status(404).end();
      if (!IMAGE_EXT.test(abs)) return res.status(404).end(); // 非图片类型没有预览语义
      let stat;
      try { stat = await fsp.stat(abs); } catch { return res.status(404).end(); }
      if (!stat.isFile()) return res.status(404).end();

      // 档位:默认 1600(切片/缩略,0727#11 原方案);?edge=2400 是「看整张原图」档。
      // 白名单校验——不然任意 edge 会把缓存目录撑成无限多份,还给了外部控制服务端 CPU 的口子。
      const askedEdge = Number(req.query?.edge);
      const maxEdge = ALLOWED_EDGES.has(askedEdge) ? askedEdge : PREVIEW_MAX_EDGE;

      // ⭐已经在档内的图直接原样送,不重编码(0731 实测:40 张真实库存图走 2400 档重编码,
      // 有 24 张**反而更大**——入库时已按 q82 压过一轮,再来一轮 q78 是净亏)。
      // 判据与入库压缩同一套(lib/heic_normalize:超边长或超 1.2MB 才动手),那边的注释
      // 明写它是"全系统图片压缩的唯一真相源",这里跟着它,不另立第二套阈值。
      if (stat.size <= COMPRESS_MIN_BYTES) {
        let meta = null;
        try { meta = await sharp(abs).metadata(); } catch { meta = null; }
        const side = Math.max(Number(meta?.width || 0), Number(meta?.height || 0));
        if (side > 0 && side <= maxEdge) return res.sendFile(abs);
      }

      const batchSeg = rel.split('/')[0];
      const cacheKey = crypto.createHash('sha1')
        .update(`${rel}|${stat.mtimeMs}|${stat.size}|${maxEdge}|${PREVIEW_QUALITY}`)
        .digest('hex');
      const cacheDir = path.join(root, batchSeg, PREVIEW_DIR);
      const cachePath = path.join(cacheDir, `${cacheKey}.jpg`);
      // dotfiles:'allow' 必须显式给——.previews 是点目录,express sendFile 默认对
      // 点段 ignore → 静默 404(本文件测试抓的第一只虫)。
      const sendOpts = { dotfiles: 'allow' };
      if (fs.existsSync(cachePath)) return res.sendFile(cachePath, sendOpts);

      await fsp.mkdir(cacheDir, { recursive: true });
      // 临时名写入 + rename 原子落位:并发同图请求不会 sendFile 半成品
      const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await sharp(abs).rotate()
          .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: PREVIEW_QUALITY })
          .toFile(tmp);
        await fsp.rename(tmp, cachePath);
      } catch {
        try { await fsp.unlink(tmp); } catch { /* 半成品清理尽力而为 */ }
        return res.sendFile(abs); // 缩放失败回退原图:宁慢勿断
      }
      return res.sendFile(cachePath, sendOpts);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  createStoragePreviewHandler, PREVIEW_DIR, PREVIEW_MAX_EDGE, PREVIEW_QUALITY, VIEW_MAX_EDGE,
};
