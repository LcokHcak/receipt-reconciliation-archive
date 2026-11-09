'use strict';

/**
 * sendback_queue_repository — 回发队列(2026-07-10,P3;2026-07-12 V2 Task6 改兼容 adapter)。
 *
 * 发12/17/18号、S活动等时效模式:确认站确认即入队,人肉发到群、系统记账(谁发的/几点/超时红签)。
 * 不做微信集成(合规),只做记账与看板。
 *
 * 两种模式:
 *   - 传入 workflowTaskRepository → adapter 模式:读写 workbench.sqlite 的 workflow_task 表
 *     (task_type='send_upstream'),旧 API 形状不变;不再碰 JSON 文件,不双写。
 *     ⚠️ 切 adapter 模式前必须先跑 scripts/migrate_sendback_queue.js --apply,
 *     否则 JSON 里的未完成回发在看板上会消失(数据还在文件里,但界面读的是新表)。
 *   - 不传 → 旧行为:storage/sendback_queue.json,进程内互斥+tmp+rename 原子替换。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DUE_HOURS_DEFAULT = 4; // 超时红签阈值:确认后 N 小时没发就标红

// adapter 模式下旧“确认即入队”的确定性幂等键(组级触发,无 customerId)。
// 带版本号(复审 HIGH):旧 JSON 语义是"有未了结的同款才去重,了结后可再入队"——
// 撤销确认→重新确认(同动作)必须能产生新的待发提醒;固定 key 会被 done/cancelled
// 行的 ON CONFLICT 永久吞掉。
function legacyLiveTaskKey({ batchId, groupKey, action }, version) {
  return `legacy_sendback_live:${String(batchId || '')}:${String(groupKey || '')}:${String(action || '')}:v${version}`;
}

// workflow_task 行 → 旧回发条目形状(前端/handlers 不感知切换)。
function taskToLegacyItem(task, nowMs) {
  if (!task) return null;
  const payload = task.payload || {};
  return {
    id: task.id,
    batchId: String(task.batchId || ''),
    groupKey: String(task.groupKey || ''),
    workspaceKey: String(task.workspaceKey || payload.legacyWorkspaceKey || ''),
    action: String(task.subtype || ''),
    mode: String(payload.mode || ''),
    tourNo: String(payload.tourNo || ''),
    status: task.status,
    createdAt: String(task.createdAt || ''),
    createdBy: String(task.createdBy || ''),
    dueAt: String(task.dueAt || ''),
    sentBy: String(task.completedBy || ''),
    sentAt: String(task.completedAt || ''),
    note: String(payload.note || task.cancelReason || ''),
    overdue: task.status === 'pending' && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) < nowMs,
  };
}

function createSendbackQueueRepository({
  storageRoot,
  dueHours = DUE_HOURS_DEFAULT,
  now = () => new Date(),
  workflowTaskRepository = null,
} = {}) {
  if (!storageRoot) throw new Error('storageRoot is required');

  // ── adapter 模式:workflow_task 表是唯一真相 ─────────────────────────────
  // 双路径过渡期边界(复审 HIGH):组级(customer_id='',本 adapter/确认站)与客户级
  // (真实 customerId,票级协调器)任务同批同组并存。回发看板只展示组级行,撤销也只
  // 动组级行——两个面向各看各的,数据层双轨是过渡设计(退役组级路径前不要合并)。
  if (workflowTaskRepository) {
    const legacyScopeOf = (batchId, groupKey, action) => ({
      customerIdExact: '',
      batchId: String(batchId || ''),
      groupKey: String(groupKey || ''),
      taskType: 'send_upstream',
      ...(action !== undefined ? { subtype: String(action || '') } : {}),
    });
    return {
      async enqueue({ batchId, groupKey, workspaceKey = '', action, mode = '', tourNo = '', createdAt = '', createdBy = '' }) {
        const nowMs = now().getTime();
        const scope = legacyScopeOf(batchId, groupKey, action);
        // 旧语义:同批同组同动作有"未了结"的 → 复用;了结的不挡新入队(版本推进)
        const existing = workflowTaskRepository.list({ ...scope, status: 'pending', limit: 1 });
        if (existing.length) return taskToLegacyItem(existing[0], nowMs);
        const settled = workflowTaskRepository.list({ ...scope, limit: 500 }).length;
        const at = createdAt || now().toISOString();
        const { task } = workflowTaskRepository.createExpected({
          taskKey: legacyLiveTaskKey({ batchId, groupKey, action }, settled + 1),
          calendarMonth: '', // 组级触发无客户上下文;客户级任务由 workflow_task_service 建
          workspaceKey: String(workspaceKey || ''),
          customerId: '',
          batchId: String(batchId || '') || null,
          groupKey: String(groupKey || '') || null,
          agentKey: '',
          taskType: 'send_upstream',
          subtype: String(action || ''),
          dueAt: new Date(new Date(at).getTime() + dueHours * 3600 * 1000).toISOString(),
          payload: { mode: String(mode || ''), tourNo: String(tourNo || ''), legacyWorkspaceKey: String(workspaceKey || '') },
          createdAt: at,
          createdBy: String(createdBy || '') || null,
        });
        return taskToLegacyItem(task, nowMs);
      },
      async markDone(id, { operator = '', note = '' } = {}) {
        const task = workflowTaskRepository.complete(id, { by: operator, note, at: now().toISOString() });
        return taskToLegacyItem(task, now().getTime());
      },
      async cancelByGroup(batchId, groupKey, { note = '' } = {}) {
        // 只撤组级行:客户级 pending 是票级表态流程独立产生的,与组级撤销无关
        return workflowTaskRepository.cancelPendingByScope({
          ...legacyScopeOf(batchId, groupKey),
          reason: String(note || 'group_cancelled'),
          at: now().toISOString(),
        });
      },
      async list({ workspaceKey = '', status = '' } = {}) {
        const nowMs = now().getTime();
        const tasks = workflowTaskRepository.list({
          taskType: 'send_upstream',
          customerIdExact: '', // 看板只看组级行,客户级任务归代理工作台 tasks 面板
          workspaceKey: String(workspaceKey || '').trim(),
          status: String(status || '').trim(),
          limit: 500,
        });
        return tasks.map((task) => taskToLegacyItem(task, nowMs));
      },
    };
  }

  // ── 旧模式:JSON 文件 ─────────────────────────────────────────────────────
  const file = path.join(storageRoot, 'sendback_queue.json');
  let writeChain = Promise.resolve(); // 进程内互斥:所有写串行

  async function readAll() {
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function writeAll(items) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(items, null, 1));
    await fsp.rename(tmp, file);
  }

  function withLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  }

  // 入队(同组同动作幂等:已有未完成同款则不重复入)。
  function enqueue({ batchId, groupKey, workspaceKey = '', action, mode = '', tourNo = '', createdAt = '', createdBy = '' }) {
    return withLock(async () => {
      const items = await readAll();
      const dup = items.find((it) => it.batchId === batchId && it.groupKey === groupKey
        && it.action === action && it.status !== 'done' && it.status !== 'cancelled');
      if (dup) return dup;
      const at = createdAt || now().toISOString();
      const item = {
        id: `sb_${crypto.randomUUID().slice(0, 8)}`,
        batchId: String(batchId || ''),
        groupKey: String(groupKey || ''),
        workspaceKey: String(workspaceKey || ''),
        action: String(action || ''),
        mode: String(mode || ''),
        tourNo: String(tourNo || ''),
        status: 'pending', // pending → done;cancelled(撤销确认时);更正通知=新条目 action 带 correction_
        createdAt: at,
        createdBy: String(createdBy || ''),
        dueAt: new Date(new Date(at).getTime() + dueHours * 3600 * 1000).toISOString(),
        sentBy: '',
        sentAt: '',
        note: '',
      };
      items.push(item);
      await writeAll(items);
      return item;
    });
  }

  function markDone(id, { operator = '', note = '' } = {}) {
    return withLock(async () => {
      const items = await readAll();
      const item = items.find((it) => it.id === id);
      if (!item) return null;
      item.status = 'done';
      item.sentBy = String(operator || '');
      item.sentAt = now().toISOString();
      if (note) item.note = String(note);
      await writeAll(items);
      return item;
    });
  }

  function cancelByGroup(batchId, groupKey, { note = '' } = {}) {
    return withLock(async () => {
      const items = await readAll();
      let n = 0;
      for (const it of items) {
        if (it.batchId === batchId && it.groupKey === groupKey && it.status === 'pending') {
          it.status = 'cancelled';
          if (note) it.note = String(note);
          n += 1;
        }
      }
      if (n) await writeAll(items);
      return n;
    });
  }

  async function list({ workspaceKey = '', status = '' } = {}) {
    const items = await readAll();
    const ws = String(workspaceKey || '').trim();
    const st = String(status || '').trim();
    const nowMs = now().getTime();
    return items
      .filter((it) => (!ws || it.workspaceKey === ws) && (!st || it.status === st))
      .map((it) => ({ ...it, overdue: it.status === 'pending' && Date.parse(it.dueAt) < nowMs }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  return { enqueue, markDone, cancelByGroup, list };
}

module.exports = { createSendbackQueueRepository };
