'use strict';

/**
 * Listing surface — Sprint 1 + Sprint 2 read-mostly endpoints.
 *
 * Grouped together because they all share the same `?limit&offset` +
 * filter-by-status pagination shape; splitting further would inflate
 * boilerplate without buying anything.
 */

const { normalizeMode } = require('../../lib/monthly_pipeline/mode_normalizer');
const { normalizeGroupNo, normalizeOcrDate } = require('../../lib/workbench_field_normalizer');
const { classifyModeFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { normalizeDate, isEmptyValue } = require('../../lib/monthly_pipeline/matching/field_diff');
// 同团号多店消歧(2026-07-07):日期窗提示按本行店家选团号行,防拿别家店的窗口误报
const { filterRowsByStore } = require('../../lib/validation/mode_store');
const { normalizeStoreFamily } = require('../../lib/validation/field_rules');
const {
  workspaceKeyFromReq,
  clampInt,
  ensureWorkspaceWritable,
  sendRouteError,
  serviceUnavailable,
} = require('./route_utils');
const {
  buildLedgerOwnerScope,
  canAccessAllOperatorData,
} = require('../../lib/operator_scope');
const { assertPurchaseBeforeDeparture } = require('../../lib/monthly/workspace_resolver');

// 待补救复查(三期)允许审核员改正的字段:除原有 购买日期/团号/代理 外,
// 加上 姓名/护照号(审核员可能把这两项看错)。applyFieldUpdates 会自动写 daily_field_history 留痕。
const LEDGER_FIELD_UPDATES = Object.freeze(['purchaseDate', 'tourNo', 'agent', 'name', 'passportNo']);
const ENDPOINT_REMOVED_RESPONSE = Object.freeze({
  error: '端点已废弃，请改用 PATCH /fields 直接编辑',
  code: 'endpoint_removed',
});

function registerListingRoutes({ app, guards, deps }) {
  const { read, fieldReview } = guards;
  const {
    groupCodeRepo, batchGroupCodeRepo, storeBillRepo, brandActivityRepo, missingReceiptRepo, errorRecordRepo,
    receivedReceiptRepo, dailyReceiptRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo,
    errorDetectionService, pendingReviewResolutionService, workspaceService,
    dailyWorkspaceMigrationService,
    dailyFieldHistoryRepo,
    derivationRecomputeService,
  } = deps;

  // A3(2026-07-16 同步一致性审计):台账手改/人工补救/行删/待审解决此前**不标脏**——
  // 人工补救成 matched 的行不进 monthly_data、改值不刷新导出,直到别的事件恰好标脏该月。
  // 统一走派生标脏(失败不拦业务,ensureFresh 在核对/出包前兜底重算)。
  function markDerivationDirty(workspaceKey, stage) {
    try { derivationRecomputeService?.markDirty(workspaceKey, stage); } catch { /* noop */ }
  }

  app.get('/api/monthly/workspaces/:workspaceKey/ledger', ...read, (req, res) => {
    if (!dailyReceiptRepo || typeof dailyReceiptRepo.listLedger !== 'function') {
      return res.status(503).json({ error: 'ledger not available (repo missing)' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const limit = clampInt(req.query.limit, 1, 500, 50);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      // 清单 #4: 台账「只认 matched」的口径作用于交付/合并取数(listByMode)与
      // 桶台账计数(dailyInBucket),不作用于本「台账编辑列表」——这里是审核员
      // 修正未匹配行的工作面,必须能看到 pending/未命中/越界等行。需要只看 matched
      // 的调用方可显式传 onlyMatched=true;待补救页传 tourMatchStatus 精确过滤。
      const onlyMatched = req.query.onlyMatched === 'true' && !req.query.tourMatchStatus;
      const filter = {
        workspaceKey,
        receiptDateFrom: req.query.from || null,
        receiptDateTo: req.query.to || null,
        agentId: req.query.agentId ? Number(req.query.agentId) : null,
        modeFolder: req.query.modeFolder || null,
        sourceType: req.query.sourceType || null,
        tourMatchStatus: req.query.tourMatchStatus || null,
        billMatchStatus: req.query.billMatchStatus || null,
        ledgerStatus: req.query.ledgerStatus || null,
        remedyReason: req.query.remedyReason || null,
        onlyMatched,
      };
      const scopedFilter = withLedgerOperatorScope(filter, req.user);
      const rows = dailyReceiptRepo.listLedger({ ...scopedFilter, limit, offset });
      const total = dailyReceiptRepo.countLedger(scopedFilter);
      const byAgent = dailyReceiptRepo.groupByAgent({
        workspaceKey,
        receiptDateFrom: scopedFilter.receiptDateFrom,
        receiptDateTo: scopedFilter.receiptDateTo,
        ownerUserId: scopedFilter.ownerUserId,
        ownerUsername: scopedFilter.ownerUsername,
      });
      res.json({ rows, total, byAgent, filter: { ...scopedFilter, limit, offset } });
    } catch (error) {
      console.error('[ledger_route] failed:', error);
      res.status(500).json({ error: error?.message || 'ledger query failed' });
    }
  });

  app.get('/api/monthly/workspaces/:workspaceKey/ledger/status-counts', ...read, (req, res) => {
    if (!dailyReceiptRepo || typeof dailyReceiptRepo.countByLedgerStatus !== 'function') {
      return res.status(503).json({ error: 'ledger not available' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const counts = dailyReceiptRepo.countByLedgerStatus(withLedgerOperatorScope({
        workspaceKey,
        receiptDateFrom: req.query.from || null,
        receiptDateTo: req.query.to || null,
        agentId: req.query.agentId ? Number(req.query.agentId) : null,
        sourceType: req.query.sourceType || null,
        tourMatchStatus: req.query.tourMatchStatus || null,
        billMatchStatus: req.query.billMatchStatus || null,
        ledgerStatus: req.query.ledgerStatus || null,
        remedyReason: req.query.remedyReason || null,
      }, req.user));
      res.json({ counts });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'count failed' });
    }
  });

  // 0731:审核台页签的「异常补救 N」承接角标专用。
  // 只回 {status, n} 的分组计数,不带行 —— 主作业面上多挂一个请求,
  // 就得是**极轻**的那种;为一个角标去拉 /workbench/overview(首页级聚合)不划算。
  app.get('/api/monthly/workspaces/:workspaceKey/ledger/tour-status-counts', ...read, (req, res) => {
    if (!dailyReceiptRepo || typeof dailyReceiptRepo.countByTourMatchStatus !== 'function') {
      return res.status(503).json({ error: 'ledger not available' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const counts = dailyReceiptRepo.countByTourMatchStatus(withLedgerOperatorScope({
        workspaceKey,
        receiptDateFrom: req.query.from || null,
        receiptDateTo: req.query.to || null,
        agentId: req.query.agentId ? Number(req.query.agentId) : null,
        sourceType: req.query.sourceType || null,
      }, req.user));
      res.json({ counts });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'count failed' });
    }
  });

  app.post('/api/monthly/workspaces/:workspaceKey/ledger/:id/status', ...fieldReview, (req, res) => {
    return res.status(410).json(ENDPOINT_REMOVED_RESPONSE);
  });

  app.patch('/api/monthly/workspaces/:workspaceKey/ledger/:id/fields', ...fieldReview, (req, res) => {
    if (!dailyReceiptRepo || typeof dailyReceiptRepo.applyFieldUpdates !== 'function') {
      return res.status(503).json({ error: 'ledger not available' });
    }
    const body = req.body || {};
    const updates = {};
    const manualRemedyConfirm = body.manualRemedyConfirm === true;

    if (Object.prototype.hasOwnProperty.call(body, 'modeRaw')) {
      const modeRaw = body.modeRaw == null ? '' : String(body.modeRaw).trim();
      updates.modeRaw = modeRaw || null;
      if (modeRaw) {
        updates.modeNormalized = normalizeMode(modeRaw).code;
        updates.modeFolder = classifyModeFolder({ modeRaw });
      } else {
        updates.modeNormalized = null;
        updates.modeFolder = null;
      }
    }

    for (const field of LEDGER_FIELD_UPDATES) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const raw = body[field] == null ? null : String(body[field]).trim();
        // 人工改台账字段落库前过中央口径(2026-07-10 审计收口):补救台曾零归一直写,
        // 与审核台双入口双口径。团号保字母/剥标签;票号保字母+横线;护照去空格大写;
        // 日期归一失败=400 拒收(禁止把 '2026/1/5' 之类写进词典序比较的日期列)。
        if (raw == null || raw === '') { updates[field] = raw; }
        else if (field === 'tourNo') {
          // 副本漂移收口(2026-07-21 全链路排查 P0):台账桥把「无」归一成 NULL 落库
          // (workbench_ledger_bridge_service.normalizeTourNo),这里曾原样存字符串「无」——
          // 下游 confirmModesByGroup 只认 IS NULL、tour_match 把「无」当真团号查表必落
          // tour_not_found,机场票在补救面板订正成「无」反而进补救死循环。对齐桥口径。
          const normalizedTour = normalizeGroupNo(raw);
          updates[field] = normalizedTour === '无' ? null : normalizedTour;
        }
        // 注:receiptNo 不在 LEDGER_FIELD_UPDATES 白名单里,不可达分支已删(已结算行票号在台账侧无订正入口,见 line151)。
        else if (field === 'passportNo') { updates[field] = raw.toUpperCase().replace(/\s+/g, ''); }
        else if (field === 'purchaseDate' || field === 'departureDate') {
          const normalizedDate = normalizeOcrDate(raw);
          if (!normalizedDate) {
            return res.status(400).json({
              error: `${field === 'purchaseDate' ? '购买' : '出境'}日期格式无法识别:${raw}(请用 YYYY-MM-DD)`,
              code: field === 'purchaseDate' ? 'invalid_purchase_date' : 'invalid_departure_date',
            });
          }
          updates[field] = normalizedDate;
        }
        else { updates[field] = raw; }
      }
    }
    updates.modifiedBy = req.user?.username || null;

    try {
      const workspaceKey = workspaceKeyFromReq(req);
      ensureWorkspaceWritable({ workspaceService, workspaceKey });
      const id = Number(req.params.id);
      const existing = typeof dailyReceiptRepo._fetchFullById === 'function'
        ? dailyReceiptRepo._fetchFullById({ workspaceKey, id })
        : null;
      if (!existing) return res.status(404).json({ error: 'row not found' });

      const accessIssue = getLedgerOwnerAccessIssue({ row: existing, user: req.user });
      if (accessIssue) {
        return res.status(accessIssue.status).json({ error: accessIssue.message, code: accessIssue.code });
      }

      // G11d: reject purchase dates after the existing departure date.
      if (Object.prototype.hasOwnProperty.call(updates, 'purchaseDate') && updates.purchaseDate) {
        try {
          assertPurchaseBeforeDeparture({
            purchaseDate: updates.purchaseDate,
            departureDate: existing.departureDate,
          });
        } catch (e) {
          if (e?.code === 'departure_before_purchase') {
            return res.status(400).json({ error: e.message, code: e.code });
          }
          throw e;
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(updates, 'purchaseDate')
        && dailyWorkspaceMigrationService?.migrateDailyByPurchaseDate
      ) {
        const migration = dailyWorkspaceMigrationService.migrateDailyByPurchaseDate({
          workspaceKey,
          dailyReceiptId: id,
          newPurchaseDate: updates.purchaseDate,
          operator: req.user?.username || null,
        });
        updates.purchaseDate = migration.purchaseDate || updates.purchaseDate;
        if (migration.migrated) {
          delete updates.purchaseDate;
          let updateResult = { changes: 1 };
          if (Object.keys(updates).length > 0) {
            updateResult = dailyReceiptRepo.applyFieldUpdates({
              id,
              workspaceKey: migration.targetWorkspaceKey,
              updates,
              manualLock: true,
              actor: req.user?.username || null,
            });
          }
          const row = dailyReceiptRepo._fetchFullById({
            workspaceKey: migration.targetWorkspaceKey,
            id,
          });
          // A3 标脏(8模块审计 HIGH:迁移分支直接 return,漏了非迁移路径 line 284 的标脏)——
          // 否则迁移行落目标月为 pending,但 dirty_from=null 让 ensureFresh no-op、别批次结算的
          // 增量匹配又只扫本批次,该票在两个月都钉死:源月交付仍含旧行、目标月永判 pending 漏掉。
          // 源月:行已移走,merge 要重算把它从交付摘掉(bill_match 起,merge 随下游);
          // 目标月:新来的 pending 行要 tour_match 才能匹配进月度。
          markDerivationDirty(migration.sourceWorkspaceKey, 'bill_match');
          markDerivationDirty(migration.targetWorkspaceKey, 'tour_match');
          return res.json({
            ok: true,
            migrated: true,
            sourceWorkspaceKey: migration.sourceWorkspaceKey,
            targetWorkspaceKey: migration.targetWorkspaceKey,
            changes: Number(updateResult?.changes || 0),
            message: '该行已迁移到新月份，源月需要重跑 merge，目标月需要跑 tour_match',
            row,
          });
        }
      }

      const dateIssue = getLedgerDateWindowIssue({
        groupCodeRepo,
        workspaceKey,
        row: { ...existing, ...updates },
      });
      // F12(2026-07-18 设计):tour_match_status 只在 manualRemedyConfirm(人工背书)时才随
      // manualLock 锁进 manual_locked_fields。无 confirm 手改踩日期窗写的 date_out_of_window
      // 是系统咨询性状态,若跟着上锁:换表 reset 裸 SQL 打回 pending 后,tour_match 重跑走
      // filterStageUpdates 跳过锁列 → 行永久卡 pending,从补救台消失。故拆成第二笔
      // 非锁定写(manualLock:false,同时尊重既有锁——人工背书过的行不被咨询状态降级)。
      if (manualRemedyConfirm) {
        updates.tourMatchStatus = 'matched';
      }

      const updateResult = dailyReceiptRepo.applyFieldUpdates({
        id, workspaceKey, updates, manualLock: true, actor: req.user?.username || null,
      });

      // 台账侧订正(审计MEDIUM):普通改团号(非补救确认)且行当前 matched 且 tour_match_status 未被
      // 人工背书锁 → 把状态重置为 pending 让新团号重查表出**新**模式/桶。此前状态保持 matched、
      // 只标 bill_match,而 tour_match 只扫 pending 行(queries listPendingTourStmt),matched 行的
      // mode_raw/mode_folder 永不按新团号重算 →「团号改了、模式还是旧团号的」。第二笔非锁定写自动
      // 尊重既有背书锁(F12:锁列被 filterStageUpdates 跳过则不重置,不误把背书行打回 pending)。
      const oldTour = String(existing.tourNo ?? existing.tour_no ?? '').trim();
      const newTour = String(updates.tourNo ?? '').trim();
      const tourNoChanged = Object.prototype.hasOwnProperty.call(updates, 'tourNo') && newTour !== oldTour;
      const wasMatched = String(existing.tourMatchStatus ?? existing.tour_match_status ?? '') === 'matched';
      let tourRematchQueued = false;
      if (tourNoChanged && wasMatched && !manualRemedyConfirm) {
        const reset = dailyReceiptRepo.applyFieldUpdates({
          id, workspaceKey,
          updates: { tourMatchStatus: 'pending' },
          manualLock: false,
          historySource: 'manual_edit',
          actor: req.user?.username || null,
        });
        tourRematchQueued = !((reset?.skippedDueToManualLock || []).includes('tour_match_status'));
      }

      // 咨询状态被既有锁跳过(行已人工背书 matched)时给响应打信号——不报错不降级,
      // 但"日期已出窗、状态仍 matched"的事实要可观测,否则后续对不上账无从排查(复核MEDIUM)。
      let dateWindowConflictIgnored = false;
      if (dateIssue && !manualRemedyConfirm) {
        const advisory = dailyReceiptRepo.applyFieldUpdates({
          id, workspaceKey,
          updates: { tourMatchStatus: 'date_out_of_window' },
          manualLock: false,
          historySource: 'manual_edit',
          actor: req.user?.username || null,
        });
        dateWindowConflictIgnored = (advisory?.skippedDueToManualLock || []).includes('tour_match_status');
      }
      const changes = typeof updateResult === 'number'
        ? updateResult
        : Number(updateResult?.changes || 0);
      if (changes === 0) return res.status(404).json({ error: 'row not found or no change' });
      // A3:人工补救直标 matched → 从 tour_match 起重算(它要进月度);改团号重排队 → 也从 tour_match 起
      // (新团号要重查表出模式);其余普通手改 → bill_match 起(票号/日期/店变了匹配要重跑,merge 随下游)。过度重算方向,安全。
      markDerivationDirty(workspaceKey, (manualRemedyConfirm || tourRematchQueued) ? 'tour_match' : 'bill_match');
      const row = dailyReceiptRepo._fetchFullById({ workspaceKey, id });
      res.json({ ok: true, changes, row, ...(dateWindowConflictIgnored ? { dateWindowConflictIgnored: true } : {}) });
    } catch (error) {
      sendRouteError(res, error, 'update fields failed');
    }
  });

  app.get('/api/monthly/v2/:workspaceKey/daily/:rowId/history', ...read, (req, res) => {
    if (!dailyFieldHistoryRepo || typeof dailyFieldHistoryRepo.list !== 'function') {
      return res.status(503).json({ error: 'daily field history not available' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const dailyRowId = Number(req.params.rowId);
      const limit = clampInt(req.query.limit, 1, 200, 50);
      const rows = dailyFieldHistoryRepo.list({
        workspaceKey,
        dailyRowId,
        source: req.query.source || null,
        before: req.query.before || null,
        limit,
      });
      res.json({
        items: rows,
        rows,
        total: rows.length,
        filter: { workspaceKey, dailyRowId, source: req.query.source || null, limit },
      });
    } catch (error) {
      sendRouteError(res, error, 'daily history query failed');
    }
  });

  app.delete('/api/monthly/workspaces/:workspaceKey/ledger/:id', ...fieldReview, (req, res) => {
    if (!dailyReceiptRepo || typeof dailyReceiptRepo.deleteLedgerRow !== 'function') {
      return res.status(503).json({ error: 'ledger not available' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      ensureWorkspaceWritable({ workspaceService, workspaceKey });
      const id = Number(req.params.id);
      const existing = typeof dailyReceiptRepo._fetchFullById === 'function'
        ? dailyReceiptRepo._fetchFullById({ workspaceKey, id })
        : null;
      const deleteIssue = getLedgerDeleteIssue({ row: existing, user: req.user });
      if (deleteIssue) {
        return res.status(deleteIssue.status).json({
          error: deleteIssue.message,
          code: deleteIssue.code,
        });
      }
      const changes = dailyReceiptRepo.deleteLedgerRow({
        workspaceKey,
        id,
      });
      if (changes === 0) return res.status(404).json({ error: 'row not found' });
      // A3:行删了 → 它配对的账单要回未收池 + 月度刷新(bill_match 起重算)
      markDerivationDirty(workspaceKey, 'bill_match');
      res.json({ ok: true, deleted: changes });
    } catch (error) {
      sendRouteError(res, error, 'delete ledger row failed');
    }
  });

  app.post('/api/monthly/workspaces/:workspaceKey/ledger/publish', ...fieldReview, (req, res) => {
    return res.status(410).json(ENDPOINT_REMOVED_RESPONSE);
  });

  // 鈹€鈹€ Sprint 1 listings 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  app.get('/api/monthly/workspaces/:workspaceKey/group-codes/used', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    if (!dailyReceiptRepo?.listUsedGroupCodes) {
      return serviceUnavailable(res, 'daily_receipt_repo');
    }
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const rows = dailyReceiptRepo.listUsedGroupCodes({ workspaceKey, limit, offset });
    res.json({ rows, total: dailyReceiptRepo.countUsedGroupCodes(workspaceKey) });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/batch-group-codes/modes', ...read, (req, res) => {
    if (!batchGroupCodeRepo?.listModesByBatch) {
      return serviceUnavailable(res, 'batch_group_code_repo');
    }
    const workspaceKey = workspaceKeyFromReq(req);
    const batchId = String(req.query.batchId || '').trim();
    if (!batchId) return res.status(400).json({ error: 'batchId required', code: 'batch_id_required' });
    const modes = batchGroupCodeRepo.listModesByBatch(batchId);
    res.json({ workspaceKey, batchId, modes });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/batch-group-codes', ...read, (req, res) => {
    if (!batchGroupCodeRepo?.listByBatch) {
      return serviceUnavailable(res, 'batch_group_code_repo');
    }
    const workspaceKey = workspaceKeyFromReq(req);
    const batchId = String(req.query.batchId || '').trim();
    if (!batchId) return res.status(400).json({ error: 'batchId required', code: 'batch_id_required' });
    // 按团号精确查(复查弹窗用,与 tour_match 同源):传 tourNo 时只返回该团号的所有版本行,
    // 不分页 —— 避免大团号表分页后漏掉目标团号,导致弹窗误报「团号表没有」。
    const tourNo = String(req.query.tourNo || '').trim();
    if (tourNo && batchGroupCodeRepo.findByTour) {
      const rows = batchGroupCodeRepo.findByTour({ batchId, tourNo });
      return res.json({ workspaceKey, batchId, tourNo, rows, total: rows.length });
    }
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    res.json({
      workspaceKey,
      batchId,
      rows: batchGroupCodeRepo.listByBatch({ batchId, limit, offset }),
      total: batchGroupCodeRepo.countByBatch(batchId),
    });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/group-codes', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { query = '' } = req.query;
    const limit = clampInt(req.query.limit, 1, 500, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const rows = query
      ? groupCodeRepo.search({ workspaceKey, query, limit, offset })
      : groupCodeRepo.list({ workspaceKey, limit, offset });
    res.json({ rows, total: groupCodeRepo.countByWorkspace(workspaceKey) });
  });

  // 品牌活动(活动数据)第5个桶:列表 + 汇总。导入走普通账单导入(自动分流),
  // 这里只读 + 清空(替换)。
  app.get('/api/monthly/workspaces/:workspaceKey/brand-activity', ...read, (req, res) => {
    if (!brandActivityRepo) return serviceUnavailable(res, 'brand_activity_repo');
    const workspaceKey = workspaceKeyFromReq(req);
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    res.json({
      rows: brandActivityRepo.list({ workspaceKey, limit, offset }),
      total: brandActivityRepo.countByWorkspace(workspaceKey),
      summary: brandActivityRepo.summary(workspaceKey),
    });
  });

  // 清空品牌活动桶(替换前先清旧;清空后需重跑 merge)。
  app.delete('/api/monthly/workspaces/:workspaceKey/brand-activity', ...fieldReview, (req, res) => {
    if (!brandActivityRepo) return serviceUnavailable(res, 'brand_activity_repo');
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      ensureWorkspaceWritable({ workspaceService, workspaceKey });
      const deleted = brandActivityRepo.deleteByWorkspace(workspaceKey);
      res.json({ ok: true, deleted });
    } catch (error) {
      sendRouteError(res, error, 'clear brand activity failed');
    }
  });

  app.get('/api/monthly/workspaces/:workspaceKey/bills', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { family = null, mode = null } = req.query;
    const limit = clampInt(req.query.limit, 1, 500, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const scope = { workspaceKey, family: family || null, mode: mode || null };
    const rows = storeBillRepo.list({ ...scope, limit, offset });
    // total 必须与 rows **同一套筛选**(2026-08-01):原来是 countByWorkspace(整个工作区),
    // 筛成一家店时列表 30 行、页脚"共 5000 条",分页还给出一堆点进去是空的页码。
    res.json({ rows, total: storeBillRepo.countFiltered(scope) });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/coverage', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    if (!storeBillRepo?.tourCoverageStats) {
      return res.status(503).json({ error: 'coverage stats not available', code: 'service_unavailable' });
    }
    try {
      const stats = storeBillRepo.tourCoverageStats(workspaceKey);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'coverage failed' });
    }
  });

  app.get('/api/monthly/workspaces/:workspaceKey/missing', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { status = null } = req.query;
    const limit = clampInt(req.query.limit, 1, 500, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const rows = missingReceiptRepo.list({
      workspaceKey, status: status || null, limit, offset,
    });
    res.json({ rows, total: missingReceiptRepo.countByWorkspace(workspaceKey) });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/errors', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { errorType = null, status = null } = req.query;
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const rows = errorRecordRepo.list({
      workspaceKey,
      errorType: errorType || null,
      status: status || null,
      limit, offset,
    });
    res.json({ rows, summary: errorRecordRepo.countByType(workspaceKey) });
  });

  app.post('/api/monthly/workspaces/:workspaceKey/errors/:id/resolve', ...fieldReview, (req, res) => {
    try {
      ensureWorkspaceWritable({ workspaceService, workspaceKey: workspaceKeyFromReq(req) });
      errorDetectionService.resolve({
        id: Number(req.params.id),
        resolvedBy: req.user?.username,
        note: req.body?.note || null,
      });
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, 'resolve failed', 400);
    }
  });

  if (receivedReceiptRepo) {
    app.get('/api/monthly/workspaces/:workspaceKey/received-receipts', ...read, (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      res.json({
        rows: receivedReceiptRepo.list({ workspaceKey, limit, offset }),
        total: receivedReceiptRepo.countByWorkspace(workspaceKey),
        byWorker: receivedReceiptRepo.countByWorker(workspaceKey),
      });
    });
  }

  if (dailyReceiptRepo) {
    app.get('/api/monthly/workspaces/:workspaceKey/daily-receipts', ...read, (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const { modeFolder = null, billMatchStatus = null, tourMatchStatus = null } = req.query;
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const rows = dailyReceiptRepo.listFiltered({
        workspaceKey,
        modeFolder: modeFolder || null,
        billMatchStatus: billMatchStatus || null,
        tourMatchStatus: tourMatchStatus || null,
        limit, offset,
      });
      const total = dailyReceiptRepo.countFiltered({
        workspaceKey,
        modeFolder: modeFolder || null,
        billMatchStatus: billMatchStatus || null,
        tourMatchStatus: tourMatchStatus || null,
      });
      res.json({ rows, total });
    });
  }

  if (billMatchLogRepo) {
    app.get('/api/monthly/workspaces/:workspaceKey/bill-match-logs', ...read, (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const { status = null } = req.query;
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      res.json({
        rows: billMatchLogRepo.list({ workspaceKey, status: status || null, limit, offset }),
        total: billMatchLogRepo.countByWorkspace(workspaceKey),
        byStatus: billMatchLogRepo.countByStatus(workspaceKey),
      });
    });
  }

  if (monthlyDataRepo) {
    app.get('/api/monthly/workspaces/:workspaceKey/monthly-data', ...read, (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      const { modeFolder = null, isUnmatched = null } = req.query;
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const flag = isUnmatched == null ? null : isUnmatched === '1' || isUnmatched === 'true';
      const rows = monthlyDataRepo.listFiltered({
        workspaceKey, modeFolder: modeFolder || null, isUnmatched: flag, limit, offset,
      });
      const total = monthlyDataRepo.countFiltered({
        workspaceKey, modeFolder: modeFolder || null, isUnmatched: flag,
      });
      // totals:**全量**返点合计,不是这一页的和。
      // 前端原来拿当前已加载的 500 行累加当"返点合计",而真实月份是万行级 ——
      // 那个数可能只有真值的百分之几,却和全量的「交付总行数」并排显示。
      // 跟随同一套筛选(modeFolder / isUnmatched),口径与 rows 一致。
      const totals = monthlyDataRepo.sumRebateByMode({
        workspaceKey, modeFolder: modeFolder || null, isUnmatched: flag,
      });
      res.json({
        rows,
        total,
        byMode: monthlyDataRepo.countByMode(workspaceKey),
        totals,
        // 这一页到底装了多少行 —— 前端据此判断"列表是截断的"并说明白
        listCap: limit,
      });
    });

    // 2026-06-13:monthly_data 改为纯派生只读。逐行手改已下线——交付数据随台账/账单/
    // 扣点/模式最新状态由 ensureFresh 自动重算,手改会被重算覆盖且与"跟着台账走"矛盾。
    // 修正请到源头(台账核对 / 账单导入 / 扣点·模式配置)。端点保留返回 410 拦旧客户端。
    app.patch('/api/monthly/workspaces/:workspaceKey/monthly-data/:id', ...fieldReview, (req, res) => res.status(410).json({
      error: '月度数据为只读派生结果,不再支持逐行手改;请到台账/账单/扣点/模式源头修改,回交付页会自动重算',
      code: 'monthly_data_readonly',
    }));
  }

  // Pending-review endpoint is always registered; missing repo returns 503.
  app.get('/api/monthly/workspaces/:workspaceKey/pending-reviews', ...read, (req, res) => {
    if (!pendingReviewRepo) {
      return serviceUnavailable(res, 'pending_review_repo');
    }
    const workspaceKey = workspaceKeyFromReq(req);
    const { status = 'open' } = req.query;
    const reasonType = req.query.reasonType ? String(req.query.reasonType).trim() : null;
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const rows = pendingReviewRepo.list({
      workspaceKey, status: status || null, reasonType: reasonType || null, limit, offset,
    });
    const total = typeof pendingReviewRepo.count === 'function'
      ? pendingReviewRepo.count({ workspaceKey, status: status || null, reasonType: reasonType || null })
      : pendingReviewRepo.countOpen(workspaceKey);
    res.json({
      rows,
      total,
      byReason: pendingReviewRepo.countByReason(workspaceKey),
      filter: { workspaceKey, status: status || null, reasonType: reasonType || null, limit, offset },
    });
  });

  // 批量否决(fuzzy/ambiguous 历史噪声清理):rejected 只翻 pending_review 状态,
  // 不动台账/账单/匹配日志,安全幂等。逐条复用单条 resolve 的 rejected 路径。
  app.post(
    '/api/monthly/workspaces/:workspaceKey/pending-reviews/batch-reject',
    ...fieldReview,
    async (req, res) => {
      if (!pendingReviewRepo) {
        return serviceUnavailable(res, 'pending_review_repo');
      }
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        ensureWorkspaceWritable({ workspaceService, workspaceKey });
        const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0);
        if (!ids.length) {
          return res.status(400).json({ error: 'ids required', code: 'empty_ids' });
        }
        const resolution = String(req.body?.resolution || 'batch_rejected_by_operator');
        const resolvedBy = req.user?.username || 'api';
        const resolvedAt = new Date().toISOString();
        let rejected = 0;
        const skipped = [];
        for (const id of ids) {
          const existing = pendingReviewRepo.findById({ id, workspaceKey });
          if (!existing || existing.status !== 'open') {
            skipped.push(id);
            continue;
          }
          pendingReviewRepo.resolve({
            id, workspaceKey, status: 'rejected', resolution, resolvedBy, resolvedAt,
          });
          rejected += 1;
        }
        res.json({ ok: true, rejected, skipped });
      } catch (error) {
        sendRouteError(res, error, 'batch reject failed', 400);
      }
    }
  );

  app.post(
    '/api/monthly/workspaces/:workspaceKey/pending-reviews/:id/resolve',
    ...fieldReview,
    async (req, res) => {
      if (!pendingReviewRepo) {
        return serviceUnavailable(res, 'pending_review_repo');
      }
      // Decision payloads require the resolution service.
      if (req.body?.decision !== undefined && !pendingReviewResolutionService) {
        return serviceUnavailable(
          res,
          'pending_review_resolution_service',
          'resolution_service_unavailable',
        );
      }
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        ensureWorkspaceWritable({ workspaceService, workspaceKey });
        const id = Number(req.params.id);
        const existing = pendingReviewRepo.ensureFingerprint
          ? pendingReviewRepo.ensureFingerprint({ id, workspaceKey })
          : pendingReviewRepo.findById({ id, workspaceKey });
        if (!existing) return res.status(404).json({ error: 'pending_review not found' });

        if (pendingReviewResolutionService && req.body?.decision !== undefined) {
          const result = await pendingReviewResolutionService.resolve({
            id, workspaceKey,
            status: req.body?.status || 'resolved',
            resolution: req.body?.resolution || null,
            resolvedBy: req.user?.username || 'api',
            decision: req.body?.decision || {},
          });
          // A3/A2:resolve 真正落库后标脏 merge——单行重建是简化行(无账单回填/返点),
          // ensureFresh 全量 merge 会在核对/出包前用完整口径重建覆盖(与冲突tab入口口径对齐)。
          if (result?.ok) markDerivationDirty(workspaceKey, 'merge');
          return res.json(result);
        }

        const changes = pendingReviewRepo.resolve({
          id, workspaceKey,
          status: req.body?.status || 'resolved',
          resolution: req.body?.resolution || null,
          resolvedBy: req.user?.username || 'api',
          resolvedAt: new Date().toISOString(),
        });
        res.json({ ok: changes > 0, changes });
      } catch (error) {
        sendRouteError(res, error, 'resolve failed', 400);
      }
    }
  );
}

function withLedgerOperatorScope(filter, user) {
  return {
    ...filter,
    ...buildLedgerOwnerScope(user),
  };
}

function getLedgerOwnerAccessIssue({ row, user }) {
  if (!row || canAccessAllOperatorData(user)) return null;
  const { ownerUserId, ownerUsername } = buildLedgerOwnerScope(user);
  const rowAgentId = row.agentId ?? row.agent_id ?? null;
  const rowModifiedBy = String(row.modifiedBy || row.modified_by || '').trim();
  if (ownerUsername && rowModifiedBy && ownerUsername === rowModifiedBy) return null;
  if (ownerUserId !== null && rowAgentId !== null && String(ownerUserId) === String(rowAgentId)) return null;
  return {
    status: 403,
    code: 'LEDGER_ROW_FORBIDDEN',
    message: '只能处理自己上传或审核导入的台账数据',
  };
}

function getLedgerDeleteIssue({ row, user }) {
  if (!row) return null;
  if (!user) return null;
  if (user.role === 'admin') return null;

  const owner = String(row.modifiedBy || '').trim();
  const username = String(user.username || '').trim();
  const sourceType = String(row.sourceType || '').trim();
  if (sourceType !== 'workbench' || !owner || owner !== username) {
    return {
      status: 403,
      code: 'LEDGER_DELETE_FORBIDDEN',
      message: '只能删除自己审核导入且尚未入月的台账数据',
    };
  }
  return null;
}

function getLedgerDateWindowIssue({ groupCodeRepo, workspaceKey, row }) {
  if (!groupCodeRepo || typeof groupCodeRepo.findByTour !== 'function') return null;
  if (isEmptyValue(row?.purchaseDate) || isEmptyValue(row?.tourNo)) return null;
  const allRows = groupCodeRepo.findByTour({ workspaceKey, tourNo: row.tourNo }) || [];
  // 按本行店家消歧(advisory:选不出就退回首行,不因此拦截)
  const { rows: storeRows } = filterRowsByStore(allRows, normalizeStoreFamily(row?.shop || ''));
  const groupCode = storeRows[0] || allRows[0];
  if (!groupCode) return null;

  const purchaseDate = normalizeDate(row.purchaseDate);
  if (!purchaseDate) return null;
  const applyDate = groupCode.applyDate || groupCode.apply_date || null;
  const endDate = groupCode.endDate || groupCode.end_date || null;
  const start = applyDate ? normalizeDate(applyDate) : '';
  const end = endDate ? normalizeDate(endDate) : '';
  if (start && purchaseDate < start) return { reason: 'before_apply_date', applyDate, purchaseDate };
  if (end && purchaseDate > end) return { reason: 'after_end_date', endDate, purchaseDate };
  return null;
}

module.exports = { registerListingRoutes };

