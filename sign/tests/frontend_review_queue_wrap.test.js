'use strict';

/**
 * 「本批次已处理完」不许在前面还有待办时说出口(2026-08-01)。
 *
 * 病灶:moveAfterFlowAction 只往**后**扫
 *   findNextInQueue(taskId, +1) || findAdjacentTaskId(taskId, +1)
 * 扫不到就直接判 'exhausted' 并喊「当前队列已完成 / 本批次已处理完」,
 * 完全不看当前位置**之前**还有多少待办 —— 而 reviewFlowStats.pending
 * 就显示在同一屏的头部。
 *
 * 真实场景:审核员为了先处理某个催得急的客户,点到队列靠后的一组审完,
 * 界面告诉他「本批次已处理完」,右上角同时写着「待处理 37」;
 * 文案还把他往「切换筛选/批次」引 —— 越走越远,前面那些整批漏审。
 * 标重拍那条路(markRephotoAndNext)的提示不会被后续消息覆盖,
 * 留在屏幕上的就是这句假话。
 *
 * 注意这与已修的「关了自动下一组」是**两个不同的成因**:那条现在返回 'stopped'。
 * 这条新增 'wrapped':后面没有了但前面还有 → 跳回去,并说清是往回跳的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'frontend', 'src', 'views', 'ReviewView.vue');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// 取函数体。⚠️ 不能简单地找 `function name` 之后的第一个 `{` ——
// 这些函数的参数带解构(`function f(taskId, { pendingOnly = true } = {})`),
// 第一个 `{` 是**参数**的,那样取到的"函数体"是 `{ pendingOnly = true }`,
// 后面所有断言都在一个 20 字符的串上跑,全是空跑。(我第一版就是这么写的,
// 靠自检那条才发现。)所以先走完参数列表的圆括号,再找花括号。
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start > 0, `找不到 ${name} —— 取段方式失效了`);
  const parenOpen = src.indexOf('(', start);
  let pd = 0;
  let bodyStart = -1;
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1;
    else if (src[i] === ')') {
      pd -= 1;
      if (pd === 0) { bodyStart = src.indexOf('{', i); break; }
    }
  }
  assert.ok(bodyStart > 0, `${name} 的参数列表没走完`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`${name} 括号不配对`);
}

test('⭐往后扫不到时必须回头再扫一遍,才能说"队列已完成"', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const body = functionBody(code, 'moveAfterFlowAction');

  // 必须有反向扫描
  assert.match(body, /findNextInQueue\([^)]*,\s*-1/,
    '要往回扫一遍 —— 后面没有不等于队列空了');
  // 且反向扫描要排在 exhausted 之前
  const backAt = body.search(/findNextInQueue\([^)]*,\s*-1/);
  const exhaustedAt = body.indexOf("return 'exhausted'");
  assert.ok(backAt > 0 && exhaustedAt > 0 && backAt < exhaustedAt,
    '回头扫必须排在判定 exhausted 之前,否则等于没扫');
  assert.match(body, /return 'wrapped'/, '回头找到了要有独立的结果,不能混进 moved');
});

test('⭐"往回跳"要说清楚,不能让人以为界面在乱跳', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const tail = functionBody(code, 'afterFlowTail');
  assert.match(tail, /wrapped/, 'afterFlowTail 要认得这种结果');
  assert.match(tail, /跳回前面/,
    '文案要点明是往回跳的 —— 队列位置突然变了而不解释,人会以为出错了');
});

test('⭐所有调用点统一走 afterFlowTail,不许再各拼一份三态判断', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  // 除了 afterFlowTail 自己,别处不该再出现对 outcome 的分支判断
  const tailBody = functionBody(code, 'afterFlowTail');
  const rest = code.replace(tailBody, '');
  assert.doesNotMatch(rest, /outcome === 'stopped'/,
    "调用点不许自己判 'stopped' —— 各拼一份的后果:新增一种结果时,"
    + '它会静默掉进 else 那支,把新情况说成旧情况(本次 wrapped 就会被说成"已处理完")');
  assert.doesNotMatch(rest, /outcome === 'moved'\s*\n?\s*\?/,
    "调用点不许自己判 'moved' 再拼文案");
});

test('⭐历史教训还在代码里(各写一份已经炸过一次)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /ReferenceError|no-undef/,
    '要留着那次记录:同函数里改了一支、漏了另一支,`moved` 变量都不存在了,'
    + '走到就 ReferenceError —— 正是"各拼一份"的代价');
});

test('自检:functionBody 取到的是真函数体(否则前面几条是空跑)', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const body = functionBody(code, 'moveAfterFlowAction');
  assert.ok(body.length > 200, `取到的函数体太短(${body.length} 字符)`);
  assert.match(body, /autoAdvance/, '取到的应该是那个真函数');
  assert.equal((body.match(/\{/g) || []).length, (body.match(/\}/g) || []).length,
    '括号要配平,否则取段跑偏了');
});
