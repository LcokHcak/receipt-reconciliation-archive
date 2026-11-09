#!/usr/bin/env node
'use strict';
// 乐天百货存量身份缺口扫描(2026-07-20 行为三合一复核MEDIUM,部署前核对项,**纯只读**):
//   断点②接线后,LOTTE_DEPT(同框票,非免护照)的 extractedName/passportNo 进后端必填集。
//   组级闸「通过并结算」会对组内**全部任务**重跑必填检查——若存量里有
//   "reviewed=true 但身份为空"的乐天百货票(绕过 FieldEditor 的历史路径/规则上线前旧票),
//   它所在整组重结算会被「还缺英文名/护照号」拦下。
//   本脚本数一遍这类票:0 = 放心上;>0 = 逐条看是先补值还是接受重结算时人工补。
//
// 用法(本机或服务器,随时可跑,不写任何东西):
//   node scripts/oneoff/scan_lotte_dept_identity_gap.js
//   环境变量 SIGN_STORAGE_ROOT 可指到别的 storage(默认 <repo>/passport_review_workbench/storage)

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = process.env.SIGN_STORAGE_ROOT
  || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const BATCHES = path.join(STORAGE, 'batches');

const { normalizeStoreFamily } = require('../../lib/validation/field_rules');

const textOf = (v) => String(v == null ? '' : v).trim();

let scannedBatches = 0;
let scannedTasks = 0;
const hits = [];

const batchDirs = fs.existsSync(BATCHES)
  ? fs.readdirSync(BATCHES).filter((name) => {
    try { return fs.statSync(path.join(BATCHES, name)).isDirectory(); } catch { return false; }
  })
  : [];

for (const batchId of batchDirs) {
  let batch;
  try {
    batch = JSON.parse(fs.readFileSync(path.join(BATCHES, batchId, 'batch.json'), 'utf8'));
  } catch { continue; /* 损坏/无 batch.json 跳过 */ }
  scannedBatches += 1;
  for (const task of batch.tasks || []) {
    scannedTasks += 1;
    const docType = textOf(task.docTypeFinal || task.docTypeAuto).toLowerCase();
    if (docType !== 'receipt') continue;
    const store = normalizeStoreFamily(textOf(task.receiptStoreFinal || task.receiptStoreAuto));
    if (store !== 'LOTTE_DEPT') continue;
    if (!task.reviewed) continue;
    const name = textOf(task.extractedNameFinal) || textOf(task.extractedNameAuto);
    const passport = textOf(task.passportNoFinal) || textOf(task.passportNoAuto);
    if (name && passport) continue;
    hits.push({
      batchId,
      taskId: textOf(task.id),
      customer: textOf(task.sourceGroupLabel || task.sourceGroupKey),
      missing: [!name && '英文名', !passport && '护照号'].filter(Boolean).join('+'),
    });
  }
}

console.log(`[scan] 批次 ${scannedBatches} 个 / 任务 ${scannedTasks} 条`);
console.log(`[scan] 乐天百货 reviewed 且身份缺失:${hits.length} 条`);
for (const hit of hits.slice(0, 100)) {
  console.log(`  - ${hit.batchId} / ${hit.taskId} / ${hit.customer || '(无组名)'} 缺:${hit.missing}`);
}
if (hits.length > 100) console.log(`  …其余 ${hits.length - 100} 条略`);
if (!hits.length) {
  console.log('[scan] ✅ 无缺口:断点②身份必填接线对存量零影响,可放心部署。');
} else {
  console.log('[scan] ⚠ 有缺口:这些票所在组重结算会被「还缺英文名/护照号」拦——先补值或知会审核员。');
}
