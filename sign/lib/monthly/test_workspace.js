'use strict';

function isTestWorkspace(workspaceKey) {
  return /^demo-\d{4}-\d{2}$/.test(String(workspaceKey || '').trim());
}

module.exports = { isTestWorkspace };
