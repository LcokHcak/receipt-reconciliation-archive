'use strict';

const { STAGE_LABELS, STAGE_STATUS_LABELS } = require('./common');

function createOperationSnapshots(stageJobRepo) {
  function buildOperationSnapshots({ workspaceKey }) {
    if (!stageJobRepo || typeof stageJobRepo.listRecent !== 'function') return [];
    return stageJobRepo.listRecent({ workspaceKey, limit: 20 }).map((job) => ({
      id: job.id,
      stage: job.stage,
      stageLabel: STAGE_LABELS[job.stage] || job.stage || '月度任务',
      status: job.status,
      statusLabel: STAGE_STATUS_LABELS[job.status] || job.status || '-',
      operator: job.operator || '',
      startedAt: job.startedAt || '',
      finishedAt: job.finishedAt || '',
      inputs: buildJobInputs(job),
      outputs: buildJobOutputs(job),
      reasonBreakdown: buildJobReasonBreakdown(job),
      logFile: job.stats?.logFile || '',
      errorMessage: job.errorMessage || '',
    }));
  }

  return buildOperationSnapshots;
}

function buildJobInputs(job) {
  const stats = job.stats || {};
  const items = [];
  if (stats.billsScanned != null) items.push({ label: '扫描账单', value: Number(stats.billsScanned) });
  if (stats.scanned != null) items.push({ label: '扫描数据', value: Number(stats.scanned) });
  if (stats.deletedExisting != null) items.push({ label: '重建前清理', value: Number(stats.deletedExisting) });
  return items;
}

function buildJobOutputs(job) {
  const stats = job.stats || {};
  const items = [];
  if (stats.matched != null) items.push({ label: '匹配成功', value: Number(stats.matched) });
  if (stats.unmatched != null) items.push({ label: '未匹配', value: Number(stats.unmatched) });
  if (stats.ambiguous != null) items.push({ label: '多个候选', value: Number(stats.ambiguous) });
  if (stats.fuzzy != null) items.push({ label: '疑似候选', value: Number(stats.fuzzy) });
  if (stats.unreceived != null) items.push({ label: '账单有但未收', value: Number(stats.unreceived) });
  if (stats.conflicts != null) items.push({ label: '进入人工确认', value: Number(stats.conflicts) });
  if (stats.inserted != null) items.push({ label: '写入月度数据', value: Number(stats.inserted) });
  if (stats.files != null) items.push({ label: '生成文件', value: Array.isArray(stats.files) ? stats.files.length : Number(stats.files) });
  return items;
}

function buildJobReasonBreakdown(job) {
  const stats = job.stats || {};
  if (job.stage !== 'bill_match') return [];
  const items = [];
  if (stats.unmatched != null) items.push({ label: '台账里没有对应小票', value: Number(stats.unmatched) });
  if (stats.ambiguous != null) items.push({ label: '多个候选，需要人工确认', value: Number(stats.ambiguous) });
  if (stats.fuzzy != null) items.push({ label: '疑似候选，需要人工确认', value: Number(stats.fuzzy) });
  if (stats.conflicts != null) items.push({ label: '字段冲突，需要人工确认', value: Number(stats.conflicts) });
  return items.filter((item) => item.value > 0);
}

module.exports = { createOperationSnapshots };
