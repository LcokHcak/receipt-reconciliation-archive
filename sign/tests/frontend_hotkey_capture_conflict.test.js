'use strict';

/**
 * 「捕获阶段吃掉冒泡阶段」的键位冲突(2026-08-01)。
 *
 * 实况:审核台重拍选择器上印着角标「模糊 1」「缺 2」「其他 3」,
 * ReviewView 里也确实写了「选择器开着时 1/2/3 直选原因」(0727 反馈#10)。
 * 但那段是**死代码**,一次都没执行过:
 *
 *   FieldEditor 用 window.addEventListener('keydown', h, **true**)(捕获阶段),
 *   对 /^[1-9]$/ 一律 preventDefault + stopPropagation;
 *   ReviewView 用 window.addEventListener('keydown', h)(冒泡阶段)。
 *   同一个 window 上,捕获先于冒泡;捕获里 stopPropagation 之后,
 *   事件既到不了 target,也回不到 window 的冒泡监听。
 *
 * 实际后果不是"快捷键不好使":REVIEW_TIER1_TYPES 顺序是 护照/小票/百货,
 * 所以按「1」触发的是 selectTier1('passport') —— 把这张**小票改成护照**。
 * 该票若已读出票号/团号,会弹「改类型会把这些字段清空且无法恢复」,
 * 而一个刚按了「1」想标"模糊"的人,很可能把它当成重拍确认点掉。
 *
 * 这条测试直接用真 DOM 事件复现两个监听的先后关系 —— 扫源码扫不出这种事,
 * 两边的代码单看都是对的,错只在**它们同处一个 window 的不同阶段**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 最小 window 模拟:只实现捕获/冒泡两阶段与 stopPropagation,够复现这个机制。
function makeWindow() {
  const capture = [];
  const bubble = [];
  return {
    addEventListener(_type, fn, useCapture) {
      (useCapture === true ? capture : bubble).push(fn);
    },
    dispatch(key) {
      const ev = {
        key,
        _stopped: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this._stopped = true; },
        target: { tagName: 'DIV', isContentEditable: false },
      };
      for (const fn of capture) { fn(ev); if (ev._stopped) return ev; }
      for (const fn of bubble) { fn(ev); if (ev._stopped) return ev; }
      return ev;
    },
  };
}

test('⭐机制复现:同一 window 上捕获里 stopPropagation,冒泡监听收不到', () => {
  const w = makeWindow();
  const seen = [];
  w.addEventListener('keydown', (e) => {
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); seen.push('capture'); }
  }, true);
  w.addEventListener('keydown', () => { seen.push('bubble'); });

  w.dispatch('1');
  assert.deepEqual(seen, ['capture'],
    '捕获里 stopPropagation 之后冒泡必须收不到 —— 这正是重拍分键失效的机制');

  seen.length = 0;
  w.dispatch('R'); // 非数字键:捕获里那个分支不匹配,所以它连记都不记,只有冒泡收到
  assert.deepEqual(seen, ['bubble'], '不该被吞的键要能传到冒泡');
});

test('⭐FieldEditor 必须能被上层"整体让开",不是只跳过数字键', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'components', 'FieldEditor.vue'), 'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(code, /hotkeysSuspended:\s*\{/, 'FieldEditor 要有 hotkeysSuspended 属性');

  // 让开必须发生在 handler **最前面**:晚一步就已经 stopPropagation 了
  const fn = code.slice(code.indexOf('function handleHotkey'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const suspendAt = body.indexOf('props.hotkeysSuspended');
  const stopAt = body.indexOf('stopPropagation');
  assert.ok(suspendAt > 0, 'handleHotkey 里要读 props.hotkeysSuspended');
  assert.ok(stopAt < 0 || suspendAt < stopAt,
    '让开的判断必须排在 stopPropagation 之前,否则事件已经被吞了');
});

test('⭐ReviewView 必须在重拍选择器打开时把这个开关传下去', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'views', 'ReviewView.vue'), 'utf8');
  assert.match(src, /:hotkeys-suspended="rephotoPickerOpen"/,
    '选择器开着时要让 FieldEditor 让开,否则 1/2/3 还是被吃掉');
});

test('⭐界面上印了角标就必须真能用(角标与处理分支要对得上)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'views', 'ReviewView.vue'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 处理分支还在
  assert.match(code, /rephotoPickerOpen\.value && \['1', '2', '3'\]\.includes\(e\.key\)/,
    '重拍分键的处理分支不许被删 —— 界面上印着角标');
  // 且原因表恰好三条,和角标一一对应
  const { REPHOTO_REASONS } = require('../lib/rephoto_reasons');
  assert.equal(REPHOTO_REASONS.length, 3,
    `角标写死了 1/2/3 三个键,原因表却有 ${REPHOTO_REASONS.length} 条 —— 多出来的按不到`);
});

test('自检:去掉 suspend 判断后,机制复现那条仍然成立(闸不是靠它蒙的)', () => {
  // 这条防止有人把上面的机制复现改成"总是通过"
  const w = makeWindow();
  let bubbled = false;
  w.addEventListener('keydown', () => { /* 什么都不做,不吞 */ }, true);
  w.addEventListener('keydown', () => { bubbled = true; });
  w.dispatch('1');
  assert.equal(bubbled, true, '捕获里不吞的话,冒泡必须能收到 —— 否则模拟本身是坏的');
});
