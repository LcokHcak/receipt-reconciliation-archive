const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchBatchLedgerImportService } = require('../services/workbench_batch_ledger_import_service');

test('batch ledger import syncs approved non-rephoto receipt groups and runs tour matching', async () => {
  const syncCalls = [];
  const tourCalls = [];
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: {
      async syncApprovedGroup(args) {
        syncCalls.push(args);
        return {
          workspaceKey: args.workspaceKey,
          inserted: args.groupTasks.filter((task) => task.docTypeFinal === 'receipt').length,
          skipped: 0,
        };
      },
    },
    tourMatchService: {
      async run(args) {
        tourCalls.push(args);
        return { scanned: 2, matched: 1, tourNotFound: 1 };
      },
    },
  });

  const batch = {
    id: 'batch_1',
    monthlyWorkspaceKey: '2026-05',
    tasks: [
      { id: 'p1', sourceGroupKey: 'g1', docTypeFinal: 'passport', reviewed: true },
      { id: 'r1', sourceGroupKey: 'g1', docTypeFinal: 'receipt', reviewed: true },
      { id: 'r2', sourceGroupKey: 'g1', docTypeFinal: 'receipt', reviewed: true },
      { id: 'p2', sourceGroupKey: 'g2', docTypeFinal: 'passport', reviewed: true },
      { id: 'r3', sourceGroupKey: 'g2', docTypeFinal: 'receipt', reviewed: true, rephotoRequested: true },
      { id: 'p3', sourceGroupKey: 'g3', docTypeFinal: 'passport', reviewed: true },
      { id: 'p4', sourceGroupKey: 'g4', docTypeFinal: 'passport', reviewed: false },
      { id: 'r4', sourceGroupKey: 'g4', docTypeFinal: 'receipt', reviewed: true },
      { id: 'r5', sourceGroupKey: 'g5', docTypeFinal: 'receipt', reviewed: true },
      { id: 'p6a', sourceGroupKey: 'g6', docTypeFinal: 'passport', reviewed: true },
      { id: 'p6b', sourceGroupKey: 'g6', docTypeFinal: 'passport', reviewed: true },
      { id: 'r6', sourceGroupKey: 'g6', docTypeFinal: 'receipt', reviewed: true },
    ],
  };

  const result = await service.importBatchToLedger({ batch, operator: 'reviewer1' });

  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].groupKey, 'g1');
  assert.equal(syncCalls[0].workspaceKey, '2026-05');
  assert.equal(syncCalls[0].operator, 'reviewer1');
  assert.equal(result.totalGroups, 6);
  assert.equal(result.eligibleGroups, 1);
  assert.equal(result.insertedRows, 2);
  assert.equal(result.skippedRows, 0);
  assert.deepEqual(result.skippedGroups.map((group) => [group.groupKey, group.reason]), [
    ['g2', 'rephoto_requested'],
    ['g3', 'no_receipts'],
    ['g4', 'not_approved'],
    ['g5', 'invalid_passport_count'],
    ['g6', 'invalid_passport_count'],
  ]);
  // 成功导入台账的组键回报(handler 据此补盖组级结算章,堵 B5 删除守卫失明,审计 HIGH)
  assert.deepEqual(result.importedGroupKeys, ['g1']);
  assert.equal(tourCalls.length, 1);
  assert.deepEqual(tourCalls[0], { workspaceKey: '2026-05', operator: 'reviewer1', batchId: 'batch_1' });
  assert.deepEqual(result.tourMatch, { workspaceKey: '2026-05', scanned: 2, matched: 1, tourNotFound: 1 });
  assert.deepEqual(result.tourMatchResults, [{ workspaceKey: '2026-05', scanned: 2, matched: 1, tourNotFound: 1 }]);
});

test('batch ledger import skips duplicate receipt business keys inside the same batch', async () => {
  const syncCalls = [];
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: {
      async syncApprovedGroup(args) {
        syncCalls.push(args);
        return {
          workspaceKey: args.workspaceKey,
          inserted: args.groupTasks.filter((task) => task.docTypeFinal === 'receipt').length,
          skipped: 0,
        };
      },
    },
  });

  const batch = {
    id: 'batch_1',
    monthlyWorkspaceKey: '2026-05',
    tasks: [
      { id: 'p1', sourceGroupKey: 'g1', docTypeFinal: 'passport', reviewed: true },
      {
        id: 'r1',
        sourceGroupKey: 'g1',
        docTypeFinal: 'receipt',
        reviewed: true,
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '032-615-530-0069',
        purchaseDateFinal: '2026-01-15',
      },
      { id: 'p2', sourceGroupKey: 'g2', docTypeFinal: 'passport', reviewed: true },
      {
        id: 'r2',
        sourceGroupKey: 'g2',
        docTypeFinal: 'receipt',
        reviewed: true,
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0326155300069',
        purchaseDateFinal: '2026-01-15',
      },
    ],
  };

  const result = await service.importBatchToLedger({ batch, operator: 'reviewer1' });

  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].groupKey, 'g1');
  assert.equal(result.insertedRows, 1);
  assert.deepEqual(result.skippedGroups.map((group) => [group.groupKey, group.reason]), [
    ['g2', 'duplicate_receipts_in_batch'],
  ]);
});

test('坏组桥接 throw(日期超窗等)→进 failedGroups,其余组照常导入(2026-07-14 审计#9)', async () => {
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: {
      async syncApprovedGroup(args) {
        if (args.groupKey === 'g_bad') {
          const err = new Error('客户组 g_bad / task_x / purchaseDate 2023-01-01 超范围');
          err.code = 'purchase_date_out_of_range';
          throw err;
        }
        return { workspaceKey: args.workspaceKey, inserted: 1, skipped: 0 };
      },
    },
  });

  const batch = {
    id: 'batch_1',
    monthlyWorkspaceKey: '2026-05',
    tasks: [
      { id: 'p1', sourceGroupKey: 'g_bad', docTypeFinal: 'passport', reviewed: true },
      { id: 'r1', sourceGroupKey: 'g_bad', docTypeFinal: 'receipt', reviewed: true, receiptNoFinal: '111', receiptStoreFinal: 'LOTTE', purchaseDateFinal: '2023-01-01' },
      { id: 'p2', sourceGroupKey: 'g_ok', docTypeFinal: 'passport', reviewed: true },
      { id: 'r2', sourceGroupKey: 'g_ok', docTypeFinal: 'receipt', reviewed: true, receiptNoFinal: '222', receiptStoreFinal: 'LOTTE', purchaseDateFinal: '2026-05-01' },
    ],
  };

  const result = await service.importBatchToLedger({ batch, operator: 'reviewer1' });

  // 坏组显式失败,好组照常导入——曾经一个坏组把整个循环炸死,后面的组连尝试都没有
  assert.equal(result.failedGroups.length, 1);
  assert.equal(result.failedGroups[0].groupKey, 'g_bad');
  assert.match(String(result.failedGroups[0].error), /超范围/);
  assert.equal(result.importedGroups, 1, 'g_ok 不受 g_bad 拖累');
  assert.equal(result.insertedRows, 1);
});

// ── handler 收口:导入台账成功 → 组级结算章补盖(B5 删除守卫失明修复,审计 HIGH)──
const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');

test('importBatchLedger handler:成功导入的组补盖 settledAt(删除守卫据此保护台账证据)', async () => {
  const batch = {
    id: 'batch_x',
    monthlyWorkspaceKey: '2026-05',
    sourceGroups: [{ key: 'g1' }, { key: 'g2' }],
    tasks: [],
  };
  const saved = [];
  const handlers = createWorkbenchTaskHandlers({
    loadBatch: () => batch,
    assertBatchAccess: () => {},
    saveBatchAsync: async (b) => { saved.push(b.id); },
    withBatchWrite: (id, action) => action(),
    getWorkbenchBatchLedgerImportService: () => ({
      // g1 成功导入台账,g2 无小票被跳过 → 只 g1 该盖章
      importBatchToLedger: async () => ({ importedGroupKeys: ['g1'], importedGroups: 1, insertedRows: 3, skippedGroups: [{ groupKey: 'g2' }], failedGroups: [] }),
    }),
  });
  const res = { statusCode: 200, body: null, status(c){this.statusCode=c;return this;}, json(p){this.body=p;return this;} };
  await handlers.importBatchLedger({ params: { batchId: 'batch_x' }, user: { username: 'op' } }, res, (e) => { throw e; });

  assert.equal(res.statusCode, 200);
  const g1 = batch.sourceGroups.find((g) => g.key === 'g1');
  const g2 = batch.sourceGroups.find((g) => g.key === 'g2');
  assert.equal(g1.settlementStatus, 'settled', 'g1 导入台账 → 盖结算章');
  assert.ok(g1.settledAt, 'g1 有 settledAt(删除守卫据此 409 保护)');
  assert.ok(!g2.settledAt, 'g2 未导入 → 不盖章');
  assert.ok(saved.includes('batch_x'), '盖章后落盘');
});

// ── 0729 静默排查(结算链):部分撞键的组仍报"导入成功",被压掉的票零提示 ────────
// 整组都撞键 → 报 duplicate_receipts_in_batch(既有,可见);
// 组里**只有部分**票撞键 → 那张票被裸 continue 排除,组照样计入 importedGroups。
// 而这个撞键**不是良性去重,是数据错误的信号**:业务键与库里
// UNIQUE(workspace_key, row_hash) 同口径,row_hash = {工作区,店,票号,购买日}**不含客户**。
// 同店同日同票号只能对应一笔交易 → 两个客户组都有 = 票号读错 或 建档串了客户。
// 被压掉的那张不进台账 = 少一笔返点。
test('部分撞键:被压掉的票要进 suppressedReceipts,并说清与谁撞', async () => {
  const syncCalls = [];
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: {
      async syncApprovedGroup(args) {
        syncCalls.push(args);
        return { workspaceKey: args.workspaceKey, inserted: args.groupTasks.filter((t) => t.docTypeFinal === 'receipt').length, skipped: 0 };
      },
    },
  });

  const r = (id, groupKey, no) => ({
    id, sourceGroupKey: groupKey, docTypeFinal: 'receipt', reviewed: true,
    receiptNoFinal: no, receiptStoreFinal: 'LOTTE', purchaseDateFinal: '2026-05-01',
  });
  const batch = {
    id: 'batch_1',
    monthlyWorkspaceKey: '2026-05',
    tasks: [
      { id: 'pA', sourceGroupKey: 'gA', sourceGroupLabel: '王五', docTypeFinal: 'passport', reviewed: true },
      r('rA1', 'gA', '1111111111111'),
      { id: 'pB', sourceGroupKey: 'gB', sourceGroupLabel: '李四', docTypeFinal: 'passport', reviewed: true },
      r('rB1', 'gB', '1111111111111'), // 与 gA 撞:同店同日同票号
      r('rB2', 'gB', '2222222222222'), // 自己的票,正常入账
    ],
  };

  const result = await service.importBatchToLedger({ batch, operator: 'reviewer1' });

  // gB 仍然导入(它还有一张好票)——这正是此前"看起来一切正常"的原因
  assert.equal(result.importedGroups, 2);
  assert.ok(!result.skippedGroups.some((g) => g.groupKey === 'gB'), 'gB 不进整组跳过名单');
  // 但被压掉的那张必须报出来
  assert.equal(result.suppressedReceipts.length, 1);
  const s = result.suppressedReceipts[0];
  assert.equal(s.taskId, 'rB1');
  assert.equal(s.groupKey, 'gB');
  assert.equal(s.receiptKey, 'LOTTE|1111111111111|2026-05-01');
  assert.equal(s.conflictWithGroupKey, 'gA', '要说清和谁撞的,否则操作员得自己翻遍全批');
  // 真正入账的只有 3 张(gA 一张 + gB 的好票 + 各自护照不算),被压那张不在其中
  const importedReceiptIds = syncCalls.flatMap((c) => c.groupTasks.filter((t) => t.docTypeFinal === 'receipt').map((t) => t.id));
  assert.deepEqual(importedReceiptIds.sort(), ['rA1', 'rB2']);
});

test('无撞键时 suppressedReceipts 为空数组(不是 undefined,前端直接拿去 .length)', async () => {
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: { async syncApprovedGroup(a) { return { workspaceKey: a.workspaceKey, inserted: 1, skipped: 0 }; } },
  });
  const result = await service.importBatchToLedger({
    batch: {
      id: 'b', monthlyWorkspaceKey: '2026-05',
      tasks: [
        { id: 'p', sourceGroupKey: 'g', docTypeFinal: 'passport', reviewed: true },
        { id: 'r', sourceGroupKey: 'g', docTypeFinal: 'receipt', reviewed: true, receiptNoFinal: '9', receiptStoreFinal: 'LOTTE', purchaseDateFinal: '2026-05-01' },
      ],
    },
    operator: 'u',
  });
  assert.deepEqual(result.suppressedReceipts, []);
});
