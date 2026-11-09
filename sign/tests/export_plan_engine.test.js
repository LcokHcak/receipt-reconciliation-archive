'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateExportPlan, resolveExportPlan } = require('../lib/export_plan_engine');

const BASE_PLAN = Object.freeze({
  planLabel: '按团号整理示例',
  scope: { modes: [] },
  levels: [{ template: '{groupNo}' }, { template: '{name}{passportNo:0,4}' }],
  naming: { template: '{docLabel}{i}' },
  includes: ['receipt', 'passport'],
  emptyPolicy: 'block_prefix',
});

function makeGroup(over = {}) {
  return {
    customerId: 'CL20260714-001',
    label: '梁总',
    tasks: [
      { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EA1234567', reviewed: true, sourcePath: 'b/p1.jpg' },
      { id: 'r1', docTypeFinal: 'receipt', groupNoFinal: '26140001', modeRawPre: '乐天SG-本司', reviewed: true, sourcePath: 'b/r1.jpg' },
      { id: 'r2', docTypeFinal: 'receipt', groupNoFinal: '26140001', modeRawPre: '乐天SG-本司', reviewed: true, sourcePath: 'b/r2.png' },
    ],
    ...over,
  };
}

test('validateExportPlan:builtin 放行;未知 token/层数/includes/emptyPolicy 一票否决', () => {
  assert.equal(validateExportPlan({ builtin: 'mode_delivery' }).kind, 'builtin');
  assert.equal(validateExportPlan({ builtin: '野路子' }).ok, false);
  assert.equal(validateExportPlan(BASE_PLAN).ok, true);
  assert.equal(validateExportPlan({ ...BASE_PLAN, levels: [] }).ok, false);
  assert.equal(validateExportPlan({ ...BASE_PLAN, levels: [{ template: '{nonexistentField}' }] }).ok, false);
  assert.equal(validateExportPlan({ ...BASE_PLAN, includes: ['receipt', 'video'] }).ok, false);
  assert.equal(validateExportPlan({ ...BASE_PLAN, emptyPolicy: 'yolo' }).ok, false);
});

test('resolveExportPlan:分层+切片+件类序号+扩展名保留;组级 token 从组内借值', () => {
  const { entries, blocked, stats } = resolveExportPlan(BASE_PLAN, [makeGroup()]);
  assert.equal(blocked.length, 0);
  assert.equal(stats.entries, 3);
  const paths = entries.map((e) => e.destPath).sort();
  // 护照任务自己没团号 → groupNo 从组内小票借值(组级 token 兜底)
  assert.deepEqual(paths, [
    '26140001/ZHANG SANEA12/护照1.jpg',
    '26140001/ZHANG SANEA12/小票1.jpg',
    '26140001/ZHANG SANEA12/小票2.png',
  ].sort());
});

test('任务图缺失(sourcePath 空=图被清理/盘故障)→ 计入 missingSource,不再静默少图(审计MEDIUM)', () => {
  const group = makeGroup();
  group.tasks[2].sourcePath = ''; // r2 的图解析失败
  const { entries, missingSource, stats } = resolveExportPlan(BASE_PLAN, [group]);
  // 只出 2 张(p1+r1);r2 缺图不静默 continue,而是进 missingSource(出包前可见)
  assert.equal(entries.length, 2, '缺图任务不产出条目');
  assert.equal(missingSource.length, 1);
  assert.equal(missingSource[0].taskId, 'r2');
  assert.equal(missingSource[0].docType, 'receipt');
  assert.equal(stats.missingSource, 1, 'stats 同款计数');
  assert.match(missingSource[0].reason, /缺失|解析失败/);
});

test('emptyPolicy=block_prefix(拍板默认):缺字段进 blocked 带建议前缀;skip_log 则跳过留痕', () => {
  const group = makeGroup();
  group.tasks[1].groupNoFinal = '';
  group.tasks[2].groupNoFinal = '';
  group.tasks = group.tasks.slice(0, 2); // p1+r1,r1 无团号 → 组级也借不到
  const blockedRun = resolveExportPlan(BASE_PLAN, [group]);
  assert.equal(blockedRun.entries.length, 0);
  assert.ok(blockedRun.blocked.length >= 1);
  assert.match(blockedRun.blocked[0].reason, /groupNo/);
  assert.match(blockedRun.blocked[0].suggested, /^缺groupNo_/);

  const skipRun = resolveExportPlan({ ...BASE_PLAN, emptyPolicy: 'skip_log' }, [group]);
  assert.equal(skipRun.blocked.length, 0);
  assert.ok(skipRun.skipped.some((s) => /groupNo/.test(s.reason)));
});

test('范围/未审/重名/超长:scope 外跳过;整组未审跳过;重名 _2;>240 拦', () => {
  const outOfScope = resolveExportPlan(
    { ...BASE_PLAN, scope: { modes: ['现代-JEOCU'] } },
    [makeGroup()],
  );
  assert.equal(outOfScope.entries.length, 0);
  assert.equal(outOfScope.skipped[0].reason, '模式不在计划范围');

  const unreviewed = makeGroup();
  unreviewed.tasks[1].reviewed = false;
  assert.equal(resolveExportPlan(BASE_PLAN, [unreviewed]).skipped[0].reason, '整组未审核完');

  // 重名:两张小票命名模板不带 {i} → 第二张自动 _2
  const dupPlan = { ...BASE_PLAN, naming: { template: '{name}' } };
  const dup = resolveExportPlan(dupPlan, [makeGroup()]);
  const dupPaths = dup.entries.map((e) => e.destPath);
  assert.ok(dupPaths.some((p) => p.endsWith('/ZHANG SAN.jpg')));
  assert.ok(dupPaths.some((p) => p.endsWith('/ZHANG SAN_2.png') || p.endsWith('/ZHANG SAN_2.jpg')));

  // 超长:单段被 sanitize 截到 80,要 3 层+命名(4×80+斜杠≈323>240)才触发 Windows 护栏
  const seg = 'x'.repeat(80);
  const longPlan = { ...BASE_PLAN, levels: [{ template: seg }, { template: seg }, { template: seg }], naming: { template: seg } };
  assert.equal(validateExportPlan(longPlan).ok, true); // 纯字面量合法
  const long = resolveExportPlan(longPlan, [makeGroup()]);
  assert.equal(long.entries.length, 0);
  assert.ok(long.blocked.length >= 1);
  assert.ok(long.blocked.every((b) => /路径过长/.test(b.reason)));
});

test('builtin 计划不进引擎(由老 planner 处理,防第二真相源)', () => {
  assert.throws(() => resolveExportPlan({ builtin: 'mode_delivery' }, []), /builtin/);
});

test('P3b 撞名计数:不同客户落同一路径 → collisions 单列示警(同客户重名只 _2 不告警)', () => {
  const dupPlan = { ...BASE_PLAN, levels: [{ template: '固定夹' }], naming: { template: '{groupNo}' } };
  const groupA = makeGroup();
  const groupB = makeGroup({ customerId: 'CL20260714-002' });
  groupB.tasks = groupB.tasks.map((t) => ({ ...t, id: `${t.id}b` }));
  const out = resolveExportPlan(dupPlan, [groupA, groupB]);
  assert.ok(out.collisions.length >= 1, '跨客户撞名应示警');
  assert.ok(out.collisions[0].customers.includes('CL20260714-001'));
  assert.ok(out.collisions[0].customers.includes('CL20260714-002'));
  // 同客户内部重名(同名模板两张小票)不算撞名
  const sameCustomer = resolveExportPlan({ ...BASE_PLAN, naming: { template: '{name}' } }, [makeGroup()]);
  assert.equal(sameCustomer.collisions.length, 0);
});

test('P3b Excel 变体:列词汇校验;与 levels 互斥;kind=excel', () => {
  assert.equal(validateExportPlan({ planLabel: 'x', excel: { columns: ['stmt_date', 'brand'] } }).kind, 'excel');
  assert.equal(validateExportPlan({ planLabel: 'x', excel: { columns: [] } }).ok, false);
  assert.equal(validateExportPlan({ planLabel: 'x', excel: { columns: ['野列'] } }).ok, false);
  assert.equal(validateExportPlan({ planLabel: 'x', excel: { columns: ['brand'] }, levels: [{ template: 'a' }] }).ok, false);
});

test('P3b buildCustomerGroups:按客户库ID分组;无ID任务各自成组(复核HIGH单源化)', () => {
  const { buildCustomerGroups } = require('../lib/export_plan_engine');
  const batch = {
    id: 'b1',
    tasks: [
      { id: 't1', sourceFolderName: 'CL20260714-001', sourceImagePath: 'a.jpg' },
      { id: 't2', sourceFolderName: 'CL20260714-001', sourceImagePath: 'b.jpg' },
      { id: 't3', sourceFolderName: 'CL20260714-002', sourceImagePath: 'c.jpg' },
      { id: 't4', sourceImagePath: 'd.jpg' }, // 人工补录无客户ID
    ],
  };
  const groups = buildCustomerGroups(batch, () => '/abs/x.jpg');
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.tasks.length).sort(), [1, 1, 2]);
  assert.ok(groups.every((g) => g.tasks.every((t) => t.sourcePath === '/abs/x.jpg')));
});

// A4(2026-07-16 同步一致性审计):scope 匹配双方归一到正名——带尾巴/别名写法的票不再静默漏出 scope
const test_a4 = require('node:test');
const assert_a4 = require('node:assert/strict');
const { resolveExportPlan: resolveA4 } = require('../lib/export_plan_engine');

test_a4('scope 归一:带尾巴的 modeRawPre 命中正名 scope;不相关模式仍出局', () => {
  const plan = {
    planLabel: 'A4',
    scope: { modes: ['乐天SG-本司'] }, // 配置台存的正名
    levels: [{ template: '{groupNo}' }],
    naming: { template: '{name}_{docLabel}{i}' },
    includes: ['receipt'],
    emptyPolicy: 'block_prefix',
  };
  const groups = [
    { customerId: 'CL20260716-001', tasks: [{ id: 't1', reviewed: true, docTypeFinal: 'receipt', modeRawPre: '乐天SG-本司（发小票17）', groupNoFinal: '26141846', extractedNameFinal: 'A', sourcePath: '/tmp/a.jpg' }] },
    { customerId: 'CL20260716-002', tasks: [{ id: 't2', reviewed: true, docTypeFinal: 'receipt', modeRawPre: '新罗V团-本司', groupNoFinal: '71990', extractedNameFinal: 'B', sourcePath: '/tmp/b.jpg' }] },
  ];
  const out = resolveA4(plan, groups);
  assert_a4.equal(out.entries.length, 1, '带尾巴票必须命中正名 scope(此前裸串比对漏出)');
  assert_a4.ok(out.entries[0].srcPath.includes('a.jpg'));
  assert_a4.equal(out.skipped.length, 1, '不相关模式照旧出局');
  assert_a4.equal(out.skipped[0].customerId, 'CL20260716-002');
});

// L117(2026-07-23 拍板「只放本渠道的票」):混模式客户按某渠道出上家包时,范围外模式的**小票**不进包;
// 护照/other 无渠道模式不参与过滤仍收;scope.modes 为空=不筛(维持现状)。
test('L117 混模式包:scope 指定渠道时,范围外模式小票被剔除,护照仍收', () => {
  const mixed = makeGroup({
    tasks: [
      { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EA1234567', reviewed: true, sourcePath: 'b/p1.jpg' },
      { id: 'r1', docTypeFinal: 'receipt', groupNoFinal: '26140001', modeRawPre: '乐天SG-本司', reviewed: true, sourcePath: 'b/r1.jpg' }, // 本渠道
      { id: 'rx', docTypeFinal: 'receipt', groupNoFinal: '26907001', modeRawPre: '新罗PKG-宋总', reviewed: true, sourcePath: 'b/rx.jpg' }, // 范围外渠道
    ],
  });
  const { entries, skipped } = resolveExportPlan({ ...BASE_PLAN, scope: { modes: ['乐天SG-本司'] } }, [mixed]);
  const ids = entries.map((e) => e.taskId).sort();
  assert.deepEqual(ids, ['p1', 'r1'], '只出本渠道小票 r1 + 护照 p1;范围外 rx 不出包');
  assert.ok(
    skipped.some((s) => s.taskId === 'rx' && s.reason === '票级模式不在计划范围'),
    '范围外模式小票记 skipped 可追溯',
  );
  assert.ok(!skipped.some((s) => s.taskId === 'p1'), '护照不被模式过滤剔除');
});

test('L117 非回归:scope.modes 为空 → 不按模式筛,混模式小票全收(维持现状)', () => {
  const mixed = makeGroup({
    tasks: [
      { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EA1234567', reviewed: true, sourcePath: 'b/p1.jpg' },
      { id: 'r1', docTypeFinal: 'receipt', groupNoFinal: '26140001', modeRawPre: '乐天SG-本司', reviewed: true, sourcePath: 'b/r1.jpg' },
      { id: 'rx', docTypeFinal: 'receipt', groupNoFinal: '26907001', modeRawPre: '新罗PKG-宋总', reviewed: true, sourcePath: 'b/rx.jpg' },
    ],
  });
  const { entries } = resolveExportPlan({ ...BASE_PLAN, scope: { modes: [] } }, [mixed]);
  const ids = entries.map((e) => e.taskId).sort();
  assert.deepEqual(ids, ['p1', 'r1', 'rx'], 'scope 为空时两个渠道小票都收 + 护照(无筛,不误伤)');
});
