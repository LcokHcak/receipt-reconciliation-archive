'use strict';

const { isTestWorkspace } = require('../../lib/monthly/test_workspace');

function parseWorkspaceKey(workspaceKey) {
  const raw = String(workspaceKey || '').trim();
  const m = /^(demo-)?(\d{4})-(\d{1,2})$/.exec(raw);
  if (!m) throw new Error('workspaceKey must match YYYY-MM or demo-YYYY-MM');
  const year = Number(m[2]);
  const month = Number(m[3]);
  if (month < 1 || month > 12) throw new Error('month out of range');
  const key = `${m[1] || ''}${m[2]}-${String(month).padStart(2, '0')}`;
  return {
    isDemo: Boolean(m[1]),
    year,
    month,
    key,
  };
}

function createMonthlyWorkspaceService({ workspaceRepo }) {
  if (!workspaceRepo) throw new Error('workspaceRepo is required');

  return {
    list({ mode = 'production' } = {}) {
      if (mode === 'test') return workspaceRepo.listTest();
      if (mode === 'all') return workspaceRepo.list();
      return workspaceRepo.listProduction();
    },
    listProduction() {
      return workspaceRepo.listProduction();
    },
    listTest() {
      return workspaceRepo.listTest();
    },
    parseKey(workspaceKey) {
      return parseWorkspaceKey(workspaceKey);
    },
    isTestWorkspace(workspaceKey) {
      return parseWorkspaceKey(workspaceKey).isDemo || isTestWorkspace(workspaceKey);
    },
    open({ workspaceKey, operator }) {
      const { year, month, key } = parseWorkspaceKey(workspaceKey);
      const now = new Date().toISOString();
      const existing = workspaceRepo.findByKey(key);
      if (existing) return existing;
      return workspaceRepo.upsert({
        workspaceKey: key,
        year,
        month,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        metadata: { openedBy: operator || null },
      });
    },
    lock({ workspaceKey, operator }) {
      const { key } = parseWorkspaceKey(workspaceKey);
      const existing = workspaceRepo.findByKey(key);
      if (!existing) throw new Error(`workspace not found: ${key}`);
      const now = new Date().toISOString();
      return workspaceRepo.updateStatus({
        workspaceKey: key,
        status: 'locked',
        updatedAt: now,
        lockedAt: now,
        lockedBy: operator || null,
      });
    },
    // G8-fix(G3): admin 解锁 — 把 status 改回 'open' 同时清 lockedAt/lockedBy。
    // 不可逆但要审计,所以路由层会强制 admin 角色 + audit_log 记录。
    unlock({ workspaceKey }) {
      const { key } = parseWorkspaceKey(workspaceKey);
      const existing = workspaceRepo.findByKey(key);
      if (!existing) throw new Error(`workspace not found: ${key}`);
      if (existing.status !== 'locked') {
        throw new Error(`workspace ${key} is not locked (status=${existing.status})`);
      }
      const now = new Date().toISOString();
      // lockedAt=null + lockedBy=null 就是"未锁"状态;谁解的由 audit_log 记录
      return workspaceRepo.updateStatus({
        workspaceKey: key,
        status: 'open',
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
      });
    },
    archive({ workspaceKey }) {
      const { key } = parseWorkspaceKey(workspaceKey);
      const existing = workspaceRepo.findByKey(key);
      if (!existing) throw new Error(`workspace not found: ${key}`);
      const now = new Date().toISOString();
      return workspaceRepo.updateStatus({
        workspaceKey: key,
        status: 'archived',
        updatedAt: now,
        lockedAt: existing.lockedAt,
        lockedBy: existing.lockedBy,
      });
    },
    getOrThrow(workspaceKey) {
      const { key } = parseWorkspaceKey(workspaceKey);
      const existing = workspaceRepo.findByKey(key);
      if (!existing) throw new Error(`workspace not found: ${key}`);
      return existing;
    },
  };
}

module.exports = {
  createMonthlyWorkspaceService,
  parseWorkspaceKey,
};
