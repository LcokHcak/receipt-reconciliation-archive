'use strict';

function getLockedFields(row) {
  const raw = row?.manual_locked_fields ?? row?.manualLockedFields;
  if (!raw) return new Set();
  if (Array.isArray(raw)) return new Set(raw.map(String).filter(Boolean));
  try {
    const parsed = JSON.parse(String(raw));
    return new Set(Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []);
  } catch {
    // intentional: tolerate legacy malformed lock payloads as no locks
    return new Set();
  }
}

function serializeLockedFields(fields) {
  const sorted = [...fields].map(String).filter(Boolean).sort();
  return sorted.length ? JSON.stringify(sorted) : null;
}

function addLockedField(row, fieldName) {
  const fields = getLockedFields(row);
  fields.add(fieldName);
  return serializeLockedFields(fields);
}

function removeLockedField(row, fieldName) {
  const fields = getLockedFields(row);
  fields.delete(fieldName);
  return serializeLockedFields(fields);
}

function filterStageUpdates(currentRow, plannedUpdates) {
  const locked = getLockedFields(currentRow);
  const allowed = {};
  const skipped = [];
  for (const [field, value] of Object.entries(plannedUpdates || {})) {
    if (locked.has(field)) {
      skipped.push(field);
    } else {
      allowed[field] = value;
    }
  }
  return { allowed, skipped };
}

module.exports = {
  getLockedFields,
  addLockedField,
  removeLockedField,
  filterStageUpdates,
  serializeLockedFields,
};
