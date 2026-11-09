'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');

const PRODUCTION_MIGRATIONS_DIR = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const PRODUCTION_MIGRATION_VERSIONS = [
  '0001_init_monthly',
  '0002_receipt_ledger_columns',
  '0003_stage_jobs_idempotency',
  '0004_pipeline_lock',
  '0005_pending_review_fingerprint',
  '0006_daily_manual_locked_fields',
  '0007_mode_config',
  '0008_merge_phase2',
  '0009_daily_field_history',
  '0010_audit_log_seq',
  '0011_store_bill_transaction_type', // G11c (#33)
  '0012_batch_group_code',
  '0013_batch_group_code_unique',
  '0014_import_job_bucket',
  '0015_daily_conflict_fields',
  '0016_store_bill_enriched',
  '0017_brand_activity',
  '0018_export_indexes',
  '0019_unreceived_resolution',
  '0020_derivation_dirty',
  '0021_pending_fingerprint_index',
  '0022_mode_confirmed',
  '0023_batch_group_code_multimode',
  '0024_group_code_mode_index',
  '0025_daily_receipt_export_passport_index',
  '0026_unreceived_state',
  '0027_smg_ledger', // SMG总账未收对账:statement_date 列 + import_job_id 索引
  '0028_daily_receipt_source_group_index', // 台账按客户组查复合索引(结算/确认热路径去全表扫)
  '0029_error_record_source_id', // L610:error_record 加行级 source_id(自愈/count 守卫按行精确)
];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migration-runner-'));
}

function makeLogger(events) {
  return {
    info: (msg, fields = {}) => events.push({ level: 'info', msg, ...fields }),
    warn: (msg, fields = {}) => events.push({ level: 'warn', msg, ...fields }),
    error: (msg, fields = {}) => events.push({ level: 'error', msg, ...fields }),
  };
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  );
}

function indexExists(db, indexName) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName)
  );
}

test('runMigrations applies production monthly migrations on a clean database', () => {
  const db = new DatabaseSync(':memory:');
  const events = [];

  runMigrations(db, PRODUCTION_MIGRATIONS_DIR, { logger: makeLogger(events) });

  const versions = db.prepare(
    'SELECT version FROM schema_migrations ORDER BY version'
  ).all().map((row) => row.version);
  assert.deepEqual(versions, PRODUCTION_MIGRATION_VERSIONS);
  assert.equal(
    events.filter((event) => event.msg === 'migration_applied').length,
    PRODUCTION_MIGRATION_VERSIONS.length,
  );
  assert.ok(tableExists(db, 'monthly_workspace'));
  assert.ok(tableExists(db, 'daily_receipt_export'));
  assert.ok(indexExists(db, 'idx_daily_receipt_ledger_status'));
  assert.ok(indexExists(db, 'ux_stage_jobs_active_idempotency'));
  assert.ok(tableExists(db, 'pipeline_lock'));
  assert.ok(indexExists(db, 'idx_pipeline_lock_acquired'));
  assert.ok(indexExists(db, 'idx_pending_review_fp'));
  assert.ok(tableExists(db, 'mode_deduct_config'));
  assert.ok(tableExists(db, 'mode_folder_mapping'));
  assert.ok(tableExists(db, 'daily_field_history'));
  assert.ok(indexExists(db, 'idx_daily_field_history_row'));
  // 0010: audit_log rebuilt with seq column
  assert.ok(tableExists(db, 'audit_log'));
  const auditCols = db.prepare("PRAGMA table_info(audit_log)").all().map((c) => c.name);
  assert.ok(auditCols.includes('seq'), 'audit_log must have seq column after 0010');
  assert.ok(tableExists(db, 'batch_group_code'));
  assert.ok(indexExists(db, 'idx_batch_group_code_batch_tour'));
  assert.ok(indexExists(db, 'idx_import_job_bucket'));
  const dailyCols = db.prepare("PRAGMA table_info(daily_receipt_export)").all().map((c) => c.name);
  assert.ok(dailyCols.includes('conflict_fields'), 'daily_receipt_export must have conflict_fields after 0015');
  // 0019: 未收清单处理状态表
  assert.ok(tableExists(db, 'unreceived_resolution'));
  assert.ok(indexExists(db, 'idx_unreceived_resolution_ws'));
  // 0020: 派生新鲜度脏标记列
  const wsCols = db.prepare("PRAGMA table_info(monthly_workspace)").all().map((c) => c.name);
  assert.ok(wsCols.includes('derivation_dirty_from'), 'monthly_workspace must have derivation_dirty_from after 0020');
});

test('runMigrations is idempotent and does not emit duplicate apply logs', () => {
  const db = new DatabaseSync(':memory:');
  const firstEvents = [];
  const secondEvents = [];

  runMigrations(db, PRODUCTION_MIGRATIONS_DIR, { logger: makeLogger(firstEvents) });
  runMigrations(db, PRODUCTION_MIGRATIONS_DIR, { logger: makeLogger(secondEvents) });

  const versions = db.prepare(
    'SELECT version FROM schema_migrations ORDER BY version'
  ).all().map((row) => row.version);
  assert.deepEqual(versions, PRODUCTION_MIGRATION_VERSIONS);
  assert.equal(firstEvents.filter((event) => event.msg === 'migration_applied').length, PRODUCTION_MIGRATION_VERSIONS.length);
  assert.equal(secondEvents.filter((event) => event.msg === 'migration_applied').length, 0);
});

test('runMigrations rolls back a failing migration and records the failed version', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE ok_table (id INTEGER);');
    fs.writeFileSync(
      path.join(dir, '0002_fail.js'),
      [
        "'use strict';",
        'module.exports = function failMigration(db) {',
        "  db.exec('CREATE TABLE rolled_back_table (id INTEGER);');",
        "  throw new Error('boom');",
        '};',
        '',
      ].join('\n')
    );

    const db = new DatabaseSync(':memory:');
    let err;
    try {
      runMigrations(db, dir, { logger: makeLogger([]) });
    } catch (caught) {
      err = caught;
    }

    assert.match(err.message, /Migration 0002_fail failed: boom/);
    assert.equal(err.version, '0002_fail');
    const versions = db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version'
    ).all().map((row) => row.version);
    assert.deepEqual(versions, ['0001_ok']);
    assert.ok(tableExists(db, 'ok_table'));
    assert.equal(tableExists(db, 'rolled_back_table'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('0002 receipt ledger migration is idempotent on an old daily_receipt_export table', () => {
  const applyReceiptLedgerMigration = require('../lib/storage/migrations/0002_receipt_ledger_columns');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE daily_receipt_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_key TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      receipt_date TEXT
    );
    INSERT INTO daily_receipt_export (workspace_key, imported_at)
    VALUES ('2026-05', '2026-05-17T12:34:56.000Z');
  `);

  assert.doesNotThrow(() => applyReceiptLedgerMigration(db));
  assert.doesNotThrow(() => applyReceiptLedgerMigration(db));

  const cols = db.prepare("PRAGMA table_info('daily_receipt_export')").all().map((row) => row.name);
  assert.ok(cols.includes('receipt_date'));
  assert.ok(cols.includes('agent_id'));
  assert.ok(cols.includes('ledger_status'));
  assert.equal(
    db.prepare('SELECT receipt_date FROM daily_receipt_export').get().receipt_date,
    '2026-05-17'
  );
  assert.equal(
    db.prepare('SELECT ledger_status FROM daily_receipt_export').get().ledger_status,
    'in_review'
  );
  assert.ok(indexExists(db, 'idx_daily_receipt_date'));
  assert.ok(indexExists(db, 'idx_daily_receipt_remedy'));
});
