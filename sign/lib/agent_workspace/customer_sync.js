'use strict';

/**
 * 代理工作台 V2 — 客户档案 → 读模型 的增量投影胶水(Task 3)。
 *
 * 由 workbench_server 装配:customer_library_repository 的 projectionHooks 指到这里。
 * 职责边界:只做锚点投影(代理/owner/时间/图片数);审核覆盖层由批次同步负责(Task 4)。
 * 失败语义:钩子内部错误由仓库层 safeProjectionHook 吞掉转 onError——这里把失败记成
 * 可检索的 retry 项(内存环形队列 + 结构化日志),后台 reconciler(Task 5 重建)可补齐;
 * 绝不阻断客户 JSON 主写入。
 */

const { buildCustomerAnchor, customerPkOf } = require('./customer_projection');

const RETRY_RING_MAX = 200;

function createCustomerProjectionHooks({
  agentWorkspaceRepository,
  timeZone = process.env.SIGN_BUSINESS_TZ || 'Asia/Seoul',
  logger = null,
} = {}) {
  if (!agentWorkspaceRepository) throw new Error('agentWorkspaceRepository is required');
  const retryItems = [];

  function recordFailure(error, context) {
    retryItems.push({
      at: new Date().toISOString(),
      event: context?.event || 'unknown',
      customerPk: context?.payload?.customerId
        ? customerPkOf(context.payload.workspaceKey || context.payload.monthKey || '', context.payload.customerId)
        : '',
      message: String(error?.message || error),
    });
    if (retryItems.length > RETRY_RING_MAX) retryItems.splice(0, retryItems.length - RETRY_RING_MAX);
    logger?.warn?.('agent_workspace_projection_failed', {
      hook: context?.event,
      customerPk: retryItems[retryItems.length - 1].customerPk,
      error: String(error?.message || error),
    });
  }

  return {
    afterCustomerSaved(record) {
      const anchor = buildCustomerAnchor({
        customer: record,
        workspaceKey: record?.workspaceKey || record?.monthKey || '',
        timeZone,
      });
      // 软删墓碑不进读模型(listCustomers 同口径)
      if (record?.deletedAt) {
        agentWorkspaceRepository.deleteCustomer(anchor.customerPk);
        return;
      }
      agentWorkspaceRepository.upsertCustomerAnchor(anchor);
    },
    afterCustomerDeleted({ workspaceKey, customerId }) {
      agentWorkspaceRepository.deleteCustomer(customerPkOf(workspaceKey, customerId));
    },
    onError: recordFailure,
    getRetryItems() {
      return [...retryItems];
    },
  };
}

module.exports = { createCustomerProjectionHooks };
