'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkbenchOverviewService } = require('../services/workbench_overview_service');

// 业务时区(Asia/Seoul)下的今日 / 昨日 ISO,用来构造 createdAt。
function kstDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
const TODAY = kstDateStr(new Date());
const todayIso = new Date().toISOString();
const oldIso = '2020-01-02T03:00:00.000Z';

function makeDeps(overrides = {}) {
  return {
    listBatches: async () => ([
      // 今日新建批次(进度只算这些)
      { createdAt: todayIso, counts: { total: 100, queued: 5, processing: 3, classification: 4, fields: 6, signature: 2, finalReview: 1, approved: 70 } },
      { createdAt: todayIso, counts: { total: 135, queued: 0, processing: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 135 } },
      // 旧批次:计入待办积压,但不计入今日进度
      { createdAt: oldIso, counts: { total: 50, queued: 10, processing: 0, classification: 2, fields: 0, signature: 0, finalReview: 0, approved: 38 } },
    ]),
    monthlyWorkspaceService: { listProduction: () => ([{ workspaceKey: '2026-05' }, { workspaceKey: '2026-04' }]) },
    dailyReceiptRepo: {
      countFiltered: ({ billMatchStatus, tourMatchStatus }) => {
        if (billMatchStatus === 'matched') return 5012;
        if (tourMatchStatus === 'tour_not_found') return 2;
        if (tourMatchStatus === 'mode_unresolved') return 1;
        return 0;
      },
      countByWorkspace: () => 5238,
    },
    missingReceiptRepo: { countByWorkspace: () => 235 },
    pendingReviewRepo: { countOpen: () => 226 },
    billMatchLogRepo: { countByStatus: () => ([{ status: 'matched', n: 5012 }, { status: 'pending', n: 226 }]) },
    customerLibraryRepository: {
      listCustomers: () => ([
        ...new Array(150).fill(0).map(() => ({ createdAt: oldIso })),  // 历史建档
        ...new Array(8).fill(0).map(() => ({ createdAt: todayIso })),  // 今日新建档 8 个
      ]),
    },
    ...overrides,
  };
}

test('今日待办 = 全部批次实时积压(含旧批次)', async () => {
  const svc = createWorkbenchOverviewService(makeDeps());
  const out = await svc.getOverview({});
  // 待预处理 = (5+3) + 0 + (10+0) = 18;待审核 = (4+6+2+1) + 0 + (2+0+0+0) = 15
  assert.equal(out.today.todo.preprocess, 18);
  assert.equal(out.today.todo.review, 15);
  assert.equal(out.today.todo.remedy, 3);
});

test('今日进度 = 仅今日新建批次(旧批次不计)', async () => {
  const svc = createWorkbenchOverviewService(makeDeps());
  const out = await svc.getOverview({});
  assert.equal(out.date, TODAY);
  assert.equal(out.timezone, 'Asia/Seoul');
  // 只数两条今日批次:上传 100+135=235,已审核 70+135=205
  assert.equal(out.today.progress.uploaded, 235);
  assert.equal(out.today.progress.reviewed, 205);
  assert.equal(out.today.progress.completionRate, Number((205 / 235).toFixed(4)));
  // 导出文件夹 = 今日新建档客户 8 个
  assert.equal(out.today.progress.exportedFolders, 8);
});

test('本月进度跟随所选月份', async () => {
  const svc = createWorkbenchOverviewService(makeDeps());
  const out = await svc.getOverview({ workspaceKey: '2026-04' });
  assert.equal(out.activeMonth, '2026-04');
  assert.equal(out.month.workspaceKey, '2026-04');
  assert.equal(out.month.received, 5238);
  assert.equal(out.month.matched, 5012);
  assert.equal(out.month.matchRate, Number((5012 / 5238).toFixed(4)));
});

test('本月进度已核对使用台账小票口径,不使用账单明细日志口径', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    dailyReceiptRepo: {
      countFiltered: ({ billMatchStatus, tourMatchStatus }) => {
        if (billMatchStatus === 'matched') return 19;
        if (tourMatchStatus === 'tour_not_found') return 0;
        return 0;
      },
      countByWorkspace: () => 22,
      countByMatchStatus: () => ([{ status: 'matched', n: 19 }, { status: 'unmatched', n: 3 }]),
    },
    billMatchLogRepo: { countByStatus: () => ([{ status: 'matched', n: 45 }]) },
  }));
  const out = await svc.getOverview({ workspaceKey: '2026-01' });
  assert.equal(out.month.received, 22);
  assert.equal(out.month.matched, 19);
  assert.equal(out.month.matchRate, Number((19 / 22).toFixed(4)));
});

test('无 workspaceKey 时取最新正式月', async () => {
  const svc = createWorkbenchOverviewService(makeDeps());
  const out = await svc.getOverview({});
  assert.equal(out.activeMonth, '2026-05');
});

test('没有今日批次时今日进度为 0,但待办积压仍在', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      { createdAt: oldIso, counts: { total: 50, queued: 4, processing: 0, classification: 1, fields: 0, signature: 0, finalReview: 0, approved: 45 } },
    ]),
  }));
  const out = await svc.getOverview({});
  assert.equal(out.today.progress.uploaded, 0);
  assert.equal(out.today.progress.reviewed, 0);
  assert.equal(out.today.progress.completionRate, 0);
  assert.equal(out.today.todo.preprocess, 4, '旧批次积压仍计入待办');
});

test('收票员看板:admin 看分人聚合按待审降序;reviewer 看不到别人(空)', async () => {
  const deps = makeDeps({
    listBatches: async () => ([
      { ownerUsername: '收票a', createdAt: todayIso, counts: { total: 200, approved: 80, classification: 120, fields: 0, signature: 0, finalReview: 0 } },
      { ownerUsername: '收票b', createdAt: todayIso, counts: { total: 150, approved: 150, classification: 0, fields: 0, signature: 0, finalReview: 0 } },
      { ownerUsername: '收票a', createdAt: oldIso, counts: { total: 50, approved: 50, classification: 0, fields: 0, signature: 0, finalReview: 0 } },
    ]),
  });
  const svc = createWorkbenchOverviewService(deps);

  const adminOut = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  assert.equal(adminOut.collectors.length, 2);
  // 待审降序:收票a(pending 120)在前,收票b(0)在后
  assert.equal(adminOut.collectors[0].owner, '收票a');
  assert.equal(adminOut.collectors[0].batches, 2);
  assert.equal(adminOut.collectors[0].collected, 250, '收票a 收图 = 200+50');
  assert.equal(adminOut.collectors[0].reviewed, 130, '收票a 已审 = 80+50');
  assert.equal(adminOut.collectors[0].pending, 120, '收票a 待审 = 120');
  assert.equal(adminOut.collectors[1].owner, '收票b');
  assert.equal(adminOut.collectors[1].pending, 0);
  assert.equal(adminOut.collectors[1].completionRate, 1, '收票b 150/150 = 100%');

  // reviewer:看板隔离 → 空数组(不该看到别人的进度)
  const reviewerOut = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '收票a' } });
  assert.equal(reviewerOut.collectors.length, 0);
});

// ── 工作台首页分离(2026-07-18)新增口径 ──────────────────────────────────

test('今日审核(动作口径):旧批次今天审掉的也算,与今日进度.已审核(存量口径)不同', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      // 昨天建的批次,今天审掉 40 张:reviewedToday 计,progress.reviewed 不计
      { createdAt: oldIso, counts: { total: 100, approved: 40 }, reviewStats: { reviewedByDate: { [TODAY]: 40 } } },
      // 今天建的批次,今天审掉 10 张
      { createdAt: todayIso, counts: { total: 30, approved: 10 }, reviewStats: { reviewedByDate: { [TODAY]: 10 } } },
      // 历史批次,历史审核:都不计
      { createdAt: oldIso, counts: { total: 50, approved: 50 }, reviewStats: { reviewedByDate: { '2020-01-02': 50 } } },
    ]),
  }));
  const out = await svc.getOverview({});
  assert.equal(out.today.progress.reviewedToday, 50, '动作口径 = 40 + 10');
  assert.equal(out.today.progress.reviewed, 10, '存量口径仍只看今日新建批次');
});

test('收票员看板扩展列:今日上传/今日审核/异常/超时/月份工作区', async () => {
  const staleIso = new Date(Date.now() - 30 * 3600 * 1000).toISOString(); // 30h 前
  const svc = createWorkbenchOverviewService(makeDeps({
    staleHours: 24,
    listBatches: async () => ([
      {
        id: 'b1', ownerUsername: '小票01', createdAt: todayIso, updatedAt: todayIso,
        monthlyWorkspaceKey: '2026-07',
        counts: { total: 100, approved: 60, fields: 40, error: 3, rephoto: 2 },
        reviewStats: { reviewedByDate: { [TODAY]: 60 } },
      },
      {
        // 超时批次:有待办且 30h 没动 → staleCount 计 1
        id: 'b2', ownerUsername: '小票01', createdAt: staleIso, updatedAt: staleIso,
        monthlyWorkspaceKey: '2026-06',
        counts: { total: 50, approved: 10, fields: 40 },
        reviewStats: { reviewedByDate: {} },
      },
      {
        // 审完的旧批次:再久没动也不算超时
        id: 'b3', ownerUsername: '小票02', createdAt: staleIso, updatedAt: staleIso,
        monthlyWorkspaceKey: '2026-07',
        counts: { total: 80, approved: 80 },
        reviewStats: { reviewedByDate: {} },
      },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  const c1 = out.collectors.find((c) => c.owner === '小票01');
  assert.equal(c1.uploadedToday, 100, '今日上传只算今日新建批次');
  assert.equal(c1.reviewedToday, 60);
  assert.equal(c1.errorCount, 3);
  assert.equal(c1.rephotoCount, 2);
  assert.equal(c1.staleCount, 1, 'b2 有待办且超阈值');
  assert.deepEqual(c1.workspaces, ['2026-07', '2026-06'], '月份工作区降序');
  const c2 = out.collectors.find((c) => c.owner === '小票02');
  assert.equal(c2.staleCount, 0, '审完的批次不算超时');
});

test('异常提醒:按可见范围聚合,带 batchIds;审完批次不进超时桶', async () => {
  const staleIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const deps = makeDeps({
    staleHours: 24,
    listBatches: async () => ([
      { id: 'bx', ownerUsername: 'a', createdAt: todayIso, updatedAt: todayIso, counts: { total: 10, error: 2, fields: 8 } },
      { id: 'by', ownerUsername: 'b', createdAt: staleIso, updatedAt: staleIso, counts: { total: 20, rephoto: 5, fields: 15 } },
    ]),
  });
  const svc = createWorkbenchOverviewService(deps);

  const adminOut = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  assert.equal(adminOut.alerts.ocrFailed.count, 2);
  assert.deepEqual(adminOut.alerts.ocrFailed.batchIds, ['bx']);
  assert.equal(adminOut.alerts.rephoto.count, 5);
  assert.deepEqual(adminOut.alerts.rephoto.batchIds, ['by']);
  assert.equal(adminOut.alerts.stale.count, 1, '只有 by 超时(bx 今天有动)');
  assert.deepEqual(adminOut.alerts.stale.batchIds, ['by']);
  assert.equal(adminOut.alerts.stale.thresholdHours, 24);

  // reviewer 只见自己批次的异常
  const reviewerOut = await svc.getOverview({ operatorUser: { role: 'reviewer', username: 'a' } });
  assert.equal(reviewerOut.alerts.ocrFailed.count, 2);
  assert.equal(reviewerOut.alerts.rephoto.count, 0, '别人的待补图不可见');
});

test('今日导出(P1):今日盖章批次的完成张数;待导出=审完未盖章', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      // 今日盖章:计入今日导出(approved=90)
      { id: 'be1', createdAt: oldIso, exportedAt: todayIso, counts: { total: 100, approved: 90, rephoto: 10 } },
      // 历史盖章:不计今日,也不进待导出
      { id: 'be2', createdAt: oldIso, exportedAt: oldIso, counts: { total: 50, approved: 50 } },
      // 审完没盖章:待导出
      { id: 'be3', createdAt: oldIso, counts: { total: 30, approved: 30 } },
      // 没审完也没盖章:不算待导出(还没到导出环节)
      { id: 'be4', createdAt: todayIso, counts: { total: 20, approved: 5, fields: 15 } },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  assert.equal(out.today.progress.exportedToday, 90);
  assert.equal(out.alerts.unexported.count, 1);
  assert.deepEqual(out.alerts.unexported.batchIds, ['be3']);
  // 全局角色的 me 段必须是中性空值:不许把"全公司聚合"塞进名叫"我的"的字段(评审M1)
  assert.equal(out.me.todayEfficiency, null);
  assert.equal(out.me.month, null);
  assert.equal(out.me.reviewedToday, 0);
});

test('me 段:今日审核数 + 全体 owner 排名,只回本人名次', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      { id: 'b1', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 100 }, reviewStats: { reviewedByDate: { [TODAY]: 30 } } },
      { id: 'b2', ownerUsername: '小票02', createdAt: todayIso, counts: { total: 100 }, reviewStats: { reviewedByDate: { [TODAY]: 80 } } },
      { id: 'b3', ownerUsername: '小票03', createdAt: todayIso, counts: { total: 100 }, reviewStats: { reviewedByDate: { [TODAY]: 50 } } },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '小票03' } });
  assert.equal(out.me.reviewedToday, 50);
  assert.equal(out.me.rank, 2, '80 > 50 > 30 → 第 2 名');
  assert.equal(out.me.rankTotal, 3);
  // 无批次的用户:不入榜
  const outNone = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '新人' } });
  assert.equal(outNone.me.rank, null);
  assert.equal(outNone.me.reviewedToday, 0);
});

test('me.reviewedToday 与效率分子同源:混合归属批次不再各讲各话(2026-07-19 审计HIGH)', async () => {
  // 批次 A 主 owner 是 admin,但内有 wang 的任务(task 级兜底→wang 可见);批次 B 直属 wang。
  // 旧 bug:对外 reviewedToday 取排行榜值(只算 B 的 2),效率分子却算 A+B 的 5。
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      {
        id: 'mixA', ownerUsername: 'admin', createdAt: todayIso,
        tasks: [{ id: 't1', customerOwnerUsername: 'wang' }],
        counts: { total: 10 },
        reviewStats: { reviewedByDate: { [TODAY]: 3 }, reviewSpans: { [TODAY]: { first: todayIso, last: todayIso } } },
      },
      {
        id: 'mixB', ownerUsername: 'wang', createdAt: todayIso,
        counts: { total: 10 },
        reviewStats: { reviewedByDate: { [TODAY]: 2 }, reviewSpans: { [TODAY]: { first: todayIso, last: todayIso } } },
      },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'reviewer', username: 'wang' } });
  assert.equal(out.me.reviewedToday, 5, '对外字段=本人可见批次求和(3+2),不取排行榜值');
  assert.equal(out.me.todayEfficiency, 5, '效率分子同源:5张÷1h(不足1h按1h)');
});

test('排名归键与看板同口径:仅有 ownerUserId 的批次也入榜,#userId 命中本人(审计LOW)', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      // 只有 userId 没有用户名的批次:旧写法漏出排行榜
      { id: 'u7', ownerUserId: 7, createdAt: todayIso, counts: { total: 10 }, reviewStats: { reviewedByDate: { [TODAY]: 9 } } },
      { id: 'n1', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 10 }, reviewStats: { reviewedByDate: { [TODAY]: 4 } } },
      // 无主批次:不入榜
      { id: 'orphan', createdAt: todayIso, counts: { total: 5 }, reviewStats: { reviewedByDate: { [TODAY]: 1 } } },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '小票07', userId: 7 } });
  assert.equal(out.me.rank, 1, '#7 桶 9 张 > 小票01 的 4 张,本人以 #userId 命中');
  assert.equal(out.me.rankTotal, 2, '未分配桶不入榜');
});

test('P2 今日效率:张/小时按首末跨度,不足1小时按1小时;跨批次同日跨度合并', async () => {
  // 今日 09:00-11:00(KST 无所谓,直接用 ISO 造 2h 跨度落在今日桶)
  const base = new Date();
  base.setHours(9, 0, 0, 0);
  const t0 = base.toISOString();
  const t2h = new Date(base.getTime() + 2 * 3600 * 1000).toISOString();
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      // 两个批次同一天干活:跨度取并集 09:00→11:00 = 2h,共 60 张 → 30 张/时
      { id: 'e1', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 50 },
        reviewStats: { reviewedByDate: { [TODAY]: 40 }, reviewSpans: { [TODAY]: { first: t0, last: t0 } } } },
      { id: 'e2', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 30 },
        reviewStats: { reviewedByDate: { [TODAY]: 20 }, reviewSpans: { [TODAY]: { first: t2h, last: t2h } } } },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '小票01' } });
  assert.equal(out.me.todayEfficiency, 30, '60张 ÷ 2小时 = 30');

  // 只审 5 张、跨度几分钟:不足 1h 按 1h → 效率=5(不会除出天文数字)
  const svcShort = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      { id: 'e3', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 10 },
        reviewStats: { reviewedByDate: { [TODAY]: 5 }, reviewSpans: { [TODAY]: { first: t0, last: t0 } } } },
    ]),
  }));
  const outShort = await svcShort.getOverview({ operatorUser: { role: 'reviewer', username: '小票01' } });
  assert.equal(outShort.me.todayEfficiency, 5);

  // 今日没审过:效率 null(前端显示 —)
  const svcNone = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      { id: 'e4', ownerUsername: '小票01', createdAt: todayIso, counts: { total: 10 }, reviewStats: { reviewedByDate: {} } },
    ]),
  }));
  const outNone = await svcNone.getOverview({ operatorUser: { role: 'reviewer', username: '小票01' } });
  assert.equal(outNone.me.todayEfficiency, null);
});

test('P2 我的数据(本月):完成按动作口径限本月;速度按活跃日工时;完成率/返工率存量', async () => {
  const monthPrefix = TODAY.slice(0, 7);
  // ⚠️ 必须是本月内**另一天**,不能写死 -01(2026-08-01 实炸):每月 1 号 day1===TODAY,
  // reviewedByDate 两个键塌成一个,90 被 60 覆盖 → 断言 150 变 60。
  // 这条用例本身没错,是夹具在"今天几号"上押了注 —— 一年 12 次必红。
  const day1 = TODAY.endsWith('-01') ? `${monthPrefix}-02` : `${monthPrefix}-01`;
  const d1t0 = `${day1}T01:00:00.000Z`;
  const d1t3h = `${day1}T04:00:00.000Z`;
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      {
        id: 'm1', ownerUsername: '小票01', createdAt: todayIso,
        counts: { total: 200, approved: 150, rephoto: 10 },
        reviewStats: {
          // 本月 90+60=150 张;上月 40 张不计
          reviewedByDate: { [day1]: 90, [TODAY]: 60, '2020-01-02': 40 },
          reviewSpans: {
            [day1]: { first: d1t0, last: d1t3h },            // 3h
            [TODAY]: { first: todayIso, last: todayIso },     // <1h → 按 1h
            '2020-01-02': { first: oldIso, last: oldIso },    // 上月:不计工时
          },
        },
      },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'reviewer', username: '小票01' } });
  assert.equal(out.me.month.reviewed, 150, '只算本月,上月 40 不计');
  assert.equal(out.me.month.avgPerHour, Number((150 / 4).toFixed(1)), '3h+1h=4h → 37.5 张/时');
  assert.equal(out.me.month.completionRate, 0.75, '150/200');
  assert.equal(out.me.month.reworkRate, 0.05, '10/200 重拍近似');
});

test('单个数据源抛错时降级为 0 并记 warning', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    missingReceiptRepo: { countByWorkspace: () => { throw new Error('db locked'); } },
  }));
  const out = await svc.getOverview({});
  assert.equal(out.month.unreceived, 0);
  assert.ok(out.warnings.some((w) => w.includes('unreceived')));
  assert.equal(out.month.received, 5238);
});

// 待管理事项(2026-07-26 用户需求②):超时未完成客户组 / 导出失败 两个新桶。
test('待管理事项:超时未完成客户组按组计数(已结算组不算);导出失败按失败戳计数', async () => {
  const staleIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const svc = createWorkbenchOverviewService(makeDeps({
    staleHours: 24,
    listBatches: async () => ([
      // 建批 48h 前:3 组里 1 组已结算 → 只算 2 组超时未完成
      {
        id: 'old',
        ownerUsername: 'a',
        createdAt: staleIso,
        updatedAt: staleIso,
        counts: { total: 30, fields: 10 },
        sourceGroups: [
          { key: 'g1', taskCount: 10, settledAt: '2026-07-20T00:00:00.000Z', settlementStatus: 'settled' },
          { key: 'g2', taskCount: 10 },
          { key: 'g3', taskCount: 10, settlementStatus: 'needs_confirm' },
        ],
      },
      // 今天建的批次:再多未结算组也不算超时
      {
        id: 'fresh',
        ownerUsername: 'a',
        createdAt: todayIso,
        updatedAt: todayIso,
        counts: { total: 20, fields: 20 },
        sourceGroups: [{ key: 'g9', taskCount: 20 }],
      },
      // 导出失败戳:进导出失败桶
      {
        id: 'failed',
        ownerUsername: 'a',
        createdAt: todayIso,
        updatedAt: todayIso,
        counts: { total: 5, approved: 5 },
        exportFailedAt: todayIso,
      },
    ]),
  }));

  const out = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  assert.equal(out.alerts.staleGroups.count, 2, '只数超时批次里未结算的组(g2/g3),已结算 g1 不算');
  assert.deepEqual(out.alerts.staleGroups.batchIds, ['old'], '今天建的 fresh 不进');
  assert.equal(out.alerts.staleGroups.thresholdHours, 24);
  // ⭐每批各贡献几个超时组(2026-08-01):前端展开明细那一列要与胶囊同量纲(都是「组」)。
  // 以前后端只给总数+批次 id,前端只能拿批次自己的**张数**填那一列 ——
  // 胶囊数组、行是批次、列是张,三个量纲串一条链上,数字之间没有可比性。
  assert.deepEqual(out.alerts.staleGroups.countByBatch, { old: 2 },
    '按批次给出各自的超时组数,且与 count 对得上');
  assert.equal(
    Object.values(out.alerts.staleGroups.countByBatch).reduce((a, b) => a + b, 0),
    out.alerts.staleGroups.count,
    '明细求和必须等于胶囊总数,否则又是两个口径',
  );
  assert.equal(out.alerts.exportFailed.count, 1);
  assert.deepEqual(out.alerts.exportFailed.batchIds, ['failed']);
});

test('待管理事项:无失败戳/无超时组时两桶为 0(不误报)', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    staleHours: 24,
    listBatches: async () => ([
      { id: 'ok', ownerUsername: 'a', createdAt: todayIso, updatedAt: todayIso, counts: { total: 5, approved: 5 }, sourceGroups: [{ key: 'g1', taskCount: 5 }] },
    ]),
  }));
  const out = await svc.getOverview({ operatorUser: { role: 'admin', username: 'boss' } });
  assert.equal(out.alerts.staleGroups.count, 0);
  assert.equal(out.alerts.exportFailed.count, 0);
});

test('staleGroups 不把 no_receipts 组 / 已干完的老批次算成「超时未完成」(部署前审计 MEDIUM)', async () => {
  const svc = createWorkbenchOverviewService(makeDeps({
    listBatches: async () => ([
      // ① 老批次、活儿已干完(backlog=0):不该再报超时,否则历史批次永久虚高
      {
        id: 'b_done', createdAt: oldIso, updatedAt: oldIso, exportedAt: oldIso,
        counts: { total: 10, queued: 0, processing: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 10 },
        sourceGroups: [{ taskCount: 5, settledAt: '', settlementStatus: '' }],
      },
      // ② 还有 backlog,但组是 no_receipts 终态(纯护照/0小票组:结算完成、故意不盖 settledAt)
      {
        id: 'b_norec', createdAt: oldIso, updatedAt: oldIso,
        counts: { total: 10, queued: 0, processing: 0, classification: 0, fields: 5, signature: 0, finalReview: 0, approved: 5 },
        sourceGroups: [{ taskCount: 5, settledAt: '', settlementStatus: 'no_receipts' }],
      },
      // ③ 真·超时未完成:有 backlog + 组确实没结算
      {
        id: 'b_real', createdAt: oldIso, updatedAt: oldIso,
        counts: { total: 10, queued: 0, processing: 0, classification: 0, fields: 5, signature: 0, finalReview: 0, approved: 5 },
        sourceGroups: [{ taskCount: 5, settledAt: '', settlementStatus: '' }],
      },
    ]),
  }));
  const out = await svc.getOverview({});
  // 口径=未完成**客户组数**(与标签「超N小时未完成客户组」一致),不是票数
  assert.equal(out.alerts.staleGroups.count, 1, '只剩 b_real 的那 1 个组');
  assert.deepEqual(out.alerts.staleGroups.batchIds, ['b_real'], 'b_done(已干完)/b_norec(终态)都不进');
});

// ── 0801:待管理事项展开面板的两个老毛病(核账报告 idx2)────────────────────────
test('⭐展开明细:列与胶囊同量纲 + 对不上的批次不静默丢', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '../frontend/src/views/home/AdminHomeView.vue'), 'utf8',
  );

  // 扫代码前先剥注释:注释里写"以前误用了哪个函数"是有价值的,不该被当成还在用它。
  // (这条闸和 ledger_select_columns_exist 那条都栽在同一处,统一这么处理。)
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // ① 明细列取的必须是后端按批次给的**组数**,不能再拿张数(batchBacklogCount)顶
  const defs = /const ALERT_DEFS = computed\(\(\) => \[([\s\S]*?)\n\]\)/.exec(src);
  assert.ok(defs, '没定位到 ALERT_DEFS');
  const defsCode = strip(defs[1]);
  assert.match(defsCode, /countByBatch/, '超时组那一列要用 countByBatch');
  assert.doesNotMatch(defsCode, /batchBacklogCount/, 'batchBacklogCount 是张数,与「组」不同量纲');
  assert.doesNotMatch(src, /import \{[^}]*batchBacklogCount/, '不再用它就别留死导入');
  // 表头要把单位写出来,否则并排数字仍会被当同一量纲比
  assert.match(src, /openAlertDef\.detailLabel \}\}\{\{ openAlertDef\.unit/, '列名带单位');

  // ② 展开列表不许 .filter(Boolean) 把对不上的 id 吞掉(「胶囊 12、点开 8 行」)
  const list = /const alertBatches = computed\(\(\) => \{[\s\S]*?\n\}\)/.exec(src);
  assert.ok(list, '没定位到 alertBatches');
  const listCode = strip(list[0]);
  assert.doesNotMatch(listCode, /\.filter\(Boolean\)/, '静默丢行就是这一句');
  assert.match(listCode, /missing: true/, '查不到详情的也要列出来(带 id)');
  assert.match(src, /alertMissingCount/, '并且要有一句说明,不是让人自己数');
  assert.match(src, /计数没错,是这张表拿不到它们的详情/, '说清楚是"取不到详情"而不是"数错了"');
});
