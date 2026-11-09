'use strict';

/**
 * 重拍原因(0727反馈#10)从审核台一路带到「需重拍·去回收」清单(2026-08-01)。
 *
 * 病灶:原因分键的**中文标签只存在于前端**(frontend/src/lib/reviewDisplay.js),
 * 后端只有键的白名单。于是资料库导出的重拍 sheet 拿不到标签,那张表干脆不带原因 ——
 * 只有「需重拍·去回收」五个字。而拿这张表去回收照片的人,恰恰是最需要知道
 * "为什么要重拍"的那个人;0727#10 加这个分键的**全部理由**就是「前台补拍不用再猜」。
 * 功能做了,却在导出这一步把它的价值漏掉了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { REPHOTO_REASONS, rephotoReasonLabel } = require('../lib/rephoto_reasons');
const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');

test('键→中文;认不出/空 → 空串(不编造)', () => {
  assert.equal(rephotoReasonLabel('blurry'), '模糊');
  assert.equal(rephotoReasonLabel('missing'), '缺');
  assert.equal(rephotoReasonLabel('other'), '其他');
  assert.equal(rephotoReasonLabel(''), '');
  assert.equal(rephotoReasonLabel('unknown-key'), '');
  assert.equal(rephotoReasonLabel(null), '');
});

test('⭐前后端两份定义必须逐条一致(跨不过 Vite/CJS 边界,只能靠对拍)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewDisplay.js'), 'utf8',
  );
  const block = /export const REPHOTO_REASONS = \[([\s\S]*?)\]/.exec(src);
  assert.ok(block, '没定位到前端的 REPHOTO_REASONS');
  const fe = [...block[1].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  assert.deepEqual(fe, REPHOTO_REASONS.map((r) => ({ key: r.key, label: r.label })),
    '前后端重拍原因清单不一致 —— 顺序也要一样(顺序即审核台快捷键 1/2/3)');
});

function makeSvc(tasks) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_key TEXT, source_customer_id TEXT,
    source_batch_id TEXT, mode_raw TEXT, purchase_date TEXT, receipt_no TEXT, shop TEXT,
    branch TEXT, imported_at TEXT
  )`);
  const batch = {
    id: 'batch_x', name: '批次X', monthlyWorkspaceKey: '2026-01', ownerUsername: '小票01',
    sourceGroups: [{ key: 'g1', label: '张三组' }],
    tasks,
  };
  return createLibraryModeExportService({
    db,
    batchRepository: {
      listBatches: () => [{ id: 'batch_x', name: '批次X', ownerUsername: '小票01' }],
      listBatchIds: () => ['batch_x'],
      loadBatch: (id) => (id === 'batch_x' ? batch : null),
    },
  });
}
const task = (over) => ({ sourceGroupKey: 'g1', customerAgentName: '本司', ...over });

// 注:期望值是「模糊×2、缺」而不是「模糊×2、缺×1」——只有一张时省略 ×1(见下一条用例)。
// 我第一版把标题和断言都写成了 ×1,和下一条自相矛盾;是断言写错,不是代码错。
test('⭐一组多张、原因不同 → 汇总成「模糊×2、缺」,不是只报第一个', () => {
  const svc = makeSvc([
    task({ rephotoRequested: true, rephotoReason: 'blurry' }),
    task({ rephotoRequested: true, rephotoReason: 'blurry' }),
    task({ rephotoRequested: true, rephotoReason: 'missing' }),
    task({ rephotoRequested: false }), // 不重拍的不进来
  ]);
  const rows = svc.listRephotoGroups({ batchId: 'batch_x' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reasonSummary, '模糊×2、缺');
});

test('只有一张时不加 ×1(别把简单的事写复杂)', () => {
  const rows = makeSvc([task({ rephotoRequested: true, rephotoReason: 'other' })])
    .listRephotoGroups({ batchId: 'batch_x' });
  assert.equal(rows[0].reasonSummary, '其他');
});

test('⭐没填原因的写「未填原因」,不留空白', () => {
  const rows = makeSvc([task({ rephotoRequested: true })]).listRephotoGroups({ batchId: 'batch_x' });
  assert.equal(rows[0].reasonSummary, '未填原因',
    '空白会被读成"不用重拍",而这张表上每一行都是要重拍的');
});

test('接线:导出 sheet 真的有「重拍原因」这一列', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'monthly', 'library_mode_export_service.js'), 'utf8',
  );
  const block = /const REPHOTO_COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, '没定位到 REPHOTO_COLUMNS');
  assert.match(block[1], /\['重拍原因', 'reasonSummary'\]/);
  assert.match(src, /require\('\.\.\/\.\.\/lib\/rephoto_reasons'\)/, '标签走后端单一真相源');
});
