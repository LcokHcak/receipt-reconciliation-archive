'use strict';

/**
 * bill_enrichment_service (G19 改造 D)
 *
 * 账单匹配规则 docx —【补全字段】:
 *   "用台账信息补全{清洗前}的账单数据表格,补全同一客户同一小票号下的全部客户信息。"
 *
 * 跑完 bill_match 后,对 match_status='matched' 的 (daily, store_bill) 配对:
 *   1. 按账单 receipt_no 分组,锁定该小票对应的台账客户行
 *   2. 把该 receipt_no 下"所有"商品行的空客户字段用台账补齐
 *   3. 护照占位符 (HDC_* / PKG*) 视作空,强制用台账真护照覆盖
 *
 * 安全约束 (决策: 只补客户信息,不动金额):
 *   - 只补 passport_no / departure_date / tour_no / name / full_name
 *   - 已有真实值的字段一律不动 (COALESCE(NULLIF(field,''), daily))
 *   - 金额/数量/品牌等业务字段绝不触碰
 */

const ENRICHABLE = Object.freeze(['passport_no', 'departure_date', 'tour_no', 'name', 'full_name']);
const PLACEHOLDER_RE = /^(HDC_|PKG)/i;

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value || ''));
}

function createBillEnrichmentService({
  db,
  storeBillRepo,
  dailyReceiptRepo,
  auditLogService = null,
}) {
  if (!db) throw new Error('bill_enrichment_service: db required');
  if (!storeBillRepo || !dailyReceiptRepo) {
    throw new Error('bill_enrichment_service: storeBillRepo + dailyReceiptRepo required');
  }

  const matchedPairsStmt = db.prepare(`
    SELECT daily_receipt_id AS dailyReceiptId, store_bill_id AS storeBillId
    FROM bill_match_log
    WHERE workspace_key = ? AND match_status = 'matched'
      AND daily_receipt_id IS NOT NULL AND store_bill_id IS NOT NULL
  `);

  const fillStmt = db.prepare(`
    UPDATE store_bill
    SET passport_no    = COALESCE(NULLIF(passport_no, ''), ?),
        departure_date = COALESCE(NULLIF(departure_date, ''), ?),
        tour_no        = COALESCE(NULLIF(tour_no, ''), ?),
        name           = COALESCE(NULLIF(name, ''), ?),
        full_name      = COALESCE(NULLIF(full_name, ''), ?),
        enriched_at    = ?,
        enriched_from_daily_id = ?
    WHERE workspace_key = ? AND receipt_no = ?
  `);

  const placeholderOverrideStmt = db.prepare(`
    UPDATE store_bill
    SET passport_no = ?,
        enriched_at = ?,
        enriched_from_daily_id = ?
    WHERE workspace_key = ? AND receipt_no = ?
      AND (passport_no IS NULL OR passport_no = ''
           OR passport_no LIKE 'HDC\\_%' ESCAPE '\\'
           OR passport_no LIKE 'PKG%')
  `);

  function run({ workspaceKey } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const stats = { receiptsTargeted: 0, receiptsEnriched: 0, itemsEnriched: 0, placeholderOverrides: 0 };

    const dailyById = new Map();
    for (const row of dailyReceiptRepo._listAll({ workspaceKey })) {
      dailyById.set(Number(row.id), row);
    }
    const billById = new Map();
    for (const bill of storeBillRepo.iterateDetail(workspaceKey)) {
      billById.set(Number(bill.id), bill);
    }

    // 按 receipt_no 锁定台账来源(同小票第一条 matched daily 作为补全源)
    const receiptToDaily = new Map();
    for (const pair of matchedPairsStmt.all(workspaceKey)) {
      const bill = billById.get(Number(pair.storeBillId));
      const daily = dailyById.get(Number(pair.dailyReceiptId));
      if (!bill || !daily || !bill.receiptNo) continue;
      if (!receiptToDaily.has(bill.receiptNo)) {
        receiptToDaily.set(bill.receiptNo, daily);
        stats.receiptsTargeted += 1;
      }
    }

    const nowIso = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const [receiptNo, daily] of receiptToDaily) {
        // 占位符护照强制覆盖(在 COALESCE 填空之前先把占位符清成真护照)
        if (daily.passportNo) {
          const existing = storeBillRepo.findByReceipt({ workspaceKey, receiptNo });
          if (existing.some((b) => isPlaceholder(b.passportNo))) {
            const ov = placeholderOverrideStmt.run(
              daily.passportNo, nowIso, daily.id, workspaceKey, receiptNo,
            );
            stats.placeholderOverrides += ov.changes;
          }
        }

        const result = fillStmt.run(
          daily.passportNo || null,
          daily.departureDate || null,
          daily.tourNo || null,
          daily.name || null,
          daily.fullName || daily.name || null,
          nowIso,
          daily.id,
          workspaceKey,
          receiptNo,
        );
        if (result.changes > 0) {
          stats.receiptsEnriched += 1;
          stats.itemsEnriched += result.changes;
        }

        if (auditLogService && typeof auditLogService.write === 'function') {
          auditLogService.write({
            workspaceKey,
            userId: 'bill_enrichment_service',
            action: 'bill_field_enrich',
            resourceType: 'store_bill',
            resourceId: String(daily.id),
            details: JSON.stringify({ receiptNo, fields: ENRICHABLE }),
            createdAt: nowIso,
          });
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return stats;
  }

  return { run };
}

module.exports = { createBillEnrichmentService, ENRICHABLE };
