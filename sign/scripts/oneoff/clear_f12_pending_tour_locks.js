#!/usr/bin/env node
'use strict';
// F12 存量毒行摘锁(2026-07-20;源头已修=73542da,设计=docs/plans/2026-07-18-团号补救链路改版-设计.md F12):
//   修复前,无 confirm 手改踩日期窗会把 tour_match_status 锁进 manual_locked_fields;之后换团号表
//   reset(repositories/daily_receipt/writes.js resetTourMatchForRematch 裸SQL)把行打回 pending,
//   tour_match 重跑又被 filterStageUpdates 跳过锁列 → 行永久卡 pending;而 pending 不在补救台
//   REMEDY_TOUR_STATUSES 里 = 从补救台消失。源头修复只保新增,本脚本清存量。
//
// 判定(锁的单一真相=lib/monthly/manual_lock;SQL LIKE 只做粗筛,精判用 getLockedFields 防子串误伤):
//   毒行   = tour_match_status='pending' 且锁集含 tour_match_status → --apply 时只摘这一把锁;
//   保护行 = 状态='matched'  且锁集含 tour_match_status = F6 人工背书行,绝不动(只报数);
//   其它状态带锁(如 date_out_of_window)不在本脚本射程,只报数供人工参考。
//   摘锁只动 manual_locked_fields 一列(写法参照 writes.js clearBillMatchLocksForIds);
//   tour_match_status 仍留 pending,下次 tour_match/换表重匹配自然重跑,不越权替业务定状态。
//
// 用法(默认 dry-run 只报数+清单,--apply 才写;生产执行前等用户亲口批——部署红线):
//   node scripts/oneoff/clear_f12_pending_tour_locks.js           # 干跑(只读,随时可跑)
//   node scripts/oneoff/clear_f12_pending_tour_locks.js --apply   # 实写(建议低峰)
//   环境变量 SIGN_STORAGE_ROOT 可指到别的 storage(默认 <repo>/passport_review_workbench/storage)
// 并发安全:apply 段单事务(BEGIN IMMEDIATE),事务内按行重读"状态+锁"复验后才摘——扫描与写入
//   间隙若行被补救成 matched(升格 F6 保护行)或锁已被摘,自动跳过;幂等,二跑无变化。

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = process.env.SIGN_STORAGE_ROOT
  || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const APPLY = process.argv.includes('--apply');

const { getLockedFields, serializeLockedFields } = require('../../lib/monthly/manual_lock');

const db = new DatabaseSync(path.join(STORAGE, 'monthly.sqlite'));
// 与主服务并跑时排队等锁而非立即 SQLITE_BUSY(同 rebuild_agent_workspace_projection 约定);
// 本脚本 apply 段是单个长事务,没这行撞上业务写会直接炸。
db.exec('PRAGMA busy_timeout = 5000');

// LIKE 粗筛捞出所有"锁疑似含 tour_match_status"的行(不分状态,便于同时报出保护行底数)。
const rows = db.prepare(`
  SELECT id, workspace_key AS ws, tour_match_status AS status,
         receipt_no AS receiptNo, name, manual_locked_fields
  FROM daily_receipt_export
  WHERE manual_locked_fields LIKE '%tour_match_status%'
  ORDER BY workspace_key, id
`).all();

const poison = [];            // pending + 锁 = F12 毒行(本脚本唯一动的对象)
let protectedMatched = 0;     // matched + 锁 = F6 人工背书,保护不动
let otherStatusLocked = 0;    // 其它状态 + 锁,不动只报数
let likeHitNoRealLock = 0;    // LIKE 命中但精判锁集不含(异形 JSON,防御性另册)

for (const row of rows) {
  const locks = getLockedFields(row);
  if (!locks.has('tour_match_status')) { likeHitNoRealLock += 1; continue; }
  if (row.status === 'pending') { poison.push(row); continue; }
  if (row.status === 'matched') { protectedMatched += 1; continue; }
  otherStatusLocked += 1;
}

// 对账清单(可重定向留档:node ... > clear_f12_pending_tour_locks.report.txt)
for (const p of poison) {
  console.log(`POISON ${p.ws} #${p.id} 票号=${p.receiptNo || ''} 姓名=${p.name || ''} 锁=${p.manual_locked_fields}`);
}

let applied = 0;
let skippedRecheck = 0; // 事务内复验不过(行没了/锁已摘/状态已非 pending)→ 跳过
if (APPLY && poison.length) {
  const fetchStmt = db.prepare(
    'SELECT tour_match_status, manual_locked_fields FROM daily_receipt_export WHERE workspace_key = ? AND id = ?'
  );
  const updateStmt = db.prepare(
    'UPDATE daily_receipt_export SET manual_locked_fields = ? WHERE workspace_key = ? AND id = ?'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of poison) {
      const fresh = fetchStmt.get(p.ws, p.id);
      if (!fresh || fresh.tour_match_status !== 'pending') { skippedRecheck += 1; continue; }
      const locks = getLockedFields(fresh);
      if (!locks.has('tour_match_status')) { skippedRecheck += 1; continue; }
      locks.delete('tour_match_status');
      applied += updateStmt.run(serializeLockedFields(locks), p.ws, p.id).changes;
      console.log(`UNLOCK ${p.ws} #${p.id} 锁 ${fresh.manual_locked_fields} -> ${serializeLockedFields(locks) || 'NULL'}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const byWorkspace = {};
for (const p of poison) byWorkspace[p.ws] = (byWorkspace[p.ws] || 0) + 1;

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY(已写盘)' : 'DRY-RUN(只报数+清单,加 --apply 实写)',
  likeHits: rows.length,
  poisonPendingLocked: poison.length,
  byWorkspace,
  applied,
  skippedRecheck,
  protectedMatchedLocked: protectedMatched,
  otherStatusLocked,
  likeHitNoRealLock,
}, null, 1));

db.close();
