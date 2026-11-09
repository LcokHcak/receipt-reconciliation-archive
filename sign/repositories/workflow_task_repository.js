'use strict';

/**
 * workflow_task_repository — 持久运营任务表(代理工作台 V2 Task 6)。
 *
 * 真相定位(架构文档 §6.4):回执/回发/更正等"人要去做的事"的持久真相,
 * 不是缓存、不可丢;替代旧 storage/sendback_queue.json(过渡期经 adapter 兼容旧 API)。
 *
 * 幂等铁律:task_key 是确定性幂等键(UNIQUE)。createExpected 用 INSERT ... ON CONFLICT
 * DO NOTHING——并发/重试/批次重复保存只会有一行;冲突时返回既有行并标 created:false。
 * 审计:completed_by/at、cancelled_at/cancel_reason 落库,状态不覆写审计(done 不能再改)。
 */

const crypto = require('node:crypto');

const TASK_STATUSES = Object.freeze(['pending', 'done', 'cancelled']);

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function toJsonObject(value) {
  if (!value || typeof value !== 'object') return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function createWorkflowTaskRepository({ db } = {}) {
  if (!db) throw new Error('db is required');

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_task (
      id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL UNIQUE,
      calendar_month TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      batch_id TEXT,
      group_key TEXT,
      agent_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      subtype TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT,
      completed_at TEXT,
      completed_by TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      source_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_task_month_agent_status
      ON workflow_task (calendar_month, agent_key, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_task_scope
      ON workflow_task (workspace_key, customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_task_batch_group
      ON workflow_task (batch_id, group_key, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_task_status_due
      ON workflow_task (status, due_at);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO workflow_task (
      id, task_key, calendar_month, workspace_key, customer_id, batch_id, group_key,
      agent_key, task_type, subtype, status, priority, due_at, payload_json,
      created_at, created_by, source_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_key) DO NOTHING
  `);
  const getByKeyStmt = db.prepare('SELECT * FROM workflow_task WHERE task_key = ?');
  const getByIdStmt = db.prepare('SELECT * FROM workflow_task WHERE id = ?');

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskKey: row.task_key,
      calendarMonth: row.calendar_month,
      workspaceKey: row.workspace_key,
      customerId: row.customer_id,
      batchId: row.batch_id,
      groupKey: row.group_key,
      agentKey: row.agent_key,
      taskType: row.task_type,
      subtype: row.subtype,
      status: row.status,
      priority: Number(row.priority) || 0,
      dueAt: row.due_at,
      payload: parseJsonObject(row.payload_json),
      createdAt: row.created_at,
      createdBy: row.created_by,
      completedAt: row.completed_at,
      completedBy: row.completed_by,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      sourceVersion: Number(row.source_version) || 1,
    };
  }

  /**
   * 幂等创建:同 task_key 只有一行。返回 { task, created }。
   * 并发安全靠 UNIQUE(task_key) + ON CONFLICT DO NOTHING,不靠先查后插。
   */
  function createExpected({
    taskKey,
    calendarMonth = '',
    workspaceKey = '',
    customerId = '',
    batchId = null,
    groupKey = null,
    agentKey = '',
    taskType,
    subtype = null,
    priority = 0,
    dueAt = null,
    payload = null,
    createdAt,
    createdBy = null,
    sourceVersion = 1,
  } = {}) {
    const key = clean(taskKey);
    if (!key) throw new Error('taskKey is required');
    if (!clean(taskType)) throw new Error('taskType is required');
    const result = insertStmt.run(
      `wt_${crypto.randomUUID().slice(0, 12)}`,
      key,
      clean(calendarMonth),
      clean(workspaceKey),
      clean(customerId),
      batchId == null ? null : clean(batchId),
      groupKey == null ? null : clean(groupKey),
      clean(agentKey),
      clean(taskType),
      subtype == null ? null : clean(subtype),
      Number(priority) || 0,
      dueAt == null ? null : clean(dueAt),
      toJsonObject(payload),
      clean(createdAt) || new Date().toISOString(),
      createdBy == null ? null : clean(createdBy),
      Number(sourceVersion) || 1,
    );
    return { task: mapRow(getByKeyStmt.get(key)), created: Number(result.changes) > 0 };
  }

  // 完成:只允许 pending → done;已 done/cancelled 返回原行不改审计(幂等安全)。
  function complete(id, { by = null, at, note = '' } = {}) {
    const row = getByIdStmt.get(clean(id));
    if (!row) return null;
    if (row.status !== 'pending') return mapRow(row);
    const payload = parseJsonObject(row.payload_json);
    if (clean(note)) payload.note = clean(note);
    db.prepare(`
      UPDATE workflow_task SET status = 'done', completed_at = ?, completed_by = ?, payload_json = ?
      WHERE id = ? AND status = 'pending'
    `).run(clean(at) || new Date().toISOString(), by == null ? null : clean(by), toJsonObject(payload), row.id);
    return mapRow(getByIdStmt.get(row.id));
  }

  function cancel(id, { reason = '', at } = {}) {
    const row = getByIdStmt.get(clean(id));
    if (!row) return null;
    if (row.status !== 'pending') return mapRow(row);
    db.prepare(`
      UPDATE workflow_task SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(clean(at) || new Date().toISOString(), clean(reason) || null, row.id);
    return mapRow(getByIdStmt.get(row.id));
  }

  // 撤销/改判时批量取消某作用域的未完成任务;返回取消的行数。
  // customerIdExact:显式按值匹配 customer_id(含空串)——legacy 组级任务(customer_id='')
  // 与客户级任务同批同组并存,组级撤销绝不能顺手把客户级 pending 一起撤了(复审 HIGH)。
  function cancelPendingByScope({ workspaceKey, customerId, customerIdExact, batchId, groupKey, taskType, reason = '', at } = {}) {
    const where = ["status = 'pending'"];
    const params = [];
    if (clean(workspaceKey)) { where.push('workspace_key = ?'); params.push(clean(workspaceKey)); }
    if (customerIdExact !== undefined) {
      where.push('customer_id = ?');
      params.push(clean(customerIdExact));
    } else if (clean(customerId)) {
      where.push('customer_id = ?');
      params.push(clean(customerId));
    }
    if (clean(batchId)) { where.push('batch_id = ?'); params.push(clean(batchId)); }
    if (clean(groupKey)) { where.push('group_key = ?'); params.push(clean(groupKey)); }
    if (clean(taskType)) { where.push('task_type = ?'); params.push(clean(taskType)); }
    if (params.length === 0) throw new Error('cancelPendingByScope needs at least one scope filter');
    const result = db.prepare(`
      UPDATE workflow_task SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE ${where.join(' AND ')}
    `).run(clean(at) || new Date().toISOString(), clean(reason) || null, ...params);
    return Number(result.changes);
  }

  // 同作用域历史版本数(含 done/cancelled;不含 pending)——服务层用它算下一个确定性版本号。
  function countByScope({ workspaceKey, customerId, batchId, groupKey, taskType } = {}) {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) AS settledCount,
        COUNT(*) AS total
      FROM workflow_task
      WHERE workspace_key = ? AND customer_id = ? AND COALESCE(batch_id, '') = ?
        AND COALESCE(group_key, '') = ? AND task_type = ?
    `).get(clean(workspaceKey), clean(customerId), clean(batchId), clean(groupKey), clean(taskType));
    return {
      pending: Number(row?.pending) || 0,
      settled: Number(row?.settledCount) || 0,
      total: Number(row?.total) || 0,
    };
  }

  function findPendingByScope({ workspaceKey, customerId, batchId, groupKey, taskType } = {}) {
    const row = db.prepare(`
      SELECT * FROM workflow_task
      WHERE status = 'pending' AND workspace_key = ? AND customer_id = ?
        AND COALESCE(batch_id, '') = ? AND COALESCE(group_key, '') = ? AND task_type = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(clean(workspaceKey), clean(customerId), clean(batchId), clean(groupKey), clean(taskType));
    return mapRow(row);
  }

  function list({
    calendarMonth = '',
    workspaceKey = '',
    customerId = '',
    customerIdExact,
    batchId = '',
    groupKey = '',
    agentKey = '',
    taskType = '',
    subtype = '',
    status = '',
    limit = 200,
  } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (clean(calendarMonth)) { where.push('calendar_month = ?'); params.push(clean(calendarMonth)); }
    if (clean(workspaceKey)) { where.push('workspace_key = ?'); params.push(clean(workspaceKey)); }
    if (customerIdExact !== undefined) {
      where.push('customer_id = ?');
      params.push(clean(customerIdExact));
    } else if (clean(customerId)) {
      where.push('customer_id = ?');
      params.push(clean(customerId));
    }
    if (clean(batchId)) { where.push('batch_id = ?'); params.push(clean(batchId)); }
    if (clean(groupKey)) { where.push('group_key = ?'); params.push(clean(groupKey)); }
    if (clean(agentKey)) { where.push('agent_key = ?'); params.push(clean(agentKey)); }
    if (clean(taskType)) { where.push('task_type = ?'); params.push(clean(taskType)); }
    if (clean(subtype)) { where.push('subtype = ?'); params.push(clean(subtype)); }
    if (clean(status)) { where.push('status = ?'); params.push(clean(status)); }
    const capped = Math.max(1, Math.min(Number(limit) || 200, 500));
    return db.prepare(`
      SELECT * FROM workflow_task WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params, capped).map(mapRow);
  }

  function getById(id) {
    return mapRow(getByIdStmt.get(clean(id)));
  }

  function getByKey(taskKey) {
    return mapRow(getByKeyStmt.get(clean(taskKey)));
  }

  return {
    TASK_STATUSES,
    cancel,
    cancelPendingByScope,
    complete,
    countByScope,
    createExpected,
    findPendingByScope,
    getById,
    getByKey,
    list,
  };
}

module.exports = { createWorkflowTaskRepository };
