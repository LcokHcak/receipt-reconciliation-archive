'use strict';

/**
 * unreceived_backfill_service — 未收补录(B2 最终方案,2026-06-12)
 *
 * 业务背景:月末对账时部分账单小票确认收不到客户实物小票/照片(未收),但账单
 * 是免税店的事实数据,必须进四桶最终数据交付。旧方案是人工在"手动录入"页
 * 手敲一遍(假汇率/假客户 mock 一堆问题,已下线);新方案是**从账单行反向补
 * 台账行**:字段全部来自账单真实数据,无任何编造,审计可溯源。
 *
 * 行为:
 *  - 按未收清单口径的 (归一化护照|姓名|小票号) 找回 store_bill 明细行,
 *    取首行身份字段建 daily_receipt_export 台账行;
 *  - sourceType='bill_backfill'(交付侧据此排除客户 PDF/客户文件夹,只进
 *    四桶数据 — 这些客户没有图片,凭证类产物业务上不成立);
 *  - tourMatchStatus 直接 'matched':补录的目的就是让账单进交付,团号校验
 *    在此场景属有意绕过(谁补录谁负责,modifiedBy/postedBy 记操作人);
 *  - rowHash 防重:同一张小票重复补录会被 INSERT OR IGNORE 跳过;
 *  - 建完行后自动重跑 bill_match(P1 小票号精确命中,数据本来就来自账单),
 *    台账配上后该小票从未收清单自然消失(listUnreceived = 账单 − 台账已收)。
 */

const { normalizeString } = require('../../lib/monthly_pipeline/matching/field_diff');
const { classifyBillFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { computeDailyRowHash } = require('../../lib/monthly/daily_row_hash');

function itemKey({ passportNo, name, receiptNo }) {
  return `${normalizeString(passportNo)}|${normalizeString(name)}|${normalizeString(receiptNo)}`;
}

function createUnreceivedBackfillService({ db, dailyReceiptRepo, billMatchService = null }) {
  if (!db) throw new Error('unreceived_backfill_service: db required');
  if (!dailyReceiptRepo) throw new Error('unreceived_backfill_service: dailyReceiptRepo required');

  // 未收口径同 customer_reconciliation:账单明细(仅销售行)按小票聚合。
  // is_detail_sheet=1(2026-07-21 复核 CRITICAL):补录=把账单行推进四桶最终交付,
  // 只许店家账单明细行走;SMG总账行(is_detail_sheet=0,拍板只做未收对账)若不拦,
  // 一次点击就能伪造 matched 台账行绕过"总账不进四桶"铁律。
  const billRowsStmt = db.prepare(`
    SELECT id, mode, store_family, store_branch, tour_no, purchase_date,
           departure_date, name, full_name, passport_no, receipt_no,
           SUM(COALESCE(net_krw, 0)) AS net_krw_sum,
           SUM(COALESCE(net_usd, 0)) AS net_usd_sum,
           SUM(COALESCE(gross_krw, 0)) AS gross_krw_sum
    FROM store_bill
    WHERE workspace_key = ?
      AND is_detail_sheet = 1
      AND receipt_no IS NOT NULL AND receipt_no != ''
      AND (transaction_type IS NULL OR transaction_type = 'sale')
    GROUP BY passport_no, name, receipt_no
  `);

  /**
   * @param {{ workspaceKey: string,
   *   items: Array<{passportNo?:string,name?:string,receiptNo?:string}>,
   *   operator?: string }} args
   * @returns {{ backfilled:number, skipped:number, notFound:string[],
   *   billMatch:object|null }}
   */
  async function backfill({ workspaceKey, items, operator = 'system' }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const wanted = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      const key = itemKey(it || {});
      if (key.replace(/\|/g, '')) wanted.set(key, it);
    }
    if (wanted.size === 0) {
      const err = new Error('no backfillable items');
      err.code = 'empty_items';
      err.statusCode = 400;
      throw err;
    }

    // 从账单聚合行里挑出请求的未收项
    const rows = [];
    const found = new Set();
    for (const bill of billRowsStmt.all(workspaceKey)) {
      const key = itemKey({ passportNo: bill.passport_no, name: bill.name, receiptNo: bill.receipt_no });
      if (!wanted.has(key) || found.has(key)) continue;
      found.add(key);
      const folder = classifyBillFolder({
        modeRaw: bill.mode,
        storeFamily: bill.store_family,
        storeBranch: bill.store_branch,
      });
      const now = new Date().toISOString();
      const row = {
        workspaceKey,
        modeRaw: bill.mode || bill.store_family || null,
        modeFolder: folder || null,
        shop: bill.store_family || null,
        name: bill.name || bill.full_name || null,
        passportNo: bill.passport_no || null,
        receiptNo: bill.receipt_no,
        tourNo: bill.tour_no || null,
        purchaseDate: bill.purchase_date || null,
        departureDate: bill.departure_date || null,
        grossKrw: bill.gross_krw_sum || null,
        netKrw: bill.net_krw_sum || null,
        netUsd: bill.net_usd_sum || null,
        remark: `补录自账单(未收确认收不到小票,store_bill_id=${bill.id})`,
        importedAt: now,
        sourceType: 'bill_backfill',
        ledgerStatus: 'posted',
        // 有意直接 matched:补录目的就是让这张账单进交付(操作人负责)
        tourMatchStatus: 'matched',
        postedAt: now,
        postedBy: operator,
        modifiedBy: operator,
      };
      row.rowHash = computeDailyRowHash(row);
      rows.push(row);
    }

    const notFound = [...wanted.keys()].filter((k) => !found.has(k));
    let backfilled = 0;
    let skipped = 0;
    if (rows.length) {
      const result = dailyReceiptRepo.insertMany(rows);
      backfilled = Number(result.inserted || 0);
      skipped = Number(result.skipped || 0);
    }

    // 自动重跑账单匹配,让补录行立即配上(P1 小票号必中);服务未注入时由前端引导手动跑
    let billMatch = null;
    if (backfilled > 0 && billMatchService && typeof billMatchService.run === 'function') {
      billMatch = await billMatchService.run({ workspaceKey });
    }

    return { backfilled, skipped, notFound, billMatch };
  }

  return { backfill };
}

module.exports = { createUnreceivedBackfillService, itemKey };
