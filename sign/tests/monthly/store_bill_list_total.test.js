'use strict';

/**
 * 账单列表的 total 必须与 rows 走**同一套筛选**(2026-08-01)。
 *
 * 病灶:路由里 rows 走 storeBillRepo.list({family, mode, limit, offset}),
 * total 却走 countByWorkspace(workspaceKey) —— 整个工作区的条数,和筛选无关。
 * 于是筛成一家店时:列表 30 行,页脚写"共 5000 条",分页控件还会给出一堆
 * 点进去是空的页码。数字本身没错(它确实是工作区总数),错在它冒充了"筛选结果的总数"。
 *
 * 这条钉两头:筛了要变小、没筛要等于全量;并且分页翻到尾页时 rows 不能是空的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-05';

function makeRepo() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES ('${WS}', 2026, 5, 'open', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
  `);
  const repo = createStoreBillRepository({ db });
  const rows = [];
  const push = (family, modeNormalized, n) => {
    for (let i = 0; i < n; i += 1) {
      rows.push({
        workspaceKey: WS,
        storeFamily: family,
        storeBranch: '本店',
        mode: modeNormalized,
        modeNormalized,
        tourNo: 'T001',
        purchaseDate: '2026-05-10',
        name: 'BAI XUE',
        passportNo: 'EP6274602',
        receiptNo: `R-${family}-${modeNormalized}-${i}`,
        brand: 'BrandA',
        qty: 1,
        netKrw: 1000,
        isDetailSheet: true,
        rowHash: `${family}|${modeNormalized}|${i}`,
        importedAt: '2026-05-11T00:00:00.000Z',
      });
    }
  };
  push('乐天首尔', 'cash', 7);
  push('乐天首尔', 'card', 3);
  push('新罗', 'cash', 5);
  repo.insertMany(rows);
  return repo;
}

test('⭐筛了店家 → total 跟着变小(不是整个工作区的 15)', () => {
  const repo = makeRepo();
  assert.equal(repo.countByWorkspace(WS), 15, '工作区总数仍是 15(这个数本身没错)');
  assert.equal(repo.countFiltered({ workspaceKey: WS, family: '乐天首尔' }), 10,
    '筛乐天首尔应是 7+3=10,不是 15');
  assert.equal(repo.countFiltered({ workspaceKey: WS, family: '新罗' }), 5);
});

test('⭐店家 + 模式一起筛 → 两个条件都要生效', () => {
  const repo = makeRepo();
  assert.equal(repo.countFiltered({ workspaceKey: WS, family: '乐天首尔', mode: 'cash' }), 7);
  assert.equal(repo.countFiltered({ workspaceKey: WS, family: '乐天首尔', mode: 'card' }), 3);
  assert.equal(repo.countFiltered({ workspaceKey: WS, mode: 'cash' }), 12, '只筛模式:7+5');
});

test('没筛时与全量一致(改动不许把老口径弄歪)', () => {
  const repo = makeRepo();
  assert.equal(repo.countFiltered({ workspaceKey: WS }), repo.countByWorkspace(WS));
  assert.equal(repo.countFiltered({ workspaceKey: '不存在的月份' }), 0);
});

test('⭐total 与 list 必须自洽:按 total 翻到最后一页,那一页不能是空的', () => {
  const repo = makeRepo();
  const scope = { workspaceKey: WS, family: '乐天首尔' };
  const total = repo.countFiltered(scope);
  const limit = 4;
  const lastOffset = (Math.ceil(total / limit) - 1) * limit;
  const lastPage = repo.list({ ...scope, limit, offset: lastOffset });
  assert.ok(lastPage.length > 0,
    `按 total=${total} 算出的尾页 offset=${lastOffset} 应该有数据,实际 ${lastPage.length} 行`);
  // 用旧口径(工作区总数)算出来的尾页则是空的 —— 这正是用户会点到的那一页
  const staleTotal = repo.countByWorkspace(WS);
  const staleOffset = (Math.ceil(staleTotal / limit) - 1) * limit;
  assert.equal(repo.list({ ...scope, limit, offset: staleOffset }).length, 0,
    '这条是反证:拿工作区总数当筛选总数,尾页确实是空的');
});

test('接线:路由的 total 走 countFiltered,不再走 countByWorkspace', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'routes', 'monthly', 'listing_routes.js'), 'utf8',
  );
  const block = /app\.get\('\/api\/monthly\/workspaces\/:workspaceKey\/bills'[\s\S]*?\n  \}\);/.exec(src);
  assert.ok(block, '没定位到 bills 列表路由');
  const code = block[0].replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /total: storeBillRepo\.countFiltered\(/, 'total 必须与 rows 同筛选');
  assert.doesNotMatch(code, /countByWorkspace/, '不许再拿工作区总数当筛选结果总数');
});

// 自检:上面那两条断言是在**真路由块**上跑的,不是在一个空壳上。
//
// 这条自己就当场立过功:我第一版把路径写成 `/store-bills`(想当然按仓库名猜的),
// 而真实路由是 `/bills` —— 自检立刻红,证明"取不到就等于没测"这件事真的会发生。
// 上面那两条用的是对的路径,所以它们没问题;错的是我新加的这条。留个记录。
test('自检:取段真的取到了那个路由块(否则上面两条是空跑)', () => {
  const fs = require('node:fs'); // 与上面那条一致:fs 在用例内部局部 require
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'routes', 'monthly', 'listing_routes.js'), 'utf8',
  );
  const block = /app\.get\('\/api\/monthly\/workspaces\/:workspaceKey\/bills'[\s\S]*?\n  \}\);/.exec(src);
  assert.ok(block, '取不到 bills 路由块 —— 取段方式失效了,上面两条会静默空跑');
  assert.ok(block[0].length > 200, `取到的块只有 ${block[0].length} 字符,可疑`);
  assert.match(block[0], /storeBillRepo/, '取到的应该是那个真路由');
  // 反向对照:一个不存在的路径必须取不到,证明这个取法不是"什么都能匹配"
  assert.equal(
    /app\.get\('\/api\/monthly\/workspaces\/:workspaceKey\/definitely-not-a-route'[\s\S]*?\n  \}\);/.exec(src),
    null,
    '取段正则必须真的在按路径匹配',
  );
});
