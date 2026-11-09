'use strict';

/**
 * feedback_report — 用户在前端"反馈问题"按钮提交的报告。
 *
 * 字段设计：
 *   - request_id: 用户提交那一刻浏览器最后一次请求的 X-Request-Id，
 *                 让管理员能在日志里 grep 出整条请求链
 *   - page_url:  用户当时在哪个页面（含 query）
 *   - user_agent: 浏览器信息
 *   - description: 用户描述（自由文本，必填）
 *   - screenshot_path: 可选，前端截图保存路径
 *   - status: open / resolved / wont_fix
 */

function createFeedbackReportRepository({ db }) {
  if (!db) throw new Error('db is required');

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      page_url TEXT,
      request_id TEXT,
      user_agent TEXT,
      description TEXT NOT NULL,
      screenshot_path TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_report(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_report(created_at DESC);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO feedback_report (
      user_id, username, page_url, request_id, user_agent, description, screenshot_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT * FROM feedback_report
    WHERE (? IS NULL OR status = ?)
    ORDER BY id DESC LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(1) AS n FROM feedback_report
    WHERE (? IS NULL OR status = ?)
  `);
  const findByIdStmt = db.prepare('SELECT * FROM feedback_report WHERE id = ?');
  const resolveStmt = db.prepare(`
    UPDATE feedback_report
    SET status = 'resolved', resolved_at = datetime('now'),
        resolved_by = ?, resolution = ?
    WHERE id = ?
  `);

  return {
    submit({ userId, username, pageUrl, requestId, userAgent, description, screenshotPath }) {
      const result = insertStmt.run(
        userId == null ? null : Number(userId),
        username || null,
        pageUrl || null,
        requestId || null,
        userAgent || null,
        String(description || '').slice(0, 4000),
        screenshotPath || null
      );
      return { id: result.lastInsertRowid };
    },
    list({ status = null, limit = 100, offset = 0 }) {
      return listStmt.all(status, status, Number(limit), Number(offset));
    },
    count({ status = null }) {
      return Number(countStmt.get(status, status)?.n || 0);
    },
    findById(id) {
      return findByIdStmt.get(Number(id));
    },
    resolve({ id, resolvedBy, resolution }) {
      return resolveStmt.run(resolvedBy || null, resolution || null, Number(id)).changes;
    },
  };
}

module.exports = { createFeedbackReportRepository };
