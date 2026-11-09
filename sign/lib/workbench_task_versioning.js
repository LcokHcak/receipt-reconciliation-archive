function getTaskVersion(taskOrVersion) {
  const rawVersion = typeof taskOrVersion === 'number'
    ? taskOrVersion
    : taskOrVersion?.version;
  const version = Number(rawVersion);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
}

function incrementTaskVersion(task) {
  const nextVersion = getTaskVersion(task) + 1;
  task.version = nextVersion;
  return nextVersion;
}

function hasTaskVersionChanged(latestTask, pendingTaskOrVersion) {
  return getTaskVersion(latestTask) !== getTaskVersion(pendingTaskOrVersion);
}

function markStaleModelResultSkipped(task, { recalcTask, touchTask } = {}) {
  task.machineState = 'completed';
  task.error = '';
  task.ocrError = '';

  if (typeof recalcTask === 'function') {
    recalcTask(task);
  }
  if (typeof touchTask === 'function') {
    touchTask(task);
  }
}

module.exports = {
  getTaskVersion,
  hasTaskVersionChanged,
  incrementTaskVersion,
  markStaleModelResultSkipped,
};
