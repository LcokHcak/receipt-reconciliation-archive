'use strict';

// V2 Task10:三栏工作台 UI 契约(源码断言;交互行为归 Task 12 Playwright)。
// 锁住的东西:候选模式必标「候选」且样式区分;状态用克制文本;固定列宽行高;
// 服务端分页绑定;深链绑定(view=queue + returnTo;回发已下线);窄屏抽屉;lucide+tooltip;
// 空/错误/投影滞后均有可恢复 UI;finance 只读(canComplete)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const VIEW = 'frontend/src/views/AgentWorkspaceView.vue';
const TABLE = 'frontend/src/components/agent-workspace/AgentCustomerTable.vue';
const LIST = 'frontend/src/components/agent-workspace/AgentList.vue';
const SUMMARY = 'frontend/src/components/agent-workspace/WorkspaceSummary.vue';

async function loadDisplay() {
  return import(pathToFileURL(path.join(root, 'frontend/src/lib/agentWorkspaceDisplay.js')).href);
}

test('展示口径:候选模式必带「候选」标记且与确认模式可区分;状态文案克制', async () => {
  // 右栏任务列已下线(2026-07-18 用户拍板):groupTasksForRail/taskSourceMonthTag 随组件一并移除
  const { customerModeChips, statusLabel } = await loadDisplay();

  const chips = customerModeChips({ confirmedModes: ['发17号'], candidateModes: ['发17号', '乐天正常'] });
  assert.deepEqual(chips, [
    { mode: '发17号', kind: 'confirmed', label: '发17号' },
    { mode: '乐天正常', kind: 'candidate', label: '候选·乐天正常' },
  ]);

  assert.equal(statusLabel('tour_pending'), '待确认团号');
  assert.equal(statusLabel('needs_confirm'), '待结算确认');
  assert.equal(statusLabel(''), '—');
});

test('客户表:固定布局、服务端分页绑定、候选样式区分、行内打开审核', () => {
  const src = read(TABLE);
  assert.match(src, /table-layout:\s*fixed/);
  // 2026-07-16 P1(A3):行高自适应换行显全(用户拍板字段必须显示全,取代46px固定行高)
  assert.match(src, /min-height:\s*46px/);
  assert.ok(!/text-overflow:\s*ellipsis/.test(src), '不得再省略截断字段');
  assert.match(src, /colgroup/);
  assert.match(src, /emit\('loadMore'\)/);
  assert.match(src, /nextCursor/);
  assert.match(src, /候选模式,团号未确认/); // tooltip 区分候选
  assert.match(src, /ct-mode\.candidate/); // 候选样式独立(虚线空心)
  assert.match(src, /emit\('open', c\)/);
  assert.match(src, /未入批次/); // 无批次客户不给假按钮
  assert.match(src, /当前筛选下没有客户/); // 空态可理解
  assert.match(src, /重试/); // 错误可恢复
});

test('视图:20/80 两栏(任务列已下线) + 1366 可用;深链绑定 view=queue + returnTo', () => {
  const src = read(VIEW);
  // 右栏任务列已下线(2026-07-18 用户拍板):三栏→两栏,抽屉/完成按钮随之移除
  assert.match(src, /grid-template-columns:\s*20%\s+1fr/);
  assert.doesNotMatch(src, /grid-template-columns:\s*20%\s+1fr\s+20%/);
  assert.doesNotMatch(src, /aw-drawer/);
  assert.match(src, /max-width:\s*1440px/);
  assert.match(src, /max-width:\s*1100px/);
  assert.match(src, /view:\s*'queue'/); // 回发面板已下线(2026-07-14):深链落实时队列
  assert.match(src, /returnTo:\s*route\.fullPath/);
});

test('可访问性与图标:lucide + tooltip/aria;左栏搜索有 aria-label', () => {
  for (const [file, needles] of [
    [VIEW, ['lucide-vue-next']], // 任务面板按钮已随任务列下线(2026-07-18)
    [LIST, ['lucide-vue-next', 'aria-label="搜索代理"', 'role="listbox"', ':aria-selected']],
    [SUMMARY, ['lucide-vue-next', 'aria-label="重试统计"', 'role="status"']],
    [TABLE, ['lucide-vue-next', 'aria-label="客户列表"']],
  ]) {
    const src = read(file);
    for (const needle of needles) {
      assert.ok(src.includes(needle), `${file} 缺 ${needle}`);
    }
  }
});

test('投影滞后提示:5 分钟内不打扰,超过才提示', async () => {
  const { projectionLagText } = await loadDisplay();
  assert.equal(projectionLagText(30_000), '');
  assert.equal(projectionLagText(4 * 60 * 1000), '');
  // 0729 用词补漏:原文案「数据同步滞后约 N 分钟」含「同步」,违反 0727 拍板。
  // 断言只锁**语义**(说清数据有多旧)+ 不含退役词,别再把具体措辞焊死在测试里。
  const text = projectionLagText(10 * 60 * 1000);
  assert.match(text, /10 分钟/, '要说清数据有多旧');
  assert.doesNotMatch(text, /同步/, '界面文案不得出现「同步」(0727 拍板)');
  assert.equal(projectionLagText(null), '');
});

// ── 2026-07-13 规格对齐新增:统计卡口径 / 相对时间 / 免税店 / 状态色 展示纯函数 ──
test('统计卡口径(2026-07-24 改版):主行 3 桶互斥、已完成+排队待审+待处理=总数;副行图数;X/Y=当前代理/全部', async () => {
  const { buildStatCards } = await loadDisplay();
  const summary = {
    // byStatus 含全部 8 态里出现的(recognizing/ready_for_sync 也在,否则加不齐总数)
    visibleAll: { totalCustomers: 100, todayCount: 12, totalImages: 300, byStatus: { recognizing: 7, ready_for_sync: 30, review_pending: 18, tour_pending: 2, passed: 34, needs_remedy: 3, needs_confirm: 1, rephoto: 5 } },
    selectedAgent: { totalCustomers: 20, todayCount: 3, totalImages: 60, byStatus: { ready_for_sync: 6, review_pending: 6, passed: 4, needs_remedy: 1, needs_confirm: 1, rephoto: 2 } },
  };
  const cards = buildStatCards(summary);
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(by.total.allCount, 100); assert.equal(by.total.agentCount, 20);
  assert.equal(by.done.allCount, 34); assert.equal(by.done.agentCount, 4); // passed
  assert.equal(by.inflow.allCount, 57); // recognizing7+ready30+tour2+review18
  assert.equal(by.needs.allCount, 9); assert.equal(by.needs.agentCount, 4); // rephoto+needs_remedy+needs_confirm
  // ⭐互斥铁律:主行三桶相加正好=总数(全部代理 + 当前代理都成立,这才是"数字可信")
  assert.equal(by.done.allCount + by.inflow.allCount + by.needs.allCount, by.total.allCount);
  assert.equal(by.done.agentCount + by.inflow.agentCount + by.needs.agentCount, by.total.agentCount);
  // 副行:活动 + 量
  assert.equal(by.today.allCount, 12); assert.equal(by.today.agentCount, 3);
  assert.equal(by.images.allCount, 300); assert.equal(by.images.agentCount, 60);
  assert.equal(by.done.row, 'main'); assert.equal(by.images.row, 'aux');
  assert.ok(by.total.hasAgent && by.needs.ratio > 0);
  // 未选代理 → agentCount null,ratio 0
  const noAgent = buildStatCards({ visibleAll: summary.visibleAll, selectedAgent: null });
  assert.equal(noAgent[0].agentCount, null);
  assert.equal(noAgent[0].hasAgent, false);
});

test('统计卡按票口径(P3 unit=receipt):主行桶用 receiptsByStatus、总数=总票数、互斥和成立', async () => {
  const { buildStatCards } = await loadDisplay();
  const summary = {
    visibleAll: {
      totalCustomers: 100, totalReceipts: 250,
      byStatus: { passed: 34, tour_pending: 2, review_pending: 18, ready_for_sync: 30, recognizing: 7, rephoto: 5, needs_remedy: 3, needs_confirm: 1 },
      receiptsByStatus: { passed: 90, tour_pending: 40, review_pending: 30, ready_for_sync: 50, recognizing: 10, rephoto: 12, needs_remedy: 15, needs_confirm: 3 },
      todayCount: 12, totalImages: 300,
    },
    selectedAgent: null,
  };
  const g = Object.fromEntries(buildStatCards(summary, 'group').map((c) => [c.key, c]));
  const r = Object.fromEntries(buildStatCards(summary, 'receipt').map((c) => [c.key, c]));
  // 按组:总数=客户组 100,标签「客户组总数」
  assert.equal(g.total.allCount, 100); assert.equal(g.total.label, '客户组总数');
  // 按票:总数=总票数 250,标签「总票数」;主行桶用 receiptsByStatus
  assert.equal(r.total.allCount, 250); assert.equal(r.total.label, '总票数');
  assert.equal(r.done.allCount, 90); // passed 的票
  assert.equal(r.inflow.allCount, 130); // recognizing10+ready50+tour40+review30
  assert.equal(r.needs.allCount, 30); // rephoto12+needs_remedy15+needs_confirm3
  // ⭐互斥铁律(按票口径同样成立):三桶和 = 总票数
  assert.equal(r.done.allCount + r.inflow.allCount + r.needs.allCount, r.total.allCount);
  // 未知 unit 回落 group
  assert.equal(Object.fromEntries(buildStatCards(summary, 'xyz').map((c) => [c.key, c])).total.allCount, 100);
});

test('相对时间/免税店中文/状态取色', async () => {
  const { relativeTime, storeDisplayName, customerStoresText, statusColorKind, formatReceivedDay } = await loadDisplay();
  const now = Date.parse('2026-07-13T10:00:00Z');
  // 收票日(P2):MM-DD,不带时刻;非法=—
  assert.match(formatReceivedDay('2026-07-14T05:55:00Z'), /^\d{2}-\d{2}$/);
  assert.equal(formatReceivedDay(''), '—');
  assert.equal(relativeTime('2026-07-13T09:57:00Z', now), '3分钟前');
  assert.equal(relativeTime('2026-07-13T09:59:40Z', now), '刚刚');
  assert.equal(relativeTime('2026-07-13T07:00:00Z', now), '3小时前');
  assert.equal(relativeTime('', now), '');
  assert.equal(storeDisplayName('LOTTE'), '乐天');
  assert.equal(storeDisplayName('THE SHILLA'), '新罗');
  assert.equal(storeDisplayName('SHILLA IPARK'), '爱宝客');
  assert.equal(storeDisplayName('HYUNDAI_DEPT'), '现代百货');
  assert.equal(customerStoresText({ storeKeys: ['LOTTE', 'THE SHILLA'] }), '乐天/新罗');
  assert.equal(customerStoresText({ storeKeys: [] }), '—');
  assert.equal(statusColorKind('passed'), 'ok');
  assert.equal(statusColorKind('review_pending'), 'plain');
});

test('客户表列结构(2026-07-24 P2):序号/收票日/票图数/免税店/状态·进度合并列/去审核台;点姓名跳审核;状态仅已通过绿', () => {
  const src = read(TABLE);
  assert.match(src, />序号</);
  assert.match(src, />免税店</);
  assert.match(src, />收票日</); // 收票时间→收票日(按日)
  assert.match(src, />票\/图数</); // 图片数→票/图数
  // 2026-07-27 需求E③:四节点进度条撤掉(每行都是同样四个词=没信息,且与状态徽章重复),
  // 该列只留【状态徽章 + 真实 pending 任务】,没任务就留空。
  assert.match(src, />状态 · 任务</);
  assert.ok(!/>审核状态</.test(src) && !/>下一步任务</.test(src), '旧的两列表头已合并');
  assert.ok(!/customerProgressNodes/.test(src), '四节点进度条已撤');
  assert.ok(!/ct-node/.test(src), '进度节点样式已撤');
  assert.match(src, /taskChipLabel/);
  assert.match(src, /v-if="tasksOf\(c\)\.length"/, '无任务时整块不渲染=单元格留空');
  assert.match(src, /去审核台/);
  assert.match(src, /\(待识别\)/u); // 未识别占位
  // 2026-07-16 P1(A1):姓名不再跳转(与右侧去审核重复,用户拍板保右侧唯一入口)
  assert.ok(!/ct-name-btn/.test(src), '姓名不得再是跳转按钮');
  assert.match(src, /去审核台/);
  assert.match(src, /relativeTime/); // 两行相对时间
  assert.match(src, /customerStoresText/);
  assert.match(src, /statusColorKind/);
  assert.match(src, /\.ct-status\.ok/); // 已通过绿
});

test('视图新增:去导出交付包→资料库;当前代理标题;模式筛选下拉;双视角页签(P2)', () => {
  const src = read(VIEW);
  assert.match(src, /去导出交付包/);
  assert.match(src, /name: 'library'/); // 跳资料库(用户拍板)
  // P2:标题「客户中心」(0728#3 正名,原代理视图),三签 已收/未收/日交付
  assert.match(src, /客户中心/); assert.match(src, /日交付/);
  assert.match(src, /已收客户组/);
  assert.match(src, /未收客户组/);
  assert.match(src, /UnreceivedPanel/);
  assert.match(src, /view === 'unreceived' \? 'unreceived' : 'received'/);
  assert.match(src, /currentScopeTitle/);
  assert.match(src, /模式筛选/);
  assert.match(src, /modeOptions/);
});

test('未收面板(P3):无需补排除在途票;深链/未建档明示;恢复催收只撤 waive', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'components', 'agent-workspace', 'UnreceivedPanel.vue'),
    'utf8',
  );
  // 复核 HIGH#1 契约:豁免集合必须排除 inFlight(图已收还在审的票标"无需补"是假留痕)
  assert.match(src, /!r\.received && !r\.waived && !r\.inFlight/);
  assert.match(src, /未建档/); // 拍板⑤:未建档明示徽标,无死按钮
  assert.match(src, /buildReviewDeepLink/); // 已建档走同一深链白名单模块
  assert.match(src, /恢复催收/);
  assert.match(src, /window\.confirm/); // 项目先例是 confirm,不引入 prompt
  assert.doesNotMatch(src, /window\.prompt/);
});

test('统计卡组件:6卡一排 X/Y + 进度条;左栏总代理数;任务列已下线', () => {
  const summarySrc = read(SUMMARY);
  assert.match(summarySrc, /ws-cards/);
  assert.match(summarySrc, /ws-card-bar/); // 细进度条
  assert.match(summarySrc, /buildStatCards/);
  const listSrc = read(LIST);
  assert.match(listSrc, /al-head-count/); // 总代理数徽标
  assert.match(listSrc, /共 \{\{ agents\.length \}\}/);
  // 右栏任务列已下线(2026-07-18 用户拍板):视图不再引用 WorkflowTaskRail,
  // 但中栏行内任务徽章(pendingTaskMap)保留——store.tasks 数据链不许断
  const viewSrc = read(VIEW);
  assert.doesNotMatch(viewSrc, /WorkflowTaskRail/);
  assert.doesNotMatch(viewSrc, /taskDrawerOpen/);
  assert.match(viewSrc, /pendingTaskMap/);
});

// ── 2026-07-27 需求E:代理视图五项(搜索清除/计数跟随日期/任务列/说人话/单位) ────────────
const STORE = 'frontend/src/stores/agentWorkspace.js';

test('E①「删不掉」根因:syncUrl 清空筛选必须先把 FILTER_KEYS 全清成 undefined', async () => {
  const src = read(VIEW);
  // queryFromFilters 省略空值 → next 里没有被清空的那个键 → {...route.query} 的旧值原地不动,
  // URL 上删不掉,刷新/前进后退又读回来。原代码手写了 5 个键的清单,2026-07 加的 search/day 都漏了。
  const fn = src.slice(src.indexOf('function syncUrl'), src.indexOf('watch(() => store.routeQuery'));
  assert.ok(fn.includes('FILTER_KEYS.map((key) => [key, undefined])'), '必须从 FILTER_KEYS 派生,不许手写清单');
  assert.ok(!/month: undefined, agentKey: undefined/.test(fn), '手写清单已废除');
  assert.match(src, /FILTER_KEYS/);
  assert.ok(src.includes('import { sameFilters, filtersFromQuery, FILTER_KEYS }'));

  // 口径本身:清空 search 后 queryFromFilters 确实不含该键(所以才必须显式清)
  const { queryFromFilters, FILTER_KEYS: keys } = await import('../frontend/src/lib/agentWorkspaceQuery.js');
  assert.ok(!('search' in queryFromFilters({ month: '2026-07', search: '' })));
  assert.ok(keys.includes('search') && keys.includes('day'), 'search/day 在筛选键里 → 也必须进清除清单');
});

test('E①搜索清除:不用 type=search——原生×只清草稿不撤筛选,就是用户说的"删不掉"', () => {
  const src = read(VIEW);
  const inputBlock = src.slice(src.indexOf('aw-search-top-input'), src.indexOf('aw-search-top-btn'));
  assert.ok(!/type="search"/.test(inputBlock), '原生 search 清除键会造成"字没了但列表还是搜索结果"');
  assert.match(inputBlock, /type="text"/);
  // 自家 × 在「有草稿 或 有已生效筛选」时都在场;清除函数两处都清
  assert.match(src, /v-if="searchDraft \|\| store\.search"/);
  assert.match(src, /@keyup\.esc="clearSearch"/);
  const fn = src.slice(src.indexOf('function clearSearch'), src.indexOf('function clearSearch') + 160);
  assert.match(fn, /searchDraft\.value = ''/);
  assert.match(fn, /setFilters\(\{ search: '' \}\)/);
});

test('E②计数跟随选中日:store 把 day 传给 summary;后端窗口收窄,前端「今日→当日」', async () => {
  const store = read(STORE);
  const call = store.slice(store.indexOf('fetchWorkspaceSummary('), store.indexOf('fetchWorkspaceSummary(') + 240);
  assert.match(call, /day: this\.day/, '不传 day → 卡片与下方按日过滤出的列表对不上');
  assert.match(read(VIEW), /:day="store\.day"/);
  assert.match(read(SUMMARY), /buildStatCards\(props\.summary, unit\.value, Boolean\(props\.day\)\)/);

  const { buildStatCards } = await loadDisplay();
  const s = { visibleAll: { totalCustomers: 3, byStatus: { passed: 3 }, todayCount: 3 } };
  const labelOf = (dayActive, key) => buildStatCards(s, 'group', dayActive).find((c) => c.key === key).label;
  assert.equal(labelOf(false, 'today'), '今日新增');
  assert.equal(labelOf(true, 'today'), '当日新增');
  assert.equal(labelOf(true, 'todayBatches'), '当日已审');
});

test('E③说人话:桶名改过三轮,桶成员一次没动(仍互斥、和=总数)', async () => {
  const { buildStatCards } = await loadDisplay();
  const summary = {
    visibleAll: {
      totalCustomers: 100,
      byStatus: {
        passed: 40,
        recognizing: 5, ready_for_sync: 5, tour_pending: 10, review_pending: 20, // 排队待审 40
        rephoto: 5, needs_remedy: 10, needs_confirm: 5, // 要人处理 20
      },
    },
  };
  const by = Object.fromEntries(buildStatCards(summary, 'group').map((c) => [c.key, c]));
  // 改名史:流程中 → 排队待审(0727);待人处理 → 要人处理(0727)→ **待处理**(0730)。
  // 0730 那轮的两条理由:①「要人/待人」会被读成一个词(要人=重要人物),断词歧义;
  // ②**不能叫「异常」** —— 生产实测这个桶里 needs_confirm 占 68.1%(4586/6731),
  //   而它的含义是"必审全干完但组未结算 = 审完了等你点结算",根本不是异常;
  //   真异常(needs_remedy)只占 5.9%。叫异常等于说系统有 4586 个毛病。
  assert.equal(by.inflow.label, '排队待审');
  assert.equal(by.needs.label, '待处理', '不叫「要人处理」(断词歧义)也不叫「异常」(68% 是等结算)');
  assert.ok(!by.needs.label.includes('异常'), '桶里 68% 不是异常,别污名化');
  assert.ok(by.inflow.hint && by.needs.hint, '两个桶都要有一句话解释(hover)');
  // hint 要按**真实占比**排序:原来把 68% 的 needs_confirm 放最后
  const needsHint = by.needs.hint;
  assert.ok(needsHint.indexOf('待确认结算') < needsHint.indexOf('要重拍'),
    '占 68% 的「待确认结算」要排在最前');
  assert.ok(needsHint.includes('待确认结算'), '「待确认」没说清确认什么,要写全');
  assert.ok(needsHint.includes('只能人动手'), 'hint 要说清为什么要人管');
  // ⭐改名不得动桶成员:三桶相加仍=总数
  assert.equal(by.done.allCount + by.inflow.allCount + by.needs.allCount, by.total.allCount);
  assert.equal(by.inflow.allCount, 40);
  assert.equal(by.needs.allCount, 20);
});

test('E④数字带单位:主行随口径切组/张,副行按本义固定批/图', async () => {
  const { buildStatCards } = await loadDisplay();
  const summary = { visibleAll: { totalCustomers: 100, totalReceipts: 250, byStatus: { passed: 100 }, receiptsByStatus: { passed: 250 } } };
  const g = Object.fromEntries(buildStatCards(summary, 'group').map((c) => [c.key, c]));
  const r = Object.fromEntries(buildStatCards(summary, 'receipt').map((c) => [c.key, c]));
  assert.equal(g.total.unitText, '组');
  assert.equal(r.total.unitText, '张');
  assert.equal(g.todayBatches.unitText, '批');
  assert.equal(g.images.unitText, '图');
  // ⭐副行单位不许跟着口径变(实测抓到的 bug):todayCount 是 COUNT(*) 组数,
  // 切到「按票」时曾显示「当日新增 7 张」——数字是组、单位是张,比不标单位更糟。
  assert.equal(r.today.unitText, '组', '当日新增恒为组数,不随口径变张');
  assert.equal(r.todayBatches.unitText, '批');
  assert.equal(r.images.unitText, '图');
  assert.match(read(SUMMARY), /ws-card-unit/);
});

test('E③任务标签:类型/时效/更正各有说法,未知类型不炸', async () => {
  const { taskChipLabel } = await loadDisplay();
  assert.equal(taskChipLabel({ taskType: 'send_upstream', subtype: 'standard' }), '发上家');
  assert.equal(taskChipLabel({ taskType: 'send_upstream', subtype: 'send_17' }), '发上家·17点前发');
  assert.equal(taskChipLabel({ taskType: 'send_upstream', subtype: 'correction' }), '发更正');
  assert.equal(taskChipLabel({ taskType: 'unreceived_followup' }), '催未收');
  assert.equal(taskChipLabel({ taskType: 'brand_new_type' }), 'brand_new_type');
  assert.equal(taskChipLabel({}), '任务');
});

test('E③配置台入口(2026-07-29 用户拍板·甲案):齿轮搬进「状态·任务」列头、只留图标、tooltip 不撒谎', () => {
  const table = read(TABLE);
  const view = read(VIEW);
  // 入口从工具栏搬到它管的那一列的表头
  assert.match(table, /class="ct-task-cfg"/, '齿轮应在表头');
  assert.match(table, /emit\('configTask'\)/, '表格保持纯展示,路由交回 View');
  assert.ok(!/aw-task-config/.test(view), '工具栏里的旧文字链应已撤');
  // 用户:「只用前面小图标显示就行了,不是很重要」——但纯图标对读屏是个空按钮,必须留可读名字
  assert.match(table, /aria-label="配置任务/, '纯图标按钮必须有 aria-label');
  assert.ok(!/>\s*配置任务\s*</.test(table), '只留图标,不带可见文字');
  // 甲案红线:配置台的 actions 并不驱动本列(本列 subtype 由 review_lane.sendbackActionOfMode
  // 正则扫模式名得出),tooltip 绝不许暗示"在那儿改能改这一列"
  assert.ok(!/title="[^"]*这一?列[^"]*"/.test(table), 'tooltip 不得宣称它决定本列内容');
  // 跳转必须带深链参数,否则落在配置台顶部,「一眼找到」这条诉求等于没做
  assert.match(view, /path: '\/admin\/config', query: \{ nav: 'modes', focus: 'tasks' \}/);
});

// ── 0727#16-2(0728新版文档):未收模式筛选+本司视角 ────────────────────────
test('未收面板:模式筛选可输入+候选带未收数;本司计数卡可点一键筛;组按模式过滤', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/components/agent-workspace/UnreceivedPanel.vue'), 'utf8');
  assert.match(src, /list="ur-mode-options"/, '可输入筛选(datalist 型)');
  assert.match(src, /v-for="\[m, c\] in modeStats"/, '候选=各模式');
  assert.match(src, /未收 \{\{ c \}\} 票/, '候选直显未收数量(需求原话)');
  assert.match(src, /companyUnreceived/, '本司未收合计');
  assert.match(src, /COMPANY_MARK = '本司'/, '公司标记词');
  assert.match(src, /@click="filterCompany"/, '计数卡点击=一键筛选');
  assert.match(src, /in shownGroups/, '表格吃过滤后的组');
  assert.match(src, /isUnreceivedRow\(r\) && String\(r\.mode \|\| ''\)\.includes\(q\)/, '只按真未收行的模式匹配');
  assert.match(src, /em :class="\{ amber: companyUnreceived > 0 \}"/, '有未收才琥珀,0 灰阶不喊');
});

// ── 0729:后端 warnings 有两个数,界面只显示了一个 ────────────────────────
// agent_workspace_service 产出 { unknownMonthCustomers, unlabeledAgentCustomers },
// 而 WorkspaceSummary 只读了后者 —— **「月份判不出来」算了但全站零处消费**。
// 后果比未标代理隐蔽:这些客户按月筛选时根本不出现,操作员看「2026-07」时他们是隐形的,
// 也不会有任何地方提示"还有 N 个人你没看到"。
// 生产实测当前为 0(18083 个投影里 0 个)→ 补显示零噪音,且一旦亮起来就一定是真问题。
test('工作区概览:后端给的两个 warning 都要显示,别只挑一个', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '../frontend/src/components/agent-workspace/WorkspaceSummary.vue'), 'utf8',
  );
  assert.match(src, /unlabeledAgentCustomers/, '未标代理(既有)');
  assert.match(src, /unknownMonthCustomers/, '月份不明(0729 补)');
  assert.match(src, /月份不明 \{\{ unknownMonth \}\}/, '要显示数字');
  assert.match(src, /按月筛选看不到/, '说清后果 —— 不是"少了个标签"那么轻');
  assert.match(src, /v-if="unknownMonth > 0"/, '健康态 0 时不显示,不制造噪音');
  // 后端确实产出这两个字段(前提失效时这条测试要红,而不是默默测一个不存在的东西)
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/agent_workspace_service.js'), 'utf8');
  assert.match(svc, /unknownMonthCustomers:/);
  assert.match(svc, /unlabeledAgentCustomers:/);
});
