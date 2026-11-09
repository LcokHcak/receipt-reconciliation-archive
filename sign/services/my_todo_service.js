const { filterBatchesByOperator } = require('../lib/operator_scope');

const ROLE_TODO_KEYS = Object.freeze({
  admin: ['classification', 'fields', 'signature', 'finalReview'],
  // reviewer 必须含 finalReview(2026-07-19 全链路审计 HIGH):单任务确认(PATCH)本就是
  // fieldReview 权限,reviewer 日常在清这个桶;不算进待办的话,"只剩终审"的批次会同时
  // 从审核员首页的「我的批次」(不算待办)和「最近完成」(isBatchCompleted 判未完)消失。
  reviewer: ['classification', 'fields', 'signature', 'finalReview'],
  finance: ['finalReview'],
});

const TODO_STAGE_LABELS = Object.freeze({
  classification: '图片确认',
  fields: '字段审核',
  signature: '签字审核',
  finalReview: '终审导出',
});

function countForStage(batch, stageKey) {
  const counts = batch?.counts || {};
  return Number(counts[stageKey] || 0);
}

function totalForBatch(batch) {
  const counts = batch?.counts || {};
  return Number(
    batch?.fileCount
    || batch?.taskCount
    || counts.total
    || 0,
  );
}

function approvedForBatch(batch) {
  const counts = batch?.counts || {};
  return Number(batch?.approvedCount || counts.approved || 0);
}

function resolveStageKeys(role) {
  if (!role) {
    return [];
  }
  return ROLE_TODO_KEYS[role] || [];
}

function buildMyTodos({ batches = [], role = 'reviewer' } = {}) {
  const stageKeys = resolveStageKeys(role);
  const todos = [];
  let totalPending = 0;

  for (const batch of batches) {
    if (!batch) {
      continue;
    }
    const batchId = batch.id || batch.batchId || '';
    if (!batchId) {
      continue;
    }
    let batchPending = 0;
    const byStage = {};
    for (const stageKey of stageKeys) {
      const count = countForStage(batch, stageKey);
      if (count > 0) {
        byStage[stageKey] = count;
        batchPending += count;
      }
    }
    if (batchPending === 0) {
      continue;
    }
    totalPending += batchPending;

    const primaryStage = stageKeys.find((key) => byStage[key]) || stageKeys[0] || 'fields';

    todos.push({
      batchId,
      batchName: batch.name || batchId,
      updatedAt: batch.updatedAt || batch.createdAt || '',
      totalFiles: totalForBatch(batch),
      approvedFiles: approvedForBatch(batch),
      pendingCount: batchPending,
      primaryStage,
      primaryStageLabel: TODO_STAGE_LABELS[primaryStage] || primaryStage,
      stages: Object.entries(byStage).map(([stageKey, count]) => ({
        stage: stageKey,
        label: TODO_STAGE_LABELS[stageKey] || stageKey,
        count,
      })),
    });
  }

  todos.sort((a, b) => {
    if (a.pendingCount !== b.pendingCount) {
      return b.pendingCount - a.pendingCount;
    }
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return {
    role,
    totalPending,
    stages: stageKeys.map((stageKey) => ({
      stage: stageKey,
      label: TODO_STAGE_LABELS[stageKey] || stageKey,
      count: todos.reduce((sum, todo) => {
        const match = todo.stages.find((entry) => entry.stage === stageKey);
        return sum + (match ? match.count : 0);
      }, 0),
    })),
    todos,
  };
}

function createMyTodoService({ listBatches }) {
  if (typeof listBatches !== 'function') {
    throw new Error('createMyTodoService requires listBatches');
  }
  return {
    async getMyTodos({ role = 'reviewer', operatorUser = null } = {}) {
      const batches = await listBatches();
      return buildMyTodos({
        batches: filterBatchesByOperator(batches, operatorUser),
        role,
      });
    },
  };
}

module.exports = {
  buildMyTodos,
  createMyTodoService,
  ROLE_TODO_KEYS,
  TODO_STAGE_LABELS,
};
