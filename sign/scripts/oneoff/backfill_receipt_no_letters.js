#!/usr/bin/env node
'use strict';
// 台账小票号存量回填(2026-07-20 交付包五问题#5修③):
//   桥接兜底曾走 normalizeReceiptNoDigits(数字投影),济州乐天V的字母 G、现代/新世界的
//   横线在**存储层**被剥没(90G331-26-000309 → 9033126000309)。修①后新结算行已按
//   computeLedgerReceiptNo 口径落库;本脚本把存量"纯数字行"按批次任务的原串订正回来。
//
// 逐行规则(单一真相=services/workbench_ledger_bridge_service.computeLedgerReceiptNo,禁副本):
//   取行条件:source_type='workbench' 且 receipt_no 纯数字 且 source_task_id 非空。
//   回查:source_batch_id → batches/<id>/batch.json → task(source_task_id)→ 重算合同值。
//   护栏:合同值的数字投影必须与现存纯数字一致(normalizeReceiptNoDigits 相等)才改——
//         数字核对不上=票号被人改过/任务串号,不是归一化丢字符,跳过并单列报告。
//   不同才 UPDATE receipt_no;**row_hash 一律不动**(哈希≠存储:兜底路径修①后本就按
//   数字投影计算,老哈希继续兼容;若同改哈希反而会撞 UNIQUE(workspace_key,row_hash)
//   或破坏与已存在重复行的去重)。
//
// 用法(服务器上;默认 dry-run 只报数+清单,--apply 才写;执行前等用户批):
//   node scripts/oneoff/backfill_receipt_no_letters.js             # 干跑(只读,随时可跑)
//   node scripts/oneoff/backfill_receipt_no_letters.js --apply     # 实写(建议低峰)
//   环境变量 SIGN_STORAGE_ROOT 可指到别的 storage(默认 <repo>/passport_review_workbench/storage)
// 并发安全:只做单行单列 UPDATE(幂等,二跑无变化);不改批次 JSON(纯读)。低峰跑即可,
//   无需停机(与 backfill_customer_agent_name 整文件覆盖不同,不存在丢写窗口)。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = process.env.SIGN_STORAGE_ROOT
  || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const BATCHES = path.join(STORAGE, 'batches');
const APPLY = process.argv.includes('--apply');

const { computeLedgerReceiptNo } = require('../../services/workbench_ledger_bridge_service');
const { normalizeReceiptNoDigits } = require('../../lib/workbench_field_normalizer');
const { setModeRuleResolver } = require('../../lib/mode_record_matrix');
const { createModeConfigRepository } = require('../../repositories/mode_config_repository');
const { createModeConfigResolver } = require('../../services/mode_config_resolver');

const db = new DatabaseSync(path.join(STORAGE, 'monthly.sqlite'));

// 模式规则与生产同源:优先 DB 配置(配置台改过的形态),坏配置自动回落出厂矩阵。
try {
  const modeConfigRepository = createModeConfigRepository({ db });
  setModeRuleResolver(createModeConfigResolver({
    modeConfigRepository,
    logger: { info() {}, warn() {}, error() {} },
  }).getModeRecordRule);
} catch (err) {
  console.error(`[warn] 模式配置接线失败,按出厂矩阵重算: ${err?.message || err}`);
}

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

const rows = db.prepare(`
  SELECT id, workspace_key AS ws, receipt_no AS receiptNo,
         source_batch_id AS batchId, source_task_id AS taskId, shop
  FROM daily_receipt_export
  WHERE source_type = 'workbench'
    AND source_task_id IS NOT NULL AND TRIM(source_task_id) <> ''
    AND source_batch_id IS NOT NULL AND TRIM(source_batch_id) <> ''
    AND receipt_no IS NOT NULL AND receipt_no <> ''
`).all().filter((r) => /^\d+$/.test(String(r.receiptNo))); // 只看纯数字行(被投影过的嫌疑面)

const updateStmt = db.prepare('UPDATE daily_receipt_export SET receipt_no = ? WHERE id = ?');

let scanned = 0;
let unchanged = 0;
let toFix = 0;
let applied = 0;
let skippedNoBatch = 0;
let skippedNoTask = 0;
let skippedDigitsMismatch = 0;
const fixes = []; // 对账清单
const mismatches = []; // 数字核对不上的另册(人工看)

for (const row of rows) {
  scanned += 1;
  const tasks = tasksOfBatch(String(row.batchId));
  if (!tasks) { skippedNoBatch += 1; continue; }
  const task = tasks.get(String(row.taskId));
  if (!task) { skippedNoTask += 1; continue; }
  const expected = String(computeLedgerReceiptNo(task).receiptNo || '');
  if (!expected || expected === String(row.receiptNo)) { unchanged += 1; continue; }
  // 护栏:数字核一致才认定"归一化丢字符";不一致=改过号/串号,不动,另册报告
  if (normalizeReceiptNoDigits(expected) !== String(row.receiptNo)) {
    skippedDigitsMismatch += 1;
    mismatches.push({ ws: row.ws, id: row.id, task: `${row.batchId}/${row.taskId}`, stored: row.receiptNo, taskValue: expected });
    continue;
  }
  toFix += 1;
  fixes.push({ ws: row.ws, id: row.id, task: `${row.batchId}/${row.taskId}`, shop: row.shop || '', old: row.receiptNo, new: expected });
  if (APPLY) {
    updateStmt.run(expected, Number(row.id));
    applied += 1;
  }
}

// 对账清单(可重定向留档:node ... > backfill_receipt_no_letters.report.txt)
for (const f of fixes) {
  console.log(`FIX ${f.ws} #${f.id} ${f.task} [${f.shop}] ${f.old} -> ${f.new}`);
}
for (const m of mismatches) {
  console.log(`SKIP-数字核不一致 ${m.ws} #${m.id} ${m.task} 台账=${m.stored} 任务=${m.taskValue}(疑改号/串号,人工核)`);
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY(已写盘)' : 'DRY-RUN(只报数+清单,加 --apply 实写)',
  scannedPureDigitRows: scanned,
  unchanged,
  toFix,
  applied,
  skippedNoBatch,
  skippedNoTask,
  skippedDigitsMismatch,
}, null, 1));

db.close();
