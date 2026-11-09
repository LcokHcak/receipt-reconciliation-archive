'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { logger: defaultLogger } = require('../request_logger');

const MIGRATION_FILE_RE = /^\d{4}_.+\.(sql|js)$/;

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function listMigrationFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function getAppliedVersions(db) {
  return new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );
}

function runMigrationFile(db, fullPath) {
  if (fullPath.endsWith('.sql')) {
    db.exec(fs.readFileSync(fullPath, 'utf8'));
    return;
  }

  const resolved = require.resolve(fullPath);
  delete require.cache[resolved];
  const migration = require(resolved);
  if (typeof migration !== 'function') {
    throw new Error(`JS migration must export a function: ${path.basename(fullPath)}`);
  }
  migration(db);
}

function createMigrationError(version, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Migration ${version} failed: ${message}`);
  error.name = 'MigrationError';
  error.version = version;
  error.cause = cause;
  return error;
}

function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // intentional: best-effort cleanup
  }
}

function runMigrations(db, dir, { logger = defaultLogger } = {}) {
  ensureMigrationTable(db);

  const applied = getAppliedVersions(db);
  for (const fileName of listMigrationFiles(dir)) {
    const version = path.basename(fileName, path.extname(fileName));
    if (applied.has(version)) continue;

    const fullPath = path.resolve(dir, fileName);
    const startedAt = Date.now();
    try {
      db.exec('BEGIN');
      runMigrationFile(db, fullPath);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
      ).run(version, new Date().toISOString());
      db.exec('COMMIT');
      logger?.info?.('migration_applied', { version, ms: Date.now() - startedAt });
      applied.add(version);
    } catch (error) {
      rollback(db);
      throw createMigrationError(version, error);
    }
  }
}

module.exports = { runMigrations };
