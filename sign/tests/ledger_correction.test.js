'use strict';

// 台账侧订正 + 隐藏不用记行 + 今日审核批次(2026-07-21 交付修改三件套)。

const test = require('node:test');
const assert = require('node:assert/strict');

const { stampGroupSettlement, clearGroupSettlement } = require('../lib/source_group_utils');
const { createWorkbenchApproveSettleService } = require('../services/workbench_approve_settle_service');
const { buildReceiptExportRows } = require('../lib/workbench_receipt_export');

// ── clearGroupSettlement:清章必须真清(stamp 的空值会被 ||new Date() 顶回) ──
test('clearGroupSettlement: 清结算章+订正留痕推进历史;stamp 清不掉是它存在的理由', () => {
  const batch = { id: 'b1', sourceGroups: [{ key: 'g1' }] };
  stampGroupSettlement(batch, 'g1', { settlementStatus: 'settled' });
  assert.ok(batch.sourceGroups[0].settledAt, '盖章后有 settledAt');
  // 反证:用 stamp 传空清不掉(会被 || new Date() 顶回)
  stampGroupSettlement(batch, 'g1', { settlementStatus: '', settledAt: '' });
  assert.ok(batch.sourceGroups[0].settledAt, 'stamp 空值清不掉章(设计如此)');
  // clearGroupSettlement 真清 + 留痕
  assert.equal(clearGroupSettlement(batch, 'g1', { by: 'admin', reason: '团号填错', removedRows: 3 }), true);
  assert.equal(batch.sourceGroups[0].settledAt, '');
  assert.equal(batch.sourceGroups[0].settlementStatus, '');
  assert.equal(batch.sourceGroups[0].ledgerCorrections.length, 1);
  assert.equal(batch.sourceGroups[0].ledgerCorrections[0].reason, '团号填错');
  assert.ok(batch.sourceGroups[0].ledgerCorrections[0].at, '订正时间自动盖');
  // 二次订正推进历史不覆盖
  stampGroupSettlement(batch, 'g1', { settlementStatus: 'settled' });
  clearGroupSettlement(batch, 'g1', { by: 'admin', reason: '再次订正', removedRows: 1 });
  assert.equal(batch.sourceGroups[0].ledgerCorrections.length, 2);
  // 组不存在 → false
  assert.equal(clearGroupSettlement(batch, 'nope', { reason: 'x' }), false);
});

// ── no_receipts 不锁组(8模块审计 MEDIUM:纯护照/0小票组结算盖 settledAt→删/订正双闸卡死)──
test('stampGroupSettlement: settlementStatus=no_receipts 记状态但不盖 settledAt(组可删可订正)', () => {
  const batch = { id: 'b1', sourceGroups: [{ key: 'g1' }] };
  // 纯护照0小票组结算:deriveSettlementStatus([])='no_receipts'
  assert.equal(stampGroupSettlement(batch, 'g1', { settlementStatus: 'no_receipts' }), true);
  const g = batch.sourceGroups[0];
  assert.equal(g.settlementStatus, 'no_receipts', '状态记下供UI显示');
  assert.equal(g.settledAt, '', 'no_receipts 绝不盖 settledAt——否则删除守卫锁死+订正零行拒绝=永久卡死');
  // 删除守卫口径 (settledAt || settlementStatus==='settled'):no_receipts 组不被锁
  const blockedBySettleGuard = Boolean(g.settledAt) || String(g.settlementStatus || '') === 'settled';
  assert.equal(blockedBySettleGuard, false, 'no_receipts 组可正常删票/删组/删批次');
  // 对照:真结算(settled)照旧盖 settledAt
  stampGroupSettlement(batch, 'g1', { settlementStatus: 'settled' });
  assert.ok(batch.sourceGroups[0].settledAt, 'settled 状态照常盖章');
});

// ── correctGroupLedger 服务:删行级联+快照;原因必填;无行报可读错 ──
function makeService(rows) {
  const deleted = [];
  const repo = {
    listBySourceGroup: ({ workspaceKey }) => rows.filter((r) => r.workspaceKey === workspaceKey),
    listWorkspaceKeysForSourceGroup: () => [...new Set(rows.map((r) => r.workspaceKey))],
    deleteMany: ({ workspaceKey, ids }) => { deleted.push({ workspaceKey, ids }); return ids.length; },
  };
  const service = createWorkbenchApproveSettleService({
    groupApprovalService: { approveGroup: async () => ({}) },
    ledgerBridgeService: { syncApprovedGroup: async () => ({}) },
    tourMatchService: { run: async () => ({}) },
    dailyReceiptRepo: repo,
    logger: { warn: () => {} },
  });
  const dirtied = [];
  service.setDerivationRecomputeService({ markDirty: (ws, kind) => dirtied.push({ ws, kind }) });
  return { service, deleted, dirtied };
}

test('correctGroupLedger: 跨workspace删行+完整快照;原因必填;无台账行报 NO_ROWS', () => {
  const rows = [
    { workspaceKey: '2026-07', id: 11, receiptNo: '90102826000682', shop: 'LOTTE', purchaseDate: '2026-07-02', tourNo: '26149661' },
    { workspaceKey: '2026-07', id: 12, receiptNo: '90102826000683', shop: 'LOTTE', purchaseDate: '2026-07-02', tourNo: '26149661' },
    { workspaceKey: '2026-08', id: 3, receiptNo: '90102826000999', shop: 'LOTTE', purchaseDate: '2026-08-01', tourNo: '26149661' },
  ];
  const { service, deleted, dirtied } = makeService(rows);
  const batch = { id: 'b1' };
  // 原因必填
  assert.throws(() => service.correctGroupLedger({ batch, groupKey: 'g1', reason: '  ' }),
    (e) => e.code === 'LEDGER_CORRECTION_REASON_REQUIRED');
  // 正常订正:跨月两个 workspace 都删,快照齐全
  const out = service.correctGroupLedger({ batch, groupKey: 'g1', reason: '识别错要重录' });
  assert.equal(out.removedRows, 3);
  assert.deepEqual(out.workspaces.sort(), ['2026-07', '2026-08']);
  assert.equal(out.snapshot.length, 3);
  assert.ok(out.snapshot.every((s) => s.receiptNo && s.workspaceKey), '快照带票号+workspace(审计证据)');
  assert.deepEqual(deleted.map((d) => d.ids), [[11, 12], [3]]);
  // 删行后每个受影响月标脏 bill_match(A3铁律:行删了→配对账单回未收池+月度刷新;
  // 用 bill_match 不用更浅的 tour_match,免得无谓重跑碰人工背书锁行)
  assert.deepEqual(dirtied, [
    { ws: '2026-07', kind: 'bill_match' },
    { ws: '2026-08', kind: 'bill_match' },
  ]);
  // 无台账行(未结算/已订正过)→ 可读错误
  const empty = makeService([]);
  assert.throws(() => empty.service.correctGroupLedger({ batch, groupKey: 'g1', reason: 'x' }),
    (e) => e.code === 'LEDGER_CORRECTION_NO_ROWS');
});

// ── 不用记行:整行剔除(2026-07-24 拍板,逆转 07-21 保留标注);_noRecord 临时键不泄漏 ──
test('buildReceiptExportRows: 不用记行整行剔除,正常行保留、临时键不泄漏', () => {
  const mkTask = (id, mode) => ({
    id, docTypeFinal: 'receipt', processResult: 'approved', reviewed: true,
    sourceGroupKey: `g_${id}`, receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '90102826000682', purchaseDateFinal: '2026-07-02',
    groupNoFinal: '26149661', modeRawPre: mode,
  });
  const tasks = [mkTask('t1', '乐天SG-本司'), mkTask('t2', '乐天SG-本司 不用记')];
  const rows = buildReceiptExportRows(tasks, {});
  assert.equal(rows.length, 1, '不用记那张整行不进表,只剩正常那张');
  assert.ok(!rows.some((r) => String(r.note || '').includes('不用记')), '导出里不再出现不用记标注行');
  assert.ok(!('_noRecord' in rows[0]), '临时键不泄漏进导出行');
});

// ── 今日审核批次统计卡(前端纯函数镜像:kind → 字段映射) ──
test('agentWorkspaceDisplay: todayBatches 卡从 todayReviewedBatches 取数', async () => {
  const { buildStatCards } = await import('../frontend/src/lib/agentWorkspaceDisplay.js');
  const summary = {
    visibleAll: { totalCustomers: 10, byStatus: { passed: 4 }, todayCount: 3, todayReviewedBatches: 2 },
    selectedAgent: null,
  };
  const cards = buildStatCards(summary);
  const card = cards.find((c) => c.key === 'todayBatches');
  assert.ok(card, '今日已审卡存在');
  assert.equal(card.label, '今日已审'); // 2026-07-24 改版更名
  assert.equal(card.allCount, 2);
});
