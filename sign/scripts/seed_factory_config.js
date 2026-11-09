'use strict';

/**
 * seed_factory_config — 出厂配置落库(配置台 P0/T3,2026-07-14)。
 *
 * 把现有硬编码(29 模式矩阵 + 3 百货店档案)生成 config_entries v1:
 *   - 出厂即真相:payload 直接从 lib/mode_record_matrix.MATRIX / lib/store_profiles.PROFILES
 *     机器生成,**不手抄**;快照测试(tests/config_factory_snapshot.test.js)锁 seed≡矩阵。
 *   - 幂等:同名已有任何版本 → 跳过;--force → 追加新版本并激活(历史版本保留)。
 *   - store 档案 P0 只存不用(P3 审核字段接配置时才有消费方)。
 *
 * 用法:
 *   node scripts/seed_factory_config.js                # 默认库 passport_review_workbench/storage/monthly.sqlite
 *   node scripts/seed_factory_config.js --db <path>    # 指定库
 *   node scripts/seed_factory_config.js --dry-run      # 只打印将写入什么
 *   node scripts/seed_factory_config.js --force        # 已有也追加新版本(不覆盖历史)
 */

const path = require('node:path');

const { MATRIX, MODE_ALIASES, normalizeModeName } = require('../lib/mode_record_matrix');
const { PROFILES, FAMILY } = require('../lib/store_profiles');
const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { BASE_FIELD_KEYS } = require('../services/review_config_resolver');

function buildModePayload(row) {
  const name = normalizeModeName(row.mode);
  return {
    modeLabel: row.mode,
    columns: { ...row.columns },
    receiptNoForm: row.receiptNoForm || '',
    actions: [...(row.actions || [])],
    note: row.note || '',
    groupNoLiteral: row.groupNoLiteral || '',
    // 表侧拼写别名(实锤出现过的写法):配置台展示用;resolver 按 normalizeModeName 命中,
    // 别名与本名归一后相同时天然命中,不同形(如括号位置)靠矩阵 MODE_ALIASES 机制
    aliases: MODE_ALIASES
      .filter(([, canonical]) => normalizeModeName(canonical) === name)
      .map(([alias]) => alias),
  };
}

function buildStorePayload(family, profile) {
  return {
    family: profile.family,
    label: profile.label,
    mode: profile.mode,
    split: profile.split,
    combined: Boolean(profile.combined),
    tourMatch: Boolean(profile.tourMatch),
    passportFree: Boolean(profile.passportFree),
    fields: [...(profile.fields || [])],
    rules: JSON.parse(JSON.stringify(profile.rules || {})),
    defaults: JSON.parse(JSON.stringify(profile.defaults || {})),
    exportMap: JSON.parse(JSON.stringify(profile.exportMap || {})),
    delivery: profile.delivery || '',
    storeFamily: family,
  };
}

/** 可编程入口(快照测试直接调):repo 由调用方提供。 */
function seedFactoryConfig({ repository, force = false, dryRun = false, log = () => {} }) {
  const planned = [];
  for (const row of MATRIX) {
    planned.push({ kind: 'mode', name: normalizeModeName(row.mode), payload: buildModePayload(row) });
  }
  for (const [family, profile] of Object.entries(PROFILES)) {
    if (profile.family !== FAMILY.DEPT) continue; // 免税店=默认档案,无独立配置体
    planned.push({ kind: 'store', name: family, payload: buildStorePayload(family, profile) });
  }
  // P3a 审核基线:出厂字段清单(passport/receipt);微调全空=行为零变化
  planned.push({ kind: 'review_base', name: 'passport', payload: { fields: [...BASE_FIELD_KEYS.passport] } });
  planned.push({ kind: 'review_base', name: 'receipt', payload: { fields: [...BASE_FIELD_KEYS.receipt] } });

  // P2 导出计划:两条内置引用(老 planner 承载,防第二真相源)+ 一条可编辑示例 DSL
  planned.push({ kind: 'export_plan', name: '内置·多模式四规则', payload: {
    planLabel: '内置·多模式四规则(济州道辉/现代三池/S活动双份/百货上家链/未归类)', builtin: 'mode_delivery',
  } });
  planned.push({ kind: 'export_plan', name: '内置·乐天百货门店双图', payload: {
    planLabel: '内置·乐天百货门店双图', builtin: 'lotte_dept',
  } });
  planned.push({ kind: 'export_plan', name: '示例·按团号整理', payload: {
    planLabel: '示例·按团号整理(可改可删,仅供照抄)',
    scope: { modes: [] },
    levels: [{ template: '{groupNo}' }, { template: '{name}{passportNo:0,4}' }],
    naming: { template: '{docLabel}{i}' },
    includes: ['receipt', 'passport'],
    emptyPolicy: 'block_prefix',
  } });

  const result = { written: 0, skipped: 0, entries: planned.length };
  for (const entry of planned) {
    const existing = repository.currentMaxVersion(entry.kind, entry.name);
    if (existing > 0 && !force) {
      result.skipped += 1;
      log(`skip  ${entry.kind}/${entry.name} (已有 v${existing})`);
      continue;
    }
    if (dryRun) {
      result.written += 1;
      log(`would ${entry.kind}/${entry.name}`);
      continue;
    }
    const saved = repository.saveNewVersion({
      kind: entry.kind,
      name: entry.name,
      payload: entry.payload,
      createdBy: 'seed',
      note: existing > 0 ? 'factory re-seed (--force)' : 'factory seed v1',
    });
    result.written += 1;
    log(`write ${entry.kind}/${entry.name} v${saved.version}`);
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const dbFlag = args.indexOf('--db');
  const dbPath = dbFlag >= 0 && args[dbFlag + 1]
    ? args[dbFlag + 1]
    : path.join(__dirname, '..', 'passport_review_workbench', 'storage', 'monthly.sqlite');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  // 与在线服务并发写时等锁 5s 而不是立即 database is locked(复核建议;脚本本身幂等,炸了重跑也无害)
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const repository = createModeConfigRepository({ db });
    const result = seedFactoryConfig({ repository, force, dryRun, log: (line) => console.log(line) });
    console.log(`[seed_factory_config] db=${dbPath} dryRun=${dryRun} force=${force} → 写入 ${result.written} / 跳过 ${result.skipped} / 共 ${result.entries}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { seedFactoryConfig, buildModePayload, buildStorePayload };
