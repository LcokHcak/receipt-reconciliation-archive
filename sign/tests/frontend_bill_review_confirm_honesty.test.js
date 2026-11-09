'use strict';

/**
 * 账单核对页的「本次隐去」不许再自称"已核对"(2026-08-01)。
 *
 * 原状:按钮叫「一键确认」,点了提示「已标记客户 X 的差异为已核对」。
 * 而它的**全部**实现是:从本地 rows 里 filter 掉这一行、total 减 1、写提示。
 * 零 API 调用、零落库。审核员在「小票无账单」tab 逐个点到 0,认为这批核完了;
 * 刷新页面或切一次 tab(loadTab 重新拉 count-mismatch)全部原样回来 ——
 * 他做过的判断**一点痕迹都没有**,只能从头再判一遍。
 *
 * 为什么不顺手做成真落库(而是先把话说对):
 *   「数量不一致」是台账 ⟂ 账单**实时算出来的派生结果**,端点只有 GET。
 *   要让"已核对"留下来,得新加一层人工标记 —— 而未收侧已经有
 *   unreceived_resolution(link/delay/void)+ unreceived_state 两张表,
 *   0026 迁移抬头明确写着:「『无需补』人工豁免不在此表 —— P3 决策它与
 *   unreceived_resolution 怎么合流,**避免两套人工标记裂脑**」。
 *   也就是说"再加一套标记"这件事,代码里已经挂着一个待拍板的决策;
 *   在那之前擅自发明第二套,正是它警告的那个坑。
 *
 * 所以这条闸守的是:**动作可以留,话必须说对**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'frontend', 'src', 'views', 'v2', 'BillReviewView.vue');
const ROW = path.join(ROOT, 'frontend', 'src', 'components', 'v2', 'CountMismatchRow.vue');

const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('⭐不许再说"已核对" —— 它没有核对任何东西', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.doesNotMatch(code, /差异为已核对/,
    '这句话承诺了一个不存在的持久化状态');
});

test('⭐提示必须点破"没有保存"', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.match(code, /仅本次浏览/, '要说清作用范围');
  assert.match(code, /不保存「已核对」状态/,
    '必须明说系统不记这件事 —— 否则人还是会以为点过就算数');
});

test('⭐按钮名要说它真正做的事', () => {
  const code = stripComments(fs.readFileSync(ROW, 'utf8'));
  assert.doesNotMatch(code, />一键确认</, '「确认」会让人以为落库了');
  assert.match(code, /本次隐去/, '名字要等于行为');
  assert.match(code, /title="[^"]*不落库/, '悬停也要给一遍,按钮字数装不下全部信息');
});

test('⭐隐去了多少行要摆在明面上(否则数字看起来会自己动)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /hiddenThisSession/, '要有计数');
  assert.match(src, /本次已隐去 \{\{ hiddenThisSession \}\} 行/,
    '要显示出来 —— 列表数字变小、刷新又变回去,不说明就是"数字自己在动"');
});

test('⭐行为本身没被改坏(隐去仍然是纯前端过滤,没有偷偷加请求)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  const start = src.indexOf('function confirmCountMismatch');
  assert.ok(start > 0, '找不到该函数,取段方式失效');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.doesNotMatch(body, /api\.(get|post|patch|put|delete)/,
    '这一版**刻意**不落库:要落库得先拍板它与 unreceived_resolution 怎么合流,'
    + '别在这里偷偷加第二套人工标记(0026 迁移抬头警告过"裂脑")');
  assert.match(body, /page\.rows = page\.rows\.filter/, '过滤动作保留 —— 长列表里它确实有用');
});

test('自检:去掉注释的函数确实能取到(否则上一条是空跑)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  const start = src.indexOf('function confirmCountMismatch');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.length > 80, `取到的函数体太短(${body.length} 字符),取段方式可能失效`);
  assert.match(body, /hiddenThisSession/, '取到的应该是改过之后的那一版');
});
