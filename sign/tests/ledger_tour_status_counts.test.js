'use strict';

// 审核台页签「异常补救 N」承接角标的数据源(0731,P2-c)。
//
// 本地 daily_receipt_export 是空表 —— 角标不显示是**真实且正确**的,
// 但那证明不了 SQL 对。用真 sqlite 造几行来验。
//
// 要钉的是这条:countByTourMatchStatus 按 **tour_match_status** 分组,
// 和既有的 countByLedgerStatus(按 ledger_status 分组)**不是一个维度**。
// 当初特意没复用那个 —— 复用了就会拿一个看起来像、其实答非所问的数字去做角标,
// 而"角标显示 3、点进去看见 7"比不显示角标更糟。

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt');

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-07';

function seed(repo, rows) {
  repo.insertMany(rows.map((r, i) => ({
    workspaceKey: r.ws || WS,
    receiptNo: `R${i}`,
    name: 'N',
    passportNo: `P${i}`,
    rowHash: `h${(r.ws || WS)}${i}`,
    importedAt: '2026-07-01T00:00:00.000Z',
    ledgerStatus: r.ledgerStatus || 'ready_to_post',
    tourMatchStatus: r.tour,
  })));
}

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());
  return createDailyReceiptRepository({ db });
}

test('⭐按 tour_match_status 分组计数(角标要的就是这个维度)', (t) => {
  const repo = setup(t);
  seed(repo, [
    { tour: 'tour_not_found' }, { tour: 'tour_not_found' }, { tour: 'tour_not_found' },
    { tour: 'date_out_of_window' },
    { tour: 'mode_unresolved' }, { tour: 'mode_unresolved' },
    { tour: 'matched' }, { tour: 'matched' }, { tour: 'matched' }, { tour: 'matched' },
  ]);
  const counts = repo.countByTourMatchStatus({ workspaceKey: WS });
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  assert.equal(byStatus.tour_not_found, 3);
  assert.equal(byStatus.date_out_of_window, 1);
  assert.equal(byStatus.mode_unresolved, 2);
  assert.equal(byStatus.matched, 4, '已匹配的也要如实回,由前端按待补救清单去筛');

  // 角标口径:只加「待补救」那几种,matched 不算
  const REMEDY = ['tour_not_found', 'tour_ambiguous', 'tour_store_mismatch',
    'agent_mismatch', 'date_out_of_window', 'mode_unresolved', 'date_missing'];
  const badge = counts.filter((r) => REMEDY.includes(r.status)).reduce((a, r) => a + r.n, 0);
  assert.equal(badge, 6, '角标应是 3+1+2=6,不该把 matched 的 4 条算进去');
});

test('⭐和 countByLedgerStatus 不是一个维度 —— 当初没复用那个就是为了这个', (t) => {
  const repo = setup(t);
  // 同样 4 行:台账态全一样,团号匹配态各不相同
  seed(repo, [
    { tour: 'tour_not_found', ledgerStatus: 'ready_to_post' },
    { tour: 'date_out_of_window', ledgerStatus: 'ready_to_post' },
    { tour: 'matched', ledgerStatus: 'ready_to_post' },
    { tour: 'matched', ledgerStatus: 'ready_to_post' },
  ]);
  const byLedger = repo.countByLedgerStatus({ workspaceKey: WS });
  const byTour = repo.countByTourMatchStatus({ workspaceKey: WS });
  assert.equal(byLedger.length, 1, 'ledger_status 看过去只有一档 —— 拿它做角标会得到 4');
  assert.equal(byLedger[0].n, 4);
  assert.equal(byTour.length, 3, 'tour_match_status 才分得出三档');
  const REMEDY = ['tour_not_found', 'date_out_of_window'];
  assert.equal(byTour.filter((r) => REMEDY.includes(r.status)).reduce((a, r) => a + r.n, 0), 2,
    '真实待补救是 2 —— 用 ledger_status 会显示 4,点进去只有 2,比不显示更糟');
});

test('工作区隔离:别把别的月份的数算进这个月的角标', (t) => {
  const repo = setup(t);
  seed(repo, [
    { tour: 'tour_not_found' }, { tour: 'tour_not_found' },
    { tour: 'tour_not_found', ws: '2026-06' },
  ]);
  const jul = repo.countByTourMatchStatus({ workspaceKey: WS });
  const jun = repo.countByTourMatchStatus({ workspaceKey: '2026-06' });
  assert.equal(jul.find((r) => r.status === 'tour_not_found').n, 2);
  assert.equal(jun.find((r) => r.status === 'tour_not_found').n, 1);
});

test('空表返回空数组(不是抛错)—— 本地就是这个情形,角标按设计不显示', (t) => {
  const repo = setup(t);
  assert.deepEqual(repo.countByTourMatchStatus({ workspaceKey: WS }), []);
});
