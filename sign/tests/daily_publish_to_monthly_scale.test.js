'use strict';

// 防复发:按 id 的批量 SQL 操作必须能扛「数万 ids」而不触发 SQLite
// "too many SQL variables"。用真实 sqlite(非 mock)灌大批数据验证。
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

test('daily.publishToMonthly 分块 IN:数万 ids 不触发 too many SQL variables', (t) => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());
  const repo = createDailyReceiptRepository({ db });

  const N = 1500; // > SQLite 999 旧上限,跨多个 500 分块
  const rows = Array.from({ length: N }, (_, i) => ({
    workspaceKey: WS,
    receiptNo: `R${i}`,
    name: 'N',
    passportNo: `P${i}`,
    rowHash: `h${i}`,
    importedAt: '2026-01-01T00:00:00.000Z',
    ledgerStatus: 'ready_to_post',
  }));
  repo.insertMany(rows);

  const ids = db.prepare('SELECT id FROM daily_receipt_export WHERE workspace_key = ?')
    .all(WS).map((r) => r.id);
  assert.equal(ids.length, N);

  // 不应抛错;应把全部 ready_to_post 行置 posted
  const changed = repo.publishToMonthly({ workspaceKey: WS, ids, postedBy: 'tester' });
  assert.equal(changed, N);

  const posted = db.prepare(
    "SELECT COUNT(1) c FROM daily_receipt_export WHERE workspace_key = ? AND ledger_status = 'posted'"
  ).get(WS).c;
  assert.equal(posted, N);
});
