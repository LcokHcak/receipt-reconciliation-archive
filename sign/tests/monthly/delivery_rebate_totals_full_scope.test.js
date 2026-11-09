'use strict';

/**
 * 交付核对页的「返点合计」必须是全量,不是当前这一页(2026-08-01)。
 *
 * 病灶:DeliveryCheckView 原来是 `for (const r of rows.value)` 把**已加载的行**累加。
 * 而前端固定请求 limit:500、后端 clampInt 又把 limit 硬顶在 500 ——
 * 真实月份 monthly_data 是万行级(服务里注释提到过 34,493 条)。
 * 于是四个「XX 返点合计」只反映前 500 行,可能只有真值的百分之几;
 * 而紧挨着它的「交付总行数」用的是服务端全量 total。
 *
 * 两个数字并排摆着,人默认是同一口径 —— 财务/审核员就是拿这几个数在交付前跟上家对账的。
 *
 * 源码里当时留了一句「从当前已加载行算…仅作参考」,但那只在源码里:
 * **注释不是回执**,看表的人看不到它。
 *
 * 这条测试用真 sqlite 造超过一页的数据,直接比"服务端聚合"与"逐行真值"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');

const WS = '2607';
const PAGE_CAP = 500; // 与 routes/monthly/listing_routes.js 的 clampInt 上限一致

function seed(repo, count) {
  const folders = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团'];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      workspaceKey: WS,
      modeFolder: folders[i % folders.length],
      isUnmatched: i % 7 === 0 ? 1 : 0,
      dailyReceiptId: i + 1,
      storeBillId: null,
      isBrandActivity: 0,
      receiptNo: `R${String(i).padStart(6, '0')}`,
      customerRebateKrw: 1000 + i, // 每行不同,一页和全量必然对不上
      customerRebateUsd: 0,
      mergeConfigVersion: 'v1',
      rowHash: `h${i}`,
      // 固定时间戳:这条测试与"今天是几号"无关,不许引入时间窗依赖
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    });
  }
  repo.insertMany(rows);
  return rows;
}

function openRepo() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
           VALUES ('${WS}', 2026, 7, 'open', 't', 't')`);
  return { db, repo: createMonthlyDataRepository({ db }) };
}

test('⭐返点合计走服务端全量聚合,不是当前这一页', () => {
  const { db, repo } = openRepo();
  try {
    const seeded = seed(repo, PAGE_CAP + 137); // 明确超过一页
    const truth = seeded.reduce((s, r) => s + r.customerRebateKrw, 0);

    const totals = repo.sumRebateByMode({ workspaceKey: WS });
    assert.equal(totals.totalRows, seeded.length, '行数要覆盖全量');
    assert.equal(totals.totalRebateKrw, truth, '返点合计要等于逐行真值');

    // 反面:按老做法(只加一页)必然对不上 —— 证明这条测试有区分力
    const onePage = repo.listFiltered({ workspaceKey: WS, limit: PAGE_CAP, offset: 0 });
    const pageSum = onePage.reduce((s, r) => s + Number(r.customer_rebate_krw || 0), 0);
    assert.notEqual(pageSum, truth,
      '造的数据必须让"一页的和"与真值不同,否则这条测试等于没测');
  } finally {
    db.close?.();
  }
});

test('⭐分桶合计逐桶正确(不是把总数摊平)', () => {
  const { db, repo } = openRepo();
  try {
    const seeded = seed(repo, PAGE_CAP + 137);
    const byFolder = {};
    for (const r of seeded) {
      byFolder[r.modeFolder] = (byFolder[r.modeFolder] || 0) + r.customerRebateKrw;
    }
    const totals = repo.sumRebateByMode({ workspaceKey: WS });
    for (const b of totals.buckets) {
      assert.equal(b.rebateKrw, byFolder[b.folder], `${b.folder} 桶对不上`);
    }
    assert.equal(totals.buckets.length, Object.keys(byFolder).length, '桶数要齐');
  } finally {
    db.close?.();
  }
});

test('⭐聚合跟随筛选,与列表同一口径(否则又是两个读者)', () => {
  const { db, repo } = openRepo();
  try {
    const seeded = seed(repo, PAGE_CAP + 137);

    for (const folder of ['乐天首尔', '爱宝客']) {
      const truth = seeded.filter((r) => r.modeFolder === folder)
        .reduce((s, r) => s + r.customerRebateKrw, 0);
      const t = repo.sumRebateByMode({ workspaceKey: WS, modeFolder: folder });
      assert.equal(t.totalRebateKrw, truth, `按 ${folder} 筛选后合计要跟着变`);
      // 与 countFiltered 同口径:同一套 WHERE,两个数不许打架
      assert.equal(t.totalRows, repo.countFiltered({ workspaceKey: WS, modeFolder: folder }),
        '聚合的行数必须与 countFiltered 一致 —— 它们是同一套 WHERE');
    }

    const unmatchedTruth = seeded.filter((r) => r.isUnmatched === 1)
      .reduce((s, r) => s + r.customerRebateKrw, 0);
    const tu = repo.sumRebateByMode({ workspaceKey: WS, isUnmatched: true });
    assert.equal(tu.totalRebateKrw, unmatchedTruth, '按"未收"筛选后合计要跟着变');
    assert.equal(tu.totalRows, repo.countFiltered({ workspaceKey: WS, isUnmatched: true }));
  } finally {
    db.close?.();
  }
});

test('⭐前端不许再把当前页累加当合计', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'views', 'v2', 'DeliveryCheckView.vue'), 'utf8',
  );
  const code = src.replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /for \(const r of rows\.value\)[\s\S]{0,200}customer_rebate_krw/,
    '不许再逐行累加当前页 —— 那正是这条 bug');
  assert.match(code, /totals\.value\.buckets/, '要用服务端的全量聚合');
  // 口径要写在界面上,不是只写在注释里
  // 2026-08-01:原来钉的是 `返点合计为**本月全量**` —— 带 markdown 星号,
  // 而 Vue 模板不渲染 markdown,那两对星号会原样显示给用户(出报告截图时看见的)。
  // 已改成 <strong>。断言跟着改成钉**语义**,不钉具体标记方式。
  assert.match(src, /返点合计为.{0,10}本月全量/,
    '界面上必须说明"合计是全量、列表是截断的",否则看表的人分不出来');
  // ⚠️ 只看**用户可见**的部分:注释里出现 `**本月全量**` 是在举反例(说明为什么不能这么写),
  // 不该被判违规。这是今天第三次踩「闸扫到自己的注释」——所以先剥注释再断言。
  const visible = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(visible, /\*\*本月全量\*\*/,
    'Vue 模板不渲染 markdown —— 要强调用 <strong>,别把星号显示给用户');
});

test('⭐路由要把 totals 交出去(接线断了等于没修)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'routes', 'monthly', 'listing_routes.js'), 'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /sumRebateByMode\(\{/, '路由要调聚合');
  assert.match(code, /modeFolder: modeFolder \|\| null, isUnmatched: flag/,
    '聚合必须吃与列表相同的筛选参数,否则两个数各说各话');
  assert.match(code, /totals,/, '要放进响应');
});
