const GLOBAL_DATA_ROLES = new Set(['admin', 'finance']);

function normalizeUsername(user = {}) {
  return String(user?.username || '').trim();
}

function normalizeUserId(user = {}) {
  const raw = user?.userId ?? user?.id;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : String(raw).trim();
}

function canAccessAllOperatorData(user = null) {
  if (!user) return true;
  return GLOBAL_DATA_ROLES.has(String(user.role || '').trim());
}

function buildOwnerMetadata(user = null) {
  if (!user) return {};
  const ownerUsername = normalizeUsername(user);
  const ownerUserId = normalizeUserId(user);
  return {
    ownerUserId,
    ownerUsername: ownerUsername || null,
    createdBy: ownerUsername || null,
  };
}

function isRecordOwnedByUser(record = {}, user = null) {
  if (canAccessAllOperatorData(user)) return true;
  const username = normalizeUsername(user);
  const userId = normalizeUserId(user);
  const ownerUsername = String(record.ownerUsername || record.createdBy || '').trim();
  const ownerUserId = record.ownerUserId ?? record.createdByUserId ?? null;

  if (username && ownerUsername && username === ownerUsername) {
    return true;
  }
  if (userId !== null && ownerUserId !== null && String(userId) === String(ownerUserId)) {
    return true;
  }
  return false;
}

function filterRecordsByOperator(records = [], user = null) {
  if (!Array.isArray(records)) return [];
  if (canAccessAllOperatorData(user)) return records;
  return records.filter((record) => isRecordOwnedByUser(record, user));
}

function assertRecordAccess(record = {}, user = null, label = 'customer') {
  if (!isRecordOwnedByUser(record, user)) {
    throw new Error(`${label} access denied`);
  }
}

function isTaskOwnedByUser(task = {}, user = null) {
  if (canAccessAllOperatorData(user)) return true;
  return isRecordOwnedByUser({
    ownerUserId: task.customerOwnerUserId ?? task.ownerUserId ?? null,
    ownerUsername: task.customerOwnerUsername || task.ownerUsername || task.createdBy || '',
  }, user);
}

function isBatchOwnedByUser(batch = {}, user = null) {
  if (canAccessAllOperatorData(user)) return true;
  if (isRecordOwnedByUser(batch, user)) return true;
  return (Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => isTaskOwnedByUser(task, user));
}

function filterBatchesByOperator(batches = [], user = null) {
  if (!Array.isArray(batches)) return [];
  if (canAccessAllOperatorData(user)) return batches;
  return batches.filter((batch) => isBatchOwnedByUser(batch, user));
}

function assertBatchAccess(batch = {}, user = null) {
  if (!isBatchOwnedByUser(batch, user)) {
    throw new Error('batch access denied');
  }
}

function buildLedgerOwnerScope(user = null) {
  if (canAccessAllOperatorData(user)) return {};
  return {
    ownerUserId: normalizeUserId(user),
    ownerUsername: normalizeUsername(user) || null,
  };
}

// V2 Task8:代理工作台读模型作用域。规则:服务端先按角色算最大可见范围,再收窄——
// reviewer 恒等于自己的 userId(传别人的 ownerUserId 也不能扩大);
// admin/finance 全局可见,可用 requestedOwnerUserId 主动收窄(低强调"收票员"筛选)。
function buildAgentWorkspaceScope(user = null, { requestedOwnerUserId = null } = {}) {
  if (!canAccessAllOperatorData(user)) {
    return { ownerUserId: normalizeUserId(user), forced: true };
  }
  if (requestedOwnerUserId === null || requestedOwnerUserId === undefined || requestedOwnerUserId === '') {
    return { ownerUserId: null, forced: false };
  }
  const numeric = Number(requestedOwnerUserId);
  return { ownerUserId: Number.isFinite(numeric) ? numeric : String(requestedOwnerUserId).trim(), forced: false };
}

// finance V1 只读:全局可见但不能完成任务。
function canCompleteWorkflowTask(user = null) {
  const role = String(user?.role || '').trim();
  return role === 'admin' || role === 'reviewer';
}

module.exports = {
  assertBatchAccess,
  assertRecordAccess,
  buildAgentWorkspaceScope,
  buildLedgerOwnerScope,
  canCompleteWorkflowTask,
  buildOwnerMetadata,
  canAccessAllOperatorData,
  filterBatchesByOperator,
  filterRecordsByOperator,
  isBatchOwnedByUser,
  isRecordOwnedByUser,
  isTaskOwnedByUser,
  normalizeUserId,
  normalizeUsername,
};
