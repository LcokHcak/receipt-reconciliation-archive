'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  const repo = createBillMatchLogRepository({ db });
  t.after(() => db.close());
  return { db, repo };
}

test('bill_match_log store-bill cleanup chunks large id lists', (t) => {
  const { repo } = setup(t);
  repo.insertMany([
    {
      workspaceKey: WS,
      dailyReceiptId: 7,
      storeBillId: 39999,
      matchPriority: 1,
      matchKey: 'R-1',
      matchStatus: 'matched',
      matchedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  const manyIds = Array.from({ length: 40000 }, (_, i) => i);

  assert.deepEqual(repo.listDailyIdsByStoreBillIds({ workspaceKey: WS, storeBillIds: manyIds }), [7]);
  assert.equal(repo.deleteByStoreBillIds({ workspaceKey: WS, storeBillIds: manyIds }), 1);
  assert.deepEqual(repo.listDailyIdsByStoreBillIds({ workspaceKey: WS, storeBillIds: manyIds }), []);
});
