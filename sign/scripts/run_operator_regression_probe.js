#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const ExcelJS = require('exceljs');
const { chromium } = require('playwright');

const { UserService } = require('../services/user_service');
const { HEADER_MAP: GROUP_HEADERS } = require('../lib/monthly_pipeline/group_code_mapper');
const { FIELD_ALIASES: DAILY_HEADERS } = require('../lib/monthly_pipeline/daily_receipt_mapper');
const { FIELD_ALIASES: BILL_HEADERS } = require('../lib/monthly_pipeline/bill_mapper');
const { FIELD_ALIASES: RECEIVED_HEADERS } = require('../lib/monthly_pipeline/receipt_mapper');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_ROOT = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const WORKBENCH_DB = path.join(STORAGE_ROOT, 'workbench.sqlite');
const MONTHLY_DB = path.join(STORAGE_ROOT, 'monthly.sqlite');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3218';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: process.env.SIGN_OPERATOR_PROBE_BASE_URL || DEFAULT_BASE_URL,
    outDir: '',
    headful: false,
    keepData: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      i += 1;
    } else if (current === '--out-dir' && next) {
      args.outDir = path.resolve(next);
      i += 1;
    } else if (current === '--headful') {
      args.headful = true;
    } else if (current === '--keep-data') {
      args.keepData = true;
    } else if (current === '--help' || current === '-h') {
      args.help = true;
    }
  }
  if (!args.outDir) {
    args.outDir = path.resolve(
      PROJECT_ROOT,
      '..',
      'output',
      `operator-regression-${stamp(new Date())}`
    );
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/run_operator_regression_probe.js --base-url http://127.0.0.1:3218

Options:
  --out-dir <path>  Output report and screenshots directory
  --headful         Show Chromium
  --keep-data       Leave 2099-01/02/03 probe workspaces in monthly.sqlite
`;
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function step(results, name, fn) {
  return (async () => {
    const started = performance.now();
    try {
      const details = await fn();
      results.steps.push({
        name,
        ok: true,
        ms: Math.round(performance.now() - started),
        details: details || {},
      });
      return details;
    } catch (error) {
      results.steps.push({
        name,
        ok: false,
        ms: Math.round(performance.now() - started),
        error: error?.message || String(error),
        stack: error?.stack || '',
      });
      throw error;
    }
  })();
}

async function ensureProbeUsers(password) {
  const service = new UserService({ dbPath: WORKBENCH_DB });
  const users = [
    ['op_probe_admin', 'admin'],
    ['op_probe_reviewer', 'reviewer'],
    ['op_probe_finance', 'finance'],
  ];
  try {
    const existing = await service.listUsers();
    for (const [username, role] of users) {
      const found = existing.find((user) => user.username === username);
      if (found) {
        await service.updateUser(found.id, {
          role,
          isActive: 1,
          displayName: `Operator Probe ${role}`,
        });
        await service.resetPassword(found.id, password);
      } else {
        await service.createUser(username, password, role, {
          displayName: `Operator Probe ${role}`,
        });
      }
    }
  } finally {
    service.close();
  }
  return {
    admin: { username: 'op_probe_admin', password },
    reviewer: { username: 'op_probe_reviewer', password },
    finance: { username: 'op_probe_finance', password },
  };
}

async function cleanupProbeUsers() {
  const service = new UserService({ dbPath: WORKBENCH_DB });
  try {
    const users = await service.listUsers();
    for (const user of users) {
      if (String(user.username || '').startsWith('op_probe_') && user.is_active === 1) {
        await service.deleteUser(user.id);
      }
    }
  } finally {
    service.close();
  }
}

function redactProbeUsers(users) {
  return Object.fromEntries(Object.entries(users).map(([key, user]) => [
    key,
    { username: user.username },
  ]));
}

function redactSessions(sessions) {
  return Object.fromEntries(Object.entries(sessions).map(([key, session]) => [
    key,
    {
      user: {
        id: session.user?.id,
        username: session.user?.username,
        role: session.user?.role,
      },
    },
  ]));
}

function cleanupProbeWorkspaces() {
  if (!fs.existsSync(MONTHLY_DB)) return;
  const db = new DatabaseSync(MONTHLY_DB);
  const workspaces = ['2099-01', '2099-02', '2099-03'];
  const workspaceTables = [
    'stage_job_retry',
    'stage_job',
    'import_job',
    'monthly_data',
    'bill_match_log',
    'pending_review',
    'match_badcase',
    'error_record',
    'departure_sync_audit',
    'daily_receipt_export',
    'received_receipt',
    'store_bill',
    'group_code',
    'missing_receipt',
    'monthly_workspace',
  ];
  try {
    db.exec('BEGIN');
    for (const table of workspaceTables) {
      try {
        const stmt = db.prepare(`DELETE FROM ${table} WHERE workspace_key = ?`);
        for (const workspace of workspaces) stmt.run(workspace);
      } catch {
        // Some historical schemas do not have every table.
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {
      // intentional: best-effort cleanup
    }
    throw error;
  } finally {
    db.close();
  }
}

async function login(baseUrl, credentials) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(`login failed for ${credentials.username}: ${res.status} ${JSON.stringify(body)}`);
  const cookies = getSetCookies(res).map((cookie) => cookie.split(';')[0]).join('; ');
  if (!cookies) throw new Error(`login did not return cookies for ${credentials.username}`);
  return { cookie: cookies, user: body.user };
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const value = res.headers.get('set-cookie');
  return value ? [value] : [];
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJson(baseUrl, routePath, { cookie, method = 'GET', body, expected = 200 } = {}) {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const payload = await readBody(res);
  if (res.status !== expected) {
    throw new Error(`${method} ${routePath} expected ${expected}, got ${res.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function uploadXlsx(baseUrl, routePath, { cookie, filePath, expected = 200 }) {
  const form = new FormData();
  const bytes = await fsp.readFile(filePath);
  form.append(
    'file',
    new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    path.basename(filePath)
  );
  return requestJson(baseUrl, routePath, {
    cookie,
    method: 'POST',
    body: form,
    expected,
  });
}

async function writeWorkbook(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    ws.addRow(sheet.headers);
    for (const row of sheet.rows) {
      ws.addRow(sheet.headers.map((header) => row[header] ?? ''));
    }
  }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

function firstHeader(map, key) {
  return map[key][0];
}

async function createProbeWorkbooks(outDir) {
  const dir = path.join(outDir, 'fixtures');
  await fsp.mkdir(dir, { recursive: true });

  const groupHeaders = Object.keys(GROUP_HEADERS);
  const groupRows = [{
    [groupHeaders.find((h) => GROUP_HEADERS[h] === 'applyDate')]: '2099-01-01',
    [groupHeaders.find((h) => GROUP_HEADERS[h] === 'endDate')]: '2099-01-31',
    [groupHeaders.find((h) => GROUP_HEADERS[h] === 'agent')]: 'Probe Agent',
    [groupHeaders.find((h) => GROUP_HEADERS[h] === 'tourNo')]: 'T209901',
    [groupHeaders.find((h) => GROUP_HEADERS[h] === 'mode')]: 'SG',
  }];

  const billHeaders = [
    firstHeader(BILL_HEADERS, 'storeFamily'),
    firstHeader(BILL_HEADERS, 'mode'),
    firstHeader(BILL_HEADERS, 'tourNo'),
    firstHeader(BILL_HEADERS, 'purchaseDate'),
    firstHeader(BILL_HEADERS, 'name'),
    firstHeader(BILL_HEADERS, 'passportNo'),
    firstHeader(BILL_HEADERS, 'receiptNo'),
  ];
  const billRows = [{
    [firstHeader(BILL_HEADERS, 'storeFamily')]: 'THE SHILLA',
    [firstHeader(BILL_HEADERS, 'mode')]: 'SG',
    [firstHeader(BILL_HEADERS, 'tourNo')]: 'T209901',
    [firstHeader(BILL_HEADERS, 'purchaseDate')]: '2099-01-03',
    [firstHeader(BILL_HEADERS, 'name')]: 'PROBE USER',
    [firstHeader(BILL_HEADERS, 'passportNo')]: 'P20990101',
    [firstHeader(BILL_HEADERS, 'receiptNo')]: 'R20990101',
  }];

  const dailyHeaders = [
    firstHeader(DAILY_HEADERS, 'modeRaw'),
    firstHeader(DAILY_HEADERS, 'shop'),
    firstHeader(DAILY_HEADERS, 'agent'),
    firstHeader(DAILY_HEADERS, 'purchaseDate'),
    firstHeader(DAILY_HEADERS, 'tourNo'),
    firstHeader(DAILY_HEADERS, 'name'),
    firstHeader(DAILY_HEADERS, 'passportNo'),
    firstHeader(DAILY_HEADERS, 'receiptNo'),
  ];
  const dailyRows = [{
    [firstHeader(DAILY_HEADERS, 'modeRaw')]: 'SG',
    [firstHeader(DAILY_HEADERS, 'shop')]: 'THE SHILLA',
    [firstHeader(DAILY_HEADERS, 'agent')]: 'Probe Agent',
    [firstHeader(DAILY_HEADERS, 'purchaseDate')]: '2099-01-03',
    [firstHeader(DAILY_HEADERS, 'tourNo')]: 'T209901',
    [firstHeader(DAILY_HEADERS, 'name')]: 'PROBE USER',
    [firstHeader(DAILY_HEADERS, 'passportNo')]: 'P20990101',
    [firstHeader(DAILY_HEADERS, 'receiptNo')]: 'R20990101',
  }];

  const receivedHeaders = [
    firstHeader(RECEIVED_HEADERS, 'receiptDate'),
    firstHeader(RECEIVED_HEADERS, 'agent'),
    firstHeader(RECEIVED_HEADERS, 'purchaseDate'),
    firstHeader(RECEIVED_HEADERS, 'receiptNo'),
    firstHeader(RECEIVED_HEADERS, 'tourNo'),
    firstHeader(RECEIVED_HEADERS, 'name'),
    firstHeader(RECEIVED_HEADERS, 'passportNo'),
    firstHeader(RECEIVED_HEADERS, 'modeRaw'),
  ];
  const receivedRows = [{
    [firstHeader(RECEIVED_HEADERS, 'receiptDate')]: '2099-01-03',
    [firstHeader(RECEIVED_HEADERS, 'agent')]: 'Probe Agent',
    [firstHeader(RECEIVED_HEADERS, 'purchaseDate')]: '2099-01-03',
    [firstHeader(RECEIVED_HEADERS, 'receiptNo')]: 'R20990101',
    [firstHeader(RECEIVED_HEADERS, 'tourNo')]: 'T209901',
    [firstHeader(RECEIVED_HEADERS, 'name')]: 'PROBE USER',
    [firstHeader(RECEIVED_HEADERS, 'passportNo')]: 'P20990101',
    [firstHeader(RECEIVED_HEADERS, 'modeRaw')]: 'SG',
  }];

  const missingHeaders = billHeaders;
  const missingRows = [{
    [firstHeader(BILL_HEADERS, 'mode')]: 'SG',
    [firstHeader(BILL_HEADERS, 'tourNo')]: 'T209901',
    [firstHeader(BILL_HEADERS, 'purchaseDate')]: '2099-01-03',
    [firstHeader(BILL_HEADERS, 'name')]: 'PROBE USER',
    [firstHeader(BILL_HEADERS, 'passportNo')]: 'P20990101',
    [firstHeader(BILL_HEADERS, 'receiptNo')]: 'M20990101',
  }];

  return {
    group: await writeWorkbook(path.join(dir, 'group-code.xlsx'), [{ name: 'group_code', headers: groupHeaders, rows: groupRows }]),
    bill: await writeWorkbook(path.join(dir, 'store-bill.xlsx'), [{ name: 'Sheet1', headers: billHeaders, rows: billRows }]),
    daily: await writeWorkbook(path.join(dir, 'daily-receipt.xlsx'), [{ name: 'daily', headers: dailyHeaders, rows: dailyRows }]),
    received: await writeWorkbook(path.join(dir, 'received-receipt.xlsx'), [{ name: '1号 Probe', headers: receivedHeaders, rows: receivedRows }]),
    missing: await writeWorkbook(path.join(dir, 'missing.xlsx'), [{ name: 'missing', headers: missingHeaders, rows: missingRows }]),
  };
}

async function getFirstId(baseUrl, routePath, cookie) {
  const payload = await requestJson(baseUrl, routePath, { cookie });
  const rows = payload.rows || payload.files || [];
  if (!rows.length) throw new Error(`No rows from ${routePath}`);
  return rows[0].id;
}

function buildRoleUiRoutes(role) {
  const common = [
    ['overview', '/app/dist/monthly/2099-01/overview'],
    ['ledger', '/app/dist/monthly/2099-01/ledger'],
    ['library', '/app/dist/library'],
    ['settings', '/app/dist/settings'],
  ];
  if (role === 'admin') {
    return [
      ...common,
      ['intake', '/app/dist/intake'],
      ['remedy', '/app/dist/monthly/2099-01/remedy'],
      ['admin-users', '/app/dist/admin/users'],
    ];
  }
  if (role === 'reviewer') {
    return [
      ...common,
      ['intake', '/app/dist/intake'],
      ['remedy', '/app/dist/monthly/2099-01/remedy'],
      ['errors', '/app/dist/monthly/2099-01/errors'],
    ];
  }
  return [
    ...common,
    ['finance-remedy-denied', '/app/dist/monthly/2099-01/remedy', { deniedPathIncludes: '/monthly/2099-01/remedy' }],
    ['finance-admin-denied', '/app/dist/admin/users', { deniedPathIncludes: '/admin/users' }],
  ];
}

function attachPageErrorListeners(page, errors, role) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ role, type: 'console', text: message.text() });
  });
  page.on('pageerror', (error) => errors.push({ role, type: 'pageerror', text: error.message }));
  page.on('response', (response) => {
    if (response.status() >= 500) {
      errors.push({ role, type: 'response', status: response.status(), url: response.url() });
    }
  });
}

async function loginUi(page, baseUrl, credentials) {
  await page.goto(`${baseUrl}/app/dist/login`, { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(credentials.username);
  await page.locator('input[name="password"]').fill(credentials.password);
  const loginResponse = page.waitForResponse(
    (response) => response.url().includes('/api/auth/login'),
    { timeout: 10_000 }
  );
  await Promise.all([
    loginResponse,
    page.locator('button[type="submit"]').click(),
  ]);
  const loginResult = await loginResponse;
  if (loginResult.status() !== 200) {
    throw new Error(`UI login failed for ${credentials.username} with status ${loginResult.status()}`);
  }
  await page.waitForURL((url) => !url.pathname.replace(/\/+$/, '').endsWith('/login'), {
    timeout: 10_000,
  });
  await page.waitForLoadState('networkidle');
}

async function assertMonthlySwitchReloads(page, baseUrl) {
  await page.goto(`${baseUrl}/app/dist/monthly/2099-01/overview`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('2099-01'), null, { timeout: 10_000 });
  await page.goto(`${baseUrl}/app/dist/monthly/2099-02/overview`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('2099-02'), null, { timeout: 10_000 });
  const bodyText = await page.locator('body').innerText();
  if (!bodyText.includes('2099-02')) {
    throw new Error('monthly overview did not show the switched workspace key 2099-02');
  }
}

async function assertReceivedReceiptExportLink(page, baseUrl) {
  await page.goto(`${baseUrl}/app/dist/monthly/2099-01/ledger`, { waitUntil: 'networkidle' });
  page.once('dialog', async (dialog) => dialog.accept());
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/exports/received-receipt'),
    { timeout: 30_000 }
  );
  await page.getByRole('button', { name: /生成收票汇总/ }).click();
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new Error(`received receipt export UI returned ${response.status()}`);
  }
  await page.waitForSelector('text=打开收票汇总', { timeout: 10_000 });
}

async function runRoleUiProbe({ browser, baseUrl, outDir, role, credentials, headful }) {
  const screenshots = path.join(outDir, 'screenshots', role);
  await fsp.mkdir(screenshots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  const errors = [];
  const pages = [];
  attachPageErrorListeners(page, errors, role);

  try {
    await loginUi(page, baseUrl, credentials);
    for (const [name, routePath, opts = {}] of buildRoleUiRoutes(role)) {
      await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'networkidle' });
      if (opts.deniedPathIncludes && page.url().includes(opts.deniedPathIncludes)) {
        throw new Error(`${role} should be denied from ${routePath}, stayed at ${page.url()}`);
      }
      await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
      pages.push({
        role,
        name,
        url: page.url(),
        title: await page.title(),
        h1: await page.locator('h1').first().textContent().catch(() => ''),
      });
    }
    await assertMonthlySwitchReloads(page, baseUrl);
    if (role === 'reviewer') {
      await assertReceivedReceiptExportLink(page, baseUrl);
      await page.screenshot({ path: path.join(screenshots, 'ledger-export-link.png'), fullPage: true });
    }
    return { role, screenshots, pages, errors };
  } finally {
    await context.close();
    if (headful) {
      // Keep the parameter visible in the call site; contexts are still closed
      // so repeated probe runs do not leak browser state.
    }
  }
}

async function runUiProbe({ baseUrl, outDir, credentialsByRole, headful }) {
  const screenshots = path.join(outDir, 'screenshots');
  await fsp.mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: !headful });
  const roleResults = [];
  try {
    for (const [role, credentials] of Object.entries(credentialsByRole)) {
      roleResults.push(await runRoleUiProbe({
        browser,
        baseUrl,
        outDir,
        role,
        credentials,
        headful,
      }));
    }
    return {
      screenshots,
      roles: roleResults,
      pages: roleResults.flatMap((result) => result.pages),
      errors: roleResults.flatMap((result) => result.errors),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  await fsp.mkdir(args.outDir, { recursive: true });
  const results = {
    ok: false,
    baseUrl: args.baseUrl,
    outDir: args.outDir,
    steps: [],
    findings: [],
  };

  const password = `Probe!${stamp(new Date())}`;
  const workbooks = await createProbeWorkbooks(args.outDir);

  try {
    await step(results, 'cleanup previous probe workspaces', async () => cleanupProbeWorkspaces());
    let users = null;
    await step(results, 'ensure three role test users', async () => {
      users = await ensureProbeUsers(password);
      return redactProbeUsers(users);
    });
    let sessions = null;
    await step(results, 'login admin/reviewer/finance', async () => {
      sessions = {
        admin: await login(args.baseUrl, users.admin),
        reviewer: await login(args.baseUrl, users.reviewer),
        finance: await login(args.baseUrl, users.finance),
      };
      return redactSessions(sessions);
    });

    await step(results, 'open correct and wrong workspaces', async () => {
      await requestJson(args.baseUrl, '/api/monthly/workspaces', {
        cookie: sessions.admin.cookie,
        method: 'POST',
        body: { workspaceKey: '2099-01' },
      });
      await requestJson(args.baseUrl, '/api/monthly/workspaces', {
        cookie: sessions.admin.cookie,
        method: 'POST',
        body: { workspaceKey: '2099-02' },
      });
      await requestJson(args.baseUrl, '/api/monthly/workspaces', {
        cookie: sessions.admin.cookie,
        method: 'POST',
        body: { workspaceKey: '2099-03' },
      });
    });

    await step(results, 'wrong month import and delete rollback', async () => {
      const cookie = sessions.admin.cookie;
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-02/imports/group-code', { cookie, filePath: workbooks.group });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-02/imports/store-bill', { cookie, filePath: workbooks.bill });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-02/imports/daily-receipt', { cookie, filePath: workbooks.daily });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-02/imports/received-receipt', { cookie, filePath: workbooks.received });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-02/imports/missing', { cookie, filePath: workbooks.missing });
      const groupId = await getFirstId(args.baseUrl, '/api/monthly/workspaces/2099-02/group-codes', cookie);
      const billId = await getFirstId(args.baseUrl, '/api/monthly/workspaces/2099-02/bills', cookie);
      const dailyId = await getFirstId(args.baseUrl, '/api/monthly/workspaces/2099-02/ledger', cookie);
      const receivedId = await getFirstId(args.baseUrl, '/api/monthly/workspaces/2099-02/received-receipts', cookie);
      const missingId = await getFirstId(args.baseUrl, '/api/monthly/workspaces/2099-02/missing', cookie);
      for (const [route, id] of [
        ['delete-group-codes', groupId],
        ['delete-bill', billId],
        ['delete-daily', dailyId],
        ['delete-received-receipts', receivedId],
        ['delete-missing', missingId],
      ]) {
        await requestJson(args.baseUrl, `/api/monthly/workspaces/2099-02/batch/${route}`, {
          cookie,
          method: 'POST',
          body: { ids: [id] },
        });
      }
      const overview = await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-02/overview', { cookie });
      return overview.counts;
    });

    await step(results, 'correct month import pipeline publish edit republish', async () => {
      const admin = sessions.admin.cookie;
      const reviewer = sessions.reviewer.cookie;
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-01/imports/group-code', { cookie: admin, filePath: workbooks.group });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-01/imports/store-bill', { cookie: admin, filePath: workbooks.bill });
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-01/imports/daily-receipt', { cookie: reviewer, filePath: workbooks.daily });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/stages/tour-match', { cookie: reviewer, method: 'POST' });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/stages/bill-match', { cookie: reviewer, method: 'POST' });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/stages/merge', { cookie: reviewer, method: 'POST' });
      const ledger = await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/ledger', { cookie: reviewer });
      const id = ledger.rows[0].id;
      await requestJson(args.baseUrl, `/api/monthly/workspaces/2099-01/ledger/${id}/status`, {
        cookie: reviewer,
        method: 'POST',
        body: { ledgerStatus: 'ready_to_post' },
      });
      const publishA = requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/ledger/publish', {
        cookie: reviewer,
        method: 'POST',
        body: { ids: [id] },
      });
      const publishB = requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/ledger/publish', {
        cookie: reviewer,
        method: 'POST',
        body: { ids: [id] },
      });
      const both = await Promise.all([publishA, publishB]);
      const patch = await requestJson(args.baseUrl, `/api/monthly/workspaces/2099-01/ledger/${id}/fields`, {
        cookie: reviewer,
        method: 'PATCH',
        body: { tourNo: 'T209901-FIXED' },
      });
      if (patch.row.ledgerStatus !== 'ready_to_post') {
        throw new Error(`posted edit did not require republish: ${patch.row.ledgerStatus}`);
      }
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/ledger/publish', {
        cookie: reviewer,
        method: 'POST',
        body: { ids: [id] },
      });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/stages/bill-match', { cookie: reviewer, method: 'POST' });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/stages/merge', { cookie: reviewer, method: 'POST' });
      return { concurrentPublish: both, editedStatus: patch.row.ledgerStatus };
    });

    await step(results, 'role permission checks', async () => {
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/imports/daily-receipt', {
        cookie: sessions.finance.cookie,
        method: 'POST',
        body: new FormData(),
        expected: 403,
      });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/ledger/publish', {
        cookie: sessions.finance.cookie,
        method: 'POST',
        body: { ids: [] },
        expected: 403,
      });
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/exports/monthly-data', {
        cookie: sessions.reviewer.cookie,
        method: 'POST',
        expected: 403,
      });
      const monthlyExport = await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/exports/monthly-data', {
        cookie: sessions.finance.cookie,
        method: 'POST',
      });
      const receivedExport = await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-01/exports/received-receipt', {
        cookie: sessions.reviewer.cookie,
        method: 'POST',
      });
      if (!monthlyExport.files?.length) throw new Error('finance monthly export did not return files');
      if (!receivedExport.filename) throw new Error('reviewer received-receipt export did not return filename');
      return {
        monthlyExportFiles: monthlyExport.files.length,
        receivedReceipt: receivedExport.filename,
      };
    });

    await step(results, 'locked workspace rejects writes', async () => {
      const finance = sessions.finance.cookie;
      await uploadXlsx(args.baseUrl, '/api/monthly/workspaces/2099-03/imports/daily-receipt', {
        cookie: sessions.admin.cookie,
        filePath: workbooks.daily,
      });
      const ledger = await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-03/ledger', {
        cookie: sessions.admin.cookie,
      });
      const id = ledger.rows[0].id;
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-03/lock', {
        cookie: finance,
        method: 'POST',
      });
      const form = new FormData();
      form.append('file', new Blob([await fsp.readFile(workbooks.daily)]), 'daily-receipt.xlsx');
      await requestJson(args.baseUrl, '/api/monthly/workspaces/2099-03/imports/daily-receipt', {
        cookie: sessions.admin.cookie,
        method: 'POST',
        body: form,
        expected: 423,
      });
      await requestJson(args.baseUrl, `/api/monthly/workspaces/2099-03/ledger/${id}/fields`, {
        cookie: sessions.reviewer.cookie,
        method: 'PATCH',
        body: { tourNo: 'SHOULD-BLOCK' },
        expected: 423,
      });
    });

    const ui = await step(results, 'ui navigation screenshots', async () => runUiProbe({
      baseUrl: args.baseUrl,
      outDir: args.outDir,
      credentialsByRole: users,
      headful: args.headful,
    }));
    if (ui.errors.length) {
      results.findings.push({ severity: 'P1', title: 'UI console/server errors during navigation', details: ui.errors });
    }

    results.ok = results.steps.every((item) => item.ok) && results.findings.length === 0;
  } finally {
    if (!args.keepData) {
      cleanupProbeWorkspaces();
      await cleanupProbeUsers();
    }
    await fsp.writeFile(path.join(args.outDir, 'operator_regression_results.json'), JSON.stringify(results, null, 2));
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (!results.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildRoleUiRoutes,
  cleanupProbeWorkspaces,
  createProbeWorkbooks,
  parseArgs,
};
