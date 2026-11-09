'use strict';

const { addOwnerScopeCondition, mapRow } = require('./common');

function createDailyReceiptQueries({ db }) {
  const MATCH_CANDIDATE_COLS = `
    id, workspace_key, source_customer_id,
    bill_match_status, bill_match_priority, mode_folder, tour_match_status,
    source_file, source_sheet, source_row, row_hash, imported_at, import_job_id,
    receipt_date, agent_id, agent_code, source_type, source_batch_id, source_task_id,
    modified_by, ledger_status, remedy_reason, posted_at, posted_by, conflict_fields,
    stmt_date, statement_date, payment_mode,
    mode_raw, mode_normalized,
    shop, branch, upstream, entry_company,
    tour_guide, agent,
    original_date, purchase_date, tour_no,
    name, passport_no, departure_date,
    receipt_no, original_receipt_no,
    category, brand, sku, product_name,
    ref_no, qty,
    gross_usd, gross_krw, net_usd, net_krw,
    dc_usd, dc_krw, discount_rate,
    voucher_amount, voucher_deduction,
    customer_points, customer_rebate,
    store_base_points, store_base_rebate,
    store_extra_points, store_extra_amount, store_final_rebate,
    category_secondary, remark
  `;
  const countStmt = db.prepare(
    `SELECT COUNT(1) AS n FROM daily_receipt_export WHERE workspace_key = ?`
  );
  const byModeStmt = db.prepare(`
    SELECT mode_folder AS folder, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
    GROUP BY mode_folder
    ORDER BY n DESC
  `);
  const byMatchStatusStmt = db.prepare(`
    SELECT bill_match_status AS status, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
    GROUP BY bill_match_status
    ORDER BY n DESC
  `);
  const listPendingTourStmt = db.prepare(`
    SELECT id, tour_no, agent, purchase_date, receipt_no, source_batch_id
    FROM daily_receipt_export
    WHERE workspace_key = ? AND tour_match_status = 'pending'
    ORDER BY id
  `);
  const listPendingTourSinceStmt = db.prepare(`
    SELECT id, tour_no, agent, purchase_date, receipt_no, source_batch_id
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND tour_match_status = 'pending'
      AND imported_at >= ?
    ORDER BY id
  `);
  const listPendingTourBatchStmt = db.prepare(`
    SELECT id, tour_no, agent, purchase_date, receipt_no, source_batch_id
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND tour_match_status = 'pending'
      AND source_batch_id = ?
    ORDER BY id
  `);
  // 清单 #2/#4: 合并/交付取行只认 tour_match_status='matched'。
  // 待补救行(agent_mismatch/date_out_of_window 等)即使残留 mode_folder,
  // 也不再被合进月度交付 —— 从取数环节堵死泄漏。
  const listByModeStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND mode_folder = ?
      AND tour_match_status = 'matched'
    ORDER BY id
    LIMIT ? OFFSET ?
  `);
  const listFilteredStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND (? IS NULL OR bill_match_status = ?)
      AND (? IS NULL OR tour_match_status = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const countFilteredStmt = db.prepare(`
    SELECT COUNT(1) AS n FROM daily_receipt_export
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND (? IS NULL OR bill_match_status = ?)
      AND (? IS NULL OR tour_match_status = ?)
  `);
  const findByReceiptStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND receipt_no = ?
  `);
  const findByReceiptDateStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND receipt_no = ?
      AND COALESCE(purchase_date, '') = COALESCE(?, '')
  `);
  const findByReceiptTourStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND receipt_no = ?
      AND COALESCE(tour_no, '') = COALESCE(?, '')
  `);
  const findByPassportDateShopStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND passport_no = ?
      AND COALESCE(purchase_date, '') = COALESCE(?, '')
      AND COALESCE(shop, '') = COALESCE(?, '')
  `);
  const findByNameDateShopStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND name = ?
      AND COALESCE(purchase_date, '') = COALESCE(?, '')
      AND COALESCE(shop, '') = COALESCE(?, '')
  `);
  const findByNameDateStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND name = ?
      AND COALESCE(purchase_date, '') = COALESCE(?, '')
  `);
  const findByReceiptPrefixStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ?
      AND receipt_no LIKE ?
    LIMIT 50
  `);
  const fetchFullByIdStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND id = ?
  `);
  const listUnmatchedStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ? AND bill_match_status = 'unmatched'
    ORDER BY id
  `);
  const listAllStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ?
    ORDER BY id
  `);
  const listMatchCandidatesStmt = db.prepare(`
    SELECT ${MATCH_CANDIDATE_COLS}
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND ledger_status = 'posted'
      AND tour_match_status = 'matched'
      AND (? IS NULL OR mode_folder = ?)
    ORDER BY id
  `);
  const iterateMergeCandidatesStmt = db.prepare(`
    SELECT ${MATCH_CANDIDATE_COLS}
    FROM daily_receipt_export
    WHERE workspace_key = ?
    ORDER BY id
  `);
  const listConsistencyCandidatesStmt = db.prepare(`
    SELECT id, workspace_key, name, passport_no, conflict_fields
    FROM daily_receipt_export
    WHERE workspace_key = ?
    ORDER BY id
  `);
  const listBillReviewConflictsStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ?
      AND conflict_fields IS NOT NULL
      AND conflict_fields <> ''
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const countBillReviewConflictsStmt = db.prepare(`
    SELECT COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND conflict_fields IS NOT NULL
      AND conflict_fields <> ''
  `);
  const listForModeFolderRefreshStmt = db.prepare(`
    SELECT id, mode_raw AS modeRaw, mode_folder AS modeFolder,
           tour_match_status AS tourMatchStatus
    FROM daily_receipt_export
    WHERE workspace_key = ?
    ORDER BY id
  `);
  const listDepartureSyncCandidatesStmt = db.prepare(`
    SELECT * FROM daily_receipt_export
    WHERE workspace_key = ?
      AND passport_no IS NOT NULL
      AND passport_no <> ''
    ORDER BY passport_no, id
  `);
  const listUsedGroupCodesStmt = db.prepare(`
    SELECT
      tour_no AS tourNo,
      mode_raw AS modeRaw,
      mode_normalized AS modeNormalized,
      mode_folder AS modeFolder,
      source_batch_id AS sourceBatchId,
      COUNT(1) AS rowsCount,
      MAX(imported_at) AS latestImportedAt
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND tour_no IS NOT NULL
      AND TRIM(tour_no) <> ''
    GROUP BY tour_no, mode_raw, mode_normalized, mode_folder, source_batch_id
    ORDER BY rowsCount DESC, tour_no
    LIMIT ? OFFSET ?
  `);
  const countUsedGroupCodesStmt = db.prepare(`
    SELECT COUNT(1) AS n
    FROM (
      SELECT tour_no, mode_raw, mode_normalized, mode_folder, source_batch_id
      FROM daily_receipt_export
      WHERE workspace_key = ?
        AND tour_no IS NOT NULL
        AND TRIM(tour_no) <> ''
      GROUP BY tour_no, mode_raw, mode_normalized, mode_folder, source_batch_id
    )
  `);

  // 流式逐客户结算回读:取某批次某客户组刚入库的台账行(含 tour_match 后的渠道模式/桶/状态),
  // 用 source_batch_id + source_customer_id(=审核台 groupKey)索引,不全表扫。
  const listBySourceGroupStmt = db.prepare(`
    SELECT id,
           receipt_no AS receiptNo,
           tour_no AS tourNo,
           shop,
           purchase_date AS purchaseDate,
           mode_raw AS modeRaw,
           mode_normalized AS modeNormalized,
           mode_folder AS modeFolder,
           tour_match_status AS tourMatchStatus,
           bill_match_status AS billMatchStatus,
           ledger_status AS ledgerStatus,
           mode_confirmed_at AS modeConfirmedAt,
           mode_confirmed_by AS modeConfirmedBy,
           source_task_id AS sourceTaskId,
           manual_locked_fields AS manualLockedFields
    FROM daily_receipt_export
    WHERE workspace_key = ? AND source_batch_id = ? AND source_customer_id = ?
    ORDER BY id
  `);
  // 一个客户组的小票可能按购买日期跨多月 → 拿到该组落进了哪些 workspace,确认/状态据此逐月处理。
  const listWorkspaceKeysForSourceGroupStmt = db.prepare(`
    SELECT DISTINCT workspace_key AS workspaceKey
    FROM daily_receipt_export
    WHERE source_batch_id = ? AND source_customer_id = ?
  `);
  // 交付包分桶"台账优先"(2026-07-20 五问题#2,mode_delivery_export 用):一次拉某审核批次
  // 全部台账行的 sourceTaskId→mode_raw(跨工作区故不带 workspace_key;体量=一个批次的已结算行,
  // 与 settledCountsByBatch 同级;读端点有 planScanGate+15s 缓存兜底)。
  const listModeRawBySourceBatchStmt = db.prepare(`
    SELECT source_task_id AS sourceTaskId,
           mode_raw AS modeRaw
    FROM daily_receipt_export
    WHERE source_batch_id = ?
      AND source_task_id IS NOT NULL
      AND TRIM(source_task_id) <> ''
  `);

  return {
    countByWorkspace(workspaceKey) {
      return Number(countStmt.get(workspaceKey)?.n || 0);
    },

    // 回读某批次某客户组的台账行(逐客户结算后看每张小票的渠道模式/状态)。
    listBySourceGroup({ workspaceKey, sourceBatchId, sourceCustomerId }) {
      return listBySourceGroupStmt.all(
        String(workspaceKey || ''),
        String(sourceBatchId || ''),
        String(sourceCustomerId || ''),
      );
    },

    // 该客户组的台账行落进了哪些 workspace(跨月时确认/状态需逐月处理)。
    listWorkspaceKeysForSourceGroup({ sourceBatchId, sourceCustomerId }) {
      return listWorkspaceKeysForSourceGroupStmt
        .all(String(sourceBatchId || ''), String(sourceCustomerId || ''))
        .map((r) => r.workspaceKey)
        .filter(Boolean);
    },

    // 某审核批次全部台账行的 sourceTaskId→mode_raw(交付包分桶"台账优先"用,见 stmt 注释)。
    listModeRawBySourceBatch({ sourceBatchId }) {
      const bid = String(sourceBatchId || '').trim();
      if (!bid) return [];
      return listModeRawBySourceBatchStmt.all(bid);
    },

    countByMode(workspaceKey) {
      return byModeStmt.all(workspaceKey);
    },
    // 只认 matched 的台账行按 mode_folder 聚合(桶汇总台账数用;SQL 聚合,不 load 全量)。
    countMatchedByFolder(workspaceKey) {
      return db.prepare(`
        SELECT mode_folder AS folder, COUNT(1) AS n
        FROM daily_receipt_export
        WHERE workspace_key = ? AND tour_match_status = 'matched'
        GROUP BY mode_folder
      `).all(workspaceKey);
    },

    countByMatchStatus(workspaceKey) {
      return byMatchStatusStmt.all(workspaceKey);
    },

    listPendingTourMatch(workspaceKey, { sinceIso = null, batchId = null } = {}) {
      if (batchId) return listPendingTourBatchStmt.all(workspaceKey, batchId);
      if (sinceIso) return listPendingTourSinceStmt.all(workspaceKey, sinceIso);
      return listPendingTourStmt.all(workspaceKey);
    },

    listByMode({ workspaceKey, modeFolder, limit = 100, offset = 0 }) {
      return listByModeStmt.all(workspaceKey, modeFolder, Number(limit), Number(offset)).map(mapRow);
    },

    listFiltered({ workspaceKey, modeFolder = null, billMatchStatus = null, tourMatchStatus = null, limit = 100, offset = 0 }) {
      return listFilteredStmt.all(
        workspaceKey,
        modeFolder, modeFolder,
        billMatchStatus, billMatchStatus,
        tourMatchStatus, tourMatchStatus,
        Number(limit), Number(offset)
      ).map(mapRow);
    },

    countFiltered({ workspaceKey, modeFolder = null, billMatchStatus = null, tourMatchStatus = null }) {
      return Number(countFilteredStmt.get(
        workspaceKey,
        modeFolder, modeFolder,
        billMatchStatus, billMatchStatus,
        tourMatchStatus, tourMatchStatus
      )?.n || 0);
    },

    findByReceipt({ workspaceKey, receiptNo }) {
      if (receiptNo == null || receiptNo === '') return [];
      return findByReceiptStmt.all(workspaceKey, String(receiptNo)).map(mapRow);
    },

    findByReceiptDate({ workspaceKey, receiptNo, purchaseDate }) {
      if (!receiptNo) return [];
      return findByReceiptDateStmt.all(workspaceKey, String(receiptNo), purchaseDate || '').map(mapRow);
    },

    findByReceiptTour({ workspaceKey, receiptNo, tourNo }) {
      if (!receiptNo) return [];
      return findByReceiptTourStmt.all(workspaceKey, String(receiptNo), tourNo || '').map(mapRow);
    },

    findByPassportDateShop({ workspaceKey, passportNo, purchaseDate, shop }) {
      if (!passportNo) return [];
      return findByPassportDateShopStmt.all(workspaceKey, String(passportNo), purchaseDate || '', shop || '').map(mapRow);
    },

    findByNameDateShop({ workspaceKey, name, purchaseDate, shop }) {
      if (!name) return [];
      return findByNameDateShopStmt.all(workspaceKey, String(name), purchaseDate || '', shop || '').map(mapRow);
    },

    findByNameDate({ workspaceKey, name, purchaseDate }) {
      if (!name) return [];
      return findByNameDateStmt.all(workspaceKey, String(name), purchaseDate || '').map(mapRow);
    },

    findFuzzyByReceiptPrefix({ workspaceKey, receiptNo, prefixLen = 10 }) {
      if (!receiptNo) return [];
      const s = String(receiptNo);
      const prefix = s.slice(0, Math.min(prefixLen, s.length - 1));
      if (!prefix) return [];
      return findByReceiptPrefixStmt.all(workspaceKey, `${prefix}%`).map(mapRow);
    },

    _fetchFullById({ workspaceKey, id }) {
      return mapRow(fetchFullByIdStmt.get(workspaceKey, Number(id)));
    },

    // A1(2026-07-16 同步一致性审计):这些行的 bill_match_status 被人工锁(resolve manualLock)——
    // bill_match 重跑的 clearCurrentMatchOutputs 不得重置它们。
    // 锁格式=JSON数组,存的是 **snake 列名**(applyFieldUpdates 先 camel→col 再上锁),LIKE 按列名命中。
    listManualBillLockedIds({ workspaceKey, ids }) {
      const list = Array.from(new Set((ids || []).map(Number).filter(Number.isFinite)));
      if (!list.length) return [];
      const out = [];
      const CHUNK = 500;
      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        for (const row of db.prepare(`
          SELECT id FROM daily_receipt_export
          WHERE workspace_key = ? AND id IN (${placeholders})
            AND manual_locked_fields LIKE '%"bill_match_status"%'
        `).all(workspaceKey, ...chunk)) {
          out.push(Number(row.id));
        }
      }
      return out;
    },

    _listUnmatched({ workspaceKey }) {
      return listUnmatchedStmt.all(workspaceKey).map(mapRow);
    },

    _listAll({ workspaceKey }) {
      return listAllStmt.all(workspaceKey).map(mapRow);
    },

    _listMatchCandidates({ workspaceKey, folder = null }) {
      return listMatchCandidatesStmt.all(workspaceKey, folder, folder).map(mapRow);
    },

    *_iterateMergeCandidates({ workspaceKey }) {
      for (const row of iterateMergeCandidatesStmt.iterate(workspaceKey)) {
        yield mapRow(row);
      }
    },

    _listConsistencyCandidates({ workspaceKey }) {
      return listConsistencyCandidatesStmt.all(workspaceKey).map(mapRow);
    },

    listBillReviewConflicts({ workspaceKey, limit = 100, offset = 0 }) {
      return listBillReviewConflictsStmt.all(workspaceKey, Number(limit), Number(offset)).map(mapRow);
    },

    countBillReviewConflicts(workspaceKey) {
      return Number(countBillReviewConflictsStmt.get(workspaceKey)?.n || 0);
    },

    listForModeFolderRefresh(workspaceKey) {
      return listForModeFolderRefreshStmt.all(workspaceKey).map((row) => ({
        id: Number(row.id),
        modeRaw: row.modeRaw || null,
        modeFolder: row.modeFolder || null,
        tourMatchStatus: row.tourMatchStatus || null,
      }));
    },

    listDepartureSyncCandidates({ workspaceKey }) {
      return listDepartureSyncCandidatesStmt.all(workspaceKey).map(mapRow);
    },

    listUsedGroupCodes({ workspaceKey, limit = 100, offset = 0 }) {
      return listUsedGroupCodesStmt.all(workspaceKey, Number(limit), Number(offset));
    },

    countUsedGroupCodes(workspaceKey) {
      return Number(countUsedGroupCodesStmt.get(workspaceKey)?.n || 0);
    },

    listLedger({
      workspaceKey,
      receiptDateFrom = null,
      receiptDateTo = null,
      agentId = null,
      modeFolder = null,
      sourceType = null,
      tourMatchStatus = null,
      billMatchStatus = null,
      ledgerStatus = null,
      remedyReason = null,
      ownerUserId = null,
      ownerUsername = null,
      onlyMatched = false,
      limit = 200,
      offset = 0,
    }) {
      const conds = ['workspace_key = ?'];
      const params = [workspaceKey];
      if (receiptDateFrom) { conds.push('receipt_date >= ?'); params.push(receiptDateFrom); }
      if (receiptDateTo) { conds.push('receipt_date <= ?'); params.push(receiptDateTo); }
      if (agentId != null) { conds.push('agent_id = ?'); params.push(Number(agentId)); }
      if (modeFolder) { conds.push('mode_folder = ?'); params.push(modeFolder); }
      if (sourceType) { conds.push('source_type = ?'); params.push(sourceType); }
      // 清单 #4: 台账只认 matched。onlyMatched=true 时强制只看团号匹配通过的行;
      // 显式传 tourMatchStatus(如待补救页查 agent_mismatch)优先,不受 onlyMatched 影响。
      if (tourMatchStatus) { conds.push('tour_match_status = ?'); params.push(tourMatchStatus); }
      else if (onlyMatched) { conds.push("tour_match_status = 'matched'"); }
      if (billMatchStatus) { conds.push('bill_match_status = ?'); params.push(billMatchStatus); }
      if (ledgerStatus) { conds.push('ledger_status = ?'); params.push(ledgerStatus); }
      if (remedyReason) { conds.push('remedy_reason = ?'); params.push(remedyReason); }
      addOwnerScopeCondition(conds, params, { ownerUserId, ownerUsername });
      const sql = `SELECT * FROM daily_receipt_export WHERE ${conds.join(' AND ')}
                   ORDER BY receipt_date DESC, id DESC
                   LIMIT ? OFFSET ?`;
      params.push(Number(limit), Number(offset));
      return db.prepare(sql).all(...params).map(mapRow);
    },

    countLedger({
      workspaceKey,
      receiptDateFrom = null,
      receiptDateTo = null,
      agentId = null,
      modeFolder = null,
      sourceType = null,
      tourMatchStatus = null,
      billMatchStatus = null,
      ledgerStatus = null,
      remedyReason = null,
      ownerUserId = null,
      ownerUsername = null,
      onlyMatched = false,
    }) {
      const conds = ['workspace_key = ?'];
      const params = [workspaceKey];
      if (receiptDateFrom) { conds.push('receipt_date >= ?'); params.push(receiptDateFrom); }
      if (receiptDateTo) { conds.push('receipt_date <= ?'); params.push(receiptDateTo); }
      if (agentId != null) { conds.push('agent_id = ?'); params.push(Number(agentId)); }
      if (modeFolder) { conds.push('mode_folder = ?'); params.push(modeFolder); }
      if (sourceType) { conds.push('source_type = ?'); params.push(sourceType); }
      if (tourMatchStatus) { conds.push('tour_match_status = ?'); params.push(tourMatchStatus); }
      else if (onlyMatched) { conds.push("tour_match_status = 'matched'"); }
      if (billMatchStatus) { conds.push('bill_match_status = ?'); params.push(billMatchStatus); }
      if (ledgerStatus) { conds.push('ledger_status = ?'); params.push(ledgerStatus); }
      if (remedyReason) { conds.push('remedy_reason = ?'); params.push(remedyReason); }
      addOwnerScopeCondition(conds, params, { ownerUserId, ownerUsername });
      const sql = `SELECT COUNT(1) AS n FROM daily_receipt_export WHERE ${conds.join(' AND ')}`;
      return Number(db.prepare(sql).get(...params)?.n || 0);
    },

    groupByAgent({
      workspaceKey,
      receiptDateFrom = null,
      receiptDateTo = null,
      ownerUserId = null,
      ownerUsername = null,
    }) {
      const conds = ['workspace_key = ?'];
      const params = [workspaceKey];
      if (receiptDateFrom) { conds.push('receipt_date >= ?'); params.push(receiptDateFrom); }
      if (receiptDateTo) { conds.push('receipt_date <= ?'); params.push(receiptDateTo); }
      addOwnerScopeCondition(conds, params, { ownerUserId, ownerUsername });
      const sql = `
        SELECT agent_id AS agentId, agent_code AS agentCode, COUNT(1) AS count
        FROM daily_receipt_export
        WHERE ${conds.join(' AND ')}
        GROUP BY agent_id, agent_code
        ORDER BY count DESC`;
      return db.prepare(sql).all(...params);
    },

    listByLedgerStatus({
      workspaceKey,
      ledgerStatus,
      remedyReason = null,
      agentId = null,
      ownerUserId = null,
      ownerUsername = null,
      limit = 200,
      offset = 0,
    }) {
      const conds = ['workspace_key = ?', 'ledger_status = ?'];
      const params = [workspaceKey, ledgerStatus];
      if (remedyReason) { conds.push('remedy_reason = ?'); params.push(remedyReason); }
      if (agentId != null) { conds.push('agent_id = ?'); params.push(Number(agentId)); }
      addOwnerScopeCondition(conds, params, { ownerUserId, ownerUsername });
      const sql = `SELECT * FROM daily_receipt_export WHERE ${conds.join(' AND ')}
                   ORDER BY receipt_date DESC, id DESC
                   LIMIT ? OFFSET ?`;
      params.push(Number(limit), Number(offset));
      return db.prepare(sql).all(...params).map(mapRow);
    },

    countByLedgerStatus(filter = {}) {
      const { conds, params } = buildLedgerConds(filter);
      const sql = `SELECT ledger_status AS status, remedy_reason AS reason, COUNT(1) AS n
                   FROM daily_receipt_export
                   WHERE ${conds.join(' AND ')}
                   GROUP BY ledger_status, remedy_reason`;
      return db.prepare(sql).all(...params);
    },

    /**
     * 按团号匹配状态分组计数(0731)。
     *
     * 为什么不复用 countByLedgerStatus:那个按 ledger_status 分组,
     * 而「异常补救」页的口径是 tour_match_status(团号没命中/日期越界/代理不符/模式无法归类)。
     * 两个是不同的维度,不是同一个数换个名字。
     *
     * 用途:审核台页签上的「异常补救 N」承接角标。之前唯一能拿到类似数字的地方是
     * /workbench/overview —— 那是首页级聚合,为一个角标在主作业面上拉它不划算。
     */
    countByTourMatchStatus(filter = {}) {
      const { conds, params } = buildLedgerConds(filter);
      const sql = `SELECT tour_match_status AS status, COUNT(1) AS n
                   FROM daily_receipt_export
                   WHERE ${conds.join(' AND ')}
                   GROUP BY tour_match_status`;
      return db.prepare(sql).all(...params);
    },
  };

  // 两个 count 共用同一套过滤条件。抽出来是因为**两份各自维护的条件必然漂**:
  // 加了个筛选项只改一处,另一处就开始返和列表对不上的数,而"数字对不上"
  // 在界面上没有任何报错,只会让人觉得系统在瞎报。
  function buildLedgerConds({
    workspaceKey,
    receiptDateFrom = null,
    receiptDateTo = null,
    agentId = null,
    sourceType = null,
    tourMatchStatus = null,
    billMatchStatus = null,
    ledgerStatus = null,
    remedyReason = null,
    ownerUserId = null,
    ownerUsername = null,
  } = {}) {
    const conds = ['workspace_key = ?'];
    const params = [workspaceKey];
    if (receiptDateFrom) { conds.push('receipt_date >= ?'); params.push(receiptDateFrom); }
    if (receiptDateTo) { conds.push('receipt_date <= ?'); params.push(receiptDateTo); }
    if (agentId != null) { conds.push('agent_id = ?'); params.push(Number(agentId)); }
    if (sourceType) { conds.push('source_type = ?'); params.push(sourceType); }
    if (tourMatchStatus) { conds.push('tour_match_status = ?'); params.push(tourMatchStatus); }
    if (billMatchStatus) { conds.push('bill_match_status = ?'); params.push(billMatchStatus); }
    if (ledgerStatus) { conds.push('ledger_status = ?'); params.push(ledgerStatus); }
    if (remedyReason) { conds.push('remedy_reason = ?'); params.push(remedyReason); }
    addOwnerScopeCondition(conds, params, { ownerUserId, ownerUsername });
    return { conds, params };
  }
}

module.exports = { createDailyReceiptQueries };
