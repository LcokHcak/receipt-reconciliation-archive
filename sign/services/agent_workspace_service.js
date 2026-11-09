'use strict';

/**
 * agent_workspace_service — 代理工作台 API 业务层(V2 Task 8)。
 *
 * 权限矩阵(架构§8):
 *   - admin/finance 全局可见;finance V1 只读,complete 一律 403;
 *   - reviewer 沿用 operator_scope,只看自己 owner 的客户与任务,传别人 ownerUserId 不能扩大;
 *   - summary/agents/customers/tasks 四个查询共用同一个 scope builder(buildAgentWorkspaceScope)。
 *
 * 契约(架构§7):月份必填且 YYYY-MM(非法 400 invalid_month);reviewStatus 白名单
 * (非法 400 invalid_review_status);limit 钳制在仓库层;cursor base64url 校验失败按"无游标"。
 * 响应带 projectionLag/warnings,不暴露服务器路径与原始 JSON payload。
 */

const { AppError } = require('../lib/errors');
const {
  buildAgentWorkspaceScope,
  canCompleteWorkflowTask,
  canAccessAllOperatorData,
} = require('../lib/operator_scope');
const { STATUS_PRIORITY } = require('../lib/agent_workspace/status_policy');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function createAgentWorkspaceService({
  agentWorkspaceRepository,
  workflowTaskRepository,
  db,
  now = () => new Date(),
  logger = null,
} = {}) {
  if (!agentWorkspaceRepository) throw new Error('agentWorkspaceRepository is required');
  if (!workflowTaskRepository) throw new Error('workflowTaskRepository is required');
  if (!db) throw new Error('db is required');

  const statusSet = new Set(STATUS_PRIORITY);

  // P1 搜索台账反查(晚绑定:monthlyDb 在 server 启动晚于本服务创建,照 setGroupCodePrematchService 模式)
  let ledgerSearchLookup = null;
  function setLedgerSearchLookup(fn) {
    ledgerSearchLookup = typeof fn === 'function' ? fn : null;
  }

  function requireMonth(raw) {
    const month = clean(raw);
    if (!MONTH_RE.test(month)) {
      throw new AppError('月份参数无效(YYYY-MM)', { status: 400, code: 'invalid_month' });
    }
    return month;
  }

  function scopeOf(user, query = {}) {
    return buildAgentWorkspaceScope(user, { requestedOwnerUserId: query.ownerUserId });
  }

  // 投影新鲜度 + 数据质量提示(不暴露路径/payload)。
  function projectionMeta() {
    try {
      const row = db.prepare(`
        SELECT
          MAX(projected_at) AS latest,
          SUM(CASE WHEN calendar_month = '' THEN 1 ELSE 0 END) AS unknown_month,
          SUM(CASE WHEN agent_unlabeled = 1 THEN 1 ELSE 0 END) AS unlabeled
        FROM agent_workspace_customer
      `).get();
      const latestMs = Date.parse(String(row?.latest || ''));
      return {
        projectionLagMs: Number.isFinite(latestMs) ? Math.max(0, now().getTime() - latestMs) : null,
        warnings: {
          unknownMonthCustomers: Number(row?.unknown_month) || 0,
          unlabeledAgentCustomers: Number(row?.unlabeled) || 0,
        },
      };
    } catch {
      return { projectionLagMs: null, warnings: { unknownMonthCustomers: 0, unlabeledAgentCustomers: 0 } };
    }
  }

  // 有数据的月份(前端"默认最近有数据月份"用;禁止从 workspaceKey 推导)。
  function listMonths() {
    const rows = db.prepare(`
      SELECT calendar_month AS m, COUNT(*) AS n
      FROM agent_workspace_customer
      WHERE calendar_month != ''
      GROUP BY calendar_month ORDER BY calendar_month DESC LIMIT 24
    `).all();
    return rows.map((r) => ({ month: r.m, customers: Number(r.n) }));
  }

  // 当日边界(Asia/Seoul 午夜)的 UTC ISO,供"今日新增"计数。韩国无夏令时,恒 UTC+9。
  function seoulTodayStartIso() {
    const seoulNow = new Date(now().getTime() + 9 * 3600 * 1000);
    const utcMidnightOfSeoulDay = Date.UTC(
      seoulNow.getUTCFullYear(), seoulNow.getUTCMonth(), seoulNow.getUTCDate(),
    ) - 9 * 3600 * 1000;
    return new Date(utcMidnightOfSeoulDay).toISOString();
  }

  // 按日筛选(2026-07-24 用户修改①):把 'YYYY-MM-DD'(KST 日历日)换成 [起, 止) 的 UTC ISO,
  // 与 received_at(收票/建档时刻)比较。非法日期=null(不过滤)。韩国恒 UTC+9,无夏令时。
  function seoulDayRangeIso(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(day));
    if (!m) return null;
    const startUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600 * 1000;
    return {
      startIso: new Date(startUtcMs).toISOString(),
      endIso: new Date(startUtcMs + 24 * 3600 * 1000).toISOString(),
    };
  }

  function getSummary(user, query = {}) {
    const month = requireMonth(query.month);
    const scope = scopeOf(user, query);
    const agentKey = clean(query.agentKey);
    // 按日筛选(2026-07-27 需求E②):选了某日 → 统计窗口整体收窄到那天,卡片与下方列表同源;
    // 「今日新增/今日已审」的窗口也换成那天(前端据 day 把标签改成「当日…」)。未选日=原样看今天。
    const dayRange = seoulDayRangeIso(query.day);
    const window = dayRange
      ? {
        todayStartIso: dayRange.startIso,
        todayEndIso: dayRange.endIso,
        receivedFromIso: dayRange.startIso,
        receivedToIso: dayRange.endIso,
      }
      : { todayStartIso: seoulTodayStartIso() };
    const visibleAll = agentWorkspaceRepository.summary({ month, ownerUserId: scope.ownerUserId, ...window });
    const selectedAgent = agentKey
      ? agentWorkspaceRepository.summary({ month, ownerUserId: scope.ownerUserId, agentKey, ...window })
      : null;
    return { month, day: dayRange ? clean(query.day) : '', visibleAll, selectedAgent, ...projectionMeta() };
  }

  function listAgents(user, query = {}) {
    const month = requireMonth(query.month);
    const scope = scopeOf(user, query);
    const { rows } = agentWorkspaceRepository.listAgents({
      month,
      ownerUserId: scope.ownerUserId,
      search: clean(query.search),
      limit: query.limit,
    });
    return { month, agents: rows };
  }

  function listCustomers(user, query = {}) {
    const month = requireMonth(query.month);
    const reviewStatus = clean(query.reviewStatus);
    if (reviewStatus && !statusSet.has(reviewStatus)) {
      throw new AppError('审核状态筛选无效', { status: 400, code: 'invalid_review_status' });
    }
    const scope = scopeOf(user, query);
    // 一键搜索(2026-07-24 全量化):护照/票号/团号跨库反查——晚绑定函数返回两路
    // { customerIds(台账已结算), groupKeys(工作台镜像在途/未结算) },并集覆盖全部客户。
    // 向后兼容旧返回(纯数组=customerIds);未注入/查询失败=空集,退化为只搜姓名/客户号,不炸。
    const search = clean(query.search).slice(0, 60);
    let searchExtraIds = [];
    let searchExtraGroupKeys = [];
    if (search && typeof ledgerSearchLookup === 'function') {
      try {
        const r = ledgerSearchLookup({ month, term: search });
        if (Array.isArray(r)) {
          searchExtraIds = r;
        } else if (r && typeof r === 'object') {
          searchExtraIds = Array.isArray(r.customerIds) ? r.customerIds : [];
          searchExtraGroupKeys = Array.isArray(r.groupKeys) ? r.groupKeys : [];
        }
      } catch { searchExtraIds = []; searchExtraGroupKeys = []; }
    }
    const dayRange = seoulDayRangeIso(query.day); // 按日筛选(收票/建档日,KST)
    const { rows, nextCursor } = agentWorkspaceRepository.listCustomers({
      month,
      ownerUserId: scope.ownerUserId,
      agentKey: clean(query.agentKey),
      mode: clean(query.mode),
      reviewStatus,
      limit: query.limit,
      cursor: clean(query.cursor),
      search,
      searchExtraIds,
      searchExtraGroupKeys,
      receivedFromIso: dayRange ? dayRange.startIso : '',
      receivedToIso: dayRange ? dayRange.endIso : '',
    });
    // 不返回原始 payload/服务器路径;行本身就是读模型瘦身列
    return { month, customers: rows, nextCursor };
  }

  // reviewer 任务可见域 = 自己客户的任务(join 读模型 owner);legacy 组级任务(customer_id='')
  // 无 owner 归属,只对 admin/finance 可见。
  function listTasks(user, query = {}) {
    const month = requireMonth(query.month);
    const scope = scopeOf(user, query);
    const status = clean(query.status);
    if (status && !['pending', 'done', 'cancelled'].includes(status)) {
      throw new AppError('任务状态筛选无效', { status: 400, code: 'invalid_task_status' });
    }
    const includeCarryover = clean(query.includeCarryover) !== 'false';
    const where = [];
    const params = [];
    if (includeCarryover) {
      // 当月全部 + 往月仍 pending 的遗留
      where.push("(wt.calendar_month = ? OR (wt.status = 'pending' AND wt.calendar_month < ?))");
      params.push(month, month);
    } else {
      where.push('wt.calendar_month = ?');
      params.push(month);
    }
    if (clean(query.agentKey)) { where.push('wt.agent_key = ?'); params.push(clean(query.agentKey)); }
    if (status) { where.push('wt.status = ?'); params.push(status); }
    // 按「屏幕上这一页的客户」收窄(0731 核账 #16)。
    // 不收窄的话:客户列表按 received_at DESC 排、任务按 due_at ASC 排 + 硬顶 50,
    // 两个排序相反 → 当月 pending 一超 50,第一页(最新收的)客户的任务全落在 50 之外,
    // 那一格渲染成空白,而空白的界面语义是「没有任务,不用管」——**含义正好相反**。
    // ⚠️ 空数组按「没指定」处理:客户还没加载完那一瞬间不能把所有任务格刷成空(又一次假空白)。
    // 路由直接透传 req.query,所以这里三种形态都要认:数组(服务层直调)、
    // 逗号串(URL 常规写法)、重复参数(express 会给数组,已被第一种覆盖)。
    const rawIds = query.customerIds;
    const customerIds = (Array.isArray(rawIds) ? rawIds : String(rawIds || '').split(','))
      .map(clean).filter(Boolean).slice(0, 500);
    if (customerIds.length) {
      where.push(`wt.customer_id IN (${customerIds.map(() => '?').join(',')})`);
      params.push(...customerIds);
    }

    let joinSql = '';
    if (scope.ownerUserId !== null) {
      joinSql = `JOIN agent_workspace_customer c
        ON c.workspace_key = wt.workspace_key AND c.customer_id = wt.customer_id`;
      where.push('c.owner_user_id = ?');
      params.push(scope.ownerUserId);
    }
    // 收窄到具体客户之后集合天然有界(一页 50 个客户的 pending 任务不会成千上万),
    // 所以放宽上限,避免"收窄了却仍被 50 截断"这种换汤不换药。
    const defaultLimit = customerIds.length ? Math.min(customerIds.length * 20, 1000) : 50;
    const capped = Math.max(1, Math.min(Number(query.limit) || defaultLimit, 1000));
    const rows = db.prepare(`
      SELECT wt.* FROM workflow_task wt
      ${joinSql}
      WHERE ${where.join(' AND ')}
      ORDER BY wt.status = 'pending' DESC, wt.due_at ASC, wt.created_at DESC
      LIMIT ?
    `).all(...params, capped);
    const nowMs = now().getTime();
    const tasks = rows.map((row) => ({
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
      dueAt: row.due_at,
      overdue: row.status === 'pending' && Number.isFinite(Date.parse(row.due_at)) && Date.parse(row.due_at) < nowMs,
      mode: (() => { try { return String(JSON.parse(row.payload_json || '{}').mode || ''); } catch { return ''; } })(),
      tourNo: (() => { try { return String(JSON.parse(row.payload_json || '{}').tourNo || ''); } catch { return ''; } })(),
      createdAt: row.created_at,
      createdBy: row.created_by,
      completedAt: row.completed_at,
      completedBy: row.completed_by,
      sourceVersion: Number(row.source_version) || 1,
    }));
    return { month, tasks };
  }

  function completeTask(user, taskId, { note = '', expectedVersion } = {}) {
    if (!canCompleteWorkflowTask(user)) {
      throw new AppError('当前角色只读,不能完成任务', { status: 403, code: 'workspace_read_only' });
    }
    const task = workflowTaskRepository.getById(taskId);
    if (!task) throw new AppError('任务不存在', { status: 404, code: 'task_not_found' });

    // reviewer 只能完成自己客户的任务(legacy 组级任务无 owner → reviewer 拒)
    if (!canAccessAllOperatorData(user)) {
      const row = task.customerId
        ? agentWorkspaceRepository.getCustomer(`${task.workspaceKey}::${task.customerId}`)
        : null;
      const scope = buildAgentWorkspaceScope(user, {});
      if (!row || String(row.ownerUserId) !== String(scope.ownerUserId)) {
        throw new AppError('无权完成该任务', { status: 403, code: 'task_forbidden' });
      }
    }

    if (task.status === 'cancelled') {
      throw new AppError('任务已取消,不能完成', { status: 409, code: 'task_cancelled' });
    }
    if (expectedVersion !== undefined && expectedVersion !== null && clean(expectedVersion) !== '') {
      const expected = Number(expectedVersion);
      if (!Number.isFinite(expected) || expected !== task.sourceVersion) {
        throw new AppError('任务版本冲突,请刷新后重试', { status: 409, code: 'task_version_conflict' });
      }
    }
    if (task.status === 'done') {
      return { task, idempotent: true }; // 重复完成:返回当前结果,不重复写事件
    }
    const done = workflowTaskRepository.complete(task.id, {
      by: clean(user?.username) || null,
      at: now().toISOString(),
      note: clean(note),
    });
    logger?.info?.('workflow_task_completed', {
      taskKey: done.taskKey, by: clean(user?.username),
    });
    return { task: done, idempotent: false };
  }

  return {
    completeTask,
    getSummary,
    listAgents,
    listCustomers,
    listMonths,
    listTasks,
    setLedgerSearchLookup,
  };
}

module.exports = { createAgentWorkspaceService };
