'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 任务级模式单源 resolveTaskModeRule(2026-07-20 行为三合一)回归 ─────────────
// 病灶:"我审核了该模式但导出里没进去"——表外团号人工选模式后 status 仍 not_found,
// 人选只落 modeManualPick;交付分桶/DSL scope/切片选择器各自读 modeRawPre 快照,人选票
// 全部漏出。收口:resolveTaskModeRule=百货档案常量 > 人选 > 快照(无条件)> 机场推断,
// 分桶(台账优先层不动)/scope/{mode} token/台账桥票号形态全走它。

const { resolveTaskModeRule } = require('../lib/workbench_receipt_export');
const { resolveExportPlan } = require('../lib/export_plan_engine');
const { createModeDeliveryExportService } = require('../services/mode_delivery_export_service');
const { createWorkbenchLedgerBridgeService } = require('../services/workbench_ledger_bridge_service');

test('resolveTaskModeRule 优先级:百货常量 > 人选 > 快照;人选在 not_found 下也生效', () => {
  // 百货:店家档案常量,人选/快照都压不过
  const dept = resolveTaskModeRule({ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', modeManualPick: '乐天SG-本司', modeRawPre: '别的' });
  assert.equal(dept.mode, '乐天百货');
  // 表外人选(bug 病根现场):status not_found + modeManualPick
  const pick = resolveTaskModeRule({ docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE', groupNoFinal: '99999', groupNoMatchStatus: 'not_found', modeManualPick: '新世界PKG-宋总' });
  assert.equal(pick.mode, '新世界PKG-宋总', '表外人选必须进导出口径');
  // 人选 > 快照
  const both = resolveTaskModeRule({ docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE', modeManualPick: '新世界PKG-宋总', modeRawPre: '新世界SG-荣晨国际', groupNoMatchStatus: 'matched' });
  assert.equal(both.mode, '新世界PKG-宋总');
  // 快照无条件(存量老批次没有 groupNoMatchStatus 也不能打成未归类)
  const legacy = resolveTaskModeRule({ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司' });
  assert.equal(legacy.mode, '乐天SG-本司');
});

test('交付分桶:表外人选票(已审未结算,无台账行)进人选模式桶', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_pick_'));
  try {
    const mkImg = (rel) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); return rel; };
    const batch = { id: 'batch_pick', name: 'n', tasks: [
      { id: 'pp', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
        sourceOriginalPath: 'ws1/CL20260720-009/pp.jpg', sourceImagePath: mkImg('s/pp.jpg') },
      // 表外团号 99999 人选了模式:modeRawPre 空、status not_found → 此前落"未归类"
      { id: 'r1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE',
        modeRawPre: '', groupNoMatchStatus: 'not_found', modeManualPick: '新世界PKG-宋总',
        groupNoFinal: '99999', receiptNoFinal: '2926063010900126',
        sourceOriginalPath: 'ws1/CL20260720-009/r1.jpg', sourceImagePath: mkImg('s/r1.jpg') },
    ] };
    const svc = createModeDeliveryExportService({
      resolveBatchRelativePath: (_b, rel) => path.join(root, rel),
    });
    const plan = svc.planModeDelivery(batch);
    const dirs = plan.files.map((f) => f.dir);
    assert.ok(dirs.some((d) => d.startsWith('新世界PKG-宋总/')), `人选模式必须成桶,实际:${dirs.join(',')}`);
    assert.ok(!dirs.some((d) => d.startsWith('未归类/')), '不再落未归类');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSL scope(断点⑤):百货票按档案常量入 scope;人选票按人选入 scope', () => {
  const plan = {
    planLabel: '百货切片',
    scope: { modes: ['乐天百货'] },
    levels: [{ template: '{mode}' }],
    naming: { template: '{docLabel}{i}' },
    includes: ['receipt'],
    emptyPolicy: 'block_prefix',
  };
  const deptGroup = {
    customerId: 'CL-dept-1',
    tasks: [{ id: 'r1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', reviewed: true, sourcePath: 'b/r1.jpg' }],
  };
  const otherGroup = {
    customerId: 'CL-other-1',
    tasks: [{ id: 'r2', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', reviewed: true, sourcePath: 'b/r2.jpg' }],
  };
  const out = resolveExportPlan(plan, [deptGroup, otherGroup]);
  // 百货组此前 modeRawPre 恒空 → 永远出 scope(配置台绿灯运行时恒空);现在按档案常量命中
  assert.equal(out.entries.length, 1);
  assert.ok(out.entries[0].destPath.startsWith('乐天百货/'), '{mode} token 也要渲染出档案常量');
  assert.equal(out.skipped.filter((s) => s.reason === '模式不在计划范围').length, 1, '不相关模式仍出局');

  const pickPlan = { ...plan, scope: { modes: ['新世界PKG-宋总'] } };
  const pickGroup = {
    customerId: 'CL-pick-1',
    tasks: [{ id: 'r3', docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE', modeManualPick: '新世界PKG-宋总', groupNoMatchStatus: 'not_found', reviewed: true, sourcePath: 'b/r3.jpg' }],
  };
  const pickOut = resolveExportPlan(pickPlan, [pickGroup]);
  assert.equal(pickOut.entries.length, 1, '表外人选票要能被 scope 圈中');
});

test('台账桥票号形态:表外人选 dashed19 模式/表态无团号机场票 都按模式合同格式化', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany(rows) { insertedRows.push(...rows); return { inserted: rows.length, skipped: 0 }; } },
    workspaceService: { getOrThrow() {} },
  });
  const passport = { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'A B', passportNoFinal: 'EQ1234567' };

  // 表外人选 现代-JEOCU(dashed19):干净16位 → 2-6-3-5 补杠(与交付包/审核台导出同口径)
  await service.syncApprovedGroup({
    batchId: 'b1', workspaceKey: '2026-07', operator: 'r',
    groupTasks: [passport, {
      id: 'r1', docTypeFinal: 'receipt', sourceGroupKey: 'g1', receiptStoreFinal: 'HYUNDAI',
      receiptNoFinal: '2926063010900126', groupNoFinal: '88888', groupNoMatchStatus: 'not_found',
      modeManualPick: '现代-JEOCU', purchaseDateFinal: '2026-07-01',
    }],
  });
  assert.equal(insertedRows[0].receiptNo, '29-260630-109-00126', '人选模式此前跌到兜底原样,与出口分家');

  // 表态无团号的机场票(写入层已回填「无」;此处模拟存量空值行)→ 机场模式 dashed19
  await service.syncApprovedGroup({
    batchId: 'b2', workspaceKey: '2026-07', operator: 'r',
    groupTasks: [passport, {
      id: 'r2', docTypeFinal: 'receipt', sourceGroupKey: 'g2', receiptStoreFinal: 'SHINSEGAE',
      receiptNoFinal: '1726063010900126', groupNoFinal: '', tourStance: 'none',
      purchaseDateFinal: '2026-07-01',
    }],
  });
  assert.equal(insertedRows[1].receiptNo, '17-260630-109-00126', '机场表态票按新世界机场-振华 dashed19 出');

  // ⭐去重哈希与存量兼容(pick/airport=2026-07-20 新进格式化路径的类别):同一张票
  // "无人选"(修改前形态:兜底存原样,哈希=数字投影)与"有人选"(格式化存带杠)
  // 的 rowHash 必须一致——存量行重结算走 UNIQUE(workspace_key,row_hash) 才能去重不翻倍。
  await service.syncApprovedGroup({
    batchId: 'b3', workspaceKey: '2026-07', operator: 'r',
    groupTasks: [passport, {
      id: 'r3', docTypeFinal: 'receipt', sourceGroupKey: 'g1', receiptStoreFinal: 'HYUNDAI',
      receiptNoFinal: '2926063010900126', groupNoFinal: '88888', groupNoMatchStatus: 'not_found',
      purchaseDateFinal: '2026-07-01',
    }],
  });
  assert.equal(insertedRows[2].receiptNo, '2926063010900126', '无人选=兜底原样(修改前存量形态)');
  assert.equal(insertedRows[0].rowHash, insertedRows[2].rowHash,
    '人选格式化行与存量兜底行 rowHash 必须一致(数字投影),否则重结算产重复台账行');
});
