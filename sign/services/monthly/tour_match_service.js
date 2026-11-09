'use strict';

/**
 * tour_match_service — stage 1.5 of the monthly pipeline.
 *
 * Inputs:
 *   - daily_receipt_export rows with tour_match_status = 'pending'
 *   - group_code table (loaded from 鍥㈠彿琛?xlsx)
 *
 * Actions per row:
 *   1. Look up group_code by tour_no
 *   2. **Filter by -钑欐柊 suffix + 7-mode enum** (v2 rule, 2026-05-11)
 *      Modes that are NOT in the required set get
 *      tour_match_status='skipped_mode_not_required' and are excluded from
 *      monthly_data / 鏈敹 outputs.
 *   3. Verify date window (purchase_date 鈭?[apply_date, end_date])
 *   4. Verify agent consistency
 *   5. Back-fill mode from group_code if daily row is empty/mismatched
 *   6. Classify into one of 4 mode folders (now enum-driven)
 *   7. Raise pending_review on agent mismatch or unresolvable mode
 *
 * All violations also written to error_record for backward compat.
 */

const { logger: structuredLogger } = require('../../lib/request_logger');
const { normalizeMode } = require('../../lib/monthly_pipeline/mode_normalizer');
const { compositeModeKey } = require('../../lib/monthly_pipeline/mode_key');
const {
  classifyModeFolder,
  isRequiredMode,
} = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { isEmptyValue, normalizeDate, normalizeString, agentMatches } = require('../../lib/monthly_pipeline/matching/field_diff');
const { RULE_VERSION } = require('../../lib/monthly_pipeline/rule_version');
const { tracker: progressTracker } = require('../../lib/stage_progress_tracker');
const { withWorkspaceTourMatchLock } = require('../../lib/workspace_tour_match_lock');
// 团号多店消歧(2026-07-07,70299病例):同团号多行属不同店(团在新世界/现代各有消费),
// 必须用本票店家选行,否则新世界小票命中"现代-JEOCU"错桶(两行记账语义还可能相反)。
const { filterRowsByStore } = require('../../lib/validation/mode_store');
const { normalizeStoreFamily } = require('../../lib/validation/field_rules');
const { getStoreProfile, FAMILY } = require('../../lib/store_profiles');

// 百货模式常量判定(P4):'乐天百货'等含"百货"关键词 → dept 家族。
function isDeptModeRaw(modeRaw) {
  return getStoreProfile(normalizeStoreFamily(modeRaw)).family === FAMILY.DEPT;
}

const ERROR_TYPE = Object.freeze({
  TOUR_NOT_FOUND: 'TM_TOUR_NOT_FOUND',
  DATE_OUT_OF_WINDOW: 'TM_DATE_OUT_OF_WINDOW',
  AGENT_MISMATCH: 'TM_AGENT_MISMATCH',
  MODE_UNRESOLVED: 'TM_MODE_UNRESOLVED',
});

const BADCASE_KIND_BY_ERROR = Object.freeze({
  [ERROR_TYPE.TOUR_NOT_FOUND]: 'tour_not_found',
  [ERROR_TYPE.DATE_OUT_OF_WINDOW]: 'date_out_of_window',
  [ERROR_TYPE.AGENT_MISMATCH]: 'agent_mismatch',
  [ERROR_TYPE.MODE_UNRESOLVED]: 'mode_unresolved',
});

function createTourMatchService({
  dailyReceiptRepo,
  groupCodeRepo,
  batchGroupCodeRepo = null,
  pendingReviewRepo,
  errorRecordRepo = null,
  matchBadcaseRepo = null,
  modeFolderMappingRepo = null,
}) {
  if (!dailyReceiptRepo || !groupCodeRepo || !pendingReviewRepo) {
    throw new Error('tour_match_service: missing repos');
  }

  async function runImpl({ workspaceKey, stageJobId = null, sinceIso = null, batchId = null }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const startedAt = new Date().toISOString();

    // 缺口A: 加载操作员模式→桶映射表。命中(含显式"不参与"=null)优先于 7 枚举种子。
    const modeMappingMap = new Map();
    if (modeFolderMappingRepo?.listByWorkspace) {
      for (const r of modeFolderMappingRepo.listByWorkspace(workspaceKey)) {
        modeMappingMap.set(String(r.modeRaw == null ? '' : r.modeRaw).trim(), r.modeFolder || null);
      }
    }
    // 返回: 桶名 / null(显式不参与) / undefined(无映射,落到 7 枚举种子)
    function mappingLookup(modeRaw) {
      const k = String(modeRaw == null ? '' : modeRaw).trim();
      return modeMappingMap.has(k) ? modeMappingMap.get(k) : undefined;
    }

    // B2/M4(2026-07-16):本服务只许清自己产生的 tour 类待审——同 source_id 上还住着
    // second_pass_candidate(账单二次候选),无过滤会被每次增量跑连带扫掉。
    const TOUR_REASON_TYPES = ['tour_not_found', 'tour_ambiguous', 'tour_store_mismatch', 'date_out_of_window', 'agent_mismatch', 'mode_unresolved'];
    const pending = dailyReceiptRepo.listPendingTourMatch(workspaceKey, { sinceIso, batchId });
    // 重跑/行重新排队前,清掉这批待匹配行上次留下的团号匹配阻塞项(TM_*)与待补救,
    // 否则字段改正重排队、或重复跑团号匹配会让旧阻塞项残留累积(删台账已由 repo 级联处理,
    // 这里覆盖「行还在、只是重新排队」的场景)。
    const reprocessIds = pending.map((r) => r.id);
    const reprocessReceiptNos = pending.map((r) => r.receipt_no).filter(Boolean);
    // L610:按行(source_id)精确清,不连坐同票号兄弟行;legacy(source_id 为 null)由 receiptNos 兜底。
    if (errorRecordRepo?.deleteOpenBySourceIds && (reprocessIds.length || reprocessReceiptNos.length)) {
      errorRecordRepo.deleteOpenBySourceIds({ workspaceKey, sourceTable: 'daily_receipt_export', sourceIds: reprocessIds, receiptNos: reprocessReceiptNos, typePrefix: 'TM' });
    } else if (errorRecordRepo?.deleteOpenByReceiptNos && reprocessReceiptNos.length) {
      errorRecordRepo.deleteOpenByReceiptNos({ workspaceKey, receiptNos: reprocessReceiptNos, typePrefix: 'TM' }); // 老 repo 兜底
    }
    if (pendingReviewRepo?.deleteOpenBySourceIds && reprocessIds.length) {
      pendingReviewRepo.deleteOpenBySourceIds({ workspaceKey, sourceTable: 'daily_receipt_export', sourceIds: reprocessIds, reasonTypes: TOUR_REASON_TYPES });
    }

    // 自愈:台账行经「非本服务路径」(手工补救 / 重分类 / 重导后重匹配等)变成 matched 后,
    // 上一轮 tour-match 留下的 open pending_review(tour_not_found/agent_mismatch…)+ TM_ error_record
    // 没人清,会让首页「阻塞项/待补救」与台账实际状态(已 matched)对不上。每次跑团号匹配时
    // 顺手把"当前已 matched 行"的这些孤儿记录清掉(这些行不在待匹配集,不会被重新打回)。
    if (typeof dailyReceiptRepo._listAll === 'function') {
      const matchedRows = dailyReceiptRepo._listAll({ workspaceKey })
        .filter((r) => (r.tourMatchStatus ?? r.tour_match_status) === 'matched');
      const matchedIds = matchedRows.map((r) => r.id);
      const matchedReceipts = matchedRows.map((r) => r.receiptNo ?? r.receipt_no).filter(Boolean);
      // L610:按行(source_id)精确清——只清「本行已 matched」的 TM error,同票号另一行仍未解决的阻塞
      // 项保住(修连坐);legacy(source_id 为 null)由 receiptNos 兜底,过渡期不漏清。
      if (errorRecordRepo?.deleteOpenBySourceIds && (matchedIds.length || matchedReceipts.length)) {
        errorRecordRepo.deleteOpenBySourceIds({ workspaceKey, sourceTable: 'daily_receipt_export', sourceIds: matchedIds, receiptNos: matchedReceipts, typePrefix: 'TM' });
      } else if (errorRecordRepo?.deleteOpenByReceiptNos && matchedReceipts.length) {
        errorRecordRepo.deleteOpenByReceiptNos({ workspaceKey, receiptNos: matchedReceipts, typePrefix: 'TM' }); // 老 repo 兜底
      }
      if (pendingReviewRepo?.deleteOpenBySourceIds && matchedIds.length) {
        pendingReviewRepo.deleteOpenBySourceIds({ workspaceKey, sourceTable: 'daily_receipt_export', sourceIds: matchedIds, reasonTypes: TOUR_REASON_TYPES });
      }
    }

    progressTracker.update({ workspaceKey, stage: 'tour_match', current: 0, total: pending.length });
    const PROGRESS_TICK = 200;
    let processed = 0;
    const stats = {
      scanned: pending.length,
      matched: 0,
      tourNotFound: 0,
      tourAmbiguous: 0,
      tourStoreMismatch: 0,
      dateOutOfWindow: 0,
      agentMismatch: 0,
      modeUnresolved: 0,
      skippedModeNotRequired: 0,
      // scanned 已经数过取不到的那些行,不补这个桶的话各桶之和永远对不上 scanned
      fetchFailed: 0,
      folderBreakdown: {},
      skipped_due_to_manual_lock: { rows_affected: 0, fields: {} },
      ruleVersion: RULE_VERSION,
    };
    const pendingToInsert = [];
    const errorsToInsert = [];
    const badcasesToInsert = [];

    // Normalize OCR prefixes/suffixes before group-code lookup.
    function normalizeTourNo(s) {
      if (s == null) return '';
      return String(s).trim().replace(/^[A-Za-z]+/, '').replace(/[-_].*$/, '');
    }

    // Cache group_code lookups per tour_no for the duration of this run
    const tourCache = new Map();
    function lookupTour(tourNo) {
      const cacheKey = `${batchId || ''}:${tourNo}`;
      if (tourCache.has(cacheKey)) return tourCache.get(cacheKey);
      // 清单 #1: 取「全部版本」而非 findByTour(LIMIT 1),否则重复团号无法被歧义闸看到。
      // gc 仍取 gcRows[0](最新版,行为不变),歧义判定看全量。
      const findAll = (repo, args) =>
        (repo?.listAllVersionsByTour ? repo.listAllVersionsByTour(args)
          : repo?.findByTour ? repo.findByTour(args)
            : []);
      let rows = [];
      if (batchId && batchGroupCodeRepo) {
        rows = findAll(batchGroupCodeRepo, { batchId, tourNo });
      }
      if ((!rows || rows.length === 0) && groupCodeRepo) {
        rows = findAll(groupCodeRepo, { workspaceKey, tourNo });
      }
      if ((!rows || rows.length === 0)) {
        const norm = normalizeTourNo(tourNo);
        if (norm && norm !== String(tourNo).trim()) {
          if (batchId && batchGroupCodeRepo) {
            rows = findAll(batchGroupCodeRepo, { batchId, tourNo: norm });
          }
          if ((!rows || rows.length === 0) && groupCodeRepo) {
            rows = findAll(groupCodeRepo, { workspaceKey, tourNo: norm });
          }
        }
      }
      tourCache.set(cacheKey, rows || []);
      return rows || [];
    }

    for (const row of pending) {
      processed += 1;
      if (processed % PROGRESS_TICK === 0) {
        progressTracker.update({ workspaceKey, stage: 'tour_match', current: processed, total: pending.length });
      }
      const fullRow = fetchDailyRow(dailyReceiptRepo, workspaceKey, row.id);
      if (!fullRow) {
        // 0729 静默排查:原来是纯 continue —— 不进任何桶、不写 pending_review、
        // 不落 error_record、连一行日志都没有。那条台账行会**永远停在 pending**,
        // 而且因为它不在任何异常态里,人工补救界面也捞不出来:彻底消失。
        // 刚从 listPendingTourMatch 拿到 id,转头取整行却没了 —— 期间被删/迁走,
        // 或仓储实现缺 _fetchFullById。不阻断其余行,但必须留痕并计数。
        stats.fetchFailed += 1;
        structuredLogger.error('tour_match_fetch_full_failed', { workspaceKey, id: row.id });
        continue;
      }
      const tourNo = row.tour_no;
      if (isEmptyValue(tourNo)) {
        // 空团号但模式=百货常量(P4 桥接注入,如'乐天百货'):保模式收口 matched——
        // 否则换表重跑/reset 把状态打回 pending 后,这里会把常量清空、行永远 pending。
        // ⚠️只认百货(审查意见):非百货的残留 mode_raw(如上轮补救失败留下的复合键)
        // 照旧清空维持 pending,强制人工再判——自动救陈旧模式会掩盖该补救的行。
        if (!isEmptyValue(fullRow.modeRaw) && isDeptModeRaw(fullRow.modeRaw)) {
          recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
            id: row.id, workspaceKey,
            modeFolder: fullRow.modeFolder || null,
            modeRaw: fullRow.modeRaw,
            modeNormalized: fullRow.modeNormalized || null,
            tourMatchStatus: 'matched',
          }));
          continue;
        }
        recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
          id: row.id, workspaceKey,
          modeFolder: null, modeRaw: null, modeNormalized: null,
          tourMatchStatus: 'pending',  // keep pending
        }));
        continue;
      }
      const gcRows = lookupTour(tourNo);
      if (gcRows.length === 0) {
        stats.tourNotFound += 1;
        errorsToInsert.push(buildErrorRecord({
          workspaceKey, row, errorType: ERROR_TYPE.TOUR_NOT_FOUND,
          detectedAt: startedAt,
        }));
        badcasesToInsert.push(buildBadcase({
          workspaceKey, row, fullRow, stageJobId, startedAt,
          kind: BADCASE_KIND_BY_ERROR[ERROR_TYPE.TOUR_NOT_FOUND],
          snapshot: {
            input: { tourNo, agent: row.agent, purchaseDate: row.purchase_date },
            normalized: { tourNo: normalizeString(tourNo) },
            decision: 'tour_not_found',
            reason: 'group_code 表里找不到这个 tour_no',
          },
        }));
        pendingToInsert.push({
          workspaceKey,
          sourceTable: 'daily_receipt_export',
          sourceId: row.id,
          reasonType: 'tour_not_found',
          detail: {
            tourNo,
            agent: row.agent,
            purchaseDate: row.purchase_date,
            receiptNo: row.receipt_no,
            hint: '在 group_code 表里找不到这个 tour_no — 可能是代理还没补发团号表，或者团号写错了',
          },
          status: 'open',
          createdAt: startedAt,
        });
        // 团号没匹配上,但模式来自收票(店铺·分店·返点模式),与团号无关,照样赋上,
        // 让待补救/台账每条都有"团号模式",修对团号后能直接归桶。
        recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
          id: row.id, workspaceKey,
          modeFolder: null,
          modeRaw: compositeModeKey({ shop: fullRow.shop, branch: fullRow.branch, modeRaw: fullRow.modeRaw }) || null,
          modeNormalized: null,
          tourMatchStatus: 'tour_not_found',
        }));
        continue;
      }
      // 团号多店消歧(2026-07-07,70299病例):同团号多行属不同店是**合法数据**
      // (同一个团在新世界、现代各有消费)。先用本票店家(shop=receiptStoreFinal)选行:
      //   命中本店行 → 只留它们(跨店的另一行不再算歧义);
      //   候选全部可判店但没有一行属于本店 → tour_store_mismatch 进待补救,绝不错桶。
      const ticketStore = normalizeStoreFamily(fullRow.shop || '');
      const storePick = filterRowsByStore(gcRows, ticketStore);
      if (storePick.storeMismatch) {
        stats.tourStoreMismatch += 1;
        pendingToInsert.push({
          workspaceKey,
          sourceTable: 'daily_receipt_export',
          sourceId: row.id,
          reasonType: 'tour_store_mismatch',
          detail: {
            tourNo,
            agent: row.agent,
            purchaseDate: row.purchase_date,
            receiptNo: row.receipt_no,
            shop: fullRow.shop || '',
            candidates: storePick.candidates.map((g) => ({
              mode: g.mode,
              agent: g.agent,
            })),
            hint: `团号在表里,但候选模式都属别家店(本票店家:${fullRow.shop || '未知'})— 请核对小票店家或团号`,
          },
          status: 'open',
          createdAt: startedAt,
        });
        recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
          id: row.id, workspaceKey,
          modeFolder: null,
          modeRaw: compositeModeKey({ shop: fullRow.shop, branch: fullRow.branch, modeRaw: fullRow.modeRaw }) || null,
          modeNormalized: null,
          tourMatchStatus: 'tour_store_mismatch',
        }));
        continue;
      }
      const effectiveRows = storePick.rows;

      // 重复团号歧义保护闸 (清单 #1)
      // 店家消歧后仍多行(同店多模式),且这些行解析出的
      // "归类信号"(folder 或 skip)不一致 → 无法确定该走哪个桶 / 是否参加交付。
      // 不猜测,直接打 tour_ambiguous 进待补救,由人工裁决。
      if (effectiveRows.length > 1) {
        const signatures = new Set(
          effectiveRows.map((g) => {
            const m = g.mode || '';
            return isRequiredMode(m) ? `folder:${classifyModeFolder({ modeRaw: m }) || 'null'}` : 'skip';
          })
        );
        if (signatures.size > 1) {
          stats.tourAmbiguous += 1;
          pendingToInsert.push({
            workspaceKey,
            sourceTable: 'daily_receipt_export',
            sourceId: row.id,
            reasonType: 'tour_ambiguous',
            detail: {
              tourNo,
              agent: row.agent,
              purchaseDate: row.purchase_date,
              receiptNo: row.receipt_no,
              candidates: effectiveRows.map((g) => ({
                mode: g.mode,
                agent: g.agent,
                applyDate: g.apply_date,
                endDate: g.end_date,
              })),
              hint: '同一团号在团号表里命中多行,且归类信号不一致 — 请人工确认该团号实际属于哪个模式/桶',
            },
            status: 'open',
            createdAt: startedAt,
          });
          recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
            id: row.id, workspaceKey,
            modeFolder: null, modeRaw: null, modeNormalized: null,
            tourMatchStatus: 'tour_ambiguous',
          }));
          continue;
        }
      }

      const gc = effectiveRows[0];

      // 缺口A(数据驱动模式): 不再因"模式不在 7 枚举内"丢弃。
      // 团号找到 + 日期/代理 OK → 一律进台账,模式原样保留。
      // 归桶用映射表(7 枚举只作默认种子);映射不到的 folder=null,停在台账"待归类",
      // 由操作员在账单管理里勾选参与的桶,再由 mode_folder_apply_service 归桶。
      const violations = [];

      // Date window check (doc 搂1.5.1)
      const dateIssue = checkDateWindow(row.purchase_date, gc);
      if (dateIssue) {
        stats.dateOutOfWindow += 1;
        violations.push({ type: ERROR_TYPE.DATE_OUT_OF_WINDOW, detail: dateIssue });
      }

      // Agent check (doc 搂1.5.2)
      if (gc.agent && row.agent
          && !agentMatches(gc.agent, row.agent)) {
        stats.agentMismatch += 1;
        violations.push({
          type: ERROR_TYPE.AGENT_MISMATCH,
          detail: { expected: gc.agent, actual: row.agent },
        });
        pendingToInsert.push({
          workspaceKey,
          sourceTable: 'daily_receipt_export',
          sourceId: row.id,
          reasonType: 'agent_mismatch',
          detail: { tourNo, expected: gc.agent, actual: row.agent },
          status: 'open',
          createdAt: startedAt,
        });
      }

      // 归桶(缺口A): 优先用操作员映射表,7 枚举只作默认种子,都没有则 null=待归类。
      // folder=null 不再算"模式未解析"违规,也不进待补救——只是停在台账"未选择"等操作员勾选。
      // 团号表带精确模式(1月)→ 用 gc.mode;团号表无模式(2/3月新格式)→ 退到收票的
      // 店铺·分店·返点模式 组合 key(裸「SG」横跨多桶无法归类;组合天然唯一,见 mode_key.js)。
      const modeRaw = gc.mode
        || compositeModeKey({ shop: fullRow.shop, branch: fullRow.branch, modeRaw: fullRow.modeRaw })
        || fullRow.modeRaw;
      const modeInfo = modeRaw ? normalizeMode(modeRaw) : { code: null };
      const mappedFolder = mappingLookup(modeRaw);
      const folder = mappedFolder !== undefined ? mappedFolder : classifyModeFolder({ modeRaw });

      // 状态: 日期/代理问题 → 各自待补救;否则按是否归到桶。
      // folder=null → skipped_mode_not_required("未选择/待归类",非错误、不可被账单匹配,
      // 防止无桶行被跨桶账单误命中;操作员映射后由 apply_service 升级 matched)。
      const tourMatchStatus = violations.some((v) => v.type === ERROR_TYPE.AGENT_MISMATCH) ? 'agent_mismatch'
        : violations.some((v) => v.type === ERROR_TYPE.DATE_OUT_OF_WINDOW) ? 'date_out_of_window'
        : folder ? 'matched'
        : 'skipped_mode_not_required';
      if (!folder) stats.skippedModeNotRequired += 1;

      recordManualLockSkip(stats, dailyReceiptRepo.updateTourMatch({
        id: row.id, workspaceKey,
        modeFolder: folder,
        modeRaw,
        modeNormalized: modeInfo.code,
        tourMatchStatus,
      }));

      if (tourMatchStatus === 'matched') stats.matched += 1;
      if (folder) {
        stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
      }
      for (const v of violations) {
        if (v.type === ERROR_TYPE.DATE_OUT_OF_WINDOW || v.type === ERROR_TYPE.MODE_UNRESOLVED || v.type === ERROR_TYPE.AGENT_MISMATCH) {
          errorsToInsert.push(buildErrorRecord({
            workspaceKey, row, errorType: v.type, detectedAt: startedAt,
            expected: v.detail?.expected, actual: v.detail?.actual,
          }));
          badcasesToInsert.push(buildBadcase({
            workspaceKey, row, fullRow, stageJobId, startedAt,
            kind: BADCASE_KIND_BY_ERROR[v.type] || 'unmatched',
            snapshot: {
              input: { tourNo, agent: row.agent, purchaseDate: row.purchase_date,
                       shop: fullRow.shop, branch: fullRow.branch, modeRaw: fullRow.modeRaw },
              groupCode: { tourNo: gc.tour_no, agent: gc.agent, mode: gc.mode,
                           applyDate: gc.apply_date, endDate: gc.end_date },
              decision: tourMatchStatus,
              reason: v.detail,
            },
          }));
        }
      }
    }
    progressTracker.update({ workspaceKey, stage: 'tour_match', current: processed, total: pending.length });

    if (pendingToInsert.length) pendingReviewRepo.insertMany(pendingToInsert);
    if (errorRecordRepo && errorsToInsert.length) {
      errorRecordRepo.insertMany(errorsToInsert);
    }
    if (matchBadcaseRepo && badcasesToInsert.length) {
      try {
        matchBadcaseRepo.insertMany(badcasesToInsert);
      } catch (error) {
        stats.badcaseWriteError = String(error?.message || error);
        // 静默失败审计 2026-07-12:同 bill_match——异常件丢失必须可 grep
        structuredLogger.error('badcase_insert_failed', { source: 'tour_match', count: badcasesToInsert.length, error: stats.badcaseWriteError });
      }
    }

    return {
      workspaceKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...stats,
    };
  }

  // 锁下沉(8模块审计 HIGH):run 内部先删该批 pending 行上的 open error_record/pending_review
  // 再重建,同 workspace 两个 run 并发会互相删/建踩花。把 per-workspace 串行锁收口在这里,
  // 三条调用路径(导入台账 / 确认即结算 / stage-routes tour-match & tour-rematch)自动互斥。
  // ⚠️锁不可重入(promise 链):调用方切勿再外包同一把锁,否则同 key 双取=死锁
  //   (approve_settle 原来的外层 withWorkspaceTourMatchLock 已随本次收口移除)。
  async function run(args = {}) {
    return withWorkspaceTourMatchLock(args.workspaceKey, () => runImpl(args));
  }

  return { run, ERROR_TYPE };
}

function buildBadcase({ workspaceKey, row, fullRow, stageJobId, startedAt, kind, snapshot }) {
  return {
    workspaceKey,
    stage: 'tour_match',
    kind,
    ruleVersion: RULE_VERSION,
    sourceTable: 'daily_receipt_export',
    sourceId: row.id,
    dailyReceiptId: row.id,
    storeBillId: null,
    receiptNo: row.receipt_no || fullRow.receiptNo || null,
    tourNo: row.tour_no || null,
    passportNo: fullRow.passportNo || null,
    name: fullRow.name || null,
    purchaseDate: row.purchase_date || null,
    snapshot,
    createdAt: startedAt,
    stageJobId,
  };
}

function recordManualLockSkip(stats, result) {
  const skipped = Array.isArray(result?.skippedDueToManualLock)
    ? result.skippedDueToManualLock
    : [];
  if (!skipped.length) return;
  stats.skipped_due_to_manual_lock.rows_affected += 1;
  for (const field of skipped) {
    stats.skipped_due_to_manual_lock.fields[field] =
      (stats.skipped_due_to_manual_lock.fields[field] || 0) + 1;
  }
}

function fetchDailyRow(repo, workspaceKey, id) {
  // dailyReceiptRepo has listByMode but not a single-row getter; use a
  // lightweight query directly on the shared db via repo.findByReceipt
  // isn't right. Instead use a passthrough since we already have the
  // raw row from listPendingTourMatch(). This helper is kept for the
  // full shape when we need it (shop/branch etc.).
  // listPendingTourMatch returns only summary columns; fetch the rest.
  if (!repo._fetchFullById) return null;
  return repo._fetchFullById({ workspaceKey, id });
}

function checkDateWindow(purchaseDate, gc) {
  if (isEmptyValue(purchaseDate)) return null; // no date to check
  const pd = normalizeDate(purchaseDate);
  const start = gc.apply_date || gc.applyDate || null;
  const end = gc.end_date || gc.endDate || null;
  if (start) {
    const s = normalizeDate(start);
    if (s && pd < s) return { reason: 'before_apply_date', applyDate: start, purchaseDate };
  }
  if (end) {
    const e = normalizeDate(end);
    if (e && pd > e) return { reason: 'after_end_date', endDate: end, purchaseDate };
  }
  return null;
}

function buildErrorRecord({ workspaceKey, row, errorType, detectedAt, expected = null, actual = null }) {
  return {
    workspaceKey,
    errorType,
    severity: errorType === ERROR_TYPE.AGENT_MISMATCH ? 'high' : 'medium',
    tourNo: row.tour_no,
    receiptNo: row.receipt_no,
    expectedValue: expected,
    actualValue: actual,
    status: 'open',
    detectedAt,
    // L610:行级来源——自愈/count 守卫按行精确,不再连坐同票号兄弟行。
    sourceId: row.id,
    sourceTable: 'daily_receipt_export',
  };
}

module.exports = { createTourMatchService, ERROR_TYPE };
