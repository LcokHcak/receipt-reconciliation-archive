const { PROCESS_RESULTS, deriveTaskState, getTaskRequiredFieldChecks } = require('./workbench_task_flow');

const STAGE_BY_PROCESS_RESULT = Object.freeze({
  [PROCESS_RESULTS.CLASSIFY]: 'classify',
  [PROCESS_RESULTS.FIELDS]: 'fields',
  [PROCESS_RESULTS.SIGNATURE]: 'signature',
  [PROCESS_RESULTS.FINAL_REVIEW]: 'final_review',
  [PROCESS_RESULTS.APPROVED]: 'approved',
  [PROCESS_RESULTS.REPHOTO]: 'rephoto',
});

function toFieldIssue(field = {}) {
  return {
    key: field.finalKey || field.autoKey || field.key || '',
    label: field.label || '',
    issue: field.issue || '',
  };
}

function buildTaskWorkflowState(task = {}) {
  const derived = deriveTaskState(task);
  const fieldSummary = getTaskRequiredFieldChecks(task);
  const processResult = derived.processResult;

  return {
    processResult,
    stage: STAGE_BY_PROCESS_RESULT[processResult] || 'unknown',
    actionSuggestion: derived.actionSuggestion,
    canApproveTask: processResult === PROCESS_RESULTS.FINAL_REVIEW,
    isTerminal: [PROCESS_RESULTS.APPROVED, PROCESS_RESULTS.REPHOTO].includes(processResult),
    fieldSummary: {
      docTypeFinal: fieldSummary.docTypeFinal,
      classificationConfirmed: fieldSummary.classificationConfirmed,
      needsSignature: fieldSummary.needsSignature,
      hasFinalSignature: fieldSummary.hasFinalSignature,
      missingFields: fieldSummary.missingFields.map(toFieldIssue),
      invalidFields: fieldSummary.invalidFields.map(toFieldIssue),
    },
  };
}

module.exports = {
  buildTaskWorkflowState,
};
