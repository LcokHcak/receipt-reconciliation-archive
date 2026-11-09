'use strict';

/**
 * unreceived_state_repository — 未收 first_seen 锚(表 unreceived_state,迁移 0026)。
 *
 * 未收清单=派生可重算,这里只存唯一不可派生的锚:item_key 第一次被对账发现的时刻
 * (超7天红的起算点,拍板③ 2026-07-16)。item_key 口径=unreceivedItemKey
 * (归一护照|姓名|票号),与 unreceived_resolution 完全同键。
 * INSERT OR IGNORE:每日重算已存在的行不重置计时。
 */
function createUnreceivedStateRepository({ db }) {
  if (!db) throw new Error('unreceived_state_repository: db required');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO unreceived_state (workspace_key, item_key, first_seen_at)
    VALUES (?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT item_key, first_seen_at FROM unreceived_state WHERE workspace_key = ?
  `);

  /** 批量盖首次发现时间;已有的键不动(不重置计时)。返回新盖的条数。 */
  function ensureFirstSeen(workspaceKey, itemKeys, firstSeenAt) {
    if (!workspaceKey || !firstSeenAt) throw new Error('workspaceKey and firstSeenAt required');
    let inserted = 0;
    // 整批一个事务(照 store_bill.insertMany 手法):首日对账可能几千条未收,逐条 autocommit 太慢
    db.exec('BEGIN');
    try {
      for (const key of itemKeys || []) {
        if (!key) continue;
        const info = insertStmt.run(workspaceKey, key, firstSeenAt);
        inserted += Number(info.changes) || 0;
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
      throw error;
    }
    return inserted;
  }

  /** @returns {Map<itemKey, firstSeenAt>} */
  function mapByWorkspace(workspaceKey) {
    const map = new Map();
    for (const row of listStmt.all(workspaceKey)) {
      map.set(row.item_key, row.first_seen_at);
    }
    return map;
  }

  return { ensureFirstSeen, mapByWorkspace };
}

module.exports = { createUnreceivedStateRepository };
