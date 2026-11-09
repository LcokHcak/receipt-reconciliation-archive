'use strict';

/**
 * mode_folder_classifier — 把 group_code 的模式字符串映射到 4 个文件夹。
 *
 * 规则源：当前业务口径记录在 AGENT_SHARED_MEMORY.md；运行时以本文件常量为准。
 *
 * 7 个有效模式：
 *   爱宝客pkg-本司 / 爱宝客SG-本司       → 爱宝客
 *   乐天SG-本司 / 乐天H团-本司           → 乐天首尔
 *   乐天釜山P特殊-本司 / 乐天釜山SG-本司  → 乐天釜山
 *   济州新罗V团-本司                     → 济州新罗V团
 *   其他                                 → null（跳过，不进 monthly_data）
 *
 * 设计变化（vs 2026-05-10 版本）：
 *   - 之前是启发式（靠 shop / branch / modeNormalized 组合猜）；
 *     真实业务规则明确是枚举驱动，改成 switch
 *   - 必须带 `-本司` 后缀；带 `-本司` 但不在 7 个枚举内 → null
 *   - 不再用 shop / branch / modeNormalized —— modeRaw 是唯一依据
 *
 * 调用方（tour_match_service）会在 null 时写 tour_match_status='skipped_mode_not_required'。
 */

const FOLDER = Object.freeze({
  LOTTE_SEOUL: '乐天首尔',
  LOTTE_BUSAN: '乐天釜山',
  HDC: '爱宝客',
  SHILLA_JEJU_V: '济州新罗V团',
});

const HUIXIN_SUFFIX = '-本司';

// 模式字符串（去除空白后的形态）→ 文件夹
const MODE_TO_FOLDER = Object.freeze({
  '爱宝客pkg-本司': FOLDER.HDC,
  '爱宝客SG-本司': FOLDER.HDC,
  '乐天SG-本司': FOLDER.LOTTE_SEOUL,
  '乐天H团-本司': FOLDER.LOTTE_SEOUL,
  '乐天釜山P特殊-本司': FOLDER.LOTTE_BUSAN,
  '乐天釜山SG-本司': FOLDER.LOTTE_BUSAN,
  '济州新罗V团-本司': FOLDER.SHILLA_JEJU_V,
});

function normalizeModeRaw(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, '').trim();
}

function isRequiredMode(modeRaw) {
  const normalized = normalizeModeRaw(modeRaw);
  if (!normalized) return false;
  if (!normalized.endsWith(HUIXIN_SUFFIX)) return false;
  return Object.prototype.hasOwnProperty.call(MODE_TO_FOLDER, normalized);
}

/**
 * 主入口：modeRaw → folder 或 null
 *
 * 兼容旧签名：为了不破坏 tour_match_service 现有调用，保留 `{modeNormalized, modeRaw, shop, branch}`
 * 的解构参数，但内部只看 modeRaw。
 */
function classifyModeFolder({ modeRaw } = {}) {
  const normalized = normalizeModeRaw(modeRaw);
  if (!normalized) return null;
  if (!normalized.endsWith(HUIXIN_SUFFIX)) return null;
  return MODE_TO_FOLDER[normalized] || null;
}

function normalizeProbe(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

function classifyBillFolder({ modeRaw, storeFamily, storeBranch, sourceFile, sourceSheet } = {}) {
  const modeFolder = classifyModeFolder({ modeRaw });
  if (modeFolder) return modeFolder;

  const probe = [
    modeRaw,
    storeFamily,
    storeBranch,
    sourceFile,
    sourceSheet,
  ].map(normalizeProbe).join('|');

  if (!probe) return null;
  if (/釜山|BUSAN/.test(probe)) return FOLDER.LOTTE_BUSAN;
  if (/爱宝客|IPARK|HDC|SHILLAIPARK/.test(probe)) return FOLDER.HDC;
  if (/济州|JEJU|V团|V團/.test(probe)) return FOLDER.SHILLA_JEJU_V;
  if (/乐天|LOTTE/.test(probe)) return FOLDER.LOTTE_SEOUL;
  if (/THESHILLA|新罗|新羅/.test(probe)) return FOLDER.SHILLA_JEJU_V;
  return null;
}

function allFolders() {
  return [FOLDER.LOTTE_SEOUL, FOLDER.LOTTE_BUSAN, FOLDER.HDC, FOLDER.SHILLA_JEJU_V];
}

function allRequiredModes() {
  return Object.keys(MODE_TO_FOLDER);
}

module.exports = {
  classifyModeFolder,
  classifyBillFolder,
  isRequiredMode,
  allFolders,
  allRequiredModes,
  FOLDER,
  MODE_TO_FOLDER,
  HUIXIN_SUFFIX,
};
