'use strict';

/**
 * workflow_task_service — 运营任务业务规则(代理工作台 V2 Task 6)。
 *
 * 规则(实施计划 Task6 步骤3-5 + 票级修订③⑥):
 *   - send_upstream(回执/回发)在「组内小票全部表态完成」时创建(修订③,即旧 B5 回执时点;
 *     触发挂点在票级表态写路径,Task 7 接线)。未全表态、无小票、全豁免 → 不生成。
 *   - 旧时效动作 send12/17/18/S活动 映射为 subtype(lib/review_lane sendbackActionOfMode),
 *     非时效模式 subtype='standard'。触发规则不变(确认完成即建)。
 *   - 撤销(票级「改」重开,修订⑥):pending 任务取消;done 任务保留审计不动,
 *     另生成 subtype='correction' 的新任务(通知群里发更正)。
 *   - task_key 确定性:send_upstream:<ws>:<customerId>:<batchId>:<groupKey>:v<N>,
 *     N = 该作用域已了结(done/cancelled)任务数 + 1。重试/重复保存撞同一个 N →
 *     UNIQUE 兜底只有一行;有 pending 在场时直接复用 pending,不开新版本。
 */

const { sendbackActionOfMode } = require('../lib/review_lane');
const { calendarMonthOf, normalizeAgentName } = require('../lib/agent_workspace/customer_projection');

const SEND_UPSTREAM = 'send_upstream';
const DUE_HOURS_DEFAULT = 4; // 与旧回发队列同口径:创建后 N 小时未发标超时

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function createWorkflowTaskService({
  workflowTaskRepository,
  timeZone = process.env.SIGN_BUSINESS_TZ || 'Asia/Seoul',
  dueHours = DUE_HOURS_DEFAULT,
  now = () => new Date(),
  logger = null,
} = {}) {
  if (!workflowTaskRepository) throw new Error('workflowTaskRepository is required');

  function scopeOf({ workspaceKey, customerId, batchId, groupKey }) {
    return {
      workspaceKey: clean(workspaceKey),
      customerId: clean(customerId),
      batchId: clean(batchId),
      groupKey: clean(groupKey),
    };
  }

  function taskKeyOf(scope, version) {
    return `${SEND_UPSTREAM}:${scope.workspaceKey}:${scope.customerId}:${scope.batchId}:${scope.groupKey}:v${version}`;
  }

  /**
   * 组内小票全部表态完成 → 确保存在一个 send_upstream 任务(幂等)。
   * 门槛由调用方(Task 7 协调器)用批次真相算好传入:
   *   receiptCount 组内小票数(不含原图占位);exemptOnly 是否全部豁免;allStanced 是否全部表态。
   * 返回 { task, created, skipped, reason }。
   */
  function ensureSendUpstream({
    workspaceKey,
    customerId,
    batchId = '',
    groupKey = '',
    agentName = '',
    mode = '',
    tourNo = '',
    receiptCount = 0,
    exemptOnly = false,
    allStanced = false,
    subtypeOverride = '',
    createdBy = '',
    receivedAt = '',
  } = {}) {
    if (!clean(workspaceKey) || !clean(customerId)) {
      return { task: null, created: false, skipped: true, reason: 'missing_customer_ref' };
    }
    if (!allStanced) return { task: null, created: false, skipped: true, reason: 'not_all_stanced' };
    if (Number(receiptCount) <= 0) return { task: null, created: false, skipped: true, reason: 'no_receipts' };
    if (exemptOnly) return { task: null, created: false, skipped: true, reason: 'exempt_only' };

    const scope = scopeOf({ workspaceKey, customerId, batchId, groupKey });
    // 有 pending 在场直接复用(重复触发不开新版本)
    const pending = workflowTaskRepository.findPendingByScope({ ...scope, taskType: SEND_UPSTREAM });
    if (pending) return { task: pending, created: false, skipped: false, reason: 'pending_exists' };

    const { settled } = workflowTaskRepository.countByScope({ ...scope, taskType: SEND_UPSTREAM });
    const version = settled + 1;
    const at = now();
    const createdAt = at.toISOString();
    const subtype = clean(subtypeOverride) || sendbackActionOfMode(mode) || 'standard';
    const { task, created } = workflowTaskRepository.createExpected({
      taskKey: taskKeyOf(scope, version),
      calendarMonth: calendarMonthOf(clean(receivedAt) || createdAt, timeZone),
      workspaceKey: scope.workspaceKey,
      customerId: scope.customerId,
      batchId: scope.batchId || null,
      groupKey: scope.groupKey || null,
      agentKey: normalizeAgentName(agentName).agentKey,
      taskType: SEND_UPSTREAM,
      subtype,
      dueAt: new Date(at.getTime() + dueHours * 3600 * 1000).toISOString(),
      payload: { mode: clean(mode), tourNo: clean(tourNo), version },
      createdAt,
      createdBy: clean(createdBy) || null,
    });
    if (created) {
      logger?.info?.('workflow_task_created', {
        taskType: SEND_UPSTREAM, subtype,
        taskKey: task.taskKey, customer: `${scope.workspaceKey}/${scope.customerId}`,
      });
    }
    return { task, created, skipped: false, reason: created ? 'created' : 'exists' };
  }

  /**
   * 票级「改」重开表态(修订⑥):
   *   - pending send_upstream → 取消(内容可能要变,发出去就是错的);
   *   - 已 done → 保留审计,生成 subtype='correction' 的新任务(通知更正)。
   * 返回 { cancelled, correction }。
   */
  function onStanceReopened({
    workspaceKey,
    customerId,
    batchId = '',
    groupKey = '',
    agentName = '',
    mode = '',
    tourNo = '',
    reason = '',
    createdBy = '',
    receivedAt = '',
  } = {}) {
    const scope = scopeOf({ workspaceKey, customerId, batchId, groupKey });
    if (!scope.workspaceKey || !scope.customerId) return { cancelled: 0, correction: null };

    const cancelled = workflowTaskRepository.cancelPendingByScope({
      ...scope,
      taskType: SEND_UPSTREAM,
      reason: clean(reason) || 'stance_reopened',
      at: now().toISOString(),
    });

    let correction = null;
    const { settled, total } = workflowTaskRepository.countByScope({ ...scope, taskType: SEND_UPSTREAM });
    const hasDone = workflowTaskRepository
      .list({ ...scope, taskType: SEND_UPSTREAM, status: 'done', limit: 1 }).length > 0;
    if (hasDone) {
      const at = now();
      const { task, created } = workflowTaskRepository.createExpected({
        taskKey: taskKeyOf(scope, settled + 1),
        calendarMonth: calendarMonthOf(clean(receivedAt) || at.toISOString(), timeZone),
        workspaceKey: scope.workspaceKey,
        customerId: scope.customerId,
        batchId: scope.batchId || null,
        groupKey: scope.groupKey || null,
        agentKey: normalizeAgentName(agentName).agentKey,
        taskType: SEND_UPSTREAM,
        subtype: 'correction',
        dueAt: new Date(at.getTime() + dueHours * 3600 * 1000).toISOString(),
        payload: { mode: clean(mode), tourNo: clean(tourNo), reason: clean(reason) || 'stance_reopened', version: settled + 1 },
        createdAt: at.toISOString(),
        createdBy: clean(createdBy) || null,
      });
      correction = task;
      if (created) {
        logger?.info?.('workflow_task_created', {
          taskType: SEND_UPSTREAM, subtype: 'correction',
          taskKey: task.taskKey, customer: `${scope.workspaceKey}/${scope.customerId}`,
        });
      }
    }
    if (cancelled || correction) {
      logger?.info?.('workflow_task_reopened', {
        cancelled, correction: correction?.taskKey || '',
        customer: `${scope.workspaceKey}/${scope.customerId}`, totalHistory: total,
      });
    }
    return { cancelled, correction };
  }

  // 客户删除 → 未完成任务全取消(架构 §6.5-4)。
  function onCustomerDeleted({ workspaceKey, customerId, reason = 'customer_deleted' } = {}) {
    if (!clean(workspaceKey) || !clean(customerId)) return 0;
    return workflowTaskRepository.cancelPendingByScope({
      workspaceKey: clean(workspaceKey),
      customerId: clean(customerId),
      reason: clean(reason),
      at: now().toISOString(),
    });
  }

  return {
    SEND_UPSTREAM,
    ensureSendUpstream,
    onCustomerDeleted,
    onStanceReopened,
  };
}

module.exports = { createWorkflowTaskService, SEND_UPSTREAM };
