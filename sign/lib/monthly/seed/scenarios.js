'use strict';

const { hashRow } = require('../../monthly_pipeline/row_hasher');
const { normalizeMode } = require('../../monthly_pipeline/mode_normalizer');

const DEFAULT_LARGE_COUNT = 10000;
const MODES = ['SG', 'V', 'PKG', 'FIT'];

function buildScenario({ scenario, workspaceKey, count, importedAt = new Date().toISOString() }) {
  if (scenario === 'large_volume') {
    return buildSeedSet({
      workspaceKey,
      importedAt,
      total: normalizeCount(count, DEFAULT_LARGE_COUNT),
      dailyCount: normalizeCount(count, DEFAULT_LARGE_COUNT),
      billCount: 0,
      groupCount: 0,
      receivedCount: 0,
      scenario,
    });
  }
  if (scenario === 'cross_month') {
    return buildSeedSet({
      workspaceKey,
      importedAt,
      total: 30,
      dailyCount: 30,
      billCount: 0,
      groupCount: 0,
      receivedCount: 0,
      scenario,
      dateForIndex: (i) => (i <= 15 ? `2026-04-${pad2(i)}` : `2026-05-${pad2(i - 15)}`),
      metadata: { expected_split: { '2026-04': 15, '2026-05': 15 } },
    });
  }
  if (scenario === 'unmatched_unreceived') {
    return buildSeedSet({
      workspaceKey,
      importedAt,
      total: 30,
      dailyCount: 20,
      billCount: 30,
      groupCount: 20,
      receivedCount: 20,
      scenario,
    });
  }
  if (scenario === 'field_conflict') {
    return buildSeedSet({
      workspaceKey,
      importedAt,
      total: 50,
      dailyCount: 50,
      billCount: 50,
      groupCount: 50,
      receivedCount: 50,
      scenario,
      mutateBill: (row, i) => (i <= 5
        ? {
            ...row,
            name: `CONFLICT ${pad4(i)}`,
            fullName: `CONFLICT ${pad4(i)}`,
            receiptNo: `${row.receiptNo}9`,
            originalReceiptNo: `${row.receiptNo}9`,
          }
        : row),
    });
  }
  if (scenario === 'all_matched') {
    return buildSeedSet({
      workspaceKey,
      importedAt,
      total: 50,
      dailyCount: 50,
      billCount: 50,
      groupCount: 50,
      receivedCount: 50,
      scenario,
    });
  }
  const error = new Error(`unsupported seed scenario: ${scenario}`);
  error.statusCode = 400;
  error.code = 'INVALID_SEED_SCENARIO';
  throw error;
}

function buildSeedSet({
  workspaceKey,
  importedAt,
  total,
  dailyCount,
  billCount,
  groupCount,
  receivedCount,
  scenario,
  dateForIndex = defaultDateForIndex,
  mutateBill = (row) => row,
  metadata = null,
}) {
  const daily = [];
  const bill = [];
  const groupCode = [];
  const received = [];
  for (let i = 1; i <= total; i += 1) {
    const base = baseRow({ i, scenario, workspaceKey, importedAt, date: dateForIndex(i) });
    if (i <= dailyCount) daily.push(buildDaily(base));
    if (i <= billCount) bill.push(buildBill(mutateBill(base, i)));
    if (i <= groupCount) groupCode.push(buildGroupCode(base));
    if (i <= receivedCount) received.push(buildReceived(base));
  }
  return { daily, bill, groupCode, received, metadata };
}

function baseRow({ i, scenario, workspaceKey, importedAt, date }) {
  const modeRaw = MODES[(i - 1) % MODES.length];
  const modeNormalized = normalizeMode(modeRaw).code;
  const suffix = pad4(i);
  return {
    workspaceKey,
    importedAt,
    sourceFile: `seed-${scenario}.xlsx`,
    sourceSheet: 'seed',
    sourceRow: i,
    receiptDate: date,
    statementDate: date,
    stmtDate: date,
    purchaseDate: date,
    originalDate: date,
    departureDate: nextDate(date),
    modeRaw,
    modeNormalized,
    mode: modeRaw,
    modeFolder: modeNormalized,
    shop: i % 3 === 0 ? 'SHILLA IPARK' : 'THE SHILLA',
    branch: i % 3 === 0 ? 'SEOUL' : 'JEJU',
    storeFamily: i % 3 === 0 ? 'SHILLA IPARK' : 'THE SHILLA',
    storeBranch: i % 3 === 0 ? 'SEOUL' : 'JEJU',
    tourNo: String(71990 + (i % 9)),
    name: `SEED CUSTOMER ${suffix}`,
    fullName: `SEED CUSTOMER ${suffix}`,
    passportNo: `EA${String(9000000 + i)}`,
    receiptNo: `0326${String(100000000 + i).slice(-9)}`,
    originalReceiptNo: `0326${String(100000000 + i).slice(-9)}`,
    category: 'COSMETICS',
    brand: 'SEED BRAND',
    sku: `SKU-${suffix}`,
    productName: `Seed Product ${suffix}`,
    refNo: `REF-${suffix}`,
    qty: 1 + (i % 3),
    grossUsd: 100 + i,
    grossKrw: 130000 + i,
    netUsd: 90 + i,
    netKrw: 120000 + i,
    points: 10 + i,
    rebateAmount: 5 + i,
    agent: `代理${(i % 5) + 1}`,
    workerName: `审核员${(i % 3) + 1}`,
    workerNo: String((i % 3) + 1),
    owner: `审核员${(i % 3) + 1}`,
  };
}

function buildDaily(base) {
  const canonical = {
    workspaceKey: base.workspaceKey,
    sourceCustomerId: `seed-customer-${pad4(base.sourceRow)}`,
    stmtDate: base.stmtDate,
    statementDate: base.statementDate,
    paymentMode: 'CARD',
    modeRaw: base.modeRaw,
    modeNormalized: base.modeNormalized,
    shop: base.shop,
    branch: base.branch,
    upstream: 'SEED',
    entryCompany: 'SEED',
    tourGuide: null,
    agent: base.agent,
    originalDate: base.originalDate,
    purchaseDate: base.purchaseDate,
    tourNo: base.tourNo,
    name: base.name,
    passportNo: base.passportNo,
    departureDate: base.departureDate,
    receiptNo: base.receiptNo,
    originalReceiptNo: base.originalReceiptNo,
    category: base.category,
    brand: base.brand,
    sku: base.sku,
    productName: base.productName,
    refNo: base.refNo,
    qty: base.qty,
    grossUsd: base.grossUsd,
    grossKrw: base.grossKrw,
    netUsd: base.netUsd,
    netKrw: base.netKrw,
    dcUsd: 0,
    dcKrw: 0,
    discountRate: 0,
    voucherAmount: 0,
    voucherDeduction: 0,
    customerPoints: null,
    customerRebate: null,
    storeBasePoints: base.points,
    storeBaseRebate: base.rebateAmount,
    storeExtraPoints: 0,
    storeExtraAmount: 0,
    storeFinalRebate: base.rebateAmount,
    categorySecondary: null,
    remark: `seed:${base.sourceFile}`,
    billMatchStatus: 'unmatched',
    billMatchPriority: null,
    modeFolder: base.modeFolder,
    tourMatchStatus: 'pending',
    sourceFile: base.sourceFile,
    sourceSheet: base.sourceSheet,
    sourceRow: base.sourceRow,
    importedAt: base.importedAt,
    importJobId: null,
    receiptDate: base.receiptDate,
    agentId: null,
    agentCode: base.agent,
    sourceType: 'imported',
    sourceBatchId: null,
    sourceTaskId: null,
    modifiedBy: base.workerName,
    ledgerStatus: 'posted',
    remedyReason: null,
    postedAt: base.importedAt,
    postedBy: base.workerName,
  };
  return {
    ...canonical,
    rawPayload: canonical,
    rowHash: hashRow({ ...canonical, sourceRow: base.sourceRow }),
  };
}

function buildBill(base) {
  const canonical = {
    workspaceKey: base.workspaceKey,
    storeFamily: base.storeFamily,
    storeBranch: base.storeBranch,
    mode: base.mode,
    modeNormalized: base.modeNormalized,
    tourNo: base.tourNo,
    purchaseDate: base.purchaseDate,
    originalDate: base.originalDate,
    departureDate: base.departureDate,
    name: base.name,
    fullName: base.fullName,
    passportNo: base.passportNo,
    receiptNo: base.receiptNo,
    originalReceiptNo: base.originalReceiptNo,
    brand: base.brand,
    sku: base.sku,
    refNo: base.refNo,
    category: base.category,
    qty: base.qty,
    grossUsd: base.grossUsd,
    grossKrw: base.grossKrw,
    netUsd: base.netUsd,
    netKrw: base.netKrw,
    points: base.points,
    rebateAmount: base.rebateAmount,
    sourceFile: base.sourceFile,
    sourceSheet: base.sourceSheet,
    sourceRow: base.sourceRow,
    isDetailSheet: true,
    importedAt: base.importedAt,
    importJobId: null,
  };
  return {
    ...canonical,
    rawPayload: canonical,
    rowHash: hashRow({ ...canonical, sheetName: base.sourceSheet, sourceRow: base.sourceRow }),
  };
}

function buildGroupCode(base) {
  const canonical = {
    workspaceKey: base.workspaceKey,
    tourNo: base.tourNo,
    mode: base.modeRaw,
    modeNormalized: base.modeNormalized,
    agent: base.agent,
    upstream: 'SEED',
    passportNo: base.passportNo,
    name: base.name,
    applyDateRaw: base.purchaseDate,
    applyDate: base.purchaseDate,
    endDateRaw: base.departureDate,
    endDate: base.departureDate,
    shillaAirport: '',
    shinsegaeAirport: '',
    remark: `seed:${base.sourceFile}`,
    isPlaceholder: false,
    importedAt: base.importedAt,
    importJobId: null,
  };
  return { ...canonical, rowHash: hashRow(canonical) };
}

function buildReceived(base) {
  const canonical = {
    workspaceKey: base.workspaceKey,
    workerName: base.workerName,
    workerNo: base.workerNo,
    receiptDate: base.receiptDate,
    agent: base.agent,
    purchaseDate: base.purchaseDate,
    receiptNo: base.receiptNo,
    tourNo: base.tourNo,
    name: base.name,
    passportNo: base.passportNo,
    departureDate: base.departureDate,
    modeRaw: base.modeRaw,
    modeNormalized: base.modeNormalized,
    owner: base.owner,
    shinsegaeAirport: '',
    shillaAirport: '',
    sourceFile: base.sourceFile,
    sourceSheet: base.sourceSheet,
    sourceRow: base.sourceRow,
    importedAt: base.importedAt,
    importJobId: null,
  };
  return {
    ...canonical,
    rawPayload: canonical,
    rowHash: hashRow({ ...canonical, sourceRow: base.sourceRow }),
  };
}

function normalizeCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function defaultDateForIndex(i) {
  const day = ((i - 1) % 28) + 1;
  return `2026-05-${pad2(day)}`;
}

function nextDate(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function pad4(value) {
  return String(value).padStart(4, '0');
}

module.exports = {
  DEFAULT_LARGE_COUNT,
  buildScenario,
};
