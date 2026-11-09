'use strict';

/**
 * 代理工作台 V2 — 客户级读模型仓库(agent_workspace_customer)。
 *
 * 定位(架构 §6):可重建读模型,不是业务主库——损坏可由 customer.json+batch.json 重建。
 * 复用 workbench_sqlite_repository 暴露的同一 DatabaseSync 句柄(免同文件锁竞争),
 * 本仓库只建自己的表/索引,幂等。
 *
 * 两层写入互不越界(测试锁死):
 *   - upsertCustomerAnchor:只写锚点列(代理/owner/时间/图片数/月份),不碰 overlay 列;
 *   - upsertReviewOverlay:只写审核覆盖列(状态/模式/结算/批次关联),不碰锚点列;
 *     行不存在 → { orphan:true } 交调用方记日志,绝不凭 overlay 造行(锚点真相在客户库)。
 *
 * 查询约定:
 *   - 游标分页 (received_at, customer_pk) 行值比较,DESC 稳定序;不用 offset;
 *   - mode 任一命中(候选或确认,json_each);
 *   - search LIKE 转义 %/_/\\;limit 钳制 [1,100](agents 到 200)。
 */

const CUSTOMERS_LIMIT_MAX = 100;
const AGENTS_LIMIT_MAX = 200;
const DEFAULT_STATUS_FOR_BARE_ANCHOR = 'ready_for_sync';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function toJsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clampLimit(limit, max) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return Math.min(50, max);
  return Math.min(Math.floor(n), max);
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function encodeCursor(receivedAt, customerPk) {
  return Buffer.from(JSON.stringify([receivedAt, customerPk]), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [receivedAt, customerPk] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof receivedAt !== 'string' || typeof customerPk !== 'string') return null;
    return { receivedAt, customerPk };
  } catch {
    return null;
  }
}

function createAgentWorkspaceRepository({ db }) {
  if (!db) throw new Error('db (DatabaseSync) is required');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_workspace_customer (
      customer_pk TEXT PRIMARY KEY,
      calendar_month TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      owner_user_id INTEGER,
      owner_username TEXT,
      agent_key TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_unlabeled INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT,
      active_batch_id TEXT NOT NULL DEFAULT '',
      active_group_key TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT '',
      original_image_count INTEGER NOT NULL DEFAULT 0,
      abnormal_image_count INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      group_key TEXT,
      monthly_workspace_key TEXT,
      store_keys_json TEXT NOT NULL DEFAULT '[]',
      candidate_modes_json TEXT NOT NULL DEFAULT '[]',
      confirmed_modes_json TEXT NOT NULL DEFAULT '[]',
      review_status TEXT NOT NULL DEFAULT '${DEFAULT_STATUS_FOR_BARE_ANCHOR}',
      next_action TEXT NOT NULL DEFAULT 'sync_to_batch',
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      settlement_status TEXT,
      receipt_count INTEGER NOT NULL DEFAULT 0,
      projection_version INTEGER NOT NULL DEFAULT 1,
      projected_at TEXT NOT NULL DEFAULT '',
      UNIQUE(workspace_key, customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_awc_month_owner_agent_received
      ON agent_workspace_customer (calendar_month, owner_user_id, agent_key, received_at DESC, customer_pk DESC);
    CREATE INDEX IF NOT EXISTS idx_awc_month_owner_status
      ON agent_workspace_customer (calendar_month, owner_user_id, review_status);
    CREATE INDEX IF NOT EXISTS idx_awc_month_owner_received
      ON agent_workspace_customer (calendar_month, owner_user_id, received_at DESC, customer_pk DESC);
    -- 2026-07-12 审计补:上面三条都把 owner_user_id 卡在第2列——admin/finance 全局视角
    -- (不带 owner 等值)与 mode 过滤查询没有任何索引能盖住 ORDER BY received_at,
    -- 16827 行/月要走 TEMP B-TREE(实测 100ms→1ms/60~100x)。
    CREATE INDEX IF NOT EXISTS idx_awc_month_received
      ON agent_workspace_customer (calendar_month, received_at DESC, customer_pk DESC);
  `);

  // 列升级幂等:老库存在但缺新列时补列(建表 IF NOT EXISTS 不会加列)。
  const existingCols = new Set(db.prepare("PRAGMA table_info('agent_workspace_customer')").all().map((c) => c.name));
  for (const [col, ddl] of [
    ['active_batch_id', "ALTER TABLE agent_workspace_customer ADD COLUMN active_batch_id TEXT NOT NULL DEFAULT ''"],
    ['active_group_key', "ALTER TABLE agent_workspace_customer ADD COLUMN active_group_key TEXT NOT NULL DEFAULT ''"],
    ['receipt_count', 'ALTER TABLE agent_workspace_customer ADD COLUMN receipt_count INTEGER NOT NULL DEFAULT 0'], // P3 真票数
  ]) {
    if (!existingCols.has(col)) db.exec(ddl);
  }

  const upsertAnchorStmt = db.prepare(`
    INSERT INTO agent_workspace_customer (
      customer_pk, calendar_month, workspace_key, customer_id,
      owner_user_id, owner_username, agent_key, agent_name, agent_unlabeled,
      customer_name, active_batch_id, active_group_key,
      received_at, original_image_count, abnormal_image_count,
      projection_version, projected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(customer_pk) DO UPDATE SET
      calendar_month = excluded.calendar_month,
      workspace_key = excluded.workspace_key,
      customer_id = excluded.customer_id,
      owner_user_id = excluded.owner_user_id,
      owner_username = excluded.owner_username,
      agent_key = excluded.agent_key,
      agent_name = excluded.agent_name,
      agent_unlabeled = excluded.agent_unlabeled,
      customer_name = excluded.customer_name,
      active_batch_id = excluded.active_batch_id,
      active_group_key = excluded.active_group_key,
      received_at = excluded.received_at,
      original_image_count = excluded.original_image_count,
      abnormal_image_count = excluded.abnormal_image_count,
      projection_version = excluded.projection_version,
      projected_at = excluded.projected_at
  `);

  const upsertOverlayStmt = db.prepare(`
    UPDATE agent_workspace_customer SET
      batch_id = ?,
      group_key = ?,
      monthly_workspace_key = COALESCE(?, monthly_workspace_key),
      store_keys_json = ?,
      candidate_modes_json = ?,
      confirmed_modes_json = ?,
      review_status = ?,
      next_action = ?,
      reason_codes_json = ?,
      settlement_status = ?,
      receipt_count = ?,
      projected_at = ?
    WHERE customer_pk = ?
      AND (active_batch_id = '' OR active_batch_id = ?)
  `);

  const getStmt = db.prepare('SELECT * FROM agent_workspace_customer WHERE customer_pk = ?');
  const deleteStmt = db.prepare('DELETE FROM agent_workspace_customer WHERE customer_pk = ?');

  function mapRow(row) {
    if (!row) return null;
    return {
      customerPk: row.customer_pk,
      calendarMonth: row.calendar_month,
      workspaceKey: row.workspace_key,
      customerId: row.customer_id,
      ownerUserId: row.owner_user_id,
      ownerUsername: row.owner_username,
      agentKey: row.agent_key,
      agentName: row.agent_name,
      agentUnlabeled: Boolean(row.agent_unlabeled),
      customerName: row.customer_name,
      activeBatchId: row.active_batch_id,
      activeGroupKey: row.active_group_key,
      receivedAt: row.received_at,
      originalImageCount: row.original_image_count,
      abnormalImageCount: row.abnormal_image_count,
      receiptCount: Number(row.receipt_count) || 0,
      batchId: row.batch_id,
      groupKey: row.group_key,
      monthlyWorkspaceKey: row.monthly_workspace_key,
      storeKeys: parseJsonArray(row.store_keys_json),
      candidateModes: parseJsonArray(row.candidate_modes_json),
      confirmedModes: parseJsonArray(row.confirmed_modes_json),
      reviewStatus: row.review_status,
      nextAction: row.next_action,
      reasonCodes: parseJsonArray(row.reason_codes_json),
      settlementStatus: row.settlement_status,
      projectedAt: row.projected_at,
    };
  }

  function upsertCustomerAnchor(anchor, { projectionVersion = 1, projectedAt = new Date().toISOString() } = {}) {
    upsertAnchorStmt.run(
      clean(anchor.customerPk),
      clean(anchor.calendarMonth),
      clean(anchor.workspaceKey),
      clean(anchor.customerId),
      anchor.ownerUserId ?? null,
      anchor.ownerUsername ?? null,
      clean(anchor.agentKey),
      clean(anchor.agentName),
      anchor.agentUnlabeled ? 1 : 0,
      clean(anchor.customerName),
      clean(anchor.activeBatchId),
      clean(anchor.activeGroupKey),
      clean(anchor.receivedAt),
      Number(anchor.originalImageCount) || 0,
      Number(anchor.abnormalImageCount) || 0,
      projectionVersion,
      projectedAt,
    );
  }

  function upsertReviewOverlay(overlay, { projectedAt = new Date().toISOString() } = {}) {
    const result = upsertOverlayStmt.run(
      overlay.batchId ?? null,
      overlay.groupKey ?? null,
      overlay.monthlyWorkspaceKey ?? null,
      toJsonArray(overlay.storeKeys),
      toJsonArray(overlay.candidateModes),
      toJsonArray(overlay.confirmedModes),
      clean(overlay.reviewStatus) || DEFAULT_STATUS_FOR_BARE_ANCHOR,
      clean(overlay.nextAction) || 'sync_to_batch',
      toJsonArray(overlay.reasonCodes),
      overlay.settlementStatus == null ? null : clean(overlay.settlementStatus),
      Number(overlay.receiptCount) || 0,
      projectedAt,
      clean(overlay.customerPk),
      clean(overlay.batchId),
    );
    if (Number(result.changes) > 0) return { orphan: false, stale: false };
    // 区分孤儿(行不存在)与陈旧批次(行在但活动批次不匹配,旧批次禁止覆盖新)
    const exists = getStmt.get(clean(overlay.customerPk));
    return exists ? { orphan: false, stale: true } : { orphan: true, stale: false };
  }

  // 批次删除/失联:该批次盖过的行回到"待建档"缺省态(客户仍在,不丢行)。
  // 两条铁则(2026-07-12 复审修订):
  //   ① 已结算(settled)客户不回退——批次归档/清理不该把 passed 打回 ready_for_sync,
  //      只解除批次关联,保留状态与模式/店名等历史事实;
  //   ② 活动批次守卫一并清空,否则守卫永远指向已删除批次,后续批次全被误判 stale(死锁)。
  function clearOverlayByBatch(batchId, { projectedAt = new Date().toISOString() } = {}) {
    let settledKept = 0;
    let cleared = 0;
    runInTransaction(() => {
      settledKept = Number(db.prepare(`
        UPDATE agent_workspace_customer SET
          batch_id = NULL, group_key = NULL,
          active_batch_id = '', active_group_key = '',
          projected_at = ?
        WHERE batch_id = ? AND settlement_status = 'settled'
      `).run(projectedAt, clean(batchId)).changes);
      cleared = Number(db.prepare(`
        UPDATE agent_workspace_customer SET
          batch_id = NULL, group_key = NULL,
          active_batch_id = '', active_group_key = '',
          store_keys_json = '[]', candidate_modes_json = '[]', confirmed_modes_json = '[]',
          review_status = '${DEFAULT_STATUS_FOR_BARE_ANCHOR}', next_action = 'sync_to_batch',
          reason_codes_json = '[]', settlement_status = NULL, receipt_count = 0, projected_at = ?
        WHERE batch_id = ?
      `).run(projectedAt, clean(batchId)).changes);
    });
    return { cleared, settledKept };
  }

  // 事务包裹(SAVEPOINT 可嵌套,外层已有事务也安全)。批次覆盖层逐客户写入必须走这里,
  // 避免热路径上几百次隐式自动提交(每次 fsync)拖慢 PATCH。
  function runInTransaction(fn) {
    db.exec('SAVEPOINT agent_ws_tx');
    try {
      const result = fn();
      db.exec('RELEASE SAVEPOINT agent_ws_tx');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT agent_ws_tx');
      db.exec('RELEASE SAVEPOINT agent_ws_tx');
      throw error;
    }
  }

  function getCustomer(customerPk) {
    return mapRow(getStmt.get(clean(customerPk)));
  }

  function deleteCustomer(customerPk) {
    deleteStmt.run(clean(customerPk));
  }

  // ── 查询:同一 scope 条件构造(month + owner 收窄),summary/agents/customers 共用 ──
  function scopeWhere({ month, ownerUserId, agentKey }) {
    const where = ['calendar_month = ?'];
    const params = [clean(month)];
    if (ownerUserId != null) {
      where.push('owner_user_id = ?');
      params.push(ownerUserId);
    }
    if (agentKey) {
      where.push('agent_key = ?');
      params.push(clean(agentKey));
    }
    return { where, params };
  }

  function listCustomers({ month, agentKey, mode, reviewStatus, ownerUserId, limit = 50, cursor, search, searchExtraIds = [], searchExtraGroupKeys = [], receivedFromIso = '', receivedToIso = '' } = {}) {
    const { where, params } = scopeWhere({ month, ownerUserId, agentKey });
    if (reviewStatus) {
      where.push('review_status = ?');
      params.push(clean(reviewStatus));
    }
    // 按日筛选(2026-07-24):received_at ∈ [起, 止)(服务层已把 KST 日历日换成 UTC ISO 边界)。
    if (clean(receivedFromIso) && clean(receivedToIso)) {
      where.push('received_at >= ? AND received_at < ?');
      params.push(clean(receivedFromIso), clean(receivedToIso));
    }
    // 一键搜索(2026-07-16 P1;2026-07-24 全量化):投影瘦身列只有姓名/客户号——护照/票号/团号
    // 命中由 service 注入的两路反查(跨库,投影在 workbench.sqlite):
    //   ① searchExtraIds     = 台账(monthly.sqlite,已结算客户)反查出的 source_customer_id;
    //   ② searchExtraGroupKeys = 工作台镜像(passport_record/receipt_record,未结算/在途客户)反查出的
    //      裸 source group key(= 投影 active_group_key)。二者并集覆盖【全部客户】,不再只限已结算。
    if (clean(search)) {
      const term = `%${escapeLike(clean(search))}%`;
      const extraIds = (Array.isArray(searchExtraIds) ? searchExtraIds : [])
        .map((v) => clean(v)).filter(Boolean).slice(0, 500);
      const extraGroupKeys = (Array.isArray(searchExtraGroupKeys) ? searchExtraGroupKeys : [])
        .map((v) => clean(v)).filter(Boolean).slice(0, 500);
      const ors = ["customer_name LIKE ? ESCAPE '\\'", "customer_id LIKE ? ESCAPE '\\'"];
      const orParams = [term, term];
      if (extraIds.length) {
        ors.push(`customer_id IN (${extraIds.map(() => '?').join(',')})`);
        orParams.push(...extraIds);
      }
      if (extraGroupKeys.length) {
        ors.push(`active_group_key IN (${extraGroupKeys.map(() => '?').join(',')})`);
        orParams.push(...extraGroupKeys);
      }
      where.push(`(${ors.join(' OR ')})`);
      params.push(...orParams);
    }
    if (mode) {
      where.push(`(
        EXISTS (SELECT 1 FROM json_each(candidate_modes_json) WHERE json_each.value = ?)
        OR EXISTS (SELECT 1 FROM json_each(confirmed_modes_json) WHERE json_each.value = ?)
      )`);
      params.push(clean(mode), clean(mode));
    }
    const decoded = decodeCursor(cursor);
    if (decoded) {
      where.push('(received_at, customer_pk) < (?, ?)');
      params.push(decoded.receivedAt, decoded.customerPk);
    }
    const capped = clampLimit(limit, CUSTOMERS_LIMIT_MAX);
    const rows = db.prepare(`
      SELECT * FROM agent_workspace_customer
      WHERE ${where.join(' AND ')}
      ORDER BY received_at DESC, customer_pk DESC
      LIMIT ?
    `).all(...params, capped + 1);
    const page = rows.slice(0, capped).map(mapRow);
    const nextCursor = rows.length > capped
      ? encodeCursor(page[page.length - 1].receivedAt, page[page.length - 1].customerPk)
      : null;
    return { rows: page, nextCursor };
  }

  function listAgents({ month, ownerUserId, search, limit = AGENTS_LIMIT_MAX } = {}) {
    const { where, params } = scopeWhere({ month, ownerUserId });
    if (clean(search)) {
      where.push("agent_name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(clean(search))}%`);
    }
    const capped = clampLimit(limit, AGENTS_LIMIT_MAX);
    const rows = db.prepare(`
      SELECT
        agent_key,
        MAX(agent_name) AS agent_name,
        MAX(agent_unlabeled) AS agent_unlabeled,
        COUNT(*) AS customer_count,
        SUM(CASE WHEN review_status NOT IN ('passed') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN review_status IN ('rephoto', 'needs_remedy', 'needs_confirm') THEN 1 ELSE 0 END) AS abnormal_count,
        SUM(abnormal_image_count) AS abnormal_image_count,
        SUM(receipt_count) AS receipt_count
      FROM agent_workspace_customer
      WHERE ${where.join(' AND ')}
      GROUP BY agent_key
      ORDER BY customer_count DESC, agent_key ASC
      LIMIT ?
    `).all(...params, capped);
    return {
      rows: rows.map((r) => ({
        agentKey: r.agent_key,
        agentName: r.agent_name,
        agentUnlabeled: Boolean(r.agent_unlabeled),
        customerCount: r.customer_count,
        openCount: r.open_count,
        abnormalCount: r.abnormal_count,
        abnormalImageCount: r.abnormal_image_count,
        receiptCount: Number(r.receipt_count) || 0,
      })),
    };
  }

  // todayStartIso:当日边界(Asia/Seoul 午夜的 UTC ISO,服务层算好传入)。
  // received_at 存的是同格式 ISO(createdAt),字符串 >= 比较即当日新增计数;
  // 纯查询期聚合,不新增投影列、不重建读模型(2026-07-13 代理工作台统计卡)。
  // 按日筛选(2026-07-27 用户需求E②):选中某日后卡片计数必须跟着变。此前 summary 无视 day,
  // 上方「客户组总数 2700」与下方按日过滤出的十几行对不上,读者只能猜哪个是真的。
  // 窗口收窄后,todayStartIso/todayEndIso 也由 service 换成那天的边界 → 「当日新增/当日已审」同源。
  function summary({ month, ownerUserId, agentKey, todayStartIso = '', todayEndIso = '', receivedFromIso = '', receivedToIso = '' } = {}) {
    const { where, params } = scopeWhere({ month, ownerUserId, agentKey });
    if (clean(receivedFromIso) && clean(receivedToIso)) {
      where.push('received_at >= ? AND received_at < ?');
      params.push(clean(receivedFromIso), clean(receivedToIso));
    }
    const rows = db.prepare(`
      SELECT review_status, COUNT(*) AS n, COALESCE(SUM(receipt_count), 0) AS receipts
      FROM agent_workspace_customer
      WHERE ${where.join(' AND ')}
      GROUP BY review_status
    `).all(...params);
    const byStatus = {};
    const receiptsByStatus = {}; // P3 真票数:各状态的小票数(与 byStatus 同 key,支持"按票"口径)
    let total = 0;
    let totalReceipts = 0;
    for (const r of rows) {
      byStatus[r.review_status] = r.n;
      receiptsByStatus[r.review_status] = Number(r.receipts) || 0;
      total += r.n;
      totalReceipts += Number(r.receipts) || 0;
    }
    // 总图数(2026-07-24 卡片改版辅读数):合计各客户组的原图数(=表格「图片数」列之和),
    // 给"业务量"一个图口径读数(注:含护照,非纯小票数;真·票数待 P3 投影加票计数列)。
    const imgRow = db.prepare(`
      SELECT COALESCE(SUM(original_image_count), 0) AS n
      FROM agent_workspace_customer
      WHERE ${where.join(' AND ')}
    `).get(...params);
    const totalImages = imgRow ? Number(imgRow.n) : 0;
    let todayCount = 0;
    let todayReviewedBatches = 0;
    if (clean(todayStartIso)) {
      // 选中过去某日时 service 会传 todayEndIso:没有上界的话,「当日新增」会把那天之后的全算进来。
      const upper = clean(todayEndIso);
      const winSql = upper ? 'AND received_at >= ? AND received_at < ?' : 'AND received_at >= ?';
      const winParams = upper ? [clean(todayStartIso), upper] : [clean(todayStartIso)];
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_workspace_customer
        WHERE ${where.join(' AND ')} ${winSql}
      `).get(...params, ...winParams);
      todayCount = row ? Number(row.n) : 0;
      // 今日审核批次(2026-07-21 交付修改0721#8):今日有审核动作(投影今日刷新且已进审后状态)
      // 的去重批次数。projected_at 随任何同步更新——全量重建投影会短暂虚高,可接受(看板口径)。
      // 「今日已审批次」只在**看今天**时有意义:它拿 projected_at(投影刷新时刻)当审核时刻的近似,
      // 而投影每 2 分钟增量刷、重启还会全量刷。选历史某天时,所有行的 projected_at 早被刷到那天之后,
      // 这条查询恒为 0 —— 显示「当日已审 0 批」会被读成"那天没人干活",比不显示更糟。
      // 故:选了历史日 → 返回 null(前端据此显示「—」),不假装有答案。
      if (upper) {
        todayReviewedBatches = null;
      } else {
        const batchRow = db.prepare(`
          SELECT COUNT(DISTINCT active_batch_id) AS n
          FROM agent_workspace_customer
          WHERE ${where.join(' AND ')} AND active_batch_id != ''
            AND projected_at >= ?
            AND review_status IN ('review_pending', 'needs_remedy', 'needs_confirm', 'passed')
        `).get(...params, ...winParams);
        todayReviewedBatches = batchRow ? Number(batchRow.n) : 0;
      }
    }
    return { totalCustomers: total, byStatus, receiptsByStatus, totalReceipts, todayCount, todayReviewedBatches, totalImages };
  }

  return {
    upsertCustomerAnchor,
    upsertReviewOverlay,
    runInTransaction,
    getCustomer,
    deleteCustomer,
    clearOverlayByBatch,
    listCustomers,
    listAgents,
    summary,
    encodeCursor,
    decodeCursor,
  };
}

module.exports = { createAgentWorkspaceRepository };
