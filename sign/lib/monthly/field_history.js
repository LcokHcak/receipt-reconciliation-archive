'use strict';

const VALID_CHANGE_SOURCES = new Set(['ocr', 'manual_edit', 'bridge_migration', 'pending_resolution', 'manual_no_image']);

function serializeHistoryValue(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function normalizeHistoryChanges(changes = {}) {
  const out = [];
  for (const [field, pair] of Object.entries(changes || {})) {
    if (!field || !pair || typeof pair !== 'object') continue;
    if (serializeHistoryValue(pair.before) === serializeHistoryValue(pair.after)) continue;
    out.push({ field, beforeValue: serializeHistoryValue(pair.before), afterValue: serializeHistoryValue(pair.after) });
  }
  return out;
}

function assertChangeSource(changeSource) {
  if (!VALID_CHANGE_SOURCES.has(changeSource)) throw new Error(`invalid daily history change_source: ${changeSource}`);
}

function recordFieldHistory(repo, payload) {
  if (!repo || typeof repo.recordChanges !== 'function') return { inserted: 0 };
  return repo.recordChanges(payload);
}

module.exports = { VALID_CHANGE_SOURCES, assertChangeSource, normalizeHistoryChanges, recordFieldHistory, serializeHistoryValue };
