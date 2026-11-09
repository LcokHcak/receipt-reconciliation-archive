'use strict';

/**
 * merge_streaming_service — 流式 merge 阶段（Sprint 2 W4）。
 *
 * 与 merge_service 功能相同，但采用流式处理：
 *   - 不在内存中累积 toInsert 数组
 *   - 每处理 500 条就批量写入 monthly_data
 *   - 降低内存峰值，适合大数据集
 *
 * 输出：
 *   monthly_data rows where
 *     is_unmatched = 0  →  daily rows that have a matched store_bill
 *     is_unmatched = 1  →  store-bill rows that did not match any posted
 *                          ledger receipt
 *
 * NOTE: monthly_data 是派生结果，每次运行先清空本月旧结果再重建，
 * 避免补图、重导账单后旧的未收/月度行残留。
 */

const crypto = require('node:crypto');

const { classifyBillFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { tracker: progressTracker } = require('../../lib/stage_progress_tracker');
const { calcCustomerRebate } = require('../../lib/monthly/customer_rebate_calculator');

const FIELD_COLS = [
  'stmtDate', 'statementDate', 'paymentMode',
  'modeRaw', 'modeNormalized',
  'shop', 'branch', 'upstream', 'entryCompany',
  'tourGuide', 'agent',
  'originalDate', 'purchaseDate', 'tourNo',
  'name', 'passportNo', 'departureDate',
  'receiptNo', 'originalReceiptNo',
  'category', 'brand', 'sku', 'productName',
  'refNo', 'qty',
  'grossUsd', 'grossKrw', 'netUsd', 'netKrw',
  'dcUsd', 'dcKrw', 'discountRate',
  'voucherAmount', 'voucherDeduction',
  'customerPoints', 'customerRebate',
  'storeBasePoints', 'storeBaseRebate',
  'storeExtraPoints', 'storeExtraAmount', 'storeFinalRebate',
  'categorySecondary', 'remark',
];

const BATCH_SIZE = 500;
const PROGRESS_TICK = 200;

function buildDeductMap(repo, workspaceKey) {
  if (!repo) return new Map();
  return new Map(repo.listByWorkspace(workspaceKey).map((r) => [r.modeFolder, r.deductValue]));
}

function buildMappingMap(repo, workspaceKey) {
  if (!repo) return new Map();
  return new Map(
    repo.listByWorkspace(workspaceKey)
      .filter((r) => r.modeFolder)
      .map((r) => [r.modeRaw, r.modeFolder])
  );
}

function buildMergeConfigVersion(ws) {
  if (!ws) return null;
  return `deduct=${ws.deductConfigConfirmedAt || ''}|mapping=${ws.modeMappingConfirmedAt || ''}`;
}

function createMergeStreamingService({
  db = null,
  dailyReceiptRepo,
  billMatchLogRepo,
  monthlyDataRepo,
  storeBillRepo = null,
  brandActivityRepo = null,
  modeDeductConfigRepo = null,
  modeFolderMappingRepo = null,
  workspaceRepo = null,
}) {
  if (!dailyReceiptRepo || !billMatchLogRepo || !monthlyDataRepo) {
    throw new Error('merge_streaming_service: missing repos');
  }

  async function run({ workspaceKey }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const startedAt = new Date().toISOString();
    const deductMap = buildDeductMap(modeDeductConfigRepo, workspaceKey);
    const mappingMap = buildMappingMap(modeFolderMappingRepo, workspaceKey);
    const ws = workspaceRepo?.findByKey ? workspaceRepo.findByKey(workspaceKey) : null;
    const mergeConfigVersion = buildMergeConfigVersion(ws);
    const stats = {
      folderBreakdown: {},
      matched: 0,
      unmatched: 0,
      unreceived: 0,
      skippedNoFolder: 0,
      skippedBillNoFolder: 0,
      // 0729:与 skipped*NoFolder 分开——百货本就不走四桶,属正常越界,不该拿去提醒人
      skippedBillOutOfScope: 0,
      skippedBrandOutOfScope: 0,
      totalInserted: 0,
      totalSkipped: 0,
      deletedExisting: 0,
    };

    // Build bill_id mapping (read-only, safe before transaction)
    const matchedLogs = listAllLogs(billMatchLogRepo, { workspaceKey, status: 'matched' });
    const unmatchedBillLogs = storeBillRepo
      ? listAllLogs(billMatchLogRepo, { workspaceKey, status: 'unmatched' })
      : [];
    const matchedDailyIds = new Set();
    const billIdsNeeded = new Set();
    const billByDaily = new Map();
    for (const log of matchedLogs) {
      if (log.dailyReceiptId != null) {
        matchedDailyIds.add(Number(log.dailyReceiptId));
        billByDaily.set(log.dailyReceiptId, log.storeBillId);
      }
      if (log.storeBillId != null) billIdsNeeded.add(Number(log.storeBillId));
    }
    for (const log of unmatchedBillLogs) {
      if (log.storeBillId != null) billIdsNeeded.add(Number(log.storeBillId));
    }
    const billById = new Map();
    const refundBills = [];
    if (storeBillRepo) {
      for (const bill of iterateBillMergeCandidates(storeBillRepo, workspaceKey)) {
        const billId = Number(bill.id);
        if (billIdsNeeded.has(billId)) billById.set(billId, bill);
        // 退货行只走退货路径,且必须是"没有任何匹配/未收日志"的行(见下方 refund 块注释)。
        // 否则 transaction_type=null && netKrw<0 的退货行若被 P4/P5 匹配上(billIdsNeeded)
        // 或落入未收日志,会被 matched/unmatched 路径写一行、refund 路径再写一行 → 双计。
        if (isRefundBill(bill) && !billIdsNeeded.has(billId)) refundBills.push(bill);
      }
    }
    const dailyById = new Map();
    if (storeBillRepo) {
      for (const row of iterateDailyMergeCandidates(dailyReceiptRepo, workspaceKey)) {
        const dailyId = Number(row.id);
        if (matchedDailyIds.has(dailyId)) dailyById.set(dailyId, row);
      }
    }

    // Calculate total for progress tracking
    const byMode = dailyReceiptRepo.countByMode(workspaceKey);
    const totalToMerge = byMode.reduce((sum, m) => sum + (m.folder ? modeCount(m) : 0), 0);
    progressTracker.update({ workspaceKey, stage: 'merge', current: 0, total: totalToMerge });

    // Declare mutable state outside the transaction block so it remains
    // accessible to the final progress update after the try/catch.
    let processed = 0;
    let batch = [];

    function flushBatch() {
      if (batch.length === 0) return;
      const result = monthlyDataRepo.insertMany(batch);
      stats.totalInserted += result.inserted;
      stats.totalSkipped += result.skipped;
      batch = [];
    }

    // Wrap delete + all batch inserts in one atomic transaction so that a
    // mid-run crash cannot leave monthly_data in a half-cleared state.
    // BEGIN IMMEDIATE acquires the write reservation up front (safe for concurrent readers).
    // When no db is injected (legacy test path), each insertMany manages its own transaction.
    if (db) db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof monthlyDataRepo.deleteByWorkspace === 'function') {
        stats.deletedExisting = monthlyDataRepo.deleteByWorkspace(workspaceKey);
      }

      if (storeBillRepo) {
        for (const log of matchedLogs) {
          const bill = billById.get(Number(log.storeBillId));
          const row = dailyById.get(Number(log.dailyReceiptId)) || { id: log.dailyReceiptId };
          const folder = resolveFolder({ bill, row, mappingMap });
          if (!folder) {
            stats.skippedNoFolder += 1;
            continue;
          }
          batch.push(buildMonthlyRow({
            workspaceKey, row, bill, folder, billId: log.storeBillId, startedAt,
            isUnmatched: false, deductMap, mergeConfigVersion,
          }));
          stats.matched += 1;
          stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
          processed += 1;
          if (batch.length >= BATCH_SIZE) flushBatch();
          if (processed % PROGRESS_TICK === 0) {
            progressTracker.update({ workspaceKey, stage: 'merge', current: processed, total: totalToMerge });
          }
        }
      } else {
        // Fallback for older route tests/wiring that only provide the daily ledger.
        for (const item of byMode) {
          const folder = item.folder;
          if (!folder) {
            stats.skippedNoFolder += modeCount(item);
            continue;
          }

          for (const rows of listModePages(dailyReceiptRepo, { workspaceKey, modeFolder: folder })) {
            for (const row of rows) {
              const billId = billByDaily.get(row.id) || null;
              const isMatched = billId != null;
              const merged = buildMonthlyRow({
                workspaceKey, row, bill: null, folder, billId, startedAt,
                isUnmatched: !isMatched, deductMap, mergeConfigVersion,
              });
              batch.push(merged);

              if (isMatched) stats.matched += 1; else stats.unmatched += 1;
              stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
              processed += 1;

              if (batch.length >= BATCH_SIZE) {
                flushBatch();
              }

              if (processed % PROGRESS_TICK === 0) {
                progressTracker.update({ workspaceKey, stage: 'merge', current: processed, total: totalToMerge });
              }
            }
          }
        }
      }

      if (storeBillRepo) {
        for (const log of unmatchedBillLogs) {
          const bill = billById.get(Number(log.storeBillId));
          if (!bill) continue;
          const folder = resolveFolder({ bill, row: null, mappingMap });
          if (!folder) {
            bumpNoFolder(stats, 'Bill', bill);
            continue;
          }
          batch.push(buildMonthlyRowFromBill({
            workspaceKey, bill, folder, startedAt, isUnmatched: true, mergeConfigVersion,
          }));
          stats.unreceived += 1;
          stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
          if (batch.length >= BATCH_SIZE) flushBatch();
        }
      }

      // 退货/退款行(transaction_type=refund/return 或净额为负):bill_match 只匹配 sale
      // (index.js:100 已过滤),这些行没有匹配日志、也不是未收。之前流式版整个丢掉。
      // 业务口径:不套返点公式,直接拿账单返点(负数)进交付,对当月返点做冲减。
      // 冲减归属:退货行小票号命中本月 matched 台账小票号 = 这张票已收、退货是对
      // 已收票的冲减 → 带台账客户身份进交付(否则 bill-only 被 eligible 排除,冲减丢失)。
      if (storeBillRepo) {
        const matchedDailyByReceipt = new Map();
        const receiptKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        for (const row of dailyById.values()) {
          const key = receiptKey(row.receiptNo);
          if (key && !matchedDailyByReceipt.has(key)) matchedDailyByReceipt.set(key, row);
        }
        stats.refund = 0;
        stats.refundLinked = 0;
        for (const bill of refundBills) {
          const folder = resolveFolder({ bill, row: null, mappingMap });
          if (!folder) { bumpNoFolder(stats, 'Bill', bill); continue; }
          const dailyRow = matchedDailyByReceipt.get(receiptKey(bill.receiptNo)) || null;
          batch.push(buildMonthlyRowFromBill({
            workspaceKey, bill, folder, startedAt, isUnmatched: false, mergeConfigVersion, billRebateAsFinal: true,
            deductValue: deductMap.get(folder) ?? null,
            dailyRow,
          }));
          stats.refund += 1;
          if (dailyRow) stats.refundLinked += 1;
          stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
          if (batch.length >= BATCH_SIZE) flushBatch();
        }
      }

      // 品牌活动(活动数据)折入:独立加项,不走小票匹配,返点已算好(billRebateAsFinal)。
      // 当作 bill-only 行直接进对应交付桶(实测全乐天首尔),负数原样冲减;is_brand_activity=1 标记。
      if (brandActivityRepo && typeof brandActivityRepo.listByWorkspace === 'function') {
        stats.brandActivity = 0;
        for (const ba of brandActivityRepo.listByWorkspace(workspaceKey)) {
          const folder = ba.modeFolder || resolveFolder({ bill: ba, row: null, mappingMap });
          if (!folder) { bumpNoFolder(stats, 'Brand', ba); continue; }
          batch.push(buildMonthlyRowFromBill({
            workspaceKey, bill: { ...ba, id: null }, folder, startedAt,
            isUnmatched: false, mergeConfigVersion, billRebateAsFinal: true, isBrandActivity: true,
          }));
          stats.brandActivity += 1;
          stats.folderBreakdown[folder] = (stats.folderBreakdown[folder] || 0) + 1;
          if (batch.length >= BATCH_SIZE) flushBatch();
        }
      }

      // Flush remaining batch
      flushBatch();

      if (db) db.exec('COMMIT');
    } catch (error) {
      if (db) {
        try { db.exec('ROLLBACK'); } catch {
          // intentional: best-effort rollback
        }
      }
      throw error;
    }

    // Final progress update (outside transaction — no DB writes)
    progressTracker.update({ workspaceKey, stage: 'merge', current: processed, total: totalToMerge });

    return {
      workspaceKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      inserted: stats.totalInserted,
      skipped: stats.totalSkipped,
      ...stats,
    };
  }

  return { run };
}

function modeCount(item) {
  return Number(item?.count ?? item?.n ?? 0);
}

function listAllLogs(repo, { workspaceKey, status }) {
  const out = [];
  const limit = 100000;
  for (let offset = 0; ; offset += limit) {
    const page = repo.list({ workspaceKey, status, limit, offset });
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

function iterateBillMergeCandidates(repo, workspaceKey) {
  if (typeof repo.iterateMergeCandidates === 'function') {
    return repo.iterateMergeCandidates(workspaceKey);
  }
  if (typeof repo.iterateMatchCandidates === 'function') {
    return repo.iterateMatchCandidates(workspaceKey);
  }
  if (typeof repo.iterateDetail === 'function') {
    return repo.iterateDetail(workspaceKey);
  }
  return [];
}

function iterateDailyMergeCandidates(repo, workspaceKey) {
  if (typeof repo._iterateMergeCandidates === 'function') {
    return repo._iterateMergeCandidates({ workspaceKey });
  }
  if (typeof repo._listMatchCandidates === 'function') {
    return repo._listMatchCandidates({ workspaceKey });
  }
  if (typeof repo._listAll === 'function') {
    return repo._listAll({ workspaceKey });
  }
  return [];
}

function isRefundBill(bill) {
  if (!bill) return false;
  const transactionType = bill.transactionType;
  return transactionType === 'refund' || transactionType === 'return' || Number(bill.netKrw) < 0;
}

function* listModePages(repo, { workspaceKey, modeFolder }) {
  const limit = 100000;
  for (let offset = 0; ; offset += limit) {
    const page = repo.listByMode({ workspaceKey, modeFolder, limit, offset });
    if (!page.length) break;
    yield page;
    if (page.length < limit) break;
  }
}

// 0729 生产量化后补的判定:四个交付桶(乐天首尔/乐天釜山/爱宝客/济州新罗V团)全是**免税店**桶。
// 百货(新世界/现代/乐天百货)走的是自己那条上家专链和乐天百货独立包,**本来就不该进四桶合并**。
// 生产实测(2026-08):归不了类的 2883 行里,2823 行全是百货(新世界明洞 2466、现代江南 327…),
// 也就是说"归不了类"这个计数里 98% 是**设计正确的越界排除**,不是归类坏了。
// 两者混在一个数字里 → 界面上永远显示"2823 行被丢弃",操作员三天就学会无视它,
// 那这个提示等于没做。必须分开数:真正需要人管的,只有"既不是百货、又归不了类"的那些。
// 0729 生产复算修正:第一版漏了**中文「现代」**(只写了韩文 현대 和 HYUNDAI),
// 且给 HYUNDAI 加了 (?!.*免税) 的否定前瞻 —— 那是错的。
// 四桶 = 乐天首尔 / 乐天釜山 / 爱宝客 / 济州新罗V团,**现代一个都不在**:
//   现代免税店 → 自己的三池交付(护照/机票/小票,见 mode_delivery 的 HYUNDAI_ZONE)
//   现代百货   → 上家专链(规则5,DEPT_UPSTREAM_FAMILIES)
// 所以现代无论免税还是百货,都属于"本就不走四桶",不该拿去提醒人。
// 复算实测:修正前仍有 331 行(现代江南 330 + 现代仁川机场 1)被误判成"真归不出来"。
const OUT_OF_SCOPE_HINT = /百货|百貨|新世界|现代|現代|현대|신세계|新羅百|SHINSEGAE|HYUNDAI|DEPT/i;
function isOutOfFourFolderScope(bill) {
  if (!bill) return false;
  const probe = [bill.mode, bill.storeFamily, bill.storeBranch, bill.sourceSheet]
    .map((v) => String(v == null ? '' : v)).join('|');
  return OUT_OF_SCOPE_HINT.test(probe);
}

// 丢弃计数分流:百货等"本就不走四桶"的记进 OutOfScope(**不该提醒人**),
// 其余才是真的归类不出来、需要有人去配模式映射的。
function bumpNoFolder(stats, kind, bill) {
  if (isOutOfFourFolderScope(bill)) {
    const key = `skipped${kind}OutOfScope`;
    stats[key] = (stats[key] || 0) + 1;
    return;
  }
  const key = `skipped${kind}NoFolder`;
  stats[key] = (stats[key] || 0) + 1;
}

function resolveFolder({ bill, row, mappingMap = new Map() }) {
  if (bill) {
    if (bill.mode && mappingMap.has(bill.mode)) return mappingMap.get(bill.mode);
    const folder = classifyBillFolder({
      modeRaw: bill.mode,
      storeFamily: bill.storeFamily,
      storeBranch: bill.storeBranch,
      sourceFile: bill.sourceFile,
      sourceSheet: bill.sourceSheet,
    });
    if (folder) return folder;
  }
  return row?.modeFolder || null;
}

function buildMonthlyRow({ workspaceKey, row, bill, folder, billId, startedAt, isUnmatched, deductMap = new Map(), mergeConfigVersion = null }) {
  const payload = {
    workspaceKey,
    modeFolder: folder,
    isUnmatched,
    dailyReceiptId: row.id,
    storeBillId: billId,
    createdAt: startedAt,
  };
  for (const k of FIELD_COLS) payload[k] = row[k];
  if (bill) applyBillFields(payload, bill);

  const deductValue = deductMap.get(folder) ?? null;
  const calc = calcCustomerRebate({
    storeBasePoints: payload.storeBasePoints,
    storeExtraPoints: payload.storeExtraPoints,
    deductValue,
    netKrw: payload.netKrw,
    netUsd: payload.netUsd,
  });
  if (calc.customerPoints !== null) {
    payload.customerPoints = calc.customerPoints;
    payload.customerRebate = calc.customerRebateKrw;
  }
  payload.customerRebateKrw = calc.customerRebateKrw;
  payload.customerRebateUsd = calc.customerRebateUsd;
  payload.mergeConfigVersion = mergeConfigVersion;

  payload.rowHash = hashRow(payload);
  return payload;
}

function buildMonthlyRowFromBill({ workspaceKey, bill, folder, startedAt, isUnmatched, mergeConfigVersion = null, billRebateAsFinal = false, isBrandActivity = false, deductValue = null, dailyRow = null }) {
  const payload = {
    workspaceKey,
    modeFolder: folder,
    isUnmatched,
    dailyReceiptId: dailyRow ? dailyRow.id : null,
    storeBillId: bill.id,
    createdAt: startedAt,
  };
  // 退货冲减归属:退货行小票号命中本月 matched 台账时,带上台账的客户身份
  // (daily_receipt_id/姓名/护照/出境日/团号)。否则按账单名(常缺护照)写 bill-only,
  // 会被交付的 eligible 口径排除 → 冲减丢失、客户返点虚高(BAO CHAO 案例)。
  // 预填台账值,applyBillFields 的 `payload.X || bill.X` 不会覆盖。
  if (dailyRow) {
    payload.name = dailyRow.name || null;
    payload.passportNo = dailyRow.passportNo || null;
    payload.departureDate = dailyRow.departureDate || null;
    payload.tourNo = dailyRow.tourNo || null;
  }
  applyBillFields(payload, bill);
  // billRebateAsFinal: 品牌活动 / 退货等 bill-only 行,优先用账单预填的返点金额(可负)。
  if (billRebateAsFinal) {
    const reb = bill.rebateAmount;
    if (reb != null && reb !== '') {
      payload.customerRebateKrw = Number(reb);
      payload.customerRebateUsd = null;
    } else if (!isBrandActivity) {
      // 退货行但账单没预填返点(某些店家账单缺「客人返点金额」列)→ 按返点公式自算。
      // 净额为负 → 返点为负,自然对当月返点做冲减;否则 null 会误触发 missing_rebate 卡死交付。
      const calc = calcCustomerRebate({
        storeBasePoints: payload.storeBasePoints,
        storeExtraPoints: payload.storeExtraPoints,
        deductValue,
        netKrw: payload.netKrw,
        netUsd: payload.netUsd,
      });
      payload.customerRebateKrw = calc.customerRebateKrw;
      payload.customerRebateUsd = calc.customerRebateUsd;
    } else {
      payload.customerRebateKrw = null;
      payload.customerRebateUsd = null;
    }
  } else {
    payload.customerRebateKrw = null;
    payload.customerRebateUsd = null;
  }
  if (isBrandActivity) payload.isBrandActivity = 1;
  payload.mergeConfigVersion = mergeConfigVersion;
  payload.rowHash = hashRow(payload);
  return payload;
}

function applyBillFields(payload, bill) {
  if (!bill) return payload;
  payload.modeRaw = payload.modeRaw || bill.mode || null;
  payload.modeNormalized = payload.modeNormalized || bill.modeNormalized || null;
  payload.shop = payload.shop || bill.storeFamily || null;
  payload.branch = payload.branch || bill.storeBranch || null;
  payload.originalDate = payload.originalDate || bill.originalDate || null;
  payload.purchaseDate = payload.purchaseDate || bill.purchaseDate || null;
  payload.tourNo = payload.tourNo || bill.tourNo || null;
  payload.name = payload.name || bill.name || bill.fullName || null;
  payload.passportNo = payload.passportNo || bill.passportNo || null;
  payload.departureDate = payload.departureDate || bill.departureDate || null;
  payload.receiptNo = payload.receiptNo || bill.receiptNo || null;
  payload.originalReceiptNo = payload.originalReceiptNo || bill.originalReceiptNo || null;
  payload.category = payload.category || bill.category || null;
  payload.brand = payload.brand || bill.brand || null;
  payload.sku = payload.sku || bill.sku || null;
  payload.refNo = payload.refNo || bill.refNo || null;
  payload.qty = payload.qty == null ? bill.qty : payload.qty;
  payload.grossUsd = payload.grossUsd == null ? bill.grossUsd : payload.grossUsd;
  payload.grossKrw = payload.grossKrw == null ? bill.grossKrw : payload.grossKrw;
  payload.netUsd = payload.netUsd == null ? bill.netUsd : payload.netUsd;
  payload.netKrw = payload.netKrw == null ? bill.netKrw : payload.netKrw;
  payload.customerPoints = payload.customerPoints == null ? bill.points : payload.customerPoints;
  payload.customerRebate = payload.customerRebate == null ? bill.rebateAmount : payload.customerRebate;
  // 返点计算需要免税店基本点+追加点;台账缺时从账单回填(与 merge_service 一致,
  // 否则匹配行算不出返点 = null)。只在台账为空时回填,不覆盖台账已有值。
  payload.storeBasePoints = payload.storeBasePoints == null ? bill.storeBasePoints : payload.storeBasePoints;
  payload.storeExtraPoints = payload.storeExtraPoints == null ? bill.storeExtraPoints : payload.storeExtraPoints;
  applyRawBillFields(payload, bill.rawPayload);
  return payload;
}

function applyRawBillFields(payload, rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return payload;
  fillText(payload, 'stmtDate', rawPayload, ['日期']);
  fillText(payload, 'statementDate', rawPayload, ['出账日期']);
  fillText(payload, 'paymentMode', rawPayload, ['付款模式']);
  fillText(payload, 'upstream', rawPayload, ['上家']);
  fillText(payload, 'entryCompany', rawPayload, ['入店公司']);
  fillText(payload, 'tourGuide', rawPayload, ['导游']);
  fillText(payload, 'agent', rawPayload, ['代理']);
  fillText(payload, 'productName', rawPayload, ['产品名称']);
  fillNumber(payload, 'dcUsd', rawPayload, ['DC($)', 'DC（$）']);
  fillNumber(payload, 'dcKrw', rawPayload, ['DC(￦)', 'DC（￦）']);
  fillNumber(payload, 'discountRate', rawPayload, ['折扣率', '折扣']);
  fillNumber(payload, 'voucherAmount', rawPayload, ['商品券金额']);
  fillNumber(payload, 'voucherDeduction', rawPayload, ['扣点商品券']);
  fillNumber(payload, 'storeBaseRebate', rawPayload, ['免税店返点', '免税店返点金额', '返点', 'D基本返点']);
  fillNumber(payload, 'storeExtraAmount', rawPayload, ['追加金额', '免税店追加金额', 'S追加金额', 'D追加金额']);
  fillNumber(payload, 'storeFinalRebate', rawPayload, ['免税店最终返点', '最终返点', '最终返点金额', 'S最终返点', 'D最终返点']);
  fillText(payload, 'categorySecondary', rawPayload, ['分类']);
  fillText(payload, 'remark', rawPayload, ['备注']);
  return payload;
}

function fillText(target, key, raw, aliases) {
  if (target[key] != null && target[key] !== '') return;
  const value = pickRaw(raw, aliases);
  if (value != null && value !== '') target[key] = String(value);
}

function fillNumber(target, key, raw, aliases) {
  if (target[key] != null && target[key] !== '') return;
  const value = pickRaw(raw, aliases);
  if (value == null || value === '') return;
  const n = Number(String(value).replace(/,/g, ''));
  target[key] = Number.isFinite(n) ? n : value;
}

function pickRaw(raw, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(raw, alias)) {
      const value = cellScalar(raw[alias]);
      if (value != null && value !== '') return value;
    }
  }
  return null;
}

function cellScalar(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellScalar(value.result);
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return cellScalar(value.text);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  }
  return value;
}

function hashRow(p) {
  const src = JSON.stringify({
    ws: p.workspaceKey, folder: p.modeFolder, daily: p.dailyReceiptId, bill: p.storeBillId,
    r: p.receiptNo, n: p.name, pa: p.passportNo, d: p.purchaseDate,
  });
  return crypto.createHash('sha1').update(src).digest('hex');
}

// 0729:导出这两个纯函数供直测。教训——上一版把常量改名后漏了使用点,
// 而测试全是源码字符串断言、从没真正调用过函数,ReferenceError 会一路带到生产
// 把整个合并阶段打崩。规则类逻辑必须有一条**真的执行它**的测试。
module.exports = { createMergeStreamingService, isOutOfFourFolderScope, bumpNoFolder };
