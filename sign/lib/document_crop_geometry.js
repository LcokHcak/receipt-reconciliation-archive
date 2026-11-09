'use strict';

/**
 * 文档裁切几何 — 纯函数,无外部依赖。
 *
 * 从检测到的区域框(regionBox)+ 原图尺寸(metadata)+ 内边距比例算出
 * sharp.extract 用的裁切矩形。审核侧拆图(document_split_service)与 qwen
 * 拆图(qwen_split_service)共用,放在 lib 作为两层共同的底座,避免 lib 反向
 * 依赖 services。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{ left?:number, top?:number, right?:number, bottom?:number, width?:number, height?:number }} regionBox
 * @param {{ width?:number, height?:number }} metadata 原图尺寸
 * @param {number} paddingPct 区域宽/高的内边距比例(如 0.02)
 * @returns {{ left:number, top:number, width:number, height:number }}
 */
function buildCropRect(regionBox, metadata, paddingPct) {
  const imageWidth = Math.max(1, Number(metadata.width || 1));
  const imageHeight = Math.max(1, Number(metadata.height || 1));
  const paddingX = Math.round(Number(regionBox.width || 0) * paddingPct);
  const paddingY = Math.round(Number(regionBox.height || 0) * paddingPct);
  const left = clamp(Math.floor(Number(regionBox.left || 0) - paddingX), 0, imageWidth - 1);
  const top = clamp(Math.floor(Number(regionBox.top || 0) - paddingY), 0, imageHeight - 1);
  const right = clamp(Math.ceil(Number(regionBox.right || 0) + paddingX), left + 1, imageWidth);
  const bottom = clamp(Math.ceil(Number(regionBox.bottom || 0) + paddingY), top + 1, imageHeight);

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

module.exports = { buildCropRect };
