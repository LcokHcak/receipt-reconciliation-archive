const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchNormalizers } = require('../lib/workbench_normalizers');

test('normalizeBatch preserves monthly ledger import metadata', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();

  const normalized = normalizeBatch({
    id: 'batch_demo',
    name: 'Demo batch',
    scenario: 'FullProcess',
    monthlyWorkspaceKey: 'demo-2026-01',
    groupCodeImport: {
      scope: 'batch',
      sourceWorkspaceKey: 'demo-2026-01',
      sourceFile: 'group-code.xlsx',
      rowsTotal: 3,
    },
    tasks: [],
  });

  assert.equal(normalized.monthlyWorkspaceKey, 'demo-2026-01');
  assert.deepEqual(normalized.groupCodeImport, {
    scope: 'batch',
    sourceWorkspaceKey: 'demo-2026-01',
    sourceFile: 'group-code.xlsx',
    rowsTotal: 3,
  });
});

test('normalizeBatch preserves owner metadata (多账号隔离,漏则operator看不到自己批次)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();

  const normalized = normalizeBatch({
    id: 'batch_owned',
    name: 'Owned batch',
    scenario: 'FullProcess',
    ownerUserId: 15,
    ownerUsername: '小票13',
    createdBy: '小票13',
    tasks: [
      {
        id: 'task_1',
        sourceOriginalPath: '260701-小票13/CL20260701-001/passport.jpg',
        customerOwnerUserId: 15,
        customerOwnerUsername: '小票13',
        customerAgentName: '西雅国际',
      },
    ],
  });

  assert.equal(normalized.ownerUserId, 15);
  assert.equal(normalized.ownerUsername, '小票13');
  assert.equal(normalized.createdBy, '小票13');
  assert.equal(normalized.tasks[0].customerOwnerUserId, 15);
  assert.equal(normalized.tasks[0].customerOwnerUsername, '小票13');
  // 代理名与 owner 同病理:白名单漏了=存盘即抹(2026-07-09 生产实锤全空)。
  assert.equal(normalized.tasks[0].customerAgentName, '西雅国际');
});

test('normalizeBatch preserves export stamp (导出留痕P1,漏则首页导出状态存盘即抹)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();

  const normalized = normalizeBatch({
    id: 'batch_exported',
    name: 'Exported batch',
    scenario: 'FullProcess',
    exportedAt: '2026-07-18T09:00:00.000Z',
    exportedBy: 'admin',
    exportKind: 'mode',
    tasks: [],
  });

  assert.equal(normalized.exportedAt, '2026-07-18T09:00:00.000Z');
  assert.equal(normalized.exportedBy, 'admin');
  assert.equal(normalized.exportKind, 'mode');

  // 没盖过章的批次:三字段稳定为空值形态,不 undefined(消费方免判空)
  const untouched = normalizeBatch({ id: 'b2', tasks: [] });
  assert.equal(untouched.exportedAt, '');
  assert.equal(untouched.exportedBy, null);
  assert.equal(untouched.exportKind, '');
});

test('normalizeTask 保留票级表态字段(tourStance/sActivityFlag/modeManualPick,漏则存盘即抹)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const once = normalizeBatch({
    id: 'batch_stance',
    name: 'stance batch',
    scenario: 'FullProcess',
    tasks: [{
      id: 'task_1',
      tourStance: 'none',
      tourStancedAt: '2026-07-10T12:00:00.000Z',
      tourStancedBy: '后勤09',
      sActivityFlag: true,
      modeManualPick: '新世界SG-振华 不用记',
    }],
  });
  const twice = normalizeBatch(once);
  assert.equal(twice.tasks[0].tourStance, 'none');
  assert.equal(twice.tasks[0].tourStancedAt, '2026-07-10T12:00:00.000Z');
  assert.equal(twice.tasks[0].tourStancedBy, '后勤09');
  assert.equal(twice.tasks[0].sActivityFlag, true);
  assert.equal(twice.tasks[0].modeManualPick, '新世界SG-振华 不用记');
  // 缺省态:未表态=空串/false(锁定判定依赖缺省语义)
  const fresh = normalizeBatch({ id: 'b2', name: 'b2', scenario: 'FullProcess', tasks: [{ id: 't2' }] });
  assert.equal(fresh.tasks[0].tourStance, '');
  assert.equal(fresh.tasks[0].sActivityFlag, false);
});

test('normalizeTask 二次归一不丢 customerAgentName(round-trip)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const once = normalizeBatch({
    id: 'batch_agent',
    name: 'agent batch',
    scenario: 'FullProcess',
    tasks: [{ id: 'task_1', customerAgentName: '天马国旅' }],
  });
  const twice = normalizeBatch(once);
  assert.equal(twice.tasks[0].customerAgentName, '天马国旅');
});

test('normalizeTask 保留团号预匹配字段(modeRawPre/groupNoMatchStatus/groupNoMatchedAt)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const normalized = normalizeBatch({
    id: 'batch_pre',
    name: 'Pre',
    tasks: [{
      id: 'task_1',
      modeRawPre: '乐天SG-本司',
      groupNoMatchStatus: 'matched',
      groupNoMatchedAt: '2026-07-02T10:00:00.000Z',
      groupNoSuggestion: '26141846',
    }],
  });
  assert.equal(normalized.tasks[0].modeRawPre, '乐天SG-本司');
  assert.equal(normalized.tasks[0].groupNoMatchStatus, 'matched');
  assert.equal(normalized.tasks[0].groupNoMatchedAt, '2026-07-02T10:00:00.000Z');
  assert.equal(normalized.tasks[0].groupNoSuggestion, '26141846', '近似纠错建议要过白名单(铁律)');
  // 店不符提示串(store_mismatch 徽章用)同属预匹配落盘字段,漏白名单=存盘即抹
  const mismatch = normalizeBatch({
    id: 'batch_mm', name: 'MM',
    tasks: [{ id: 't1', groupNoMatchStatus: 'store_mismatch', modeStoreMismatch: '新世界SG-振华 不用记 / 现代-JEOCU' }],
  });
  assert.equal(mismatch.tasks[0].modeStoreMismatch, '新世界SG-振华 不用记 / 现代-JEOCU', 'modeStoreMismatch 要过白名单(铁律)');
  // 缺省为空串(旧任务向后兼容)
  const legacy = normalizeBatch({ id: 'b', name: 'L', tasks: [{ id: 't' }] });
  assert.equal(legacy.tasks[0].modeRawPre, '');
  assert.equal(legacy.tasks[0].groupNoMatchStatus, '');
  assert.equal(legacy.tasks[0].modeStoreMismatch, '');
});

test('normalizeTask 保留 receiptNoRawAuto(OCR 原串留底,导出层还原格式用)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const normalized = normalizeBatch({
    id: 'batch_raw',
    name: 'Raw',
    tasks: [{ id: 'task_1', receiptNoRawAuto: '123-4567-89S' }],
  });
  assert.equal(normalized.tasks[0].receiptNoRawAuto, '123-4567-89S');
  const legacy = normalizeBatch({ id: 'b', name: 'L', tasks: [{ id: 't' }] });
  assert.equal(legacy.tasks[0].receiptNoRawAuto, '');
});

test('normalizeTask 保留百货真字段(金额Final/门店/品牌/上家,漏则存盘即抹)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const normalized = normalizeBatch({
    id: 'batch_dept',
    name: 'Dept',
    tasks: [{
      id: 'task_1',
      receiptAmountFinal: '3500000',
      branchAuto: '明洞',
      branchFinal: '蚕室',
      brandAuto: '루이비통',
      brandFinal: '티파니',
      upstreamAuto: '梁总',
      upstreamFinal: '梁总',
    }],
  });
  const t = normalized.tasks[0];
  assert.equal(t.receiptAmountFinal, '3500000');
  assert.equal(t.branchAuto, '明洞');
  assert.equal(t.branchFinal, '蚕室');
  assert.equal(t.brandAuto, '루이비통');
  assert.equal(t.brandFinal, '티파니');
  assert.equal(t.upstreamAuto, '梁总');
  assert.equal(t.upstreamFinal, '梁总');
  // 缺省为空串(免税店任务/旧任务向后兼容)
  const legacy = normalizeBatch({ id: 'b', name: 'L', tasks: [{ id: 't' }] });
  assert.equal(legacy.tasks[0].receiptAmountFinal, '');
  assert.equal(legacy.tasks[0].branchFinal, '');
  assert.equal(legacy.tasks[0].brandFinal, '');
  assert.equal(legacy.tasks[0].upstreamFinal, '');
});

test('normalizeBatch owner 缺省为 null(旧批次向后兼容)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const normalized = normalizeBatch({ id: 'batch_legacy', name: 'Legacy', tasks: [] });
  assert.equal(normalized.ownerUserId, null);
  assert.equal(normalized.ownerUsername, null);
  assert.equal(normalized.createdBy, null);
});

test('normalizeBatch 保留已删路径墓碑 deletedSourcePaths(缺省空数组)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const normalized = normalizeBatch({
    id: 'batch_tomb', name: 'T', tasks: [],
    deletedSourcePaths: ['ws/CL-001/01-dup-passport.jpg'],
  });
  assert.deepEqual(normalized.deletedSourcePaths, ['ws/CL-001/01-dup-passport.jpg']);
  const legacy = normalizeBatch({ id: 'b', name: 'L', tasks: [] });
  assert.deepEqual(legacy.deletedSourcePaths, []);
});

test('normalizeTask 保留 tourConfirmedAt(确认站任务级回执,漏则存盘即抹)', () => {
  const { normalizeBatch } = createWorkbenchNormalizers();
  const once = normalizeBatch({
    id: 'batch_tc',
    name: 'tc',
    scenario: 'FullProcess',
    tasks: [{ id: 'task_1', tourConfirmedAt: '2026-07-10T02:00:00.000Z' }],
  });
  assert.equal(once.tasks[0].tourConfirmedAt, '2026-07-10T02:00:00.000Z');
  assert.equal(normalizeBatch(once).tasks[0].tourConfirmedAt, '2026-07-10T02:00:00.000Z');
});
