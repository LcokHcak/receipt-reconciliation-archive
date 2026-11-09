'use strict';

/**
 * migrate_sendback_queue — 旧回发队列 JSON → workflow_task 表(代理工作台 V2 Task 6)。
 *
 * 用法:
 *   node scripts/migrate_sendback_queue.js            # dry-run:只输出计数,不写业务数据行
 *                                                     # (会确保 workflow_task 表结构存在,幂等 DDL,
 *                                                     #  与服务器正常启动建的是同一张表)
 *   node scripts/migrate_sendback_queue.js --apply    # 真写
 *   可选:--db <path> --file <path> --json
 *
 * 语义:
 *   - task_key = legacy_sendback:<旧id> → 重跑幂等(已迁移的跳过,计数 alreadyMigrated);
 *   - pending/done/cancelled 全迁,保留时间、操作人、note、payload(mode/tourNo/workspaceKey);
 *   - 旧队列是组级触发,无 customerId → customer_id='',calendar_month 从 createdAt(业务时区)推;
 *   - 旧 JSON 文件不动(切 adapter 后它就是死档,备份留证)。
 * ⚠️ 部署顺序(灰度清单):先跑本脚本 --apply,再让服务器以 adapter 模式启动,
 *    否则 JSON 里的未完成回发在看板上会消失。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { calendarMonthOf } = require('../lib/agent_workspace/customer_projection');

function parseArgs(argv) {
  const args = { apply: false, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function migrateSendbackQueue({ db, filePath, apply = false, timeZone = process.env.SIGN_BUSINESS_TZ || 'Asia/Seoul' }) {
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    fileFound: fs.existsSync(filePath),
    totalItems: 0,
    byStatus: { pending: 0, done: 0, cancelled: 0, other: 0 },
    migrated: 0,
    alreadyMigrated: 0,
    badItems: 0,
  };
  if (!report.fileFound) return report;

  let items;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    report.badItems = -1; // 整文件坏
    return report;
  }
  report.totalItems = items.length;

  const repo = createWorkflowTaskRepository({ db });
  for (const item of items) {
    if (!item || !item.id) {
      report.badItems += 1;
      continue;
    }
    const status = ['pending', 'done', 'cancelled'].includes(item.status) ? item.status : 'other';
    report.byStatus[status] += 1;

    const taskKey = `legacy_sendback:${item.id}`;
    if (repo.getByKey(taskKey)) {
      report.alreadyMigrated += 1;
      continue;
    }
    if (!apply) {
      report.migrated += 1;
      continue;
    }

    const createdAt = String(item.createdAt || '') || new Date().toISOString();
    const { task } = repo.createExpected({
      taskKey,
      calendarMonth: calendarMonthOf(createdAt, timeZone),
      workspaceKey: String(item.workspaceKey || ''),
      customerId: '', // 旧队列组级触发,无客户上下文
      batchId: String(item.batchId || '') || null,
      groupKey: String(item.groupKey || '') || null,
      agentKey: '',
      taskType: 'send_upstream',
      subtype: String(item.action || ''),
      dueAt: String(item.dueAt || '') || null,
      payload: {
        mode: String(item.mode || ''),
        tourNo: String(item.tourNo || ''),
        legacyWorkspaceKey: String(item.workspaceKey || ''),
        legacyId: String(item.id),
        ...(item.note ? { note: String(item.note) } : {}),
      },
      createdAt,
      createdBy: String(item.createdBy || '') || null,
    });
    // 终态经仓库方法落审计字段(不开裸 INSERT 后门)
    if (item.status === 'done') {
      repo.complete(task.id, {
        by: String(item.sentBy || ''),
        at: String(item.sentAt || '') || createdAt,
        note: String(item.note || ''),
      });
    } else if (item.status === 'cancelled') {
      repo.cancel(task.id, {
        reason: String(item.note || 'legacy_cancelled'),
        at: String(item.sentAt || '') || createdAt,
      });
    }
    report.migrated += 1;
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv);
  const projectRoot = path.resolve(__dirname, '..');
  const storageRoot = path.join(projectRoot, 'passport_review_workbench', 'storage');
  const dbPath = args.db || path.join(storageRoot, 'workbench.sqlite');
  const filePath = args.file || path.join(storageRoot, 'sendback_queue.json');

  if (!fs.existsSync(dbPath)) {
    console.error(`主库不存在: ${dbPath}`);
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const report = migrateSendbackQueue({ db, filePath, apply: args.apply });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.fileFound) {
      console.log(`[${report.mode}] 旧队列文件不存在(${filePath}),无需迁移`);
      return;
    }
    console.log(`[${report.mode}] 旧队列 ${report.totalItems} 条:pending ${report.byStatus.pending} / done ${report.byStatus.done} / cancelled ${report.byStatus.cancelled}`);
    console.log(`迁移 ${report.migrated} 条,已迁移跳过 ${report.alreadyMigrated} 条,坏条目 ${report.badItems}`);
    if (!args.apply) console.log('dry-run 结束,未写业务数据行(表结构幂等确保)。确认后加 --apply 执行。');
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrateSendbackQueue };
