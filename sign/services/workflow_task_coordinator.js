'use strict';

/**
 * workflow_task_coordinator — 票级表态写路径 → 运营任务对账(V2 Task 7,修订④)。
 *
 * 挂点:services/workbench_write/task.js 的 updateTask,主写(saveBatchAsync)落盘之后。
 * V2 文档原稿把协调器挂在组级 confirm-tour;票级两步流拍板后,组级确认已退化为兼容路径,
 * 真相在票上——所以对账跟着票级表态走(修订④),规则本身在 workflow_task_service(修订③⑥)。
 *
 * 触发判定(用同一份 buildReviewOverlay 口径,禁止另写副本):
 *   - 本次写把客户组从「有未表态小票」推到「全部表态」→ ensureSendUpstream(幂等);
 *     只认转变沿,不认状态本身——否则 done 之后随手改个字段都会开新版本任务。
 *   - 本次写把某张已表态小票清回未表态(票级「改」/ B2 改团号清表态)→ onStanceReopened
 *     (pending 取消;done 保留并生成 correction)。
 *
 * 失败语义(计划步骤2/3):任务表失败绝不回滚已落盘的批次主写;失败记 retry 环形队列
 * (getRetryItems 供诊断/后台补齐)+ 结构化日志 workflow_task_reconcile_failed,不伪装成功。
 */

const {
  buildReviewOverlay,
  parseTaskCustomerRef,
} = require('../lib/agent_workspace/customer_projection');
const { sendbackActionOfMode } = require('../lib/review_lane');
const { ROOT_SOURCE_GROUP_KEY } = require('../lib/source_group_utils');
const { resolveTaskModeRule } = require('../lib/workbench_receipt_export');

const RETRY_RING_MAX = 200;

function buildSendUpstreamContext(batch, ref, tasks, operator) {
  let mode;
  let subtypeOverride = '';
  let tourNo = '';
  let agentName = '';
  const modes = [];
  for (const t of tasks) {
    if (!agentName && clean(t.customerAgentName)) agentName = clean(t.customerAgentName);
    if (clean(t.tourStance) !== 'matched') continue;
    // 任务级模式单源(复核MEDIUM,2026-07-20):此前手抄"人选||快照"第三副本,
    // 百货常量/机场推断吃不到,全百货组上游任务恒丢模式标签
    const m = clean(resolveTaskModeRule(t).mode);
    if (m && !modes.includes(m)) modes.push(m);
    if (!tourNo && clean(t.groupNoFinal)) tourNo = clean(t.groupNoFinal);
  }
  mode = modes.join('+');
  for (const m of modes) {
    const action = sendbackActionOfMode(m);
    if (action) { subtypeOverride = action; break; } // 多模式客户:任一时效动作优先
  }
  return {
    workspaceKey: ref.workspaceKey,
    customerId: ref.customerId,
    batchId: clean(batch.id),
    groupKey: clean(tasks[0]?.sourceGroupKey) || ROOT_SOURCE_GROUP_KEY, // 与 buildBatchOverlayEntries 同口径(复核 LOW)
    agentName,
    mode,
    tourNo,
    subtypeOverride,
    createdBy: clean(operator),
  };
}


function clean(value) {
  return String(value == null ? '' : value).trim();
}

function sameCustomer(a, b) {
  return a && b && a.workspaceKey === b.workspaceKey && a.customerId === b.customerId;
}

function createWorkflowTaskCoordinator({ workflowTaskService, logger = null } = {}) {
  if (!workflowTaskService) throw new Error('workflowTaskService is required');
  const retryItems = [];

  function recordFailure(error, context) {
    retryItems.push({
      at: new Date().toISOString(),
      event: context?.event || 'afterTaskWrite',
      customer: context?.customer || '',
      message: String(error?.message || error),
    });
    if (retryItems.length > RETRY_RING_MAX) retryItems.splice(0, retryItems.length - RETRY_RING_MAX);
    logger?.warn?.('workflow_task_reconcile_failed', {
      hook: context?.event,
      customer: context?.customer,
      error: String(error?.message || error),
    });
  }

  // 客户在批次里的任务子集(一次线性扫描;before 视图用内存换票,不再扫第二遍——
  // 复审 MEDIUM:PATCH 热路径上 syncBatch 已有一次 O(n),这里不许再叠两次)。
  function collectCustomerTasks(batch, ref) {
    const tasks = [];
    for (const t of batch.tasks || []) {
      if (sameCustomer(parseTaskCustomerRef(t), ref)) tasks.push(t);
    }
    return tasks;
  }

  /**
   * 主写落盘后调用(advisory)。previousTask/task 是同一张票的前后快照(normalize 后)。
   * 返回 {sent, reopened} 便于测试断言;失败吞掉记 retry,绝不抛。
   */
  function afterTaskWrite({ batch, previousTask, task, operator = '' } = {}) {
    try {
      const ref = parseTaskCustomerRef(task);
      if (!ref) return { sent: null, reopened: null }; // 直传批次无客户引用:组级兼容路径负责

      const prevStance = clean(previousTask?.tourStance);
      const nextStance = clean(task?.tourStance);

      // ── 重开沿:已表态 → 未表态(票级「改」/ B2 改团号清表态)──────────────
      if (prevStance && !nextStance) {
        const tasks = collectCustomerTasks(batch, ref);
        const ctx = buildSendUpstreamContext(batch, ref, tasks, operator);
        const reopened = workflowTaskService.onStanceReopened({
          ...ctx,
          mode: ctx.mode || clean(resolveTaskModeRule(previousTask || {}).mode),
          tourNo: ctx.tourNo || clean(previousTask?.groupNoFinal),
          reason: 'stance_reopened',
        });
        return { sent: null, reopened };
      }

      // ── 完成沿:组的"未表态小票数"从 >0 掉到 0 ─────────────────────────────
      // 用 stanceLockedCount 差值而非 tourStance 字段差值(复审 MEDIUM):
      // 表态之外,改店名成百货/改团号成"无"/改类型,也能把最后一张待表态票变豁免——
      // 这些路径同样要触发送达任务,否则该组提醒永久漏建。
      const tasksAfter = collectCustomerTasks(batch, ref);
      if (tasksAfter.length) {
        const tasksBefore = tasksAfter.map((t) => (t.id === task.id ? (previousTask || t) : t));
        const before = buildReviewOverlay({ tasks: tasksBefore });
        const after = buildReviewOverlay({ tasks: tasksAfter });
        if (before.stanceLockedCount > 0 && after.stanceLockedCount === 0) {
          const ctx = buildSendUpstreamContext(batch, ref, tasksAfter, operator);
          const sent = workflowTaskService.ensureSendUpstream({
            ...ctx,
            receiptCount: after.receiptCount,
            exemptOnly: after.nonExemptReceiptCount === 0,
            allStanced: true,
          });
          return { sent, reopened: null };
        }
      }
      return { sent: null, reopened: null };
    } catch (error) {
      recordFailure(error, {
        event: 'afterTaskWrite',
        customer: `${clean(task?.sourceOriginalPath).split(/[\\/]/).slice(0, 2).join('/')}`,
      });
      return { sent: null, reopened: null, failed: true };
    }
  }

  return {
    afterTaskWrite,
    getRetryItems() {
      return [...retryItems];
    },
  };
}

module.exports = { createWorkflowTaskCoordinator, buildSendUpstreamContext };
