'use strict';

/**
 * second_pass_missing_service — stage 3 backfill (Sprint 2 W3).
 *
 * After stage 2 completes, every daily_receipt_export row still marked
 * bill_match_status = 'unmatched' is one of:
 *   a. bill arrived under a different receipt_no (typo / reprint)
 *   b. bill truly missing — operator must chase the store
 *
 * Strategy:
 *   1. For each unmatched daily row, try to find a store_bill row with
 *      the same (passport_no OR name) + tour_no + purchaseDate ± 2 days
 *   2. If exactly one hit → promote to pending_review (reason: second_pass)
 *      so operator confirms before a write
 *   3. If zero hits → keep status unchanged; these are real 未收
 *
 * Produces only review requests + stats; does NOT mutate
 * bill_match_status directly (that's operator's job via the UI).
 */

const { normalizeString, normalizeDate, isEmptyValue } = require('../../lib/monthly_pipeline/matching/field_diff');
const { tracker: progressTracker } = require('../../lib/stage_progress_tracker');

function createSecondPassMissingService({
  dailyReceiptRepo,
  storeBillRepo,
  pendingReviewRepo,
}) {
  if (!dailyReceiptRepo || !storeBillRepo || !pendingReviewRepo) {
    throw new Error('second_pass_missing_service: missing repos');
  }

  async function run({ workspaceKey, dateWindowDays = 2 } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const startedAt = new Date().toISOString();
    const stats = {
      scanned: 0,
      promotedToReview: 0,
      stillMissing: 0,
      ambiguousCandidates: 0,
    };
    const pendings = [];

    // Build a quick in-memory index of bills by passport / name / tour
    const bills = storeBillRepo.iterateDetail(workspaceKey);
    const billByPassport = groupBy(bills, (b) => normalizeString(b.passportNo));
    const billByTour = groupBy(bills, (b) => normalizeString(b.tourNo));

    // Walk every daily row still marked unmatched
    const unmatchedRows = db_listAllUnmatched(dailyReceiptRepo, workspaceKey);
    progressTracker.update({ workspaceKey, stage: 'second_pass', current: 0, total: unmatchedRows.length });
    const PROGRESS_TICK = 200;
    let processed = 0;
    // B2(2026-07-16 同步一致性审计):重跑去重——同一台账行已有 open 的二次候选就不再堆一条
    // (此前直插无去重,重复堆积一直被 M4 的越界误删"对冲"掩盖;M4 修掉后必须补这层)。
    const openCandidateIds = new Set(
      (pendingReviewRepo.list({ workspaceKey, status: 'open', reasonType: 'second_pass_candidate', limit: 100000 }) || [])
        .map((r) => Number(r.sourceId ?? r.source_id)).filter(Number.isFinite),
    );

    for (const row of unmatchedRows) {
      stats.scanned += 1;
      if (openCandidateIds.has(Number(row.id))) {
        stats.skippedExistingOpen = (stats.skippedExistingOpen || 0) + 1;
        processed += 1;
        continue;
      }
      const candidates = findCandidates({
        row, billByPassport, billByTour, dateWindowDays,
      });
      if (candidates.length === 0) {
        stats.stillMissing += 1;
        processed += 1;
        if (processed % PROGRESS_TICK === 0) {
          progressTracker.update({ workspaceKey, stage: 'second_pass', current: processed, total: unmatchedRows.length });
        }
        continue;
      }
      if (candidates.length > 1) stats.ambiguousCandidates += 1;
      stats.promotedToReview += 1;
      pendings.push({
        workspaceKey,
        sourceTable: 'daily_receipt_export',
        sourceId: row.id,
        reasonType: 'second_pass_candidate',
        detail: {
          dailyReceiptNo: row.receiptNo,
          dailyName: row.name,
          dailyPassport: row.passportNo,
          dailyTour: row.tourNo,
          dailyPurchaseDate: row.purchaseDate,
          candidates: candidates.slice(0, 10).map((c) => ({
            billId: c.id,
            receiptNo: c.receiptNo,
            name: c.name,
            passportNo: c.passportNo,
            tourNo: c.tourNo,
            purchaseDate: c.purchaseDate,
            storeFamily: c.storeFamily,
          })),
        },
        status: 'open',
        createdAt: startedAt,
      });
      processed += 1;
      if (processed % PROGRESS_TICK === 0) {
        progressTracker.update({ workspaceKey, stage: 'second_pass', current: processed, total: unmatchedRows.length });
      }
    }
    progressTracker.update({ workspaceKey, stage: 'second_pass', current: processed, total: unmatchedRows.length });

    if (pendings.length) pendingReviewRepo.insertMany(pendings);

    return {
      workspaceKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...stats,
    };
  }

  return { run };
}

function findCandidates({ row, billByPassport, billByTour, dateWindowDays }) {
  const targetDate = row.purchaseDate ? normalizeDate(row.purchaseDate) : null;
  const candidatePool = new Map();

  if (!isEmptyValue(row.passportNo)) {
    for (const b of billByPassport.get(normalizeString(row.passportNo)) || []) {
      candidatePool.set(b.id, b);
    }
  }
  if (!isEmptyValue(row.tourNo)) {
    for (const b of billByTour.get(normalizeString(row.tourNo)) || []) {
      // require name or passport match to be added via tour
      if (normalizeString(b.name) === normalizeString(row.name)
          || normalizeString(b.passportNo) === normalizeString(row.passportNo)) {
        candidatePool.set(b.id, b);
      }
    }
  }

  const out = [];
  for (const b of candidatePool.values()) {
    if (targetDate && b.purchaseDate) {
      const bd = normalizeDate(b.purchaseDate);
      if (daysBetween(targetDate, bd) > dateWindowDays) continue;
    }
    out.push(b);
  }
  return out;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return Infinity;
  return Math.abs((da.getTime() - db.getTime()) / 86400000);
}

function db_listAllUnmatched(dailyReceiptRepo, workspaceKey) {
  // Use the repo's internal db access via helper — add one-off query
  // through _listUnmatched if present; else fall back to folder walk.
  if (typeof dailyReceiptRepo._listUnmatched === 'function') {
    return dailyReceiptRepo._listUnmatched({ workspaceKey });
  }
  throw new Error('dailyReceiptRepo._listUnmatched is required for second pass');
}

module.exports = { createSecondPassMissingService };
