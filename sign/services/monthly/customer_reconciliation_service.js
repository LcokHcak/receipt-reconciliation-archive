'use strict';

/**
 * customer_reconciliation_service (G19 改造 B)
 *
 * 账单匹配规则 docx —【数据数量不一致】:
 *   "该客户在台账数据中收 xxx 张小票 — 在账单数据中共出现 xxx 条小票,
 *    其中 xx 小票列为【未收】,xx 为台账/账单数据中多出的小票号"
 *
 * 按 (passport_no, name) 客户维度,比对台账 distinct receipt_no 与账单 distinct receipt_no:
 *   - missing_in_bill  = 台账有、账单没有 → 台账多出的小票号(账单未出/小票无账单)
 *   - missing_in_daily = 账单有、台账没有 → 客户该补交的【未收】小票
 *
 * 口径(2026-06-03 统一):【未收】= 账单有、台账无(以账单为基准,客户该补交的票)。
 *   listUnreceived 据此从 store_bill(全量基准)取台账没有的小票,与 merge/monthly_export
 *   的「未收小票账单」、样本 1月未收(1).xlsx 同向。getCustomerDiff 仍同时给两个方向,
 *   核对页可看「数量不一致」。
 *
 * 只读,不改任何数据。
 *
 * 清洗一致性 (G19 收尾): store_bill / daily_receipt_export 入库只 trim,未 lowercase /
 * 折叠空格。匹配层查询时过 normalizeString 补齐,本 service 也必须用同一归一化键比对,
 * 否则大小写/空格差异会误报"数量不一致 / 未收"。比对用归一化键,展示保留原值。
 */
const { normalizeString } = require('../../lib/monthly_pipeline/matching/field_diff');

function createCustomerReconciliationService({ db, unreceivedResolutionRepo = null }) {
  if (!db) throw new Error('customer_reconciliation_service: db required');

  // 口径(清单#4):账单核对/未收只看「团号匹配通过(matched)」的台账行。
  // 卡在团号阶段的行(日期越界/团号找不到/代理不符/歧义/待归类)属于待补救,
  // 还没进入账单匹配环节,不能算进核对或未收,否则会与待补救重复计数、误报"未收"。
  const dailyStmt = db.prepare(`
    SELECT passport_no AS passportNo, name, receipt_no AS receiptNo,
           tour_no AS tourNo, agent
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND tour_match_status = 'matched'
      AND receipt_no IS NOT NULL AND receipt_no != ''
  `);

  // 退货/退税行不算"账单出现过这张小票":匹配管线只匹配 sale 行,退货行不参与。
  // 若不过滤,跨月退货(本月账单只有退货行、没有售出行)会把台账小票误判成"账单有",
  // 漏报「小票无账单」;方向口径与 listUnreceived/bill_match 保持一致(sale-only)。
  const billStmt = db.prepare(`
    SELECT passport_no AS passportNo, name, receipt_no AS receiptNo, tour_no AS tourNo
    FROM store_bill
    WHERE workspace_key = ?
      AND (? IS NULL OR store_family = ?)
      AND receipt_no IS NOT NULL AND receipt_no != ''
      AND (transaction_type IS NULL OR transaction_type = 'sale')
    GROUP BY passport_no, name, receipt_no
  `);

  // 未收 = 账单有、台账无 (以账单为基准)。
  // 台账已收键集:任意状态的台账行 — 只要物理收到过(哪怕卡在待补救)就不算未收。
  const ledgerSeenStmt = db.prepare(`
    SELECT passport_no, name, receipt_no
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND receipt_no IS NOT NULL AND receipt_no != ''
  `);
  // 账单逐小票聚合 (SUM 纯卖出$),folder 过滤 store_family;退货/退税行不算未收。
  // store_branch:同一票号只在一家分店,GROUP BY 下取任意行的分店即可(代理视图 B 页/未收清单 9 列用)。
  // ⭐两套对账逻辑(2026-07-22 用户拍板):日度【未收对账】只算 SMG总账(job_type='smg_ledger'),
  //   月度对账才用店家账单(store_bill)。同票在两源都有时旧 SQL 跨源 SUM=金额翻倍(审计 HIGH「双源重叠」);
  //   现按 import_job.job_type 单源=SMG,店家账单行不进未收池;工作区没导 SMG → 未收为空(拍板接受)。
  //   判源用 job_type 不用 is_detail_sheet(店家账单汇总行也 is_detail_sheet=0)、也不用 statement_date(可能空)。
  const billUnreceivedStmt = db.prepare(`
    SELECT mode AS mode_raw, tour_no, purchase_date, name, full_name,
           passport_no, receipt_no, brand,
           store_family AS mode_folder, store_branch,
           MAX(statement_date) AS statement_date,
           SUM(COALESCE(net_usd, 0)) AS net_usd
    FROM store_bill
    WHERE workspace_key = ?
      AND (? IS NULL OR store_family = ?)
      AND receipt_no IS NOT NULL AND receipt_no != ''
      AND (transaction_type IS NULL OR transaction_type = 'sale')
      AND import_job_id IN (SELECT id FROM import_job WHERE workspace_key = ? AND job_type = 'smg_ledger')
    GROUP BY passport_no, name, receipt_no
    ORDER BY mode, passport_no, receipt_no
  `);
  // 团号 → 代理 (store_bill 不存代理,从 group_code 按团号补;同团号取首个非空 agent)
  const tourAgentStmt = db.prepare(`
    SELECT tour_no, agent FROM group_code
    WHERE workspace_key = ? AND agent IS NOT NULL AND agent != ''
  `);

  /**
   * @param {string} workspaceKey
   * @param {{ folder?: string|null }} [opts] folder 同时过滤台账 mode_folder 与账单 store_family
   * @returns {Array<object>} 每个客户一行,含 daily_count / bill_count / missing 列表 / status
   */
  function getCustomerDiff(workspaceKey, { folder = null } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const f = folder || null;

    // receipts: Map<归一化小票号, 原始展示值>(去重用归一化键,展示用原值)
    const dailyMap = new Map();
    for (const row of dailyStmt.all(workspaceKey, f, f)) {
      const key = customerKey(row);
      if (!dailyMap.has(key)) {
        dailyMap.set(key, {
          passportNo: row.passportNo,
          name: row.name,
          tourNo: row.tourNo,
          agent: row.agent,
          receipts: new Map(),
        });
      }
      addReceipt(dailyMap.get(key).receipts, row.receiptNo);
    }

    const billMap = new Map();
    for (const row of billStmt.all(workspaceKey, f, f)) {
      const key = customerKey(row);
      if (!billMap.has(key)) {
        billMap.set(key, {
          passportNo: row.passportNo,
          name: row.name,
          tourNo: row.tourNo,
          receipts: new Map(),
        });
      }
      addReceipt(billMap.get(key).receipts, row.receiptNo);
    }

    const allKeys = new Set([...dailyMap.keys(), ...billMap.keys()]);
    const result = [];
    for (const key of allKeys) {
      const d = dailyMap.get(key);
      const b = billMap.get(key);
      const dailyReceipts = d ? d.receipts : new Map();
      const billReceipts = b ? b.receipts : new Map();
      // 比对归一化键,展示原值
      const missingInBill = [...dailyReceipts.keys()]
        .filter((nr) => !billReceipts.has(nr))
        .map((nr) => dailyReceipts.get(nr)).sort();
      const missingInDaily = [...billReceipts.keys()]
        .filter((nr) => !dailyReceipts.has(nr))
        .map((nr) => billReceipts.get(nr)).sort();
      const isMismatch = missingInBill.length > 0 || missingInDaily.length > 0;
      const anchor = d || b;
      result.push({
        passportNo: anchor.passportNo,
        name: anchor.name,
        tourNo: (d && d.tourNo) || (b && b.tourNo) || null,
        agent: (d && d.agent) || null,
        dailyCount: dailyReceipts.size,
        billCount: billReceipts.size,
        dailyReceipts: [...dailyReceipts.values()].sort(),
        billReceipts: [...billReceipts.values()].sort(),
        missingInBill,
        missingInDaily,
        status: isMismatch ? 'mismatch' : 'match',
      });
    }
    result.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'mismatch' ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return result;
  }

  /** 只返回数量不一致的客户(核对页"数量不一致" tab 用)。 */
  function getMismatches(workspaceKey, opts = {}) {
    return getCustomerDiff(workspaceKey, opts).filter((r) => r.status === 'mismatch');
  }

  /**
   * 行级未收清单 (账单有、台账无 — 客户该补交的票)。导出文件与未收清单页共用此口径。
   * 数据源 store_bill(全量基准),排除台账(任意状态)已收的小票;代理由 group_code 补。
   * @returns {Array<object>} snake_case 列 (mode_raw/tour_no/purchase_date/name/full_name/
   *   passport_no/receipt_no/brand/net_usd/agent),逐张未收小票一行
   */
  function listUnreceived(workspaceKey, { folder = null, includeReceived = false, includeResolved = false } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const f = folder || null;
    const ledgerSeen = new Set();
    for (const r of ledgerSeenStmt.all(workspaceKey)) ledgerSeen.add(receiptKey(r));
    const agentByTour = new Map();
    for (const r of tourAgentStmt.all(workspaceKey)) {
      const k = normalizeString(r.tour_no);
      if (k && !agentByTour.has(k)) agentByTour.set(k, r.agent);
    }
    // 已处理(link/延期/作废/无需补)的未收项不再出现在清单(B3)。仓储可选注入,
    // 未注入时不过滤(保持纯只读单测行为)。
    const resolvedKeys = unreceivedResolutionRepo
      ? unreceivedResolutionRepo.listKeys(workspaceKey)
      : null;
    // includeResolved(代理视图 B 页,2026-07-17):已处理行不过滤而是挂 resolution 详情
    // (「无需补」灰行要留痕展示)。默认 false = 原行为,老消费方零感知。
    const resolutionByKey = new Map();
    if (includeResolved && unreceivedResolutionRepo && resolvedKeys && resolvedKeys.size) {
      for (const row of unreceivedResolutionRepo.list(workspaceKey)) {
        resolutionByKey.set(row.itemKey, {
          action: row.action,
          reason: row.reason || '',
          resolvedBy: row.resolvedBy || '',
          resolvedAt: row.resolvedAt || '',
        });
      }
    }
    // includeReceived(代理视图 B 页,2026-07-16):已收行不过滤而是打 received 标——
    // 「曾未收、后补齐」的行要在 B 页变灰展示。默认 false = 原行为原形状,老消费方零感知。
    return billUnreceivedStmt.all(workspaceKey, f, f, workspaceKey)
      .filter((r) => includeReceived || !ledgerSeen.has(receiptKey(r)))
      .filter((r) => includeResolved || !(resolvedKeys && resolvedKeys.has(receiptKey(r))))
      .map((r) => ({
        mode_raw: r.mode_raw || null,
        tour_no: r.tour_no || null,
        purchase_date: r.purchase_date || null,
        name: r.name || null,
        full_name: r.full_name || r.name || null,
        passport_no: r.passport_no || null,
        receipt_no: r.receipt_no || null,
        brand: r.brand || null,
        net_usd: r.net_usd,
        agent: agentByTour.get(normalizeString(r.tour_no)) || null,
        mode_folder: r.mode_folder || null,
        store_branch: r.store_branch || null,
        statement_date: r.statement_date || null, // 出账日期(SMG总账来源才有,店家账单 NULL)

        ...(includeReceived ? { received: ledgerSeen.has(receiptKey(r)) } : {}),
        ...(includeResolved ? { resolution: resolutionByKey.get(receiptKey(r)) || null } : {}),
      }));
  }

  /**
   * 未收清单按客户聚合 — 账单核对页「未收小票」tab 用。
   * 口径与 listUnreceived(未收清单页 / 交付包 5_未收)**完全同源**:同一组未收小票,
   * 只是从「逐张」改成「按客户(护照|姓名)归并」。这样两处页面的未收小票总数必然一致,
   * 不再出现 13594(逐票) vs 3835(另一套客户口径) 的对不上。
   *
   * @returns {{ rows: Array<object>, receiptTotal: number }}
   *   rows: 每位有未收的客户一行 {passportNo,name,tourNo,agent,billCount,dailyCount:0,
   *         missingInDaily:[未收小票号...],missingInBill:[],netUsd},按未收小票数降序
   *   receiptTotal: 未收小票总张数(= listUnreceived 行数,徽标按张展示用)
   */
  function listUnreceivedByCustomer(workspaceKey, { folder = null } = {}) {
    const receipts = listUnreceived(workspaceKey, { folder });
    const byCustomer = new Map();
    for (const r of receipts) {
      const key = customerKey({ passportNo: r.passport_no, name: r.name });
      if (!byCustomer.has(key)) {
        byCustomer.set(key, {
          passportNo: r.passport_no,
          name: r.name,
          tourNo: r.tour_no || null,
          agent: r.agent || null,
          missingInDaily: [],
          missingInBill: [],
          dailyCount: 0,
          netUsd: 0,
        });
      }
      const c = byCustomer.get(key);
      if (r.receipt_no != null && r.receipt_no !== '') c.missingInDaily.push(r.receipt_no);
      c.netUsd += Number(r.net_usd) || 0;
      if (!c.tourNo && r.tour_no) c.tourNo = r.tour_no;
      if (!c.agent && r.agent) c.agent = r.agent;
    }
    const rows = [...byCustomer.values()].map((c) => ({
      ...c,
      missingInDaily: c.missingInDaily.sort(),
      billCount: c.missingInDaily.length,
      status: 'mismatch',
    }));
    rows.sort((a, b) => b.missingInDaily.length - a.missingInDaily.length
      || String(a.name || '').localeCompare(String(b.name || '')));
    return { rows, receiptTotal: receipts.length };
  }

  return { getCustomerDiff, getMismatches, listUnreceived, listUnreceivedByCustomer };
}

// 客户键用归一化护照+姓名,与匹配层字段处理一致(避免大小写/空格把同一客户拆成两个)
function customerKey(row) {
  return `${normalizeString(row.passportNo)}|${normalizeString(row.name)}`;
}

// 归一化 (护照|姓名|小票) 键 — listUnreceived 用,兼容 camelCase / snake_case 行
function receiptKey(row) {
  const passport = row.passportNo != null ? row.passportNo : row.passport_no;
  const receipt = row.receiptNo != null ? row.receiptNo : row.receipt_no;
  return `${normalizeString(passport)}|${normalizeString(row.name)}|${normalizeString(receipt)}`;
}

// 归一化键去重,首个出现的原始值作展示
function addReceipt(map, receiptNo) {
  const nr = normalizeString(receiptNo);
  if (!nr) return;
  if (!map.has(nr)) map.set(nr, receiptNo);
}

// 未收项稳定标识键 — 路由层据此把前端 POST 的 {passportNo,name,receiptNo} 归一化成
// 与 listUnreceived 过滤完全一致的 item_key。
function unreceivedItemKey({ passportNo, name, receiptNo } = {}) {
  return receiptKey({ passportNo, name, receiptNo });
}

module.exports = { createCustomerReconciliationService, unreceivedItemKey };
