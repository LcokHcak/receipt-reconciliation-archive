'use strict';

/**
 * review_lane — 分车道审核的车道判定(单一真相源,2026-07-10)。
 *
 * 车道由「人工确认过的模式」决定(tourConfirm.mode / 回填后的 task.modeRawPre):
 *   slim        「不用记」类:小票免逐字段,只勾归属;护照锚字段仍人审。
 *               ⚠️灰度铁律:slim 只对 WORKBENCH_SLIM_MODES(逗号分隔 ENV 白名单)里的模式生效,
 *               默认空=没有任何模式免审。首期只放「新世界SG-振华 不用记」(用户拍板)。
 *   s_activity  S活动:全字段一个不省 + 时效动作(红标签)。
 *   sendback    发12/17/18号类:标准审 + 回发队列。
 *   standard    其余全部(含未知模式/未确认/被撤销)——fail-safe 全审。
 */

function parseSlimModes(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const SENDBACK_RE = /发\s*(1[278])\s*[号群]/; // 发12号 / 发17群 / 发18号(群) 等写法

function laneOfMode(mode, { slimModes = [] } = {}) {
  const m = String(mode || '').trim();
  if (!m) return 'standard';
  if (m.includes('S活动')) return 's_activity';
  if (SENDBACK_RE.test(m)) return 'sendback';
  if (slimModes.includes(m)) return 'slim';
  return 'standard';
}

// 时效动作(确认即入回发队列)的类型;非时效模式返回 ''。
function sendbackActionOfMode(mode) {
  const m = String(mode || '').trim();
  if (m.includes('S活动')) return 's_activity';
  const hit = m.match(SENDBACK_RE);
  if (hit) return `send_${hit[1]}`; // send_12 / send_17 / send_18
  return '';
}

module.exports = { laneOfMode, parseSlimModes, sendbackActionOfMode };
