'use strict';

const {
  workspaceKeyFromReq,
  clampInt,
  ensureWorkspaceWritable,
  sendRouteError,
  serviceUnavailable,
} = require('./route_utils');
const { COMPARABLE_FIELDS } = require('../../lib/monthly_pipeline/matching/field_diff');
const ExcelJS = require('exceljs');
const { unreceivedItemKey } = require('../../services/monthly/customer_reconciliation_service');

// 冲突核对只允许改写"账单 vs 台账"可比较的数据字段,绝不允许借此端点
// 改闸控列(tourMatchStatus/ledgerStatus/modeFolder/posted* 等),否则待补救行
// 可被静默翻成 matched 绕过防漏闸进交付。
const CONFLICT_RESOLVABLE_FIELDS = new Set(COMPARABLE_FIELDS);

function pickConflictResolvableUpdates(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (CONFLICT_RESOLVABLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

function rowText(row, keys) {
  return keys
    .map((key) => row?.[key])
    .filter((value) => value != null && value !== '')
    .join(' ')
    .toLowerCase();
}

function filterUnreceivedRows(rows, {
  mode = null,
  dateFrom = null,
  dateTo = null,
  search = null,
} = {}) {
  const q = String(search || '').trim().toLowerCase();
  const m = mode && mode !== 'all' ? String(mode).trim() : null;
  return rows.filter((row) => {
    const rowMode = row.mode_raw || row.mode_folder || row.mode || '';
    if (m && rowMode !== m) return false;
    const date = row.purchase_date ? String(row.purchase_date).slice(0, 10) : '';
    if (dateFrom && date && date < dateFrom) return false;
    if (dateTo && date && date > dateTo) return false;
    if (q) {
      const haystack = rowText(row, [
        'receipt_no',
        'passport_no',
        'name',
        'full_name',
        'tour_no',
        'agent',
        'brand',
      ]);
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function registerBillMatchRoutes({ app, guards, deps }) {
  const { read, intake } = guards;
  const {
    billMatchBucketService,
    billMatchService,
    dailyReceiptRepo,
    pendingReviewRepo,
    orphanAggregationService,
    customerReconciliationService,
    unreceivedResolutionRepo,
    unreceivedBackfillService,
    unreceivedExportService,
    billEnrichmentService,
    workspaceService,
    derivationRecomputeService,
  } = deps;
  if (!billMatchBucketService) return;

  app.get(
    '/api/monthly/workspaces/:workspaceKey/bill-match/buckets',
    ...read,
    (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        workspaceService.getOrThrow(workspaceKey);
        res.json(billMatchBucketService.getBucketsOverview(workspaceKey));
      } catch (error) {
        sendRouteError(res, error, 'bill-match buckets failed');
      }
    }
  );

  app.delete(
    '/api/monthly/workspaces/:workspaceKey/bill-match/buckets/:folder',
    ...intake,
    (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        ensureWorkspaceWritable({ workspaceService, workspaceKey });
        const folder = String(req.params.folder || '').trim();
        if (!folder) return res.status(400).json({ error: 'folder required' });
        const result = billMatchBucketService.clearBucketBills({
          workspaceKey,
          folder,
          operator: req.user?.username || 'system',
        });
        // 替换本桶清了账单+monthly_data → 需从 bill_match 重跑(新账单要重新匹配)
        try { derivationRecomputeService?.markDirty(workspaceKey, 'bill_match'); } catch { /* noop */ }
        return res.json({ ok: true, ...result });
      } catch (error) {
        return sendRouteError(res, error, 'bill-match bucket clear failed');
      }
    }
  );

  if (billMatchService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-match/run-bucket',
      ...intake,
      async (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const folder = String(req.body?.folder || '').trim();
          if (!folder) return res.status(400).json({ error: 'folder required' });

          const result = await billMatchService.run({
            workspaceKey,
            folder,
            billFilter: (bill) => billMatchBucketService.folderOfBill(bill) === folder,
          });
          return res.json({ folder, ...result });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match run-bucket failed');
        }
      }
    );
  }

  if (dailyReceiptRepo) {
    app.get(
      '/api/monthly/workspaces/:workspaceKey/bill-match/conflicts',
      ...read,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const limit = clampInt(req.query.limit, 1, 200, 100);
          const offset = clampInt(req.query.offset, 0, 100000, 0);
          const rows = typeof dailyReceiptRepo.listBillReviewConflicts === 'function'
            ? dailyReceiptRepo.listBillReviewConflicts({ workspaceKey, limit, offset })
            : [];
          const total = typeof dailyReceiptRepo.countBillReviewConflicts === 'function'
            ? dailyReceiptRepo.countBillReviewConflicts(workspaceKey)
            : rows.length;
          return res.json({ rows, total });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match conflicts failed');
        }
      }
    );

    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-match/resolve-conflict',
      ...intake,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const dailyId = Number(req.body?.dailyId);
          if (!Number.isFinite(dailyId) || dailyId <= 0) {
            return res.status(400).json({ error: 'dailyId required', code: 'daily_id_required' });
          }
          // 只接受可比较的冲突数据字段;闸控列(tourMatchStatus/ledgerStatus/
          // modeFolder/posted* 等)在此被剔除,防止借核对端点绕过防漏闸。
          const updates = pickConflictResolvableUpdates(req.body?.updates);
          const updateResult = Object.keys(updates).length
            ? dailyReceiptRepo.applyFieldUpdates({
              id: dailyId,
              workspaceKey,
              updates,
              manualLock: true,
              actor: req.user?.username || 'system',
              historySource: 'pending_resolution',
            })
            : { changes: 0 };
          const matchResult = dailyReceiptRepo.updateBillMatch({
            id: dailyId,
            workspaceKey,
            billMatchStatus: 'matched',
            billMatchPriority: null,
            conflictFields: null,
          });
          // 同步关掉该台账行上的 open 字段冲突待审 —— 否则 tab 清零后
          // pending_review 仍 open,首页/交付检查继续报阻塞(孤儿)。
          const closedPending = typeof pendingReviewRepo?.closeFieldConflictByDailyReceiptId === 'function'
            ? pendingReviewRepo.closeFieldConflictByDailyReceiptId({
              workspaceKey,
              dailyReceiptId: dailyId,
              operator: req.user?.username || 'system',
            })
            : 0;
          // 解决冲突把这行设为 matched → merge 结果过期,标脏让出包自动重算
          try { derivationRecomputeService?.markDirty(workspaceKey, 'merge'); } catch { /* noop */ }
          return res.json({ ok: true, dailyId, updateResult, matchResult, closedPending });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match resolve-conflict failed');
        }
      }
    );
  }

  if (customerReconciliationService) {
    app.get(
      '/api/monthly/workspaces/:workspaceKey/bill-match/count-mismatch',
      ...read,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const folder = req.query.folder ? String(req.query.folder).trim() : null;
          const onlyMismatch = req.query.all !== '1';
          // direction:按差异方向过滤(2026-06-12 账单核对页把「数量不一致」拆成
          // 未收小票(unreceived=账单多)/小票无账单(daily_without_bill=台账多)两个 tab)
          const direction = String(req.query.direction || '').trim();
          const limit = clampInt(req.query.limit, 1, 200, 50);
          const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
          let allRows;
          let receiptTotal = null;
          if (direction === 'unreceived') {
            // 未收小票:与「未收清单页 / 交付包 5_未收」**完全同源**(listUnreceived),
            // 仅按客户归并。receiptTotal=未收小票总张数,徽标按张展示,保证两处页面数字一致。
            const grouped = customerReconciliationService.listUnreceivedByCustomer(workspaceKey, { folder });
            allRows = grouped.rows;
            receiptTotal = grouped.receiptTotal;
          } else {
            allRows = onlyMismatch
              ? customerReconciliationService.getMismatches(workspaceKey, { folder })
              : customerReconciliationService.getCustomerDiff(workspaceKey, { folder });
            if (direction === 'daily_without_bill') {
              allRows = allRows.filter((r) => (r.missingInBill || []).length > 0);
            }
          }
          const rows = allRows.slice(offset, offset + limit);
          return res.json({
            rows,
            total: allRows.length,
            receiptTotal,
            filter: { workspaceKey, folder, onlyMismatch, limit, offset, direction: direction || null },
          });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match count-mismatch failed');
        }
      }
    );

    // 未收清单 (账单有台账无,客户该补交) — 与导出文件同口径,逐张未收小票一行
    app.get(
      '/api/monthly/workspaces/:workspaceKey/bill-match/unreceived',
      ...read,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const folder = req.query.folder ? String(req.query.folder).trim() : null;
          const limit = clampInt(req.query.limit, 1, 200, 50);
          const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
          const allRows = customerReconciliationService.listUnreceived(workspaceKey, { folder });
          const folders = Array.from(new Map(
            allRows
              .map((row) => row.mode_folder || row.folder || '')
              .filter(Boolean)
              .map((name) => [name, { folder: name, count: 0 }])
          ).values());
          for (const row of allRows) {
            const name = row.mode_folder || row.folder || '';
            const item = folders.find((f) => f.folder === name);
            if (item) item.count += 1;
          }
          const modes = Array.from(new Set(
            allRows.map((row) => row.mode_raw || row.mode_folder || row.mode || '').filter(Boolean)
          )).sort();
          const filtered = filterUnreceivedRows(allRows, {
            mode: req.query.mode ? String(req.query.mode).trim() : null,
            dateFrom: req.query.dateFrom ? String(req.query.dateFrom).slice(0, 10) : null,
            dateTo: req.query.dateTo ? String(req.query.dateTo).slice(0, 10) : null,
            search: req.query.search || null,
          });
          const rows = filtered.slice(offset, offset + limit);
          return res.json({
            rows,
            total: filtered.length,
            modes,
            folders,
            filter: { workspaceKey, folder, limit, offset },
          });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match unreceived failed');
        }
      }
    );

    // 未收清单 处理(link/延期/作废) — 落库后该项从清单/导出移除,刷新不复活 (B3)
    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-match/unreceived/resolve',
      ...intake,
      (req, res) => {
        if (!unreceivedResolutionRepo) {
          return serviceUnavailable(res, 'unreceived_resolution_repo');
        }
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const body = req.body || {};
          const rawItems = Array.isArray(body.items) ? body.items : [];
          const items = rawItems
            .map((it) => ({
              itemKey: unreceivedItemKey({
                passportNo: it.passportNo,
                name: it.name,
                receiptNo: it.receiptNo,
              }),
              passportNo: it.passportNo ?? null,
              name: it.name ?? null,
              receiptNo: it.receiptNo ?? null,
            }))
            .filter((it) => it.itemKey && it.itemKey.replace(/\|/g, '').length > 0);
          if (items.length === 0) {
            return res.status(400).json({ error: 'no resolvable items', code: 'empty_items' });
          }
          const result = unreceivedResolutionRepo.resolveMany({
            workspaceKey,
            items,
            action: String(body.action || ''),
            linkedRef: body.linkedRef ?? null,
            reason: body.reason ?? null,
            resolvedBy: req.user?.username || 'system',
          });
          return res.json({ ok: true, ...result });
        } catch (error) {
          if (error?.code === 'unsupported_action') {
            return res.status(400).json({ error: error.message, code: error.code });
          }
          return sendRouteError(res, error, 'bill-match unreceived resolve failed');
        }
      }
    );

    // 未收补录(B2):确认收不到小票的未收行,从账单复制真实数据反向建台账行
    // (sourceType=bill_backfill,无图,不出客户 PDF/文件夹,只进四桶数据),
    // 建完自动重跑 bill_match,该小票从未收清单自然消失。
    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-match/unreceived/backfill',
      ...intake,
      async (req, res) => {
        if (!unreceivedBackfillService) {
          return serviceUnavailable(res, 'unreceived_backfill_service');
        }
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await unreceivedBackfillService.backfill({
            workspaceKey,
            items: Array.isArray(req.body?.items) ? req.body.items : [],
            operator: req.user?.username || 'system',
          });
          return res.json({ ok: true, ...result });
        } catch (error) {
          if (error?.code === 'empty_items') {
            return res.status(400).json({ error: error.message, code: error.code });
          }
          return sendRouteError(res, error, 'bill-match unreceived backfill failed');
        }
      }
    );

    // 未收清单 导出 xlsx (内存生成,直接下载;列同未收清单页/交付包)
    app.get(
      '/api/monthly/workspaces/:workspaceKey/bill-match/unreceived/export.xlsx',
      ...read,
      async (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const folder = req.query.folder ? String(req.query.folder).trim() : null;
          if (!unreceivedExportService) {
            return serviceUnavailable(res, 'unreceived_export_service');
          }
          // 2026-06-12 改版:账单明细样式 + 按桶分 sheet(审核员可直接对回源账单溯源)。
          // folder 筛选跟随;mode/date/search 等行级筛选不再应用(明细按桶全量给)。
          const workbook = new ExcelJS.Workbook();
          workbook.creator = 'Sign Workbench';
          workbook.created = new Date();
          unreceivedExportService.addUnreceivedWorksheets(workbook, workspaceKey, { folder });

          const fname = encodeURIComponent(`未收清单_${workspaceKey}${folder ? '_' + folder : ''}.xlsx`);
          res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('content-disposition', `attachment; filename*=UTF-8''${fname}`);
          await workbook.xlsx.write(res);
          res.end();
        } catch (error) {
          return sendRouteError(res, error, 'bill-match unreceived export failed');
        }
      }
    );
  }

  if (billEnrichmentService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-enrichment/run',
      ...intake,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const stats = billEnrichmentService.run({ workspaceKey });
          return res.json({ ok: true, ...stats });
        } catch (error) {
          return sendRouteError(res, error, 'bill-enrichment run failed');
        }
      }
    );
  }

  app.get(
    '/api/monthly/workspaces/:workspaceKey/bill-match/daily-without-bill',
    ...read,
    (req, res) => {
      if (!orphanAggregationService?.listDailyWithoutBill) {
        return serviceUnavailable(res, 'orphan_aggregation_service');
      }
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        workspaceService.getOrThrow(workspaceKey);
        const result = orphanAggregationService.listDailyWithoutBill({
          workspaceKey,
          mode:     req.query.mode     || null,
          dateFrom: req.query.dateFrom || null,
          dateTo:   req.query.dateTo   || null,
          search:   req.query.search   || null,
          limit:    clampInt(req.query.limit,  1, 200, 50),
          offset:   clampInt(req.query.offset, 0, 1_000_000, 0),
        });
        return res.json(result);
      } catch (error) {
        return sendRouteError(res, error, 'bill-match daily-without-bill failed');
      }
    }
  );

  if (billMatchService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/bill-match/rerun-row',
      ...intake,
      async (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const dailyId = Number(req.body?.dailyId);
          if (!Number.isFinite(dailyId) || dailyId <= 0) {
            return res.status(400).json({ error: 'dailyId required', code: 'daily_id_required' });
          }
          const result = await billMatchService.run({ workspaceKey });
          // 重跑了账单匹配 → merge 过期,标脏让出包自动重算
          try { derivationRecomputeService?.markDirty(workspaceKey, 'merge'); } catch { /* noop */ }
          return res.json({ ok: true, dailyId, rerunScope: 'workspace', ...result });
        } catch (error) {
          return sendRouteError(res, error, 'bill-match rerun-row failed');
        }
      }
    );
  }
}

module.exports = { registerBillMatchRoutes };
