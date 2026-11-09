'use strict';

function runSqliteTransaction(db, action, {
  mode = 'BEGIN',
  savepointName = 'nested_write',
  preferSavepoint = false,
} = {}) {
  if (!db || typeof action !== 'function') {
    throw new Error('db and action required');
  }
  const useSavepoint = preferSavepoint || Boolean(db.isTransaction);
  if (useSavepoint) {
    const name = sanitizeSavepointName(savepointName);
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = action();
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      } finally {
        try {
          db.exec(`RELEASE SAVEPOINT ${name}`);
        } catch {
          // intentional: best-effort cleanup
        }
      }
      throw error;
    }
  }

  db.exec(mode);
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // intentional: best-effort cleanup
    }
    throw error;
  }
}

function sanitizeSavepointName(value) {
  return String(value || 'nested_write').replace(/[^A-Za-z0-9_]/g, '_');
}

module.exports = { runSqliteTransaction };
