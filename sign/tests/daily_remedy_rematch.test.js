'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBatchGroupCodeRepository } = require('../repositories/batch_group_code_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');

function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `remedy-rematch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return fn(db);
  } finally {
    try { db.close?.(); } catch { /* best-effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${tmp}${suffix}`, { force: true }); } catch { /* best-effort */ }
    }
  }
}

const WS = '2026-02';
function seed(repo) {
  repo.insertMany([
    { workspaceKey: WS, receiptNo: 'R1', shop: 'A', purchaseDate: '2026-02-01', tourNo: 'T1', tourMatchStatus: 'tour_not_found', sourceBatchId: 'B1', sourceType: 'imported', rowHash: 'h1', importedAt: '2026-02-01T00:00:00Z' },
    { workspaceKey: WS, receiptNo: 'R2', shop: 'A', purchaseDate: '2026-02-01', tourNo: 'T2', tourMatchStatus: 'matched', modeFolder: 'lotte_sg', sourceBatchId: 'B1', sourceType: 'imported', rowHash: 'h2', importedAt: '2026-02-01T00:00:00Z' },
    { workspaceKey: WS, receiptNo: 'R3', shop: 'A', purchaseDate: '2026-02-01', tourNo: 'T3', tourMatchStatus: 'agent_mismatch', sourceBatchId: 'B1', sourceType: 'imported', rowHash: 'h3', importedAt: '2026-02-01T00:00:00Z' },
    { workspaceKey: WS, receiptNo: 'R4', shop: 'A', purchaseDate: '2026-02-01', tourNo: 'T4', tourMatchStatus: 'tour_not_found', sourceBatchId: 'B2', sourceType: 'imported', rowHash: 'h4', importedAt: '2026-02-01T00:00:00Z' },
    { workspaceKey: WS, receiptNo: 'R5', shop: 'A', purchaseDate: '2026-02-01', tourNo: 'T5', tourMatchStatus: 'date_missing', sourceBatchId: 'B1', sourceType: 'imported', rowHash: 'h5', importedAt: '2026-02-01T00:00:00Z' },
  ]);
}

test('resetTourMatchForRematch — 只把本批次待补救行打回 pending;matched / 别批次 / 缺日期不动', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    seed(repo);

    const n = repo.resetTourMatchForRematch({ workspaceKey: WS, batchId: 'B1' });
    assert.equal(n, 2, 'R1(tour_not_found) + R3(agent_mismatch) 被重置');

    const byReceipt = Object.fromEntries(
      repo._listAll({ workspaceKey: WS }).map((r) => [r.receiptNo, r.tourMatchStatus]),
    );
    assert.equal(byReceipt.R1, 'pending');
    assert.equal(byReceipt.R3, 'pending');
    assert.equal(byReceipt.R2, 'matched', '已匹配的行不动');
    assert.equal(byReceipt.R4, 'tour_not_found', '别的批次不动');
    assert.equal(byReceipt.R5, 'date_missing', '缺购买日期不重置(重跑也救不了)');

    assert.equal(repo.listPendingTourMatch(WS, { batchId: 'B1' }).length, 2);
  });
});

test('resetTourMatchForRematch — 缺 batchId / workspaceKey 时返回 0,不误伤', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    seed(repo);

    assert.equal(repo.resetTourMatchForRematch({ workspaceKey: WS, batchId: '' }), 0);
    assert.equal(repo.resetTourMatchForRematch({ workspaceKey: '', batchId: 'B1' }), 0);

    const pendingCount = repo._listAll({ workspaceKey: WS })
      .filter((r) => r.tourMatchStatus === 'pending').length;
    assert.equal(pendingCount, 0, '没有任何行被误重置');
  });
});

async function withDbAsync(fn) {
  const tmp = path.join(os.tmpdir(), `remedy-rematch-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return await fn(db);
  } finally {
    try { db.close?.(); } catch { /* best-effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${tmp}${suffix}`, { force: true }); } catch { /* best-effort */ }
    }
  }
}

test('换表后重新匹配 — 找不到团号的行,换上含该团号的新表后不再 tour_not_found', async () => {
  await withDbAsync(async (db) => {
    const dailyRepo = createDailyReceiptRepository({ db });
    const batchGroupCodeRepo = createBatchGroupCodeRepository({ db });
    const groupCodeRepo = createGroupCodeRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const tourMatch = createTourMatchService({
      dailyReceiptRepo: dailyRepo, groupCodeRepo, batchGroupCodeRepo, pendingReviewRepo,
    });
    const BID = 'B1';

    dailyRepo.insertMany([
      { workspaceKey: WS, receiptNo: 'R1', shop: 'THE SHILLA', purchaseDate: '2026-02-10', tourNo: 'T999', tourMatchStatus: 'pending', sourceBatchId: BID, sourceType: 'imported', rowHash: 'flow1', importedAt: '2026-02-01T00:00:00Z', agent: 'A1' },
    ]);

    // ① 第一次匹配:团号表里没有 T999 → tour_not_found
    const first = await tourMatch.run({ workspaceKey: WS, batchId: BID });
    assert.equal(first.tourNotFound, 1);
    assert.equal(dailyRepo._listAll({ workspaceKey: WS })[0].tourMatchStatus, 'tour_not_found');

    // ② 换团号表:新表收录了 T999(宽日期窗、代理留空不校验)
    batchGroupCodeRepo.replaceBatch({
      batchId: BID,
      rows: [{
        batchId: BID, tourNo: 'T999', mode: 'SG乐天', agent: null,
        applyDate: '2026-02-01', endDate: '2026-02-28',
        rowHash: 'gc-t999', importedAt: '2026-02-02T00:00:00Z',
      }],
    });

    // ③ reset 待补救行 + 用新表重跑
    assert.equal(dailyRepo.resetTourMatchForRematch({ workspaceKey: WS, batchId: BID }), 1);
    await tourMatch.run({ workspaceKey: WS, batchId: BID });

    // ④ 团号已在新表命中 → 不再 tour_not_found
    assert.notEqual(
      dailyRepo._listAll({ workspaceKey: WS })[0].tourMatchStatus,
      'tour_not_found',
      '换表后该团号已命中',
    );
  });
});
