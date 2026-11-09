'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExportPlanNotes } = require('../services/export_plan_execute_service');
const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');

// ── A5 配置台自定义 DSL 计划 ───────────────────────────────────────────────
// 反常之处:整单失败(422)时 skipped/copyFailed 会随响应回给前端,而"部分跳过、
// 但 zip 照常生成"这个**真正需要提醒**的情形,响应是 res.download 流二进制,塞不进字段。
// 操作员拿到一个看起来正常的 zip,里面少了几个客户组,零提示。

test('自定义计划说明:按原因分组,不是把客户号糊成一堆', () => {
  assert.equal(buildExportPlanNotes({}), null, '干净包不塞噪音');

  const text = buildExportPlanNotes({
    skipped: [
      { customerId: 'CL-001', reason: '整组未审核完' },
      { customerId: 'CL-002', reason: '整组未审核完' },
      { customerId: 'CL-003', reason: '模式不在计划范围' },
    ],
    copyFailed: ['东方/王五/1622-0011.jpg(EACCES)'],
  }).join('\n');
  assert.match(text, /【没进包的客户组】共 3 个/);
  assert.match(text, /· 整组未审核完 —— 2 个/, '按原因聚合,一眼看出该做什么');
  assert.match(text, /· 模式不在计划范围 —— 1 个/);
  // 两种原因的处置完全不同,必须分别说
  assert.match(text, /「整组未审核完」= 审完后重新导出即可收进来/);
  assert.match(text, /「模式不在计划范围」= 计划本身没圈到这些模式/);
  assert.match(text, /【文件缺失】1 个文件/);
});

test('自定义计划说明:没原因的条目也不能吞(报「未说明原因」)', () => {
  const text = buildExportPlanNotes({ skipped: [{ customerId: 'CL-009' }] }).join('\n');
  assert.match(text, /未说明原因 —— 1 个/);
  assert.match(text, /CL-009/);
});

// ── B2 重拍名单:批次读不出来时静默少人 ─────────────────────────────────
// 「重拍名单少了人」= 少通知一个客户 = 少收一张票 = 少一笔返点。
// 原来是 catch{}continue,运营看到的名单是"完整"的,只有有人去查某个客户
// 为什么消失了才会发现。

function makeDb() {
  // listRephotoGroups 只用 batchRepository,不碰 db;给个最小桩即可
  return { prepare: () => ({ all: () => [], get: () => ({}) }) };
}

test('重拍名单:批次读不出来要报出来,且不影响其余批次照常出', () => {
  const good = {
    id: 'batch_ok',
    name: '好批次',
    tasks: [{ sourceGroupKey: 'G1', rephotoRequested: true, customerAgentName: '张代理' }],
  };
  const svc = createLibraryModeExportService({
    db: makeDb(),
    batchRepository: {
      listBatchIds: () => ['batch_ok', 'batch_broken', 'batch_empty'],
      loadBatch: (id) => {
        if (id === 'batch_broken') throw new Error('Unexpected token < in JSON');
        if (id === 'batch_empty') return null;
        return good;
      },
    },
  });

  const groups = svc.listRephotoGroups({});
  assert.equal(groups.length, 1, '好批次照常出,坏批次不阻断');
  assert.equal(groups[0].batchId, 'batch_ok');

  const bad = groups.unreadableBatches;
  assert.equal(bad.length, 2, '两个读不出的都要报');
  assert.deepEqual(bad.map((b) => b.batchId).sort(), ['batch_broken', 'batch_empty']);
  assert.match(bad.find((b) => b.batchId === 'batch_broken').error, /Unexpected token/, '带上真实原因');
  assert.match(bad.find((b) => b.batchId === 'batch_empty').error, /空的/);

  // 挂成不可枚举:五个调用方都当纯数组用,数组行为与序列化都不能被搅动
  assert.ok(!Object.keys(groups).includes('unreadableBatches'));
  assert.equal(JSON.parse(JSON.stringify(groups)).length, 1);
});

// ── B1 审核台每日收票 Excel:「不用记」整行剔除,零计数零说明 ─────────────
// 剔除本身是拍板过的合法业务(2026-07-24),问题是**剔了多少一个字都没说**:
// 操作员核对"今天收了多少票"时,表里行数比审核通过的收据数少,只能自己数、自己猜。
// 交付包那边已用【图在包里·账不在单上】解释过同一件事,这个出口一直没有。
test('每日收票导出:被剔除的「不用记」行数要交出来', () => {
  const { buildReceiptExportRows } = require('../lib/workbench_receipt_export');
  const mk = (over) => ({
    reviewed: true, docTypeFinal: 'receipt', sourceGroupKey: 'G1',
    receiptNoFinal: '1234567890123', purchaseDateFinal: '2026-07-20', ...over,
  });
  const rows = buildReceiptExportRows([
    mk({ id: 'r1', modeRawPre: '乐天SG-本司' }),
    mk({ id: 'r2', modeRawPre: '新罗SG-新琪 不用记' }),
    mk({ id: 'r3', modeRawPre: '济州新罗SG-道辉 不用记' }),
  ], { customerContextByGroup: new Map() });

  assert.equal(rows.length, 1, '两行「不用记」被剔除');
  assert.equal(rows.noRecordExcluded, 2, '剔了几行必须说得出来');

  // 不可枚举:调用方拿它遍历写 sheet / 拼 CSV,数组行为与序列化都不能被搅动
  assert.ok(!Object.keys(rows).includes('noRecordExcluded'));
  assert.equal(JSON.parse(JSON.stringify(rows)).length, 1);

  // 没有「不用记」时是 0,不是 undefined(前端拿去显示不该出现 undefined)
  const clean = buildReceiptExportRows([mk({ id: 'r9', modeRawPre: '乐天SG-本司' })], { customerContextByGroup: new Map() });
  assert.equal(clean.noRecordExcluded, 0);
});

test('接线:每日收票导出的响应要把剔除数带到前端', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/workbench_export_service.js'), 'utf8');
  assert.match(svc, /noRecordExcluded: exportRows\.noRecordExcluded \|\| 0/);
  // handler 用 ...exported 展开,所以服务层加了字段就一路到前端;锁住这个前提
  const h = fs2.readFileSync(path2.join(__dirname, '../services/handlers/workbench/batch_handlers.js'), 'utf8');
  assert.match(h, /return res\.json\(\{\s*\n\s*ok: true,\s*\n\s*\.\.\.exported,/,
    'handler 靠展开转发,改成挑字段就会把新字段挡在外面');
});
