'use strict';

const { hashRow } = require('../monthly_pipeline/row_hasher');
const { parseCellDate, fallbackYearFromWorkspace } = require('../monthly_pipeline/date_parsers');
const { normalizeMode } = require('../monthly_pipeline/mode_normalizer');

const HEADER_MAP = Object.freeze({
  '申请日期&起始日期': 'applyDate',
  '出境日期&截止日期': 'endDate',
  '代理': 'agent',
  '团号': 'tourNo',
  '模式': 'mode',
  '上家': 'upstream',
  '护照号': 'passportNo',
  '姓名': 'name',
  '新罗机场': 'shillaAirport',
  '新世界机场': 'shinsegaeAirport',
  '备注': 'remark',
});

const PLACEHOLDER_RE = /^[A-Za-z_]+$/;

/**
 * Map a raw header-object row from 团号汇总.xlsx into the DB-ready shape.
 * Returns null when the row is empty.
 */
function mapGroupCodeRow({ asObject, workspaceKey, importedAt, importJobId }) {
  const src = remapHeaders(asObject, HEADER_MAP);
  const tourNo = trim(src.tourNo);
  if (!tourNo) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const applyDateRaw = toRawText(src.applyDate);
  const endDateRaw = toRawText(src.endDate);
  const applyDate = parseCellDate(src.applyDate, { fallbackYear });
  const endDate = parseCellDate(src.endDate, { fallbackYear });
  const modeRaw = trim(src.mode);
  const modeInfo = normalizeMode(modeRaw);
  const isPlaceholder = PLACEHOLDER_RE.test(tourNo);

  const canonical = {
    workspaceKey,
    tourNo,
    mode: modeRaw,
    agent: trim(src.agent),
    upstream: trim(src.upstream),
    passportNo: trim(src.passportNo),
    name: trim(src.name),
    applyDateRaw,
    applyDate,
    endDateRaw,
    endDate,
    shillaAirport: trim(src.shillaAirport),
    shinsegaeAirport: trim(src.shinsegaeAirport),
    remark: trim(src.remark),
  };

  return {
    ...canonical,
    modeNormalized: modeInfo.code,
    isPlaceholder,
    rowHash: hashRow(canonical),
    importedAt,
    importJobId,
  };
}

function remapHeaders(row, map) {
  const out = {};
  for (const [chinese, key] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(row, chinese)) {
      out[key] = row[chinese];
    }
  }
  return out;
}

function trim(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toRawText(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value).trim() || null;
}

module.exports = {
  mapGroupCodeRow,
  HEADER_MAP,
};
