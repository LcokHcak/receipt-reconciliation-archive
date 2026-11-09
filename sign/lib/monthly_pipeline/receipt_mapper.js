'use strict';

/**
 * received_receipt mapper — parses one row from a worker Sheet of
 * 收票汇总.xlsx into the received_receipt shape.
 *
 * Sheet name shape: "N号 姓名" (e.g. "9号 侯丹妮"). Summary / layout
 * sheets are filtered out by isReceiptWorkerSheet() below.
 *
 * Stable header set (from 4 confirmed worker sheets):
 *   收票日期 | 代理 | 购买日期 | 小票号 | 团号 | 姓名 | 护照号 |
 *   出境日期 | 模式 | 负责人 | 新世界机场... | 新罗机场...
 */

const { hashRow } = require('./row_hasher');
const { parseCellDate, fallbackYearFromWorkspace } = require('./date_parsers');
const { normalizeMode } = require('./mode_normalizer');

// Sheet names that are NOT individual worker sheets
const SUMMARY_SHEET_NAMES = new Set([
  '收票数统计', '团号汇总', '工作分配', '备份',
]);
const SUMMARY_NAME_RE = /(统计|汇总|工作分配|备份|模板|说明|---)/;
const WORKER_NAME_RE = /^(\d+)号[\s ]*(.*)$/; // "9号 侯丹妮"

function isReceiptWorkerSheet(name) {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  if (SUMMARY_SHEET_NAMES.has(trimmed)) return false;
  if (SUMMARY_NAME_RE.test(trimmed)) return false;
  return WORKER_NAME_RE.test(trimmed);
}

function parseWorkerSheetName(name) {
  const m = WORKER_NAME_RE.exec(String(name || '').trim());
  if (!m) return { workerNo: null, workerName: null };
  return { workerNo: m[1], workerName: m[2] || null };
}

// Header synonyms — worker sheets sometimes shorten headers
const FIELD_ALIASES = Object.freeze({
  receiptDate: ['收票日期'],
  agent: ['代理'],
  purchaseDate: ['购买日期'],
  receiptNo: ['小票号'],
  tourNo: ['团号'],
  name: ['姓名'],
  passportNo: ['护照号'],
  departureDate: ['出境日期'],
  modeRaw: ['模式', '返点模式'],
  owner: ['负责人'],
  shinsegaeAirport: ['新世界机场14开头', '新世界机场'],
  shillaAirport: ['新罗机场05开头', '新罗机场'],
});

function pickFromRow(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
    for (const k of Object.keys(row)) {
      if (k.startsWith(key) || key.startsWith(k.slice(0, Math.min(4, k.length)))) {
        if (row[k] != null && row[k] !== '') return row[k];
      }
    }
  }
  return null;
}

function mapReceivedReceiptRow({
  asObject,
  workspaceKey,
  sheetName,
  sourceFile,
  sourceRow,
  importedAt,
  importJobId,
}) {
  const receiptNo = trim(pickFromRow(asObject, FIELD_ALIASES.receiptNo));
  const passportNo = trim(pickFromRow(asObject, FIELD_ALIASES.passportNo));
  const name = trim(pickFromRow(asObject, FIELD_ALIASES.name));
  // Must have at least one identifying field
  if (!receiptNo && !passportNo && !name) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(pickFromRow(asObject, FIELD_ALIASES.modeRaw));
  const { workerNo, workerName } = parseWorkerSheetName(sheetName);

  const canonical = {
    workspaceKey,
    workerName,
    workerNo,
    receiptDate: parseCellDate(pickFromRow(asObject, FIELD_ALIASES.receiptDate), { fallbackYear }),
    agent: trim(pickFromRow(asObject, FIELD_ALIASES.agent)),
    purchaseDate: parseCellDate(pickFromRow(asObject, FIELD_ALIASES.purchaseDate), { fallbackYear }),
    receiptNo,
    tourNo: trim(pickFromRow(asObject, FIELD_ALIASES.tourNo)),
    name,
    passportNo,
    departureDate: parseCellDate(pickFromRow(asObject, FIELD_ALIASES.departureDate), { fallbackYear }),
    modeRaw,
    owner: trim(pickFromRow(asObject, FIELD_ALIASES.owner)),
    shinsegaeAirport: trim(pickFromRow(asObject, FIELD_ALIASES.shinsegaeAirport)),
    shillaAirport: trim(pickFromRow(asObject, FIELD_ALIASES.shillaAirport)),
    sourceFile,
    sourceSheet: sheetName,
    sourceRow,
  };

  return {
    ...canonical,
    modeNormalized: modeRaw ? normalizeMode(modeRaw).code : null,
    rawPayload: asObject,
    rowHash: hashRow({ ...canonical, sourceRow }),
    importedAt,
    importJobId,
  };
}

function trim(v) {
  if (v == null) return null;
  const text = String(v).trim();
  return text || null;
}

module.exports = {
  mapReceivedReceiptRow,
  isReceiptWorkerSheet,
  parseWorkerSheetName,
  FIELD_ALIASES,
};
