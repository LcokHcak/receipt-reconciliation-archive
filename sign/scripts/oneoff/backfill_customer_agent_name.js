#!/usr/bin/env node
'use strict';
// customerAgentName 存量回填:normalizeTask 白名单曾漏该字段(存盘即抹),修复后老批次任务上仍是空。
// 从 customer_library/<ws>/<customerId>/customer.json 的 agentName 反灌回 batch.json 任务。
//
// 用法(服务器上;默认 dry-run 只报数,--apply 才写):
//   node scripts/backfill_customer_agent_name.js            # 干跑(随时可跑,只读)
//   pm2 stop sign-workbench && node scripts/backfill_customer_agent_name.js --apply && pm2 start sign-workbench
//
// ⚠️--apply 必须在服务停机的维护窗口跑,不是"低峰"——本脚本是读整份-改内存-写回:
//   服务若在读写之间对同一 batch.json 写了别的字段(审核/识别/看门狗/团号表解析),
//   会被本脚本的旧快照整份覆盖、静默丢失。tmp+rename 只保证"没人读到半截文件",不解决丢写。
//   脚本也在服务进程外,进不了 withBatchWrite 写队列——停机是唯一干净解。
// 附带影响(可接受):批次摘要缓存按 mtime 自失效(rename 改 mtime,重启后自愈);
//   workbench.sqlite 镜像要等该批次下次正常保存才同步——本字段仅供展示/分组,不进结算链。

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE = process.env.SIGN_STORAGE_ROOT
  || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const BATCHES = path.join(STORAGE, 'batches');
const LIBRARY = path.join(STORAGE, 'customer_library');
const APPLY = process.argv.includes('--apply');

const agentCache = new Map(); // 'ws/customerId' -> agentName
function agentNameOf(workspaceKey, customerId) {
  const key = `${workspaceKey}/${customerId}`;
  if (agentCache.has(key)) return agentCache.get(key);
  let name = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(LIBRARY, workspaceKey, customerId, 'customer.json'), 'utf8'));
    name = String(d.agentName || '').trim();
  } catch { /* 客户不存在/损坏 → 留空跳过 */ }
  agentCache.set(key, name);
  return name;
}

// task.sourceOriginalPath 形如 "260702-小票11/CL20260708-016/images/x.jpg" → [workspace, customerId]
function refOf(task) {
  const parts = String(task.sourceOriginalPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return { ws: parts[0], cid: parts[1] };
  return null;
}

let batchesTouched = 0; let tasksFilled = 0; let tasksSkippedNoRef = 0; let tasksSkippedNoAgent = 0;
for (const dir of fs.readdirSync(BATCHES)) {
  const file = path.join(BATCHES, dir, 'batch.json');
  let batch;
  try { batch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  let dirty = false;
  for (const task of batch.tasks || []) {
    if (String(task.customerAgentName || '').trim()) continue; // 已有值不动
    const ref = refOf(task);
    if (!ref) { tasksSkippedNoRef += 1; continue; }
    const agent = agentNameOf(ref.ws, ref.cid);
    if (!agent) { tasksSkippedNoAgent += 1; continue; }
    task.customerAgentName = agent;
    tasksFilled += 1;
    dirty = true;
  }
  if (dirty) {
    batchesTouched += 1;
    if (APPLY) {
      const tmp = `${file}.backfill-tmp`;
      fs.writeFileSync(tmp, JSON.stringify(batch, null, 2));
      fs.renameSync(tmp, file); // 原子替换,避免写一半被读到
    }
  }
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY(已写盘)' : 'DRY-RUN(只报数,加 --apply 实写)',
  batchesTouched,
  tasksFilled,
  tasksSkippedNoRef,
  tasksSkippedNoAgent,
}, null, 1));
