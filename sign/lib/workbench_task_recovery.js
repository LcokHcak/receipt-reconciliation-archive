const { getTaskRequiredFieldChecks } = require('./workbench_task_flow');

function normalizeText(value) {
  return String(value || '').trim();
}

function recoverCompletedStateAfterManualReview(task = {}) {
  const recoverableMachineStates = new Set(['error', 'queued', 'processing']);
  if (!recoverableMachineStates.has(normalizeText(task.machineState))) {
    return false;
  }

  const fieldSummary = getTaskRequiredFieldChecks(task);
  if (!fieldSummary.classificationConfirmed || fieldSummary.missingFields.length > 0) {
    return false;
  }

  task.machineState = 'completed';
  task.error = '';
  task.ocrError = '';
  return true;
}

module.exports = {
  recoverCompletedStateAfterManualReview,
};
