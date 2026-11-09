'use strict';

const {
  assertChangeSource,
  normalizeHistoryChanges,
} = require('../lib/monthly/field_history');

function createDailyFieldHistoryRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO daily_field_history (
      workspace_key, daily_row_id, field,
      before_value, after_value, change_source,
      actor, ts, conflict_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const mapRow = (row) => ({
    id: row.id, workspaceKey: row.workspace_key, dailyRowId: row.daily_row_id,
    field: row.field, beforeValue: row.before_value, afterValue: row.after_value,
    changeSource: row.change_source, actor: row.actor, ts: row.ts, conflictId: row.conflict_id,
  });

  return {
    recordChanges({
      workspaceKey,
      dailyRowId,
      changes,
      changeSource,
      actor = 'system',
      conflictId = null,
      ts = null,
    }) {
      assertChangeSource(changeSource);
      const normalized = normalizeHistoryChanges(changes);
      if (normalized.length === 0) return { inserted: 0 };
      const now = ts || new Date().toISOString();
      let inserted = 0;
      for (const c of normalized) {
        insertStmt.run(
          workspaceKey, Number(dailyRowId), c.field, c.beforeValue, c.afterValue,
          changeSource, actor || 'system', now, conflictId == null ? null : String(conflictId)
        );
        inserted += 1;
      }
      return { inserted };
    },

    list({ workspaceKey, dailyRowId, source = null, before = null, limit = 50 }) {
      const clauses = ['workspace_key = ?', 'daily_row_id = ?'];
      const params = [workspaceKey, Number(dailyRowId)];
      if (source) {
        clauses.push('change_source = ?');
        params.push(String(source));
      }
      if (before) {
        clauses.push('ts <= ?');
        params.push(String(before));
      }
      params.push(Math.max(1, Math.min(Number(limit) || 50, 200)));
      return db.prepare(`
        SELECT * FROM daily_field_history
        WHERE ${clauses.join(' AND ')}
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(...params).map(mapRow);
    },
  };
}

module.exports = { createDailyFieldHistoryRepository };
