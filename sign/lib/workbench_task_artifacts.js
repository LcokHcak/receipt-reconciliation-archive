const TASK_ARTIFACT_PATH_KEYS = Object.freeze([
  'sourceImagePath',
  'rawJsonPath',
  'initialRawJsonPath',
  'signatureRegionPath',
  'finalSignaturePath',
]);

function normalizeRelativePath(value) {
  return String(value || '').trim();
}

function getTaskArtifactRelativePaths(task = {}) {
  return [...new Set(
    TASK_ARTIFACT_PATH_KEYS
      .map((key) => normalizeRelativePath(task?.[key]))
      .filter(Boolean)
  )];
}

function getReferencedArtifactPathSet(tasks = []) {
  const referenced = new Set();
  tasks.forEach((task) => {
    getTaskArtifactRelativePaths(task).forEach((relativePath) => referenced.add(relativePath));
  });
  return referenced;
}

function getDeletableTaskArtifactRelativePaths(task = {}, remainingTasks = []) {
  const remainingPaths = getReferencedArtifactPathSet(remainingTasks);
  return getTaskArtifactRelativePaths(task).filter((relativePath) => !remainingPaths.has(relativePath));
}

module.exports = {
  TASK_ARTIFACT_PATH_KEYS,
  getDeletableTaskArtifactRelativePaths,
  getReferencedArtifactPathSet,
  getTaskArtifactRelativePaths,
};
