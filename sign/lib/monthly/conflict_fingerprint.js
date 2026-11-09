'use strict';

const crypto = require('node:crypto');

function computeFingerprint(pending) {
  return fingerprintFromPayload({
    sourceTable: pending?.sourceTable ?? pending?.source_table,
    sourceId: pending?.sourceId ?? pending?.source_id,
    reasonType: pending?.reasonType ?? pending?.reason_type,
    detail: pending?.detail,
  });
}

function fingerprintFromPayload({ sourceTable, sourceId, reasonType, detail }) {
  const canonical = {
    sourceTable: normalizeScalar(sourceTable),
    sourceId: normalizeNumber(sourceId),
    reasonType: normalizeScalar(reasonType),
    detail: normalizeDetail(parseDetail(detail)),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function parseDetail(detail) {
  if (!detail) return {};
  if (typeof detail === 'string') {
    try {
      return JSON.parse(detail) || {};
    } catch {
      return {};
    }
  }
  return detail && typeof detail === 'object' ? detail : {};
}

function normalizeDetail(detail) {
  return {
    priority: normalizeNumber(detail.priority),
    matchKey: normalizeScalar(detail.matchKey),
    dailyReceiptId: normalizeNumber(detail.dailyReceiptId),
    candidateIds: normalizeIds(detail.candidateIds),
    conflicts: normalizeConflicts(detail.conflicts),
  };
}

function normalizeIds(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => normalizeNumber(v))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
}

function normalizeConflicts(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      field: normalizeScalar(v.field),
      dailyValue: normalizeValue(v.dailyValue),
      billValue: normalizeValue(v.billValue),
    }))
    .sort((a, b) => {
      if (a.field !== b.field) return a.field < b.field ? -1 : 1;
      const av = `${a.dailyValue}|${a.billValue}`;
      const bv = `${b.dailyValue}|${b.billValue}`;
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });
}

function normalizeScalar(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeValue(value) {
  if (value == null) return null;
  return String(value).trim();
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  computeFingerprint,
  fingerprintFromPayload,
};
