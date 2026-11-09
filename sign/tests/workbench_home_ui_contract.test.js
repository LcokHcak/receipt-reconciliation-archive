'use strict';

// 工作台首页分离(2026-07-18)UI 契约(源码断言,交互归 E2E)。
// 锁住的东西:角色分发(admin/finance→管理员版,其余→审核员版);管理员四区块
// (KPI/看板/已完成/异常提醒);审核员不出现管理员统计;看板与我的批次保持极简列
// (不显示主工序/更新时间);进入▶ 深链 /review/:batchId;展示口径纯函数(homeDisplay)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const HOME = 'frontend/src/views/HomeView.vue';
const ADMIN = 'frontend/src/views/home/AdminHomeView.vue';
const REVIEWER = 'frontend/src/views/home/ReviewerHomeView.vue';
const BOARD = 'frontend/src/components/home/CollectorBoard.vue';
const BATCH_TABLE = 'frontend/src/components/home/BatchListTable.vue';
const ROUTER = 'frontend/src/router/index.js';

async function loadDisplay() {
  return import(pathToFileURL(path.join(root, 'frontend/src/lib/homeDisplay.js')).href);
}

test('分发器:admin/finance → 管理员版,其余 → 审核员版;路由名 workbench 不变', () => {
  const home = read(HOME);
  assert.match(home, /AdminHomeView/);
  assert.match(home, /ReviewerHomeView/);
  assert.match(home, /'admin', 'finance'/, 'finance 复用管理员版(拍板#7)');

  const router = read(ROUTER);
  assert.match(router, /name: 'workbench',\s*\n\s*component: HomeView/, '路由名按名跳转各处依赖,不能改');
  assert.ok(!router.includes('OverviewView'), '旧首页已删,router 不得残留引用');
});

test('管理员首页:运营概览五 KPI + 看板 + 已完成批次 + 待管理事项四胶囊', () => {
  const src = read(ADMIN);
  for (const label of ['今日上传', '今日审核', '今日导出', '未清异常', '今日完成率']) {
    assert.ok(src.includes(label), `KPI 缺 ${label}`);
  }
  // 口径诚实(2026-07-20):异常 KPI 是 error+rephoto 存量(无日期过滤),不许顶「今日」前缀
  assert.ok(!src.includes('今日异常'), '存量口径的异常 KPI 不得叫「今日异常」');
  assert.match(src, /CollectorBoard/);
  assert.match(src, /已完成批次/);
  assert.match(src, /show-owner show-export show-action/, '管理员已完成表带 收票员/导出状态/查看 列');
  // 2026-07-26 用户需求②:「异常提醒」改「待管理事项」,四项=超时未完成客户组/未收/待导出/导出失败
  assert.match(src, /待管理事项/);
  assert.ok(!src.includes('>异常提醒<'), '旧「异常提醒」标题已改名');
  assert.match(src, /小时未完成客户组/, '超时阈值取后端 thresholdHours,不写死 24');
  for (const label of ['未收清单数量', '待导出', '导出失败']) {
    assert.ok(src.includes(label), `待管理事项缺 ${label}`);
  }
  for (const key of ['staleGroups', 'unreceived', 'unexported', 'exportFailed']) {
    assert.ok(src.includes(key), `待管理事项缺数据键 ${key}`);
  }
  // 需求③:所有工作块可一键收起
  assert.match(src, /CollapsiblePanel/, '工作块用可收起面板');
  assert.match(src, /storage-key="admin-/, '收起状态按块记忆');
  assert.match(src, /reviewedToday/, '今日审核用动作口径,不用今日批次存量');
  assert.match(src, /exportedToday/, 'P1:今日导出 KPI 已点亮');
  assert.match(src, /key: 'unexported'/, 'P1:待导出胶囊转正(alerts.unexported)');
  assert.match(src, /name: 'review'/, '深链进审核页');
  assert.ok(!src.includes('本月进度'), '月度对账不进管理员首页(避免 BI 化)');
});

test('审核员首页:打开即干活,不出现管理员统计;我的批次极简列', () => {
  const src = read(REVIEWER);
  for (const label of ['待审核', '今日完成', '今日上传', '今日效率', '当前排名']) {
    assert.ok(src.includes(label), `KPI 缺 ${label}`);
  }
  assert.match(src, /todayEfficiency/, 'P2:今日效率点亮(张/小时近似)');
  assert.match(src, /v-if="rankText"/, 'P2 拍板#6:排名只在有名次时显示,只给本人');
  // 我的数据(本月,P2)
  assert.match(src, /我的数据\(本月\)/);
  for (const label of ['本月完成', '平均速度', '完成率', '返工率']) {
    assert.ok(src.includes(label), `我的数据缺 ${label}`);
  }
  assert.match(src, /近似口径/, '返工率必须注明近似口径(拍板#5)');
  assert.match(src, /不限本月/, '完成率/返工率是全量存量口径,标题在"本月"面板里必须澄清(审计M)');
  assert.match(src, /我的批次/);
  assert.match(src, /最近完成/);
  assert.match(src, /name: 'review'/, '进入深链直达审核页');
  assert.ok(!src.includes("query: { tab"), '审核页单队列,深链不得再造 tab 死参数(2026-07-20 整链清理)');
  assert.ok(!src.includes('CollectorBoard'), '审核员不见收票员看板');
  assert.ok(!src.includes('本月进度'), '审核员不见月度统计');
  assert.ok(!src.includes('主工序'), '我的批次不显示主工序(提示词极简)');
  assert.ok(!src.includes('更新时间'), '我的批次不显示更新时间(提示词极简)');
  assert.match(src, /rh-banner/, '蓝底横幅与管理员白底 hero 区分身份');
});

test('收票员看板:四种排序+搜索+展开;展开行=该员全部批次+完整列(需求A1)', () => {
  const src = read(BOARD);
  assert.match(src, /COLLECTOR_SORTS/);
  assert.match(src, /搜索收票员/);
  assert.match(src, /toggleExpand/);
  assert.match(src, /ownerBatches/, '展开行取该员全部批次(未完成在前)');
  assert.match(src, /BatchListTable/, '复用已完成批次表:列口径一套代码,免两处漂移');
  assert.ok(!src.includes('进入 ▶'), '三列极简表(批次|待办|进入)作废——装不下需求要的完成时间/耗时/导出状态');
  assert.ok(!src.includes("query: { tab"), '深链不得再造 tab 死参数(2026-07-20 整链清理)');
  // 原「待办」= 待审+异常,BatchListTable 拆成两列显示,信息更细未丢
  assert.match(src, /formatWorkspaces/, '工作区列截断,长月份串给 title');
  assert.ok(!src.includes('主工序'), '展开行不显示主工序');
  assert.ok(!src.includes('更新时间'), '展开行不显示更新时间');
});

test('待管理事项:胶囊标量纲(组/条/批),明细数值列按类型切换(审计M3/M4)', () => {
  const src = read(ADMIN);
  assert.match(src, /unit: '组'/);
  assert.match(src, /unit: '条'/);
  assert.match(src, /unit: '批'/);
  assert.match(src, /detailOf/, '明细列按 alert 类型给对应字段');
  assert.match(src, /完成张数/);
  // 未收是月度口径无 batchIds,不展开而给跳转入口
  assert.match(src, /standalone: true/);
  assert.match(src, /v2-monthly-unreceived/, '未收胶囊跳未收对账页');
});

test('已完成批次表:列按角色开关;导出状态列已点亮(P1);收图/已审/待审(2026-07-26)', () => {
  const src = read(BATCH_TABLE);
  for (const label of ['完成时间', '收图', '已审', '待审', '耗时']) {
    assert.ok(src.includes(label), `缺列 ${label}`);
  }
  assert.match(src, /batchTotalCount/, '收图=批次总张数');
  // 2026-07-27 拍板A:待审改用 batchOpenWorkCount(人工待审+机器在途,**不含异常**),
  // 异常另起一列 —— 两边都算会让人以为有两拨活。详见下方「已完成口径」用例。
  assert.match(src, /batchOpenWorkCount/, '待审=未收尾张数(不含异常)');
  assert.ok(src.includes('>异常<'), '异常单列');
  assert.ok(!src.includes('>完成张数<'), '完成张数列已拆成 收图/已审/待审');
  assert.match(src, /showOwner/);
  assert.match(src, /showExport/);
  assert.match(src, /batchCompletedAt/, '完成时间取 reviewStats.lastReviewedAt');
  assert.match(src, /isBatchExported/, 'P1:导出状态用留痕字段渲染');
  assert.match(src, /未导出/, '未盖章批次显示"未导出"');
  assert.match(src, /exportKindLabel/, '已导出带类型徽标');
});

test('导出类型标签:五种导出 kind 全有中文名,未知 kind 原样返回', async () => {
  const d = await loadDisplay();
  for (const kind of ['workbook', 'customer_data', 'hyundai', 'lotte_dept', 'mode']) {
    assert.ok(d.exportKindLabel(kind), `kind ${kind} 缺中文标签`);
  }
  assert.equal(d.exportKindLabel(''), '', '未盖章给空串');
  assert.equal(d.exportKindLabel('future_kind'), 'future_kind', '未知类型原样显示不炸');
  assert.equal(d.isBatchExported({ exportedAt: '2026-07-18T09:00:00Z' }), true);
  assert.equal(d.isBatchExported({ exportedAt: '' }), false);
  assert.equal(d.isBatchExported({}), false);
});

test('展示口径:完成=人工审完+机器不在途(异常不挡);耗时倒挂给 —;排序数字感知', async () => {
  const d = await loadDisplay();

  // 完成 = 人工审完 + 机器不在途:还在识别中(queued/processing)的批次不算完成
  assert.equal(d.isBatchCompleted({ counts: { total: 10, approved: 8, queued: 2 } }), false);
  assert.equal(d.isBatchCompleted({ counts: { total: 10, approved: 10 } }), true);
  assert.equal(d.isBatchCompleted({ counts: { total: 0 } }), false, '空批次不算完成');
  // 2026-07-27 用户拍板A **口径反转**:残留 OCR失败/待重拍 不再阻止批次进「已完成」。
  // 旧规则(评审 M1)要求故障全清,但生产一批几百张几乎必然剩一两张 → 表永远是空的,
  // 用户实际反馈"这个没有看到"。异常改为独立列如实标注(见「已完成口径」用例的恒等式断言)。
  assert.equal(d.isBatchCompleted({ counts: { total: 10, approved: 7, error: 3 } }), true);
  assert.equal(d.isBatchCompleted({ counts: { total: 10, approved: 8, rephoto: 2 } }), true);

  // 完成时间 = 最后一次审核动作;审核动作在,才有完成时间
  assert.equal(
    d.batchCompletedAt({ reviewStats: { lastReviewedAt: '2026-07-01T02:00:00Z' }, updatedAt: '2026-07-02T00:00:00Z' }),
    '2026-07-01T02:00:00Z',
  );
  // ⭐零审核动作 → 空(显示「—」),不许拿 updatedAt/createdAt 冒充(2026-08-01)。
  // 可达形状:整批任务全被标重拍会清空 reviewedAt(workbench_write/task.js:377/389),
  // 于是这批既满足"完成"判据、又零审核 —— 旧实现给出的完成时间/耗时是**从没测量过**的数,
  // 而看板上的数会被拿去算人效和排班。
  assert.equal(d.batchCompletedAt({ updatedAt: '2026-07-11T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' }), '');
  assert.equal(d.batchCompletedAt({ reviewStats: {}, createdAt: '2026-07-01T00:00:00Z' }), '');
  assert.equal(d.fmtDateTime(d.batchCompletedAt({ updatedAt: '2026-07-11T00:00:00Z' })), '—');
  // 耗时跟着一起为空,两列口径一致(不能一列「—」一列 10天)
  assert.equal(d.batchDurationMs({ createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z' }), null);

  // 耗时:建批→最后审核;时间倒挂/缺失给 null → fmtDuration 显示 —
  const ok = d.batchDurationMs({ createdAt: '2026-07-01T00:00:00Z', reviewStats: { lastReviewedAt: '2026-07-01T02:18:00Z' } });
  assert.equal(d.fmtDuration(ok), '2小时18分');
  assert.equal(d.batchDurationMs({ createdAt: '2026-07-02T00:00:00Z', reviewStats: { lastReviewedAt: '2026-07-01T00:00:00Z' } }), null);
  assert.equal(d.fmtDuration(null), '—');
  assert.equal(d.fmtDuration(41 * 60000), '41分');

  // 员工编号排序数字感知:小票2 < 小票10
  const sorted = d.sortCollectors([{ owner: '小票10' }, { owner: '小票2' }], 'owner');
  assert.deepEqual(sorted.map((c) => c.owner), ['小票2', '小票10']);

  // 待审排序降序
  const byPending = d.sortCollectors([{ owner: 'a', pending: 3 }, { owner: 'b', pending: 9 }], 'pending');
  assert.equal(byPending[0].owner, 'b');

  // 展开行:该员全部批次,未完成在前、已完成在后;别人的不出现
  const batches = [
    { id: 'b1', ownerUsername: '小票01', counts: { total: 10, fields: 2 } },
    { id: 'b2', ownerUsername: '小票01', counts: { total: 10, approved: 10 } },
    { id: 'b3', ownerUsername: '小票02', counts: { total: 5, fields: 5 } },
    { id: 'b4', counts: { total: 3, fields: 3 } }, // 无主批次
    { id: 'b5', ownerUserId: 7, counts: { total: 2, fields: 2 } }, // 只有 userId
  ];
  assert.deepEqual(d.ownerBatches(batches, '小票01').map((b) => b.id), ['b1', 'b2'], '有活的 b1 在前,审完的 b2 在后');
  // 归键与后端看板同口径:未分配/#userId 桶展开也要能命中(2026-07-18 截图逮出的真 bug)
  assert.deepEqual(d.ownerBatches(batches, '未分配').map((b) => b.id), ['b4']);
  assert.deepEqual(d.ownerBatches(batches, '#7').map((b) => b.id), ['b5']);
  assert.equal(d.ownerKeyOfBatch({ ownerUsername: ' 小票01 ' }), '小票01');

  // 完成率整数百分比(提示词样式 79%);99% 护栏:没真做完不显示 100%
  assert.equal(d.fmtPct(0.789), '79%');
  assert.equal(d.fmtPct(undefined), '0%');
  assert.equal(d.fmtPct(0.996), '99%', '0.996 不许四舍五入成 100%');
  assert.equal(d.fmtPct(1), '100%');
  assert.equal(d.fmtPct(1.3), '100%', '脏数据 >1 也压回 100%');

  // 耗时超过一天给"天"级单位
  assert.equal(d.fmtDuration(26 * 3600000), '1天2小时');
  assert.equal(d.fmtDuration(3 * 24 * 3600000 + 30 * 60000), '3天0小时');

  // 排序:异常桶(未分配/#id)显式置顶,不依赖 ICU collation 摆位
  const sortedSpecial = d.sortCollectors(
    [{ owner: '小票01' }, { owner: '#7' }, { owner: '未分配' }, { owner: '小票02' }],
    'owner',
  );
  assert.deepEqual(sortedSpecial.map((c) => c.owner), ['未分配', '#7', '小票01', '小票02']);

  // workspace/completionRate 分支(此前无覆盖)
  const byWs = d.sortCollectors(
    [{ owner: 'a', workspaces: ['2026-06'] }, { owner: 'b', workspaces: ['2026-07'] }],
    'workspace',
  );
  assert.equal(byWs[0].owner, 'b', '月份工作区降序,新月在前');
  const byRate = d.sortCollectors(
    [{ owner: 'a', completionRate: 0.4 }, { owner: 'b', completionRate: 0.9 }],
    'completionRate',
  );
  assert.equal(byRate[0].owner, 'b', '完成率降序');

  // 工作区列截断:≤2 全显,>2 收进"等N月"并给 title 全量
  assert.deepEqual(d.formatWorkspaces(['2026-07', '2026-06']), { text: '2026-07 / 2026-06', title: '' });
  const truncated = d.formatWorkspaces(['2026-07', '2026-06', '2026-05', '2026-04']);
  assert.equal(truncated.text, '2026-07 / 2026-06 等4月');
  assert.equal(truncated.title, '2026-07 / 2026-06 / 2026-05 / 2026-04');
  assert.deepEqual(d.formatWorkspaces([]), { text: '—', title: '' });
});

test('owner 归键双端契约:前端 homeDisplay 与后端 overview service 逐边界一致', async () => {
  // 看板行 key 由后端算,展开明细由前端过滤——两边判空漂移则「未分配/#id」桶展开永远为空
  // (评审 M2:'' userId 边界曾不一致)。任一边改归键必须两边同改,此测试就会拦下。
  const d = await loadDisplay();
  const { ownerKeyOfBatch } = require('../services/workbench_overview_service');
  const cases = [
    { ownerUsername: '小票01' },
    { ownerUsername: ' 小票01 ' },
    { createdBy: '收票a' },
    { ownerUserId: 7 },
    { ownerUserId: 0 },
    { ownerUserId: '' },
    { ownerUserId: null },
    { createdByUserId: 9 },
    {},
  ];
  for (const batch of cases) {
    assert.equal(
      d.ownerKeyOfBatch(batch),
      ownerKeyOfBatch(batch),
      `归键不一致: ${JSON.stringify(batch)}`,
    );
  }
  assert.equal(ownerKeyOfBatch({ ownerUserId: '' }), '未分配', "'' userId 归未分配(双端约定)");
  assert.equal(ownerKeyOfBatch({ ownerUserId: 0 }), '#0', '0 是合法 userId,不归未分配');
});

// ── 2026-07-27 用户拍板A:「已完成」口径放宽,异常单列 ────────────────────────────
// 起因:用户反馈「已完成批次」表看不到内容。根因=旧口径要求"零积压"且积压含 error/rephoto,
// 生产一批几百张几乎必然剩一两张异常 → 这张表**永远是空的**,功能等于不存在。
test('已完成口径:人工审完+机器不在途即算完成,残留 OCR失败/待重拍 不再挡住', async () => {
  const { isBatchCompleted, batchAbnormalCount, batchOpenWorkCount, batchBacklogCount } = await loadDisplay();
  const base = { counts: { total: 520, queued: 0, processing: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 520, error: 0, rephoto: 0 } };
  const withCounts = (patch) => ({ counts: { ...base.counts, ...patch } });

  assert.equal(isBatchCompleted(base), true, '全干净=完成');
  // ⭐核心改动:残留异常不再阻止进表(旧口径这两条都是 false)
  assert.equal(isBatchCompleted(withCounts({ error: 3 })), true, '3张OCR失败不挡完成');
  assert.equal(isBatchCompleted(withCounts({ rephoto: 2 })), true, '2张待重拍不挡完成');
  // 真没干完的仍然不算完成
  assert.equal(isBatchCompleted(withCounts({ fields: 1 })), false, '还有1张待补字段=没完成');
  assert.equal(isBatchCompleted(withCounts({ queued: 1 })), false, '机器还在排队=没完成');
  assert.equal(isBatchCompleted(withCounts({ processing: 1 })), false, '机器还在跑=没完成');
  assert.equal(isBatchCompleted({ counts: { total: 0 } }), false, '空批次不算完成');

  // 诚实性:异常有独立读数,不是被藏起来了
  assert.equal(batchAbnormalCount(withCounts({ error: 3, rephoto: 2 })), 5);
  // 待审列不含异常(两边都算会让人以为有两拨活);三者恒等式:待收尾 + 异常 = 全部积压
  const mixed = withCounts({ fields: 4, queued: 1, error: 3, rephoto: 2 });
  assert.equal(batchOpenWorkCount(mixed), 5, '待收尾=人工4+在途1,不含异常');
  assert.equal(batchAbnormalCount(mixed), 5);
  assert.equal(batchOpenWorkCount(mixed) + batchAbnormalCount(mixed), batchBacklogCount(mixed),
    '待收尾+异常必须恰好等于全部积压,否则两列加起来对不上总数');
});

test('已完成批次表:列含「异常」,待审列改用不含异常的口径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'home', 'BatchListTable.vue'), 'utf8');
  assert.match(src, />异常</, '异常列在场');
  assert.match(src, /batchAbnormalCount/);
  assert.match(src, /batchOpenWorkCount\(b\)/, '待审列改用不含异常的口径');
  assert.ok(!/batchBacklogCount\(b\)/.test(src), '待审列不再用含异常的全积压,否则与异常列双计');
});

test('首页批次列表加载失败要明示,不许静默显示「暂无」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'home', 'AdminHomeView.vue'), 'utf8');
  assert.ok(!/fetchBatches\(\)\.catch\(\(\) => null\)/.test(src), '静默吞错已废除');
  assert.match(src, /batchesError/);
  assert.match(src, /下面的空白不代表真的没有批次/, '空白要有解释,否则分不清出错和真没有');
});

// ── 需求A1 修正(2026-07-29):看板展开行复用本表后必然混入未完成批次 ────────────
test('已完成批次表:未完成批次不许假报完成时间/耗时(batchCompletedAt 会回落 updatedAt)', () => {
  const src = read(BATCH_TABLE);
  assert.match(src, /isBatchCompleted\(b\)/, '完成时间/耗时按完成态门控');
  assert.match(src, /进行中/, '未完成显示「进行中」而不是回落时间');
  assert.match(src, /isBatchCompleted\(b\) \? fmtDuration\(batchDurationMs\(b\)\) : '—'/, '耗时对进行中给 —,不拿"已用时"充数');
});
