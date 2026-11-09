'use strict';

/**
 * End-to-end rule engine test with SYNTHETIC conflicts injected into
 * a temp DB. This verifies that the full path (sqlite storage →
 * iterateDetail → runRules → error_record) actually fires.
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
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');

function createTempDb() {
  const dbPath = path.join(os.tmpdir(), `monthly-rule-${Date.now()}-${Math.random()}.sqlite`);
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
    brand: 'CHANEL',
    qty: 1,
    grossUsd: 100,
    netUsd: 95,
    sourceFile: 'f.xlsx',
    sourceSheet: '明细',
    sourceRow: 1,
    isDetailSheet: true,
    rowHash: `h-${Math.random()}`,
    importedAt: NOW,
    ...overrides,
  };
}

test('cross-check detects departure date conflicts end-to-end', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
    const { createCrossCheckService } = require('../services/monthly/cross_check_service');
    const crossCheckService = createCrossCheckService({
      storeBillRepo,
      errorRecordRepo,
      departureSyncAuditRepo,
    });
    const service = createErrorDetectionService({
      storeBillRepo,
      errorRecordRepo,
      crossCheckService,
    });

    storeBillRepo.insertMany([
      billRow({
        receiptNo: 'R1', departureDate: '2026-01-05',
        rowHash: 'h-dep-1',
      }),
      billRow({
        receiptNo: 'R2', departureDate: '2026-01-09',
        rowHash: 'h-dep-2',
      }),
      billRow({
        receiptNo: 'R3', departureDate: '2026-01-07',
        rowHash: 'h-dep-3',
      }),
    ]);

    const result = service.runCrossCheck({ workspaceKey: WS, withDepartureSync: true });
    assert.equal(result.summary.CC_DEPARTURE_SYNC, 2);
    assert.equal(result.departureSync.rewritten, 2);

    const errors = errorRecordRepo.list({ workspaceKey: WS, errorType: 'CC_DEPARTURE_SYNC' });
    for (const err of errors) {
      assert.equal(err.expectedValue, '2026-01-09');
      assert.equal(err.passportNo, 'EA1234567');
    }
  } finally {
    cleanup();
  }
});

test('cross-check re-running clears previous open errors of the same type', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const service = createErrorDetectionService({ storeBillRepo, errorRecordRepo });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'R1', departureDate: '2026-01-05', rowHash: 'a' }),
      billRow({ receiptNo: 'R2', departureDate: '2026-01-09', rowHash: 'b' }),
    ]);

    const first = service.runCrossCheck({ workspaceKey: WS });
    const second = service.runCrossCheck({ workspaceKey: WS });
    assert.equal(first.totalErrors, second.totalErrors, 'identical runs should not double-count');
  } finally {
    cleanup();
  }
});

test('cross-check detects receipt->passport/name conflicts', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const service = createErrorDetectionService({ storeBillRepo, errorRecordRepo });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'SHARED', passportNo: 'PA', name: 'ZHANG SAN', rowHash: 'c1' }),
      billRow({ receiptNo: 'SHARED', passportNo: 'PB', name: 'LI SI', rowHash: 'c2' }),
    ]);
    const result = service.runCrossCheck({ workspaceKey: WS });
    assert.ok(result.summary.CC_NAME_PASSPORT >= 2);
  } finally {
    cleanup();
  }
});

test('resolve marks a record as resolved without deleting it', () => {
  const { db, cleanup } = createTempDb();
  try {
    const storeBillRepo = createStoreBillRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const service = createErrorDetectionService({ storeBillRepo, errorRecordRepo });

    storeBillRepo.insertMany([
      billRow({ receiptNo: 'R1', departureDate: '2026-01-05', rowHash: 'r1' }),
      billRow({ receiptNo: 'R2', departureDate: '2026-01-09', rowHash: 'r2' }),
    ]);
    service.runCrossCheck({ workspaceKey: WS });
    const open = errorRecordRepo.list({ workspaceKey: WS, status: 'open' });
    assert.ok(open.length > 0);

    service.resolve({ id: open[0].id, resolvedBy: 'tester', note: 'ok' });
    const after = errorRecordRepo.list({ workspaceKey: WS, status: 'resolved' });
    assert.equal(after[0].id, open[0].id);
    assert.equal(after[0].resolvedBy, 'tester');
    assert.equal(after[0].resolutionNote, 'ok');
  } finally {
    cleanup();
  }
});
