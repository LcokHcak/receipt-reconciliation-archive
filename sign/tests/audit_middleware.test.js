const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { createAuditMiddleware } = require('../lib/audit_middleware');

async function withServer(t, app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('audit middleware matches current monthly import and export routes', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({
    auditLogRepo: {
      log(entry) {
        logs.push(entry);
      },
    },
  }));
  app.post('/api/monthly/workspaces/:workspaceKey/imports/daily-receipt', (_req, res) => res.json({ ok: true }));
  app.post('/api/monthly/workspaces/:workspaceKey/exports/monthly-data', (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);

  await fetch(`${baseUrl}/api/monthly/workspaces/2026-01/imports/daily-receipt`, { method: 'POST' });
  await fetch(`${baseUrl}/api/monthly/workspaces/2026-01/exports/monthly-data`, { method: 'POST' });

  assert.deepEqual(logs.map((entry) => entry.action), ['import_daily', 'export_monthly']);
  assert.deepEqual(logs.map((entry) => entry.workspaceKey), ['2026-01', '2026-01']);
});

test('D4a: audit middleware covers 5 previously missing routes', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));

  // Register the 5 new routes
  app.post('/api/monthly/workspaces', (_req, res) => res.json({ ok: true }));
  app.post('/api/monthly/workspaces/:workspaceKey/clear', (_req, res) => res.json({ ok: true }));
  app.post('/api/monthly/workspaces/:workspaceKey/ledger/:id/status', (_req, res) => res.json({ ok: true }));
  app.put('/api/monthly/workspaces/:workspaceKey/deduct-config', (_req, res) => res.json({ ok: true }));
  app.put('/api/monthly/workspaces/:workspaceKey/mode-mapping', (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);

  await fetch(`${baseUrl}/api/monthly/workspaces`, { method: 'POST' });
  await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/clear`, { method: 'POST' });
  await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/ledger/42/status`, { method: 'POST' });
  await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/deduct-config`, { method: 'PUT' });
  await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/mode-mapping`, { method: 'PUT' });

  const actions = logs.map((entry) => entry.action);
  assert.ok(actions.includes('create_workspace'), 'create_workspace must be logged');
  assert.ok(actions.includes('clear_workspace'), 'clear_workspace must be logged');
  assert.ok(actions.includes('update_ledger_status'), 'update_ledger_status must be logged');
  assert.ok(actions.includes('update_deduct_config'), 'update_deduct_config must be logged');
  assert.ok(actions.includes('update_mode_mapping'), 'update_mode_mapping must be logged');

  // workspaceKey extracted correctly from URL
  const clearLog = logs.find((e) => e.action === 'clear_workspace');
  assert.equal(clearLog?.workspaceKey, '2026-05');
  const ledgerLog = logs.find((e) => e.action === 'update_ledger_status');
  assert.equal(ledgerLog?.workspaceKey, '2026-05');
  assert.equal(ledgerLog?.resourceId, '42');
});

// ── 批次导出留痕(P1,2026-07-18)────────────────────────────────────────────
test('P1: 批次导出路由留痕——batchId 落 resourceId 而非 workspaceKey', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  app.post('/api/batches/:batchId/export', (_req, res) => res.json({ ok: true }));
  app.post('/api/batches/:batchId/export-mode-delivery', (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);
  await fetch(`${baseUrl}/api/batches/batch_001/export`, { method: 'POST' });
  await fetch(`${baseUrl}/api/batches/batch_001/export-mode-delivery`, { method: 'POST' });

  assert.deepEqual(logs.map((e) => e.action), ['export_batch', 'export_delivery']);
  // 组1是 batchId:必须落 resourceId,不能污染 workspaceKey(月度审计按 workspace 过滤)
  assert.equal(logs[0].resourceId, 'batch_001');
  assert.equal(logs[0].workspaceKey, null);
  assert.equal(logs[0].resourceType, 'batch');
});

test('P1: res.download 流式响应也留痕(finish 兜底;send/json 拦不到下载)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpFile = path.join(os.tmpdir(), `audit_dl_probe_${process.pid}.txt`);
  fs.writeFileSync(tmpFile, 'zip-bytes');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch { /* 清理失败不致命 */ } });

  const logs = [];
  const app = express();
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  app.post('/api/batches/:batchId/export-customer-data', (_req, res) => res.download(tmpFile, 'pack.zip'));

  const baseUrl = await withServer(t, app);
  const resp = await fetch(`${baseUrl}/api/batches/batch_dl/export-customer-data`, { method: 'POST' });
  await resp.arrayBuffer();
  // finish 事件在响应流结束后触发,轮询等一拍
  for (let i = 0; i < 50 && logs.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(logs.length, 1, '下载响应必须留痕');
  assert.equal(logs[0].action, 'export_delivery');
  assert.equal(logs[0].resourceId, 'batch_dl');
});

test('客户数据Excel下载(GET,含姓名+护照号)留痕 + query 范围记进 details(审计MEDIUM)', async (t) => {
  const logs = [];
  const app = express();
  app.use(createAuditMiddleware({ auditLogRepo: { log(entry) { logs.push(entry); } } }));
  // 流式写 xlsx(与生产同款:不经 send/json,靠 finish 兜底)
  app.get('/api/monthly/library-export/download', (_req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.write('xlsx-bytes'); res.end();
  });

  const baseUrl = await withServer(t, app);
  const resp = await fetch(`${baseUrl}/api/monthly/library-export/download?workspaceKey=2026-07&batchId=b_x`);
  await resp.arrayBuffer();
  for (let i = 0; i < 50 && logs.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(logs.length, 1, 'PII Excel 下载必须留痕(此前零审计)');
  assert.equal(logs[0].action, 'export_library_excel');
  assert.equal(logs[0].resourceType, 'library_excel');
  assert.equal(logs[0].workspaceKey, '2026-07', 'query 里的 workspaceKey 落审计');
  assert.deepEqual(logs[0].details.query, { workspaceKey: '2026-07', batchId: 'b_x' }, '导的是哪个工作区/批次可溯');
});

test('删除动作全部留痕:删票/删客户组/删客户/删图/整库删/库清理(审计MEDIUM)', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({ auditLogRepo: { log(entry) { logs.push(entry); } } }));
  app.delete('/api/batches/:batchId/tasks/:taskId', (_req, res) => res.json({ ok: true }));
  app.delete('/api/batches/:batchId/source-groups/:groupKey/customer', (_req, res) => res.json({ ok: true }));
  app.delete('/api/customer-library/workspaces/:workspaceKey', (_req, res) => res.json({ ok: true }));
  app.delete('/api/customer-library/workspaces/:workspaceKey/customers/:customerId', (_req, res) => res.json({ ok: true }));
  app.delete('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId', (_req, res) => res.json({ ok: true }));
  app.post('/api/customer-library/cleanup/delete', (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);
  await fetch(`${baseUrl}/api/batches/b1/tasks/t1`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/batches/b1/source-groups/g1/customer`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/customer-library/workspaces/ws1`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/customer-library/workspaces/ws1/customers/CL1`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/customer-library/workspaces/ws1/customers/CL1/images/img1`, { method: 'DELETE' });
  await fetch(`${baseUrl}/api/customer-library/cleanup/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  assert.deepEqual(logs.map((e) => e.action), [
    'delete_task', 'delete_customer_group', 'delete_workspace_library', 'delete_customer', 'delete_customer_image', 'cleanup_orphans',
  ], '六条删除动作全部留痕');
  // 批次侧 batchId 落 resourceId;客户库侧 workspaceKey 落 workspaceKey/customerId 落 resourceId
  assert.equal(logs[0].resourceId, 'b1', '删票:batchId 落 resourceId');
  assert.equal(logs[2].workspaceKey, 'ws1', '整库删:workspaceKey 可溯');
  assert.equal(logs[3].resourceId, 'CL1', '删客户:customerId 落 resourceId');
});

test('审计: 客户端中断下载(close 不 finish)也留痕(2026-07-19 审计M)', async (t) => {
  const logs = [];
  const app = express();
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  // 慢流式响应:写一块后悬住,等客户端 abort
  app.post('/api/batches/:batchId/export-mode-delivery', (_req, res) => {
    res.status(200).type('application/zip');
    res.write('chunk-1');
    // 不 end:保持挂起直到客户端断开
  });

  const baseUrl = await withServer(t, app);
  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/api/batches/batch_abort/export-mode-delivery`, {
    method: 'POST', signal: controller.signal,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await pending;
  for (let i = 0; i < 50 && logs.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(logs.length, 1, '中断的下载动作已经发生,必须留痕');
  assert.equal(logs[0].action, 'export_delivery');
  assert.equal(logs[0].resourceId, 'batch_abort');
});

// ── 结算/确认/组通过/整批删留痕(8模块审计 HIGH:结算全链路零 audit_log)────────────
test('审计: settle/confirm-modes/approve/delete-batch 四条结算类路由全部留痕，batchId 落 resourceId', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  app.post('/api/batches/:batchId/source-groups/:groupKey/settle', (_req, res) => res.json({ ok: true }));
  app.post('/api/batches/:batchId/source-groups/:groupKey/confirm-modes', (_req, res) => res.json({ ok: true }));
  app.post('/api/batches/:batchId/source-groups/:groupKey/approve', (_req, res) => res.json({ ok: true }));
  app.delete('/api/batches/:batchId', (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);
  await fetch(`${baseUrl}/api/batches/batch_9/source-groups/g1/settle`, { method: 'POST' });
  await fetch(`${baseUrl}/api/batches/batch_9/source-groups/g1/confirm-modes`, { method: 'POST' });
  await fetch(`${baseUrl}/api/batches/batch_9/source-groups/g1/approve`, { method: 'POST' });
  await fetch(`${baseUrl}/api/batches/batch_9`, { method: 'DELETE' });

  assert.deepEqual(
    logs.map((e) => e.action),
    ['settle_group', 'confirm_group_modes', 'approve_group', 'delete_batch'],
    '四条结算类动作全部留痕',
  );
  // batchId 落 resourceId,不污染 workspaceKey(月度审计按 workspace 过滤);groupKey 可从 details.path 溯回
  for (const e of logs) {
    assert.equal(e.resourceId, 'batch_9', 'batchId 落 resourceId');
    assert.equal(e.workspaceKey, null, '不污染 workspaceKey');
  }
  const settleLog = logs.find((e) => e.action === 'settle_group');
  assert.equal(settleLog.resourceType, 'daily_receipt');
  assert.match(settleLog.details.path, /source-groups\/g1\/settle$/, 'groupKey 在 details.path 可溯');
});

test('审计: 结算类路由非2xx不留痕(失败的结算不算数)', async (t) => {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  app.post('/api/batches/:batchId/source-groups/:groupKey/settle', (_req, res) => res.status(409).json({ error: '团号未确认' }));

  const baseUrl = await withServer(t, app);
  await fetch(`${baseUrl}/api/batches/batch_x/source-groups/g1/settle`, { method: 'POST' });
  assert.equal(logs.length, 0, '409 失败的结算不留痕(只记成功动作)');
});

test('P1: userId 在响应时读取——路由级鉴权填的 req.user 必须被记上(anonymous 病根)', async (t) => {
  const logs = [];
  const app = express();
  app.use(createAuditMiddleware({
    auditLogRepo: { log(entry) { logs.push(entry); } },
  }));
  // 模拟路由级鉴权:audit 中间件之后、handler 之前才填 req.user(与生产一致)
  const fakeAuth = (req, _res, next) => { req.user = { username: '小票03' }; next(); };
  app.post('/api/batches/:batchId/export', fakeAuth, (_req, res) => res.json({ ok: true }));

  const baseUrl = await withServer(t, app);
  await fetch(`${baseUrl}/api/batches/b1/export`, { method: 'POST' });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].userId, '小票03', '早读 req.user 会退化成 anonymous');
});
