'use strict';

/**
 * audit_distinct_endpoints — audit_log_repository 四个 distinct 查询测试 (Sprint E E0c)
 *
 * 测试 distinctUsers / distinctActions / distinctWorkspaces / distinctResourceTypes:
 *   1. 空表 → values=[]
 *   2. 单条记录 → 各字段正确返回
 *   3. 多条去重 → 每个值只出现一次，按 ASC 排序
 *   4. NULL 值过滤 → workspace_key=NULL 的行不出现在 distinctWorkspaces
 *   5. workspaceKey 过滤 → 只返回该 workspace 的值
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createAuditLogRepository } = require('../repositories/audit_log_repository');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0c-audit-dist-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createAuditLogRepository({ db });

  t.after(() => {
    try { db.close(); } catch { /* intentional */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* intentional */ }
  });
  return { db, repo };
}

test('E0c t1: 空表 → 所有 distinct 返回空数组', (t) => {
  const { repo } = setup(t);
  assert.deepEqual(repo.distinctUsers(), []);
  assert.deepEqual(repo.distinctActions(), []);
  assert.deepEqual(repo.distinctWorkspaces(), []);
  assert.deepEqual(repo.distinctResourceTypes(), []);
});

test('E0c t2: 单条记录 → 各字段正确返回', (t) => {
  const { repo } = setup(t);
  repo.log({
    workspaceKey: '2026-05',
    userId: 'alice',
    action: 'export_monthly',
    resourceType: 'monthly_data',
  });
  assert.deepEqual(repo.distinctUsers(), ['alice']);
  assert.deepEqual(repo.distinctActions(), ['export_monthly']);
  assert.deepEqual(repo.distinctWorkspaces(), ['2026-05']);
  assert.deepEqual(repo.distinctResourceTypes(), ['monthly_data']);
});

test('E0c t3: 多条去重，ASC 排序', (t) => {
  const { repo } = setup(t);
  repo.log({ workspaceKey: '2026-05', userId: 'charlie', action: 'run_merge', resourceType: 'stage_job' });
  repo.log({ workspaceKey: '2026-04', userId: 'alice',   action: 'import_daily', resourceType: 'daily_receipt' });
  repo.log({ workspaceKey: '2026-05', userId: 'alice',   action: 'run_merge', resourceType: 'stage_job' });
  repo.log({ workspaceKey: '2026-03', userId: 'bob',     action: 'export_monthly', resourceType: 'monthly_data' });

  const users = repo.distinctUsers();
  assert.deepEqual(users, ['alice', 'bob', 'charlie']);

  const actions = repo.distinctActions();
  assert.ok(actions.indexOf('export_monthly') < actions.indexOf('import_daily'));  // alphabetical
  assert.ok(actions.indexOf('import_daily') < actions.indexOf('run_merge'));

  const workspaces = repo.distinctWorkspaces();
  assert.deepEqual(workspaces, ['2026-03', '2026-04', '2026-05']);
});

test('E0c t4: workspace_key=NULL 的行不出现在 distinctWorkspaces', (t) => {
  const { repo } = setup(t);
  // login action: workspaceKey=null (auth action)
  repo.log({ workspaceKey: null, userId: 'alice', action: 'login', resourceType: 'auth' });
  repo.log({ workspaceKey: '2026-05', userId: 'alice', action: 'run_merge', resourceType: 'stage_job' });

  const workspaces = repo.distinctWorkspaces();
  assert.ok(!workspaces.includes(null), 'null should be excluded');
  assert.deepEqual(workspaces, ['2026-05']);
  // users should still include alice
  assert.deepEqual(repo.distinctUsers(), ['alice']);
});

test('E0c t5: workspaceKey 过滤 → 只返回该 workspace 的值', (t) => {
  const { repo } = setup(t);
  repo.log({ workspaceKey: '2026-05', userId: 'alice', action: 'run_merge',    resourceType: 'stage_job' });
  repo.log({ workspaceKey: '2026-04', userId: 'bob',   action: 'import_daily', resourceType: 'daily_receipt' });
  repo.log({ workspaceKey: '2026-05', userId: 'carol', action: 'export_monthly', resourceType: 'monthly_data' });

  const users = repo.distinctUsers({ workspaceKey: '2026-05' });
  assert.deepEqual(users, ['alice', 'carol']);
  assert.ok(!users.includes('bob'));

  const actions = repo.distinctActions({ workspaceKey: '2026-04' });
  assert.deepEqual(actions, ['import_daily']);

  const resTypes = repo.distinctResourceTypes({ workspaceKey: '2026-05' });
  assert.ok(resTypes.includes('stage_job'));
  assert.ok(resTypes.includes('monthly_data'));
  assert.ok(!resTypes.includes('daily_receipt'));
});
