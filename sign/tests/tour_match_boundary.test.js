'use strict';

/**
 * 域1/域2 边界测试(docs/边界测试设计.md,2026-07-21):
 *
 *   1. tour_ambiguous 正路(tour_match_service:299)——同团号同店多行信号集歧义判定:
 *      ① 两行 required 模式归不同桶 → tour_ambiguous;② required+非required → tour_ambiguous;
 *      ③ 两行同桶(signatures size=1)→ 不歧义,matched。
 *   2. checkDateWindow 经 tour_match(:497)——窗前/窗后/恰好窗沿/购买日期空。
 *   3. 状态优先级(:387 三元链)——agent 不符 + 日期越窗同存 → agent_mismatch。
 *   4. normalizeTourNo 兜底(:145)——剥前缀字母/剥后缀命中;中间字母团号精确命中保字母。
 *   5. ⭐date_missing 语义非对称交叉锁定:
 *      (a) workbench_approve_settle_service.deriveSettlementStatus 判 needs_remedy;
 *      (b) daily_receipt/writes.resetTourMatchForRematch **不**把它重置回 pending。
 *   6. ⭐tour_no NULL vs 空串'':confirmModesByGroup 现行 SQL 只判 IS NULL——
 *      NULL+pending 盖戳、''+pending 不盖(如实锁现行为,语义边界见设计文档域1)。
 *
 * 搭法与 tests/tour_match_groupcode_mode.test.js / tests/monthly/tour_store_disambiguation.test.js
 * 一致:真 SQLite(openMonthlyDatabase)+ 真 repo 种子,不 mock 判定路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createWorkbenchApproveSettleService } = require('../services/workbench_approve_settle_service');

const WS = '2026-02';

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `tour-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try { return await fn(db); } finally {
    try { db.close?.(); } catch { /* best effort */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(`${tmp}${s}`, { force: true }); } catch { /* best effort */ } }
  }
}

function makeRepos(db) {
  return {
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    groupCodeRepo: createGroupCodeRepository({ db }),
    pendingReviewRepo: createPendingReviewRepository({ db }),
    errorRecordRepo: createErrorRecordRepository({ db }),
  };
}

// 团号表种子:modes = [{mode, agent?, applyDate?, endDate?}],同团号多行。
function seedGroupCode(groupCodeRepo, tourNo, modes) {
  groupCodeRepo.insertMany(modes.map((m, i) => ({
    workspaceKey: WS,
    tourNo,
    mode: m.mode,
    modeNormalized: null,
    agent: m.agent || null,
    applyDate: m.applyDate || null,
    endDate: m.endDate || null,
    rowHash: `gc-${tourNo}-${i}`,
    importedAt: 't',
  })));
}

// 台账行种子(pending 待匹配)。shop 用 'LOTTE' 使 normalizeStoreFamily 可判店
// (消歧闸生效,与 70299 病例测试同款);modeRaw 空 = 千问收票无返点模式。
function seedDaily(dailyReceiptRepo, { rowHash, tourNo, agent = null, purchaseDate = '2026-02-10', shop = 'LOTTE', tourMatchStatus = 'pending', sourceBatchId = null, sourceCustomerId = null }) {
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS,
    receiptNo: 'R-' + rowHash,
    name: 'WANG',
    passportNo: 'P-' + rowHash,
    tourNo,
    agent,
    shop,
    branch: '',
    modeRaw: '',
    purchaseDate,
    rowHash,
    importedAt: 't',
    sourceType: 'imported',
    ledgerStatus: 'posted',
    tourMatchStatus,
    sourceBatchId,
    sourceCustomerId,
  }]);
}

function runTour(repos) {
  const svc = createTourMatchService({
    dailyReceiptRepo: repos.dailyReceiptRepo,
    groupCodeRepo: repos.groupCodeRepo,
    pendingReviewRepo: repos.pendingReviewRepo,
    errorRecordRepo: repos.errorRecordRepo,
  });
  return svc.run({ workspaceKey: WS });
}

function rowByHash(dailyReceiptRepo, rowHash) {
  return dailyReceiptRepo._listAll({ workspaceKey: WS })
    .find((r) => (r.rowHash ?? r.row_hash) === rowHash);
}

function openAmbiguousCount(pendingReviewRepo) {
  return Number(pendingReviewRepo.count({ workspaceKey: WS, status: 'open', reasonType: 'tour_ambiguous' }) || 0);
}

// ---------------------------------------------------------------------------
// 1. tour_ambiguous 正路(tour_match_service:299)
// ---------------------------------------------------------------------------

test('歧义①:同团号同店两行 required 模式归不同桶 → tour_ambiguous,行 modeRaw/folder 清空,进待补救', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    // 同店(都是乐天免税店家族)、都在 7 枚举、但桶不同:乐天首尔 vs 乐天釜山
    seedGroupCode(repos.groupCodeRepo, '70701', [
      { mode: '乐天SG-本司' },
      { mode: '乐天釜山SG-本司' },
    ]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-amb1', tourNo: '70701' });

    const stats = await runTour(repos);

    assert.equal(stats.tourAmbiguous, 1, '统计到 1 条歧义');
    assert.equal(stats.matched, 0, '歧义行不算 matched');
    const row = rowByHash(repos.dailyReceiptRepo, 'd-amb1');
    assert.equal(row.tourMatchStatus, 'tour_ambiguous');
    assert.equal(row.modeFolder, null, '歧义不猜桶,folder 清空');
    assert.ok(row.modeRaw == null || row.modeRaw === '', '歧义不写模式,modeRaw 保持空');
    assert.equal(openAmbiguousCount(repos.pendingReviewRepo), 1, '产生 tour_ambiguous 待补救');
  });
});

test('歧义②:一行 required 一行非 required(signatures={folder:X,skip})→ tour_ambiguous', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    // '乐天PKG' 无 -本司 后缀 → 非 required → 信号 'skip';与 'folder:乐天首尔' 不一致
    seedGroupCode(repos.groupCodeRepo, '70702', [
      { mode: '乐天SG-本司' },
      { mode: '乐天PKG' },
    ]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-amb2', tourNo: '70702' });

    const stats = await runTour(repos);

    assert.equal(stats.tourAmbiguous, 1, '参加/不参加交付信号冲突也算歧义');
    const row = rowByHash(repos.dailyReceiptRepo, 'd-amb2');
    assert.equal(row.tourMatchStatus, 'tour_ambiguous');
    assert.equal(row.modeFolder, null);
    assert.equal(openAmbiguousCount(repos.pendingReviewRepo), 1);
  });
});

test('歧义③负路:两行归同桶(signatures size=1)→ 不歧义,取行 matched', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    // 乐天SG-本司 / 乐天H团-本司 都归「乐天首尔」→ 归类信号一致 → 无需人工
    seedGroupCode(repos.groupCodeRepo, '70703', [
      { mode: '乐天SG-本司' },
      { mode: '乐天H团-本司' },
    ]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-amb3', tourNo: '70703' });

    const stats = await runTour(repos);

    assert.equal(stats.tourAmbiguous, 0, '同桶多行不算歧义');
    assert.equal(stats.matched, 1);
    const row = rowByHash(repos.dailyReceiptRepo, 'd-amb3');
    assert.equal(row.tourMatchStatus, 'matched');
    assert.equal(row.modeFolder, '乐天首尔', '按首行归桶');
    assert.ok(['乐天SG-本司', '乐天H团-本司'].includes(row.modeRaw), 'modeRaw 来自团号表候选行');
    assert.equal(openAmbiguousCount(repos.pendingReviewRepo), 0, '不产生歧义待补救');
  });
});

// ---------------------------------------------------------------------------
// 2. checkDateWindow 经 tour_match(:497)
// ---------------------------------------------------------------------------

const WINDOW = { applyDate: '2026-02-01', endDate: '2026-02-28' };

test('日期窗:购买日期在窗前/窗后 → date_out_of_window', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '70711', [{ mode: '乐天SG-本司', ...WINDOW }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-before', tourNo: '70711', purchaseDate: '2026-01-31' });
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-after', tourNo: '70711', purchaseDate: '2026-03-01' });

    const stats = await runTour(repos);

    assert.equal(stats.dateOutOfWindow, 2, '窗前+窗后各 1');
    assert.equal(stats.matched, 0);
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-before').tourMatchStatus, 'date_out_of_window', '2026-01-31 < applyDate 2026-02-01 越窗');
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-after').tourMatchStatus, 'date_out_of_window', '2026-03-01 > endDate 2026-02-28 越窗');
  });
});

test('日期窗:购买日期恰好等于窗沿(=applyDate / =endDate)→ 不越窗,matched', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '70712', [{ mode: '乐天SG-本司', ...WINDOW }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-edge-start', tourNo: '70712', purchaseDate: '2026-02-01' });
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-edge-end', tourNo: '70712', purchaseDate: '2026-02-28' });

    const stats = await runTour(repos);

    assert.equal(stats.dateOutOfWindow, 0, '闭区间:窗沿当天有效');
    assert.equal(stats.matched, 2);
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-edge-start').tourMatchStatus, 'matched');
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-edge-end').tourMatchStatus, 'matched');
  });
});

test('日期窗:购买日期空 → 跳过日期判定,不判越窗', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '70713', [{ mode: '乐天SG-本司', ...WINDOW }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-nodate', tourNo: '70713', purchaseDate: '' });

    const stats = await runTour(repos);

    assert.equal(stats.dateOutOfWindow, 0, '无日期可查 → 不判越窗');
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-nodate').tourMatchStatus, 'matched');
  });
});

// ---------------------------------------------------------------------------
// 3. 状态优先级(:387 三元链:agent_mismatch > date_out_of_window > matched)
// ---------------------------------------------------------------------------

test('状态优先级:agent 不符 + 日期越窗同存 → 状态取 agent_mismatch', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '70722', [{ mode: '乐天SG-本司', agent: '张三', ...WINDOW }]);
    // 代理不同(张三 vs 李四)+ 购买日期出窗(2026-03-05)→ 双违规同存
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-prio', tourNo: '70722', agent: '李四', purchaseDate: '2026-03-05' });

    const stats = await runTour(repos);

    assert.equal(stats.agentMismatch, 1, '代理违规照常统计');
    assert.equal(stats.dateOutOfWindow, 1, '日期违规照常统计(两违规都记账)');
    const row = rowByHash(repos.dailyReceiptRepo, 'd-prio');
    assert.equal(row.tourMatchStatus, 'agent_mismatch', '双违规时状态按三元链取 agent_mismatch');
    assert.equal(
      Number(repos.pendingReviewRepo.count({ workspaceKey: WS, status: 'open', reasonType: 'agent_mismatch' }) || 0),
      1,
      '产生 agent_mismatch 待补救',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. normalizeTourNo 兜底(:145)
// ---------------------------------------------------------------------------

test('normalizeTourNo:表存 26147854,收票 R26147854 → 剥前缀字母命中 matched', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '26147854', [{ mode: '乐天SG-本司' }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-prefix', tourNo: 'R26147854' });

    const stats = await runTour(repos);

    assert.equal(stats.tourNotFound, 0, '乐天R团前缀剥掉后应命中,不判 tour_not_found');
    assert.equal(stats.matched, 1);
    const row = rowByHash(repos.dailyReceiptRepo, 'd-prefix');
    assert.equal(row.tourMatchStatus, 'matched');
    assert.equal(row.modeRaw, '乐天SG-本司', 'modeRaw 来自团号表命中行');
  });
});

test('normalizeTourNo:收票 26147854-2(二次收票后缀)→ 剥后缀命中 matched', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '26147854', [{ mode: '乐天SG-本司' }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-suffix', tourNo: '26147854-2' });

    const stats = await runTour(repos);

    assert.equal(stats.tourNotFound, 0);
    assert.equal(stats.matched, 1);
    assert.equal(rowByHash(repos.dailyReceiptRepo, 'd-suffix').tourMatchStatus, 'matched');
  });
});

test('normalizeTourNo:表存 26V00041 收票 26V00041 → 精确命中(中间字母不剥,保字母)', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedGroupCode(repos.groupCodeRepo, '26V00041', [{ mode: '乐天SG-本司' }]);
    seedDaily(repos.dailyReceiptRepo, { rowHash: 'd-letter', tourNo: '26V00041' });

    const stats = await runTour(repos);

    assert.equal(stats.tourNotFound, 0, '字母团号必须走精确命中,不得被归一化毁掉');
    assert.equal(stats.matched, 1);
    const row = rowByHash(repos.dailyReceiptRepo, 'd-letter');
    assert.equal(row.tourMatchStatus, 'matched');
    assert.equal(row.tourNo, '26V00041', '铁律:存储行 tour_no 原样保字母,匹配不回写投影');
  });
});

// ---------------------------------------------------------------------------
// 5. ⭐date_missing 语义非对称交叉锁定
//    在 approve_settle 的 REMEDY_STATUSES(→needs_remedy),
//    却不在 writes 的 REMATCH_RESET_STATUSES(重跑不重置)。两断言锁死非对称。
// ---------------------------------------------------------------------------

test('date_missing 非对称(a):组内一行 date_missing → deriveSettlementStatus=needs_remedy', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    // C1 组:date_missing + matched 混合 → remedy 优先
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-dm-1', tourNo: '70731', tourMatchStatus: 'date_missing',
      purchaseDate: '', sourceBatchId: 'B-DM', sourceCustomerId: 'C1',
    });
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-dm-2', tourNo: '70731', tourMatchStatus: 'matched',
      sourceBatchId: 'B-DM', sourceCustomerId: 'C1',
    });
    // C2 对照组:仅 matched(未确认)→ needs_confirm,证明 needs_remedy 是 date_missing 驱动的
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-dm-3', tourNo: '70731', tourMatchStatus: 'matched',
      sourceBatchId: 'B-DM', sourceCustomerId: 'C2',
    });

    const svc = createWorkbenchApproveSettleService({
      groupApprovalService: { approveGroup: async () => ({ approvedTaskIds: [] }) },
      ledgerBridgeService: { syncApprovedGroup: async () => ({ inserted: 0 }) },
      tourMatchService: { run: async () => ({}) },
      dailyReceiptRepo: repos.dailyReceiptRepo,
      logger: { error: () => {} },
    });

    const c1 = svc.getGroupSettlement({ batch: { id: 'B-DM' }, groupKey: 'C1' });
    assert.equal(c1.settlementStatus, 'needs_remedy', 'date_missing 在 REMEDY_STATUSES → 组判 needs_remedy');
    assert.ok(c1.settledReceipts.some((r) => r.tourMatchStatus === 'date_missing'), '回读行带 date_missing 状态');

    const c2 = svc.getGroupSettlement({ batch: { id: 'B-DM' }, groupKey: 'C2' });
    assert.equal(c2.settlementStatus, 'needs_confirm', '对照组无 date_missing → needs_confirm(非 remedy)');
  });
});

test('date_missing 非对称(b):resetTourMatchForRematch 不把 date_missing 重置回 pending', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-rst-dm', tourNo: '70741', tourMatchStatus: 'date_missing',
      purchaseDate: '', sourceBatchId: 'B-RST', sourceCustomerId: 'C1',
    });
    // 对照:tour_not_found 在 REMATCH_RESET_STATUSES → 会被打回 pending
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-rst-tnf', tourNo: '70742', tourMatchStatus: 'tour_not_found',
      sourceBatchId: 'B-RST', sourceCustomerId: 'C1',
    });

    const changed = repos.dailyReceiptRepo.resetTourMatchForRematch({ workspaceKey: WS, batchId: 'B-RST' });

    assert.equal(changed, 1, '默认状态清单只覆盖 tour_not_found 这 1 行');
    assert.equal(
      rowByHash(repos.dailyReceiptRepo, 'd-rst-dm').tourMatchStatus,
      'date_missing',
      'date_missing 缺购买日期、重跑救不了 → 不重置,留人工',
    );
    assert.equal(
      rowByHash(repos.dailyReceiptRepo, 'd-rst-tnf').tourMatchStatus,
      'pending',
      'tour_not_found 正常打回 pending 待重匹配',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. ⭐tour_no NULL vs 空串''(confirmModesByGroup 现行 SQL 只判 IS NULL)
//    正常写路径 insertMany 把 '' 归一成 NULL;'' 只能来自历史/直改数据——
//    这里用直 SQL 模拟历史空串行,如实锁定「NULL 盖、'' 不盖」的现行语义边界。
// ---------------------------------------------------------------------------

test("tour_no NULL vs 空串'':confirmModesByGroup 盖 NULL+pending,不盖 ''+pending(现行为)", async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    // rowA:tourNo '' 经 insertMany 归一 → 落库 NULL(无团号票的正常形态)
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-null', tourNo: '', tourMatchStatus: 'pending',
      sourceBatchId: 'B-CONF', sourceCustomerId: 'C-CONF',
    });
    // rowB:直 SQL 造历史空串 ''(正常写路径造不出来)
    seedDaily(repos.dailyReceiptRepo, {
      rowHash: 'd-empty', tourNo: '', tourMatchStatus: 'pending',
      sourceBatchId: 'B-CONF', sourceCustomerId: 'C-CONF',
    });
    db.prepare("UPDATE daily_receipt_export SET tour_no = '' WHERE workspace_key = ? AND row_hash = ?")
      .run(WS, 'd-empty');

    // 前提自证:rowA 落库确实是 NULL,rowB 确实是 ''
    assert.equal(
      db.prepare('SELECT tour_no FROM daily_receipt_export WHERE workspace_key = ? AND row_hash = ?').get(WS, 'd-null').tour_no,
      null,
      "insertMany 把 '' 归一成 NULL(空值收口)",
    );
    assert.equal(
      db.prepare('SELECT tour_no FROM daily_receipt_export WHERE workspace_key = ? AND row_hash = ?').get(WS, 'd-empty').tour_no,
      '',
      '历史空串行就位',
    );

    const stamped = repos.dailyReceiptRepo.confirmModesByGroup({
      workspaceKey: WS, sourceBatchId: 'B-CONF', sourceCustomerId: 'C-CONF', operator: 'op-x',
    });

    assert.equal(stamped, 1, "现行 SQL 只判 tour_no IS NULL → 仅 NULL 行被盖");
    const rowNull = rowByHash(repos.dailyReceiptRepo, 'd-null');
    const rowEmpty = rowByHash(repos.dailyReceiptRepo, 'd-empty');
    assert.ok(rowNull.modeConfirmedAt, 'NULL+pending 无团号票:确认盖戳成功');
    assert.equal(rowNull.modeConfirmedBy, 'op-x');
    assert.equal(
      rowEmpty.modeConfirmedAt,
      null,
      "⚠️语义边界(如实锁现行为):''+pending 不被盖——历史空串行确认永久无效,见设计文档域1「tour_no 空值非对称」",
    );

    // 幂等:再确认一次,NULL 行已有戳、'' 行仍被排除 → 0 新增
    const again = repos.dailyReceiptRepo.confirmModesByGroup({
      workspaceKey: WS, sourceBatchId: 'B-CONF', sourceCustomerId: 'C-CONF', operator: 'op-x',
    });
    assert.equal(again, 0, '二次确认幂等,空串行也不会在重试中被误盖');
  });
});
