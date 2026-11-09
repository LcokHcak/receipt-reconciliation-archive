'use strict';

// 审核台任务流改造(2026-07-27 用户提词):队列从"资料列表"转向"工作队列"。
// 锁四层:①纯口径(概览/等待分级/新排序/命中字段)②队列组件契约(默认隐藏已完成/
// 单图直开/队列顺序上报)③推进链路(确认沿队列走/自动推进开关/会话历史)④快捷键不冲突。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const LIST = 'frontend/src/components/GroupedTaskList.vue';
const VIEW = 'frontend/src/views/ReviewView.vue';

const {
  buildQueueSummary, waitTierOf, WAIT_TIERS, sortReviewGroups, matchedFieldOfGroup, normalizeQueueQuery,
} = require('../frontend/src/lib/reviewDisplay.js');

// ── ① 纯口径 ────────────────────────────────────────────────────────────────
test('概览三桶互斥穷尽:done+pending+abnormal === total(与页签计数同构,顶部数字不许自相矛盾)', () => {
  const groups = [
    { total: 3, pendingCount: 0, rephotoCount: 0 }, // done
    { total: 2, pendingCount: 1, rephotoCount: 0 }, // pending
    { total: 2, pendingCount: 2, rephotoCount: 1 }, // abnormal(重拍优先归异常)
    { total: 1, pendingCount: 1, rephotoCount: 0 }, // pending
  ];
  const s = buildQueueSummary(groups);
  assert.equal(s.total, 4);
  assert.deepEqual([s.done, s.pending, s.abnormal], [1, 2, 1]);
  assert.equal(s.done + s.pending + s.abnormal, s.total);
  assert.equal(buildQueueSummary([]).ratio, 0, '空队列不许除零');
});

test('等待分级:2h 警告 / 4h 超时 / 已完成恒 normal(完成件不存在"超时")', () => {
  const now = Date.parse('2026-07-27T10:00:00Z');
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  assert.equal(waitTierOf(at(30), now), 'normal');
  assert.equal(waitTierOf(at(121), now), 'warning');
  assert.equal(waitTierOf(at(241), now), 'overdue');
  assert.equal(waitTierOf(at(500), now, false), 'normal', 'hasWork=false 恒 normal');
  assert.equal(waitTierOf('bad-date', now), 'normal', '坏时间不炸');
  assert.ok(WAIT_TIERS.warningMs < WAIT_TIERS.overdueMs, '阈值单调');
});

test('排序·异常优先:重拍组置顶,其余待办次之,已完成沉底;桶内 FIFO', () => {
  const g = (label, createdAt, pending, rephoto) => ({ label, displayName: label, createdAt, pendingCount: pending, rephotoCount: rephoto });
  const out = sortReviewGroups([
    g('完成A', '2026-07-27T01:00:00Z', 0, 0),
    g('待办B', '2026-07-27T02:00:00Z', 1, 0),
    g('重拍C', '2026-07-27T03:00:00Z', 1, 1),
    g('待办D', '2026-07-27T01:30:00Z', 1, 0),
    g('重拍E', '2026-07-27T00:30:00Z', 0, 2),
  ], 'abnormalFirst');
  assert.deepEqual(out.map((x) => x.label), ['重拍E', '重拍C', '待办D', '待办B', '完成A']);
});

test('排序·代理连续:同代理聚在一起,代理间按"最早一组"定先后(先来的代理整体先处理)', () => {
  const g = (agent, id, createdAt) => ({ label: id, displayName: agent, createdAt, pendingCount: 1, rephotoCount: 0 });
  const out = sortReviewGroups([
    g('张代理', 'z1', '2026-07-27T02:00:00Z'),
    g('李代理', 'l1', '2026-07-27T01:00:00Z'),
    g('张代理', 'z2', '2026-07-27T01:30:00Z'),
    g('李代理', 'l2', '2026-07-27T03:00:00Z'),
  ], 'agentGroup');
  // 李代理最早(01:00)→ 李的两组(FIFO)→ 张的两组(FIFO)
  assert.deepEqual(out.map((x) => x.label), ['l1', 'l2', 'z2', 'z1']);
});

test('搜索命中字段:护照/团号/小票号各自报得出名字,帮用户确认为什么命中', () => {
  const group = {
    displayName: 'WANG FANG',
    customerId: 'CL20260727-003',
    tasks: [{ passportNoFinal: 'EA1234567', groupNoFinal: '26146517', receiptNoFinal: '901125-26-006433' }],
  };
  assert.equal(matchedFieldOfGroup(group, normalizeQueueQuery('EA12345')), '护照号');
  assert.equal(matchedFieldOfGroup(group, normalizeQueueQuery('26146517')), '团号');
  assert.equal(matchedFieldOfGroup(group, normalizeQueueQuery('90112526006433')), '小票号');
  assert.equal(matchedFieldOfGroup(group, normalizeQueueQuery('wang fang')), '姓名');
  assert.equal(matchedFieldOfGroup(group, ''), '', '空查询不标');
});

// ── ② 队列组件契约 ──────────────────────────────────────────────────────────
test('P4 默认隐藏已完成:仅「全部」页签+开关关+非搜索态隐藏;已通过页签/搜索照常显示', () => {
  const src = read(LIST);
  assert.match(src, /showCompleted/);
  assert.match(src, /reviewQueueShowCompleted/, '开关记 localStorage');
  // 搜索态全量的实现形态升级(0727#7):原来靠 !normalizedQuery 条件豁免,现在搜索分支
  // 提前返回全量过滤(连状态页签一起豁免),见 ⑩ 的顺序断言;这里只守非搜索态默认隐藏。
  assert.match(src, /!showCompleted\.value/, '非搜索态默认隐藏已完成');
  assert.match(src, /显示已完成/);
  // 定位清障必须连开关一起打开,否则"定位到已审完的图"静默失效
  const reveal = src.slice(src.indexOf('function revealForLocate'), src.indexOf('function revealForLocate') + 300);
  assert.match(reveal, /showCompleted\.value = true/);
});

test('P5 单图组直开:total===1 点组头直接 select,不渲染子层;多图组保持展开', () => {
  const src = read(LIST);
  assert.match(src, /function onHeaderClick/);
  assert.match(src, /group\.total === 1 && group\.tasks\[0\]/);
  assert.match(src, /@click="onHeaderClick\(group\)"/);
  assert.match(src, /v-if="group\.total > 1 && isExpanded\(group\)"/, '单图组不出子列表');
});

test('P6 概览+计数器:三桶数字来自 buildQueueSummary(与页签同构);7/147 计数器与上一/下一组按钮在场', () => {
  const src = read(LIST);
  assert.match(src, /buildQueueSummary\(groups\.value\)/, '概览必须算「全部组」,不随筛选缩水');
  assert.match(src, /queue-summary/);
  assert.match(src, /qs-bar/, '进度条');
  // ‹ i/N › 导航 2026-07-28 挪进 ReviewView 面板头(塞概览行 280px 必换行):
  // i/N 由父层从 queue-change 的 groupKeys + selectedGroupKey 自算,组件不再 emit 导航。
  const view = read(VIEW);
  assert.match(view, /queueNavText/);
  assert.match(view, /class="queue-nav"/);
  assert.match(view, /@click="goPrevGroup"/);
  assert.match(view, /@click="goNextGroup"/);
  assert.ok(!src.includes("emit('go-prev')"), '导航按钮已不在队列组件里');
});

test('队列顺序上报:visibleGroups 变化 emit queue-change(展平任务id),签名去重防循环', () => {
  const src = read(LIST);
  assert.match(src, /emit\('queue-change', \{ taskIds, groupKeys/);
  assert.match(src, /lastQueueSig/, 'computed 每次新数组,必须签名比对防重复 emit');
  assert.match(src, /\{ immediate: true \}/, '首屏也要上报,否则确认第一张时队列序还是空');
});

test('P3 当前居中:选中变化 scrollIntoView center;单图组滚组头(它没有 task-row)', () => {
  const src = read(LIST);
  assert.match(src, /block: 'center'/);
  assert.match(src, /group-header\.current/);
  assert.ok(!src.includes("'.task-row.active')?.scrollIntoView?.({ block: 'nearest' })"), 'nearest 已换 center');
});

// ── ③ 推进链路 ──────────────────────────────────────────────────────────────
test('确认推进沿队列走:findNextInQueue 优先,回落存储序;开关关则原地不动', () => {
  const src = read(VIEW);
  assert.match(src, /function findNextInQueue/);
  // 2026-08-01:原来这里截固定 500 字符。函数一长(本次加了"回头再扫一遍"),
  // 'exhausted' 就被推出窗口,断言凭空失败 —— 而代码是对的。
  // 截固定长度的取段方式本身就是个定时炸弹,改成取到函数结尾。
  const moveStart = src.indexOf('function moveAfterFlowAction');
  const move = src.slice(moveStart, src.indexOf('\nfunction afterFlowTail'));
  assert.ok(move.length > 300, `取到的函数体太短(${move.length}),取段方式失效了`);
  assert.match(move, /findNextInQueue\(taskId, 1, \{ pendingOnly \}\) \|\| findAdjacentTaskId/, '队列序优先,存储序兜底');
  // 2026-08-01:返回值从布尔改成原因('moved'|'stopped'|'exhausted')。
  // 行为没变(开关关=停在原地),变的是**它把原因说出来了** —— 原来 false 有两个意思,
  // 调用方一律说"队列已完成",于是关掉开关之后每审完一组都被告知队列完成了。
  assert.match(move, /if \(!autoAdvance\.value\) return 'stopped'/, '开关关=确认后停在原地');
  assert.match(move, /return 'moved'/);
  assert.match(move, /return 'exhausted'/, '真没有下一组是另一种结果,不能和"开关关着"混为一谈');
  // 2026-08-01 再加一种:往后扫不到**不等于**队列空了,前面可能还有一堆待办。
  // 原来直接喊"本批次已处理完",而右上角同时写着"待处理 37"——插队审完就漏整批。
  assert.match(move, /return 'wrapped'/,
    '后面没有但前面还有 → 要跳回去,而不是谎报队列完成');
  assert.match(src, /function afterFlowTail/, '每种结果各配一句人话');
  assert.match(src, /「自动下一组」是关着的,停在本组/, '开关关着时要这么说,不能说"队列已完成"');
  assert.ok(!/moved \? .{0,40}队列已完成/.test(src), '不许再用布尔三元把两种原因说成同一句');
  assert.match(src, /reviewAutoAdvance/, '开关记 localStorage');
  assert.match(src, /自动下一组/);
});

// 2026-08-01:选「百货」时的提示说成"已改为小票,请先匹配团号" —— 百货落库也是 receipt,
// 但界面上人点的是百货,而且**百货没有团号**,那一步根本不存在。指向做不到的动作。
test('改类型提示按用户点的那一档说话:百货不说"小票",也不叫人去匹配团号', () => {
  const src = read(VIEW);
  assert.match(src, /async function changeDocType\(nextType, uiPick = ''\)/,
    '要接收界面上点的那一档(百货落库是 receipt,光看落库值分不出来)');
  assert.match(src, /dept: '百货票'/);
  assert.match(src, /百货无团号,不需要匹配团号/, '要显式说清楚这一步不存在');
  // ⚠️ 光有文案不够:得确认它真的按 uiPick 分支。第一次写这条时只断言了文案存在,
  // 验红时把 `pick` 改成直接取落库值也照样通过 —— 那等于没测。
  assert.match(src, /const pick = uiPick === 'dept' \? 'dept' : next/,
    '提示分档必须由 uiPick 决定(只看落库值的话百货和小票分不开)');
  assert.match(src, /pick === 'dept'/, '要有百货那一支');
  // 免税小票那句照旧(它确实要先匹配团号)
  assert.match(src, /请先在「第一步·本票团号」匹配团号/);

  const editor = read('frontend/src/components/FieldEditor.vue');
  assert.match(editor, /emit\('on-doctype-change', draft\.docTypeFinal, nextType\)/,
    '落库值与界面选择要分两个参数传,不能只传落库值');
});

test('上一组=会话历史(非索引减一):history 去重相邻、上限、弹到仍存在的任务为止;换批次清空', () => {
  const src = read(VIEW);
  assert.match(src, /visitHistory/);
  assert.match(src, /if \(last === prev\) return/, '相邻去重');
  assert.match(src, /function goPrevGroup/);
  assert.match(src, /while \(visitHistory\.value\.length\)/, '被删任务要跳过,不能停在死id上');
  assert.match(src, /visitHistory\.value = \[\]/, '换批次清历史');
});

test('预加载:只预热后面≤2组的图片URL,Set 去重,换批次清空,失败不影响当前任务', () => {
  const src = read(VIEW);
  assert.match(src, /prefetchedUrls = new Set/);
  assert.match(src, /prefetchedUrls\.has\(url\)/, '同URL只请求一次');
  assert.match(src, /groupsSeen\.size > 2/, '封顶2组,防内存/请求风暴');
  assert.match(src, /prefetchedUrls\.clear\(\)/, '换批次清缓存');
});

// ── ④ 快捷键 ────────────────────────────────────────────────────────────────
test('快捷键:←/→/Ctrl+F/Esc 新增;R 仍=重拍(规格想改"刷新",不采纳——有肌肉记忆+回归测试钉着)', () => {
  const src = read(VIEW);
  const hotkey = src.slice(src.indexOf('function onReviewHotkey'), src.indexOf('onMounted(() => window.addEventListener'));
  assert.match(hotkey, /ArrowLeft/);
  assert.match(hotkey, /ArrowRight/);
  assert.match(hotkey, /e\.key === 'f' \|\| e\.key === 'F'/);
  assert.match(hotkey, /focusSearch/);
  assert.match(hotkey, /Escape/);
  assert.match(hotkey, /markRephotoAndNext\(\)/, 'R=重拍不动');
  // 输入框里不误触:←/→ 在 isEditableTarget 判定之后(Ctrl+F 例外,它就该在输入框里也能用)
  assert.ok(hotkey.indexOf('isEditableTarget(e.target)') < hotkey.indexOf('ArrowLeft'), '方向键必须在输入框守卫之后');
});

// ── ⑤ 280px 面板布局契约(2026-07-27 UI评估:生产截图实锤三处溢出/截断) ──────────
test('280px 面板不许横向溢出:概览可换行/导航簇不拆散/工具行可换行/兜底 overflow-x hidden', () => {
  const src = read(LIST);
  // ① 概览行必须可换行(nowrap 曾把 ‹1/6› 顶出右缘 + 撑出横向滚动条)
  const qsNumsStart = src.indexOf('.qs-nums {');
  const qsNums = src.slice(qsNumsStart, src.indexOf('}', qsNumsStart)); // 只看本规则块,子选择器的合法 nowrap 不误伤
  assert.match(qsNums, /flex-wrap: wrap/);
  assert.ok(!/white-space: nowrap/.test(qsNums), '整行 nowrap 已废除(单项内部 nowrap 由子选择器承担)');
  // ② ‹ 计数 › 三件套已整体挪进面板头(2026-07-28):概览行塞不下是拥挤元凶,
  // 面板头右侧本来空着。组件里不得残留导航簇。
  assert.ok(!src.includes('qs-nav-cluster'), '导航簇已迁出概览行');
  assert.match(read(VIEW), /queue-nav-counter/);
  // ③ 工具行可换行(排序+开关+展开按钮放不下时不截断)
  const tools = src.slice(src.indexOf('.queue-tools-row {'), src.indexOf('.queue-tools-row {') + 220);
  assert.match(tools, /flex-wrap: wrap/);
  // ④ 兜底:任何一行再溢出也不给整栏挂横向滚动条
  const list = src.slice(src.indexOf('.grouped-list {'), src.indexOf('.grouped-list {') + 300);
  assert.match(list, /overflow-x: hidden/);
});

test('零值筛选页签压暗(位置保留=可盲点),选中态不压;面板头不再重复组数', () => {
  const src = read(LIST);
  assert.match(src, /'qf-zero': filter\.count === 0 && filter\.key !== 'all'/);
  assert.match(src, /button\.qf-zero:not\(\.active\)/);
  const view = read(VIEW);
  assert.ok(!view.includes('{{ reviewGroupCount }} 组'), '「客户组队列 N组」与概览「本批次 N组」重复,删前者');
});

// ── ⑥ 2026-07-28 参考图对齐(用户发生产截图:工具区 8 行 vs 参考 3 行) ──────────
test('参考图对齐:chips 图标+数字(仅「全部」留文字)/子行图标化/双「当前」清理/导航在面板头', () => {
  const src = read(LIST);
  // chips:非「全部」页签文字进 sr-only(读屏保留),视觉只剩 图标+数字 → 一行放得下
  assert.match(src, /v-if="filter\.key === 'all'" class="qf-label"/);
  assert.match(src, /class="sr-only"/);
  // 子行:StatusBadge 四字文字徽章 → 与组状态同一套圆形图标;组件不再 import StatusBadge
  assert.match(src, /function taskStatusIcon/);
  assert.match(src, /item\.statusIcon\.icon/);
  assert.ok(!src.includes('StatusBadge'), '子行文字徽章已图标化');
  // 0729 生产事故防回归:icon 字段自 lucide 化之后装的是**Vue 组件对象**,
  // 用 {{ }} 插值会把组件源码当文本渲染(生产曾 522 个子行显示
  // 「(n,{slots:r,attrs:i})=>s(Et,…)」)。所有图标渲染点必须走 <component :is>。
  assert.match(src, /<component :is="item\.statusIcon\.icon"/, '子行图标必须用 component :is 渲染');
  assert.doesNotMatch(src, /\{\{\s*[\w.]*\.icon\s*\}\}/, '图标是组件对象,禁止 {{ }} 文本插值');
  // 「排序」二字省掉(下拉即排序),含义进 title/aria
  assert.ok(!/<span>排序<\/span>/.test(src), '「排序」label 已省');
  assert.match(src, /aria-label="队列排序方式"/);
  // 面板头:标题 + ‹ i/N ›(ReviewView),组件概览行不再挤导航
  const view = read(VIEW);
  assert.match(view, /queue-panel-title/);
  assert.match(view, /queueNavText = computed/);
});

// ── 0729 生产复查:「全部 860」只显示 100 行,落差无交代 ──────────────────────
test('「全部」页签隐藏已审完组时,列表末尾必须说明差额并给一键显示', () => {
  const src = read(LIST);
  assert.match(src, /const hiddenDoneCount = computed/);
  // 只在「全部 + 开关关 + 非搜索态」这一种会产生落差的组合下才提示,否则是噪音
  assert.match(src, /if \(normalizedQuery\.value\) return 0/);
  assert.match(src, /if \(activeFilter\.value !== 'all' \|\| showCompleted\.value\) return 0/);
  // 说明落在列表末尾(困惑正是在滑到底那一刻产生),不是塞回工具行
  assert.match(src, /hiddenDoneCount > 0[\s\S]{0,200}另有 \{\{ hiddenDoneCount \}\} 组已审完/);
  assert.match(src, /queue-hidden-show[\s\S]{0,80}showCompleted = true/, '给一键放出来的入口');
  // 颜色语义:交代事实=灰阶,动作=蓝(与全站硬规则同口径)
  assert.match(src, /\.queue-hidden-note \{[\s\S]{0,200}color: var\(--muted\)/);
  assert.match(src, /\.queue-hidden-show \{[\s\S]{0,200}color: var\(--accent\)/);
});

// ── ⑦ 0727 测试反馈迭代①(百货流顺滑 + 代理联动 + 配置台文案) ──────────────
test('反馈#5 百货意图豁免:一等档=百货时 表态区隐藏/字段解锁/确认放行,不再绕「无团号」', () => {
  const view = read(VIEW);
  // 意图经显式事件上报(读 expose 的响应性在任务更新/重挂时不可靠,实测栽过)
  assert.ok(view.includes("const deptIntentActive = computed(() => editorUiType.value === 'dept')"));
  assert.ok(view.includes('@on-ui-type-change="editorUiType = $event"'));
  // 三处锁位全部挂豁免:确认守卫 / 字段区锁样式 / 表态区渲染
  assert.match(view, /isTaskStanceLocked\(selectedTask\.value\) && !deptIntentActive\.value/);
  assert.match(view, /isTaskStanceLocked\(selectedTask\) && !deptIntentActive/);
  assert.match(view, /!isTourExemptTask\(selectedTask\) && !deptIntentActive/);
  // FieldEditor 暴露 uiType(意图源)
  const fe = read('frontend/src/components/FieldEditor.vue');
  assert.ok(fe.includes("watch(uiType, (v) => emit('on-ui-type-change', v), { immediate: true })"), '意图变化立即上报,换任务不残留');
});

test('反馈#4 百货默认缩放:免税小票才 350%,百货整图走适应窗口', () => {
  const iv = read('frontend/src/components/ImageViewer.vue');
  assert.match(iv, /isDeptStoreValue/);
  assert.match(iv, /docType === 'receipt' && !isDept && !showOriginal\.value/);
});

test('反馈E4 代理联动:全代理视角点客户 → 左栏亮起其代理(不改筛选)+滚动到位', () => {
  const view = read('frontend/src/views/AgentWorkspaceView.vue');
  assert.match(view, /highlightAgentKey/);
  assert.match(view, /@select="onCustomerSelect"/);
  assert.match(view, /:highlight-key="highlightAgentKey"/);
  const list = read('frontend/src/components/agent-workspace/AgentList.vue');
  assert.match(list, /highlight: !activeAgentKey && highlightKey === agent\.agentKey/, '已选代理筛选时不叠加高亮');
  assert.match(list, /\.al-item\.highlight/, '高亮是描边提示,与 active 实底可区分');
  assert.match(list, /data-agent-key/, '滚动定位锚');
});

test('反馈G1/G5 配置台:「特殊动作签」→「任务设置」且不再折叠;左栏去全粗、选中才加重、栏宽 268px', () => {
  const cc = read('frontend/src/views/ConfigConsoleView.vue');
  // 2026-07-29:文案再改一版(设置任务→任务设置),并从 <details class="adv"> 提到主区块④——
  // 用户诉求是"进配置台要一眼找到在哪设置任务",默认收起时改名也没用,折叠本身才是根因。
  assert.match(cc, /任务设置\s*<span class="summary">/, '任务设置是主区块 h3,不是 summary');
  assert.ok(!/<summary[^>]*>(特殊动作签|设置任务|任务设置)</.test(cc), '不许再退回折叠标题');
  // 位置断言:光看"有没有这四个字"锁不住诉求——它埋在默认收起的 <details> 里时也"有"。
  // 真正要锁的是**它排在「高级」折叠之前**,即还在主区里。
  const taskIdx = cc.indexOf('id="mode-task-settings"');
  const advIdx = cc.indexOf('<details class="adv">');
  assert.ok(taskIdx > 0, '任务设置块要有锚点(代理视图齿轮靠它定位)');
  assert.ok(advIdx > 0, '高级折叠区应仍在(导出与冲突/改动历史)');
  assert.ok(taskIdx < advIdx, '任务设置必须排在「高级」折叠之前——默认收起时改名解决不了"找不到"');
  assert.ok(!cc.includes('动作签=审核台字段区的提醒 chip'), '大段说明已删(要点进悬停)');
  assert.match(cc, /\.li-name \{ font-weight: 400/);
  assert.match(cc, /\.list-item\.active \.li-name \{ font-weight: 500/);
  assert.match(cc, /grid-template-columns: 268px/);
});

test('反馈G2/G3 配置台:大段说明收进【说明】点开;死配置「团号字面量」输入框已删', () => {
  const cc = read('frontend/src/views/ConfigConsoleView.vue');
  // G2:说明默认收起,内容一字不删(免审生效条件是防误解关键)
  assert.match(cc, /const showFieldsDoc = ref\(false\)/);
  assert.match(cc, /doc-toggle/);
  assert.match(cc, /v-if="showFieldsDoc"/);
  assert.match(cc, /自动免审/, '说明内容保留,只是收起');
  // G3:自称"暂未接线,改了不生效"的输入框删掉;draft 字段保留透传(存量配置不丢)
  assert.ok(!cc.includes('团号字面量(暂未接线'), '死配置输入框已删');
  assert.match(cc, /groupNoLiteral: draft\.value\.groupNoLiteral/, 'payload 透传保留,存量不丢');
});

// ── ⑧ 0727反馈#2 百货直通:纯百货组结算不弹面板,自动确认+跳下一组 ─────────────
test('反馈#2 百货直通判定:组内小票全为百货才直通,混组/无小票走面板', () => {
  const view = read(VIEW);
  // 判定:仅看小票(免税小票混入即非直通),空小票组不直通(receipts.length > 0)
  assert.match(view, /function isDeptOnlyGroup/);
  assert.match(view, /normalizeDocType\(t\) === 'receipt'/);
  assert.match(view, /receipts\.length > 0/);
  assert.match(view, /receipts\.every\(\(t\) => isDeptStoreValue\(t\.receiptStoreFinal \|\| t\.receiptStoreAuto\)\)/);
  // 直通经 panel 开关走 settleGroupInline,不是旁路复制一套结算
  assert.match(view, /settleGroupInline\(groupKey, \{ panel: !deptDirect \}\)/);
  assert.match(view, /if \(panel\) settleResult\.value = res/);
});

test('反馈#2 直通护栏:S活动/意外结算态回退面板;自动确认失败退人工且必带错误提示', () => {
  const view = read(VIEW);
  // S活动要人工背书,needs_remedy 等意外形态要人看见 → 都弹面板
  assert.match(view, /hasSActivity/);
  assert.match(view, /\['needs_confirm', 'settled'\]\.includes\(String\(res\.settlementStatus \|\| ''\)\)/);
  // 直通收口:needs_confirm 才补确认,随后本地 stamp + 沿队列推进
  assert.match(view, /confirmGroupModes\(selectedBatchId\.value, groupKey\)/);
  // 失败兜底:退回面板 + setError,绝不静默(组已结算,只差模式确认)
  assert.match(view, /自动确认渠道模式失败,请在面板手动确认/);
});

test('反馈#2 面板确认收口:不回建档时确认后沿队列跳下一组(尊重 pendingOnly),文案同步', () => {
  const view = read(VIEW);
  assert.match(view, /moveAfterFlowAction\(selectedTaskId\.value, \{ pendingOnly: true \}\)/);
  assert.match(view, /确认后自动跳下一组/);
  assert.ok(!view.includes('已留在审核页,继续下一组'), '旧「留在原地」文案已换');
});

// ── ⑨ 0727反馈#10 重拍分键:标重拍带原因(模糊/缺/其他),R→1/2/3 两键完成 ──────
test('反馈#10 原因三键单一声明:key 落库 label 呈现,顺序即快捷键 1/2/3', () => {
  const { REPHOTO_REASONS, rephotoReasonLabel } = require('../frontend/src/lib/reviewDisplay.js');
  assert.deepEqual(REPHOTO_REASONS.map((r) => r.key), ['blurry', 'missing', 'other']);
  assert.deepEqual(REPHOTO_REASONS.map((r) => r.label), ['模糊', '缺', '其他']);
  assert.equal(rephotoReasonLabel('blurry'), '模糊');
  assert.equal(rephotoReasonLabel('bogus'), '', '不认识的键回空——旧数据无原因时不显示乱码');
});

test('反馈#10 交互:R/点按钮=开三键选择器(不直接标),1/2/3 直选,Esc 先收选择器,换任务关残影', () => {
  const view = read(VIEW);
  assert.match(view, /const rephotoPickerOpen = ref\(false\)/);
  // 无参调用=开关选择器;选了原因才真标(markRephotoAndNext(reason) 落库)
  assert.match(view, /if \(!reason\) \{[\s\S]{0,120}rephotoPickerOpen\.value = !rephotoPickerOpen\.value/);
  const hotkey = view.slice(view.indexOf('function onReviewHotkey'), view.indexOf("onMounted(() => window.addEventListener"));
  assert.match(hotkey, /rephotoPickerOpen\.value && \['1', '2', '3'\]\.includes\(e\.key\)/);
  assert.match(hotkey, /markRephotoAndNext\(\)/, 'R 仍是重拍入口(肌肉记忆不动)');
  assert.ok(
    hotkey.indexOf('rephotoPickerOpen.value = false; return') < hotkey.indexOf('clearSearch'),
    'Esc 先收选择器,不连带清搜索',
  );
  assert.match(view, /watch\(selectedTaskId, \(\) => \{ rephotoPickerOpen\.value = false \}\)/);
});

test('反馈#10 落库与呈现:store 随更新带原因;后端只认三键、取消/通过时清;子行 title 带「重拍·原因」', () => {
  const store = read('frontend/src/stores/workbench.js');
  assert.match(store, /markTaskRephoto\(taskId, reason = ''\)/);
  assert.match(store, /rephotoReason: reason/);
  const w = read('services/workbench_write/task.js');
  assert.match(w, /\['blurry', 'missing', 'other'\]\.includes\(String\(rephotoReason \|\| ''\)\)/, '乱值不落,旧客户端裸标兼容');
  const approveBlock = w.slice(w.indexOf('const approve = reviewed'), w.indexOf('if (typeof rephotoRequested'));
  assert.match(approveBlock, /task\.rephotoReason = ''/, '通过时原因跟着清');
  // 持久化白名单/改类型清场由 task_field_contract(field_registry 登记)机器核对,这里不重复
  const list = read(LIST);
  assert.match(list, /rephotoReasonLabel\(task\.rephotoReason\)/);
  assert.match(list, /`重拍·\$\{reason\}`/, '有原因显「重拍·模糊」,无原因照旧「需重拍」');
});

// ── ⑩ 0727反馈#7 搜索跨状态全量:票号在别的状态页签下也必须搜得回 ────────────
test('反馈#7 搜索态无视状态页签:visibleGroups 搜索分支提前返回全量过滤,不与页签取交集', () => {
  const src = read(LIST);
  const vg = src.slice(src.indexOf('const visibleGroups = computed'), src.indexOf('// ── 任务流(2026-07-27)'));
  // 搜索分支必须在页签过滤之前提前返回(交集=「待处理」页签搜已通过组票号得空,即 0727#7 报障)
  const searchReturn = vg.indexOf('return groups.value.filter((group) => matchesGroupSearch');
  const tabFilter = vg.indexOf("activeFilter.value === 'stance'");
  assert.ok(searchReturn !== -1, '搜索态从全量 groups 出发');
  assert.ok(tabFilter !== -1 && searchReturn < tabFilter, '搜索提前返回,页签过滤只在非搜索态生效');
  // 非搜索态的 P4 默认隐藏已完成保持原样
  assert.match(vg, /!showCompleted\.value/);
});

// ── ⑧ 2026-07-28 完成态整改(用户截图:完成卡飘中间/裂图白板/横幅冗余) ──────────
test('批次完成卡:✓态标+三桶数字(与左栏概览同源)+需重拍联动+主CTA;不再飘在面板中间', () => {
  const view = read(VIEW);
  assert.match(view, /rc-check/);
  assert.match(view, /本批次已审完/);
  assert.match(view, /queueOrder\.summary\.done/, '组桶来自 queue-change 上报的 summary,与左栏同源');
  assert.match(view, /setFilter\?\.\('rephoto'\)/, '「处理需重拍」联动左栏筛选');
  const list = read(LIST);
  assert.match(list, /summary: summary\.value/, '队列组件把 summary 一并 emit');
  assert.match(list, /function setFilter/);
  // 布局:inspector 改 flex 列,完成卡 none/字段面板 1——旧 grid 单行把完成卡垂直居中
  const css = read('frontend/src/style.css');
  assert.match(css, /\.review-inspector \{\s*[^}]*flex-direction: column/s);
  assert.match(css, /\.review-inspector > \.review-complete-inline \{ flex: none; \}/);
});

test('图片空/裂态:无图=占位说明;原图也挂=覆盖层+重新加载;换任务重置', () => {
  const iv = read('frontend/src/components/ImageViewer.vue');
  assert.match(iv, /const brokenImage = ref\(false\)/);
  assert.match(iv, /brokenImage\.value = true/, '回退后仍挂 → 占位,不留浏览器破图标');
  assert.match(iv, /function retryBrokenImage/);
  assert.match(iv, /viewer-broken-overlay/);
  assert.match(iv, /该任务没有可显示的图片/, '有任务但无图,与「没选任务」各说各话');
  assert.match(iv, /previewFailed\.value = false; brokenImage\.value = false/, '换任务两态都重置');
  assert.match(iv, /position: relative; \/\* 裂图覆盖层/, 'stage 是 overlay 定位锚');
});

test('回执横幅只显短句(名字/张数不再说两遍),完整回执在悬停+复制里一字不少', () => {
  const view = read(VIEW);
  assert.match(view, /receiptCard\.brief \|\| receiptCard\.text/);
  assert.match(view, /张小票已全部表态/);
  assert.match(view, /:title="receiptCard\.text"/, '完整回执在悬停');
  assert.match(view, /text: buildReceiptText\(list, name\)/, '复制物完整保留');
  assert.ok(!view.includes('小票已全部表态,{{ receiptCard.text }}'), '横幅不再铺全文');
});

// 2026-08-01:队列搜索只搜**本批次已加载**的组,而界面此前一个字都没交代 ——
// 客服拿着别的批次的票号来问,审核员在这儿永远搜不到,最容易得出的结论是"号错了"。
// (对照:客户中心那个搜索框是真·全库的,注释与实现一致,tooltip 没说谎。)
test('队列搜索要交代范围:占位符标「仅本批次」,0 命中时给跨批次的去处', () => {
  const src = read('frontend/src/components/GroupedTaskList.vue');
  // 用字面量包含,不拼正则:中文全角括号在正则里是普通字符没错,但半角/全角混用极易看走眼,
  // 而"断言写错方向"今天已经栽过两次。能用 includes 就别用 match。
  assert.ok(src.includes('placeholder="搜 姓名/护照/团号/票号(仅本批次)"'), '占位符就得说清范围');
  // 2026-08-01:原来钉的是 `只搜**本批次**已加载的客户组` —— 带 markdown 星号。
  // 而 title 是 HTML 属性,**不渲染 markdown**,那两对星号会原样显示给用户。
  // 出交付报告截图时看见的,已改成中文引号。断言跟着改成钉**语义**而不是钉那两个星号:
  // 措辞以后还会调,而"要说清只搜本批次"这件事不该跟着变。
  assert.match(src, /只搜.{0,2}本批次.{0,2}已加载的客户组/, 'title 里把话说透');
  assert.doesNotMatch(src, /\*\*本批次\*\*/, 'title 属性不渲染 markdown,别把星号显示给用户');
  assert.match(src, /不是号错了/, '点破最容易的误判');
  // 0 命中才出提示(有命中时不添噪音)
  assert.match(src, /v-if="normalizedQuery && visibleGroups\.length === 0"/);
  assert.match(src, /跨批次找请去<RouterLink to="\/agents">客户中心<\/RouterLink>搜/, '要给去处,不能只说"没有"');
  assert.match(src, /import \{ RouterLink \} from 'vue-router'/, 'RouterLink 得导入,否则渲染成空标签');
});
