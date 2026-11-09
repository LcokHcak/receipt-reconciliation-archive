const fs = require('fs').promises;
const path = require('path');

/**
 * Storage Transaction Manager
 *
 * Implements the storage pattern: SQLite primary, JSON backup
 *
 * Write order:
 * 1. Write to SQLite (transactional)
 * 2. Async backup to JSON (non-blocking)
 * 3. Return success to caller
 *
 * Read order:
 * 1. Read from SQLite (primary)
 * 2. Fallback to JSON if SQLite fails
 */
class StorageTransaction {
  constructor(db, backupDir) {
    this.db = db;
    this.backupDir = backupDir;
  }

  /**
   * Execute a transactional operation
   * @param {Function} operation - Async function that performs SQLite operations
   * @param {Object} backupData - Data to backup to JSON (optional)
   * @returns {Promise<any>} - Result from the operation
   */
  async execute(operation, backupData = null) {
    // 1. Begin SQLite transaction
    await this.db.run('BEGIN TRANSACTION');

    try {
      // 2. Execute the operation
      const result = await operation(this.db);

      // 3. Commit SQLite transaction
      await this.db.run('COMMIT');

      // 4. Async backup to JSON (non-blocking)
      if (backupData) {
        setImmediate(() => this.backupToJSON(backupData).catch(err => {
          console.error('[StorageTransaction] JSON backup failed:', err);
          // Log but don't throw - backup failure should not affect main flow
        }));
      }

      return result;
    } catch (error) {
      // 5. Rollback on error
      await this.db.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * Backup data to JSON file
   * @param {Object} data - Data to backup
   * @param {string} data.type - Resource type (batch, customer, etc.)
   * @param {string} data.id - Resource ID
   * @param {Object} data.content - Content to backup
   */
  async backupToJSON(data) {
    const { type, id, content } = data;

    // Create backup directory if not exists
    const typeDir = path.join(this.backupDir, type);
    await fs.mkdir(typeDir, { recursive: true });

    // Write JSON file
    const filePath = path.join(typeDir, `${id}.json`);
    await fs.writeFile(
      filePath,
      JSON.stringify(content, null, 2),
      'utf8'
    );
  }

  /**
   * Read from JSON backup (fallback)
   * @param {string} type - Resource type
   * @param {string} id - Resource ID
   * @returns {Promise<Object|null>} - Backup data or null
   */
  async readFromJSON(type, id) {
    try {
      const filePath = path.join(this.backupDir, type, `${id}.json`);
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // File not found
      }
      throw error;
    }
  }

  /**
   * Delete JSON backup
   * @param {string} type - Resource type
   * @param {string} id - Resource ID
   */
  async deleteJSON(type, id) {
    try {
      const filePath = path.join(this.backupDir, type, `${id}.json`);
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[StorageTransaction] Failed to delete JSON backup:', error);
      }
    }
  }
}

/**
 * Create a storage transaction manager
 * @param {Object} db - SQLite database instance
 * @param {string} backupDir - Backup directory path
 * @returns {StorageTransaction}
 */
function createStorageTransaction(db, backupDir) {
  return new StorageTransaction(db, backupDir);
}

module.exports = {
  StorageTransaction,
  createStorageTransaction,
};
