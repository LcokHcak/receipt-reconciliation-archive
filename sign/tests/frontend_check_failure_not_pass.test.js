'use strict';

/**
 * 「检查没跑成」不许显示成「检查通过」(2026-08-01)。
 *
 * 病灶:配置台的模式冲突检查,catch 分支是
 *   `catch { conflictRows.value = []; conflictHard.value = 0 }`
 * 而模板里 `v-else` 看的就是"数组空不空" → 渲染出
 *   「审核勾选都能供上导出要的字段,无冲突。」
 *
 * 于是接口 500、断网、权限不足,**全都显示成"无冲突"**。
 * 这里是管理员判断"这套配置能不能发"的地方 ——
 * **把没查说成没问题,是最危险的一类假话**:它比报错更糟,因为报错至少会让人再看一眼。
 *
 * 与之同源、但**不在这一笔修**的是:内置计划被三处短路,根本不参与检查,
 * 却同样落到这句"无冲突"上(待拍板 A3)。那条要改行为,需要你先定
 * "内置计划之间算不算冲突";这条只是把"没查成"从"没问题"里分出来,不需要拍板。
 *
 * 这条闸守的是**三态**:查出问题 / 查了没事 / 没查成。少一态就会有一种情况被冒充。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'frontend', 'src', 'views', 'ConfigConsoleView.vue');

const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('⭐冲突检查失败不许被吞成空数组', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const at = code.indexOf('async function loadConflicts');
  assert.ok(at > 0, '找不到 loadConflicts');
  const body = code.slice(at, code.indexOf('\n}', at));

  assert.doesNotMatch(body, /catch\s*\{\s*conflictRows\.value = \[\];\s*conflictHard\.value = 0\s*\}/,
    'catch 里不许只把数组清空就完事 —— 空数组会被渲染成"无冲突"');
  assert.match(body, /catch \(error\)/, '要接住错误');
  assert.match(body, /conflictError\.value = /, '要把"没查成"记下来');
});

test('⭐界面必须是三态:查出问题 / 查了没事 / 没查成', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  // 有问题
  assert.match(src, /v-if="conflictRows\.length"/, '有冲突要列出来');
  // 没查成 —— 必须排在"无冲突"**之前**,否则永远轮不到它
  const errAt = src.indexOf('v-else-if="conflictError"');
  const okAt = src.indexOf('无冲突。');
  assert.ok(errAt > 0, '缺"没查成"这一态');
  assert.ok(errAt < okAt, '"没查成"必须排在"无冲突"之前,否则被 v-else 吃掉');
});

test('⭐"没查成"的话要说清它不等于没有冲突', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  const at = src.indexOf('v-else-if="conflictError"');
  const block = src.slice(at, at + 400);
  assert.match(block, /没跑成/, '要说清是"没跑成"');
  // 模板里是纯文本,别拿 markdown 的 ** 去匹配(我第一版就这么写,断言凭空挂)
  assert.ok(block.includes('不等于') && block.includes('没有冲突'),
    '必须点破"这不等于没有冲突" —— 否则人看到一句错误提示,'
    + `还是会当成"那大概没事"就发版了。实际:${block.slice(0, 200)}`);
});

test('⭐用统一的人话口径,不许原样吐 axios 英文', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.match(code, /humanErrorMessage\(error, '冲突检查没跑成'\)/,
    '走 lib/errorMessage 的统一口径:后端有中文就用中文,'
    + '没有(断网/超时/网关)就给人话,不吐 Network Error 这种');
});

test('自检:取段真的取到了 loadConflicts(否则第一条是空跑)', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const at = code.indexOf('async function loadConflicts');
  const body = code.slice(at, code.indexOf('\n}', at));
  assert.ok(body.length > 150, `取到的函数体太短(${body.length} 字符)`);
  assert.match(body, /fetchModeConflicts/, '取到的应该是那个真函数');
});
