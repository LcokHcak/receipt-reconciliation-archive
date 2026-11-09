const path = require('node:path');

const INVALID_WORKSPACE_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

function normalizeWorkspaceKey(workspaceKey) {
  return String(workspaceKey || '').trim();
}

function isValidWorkspaceKey(workspaceKey) {
  const normalized = normalizeWorkspaceKey(workspaceKey);
  if (!normalized || normalized === '.' || normalized === '..') {
    return false;
  }
  if (INVALID_WORKSPACE_CHARS.test(normalized)) {
    return false;
  }
  return true;
}

function assertValidWorkspaceKey(workspaceKey) {
  if (!isValidWorkspaceKey(workspaceKey)) {
    throw new Error(`Invalid workspace key: ${workspaceKey}`);
  }
}

function isValidMonthKey(monthKey) {
  return isValidWorkspaceKey(monthKey);
}

function assertValidMonthKey(monthKey) {
  assertValidWorkspaceKey(monthKey);
}

function ensureInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes customer library root: ${targetPath}`);
  }
  return resolvedTarget;
}

function resolveWorkspacePath(rootPath, workspaceKey) {
  const normalized = normalizeWorkspaceKey(workspaceKey);
  assertValidWorkspaceKey(normalized);
  return ensureInsideRoot(rootPath, path.join(rootPath, normalized));
}

function resolveMonthPath(rootPath, monthKey) {
  return resolveWorkspacePath(rootPath, monthKey);
}

module.exports = {
  assertValidMonthKey,
  assertValidWorkspaceKey,
  ensureInsideRoot,
  isValidMonthKey,
  isValidWorkspaceKey,
  normalizeWorkspaceKey,
  resolveMonthPath,
  resolveWorkspacePath,
};
