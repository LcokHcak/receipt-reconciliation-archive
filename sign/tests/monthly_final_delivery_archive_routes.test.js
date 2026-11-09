'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { registerExportRoutes } = require('../routes/monthly/export_routes');

const WORKSPACE_KEY = '2026-01';

test('final delivery export returns a selected zip archive and makes it downloadable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-delivery-archive-route-'));
  const exportRoot = path.join(dir, 'exports');
  const app = express();
  app.use(express.json());

  registerExportRoutes({
    app,
    guards: { read: [], fieldReview: [], finalReview: [] },
    deps: {
      monthlyExportService: {},
      exportRoot,
      workspaceService: { getOrThrow: () => ({ workspaceKey: WORKSPACE_KEY }) },
      finalDeliveryExportService: createStubFinalDeliveryService(),
    },
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/final-delivery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageTypes: ['data'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.archive.packageTypes.join(','), 'data');
  assert.match(body.archive.filename, /\.zip$/);
  assert.match(body.archive.downloadPath, /\/exports\/files\/.+\.zip$/);

  const zipRes = await fetch(`${baseUrl}${body.archive.downloadPath}`);
  assert.equal(zipRes.status, 200);
  const bytes = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');
});

test('export file list supports server-side pagination', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-files-pagination-'));
  const exportRoot = path.join(dir, 'exports');
  const workspaceDir = path.join(exportRoot, WORKSPACE_KEY);
  fs.mkdirSync(path.join(workspaceDir, 'batch-a'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'batch-a', 'a.xlsx'), 'a');
  await touch(path.join(workspaceDir, 'batch-a', 'a.xlsx'), Date.now() - 3000);
  fs.writeFileSync(path.join(workspaceDir, 'batch-a', 'b.pdf'), 'b');
  await touch(path.join(workspaceDir, 'batch-a', 'b.pdf'), Date.now() - 2000);
  fs.writeFileSync(path.join(workspaceDir, 'c.zip'), 'c');
  await touch(path.join(workspaceDir, 'c.zip'), Date.now() - 1000);

  const app = express();
  app.use(express.json());
  registerExportRoutes({
    app,
    guards: { read: [], fieldReview: [], finalReview: [] },
    deps: {
      monthlyExportService: {},
      exportRoot,
      workspaceService: { getOrThrow: () => ({ workspaceKey: WORKSPACE_KEY }) },
      finalDeliveryExportService: createStubFinalDeliveryService(),
    },
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/files?limit=2&offset=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 3);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 1);
  assert.equal(body.hasMore, false);
  assert.equal(body.files.length, 2);
  assert.deepEqual(body.files.map((f) => f.filename), [
    path.join('batch-a', 'b.pdf'),
    path.join('batch-a', 'a.xlsx'),
  ]);
});

function createStubFinalDeliveryService() {
  return {
    checkReadiness() {
      return { ok: true, eligibleRows: 1, excluded: {}, blocking: [], warnings: [] };
    },
    async run({ workspaceKey, outputDir }) {
      const packageDir = path.join(outputDir, `${workspaceKey}_final_delivery`);
      const dataDir = path.join(packageDir, '4_最终数据');
      const customerPdfDir = path.join(packageDir, '客户PDF');
      const customerPackageDir = path.join(packageDir, '客户数据包', 'HAN P123');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(customerPdfDir, { recursive: true });
      fs.mkdirSync(customerPackageDir, { recursive: true });

      const dataFile = path.join(dataDir, '乐天首尔-最终数据.xlsx');
      const manifestPath = path.join(packageDir, '交付清单.json');
      const pdfFile = path.join(customerPdfDir, 'HAN P123.pdf');
      const customerFile = path.join(customerPackageDir, 'manifest.json');
      fs.writeFileSync(dataFile, 'xlsx');
      fs.writeFileSync(manifestPath, '{}');
      fs.writeFileSync(pdfFile, '%PDF');
      fs.writeFileSync(customerFile, '{}');

      return {
        workspaceKey,
        outputDir: packageDir,
        producedAt: '2026-06-09T00:00:00.000Z',
        readiness: this.checkReadiness(),
        files: [
          { kind: 'final_data', folder: '乐天首尔', path: dataFile, rows: 1 },
          { kind: 'manifest', folder: null, path: manifestPath, rows: 1 },
        ],
        customerPdfs: [
          { kind: 'customer_pdf', folder: '乐天首尔', path: pdfFile, rows: 1 },
        ],
        dataPackages: [
          { kind: 'customer_data_package', folder: '乐天首尔', path: customerPackageDir, rows: 1 },
        ],
      };
    },
  };
}

async function touch(filePath, mtimeMs) {
  const when = new Date(mtimeMs);
  fs.utimesSync(filePath, when, when);
}
