'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');

// 审计L610:error_record 无行级外键,tour_match 自愈/count 抑制守卫全按 receipt_no 粗匹配,同票号
// 多行互相误清/误抑制。修=加 source_id(=daily_receipt_export.id),按行精确清/抑制;legacy(null)
// 回退 receipt_no(零回归)。此处锁 repo 层:deleteOpenBySourceIds 精确+兜底、countByType 按行抑制。

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';
const SILENT = { info() {}, warn() {}, error() {} };

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: SILENT });
  t.after(() => db.close());
  return {
    db,
    daily: createDailyReceiptRepository({ db }),
    err: createErrorRecordRepository({ db }),
  };
}

test('L610 deleteOpenBySourceIds:按行精确清,不连坐同票号兄弟行', (t) => {
  const { err } = setup(t);
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: 101, detectedAt: 't' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: 102, detectedAt: 't' },
  ]);
  // 行 101 变 matched → 清它的 error;兄弟 102 仍阻塞 → 必须保住(修前 receipt_no 粗清会连坐删掉)
  const deleted = err.deleteOpenBySourceIds({ workspaceKey: WS, sourceIds: [101], receiptNos: ['R-DUP'] });
  assert.equal(deleted, 1, '只删本行(101)一条,不连坐兄弟');
  const remain = err.list({ workspaceKey: WS });
  assert.equal(remain.length, 1);
  assert.equal(remain[0].sourceId, 102, '兄弟行 102 的真阻塞保住');
});

test('L610 deleteOpenBySourceIds:legacy(source_id 为 null)按 receipt_no 兜底清(过渡期不漏清)', (t) => {
  const { err } = setup(t);
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-LEG', detectedAt: 't' }, // 无 sourceId=legacy
  ]);
  const deleted = err.deleteOpenBySourceIds({ workspaceKey: WS, sourceIds: [999], receiptNos: ['R-LEG'] });
  assert.equal(deleted, 1, 'legacy null 行按 receipt_no 兜底清(与旧 deleteOpenByReceiptNos 同行为)');
  assert.equal(err.list({ workspaceKey: WS }).length, 0);
});

test('L610 deleteOpenBySourceIds:新行(有 source_id)不被别行的 receiptNos 兜底误删', (t) => {
  const { err } = setup(t);
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: 102, detectedAt: 't' },
  ]);
  // 清 101(不同行)但 receiptNos 含 R-DUP:102 有 source_id 非 null → 不走 receipt_no 兜底 → 不被误删
  const deleted = err.deleteOpenBySourceIds({ workspaceKey: WS, sourceIds: [101], receiptNos: ['R-DUP'] });
  assert.equal(deleted, 0, '有 source_id 的兄弟行不被 receipt_no 兜底误删(兜底只作用于 legacy null)');
  assert.equal(err.list({ workspaceKey: WS }).length, 1);
});

test('L610 countByType:按行抑制——matched 本行 TM error 隐,同票号未匹配兄弟行照计', (t) => {
  const { daily, err } = setup(t);
  daily.insertMany([
    { workspaceKey: WS, receiptNo: 'R-DUP', shop: 'THE SHILLA', purchaseDate: '2026-01-15', rowHash: 'a', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'matched' },
    { workspaceKey: WS, receiptNo: 'R-DUP', shop: 'THE SHILLA', purchaseDate: '2026-01-20', rowHash: 'b', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'tour_not_found' },
  ]);
  const rows = daily._listAll({ workspaceKey: WS });
  const A = rows.find((r) => r.purchaseDate === '2026-01-15'); // matched
  const B = rows.find((r) => r.purchaseDate === '2026-01-20'); // 未匹配,仍阻塞
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: A.id, detectedAt: 't' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: B.id, detectedAt: 't' },
  ]);
  const tm = err.countByType(WS).filter((e) => String(e.error_type || '').startsWith('TM_'));
  const total = tm.reduce((n, e) => n + Number(e.count || 0), 0);
  // 修前:A matched + receipt_no 撞 → A、B 两条都被抑制 → total=0(B 真阻塞被隐藏)。
  // 修后:只 A 本行被抑制(d.id=source_id),B 的真阻塞照计。
  assert.equal(total, 1, '只未匹配兄弟 B 计入首页阻塞;A(matched)本行抑制,不连坐抑制 B');
});

test('L610 countByType:legacy(source_id null)行仍按 receipt_no 抑制(零回归)', (t) => {
  const { daily, err } = setup(t);
  daily.insertMany([
    { workspaceKey: WS, receiptNo: 'R-LEG', shop: 'THE SHILLA', purchaseDate: '2026-01-15', rowHash: 'c', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'matched' },
  ]);
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-LEG', detectedAt: 't' }, // legacy 无 sourceId
  ]);
  const tm = err.countByType(WS).filter((e) => String(e.error_type || '').startsWith('TM_'));
  const total = tm.reduce((n, e) => n + Number(e.count || 0), 0);
  assert.equal(total, 0, 'legacy 行按 receipt_no 抑制(matched 行的陈旧 error 不计,与修前一致)');
});

test('L610 insert/mapRow round-trip:source_id / source_table 落库回读', (t) => {
  const { err } = setup(t);
  err.insertMany([{ workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R', sourceId: 55, detectedAt: 't' }]);
  const [row] = err.list({ workspaceKey: WS });
  assert.equal(row.sourceId, 55);
  assert.equal(row.sourceTable, 'daily_receipt_export', '默认来源表');
});

// L610-④:删台账行时级联清 error_record。同票号多行删 A 留 B,A 的 open TM error 按 source_id
// 精确清(不再被 countDailyByReceipt 撞 B 而留孤儿虚计);删最后一行则扫尾清整票号(含 legacy)。
test('L610-④ 级联删:删 A 留同票号兄弟 B → A 的 open TM error 被清,B 的保住', (t) => {
  const { daily, err } = setup(t);
  daily.insertMany([
    { workspaceKey: WS, receiptNo: 'R-DUP', shop: 'S', purchaseDate: '2026-01-15', rowHash: 'a', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'tour_not_found' },
    { workspaceKey: WS, receiptNo: 'R-DUP', shop: 'S', purchaseDate: '2026-01-20', rowHash: 'b', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'tour_not_found' },
  ]);
  const rows = daily._listAll({ workspaceKey: WS });
  const A = rows.find((r) => r.purchaseDate === '2026-01-15');
  const B = rows.find((r) => r.purchaseDate === '2026-01-20');
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: A.id, detectedAt: 't' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-DUP', sourceId: B.id, detectedAt: 't' },
  ]);
  daily.deleteMany({ workspaceKey: WS, ids: [A.id] }); // 删 A,B 仍在
  const remain = err.list({ workspaceKey: WS, status: 'open', limit: 10 });
  assert.equal(remain.length, 1, 'A 的 error 被按行清,只剩 B 的');
  assert.equal(remain[0].sourceId, B.id, 'B 的真阻塞保住(修前 A 的 error 撞 B 留孤儿虚计)');
});

test('L610-④ 级联删:删最后一行 → 扫尾清整票号残留(含 legacy source_id 为 null)', (t) => {
  const { daily, err } = setup(t);
  daily.insertMany([
    { workspaceKey: WS, receiptNo: 'R-LAST', shop: 'S', purchaseDate: '2026-01-15', rowHash: 'x', importedAt: 't', sourceType: 'imported', tourMatchStatus: 'tour_not_found' },
  ]);
  const A = daily._listAll({ workspaceKey: WS })[0];
  err.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-LAST', sourceId: A.id, detectedAt: 't' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-LAST', detectedAt: 't' }, // legacy 无 sourceId
  ]);
  daily.deleteMany({ workspaceKey: WS, ids: [A.id] }); // 最后一行删尽
  assert.equal(err.list({ workspaceKey: WS, status: 'open', limit: 10 }).length, 0, '整票号 TM error 清干净(source_id 行 + legacy 兜底)');
});
