'use strict';

// 队列搜索匹配器(2026-07-13):861组翻"已通过"找人只能挨个看 → 工具栏搜索。
// 纯函数在 reviewDisplay,组件只做接线;这里锁匹配口径。

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesGroupSearch, normalizeQueueQuery } = require('../frontend/src/lib/reviewDisplay.js');

const GROUP = {
  key: 'group_abc',
  label: '星途',
  displayName: 'JIANG AITONG 260702-011',
  customerId: 'CL20260702-011',
  tasks: [
    { extractedNameFinal: 'JIANG AITONG', passportNoFinal: 'EG8761171', groupNoFinal: '26146517', receiptNoFinal: '901125-26-006433' },
    { extractedNameAuto: '', passportNoAuto: '', groupNoAuto: '', receiptNoAuto: '21-000123-456-78901' },
  ],
};

test('normalizeQueueQuery:大写化+去空白与连字符', () => {
  assert.equal(normalizeQueueQuery(' jiang  aitong '), 'JIANGAITONG');
  assert.equal(normalizeQueueQuery('901125-26-006433'), '90112526006433');
  assert.equal(normalizeQueueQuery(''), '');
  assert.equal(normalizeQueueQuery(null), '');
});

test('搜索命中:姓名(含空格差异)/护照号/团号/客户号/组标签/小票号(带杠数字都命中)', () => {
  for (const q of ['JIANG AITONG', 'jiangaitong', 'jiang ai', 'EG8761171', 'eg87611', '26146517', 'CL20260702-011', '星途',
    '90112526006433', '9011252600643', '901125-26-006433', // 小票号 Final:纯数字/前缀/带杠都命中
    '2100012345678901', '21-000123-456-78901']) { // 小票号 Auto(百货带杠)
    assert.equal(matchesGroupSearch(GROUP, normalizeQueueQuery(q)), true, `${q} 应命中`);
  }
});

test('搜索不命中:别人的名字/号', () => {
  for (const q of ['WANG WEI', 'EH9999999', '99999999']) {
    assert.equal(matchesGroupSearch(GROUP, normalizeQueueQuery(q)), false, `${q} 不该命中`);
  }
});

test('空搜索恒真;脏组不炸(非空查询才走任务循环,体检 MEDIUM 指出旧断言没打到炸点)', () => {
  assert.equal(matchesGroupSearch(GROUP, ''), true);
  assert.equal(matchesGroupSearch({}, normalizeQueueQuery('x')), false);
  // 真炸点:非空查询 + tasks 含 null(删除残留引用)——修复前这里 TypeError 炸穿队列
  assert.equal(matchesGroupSearch({ tasks: [null, undefined], displayName: 'ABC' }, normalizeQueueQuery('abc')), true);
  assert.equal(matchesGroupSearch({ tasks: [null] }, normalizeQueueQuery('zzz')), false);
});

// 队列左栏改版(2026-07-26 用户需求①③④)
const fsq = require('node:fs');
const pathq = require('node:path');
const listSrc = fsq.readFileSync(pathq.join(__dirname, '../frontend/src/components/GroupedTaskList.vue'), 'utf8');

test('①搜索框置顶:排在筛选页签之前', () => {
  const searchIdx = listSrc.indexOf('queue-search-row');
  const filterIdx = listSrc.indexOf('queue-filter-row');
  assert.ok(searchIdx > 0 && filterIdx > 0, '两个区块都在');
  assert.ok(searchIdx < filterIdx, '搜索行必须排在筛选行之前(用户需求:搜索是进队列第一动作)');
});

test('③状态图标:筛选页签与行内状态共用同一套符号,行内只出图标不堆文字', () => {
  assert.match(listSrc, /QUEUE_STATUS_ICONS/);
  // 四态各有符号(取 QUEUE_STATUS_ICONS 块逐个查,避免正则转义踩坑)
  const iconBlock = listSrc.slice(listSrc.indexOf('QUEUE_STATUS_ICONS'), listSrc.indexOf('QUEUE_STATUS_ICONS') + 260);
  for (const key of ['stance', 'pending', 'rephoto', 'approved']) {
    assert.ok(iconBlock.includes(`${key}:`), `缺 ${key} 图标`);
  }
  assert.match(listSrc, /qf-icon/, '筛选页签带图标');
  assert.match(listSrc, /group\.next\.icon/, '行内状态渲染图标而非文字');
  assert.ok(!listSrc.includes('>{{ group.next.text }}<'), '行内不再把 next.text 直接当内容渲染');
  // 文案降级进悬停(不丢信息:待匹配3·重拍1 的分解仍可查)
  assert.match(listSrc, /group\.next\.text/, '完整文案仍在 title 里');
});

test('④客户号只留末段序号(完整号进悬停)', () => {
  assert.match(listSrc, /shortCustomerId/);
  assert.match(listSrc, /group\.shortId/);
  assert.match(listSrc, /:title="group\.customerId"/, '完整客户号进悬停,排查/搜索不受影响');
});

test('shortCustomerId:取末段序号;无横线原样;空值空串', async () => {
  const { shortCustomerId } = await import('../frontend/src/lib/reviewDisplay.js');
  assert.equal(shortCustomerId('CL20260722-001'), '001');
  assert.equal(shortCustomerId('CL20260722-014'), '014');
  assert.equal(shortCustomerId('ABC'), 'ABC');
  assert.equal(shortCustomerId(''), '');
  assert.equal(shortCustomerId(null), '');
});

test('formatQueueClock:只出 HH:mm,非法值空串', async () => {
  const { formatQueueClock } = await import('../frontend/src/lib/reviewDisplay.js');
  assert.match(formatQueueClock('2026-07-22T06:35:00Z'), /^\d{2}:\d{2}$/);
  assert.equal(formatQueueClock('bad'), '');
  assert.equal(formatQueueClock(''), '');
});

// 检查器面板设计整改(2026-07-27):快检↔确认闭环 / 键位不抢已有快捷键 / 单选不用蓝
const fe = fsq.readFileSync(pathq.join(__dirname, '../frontend/src/components/FieldEditor.vue'), 'utf8');
const rv = fsq.readFileSync(pathq.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');

test('键盘快捷键不与已有 Enter/R 冲突:免税店键位跳过 R(R=重拍)', () => {
  const m = /const CHOICE_HOTKEYS = \[([^\]]+)\]/.exec(fe);
  assert.ok(m, '找得到 CHOICE_HOTKEYS');
  const keys = m[1].replace(/['\s]/g, '').split(',');
  assert.ok(!keys.includes('R'), 'R 是「重拍」全局快捷键,不能分给店家(捕获阶段会抢走)');
  assert.ok(keys.includes('Q') && keys.includes('W'), '仍从 Q/W 起排');
  // 数字键给文件类型
  assert.match(fe, /\^\[1-9\]\$/, '数字键绑文件类型');
  // 输入框内不劫持
  assert.match(fe, /tag === 'input' \|\| tag === 'textarea'/, '焦点在输入框时不劫持按键');
});

test('快检结果与确认按钮闭环:没过→红字点名字段 + 确认降级描边', () => {
  assert.match(fe, /quickcheck-line/);
  assert.match(fe, /nonGreenLabels/, '红字要点名是哪几个字段');
  assert.ok(!fe.includes('all-green-banner'), '整块绿底卡片已取消');
  assert.match(rv, /fieldsQuickCheckPassed/);
  assert.match(rv, /confirm-cta-caution/, '快检没过时确认降级');
  assert.match(rv, /isSlimReceipt\.value\) return true/, 'SLIM 车道无字段面板→不误降级');
});

test('单选统一且不用蓝色(蓝色只留给确认)', () => {
  // tier1 与 choice 都用同一套「加重边框+浅底+主文本色」,不再 background: var(--accent)
  assert.ok(!/\.tier1-btn\.active\s*\{[^}]*background:\s*var\(--accent\)/.test(fe), '文件类型选中不再用蓝底');
  assert.ok(!/\.choice-option\.active\s*\{[^}]*color:\s*var\(--accent\)/.test(fe), '免税店选中不再用蓝字');
  assert.match(fe, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, '免税店两列固定网格');
});

// ── 2026-07-29 方案A:状态图标换成 lucide 线性图标族(用户:原来那套"好像智障")──
test('状态图标是同一族线性图标组件,不再是拼凑的标点符号', () => {
  const iconBlock = listSrc.slice(listSrc.indexOf('const QUEUE_STATUS_ICONS'), listSrc.indexOf('const QUEUE_STATUS_ICONS') + 220);
  // 语义映射:问号圈=不知道归谁 / 时钟=在等 / 相机=要重拍 / 勾=完成
  assert.match(iconBlock, /stance: HelpCircle/);
  assert.match(iconBlock, /pending: Clock/);
  assert.match(iconBlock, /rephoto: Camera/);
  assert.match(iconBlock, /approved: Check/);
  // 结算三态同族;待补救用扳手=与「异常补救」页头同图标,跨页面呼应
  assert.match(listSrc, /settled: CheckCheck, confirm: Tag, remedy: Wrench/);
  assert.match(listSrc, /from 'lucide-vue-next'/, '复用既有依赖,不新增图标体积');
  // 渲染成组件(旧写法是把字符插值进 span)
  assert.match(listSrc, /<component :is="filter\.icon"/);
  assert.match(listSrc, /<component :is="group\.next\.icon"/);
  for (const glyph of ['❗', '◐', '✕', '●', '◆', '▲']) {
    assert.ok(!listSrc.includes(`'${glyph}'`), `旧标点图标 ${glyph} 应已下线`);
  }
  // 绿删补漏:已审完/已通过是"正常态",走灰阶不喊
  assert.ok(!listSrc.includes('#ecfccb') && !listSrc.includes('#3f6212'), '已通过/已审完不得再用绿');
});

// ── 页签宽度护栏(0729 实测回归):SVG 图标比原标点宽,全桶三位数时曾把 5 个页签挤到换行 ──
// 280px 面板实测:图标 13px+margin1px+内边距5px → 999 态占满 247px 恰好换行;
// 收成 图标12px+无margin+内边距4px → 229px,留 18px 余量。数值锁死,防以后调图标又挤爆。
test('筛选页签在 280px 面板放得下:图标 12px、无右外距、内边距 4px', () => {
  assert.match(listSrc, /:size="12"[^>]*class="qf-icon"|class="qf-icon"[^>]*:size="12"/, '页签图标 12px');
  const iconCss = /\.queue-filter-row \.qf-icon \{([^}]*)\}/.exec(listSrc);
  assert.ok(iconCss, '有 qf-icon 样式');
  assert.ok(!/margin-right/.test(iconCss[1]), '不留右外距(flex gap 已负责间隔)');
  const btnCss = /\.queue-filter-row button \{([^}]*)\}/.exec(listSrc);
  assert.match(btnCss[1], /padding: 0 4px/, '内边距 4px');
});

test('⭐搜索框还要排在「任务概览」之前(0724-C2-1:搜索框放到队列标题上方)', () => {
  // 两份需求抢同一个位置:你要搜索框紧贴【客户组队列】标题,
  // 而 GPT 那份规格要在标题下加「任务概览」块 —— 概览先渲染就把搜索顶下去了。
  // 实机实测:搜索框距左栏顶 99px,中间隔着 48px 标题 + 概览行。
  //
  // 取舍理由:概览是**看**的(24组/完成/待办,扫一眼就行,在哪都能看见),
  // 搜索是**够**的(要用手点、要靠肌肉记忆),够的东西必须位置固定且靠上。
  // 所以搜索置顶,概览退到它下面 —— 两个需求都还在,只是排序换了。
  const searchIdx = listSrc.indexOf('queue-search-row');
  const summaryIdx = listSrc.indexOf('queue-summary');
  assert.ok(searchIdx > 0 && summaryIdx > 0, '两个区块都要在(概览不是删掉,是让位)');
  assert.ok(searchIdx < summaryIdx,
    '「任务概览」排在搜索框之前 —— 它会把搜索框顶下去,而搜索是进队列的第一个动作');
});
