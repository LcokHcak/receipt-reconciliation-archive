#!/usr/bin/env node
'use strict';
// 台账百货行 上家/代理 存量回填(2026-07-20 百货交付重构§4/F6/F7):
//   上家:桥自 7b35e41(百货P4)就写 upstream,但更早结算的百货行是空;客户数据 Excel
//     新增「上家」列后,空值行对不上账。
//   代理:normalizeTask 曾漏 customerAgentName 白名单(存盘即抹,70c9469 已修;批次任务侧
//     另有 backfill_customer_agent_name.js 停机回填),但**修复前结算入台账的行 agent 永远空**
//     ——台账没有二次机会,现代百货行代理列空(用户截图报障)即此因。
//
// 逐行规则(dry-run 默认,--apply 才写;执行前等用户批):
//   取行:source_type='workbench' 且 (upstream 空 或 agent 空) 且 batch/task id 齐。
//   只碰百货行:shop → getStoreProfile family=DEPT(乐天百货无上家字段,upstream 兜底恒空,
//     只可能补 agent;新世界/现代两列都可能补)。
//   上家 = 任务 upstreamFinal||upstreamAuto → 档案 defaults.upstream(新世界=梁总/现代=东方;
//     金浦奥莱只能来自任务值——贴卡是人工判定,兜底不猜)。
//   代理 = 任务 customerAgentName→sourceGroupLabel→sourceFolderName→sourceFolderPath
//     → customer_library/<ws>/<客户号>/customer.json 的 agentName(与 backfill_customer_agent_name 同源)。
//   只补空列,非空恒不动(人工改过的值不覆盖);row_hash 不含 upstream/agent,不动哈希。
//
// 用法(服务器上):
//   node scripts/oneoff/backfill_dept_upstream_agent.js           # 干跑(只读,随时可跑)
//   node scripts/oneoff/backfill_dept_upstream_agent.js --apply   # 实写(单行 UPDATE 幂等,低峰即可,无需停机)
//   环境变量 SIGN_STORAGE_ROOT 可指到别的 storage(默认 <repo>/passport_review_workbench/storage)

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = process.env.SIGN_STORAGE_ROOT
  || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const BATCHES = path.join(STORAGE, 'batches');
const LIBRARY = path.join(STORAGE, 'customer_library');
const APPLY = process.argv.includes('--apply');

const { getStoreProfile, FAMILY, resolveDeptUpstream } = require('../../lib/store_profiles');
const { normalizeStoreFamily } = require('../../lib/validation/field_rules');
const { parseCustomerRefFromTask } = require('../../lib/customer_ref');

const db = new DatabaseSync(path.join(STORAGE, 'monthly.sqlite'));

const textOf = (v) => String(v == null ? '' : v).trim();

// 批次任务缓存:batchId → Map(taskId → task);批次 JSON 只读不写。
const batchCache = new Map();
function tasksOfBatch(batchId) {
  if (batchCache.has(batchId)) return batchCache.get(batchId);
  let map;
  try {
    const batch = JSON.parse(fs.readFileSync(path.join(BATCHES, batchId, 'batch.json'), 'utf8'));
    map = new Map((batch.tasks || []).map((t) => [String(t.id || ''), t]));
  } catch { map = null; /* 批次已删/损坏 → 该批次全部跳过 */ }
  batchCache.set(batchId, map);
  return map;
}

// 客户库 agentName 缓存(与 backfill_customer_agent_name.js 同源路径)
const agentCache = new Map();
function libraryAgentName(workspaceKey, customerId) {
  if (!workspaceKey || !customerId) return '';
  const key = `${workspaceKey}/${customerId}`;
  if (agentCache.has(key)) return agentCache.get(key);
  let name;
  try {
    const customer = JSON.parse(fs.readFileSync(path.join(LIBRARY, workspaceKey, customerId, 'customer.json'), 'utf8'));
    name = textOf(customer.agentName);
  } catch { name = ''; }
  agentCache.set(key, name);
  return name;
}

function resolveAgent(task) {
  const fromTask = textOf(task?.customerAgentName) || textOf(task?.sourceGroupLabel)
    || textOf(task?.sourceFolderName) || textOf(task?.sourceFolderPath);
  if (fromTask) return fromTask;
  const ref = parseCustomerRefFromTask(task || {});
  return libraryAgentName(ref.workspaceKey, ref.customerId);
}

const rows = db.prepare(`
  SELECT id, workspace_key AS ws, shop, upstream, agent,
         source_batch_id AS batchId, source_task_id AS taskId
  FROM daily_receipt_export
  WHERE source_type = 'workbench'
    AND source_batch_id IS NOT NULL AND TRIM(source_batch_id) <> ''
    AND source_task_id IS NOT NULL AND TRIM(source_task_id) <> ''
    AND (upstream IS NULL OR TRIM(upstream) = '' OR agent IS NULL OR TRIM(agent) = '')
`).all();

const updateStmt = db.prepare('UPDATE daily_receipt_export SET upstream = ?, agent = ? WHERE id = ?');

let scanned = 0;
let nonDept = 0;
let unchanged = 0;
let toFix = 0;
let applied = 0;
let skippedNoBatch = 0;
let skippedNoTask = 0;
const fixes = []; // 对账清单

for (const row of rows) {
  scanned += 1;
  const storeFamily = normalizeStoreFamily(textOf(row.shop));
  if (getStoreProfile(storeFamily).family !== FAMILY.DEPT) { nonDept += 1; continue; }
  const tasks = tasksOfBatch(String(row.batchId));
  if (!tasks) { skippedNoBatch += 1; continue; }
  const task = tasks.get(String(row.taskId));
  if (!task) { skippedNoTask += 1; continue; }

  // 只补空列;非空恒不动(人工改过的值不覆盖);上家解析=resolveDeptUpstream 单一真相(与交付规则5同源)
  const nextUpstream = textOf(row.upstream) || resolveDeptUpstream(storeFamily, task);
  const nextAgent = textOf(row.agent) || resolveAgent(task);
  if (nextUpstream === textOf(row.upstream) && nextAgent === textOf(row.agent)) { unchanged += 1; continue; }

  toFix += 1;
  fixes.push({
    ws: row.ws, id: row.id, task: `${row.batchId}/${row.taskId}`, shop: row.shop || '',
    upstream: `${textOf(row.upstream) || '(空)'} -> ${nextUpstream || '(空)'}`,
    agent: `${textOf(row.agent) || '(空)'} -> ${nextAgent || '(空)'}`,
  });
  if (APPLY) {
    updateStmt.run(nextUpstream || null, nextAgent || null, Number(row.id));
    applied += 1;
  }
}

// 对账清单(可重定向留档:node ... > backfill_dept_upstream_agent.report.txt)
for (const f of fixes) {
  console.log(`FIX ${f.ws} #${f.id} ${f.task} [${f.shop}] 上家 ${f.upstream} | 代理 ${f.agent}`);
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY(已写盘)' : 'DRY-RUN(只报数+清单,加 --apply 实写)',
  scannedEmptyRows: scanned,
  nonDept,
  unchanged,
  toFix,
  applied,
  skippedNoBatch,
  skippedNoTask,
}, null, 1));

db.close();
