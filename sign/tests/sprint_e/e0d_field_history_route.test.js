'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createDailyFieldHistoryRepository } = require('../../repositories/daily_field_history_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createMonthlyRoutes } = require('../../routes/monthly_routes');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0d-history-route-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'tester' });
  const historyRepo = createDailyFieldHistoryRepository({ db });

  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { db, workspaceService, historyRepo };
}

async function getHistory(ctx, dailyRowId, query = '') {
  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService: ctx.workspaceService,
    importService: {},
    errorDetectionService: {},
    dailyFieldHistoryRepo: ctx.historyRepo,
    upload: { single: () => (_req, _res, next) => next() },
  }).register(app, null);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}/api/monthly/v2/${WS}/daily/${dailyRowId}/history${query}`);
        resolve({ status: res.status, body: await res.json() });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test('E5 t1: history route returns empty items for a row without history', async (t) => {
  const ctx = setup(t);
  const res = await getHistory(ctx, 999999);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.deepEqual(res.body.rows, []);
  assert.equal(res.body.total, 0);
});

test('E5 t2: history route returns rows ordered by timestamp descending', async (t) => {
  const ctx = setup(t);
  for (let i = 1; i <= 5; i += 1) {
    ctx.historyRepo.recordChanges({
      workspaceKey: WS,
      dailyRowId: 501,
      changeSource: 'manual_edit',
      actor: 'tester',
      ts: `2026-05-23T10:0${i}:00.000Z`,
      changes: { tour_no: { before: String(i - 1), after: String(i) } },
    });
  }

  const res = await getHistory(ctx, 501, '?limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 5);
  assert.deepEqual(res.body.items.map((row) => row.afterValue), ['"5"', '"4"', '"3"', '"2"', '"1"']);
  assert.deepEqual(res.body.rows.map((row) => row.id), res.body.items.map((row) => row.id));
});

test('E5 t3: history route filters by source', async (t) => {
  const ctx = setup(t);
  ctx.historyRepo.recordChanges({
    workspaceKey: WS,
    dailyRowId: 601,
    changeSource: 'manual_edit',
    actor: 'tester',
    changes: { tour_no: { before: '71990', after: '88888' } },
  });
  ctx.historyRepo.recordChanges({
    workspaceKey: WS,
    dailyRowId: 601,
    changeSource: 'ocr',
    actor: 'system',
    changes: { mode_folder: { before: null, after: 'lotte' } },
  });

  const res = await getHistory(ctx, 601, '?source=manual_edit');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].changeSource, 'manual_edit');
});
