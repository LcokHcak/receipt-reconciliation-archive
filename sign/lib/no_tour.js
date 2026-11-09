'use strict';

// ── 无团号语义单源(2026-07-20 行为三合一)─────────────────────────────
// 历史上「票上没有团号」有两条不汇流的路:
//   ①机场票哨兵字面量「无」(groupNoFinal='无')——确认闸豁免/机场模式推断/代理视图豁免全绕它建;
//   ②票级两步流表态 tourStance='none'(confirmNoTour 写空团号)。
// 8651902 只对齐了必填层(审核台不再卡「团号必填」),下游各副本仍只认「无」:
// 表态行在确认硬闸被 409、导出丢机场模式归类。收口两刀:
//   写入层:表态 none 自动把空团号回填「无」(services/workbench_write/task.js),新数据物理汇流;
//   读取层:isNoTourTask 带表态容错,兜住回填前的存量空值行。
// 新消费点一律 require 这里,禁再抄「=== '无'」字面量判断(前端经相对路径同源 import)。

const NO_TOUR_LITERAL = '无';

function tourValueOf(task) {
  const final = String((task && task.groupNoFinal) || '').trim();
  if (final) return final;
  return String((task && task.groupNoAuto) || '').trim();
}

// 票级表态「票上无团号」(人工背书)
function hasNoTourStance(task) {
  return String((task && task.tourStance) || '') === 'none';
}

// 这张票是否「无团号」:字面量「无」(两条路的汇流点)或 表态none+空值(存量行容错)。
// 注意:表态 none 但团号被后来填了真值(API 直改)→ 不算无团号,按普通票走。
function isNoTourTask(task) {
  const v = tourValueOf(task);
  if (v === NO_TOUR_LITERAL) return true;
  return !v && hasNoTourStance(task);
}

module.exports = { NO_TOUR_LITERAL, hasNoTourStance, isNoTourTask, tourValueOf };
