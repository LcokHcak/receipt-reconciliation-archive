/**
 * @deprecated since 2026-05-20.
 *
 * This module is the legacy `sqlite` promise wrapper + `sqlite3` native driver
 * entrypoint, kept alive only for the ops/data-rescue scripts:
 *   - scripts/migrate_json_to_sqlite.js
 *   - scripts/restore_from_json.js
 *   - scripts/backup_sqlite.js
 *   - scripts/archive_test_batch.js
 *   - scripts/check_storage_consistency.js
 *
 * DO NOT use it in new runtime code. Production runtime uses `node:sqlite`
 * (DatabaseSync) - see `lib/storage/monthly_database.js`.
 *
 * Removal tracked in `AGENT_SHARED_MEMORY.md` legacy sqlite backlog.
 */
const fs = require('fs').promises
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

/**
 * Initialize SQLite database with schema
 * @param {string} dbPath - Path to SQLite database file
 * @returns {Promise<Object>} - Database instance
 * @deprecated since 2026-05-20. Legacy sqlite/sqlite3 ops entrypoint; migrate ops scripts to node:sqlite.
 */
async function initializeDatabase(dbPath) {
  // Ensure directory exists
  const dbDir = path.dirname(dbPath)
  await fs.mkdir(dbDir, { recursive: true })

  // Open database
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  })

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON')

  // Enable WAL mode for better concurrency
  await db.run('PRAGMA journal_mode = WAL')

  // Read and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql')
  const schema = await fs.readFile(schemaPath, 'utf8')

  // Remove comments and split by semicolon
  const lines = schema.split('\n')
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('--')
  })

  const cleanedSchema = cleanedLines.join('\n')
  const statements = cleanedSchema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const statement of statements) {
    try {
      await db.run(statement)
    } catch (error) {
      console.error('Failed to execute statement:', statement.substring(0, 100))
      throw error
    }
  }

  console.log('[Database] Initialized successfully')
  return db
}

/**
 * Check database health
 * @param {Object} db - Database instance
 * @returns {Promise<Object>} - Health status
 * @deprecated since 2026-05-20. Legacy sqlite/sqlite3 ops entrypoint; migrate to node:sqlite in Sprint C5.
 */
async function checkDatabaseHealth(db) {
  try {
    // Check if database is accessible
    await db.get('SELECT 1')

    // Get table count
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )

    // Get row counts
    const counts = {}
    for (const table of tables) {
      const result = await db.get(`SELECT COUNT(*) as count FROM ${table.name}`)
      counts[table.name] = result.count
    }

    return {
      healthy: true,
      tables: tables.length,
      counts,
    }
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
    }
  }
}

/**
 * Backup database to file
 * @param {Object} db - Database instance
 * @param {string} backupPath - Backup file path
 * @deprecated since 2026-05-20. Legacy sqlite/sqlite3 ops entrypoint; migrate to node:sqlite in Sprint C5.
 */
async function backupDatabase(db, backupPath) {
  const backupDir = path.dirname(backupPath)
  await fs.mkdir(backupDir, { recursive: true })

  // Use SQLite backup API
  await db.run(`VACUUM INTO '${backupPath}'`)
  console.log(`[Database] Backed up to ${backupPath}`)
}

/**
 * Get database statistics
 * @param {Object} db - Database instance
 * @returns {Promise<Object>} - Statistics
 * @deprecated since 2026-05-20. Legacy sqlite/sqlite3 ops entrypoint; migrate to node:sqlite in Sprint C5.
 */
async function getDatabaseStats(db) {
  const stats = {}

  // Batch stats
  const batchStats = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
    FROM batches
  `)
  stats.batches = batchStats

  // Task stats
  const taskStats = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN doc_type = 'passport' THEN 1 ELSE 0 END) as passports,
      SUM(CASE WHEN doc_type = 'receipt' THEN 1 ELSE 0 END) as receipts
    FROM tasks
  `)
  stats.tasks = taskStats

  // Customer stats
  const customerStats = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM customers
  `)
  stats.customers = customerStats

  // User stats
  const userStats = await db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
    FROM users
  `)
  stats.users = userStats

  return stats
}

module.exports = {
  initializeDatabase,
  checkDatabaseHealth,
  backupDatabase,
  getDatabaseStats,
}
