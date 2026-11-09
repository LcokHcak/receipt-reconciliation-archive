'use strict';

/**
 * 代理工作台 V2 — 读模型重建 CLI(Task 5)。
 *
 * 用法:
 *   node scripts/rebuild_agent_workspace_projection.js            # dry-run:报告+parity,不写主库
 *   node scripts/rebuild_agent_workspace_projection.js --apply    # 影子库重建后原子切换进主库
 *   可选:--db <path> --library-root <path> --batches-root <path> --json
 *
 * apply 建议低峰执行(切换是主库单事务,期间写会被短暂阻塞);失败自动回滚,旧投影不受影响。
 * 路径默认值与 server/dependencies.js 同一套(storage/ 下),客户库尊重
 * customer_library.settings.json 的 activeRoot 覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createAgentWorkspaceRebuildService } = require('../services/agent_workspace_rebuild_service');

function parseArgs(argv) {
  const args = { apply: false, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--library-root') args.libraryRoot = argv[++i];
    else if (a === '--batches-root') args.batchesRoot = argv[++i];
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function resolveDefaults() {
  const projectRoot = path.resolve(__dirname, '..');
  const storageRoot = path.join(projectRoot, 'passport_review_workbench', 'storage');
  const settingsPath = path.join(storageRoot, 'customer_library.settings.json');
  let libraryRoot = path.join(storageRoot, 'customer_library');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.activeRoot) libraryRoot = path.resolve(settings.activeRoot);
  } catch { /* 无 settings 用默认 */ }
  return {
    db: path.join(storageRoot, 'workbench.sqlite'),
    libraryRoot,
    batchesRoot: path.join(storageRoot, 'batches'),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const defaults = resolveDefaults();
  const dbPath = args.db || defaults.db;
  const libraryRoot = args.libraryRoot || defaults.libraryRoot;
  const batchesRoot = args.batchesRoot || defaults.batchesRoot;

  if (!fs.existsSync(dbPath)) {
    console.error(`主库不存在: ${dbPath}`);
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000'); // 遇主服务器持锁时排队等待而非立即 SQLITE_BUSY
    const service = createAgentWorkspaceRebuildService({ db, libraryRoot, batchesRoot });
    const report = service.rebuild({
      apply: args.apply,
      shadowDbPath: `${dbPath}.rebuild-shadow`,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`[${report.mode}] 客户JSON ${report.fsCustomerFiles}(墓碑 ${report.tombstones})→ 投影 ${report.rebuiltTotal} 行;批次 ${report.batchesScanned} 个;耗时 ${report.elapsedMs}ms`);
    console.log(`覆盖层: 写入 ${report.overlay.projected} / 孤儿 ${report.overlay.orphans} / 陈旧批次拦截 ${report.overlay.stale} / 无客户引用任务 ${report.overlay.skippedNoRef}`);
    console.log(`状态分布: ${JSON.stringify(report.statusDistribution)}`);
    console.log(`月分布: ${JSON.stringify(report.rebuiltByMonth)}`);
    console.log(`代理TOP: ${JSON.stringify(Object.entries(report.agentDistribution).slice(0, 8))}`);
    if (Object.keys(report.warnings).length) {
      console.log(`警告: ${JSON.stringify(report.warnings)}`);
    }
    if (report.parity.liveTableMissing) {
      console.log('parity: 主库还没有读模型表(首次重建属正常)');
    } else if (report.parity.mismatches.length === 0) {
      console.log(`parity: 与主库现有投影一致(live=${report.parity.liveTotal})`);
    } else {
      console.log(`parity: ${report.parity.mismatches.length} 个月份不一致(live=${report.parity.liveTotal}):`);
      for (const m of report.parity.mismatches) {
        console.log(`  ${m.month}: 重建 ${m.rebuilt} vs 主库 ${m.live}(差 ${m.delta > 0 ? '+' : ''}${m.delta})`);
      }
    }
    if (report.applied) {
      console.log(`已切换主库: ${report.appliedRows} 行`);
    } else if (args.apply) {
      console.log('apply 未完成(见上方错误)');
    } else {
      console.log('dry-run 结束,主库未改动。确认无误后加 --apply 执行切换。');
    }
  } finally {
    db.close();
  }
}

main();
