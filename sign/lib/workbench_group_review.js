const {
  PROCESS_RESULTS,
  deriveTaskState,
  getTaskRequiredFieldChecks,
  normalizeDocType,
} = require('./workbench_task_flow');
const { DOC_TYPES } = require('./package_constants');
const { groupPassportIssue } = require('./validation/group_passport_rule');

function normalizeText(value) {
  return String(value || '').trim();
}

function formatTaskToken(taskId) {
  const id = normalizeText(taskId);
  if (!id) {
    return '';
  }
  return id.startsWith('task_') ? id : `task ${id}`;
}

function buildApprovalTaskLabel(task = {}) {
  const parts = [];
  const agent = normalizeText(task.customerAgentName || task.agentName || task.agent);
  const group = normalizeText(task.sourceGroupLabel || task.sourceFolderName || task.sourceGroupKey);
  const taskId = formatTaskToken(task.id);
  const receiptNo = normalizeText(task.receiptNoFinal || task.receiptNoAuto);
  const file = normalizeText(task.originalFileName || task.fileName || task.sourceFileName);

  if (agent) {
    parts.push(`代理 ${agent}`);
  }
  if (group) {
    parts.push(`客户组 ${group}`);
  }
  if (taskId) {
    parts.push(taskId);
  }
  if (receiptNo) {
    parts.push(`小票号 ${receiptNo}`);
  }
  if (file) {
    parts.push(`文件 ${file}`);
  }

  return parts.length ? parts.join(' / ') : '当前图片';
}

function isPassportTask(task = {}) {
  return normalizeDocType(task.docTypeFinal || task.docTypeAuto) === DOC_TYPES.PASSPORT;
}

function normalizePassportNo(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 「重复护照」的正确判据是**护照号不同**,不是护照类任务的张数。
// 2026-07-07 生产事故:一本护照拍多张 / 护照号印在乐天购物卡上被多次识别成护照
// (探针实测大量组:EQ1035708×4、EH7893900×4、E04881483×2…同号),旧逻辑按"张数>1"
// 判成多本 → 客户组通过时 markGroupRephoto 把整组(含小票)全标需重拍,摧毁审核成果。
// 现在:同号算同一本护照;只有出现 ≥2 个**不同**非空护照号,才是把两个人的证件混进一个
// 客户文件夹,才拦。无号误分类的护照类任务由后续字段校验(缺护照号)温和拦,不触发整组重拍。
function getDuplicatePassportIssue(tasks = []) {
  const passportTasks = tasks.filter((task) => isPassportTask(task) && !task?.rephotoRequested);
  if (passportTasks.length <= 1) {
    return null;
  }
  const distinctNos = new Set(
    passportTasks.map((t) => normalizePassportNo(t.passportNoFinal || t.passportNoAuto)).filter(Boolean)
  );
  if (distinctNos.size <= 1) {
    return null;
  }
  const issueTask = passportTasks[1] || passportTasks[0];
  return {
    task: issueTask,
    issue: `同一客户文件夹出现 ${distinctNos.size} 个不同护照号（${[...distinctNos].join('、')}），疑似两人证件混放，请分开`,
  };
}

function getMissingPassportIssue(tasks = []) {
  const activeTasks = tasks.filter((task) => task?.id && !task?.rephotoRequested);
  const hasPassport = activeTasks.some((task) => isPassportTask(task));
  if (hasPassport || !activeTasks.length) {
    return null;
  }
  // 0 独立护照：交给单一真相源(lib/validation/group_passport_rule)判——
  // 百货同框自带身份 / 纯百货组免护照(2026-07-14 拍板)都放行；此处不再自铸口径。
  const receiptTasks = activeTasks.filter(
    (task) => normalizeDocType(task.docTypeFinal || task.docTypeAuto) === DOC_TYPES.RECEIPT
  );
  if (groupPassportIssue({ passportTasks: [], receiptTasks }) === '') {
    return null;
  }
  return {
    task: activeTasks[0],
    issue: '整组还缺护照',
  };
}

function getTaskFinalApprovalIssue(task = {}) {
  const fieldSummary = getTaskRequiredFieldChecks(task);
  const workflow = deriveTaskState(task);
  const previewProcessResult = workflow.processResult;

  if (previewProcessResult === PROCESS_RESULTS.REPHOTO || task?.rephotoRequested) {
    return '已标记为需重拍';
  }
  if (!fieldSummary.classificationConfirmed || previewProcessResult === PROCESS_RESULTS.CLASSIFY) {
    return '还没确认证件类型';
  }
  const firstMissingField = fieldSummary.missingFields?.[0];
  if (firstMissingField?.label) {
    return `还缺${firstMissingField.label}`;
  }
  const firstInvalidField = fieldSummary.invalidFields?.[0];
  if (firstInvalidField?.label) {
    return `${firstInvalidField.label}格式不对：${firstInvalidField.issue || '请按规则填写'}`;
  }
  if (fieldSummary.needsSignature && !fieldSummary.hasFinalSignature) {
    return '还没有最终签字';
  }
  if (![PROCESS_RESULTS.FINAL_REVIEW, PROCESS_RESULTS.APPROVED].includes(previewProcessResult)) {
    return '还没到终审状态';
  }
  return '';
}

function createGroupApprovalError(task, issue, options = {}) {
  const label = buildApprovalTaskLabel(task);
  const error = new Error(`${label}：${issue}。`);
  error.code = 'GROUP_APPROVAL_INVALID';
  error.taskId = normalizeText(task?.id);
  error.issue = issue;
  if (options.markedRephoto) {
    error.markedRephoto = true;
  }
  return error;
}

function approveSourceGroupTasks(tasks = [], helpers = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    const error = new Error('当前分组不存在或已经被移除');
    error.code = 'GROUP_NOT_FOUND';
    throw error;
  }

  const markClassificationConfirmed = helpers.markClassificationConfirmed || (() => {});
  const recalcTask = helpers.recalcTask || (() => {});
  const touchTask = helpers.touchTask || (() => {});
  const now = typeof helpers.now === 'function' ? helpers.now : () => new Date().toISOString();

  // 2026-07-07 软拦化(隐患收口):护照数量/缺护照/字段任何问题都**只抛阻断错误、绝不改任何任务状态**。
  // 旧版对护照问题会 markGroupRephoto 把整组(含小票)全标需重拍摧毁审核成果,叠加前端
  // autoApproveGroupIfReady 自动触发 → 无人点按钮就整组翻需重拍、改回又被翻(死循环)。
  // 现在:阻断即报清晰原因(缺护照/两人证件混放),审核状态原封不动;操作员针对性修
  // (删/改错分类的护照、补护照、点具体那张的"重拍"),再通过。
  const duplicatePassportIssue = getDuplicatePassportIssue(tasks);
  if (duplicatePassportIssue) {
    throw createGroupApprovalError(duplicatePassportIssue.task, duplicatePassportIssue.issue);
  }

  const missingPassportIssue = getMissingPassportIssue(tasks);
  if (missingPassportIssue) {
    throw createGroupApprovalError(missingPassportIssue.task, missingPassportIssue.issue);
  }

  const issueTask = tasks.find((task) => getTaskFinalApprovalIssue(task));
  if (issueTask) {
    throw createGroupApprovalError(issueTask, getTaskFinalApprovalIssue(issueTask));
  }

  tasks.forEach((task) => {
    markClassificationConfirmed(task);
    task.reviewed = true;
    task.reviewedAt = now();
    task.rephotoRequested = false;
    recalcTask(task);
    touchTask(task);
  });

  return tasks.map((task) => task.id);
}

module.exports = {
  approveSourceGroupTasks,
  getTaskFinalApprovalIssue,
};
