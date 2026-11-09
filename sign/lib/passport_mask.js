'use strict';

// 护照区打码(0727反馈#13-3,乐天百货交付包):同框整图(小票+护照)以交易编号命名
// 交付时,护照区域必须打码。
//
// v1 口径 = 方案a的保守版:护照 bbox 区域**整体涂黑** + 角标"护照已打码"。
//   - 反馈原话是"只能露出国籍",但国籍值/国籍行位置在持久化数据里都不存在
//     (sidecar 不存 MRZ 行,改 prompt 取国籍会作废全量识别缓存)——固定比例开窗
//     有泄漏姓名/证号的风险,零泄漏 > 多露一行。同夹《护照.jpg》本就不打码
//     (2026-07-20 拍板a),上家核身份不受影响。
//   - 要精确"只露国籍行"(方案b:模型返国籍行 bbox)等用户拍板后在此函数内换算法,
//     调用方接口不变。
//
// bbox 合理性闸:归一化 [x1,y1,x2,y2]、面积占整图 3%~75% 才动手——bbox 不可信时
// 宁可不遮并让调用方把该张列进"未打码名单"(可见),也不许黑块盖到小票上(错遮=残包)。

const sharp = require('sharp');

const MIN_AREA_RATIO = 0.03;
const MAX_AREA_RATIO = 0.75;

function plausibleBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [x1, y1, x2, y2] = bbox.map(Number);
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return false;
  if (x2 <= x1 || y2 <= y1) return false;
  const area = (x2 - x1) * (y2 - y1);
  return area >= MIN_AREA_RATIO && area <= MAX_AREA_RATIO;
}

// 遮罩 SVG(纯函数供测试):黑底 + 「PASSPORT MASKED」小字;带国籍时(0728 拍板
// 「打码要露出国籍」)国籍行用大号琥珀字居中主位——信息露出,位置零泄漏。
function buildMaskOverlaySvg({ width, height, nationalityText = '' }) {
  const base = Math.max(14, Math.round(Math.min(width, height) * 0.08));
  const cx = Math.round(width / 2);
  let texts;
  if (nationalityText) {
    const natSize = Math.max(20, Math.round(Math.min(width, height) * 0.14));
    texts = `<text x="${cx}" y="${Math.round(height * 0.42)}" fill="#fbbf24" `
      + `font-size="${natSize}" font-weight="bold" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">`
      + `${nationalityText}</text>`
      + `<text x="${cx}" y="${Math.round(height * 0.62)}" fill="#9ca3af" `
      + `font-size="${base}" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">`
      + 'PASSPORT MASKED</text>';
  } else {
    texts = `<text x="${cx}" y="${Math.round(height / 2)}" fill="#9ca3af" `
      + `font-size="${base}" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">`
      + 'PASSPORT MASKED</text>';
  }
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="0" y="0" width="${width}" height="${height}" fill="#000"/>`
    + `${texts}</svg>`;
}

// sourcePath → destPath:护照区涂黑后落盘(jpeg q90,清晰度尽量保住小票区)。
// nationalityText(0728 拍板):有值就印在遮罩上(如「국적/Nationality: CHN」);
// 空=v1 全遮行为不变。返回 { masked:true } 或 { masked:false, reason }。
async function maskPassportRegion({ sourcePath, destPath, bbox, nationalityText = '' }) {
  if (!plausibleBbox(bbox)) return { masked: false, reason: 'bbox_implausible' };
  try {
    const img = sharp(sourcePath).rotate();
    const meta = await sharp(sourcePath).metadata();
    let W = Number(meta.width || 0);
    let H = Number(meta.height || 0);
    if (Number(meta.orientation) >= 5) [W, H] = [H, W]; // rotate() 后宽高互换(与裁片服务同口径)
    if (!W || !H) return { masked: false, reason: 'no_dimensions' };
    const pad = 0.012; // 略外扩,防 bbox 贴边露一条护照边缘
    const left = Math.max(0, Math.round((Number(bbox[0]) - pad) * W));
    const top = Math.max(0, Math.round((Number(bbox[1]) - pad) * H));
    const right = Math.min(W, Math.round((Number(bbox[2]) + pad) * W));
    const bottom = Math.min(H, Math.round((Number(bbox[3]) + pad) * H));
    const width = right - left;
    const height = bottom - top;
    if (width < 8 || height < 8) return { masked: false, reason: 'region_too_small' };
    const overlay = Buffer.from(buildMaskOverlaySvg({ width, height, nationalityText }));
    await img
      .composite([{ input: overlay, left, top }])
      .jpeg({ quality: 90 })
      .toFile(destPath);
    return { masked: true };
  } catch (error) {
    return { masked: false, reason: `sharp_failed:${error?.message || error}` };
  }
}

module.exports = { maskPassportRegion, buildMaskOverlaySvg, plausibleBbox, MIN_AREA_RATIO, MAX_AREA_RATIO };
