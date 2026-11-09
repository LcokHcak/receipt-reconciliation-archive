'use strict';

/**
 * 重拍原因分键(0727反馈#10)的单一真相源:**键 + 中文标签在同一处**。
 *
 * 由来:键的白名单本来就有三处在用(lib/workbench_normalizers 存盘白名单、
 * services/workbench_write/task.js 落库校验、lib/field_registry 契约),
 * 但**中文标签只存在于前端** frontend/src/lib/reviewDisplay.js。
 * 后果:资料库导出的「需重拍·去回收」sheet 拿不到标签,于是那张表干脆不带原因 ——
 * 而拿那张表去回收照片的人,恰恰是最需要知道"为什么要重拍"的那个人
 * (0727#10 加这个分键的**全部理由**就是"前台补拍不用再猜")。
 *
 * 所以标签放后端 lib,前端从这里取,不各写一份。
 * 顺序即审核台的快捷键 1/2/3,改顺序等于改快捷键,别乱动。
 */

const REPHOTO_REASONS = Object.freeze([
  Object.freeze({ key: 'blurry', label: '模糊' }),
  Object.freeze({ key: 'missing', label: '缺' }),
  Object.freeze({ key: 'other', label: '其他' }),
]);

const REPHOTO_REASON_KEYS = Object.freeze(REPHOTO_REASONS.map((r) => r.key));

/** 键 → 中文;认不出/空 → ''(不编造,调用方自己决定显示什么) */
function rephotoReasonLabel(key) {
  const k = String(key == null ? '' : key).trim();
  return REPHOTO_REASONS.find((r) => r.key === k)?.label || '';
}

module.exports = { REPHOTO_REASONS, REPHOTO_REASON_KEYS, rephotoReasonLabel };
