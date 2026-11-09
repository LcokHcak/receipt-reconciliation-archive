'use strict';

/**
 * group_code_prematch_service — 团号预匹配(前移到审核前)。
 *
 * 识别一完成就拿 团号(Final优先,退Auto) 查「本批次团号表」(batch_group_code,本地SQL毫秒级):
 *   命中   → task.modeRawPre = 模式,groupNoMatchStatus = 'matched'   → 审核台绿徽章,按模式干活
 *   未命中 → 'not_found'                                             → 黄徽章,审核员改团号当场重跑
 *   表未就绪(还在后台解析/没绑表)→ 'pending_table'                    → 灰徽章,解析完成后 sweep 补跑
 *
 * 纯参考(advisory):结算时的终匹配(tour_match)才是权威,这里错了最坏是徽章显示错,钱的口径零影响。
 * 归一化口径与 tour_match_service 一致:先精确查,再剥前缀字母/后缀[-_]兜底。
 */

const { DOC_TYPES } = require('../lib/package_constants');
// 团号多店消歧(2026-07-07,70299病例):同团号多行属不同店,按小票店家选行,
// 全是别家店的行 → STORE_MISMATCH(黄徽章),绝不把现代模式亮给新世界小票。
const { filterRowsByStore } = require('../lib/validation/mode_store');
const { normalizeStoreFamily } = require('../lib/validation/field_rules');

const MATCH_STATUS = Object.freeze({
  NONE: '',                 // 无团号可查(护照任务/团号为空)
  PENDING: 'pending_table', // 批次团号表未就绪(解析中或未绑表)
  MATCHED: 'matched',
  NOT_FOUND: 'not_found',
  NO_GROUP: 'no_group',     // 团号="无"(机场票合法值)——不查表,中性徽章,别误报黄"未命中"
  FUZZY: 'fuzzy_candidate', // 表里查不到,但存在唯一"只差1个字符"的候选——纯建议,审核员一键采用
  STORE_MISMATCH: 'store_mismatch', // 团号在表里,但候选模式全属别家店——核对店家或团号
  // 店消歧后仍剩多个不同模式(同店双代理撞号,2026-07-12 审计实锤 新罗V团-新琪⇆新罗V团-本司
  // ×3 团号):**必须人选,系统绝不默取第一行**(用户拍板)。候选串走 mismatchModes 同管道。
  MODE_AMBIGUOUS: 'mode_ambiguous',
});

// 编辑距离是否 ≤1(只需要 0/1 判定,不用完整 DP):
// 等长 → 恰好一个位置不同;长度差1 → 短串是长串删掉一个字符的结果。
function isEditDistanceLe1(a, b) {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) { diff += 1; if (diff > 1) return false; }
    }
    return diff === 1;
  }
  const [s, l] = la < lb ? [a, b] : [b, a]; // s 短 l 长
  let i = 0; let j = 0; let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i += 1; j += 1; continue; }
    if (skipped) return false;
    skipped = true; j += 1; // 跳过长串一个字符
  }
  return true;
}

// 与 tour_match_service.normalizeTourNo 同口径(团号带字母前缀/横线后缀的兜底)。
function normalizeTourNo(s) {
  if (s == null) return '';
  return String(s).trim().replace(/^[A-Za-z]+/, '').replace(/[-_].*$/, '');
}

function createGroupCodePrematchService({ batchGroupCodeRepo, now = () => new Date().toISOString() }) {
  if (!batchGroupCodeRepo) throw new Error('group_code_prematch_service: batchGroupCodeRepo required');

  function tableReady(batchId) {
    try { return batchGroupCodeRepo.countByBatch(batchId) > 0; } catch { return false; }
  }

  // 查团号 → { status, mode }。精确优先,归一化兜底(与结算终匹配同口径);
  // storeFamily(小票店家,canonical)用于同团号多店消歧(与 tour_match_service 同一 helper)。
  function lookupTour(batchId, tourNoRaw, storeFamily = '') {
    const tourNo = String(tourNoRaw || '').trim();
    if (!tourNo) return { status: MATCH_STATUS.NONE, mode: '' };
    if (tourNo === '无') return { status: MATCH_STATUS.NO_GROUP, mode: '' }; // 机场票,查表无意义
    if (!tableReady(batchId)) return { status: MATCH_STATUS.PENDING, mode: '' };

    let rows = batchGroupCodeRepo.findByTour({ batchId, tourNo });
    if (!rows.length) {
      const norm = normalizeTourNo(tourNo);
      if (norm && norm !== tourNo) {
        rows = batchGroupCodeRepo.findByTour({ batchId, tourNo: norm });
      }
    }
    if (!rows.length) {
      // 近似纠错(金标发现:团号错误主形态=差1个字符,如 2614846→26141846 / 26146047→26146097)。
      // 表内存在唯一"编辑距离≤1"候选 → FUZZY 建议(纯 advisory,审核员一键采用才落 Final;
      // 多个候选=不敢猜,照旧 not_found)。团号太短(<5位)不启用,防误建议。
      const suggestion = findFuzzyCandidate(batchId, tourNo);
      if (suggestion) return { status: MATCH_STATUS.FUZZY, mode: '', suggestion };
      return { status: MATCH_STATUS.NOT_FOUND, mode: '' };
    }
    // 店家消歧:命中本店行→只在其中出模式;候选全属别家店→黄徽章提示核对(带候选模式)
    const storePick = filterRowsByStore(rows, storeFamily);
    if (storePick.storeMismatch) {
      const candidateModes = [...new Set(
        storePick.candidates.map((r) => String(r.mode || '').trim()).filter(Boolean)
      )].join(' / ');
      return { status: MATCH_STATUS.STORE_MISMATCH, mode: '', mismatchModes: candidateModes };
    }
    const effectiveRows = storePick.rows;
    // 同店/未知店下仍剩多个不同模式 → 人选(2026-07-12 用户拍板):旧逻辑默取第一行,
    // 同店双代理撞号(新罗V团-新琪⇆新罗V团-本司)会静默错模式。候选给足,审核员点一下。
    const distinctModes = [...new Set(
      effectiveRows.map((r) => String(r.mode || '').trim()).filter(Boolean)
    )];
    if (distinctModes.length > 1) {
      return { status: MATCH_STATUS.MODE_AMBIGUOUS, mode: '', mismatchModes: distinctModes.join(' / ') };
    }
    return { status: MATCH_STATUS.MATCHED, mode: distinctModes[0] || '' };
  }

  // 批次团号清单缓存(团号表几万行,逐次全查太浪费;换表后 countByBatch 变化即失效)
  const tourListCache = new Map(); // batchId -> { count, list }
  function getTourList(batchId) {
    const count = batchGroupCodeRepo.countByBatch(batchId);
    const cached = tourListCache.get(batchId);
    if (cached && cached.count === count) return cached.list;
    const list = typeof batchGroupCodeRepo.listTourNosByBatch === 'function'
      ? batchGroupCodeRepo.listTourNosByBatch(batchId)
      : [];
    tourListCache.set(batchId, { count, list });
    return list;
  }

  function findFuzzyCandidate(batchId, tourNoRaw) {
    const tourNo = String(tourNoRaw || '').trim();
    if (tourNo.length < 5) return '';
    let hit = '';
    for (const candidate of getTourList(batchId)) {
      if (Math.abs(candidate.length - tourNo.length) > 1) continue;
      if (!isEditDistanceLe1(tourNo, candidate)) continue;
      if (hit && hit !== candidate) return ''; // 多个候选=不敢猜
      hit = candidate;
    }
    return hit;
  }

  // 给单任务打预匹配标(就地改 task 字段,不落盘——由调用方保存)。返回是否有变化。
  function prematchTask(batchId, task) {
    if (!task || typeof task !== 'object') return false;
    const docType = String(task.docTypeFinal || task.docTypeAuto || '').trim().toLowerCase();
    // 只有小票任务有团号语义;护照/其它清空预匹配标(防 docType 被人改后残留)。
    const tourNo = docType === DOC_TYPES.RECEIPT
      ? String(task.groupNoFinal || task.groupNoAuto || '').trim()
      : '';
    // 店家消歧用本票店(Final 优先,canonical 化);审核员改店保存后即时重查,徽章跟着切
    const storeFamily = docType === DOC_TYPES.RECEIPT
      ? normalizeStoreFamily(task.receiptStoreFinal || task.receiptStoreAuto || '')
      : '';
    let { status, mode, suggestion = '', mismatchModes = '' } = tourNo
      ? lookupTour(batchId, tourNo, storeFamily)
      : { status: MATCH_STATUS.NONE, mode: '' };

    // 人工选模式守卫(2026-07-10 票级两步流):同团号多模式、店消歧不了时审核员人选了一个。
    // 团号没变 → 模式以人选为准(仅审核侧车道/徽章/回执;结算权威终匹配照旧自查表,选错不
    // 污染台账);团号变了 → 选择自动作废回查表结果。防换表 sweep/保存重跑覆盖人选。
    const manualMode = String(task.modeManualPick || '').trim();
    const manualTour = String(task.modeManualPickTour || '').trim();
    if (manualMode && manualTour && manualTour === tourNo) {
      mode = manualMode;
      if (status === MATCH_STATUS.STORE_MISMATCH || status === MATCH_STATUS.MODE_AMBIGUOUS) {
        status = MATCH_STATUS.MATCHED;
      }
      mismatchModes = '';
    } else if (manualMode) {
      task.modeManualPick = '';
      task.modeManualPickTour = '';
    }

    const changed = task.groupNoMatchStatus !== status
      || task.modeRawPre !== mode
      || (task.groupNoSuggestion || '') !== suggestion
      || (task.modeStoreMismatch || '') !== mismatchModes;
    task.groupNoMatchStatus = status;
    task.modeRawPre = mode;
    task.groupNoSuggestion = suggestion; // FUZZY 时=表内近似团号;其余为空
    task.modeStoreMismatch = mismatchModes; // STORE_MISMATCH 时=表内候选模式串(供徽章提示);其余为空
    task.groupNoMatchedAt = status === MATCH_STATUS.MATCHED ? now() : '';
    return changed;
  }

  // 整批补跑(团号表解析完成/换表后调用)。返回 {total, changed, matched}。
  function sweepBatch(batch) {
    const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
    let changed = 0;
    let matched = 0;
    for (const task of tasks) {
      if (prematchTask(batch.id, task)) changed += 1;
      if (task.groupNoMatchStatus === MATCH_STATUS.MATCHED) matched += 1;
    }
    return { total: tasks.length, changed, matched };
  }

  return { lookupTour, prematchTask, sweepBatch, MATCH_STATUS };
}

module.exports = { createGroupCodePrematchService, MATCH_STATUS, normalizeTourNo };
