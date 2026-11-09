'use strict';

/**
 * Cross-check service end-to-end: verify that
 *   1. it actually rewrites store_bill.departure_date to the latest value
 *   2. it persists one CC_DEPARTURE_SYNC error per rewrite
 *   3. it writes a departure_sync_audit row per rewrite, linked to the error
 *   4. re-running is idempotent (no double rewrite, no duplicate audits for
 *      the now-consistent rows)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createDepartureSyncAuditRepository } = require('../repositories/departure_sync_audit_repository');
const { createCrossCheckService } = require('../services/monthly/cross_check_service');

function createTempDb() {
  const dbPath = path.join(os.tmpdir(), `monthly-cc-${Date.now()}-${Math.random()}.sqlite`);
  const db = openMonthlyDatabase({ dbPath });
  return {
    db,
    cleanup: () => {
      db.close?.();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    },
  };
}

const WS = '2026-01';
const NOW = '2026-05-10T00:00:00.000Z';

function billRow(overrides = {}) {
  return {
    workspaceKey: WS,
    storeFamily: '乐天',
    storeBranch: '乐天明洞',
    mode: 'H团',
    modeNormalized: 'H',
    tourNo: '25186291',
    purchaseDate: '2026-01-05',
    departureDate: '2026-01-06',
    name: 'ZHANG SAN',
    passportNo: 'EA1234567',
    receiptNo: '90100326000001',
    sourceFile: 'f.xlsx',
    sourceSheet: '明细',
    sourceRow: 1,
    isDetailSheet: true,
    rowHash: `h-${Math.random()}`,
    importedAt: NOW,
    ...overrides,
  };
}

test('cross_check_service rewrites earlier departures to the latest and audits each', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
    const service = createCrossCheckService({
      storeBillRepo,
      errorRecordRepo,
      departureSyncAuditRepo,
      clock: () => NOW,
    });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'R1', departureDate: '2026-01-05', rowHash: 'a' }),
      billRow({ receiptNo: 'R2', departureDate: '2026-01-09', rowHash: 'b' }),
      billRow({ receiptNo: 'R3', departureDate: '2026-01-07', rowHash: 'c' }),
    ]);

    const result = service.run({ workspaceKey: WS, triggeredBy: 'tester' });

    // Two of the three rows had to be rewritten (R1 and R3 → 2026-01-09).
    assert.equal(result.rewritten, 2);
    assert.equal(result.errorsLogged, 2);

    // store_bill should be physically rewritten.
    const after = storeBillRepo.iterateDetail(WS);
    const dates = new Set(after.map((r) => r.departureDate));
    assert.equal(dates.size, 1);
    assert.equal([...dates][0], '2026-01-09');

    // Audit trail should record before/after + trigger.
    const auditRows = departureSyncAuditRepo.list({ workspaceKey: WS, limit: 100 });
    assert.equal(auditRows.length, 2);
    for (const row of auditRows) {
      assert.equal(row.afterValue, '2026-01-09');
      assert.ok(['2026-01-05', '2026-01-07'].includes(row.beforeValue));
      assert.equal(row.triggeredBy, 'tester');
      assert.ok(row.errorRecordId, 'audit row should back-link to the error_record');
    }
  } finally {
    cleanup();
  }
});

test('cross_check_service is idempotent once departures are aligned', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
    const service = createCrossCheckService({
      storeBillRepo,
      errorRecordRepo,
      departureSyncAuditRepo,
      clock: () => NOW,
    });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'R1', departureDate: '2026-01-05', rowHash: 'a' }),
      billRow({ receiptNo: 'R2', departureDate: '2026-01-09', rowHash: 'b' }),
    ]);

    const first = service.run({ workspaceKey: WS });
    assert.equal(first.rewritten, 1);

    const second = service.run({ workspaceKey: WS });
    assert.equal(second.rewritten, 0);
    assert.equal(second.errorsLogged, 0);

    // Audit table keeps the original rewrite but no new entries on re-run.
    assert.equal(departureSyncAuditRepo.count(WS), 1);

    // The stale CC_DEPARTURE_SYNC error from the first run must be gone.
    const open = errorRecordRepo.list({ workspaceKey: WS, errorType: 'CC_DEPARTURE_SYNC', status: 'open' });
    assert.equal(open.length, 0);
  } finally {
    cleanup();
  }
});

test('cross_check_service ignores rows without passport_no and fills missing departure_date', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
    const service = createCrossCheckService({
      storeBillRepo,
      errorRecordRepo,
      departureSyncAuditRepo,
      clock: () => NOW,
    });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'R1', passportNo: null, departureDate: '2026-01-05', rowHash: 'a' }),
      billRow({ receiptNo: 'R2', passportNo: 'EA1234567', departureDate: null, rowHash: 'b' }),
      billRow({ receiptNo: 'R3', passportNo: 'EA1234567', departureDate: '2026-01-09', rowHash: 'c' }),
    ]);

    const result = service.run({ workspaceKey: WS });
    assert.equal(result.rewritten, 1);
    assert.equal(result.errorsLogged, 0);
    assert.equal(storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R2' })[0].departureDate, '2026-01-09');
    assert.equal(storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R1' })[0].departureDate, '2026-01-05');
  } finally {
    cleanup();
  }
});
