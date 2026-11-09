'use strict';

/**
 * 承诺过的事没发生要说话;计数要说清数的是什么(2026-08-01)。
 *
 * 两条都来自同一次文案排查,病根也一样:**界面说的和实际发生的对不上**。
 *
 * ① 补小票:确认框白纸黑字承诺三件事 ——
 *      「并自动进入画框态 / 在整张原图上框出 / 松手后系统会按框重读票面字段」
 *    而 enterDrawMode() 在后端判"这条不能画"时返回 false 什么都不做,
 *    调用方**不看返回值**,代码注释写着「进不去就静默算了」。
 *    进不去的三种真实成因(copyOriginalIntoBatch 返回 null):
 *    回溯不到 _original 兄弟 / 客户库原图已被清理或重传 / 复制失败(磁盘满、权限)。
 *    三种都不是操作员能预判的 —— 他只会以为自己点错了、或系统卡了,
 *    然后对着一条空白记录手填一遍本来能自动读出来的东西(正是 P2-b 要省掉的那步)。
 *
 * ② 交付护栏条的「本批共 N 条」:v-if 只判 blockedImageCount > 1,
 *    却挂在**整条** bar 上;而 bar 在 action==='crop' 时显示的是
 *    「交付时按框裁」(正常路径、灰底)。于是站在一张"会被裁"的图上读到
 *    「本批共 2 条」,自然理解成"本批有 2 张要按框裁,不用管" ——
 *    实际那 2 条是**进不了包**的图,而且此时条子是灰的、不是 block 的红橙,
 *    提示强度还降了一级。等交付包出来才发现少图。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'frontend', 'src', 'views', 'ReviewView.vue');
const VIEWER = path.join(ROOT, 'frontend', 'src', 'components', 'ImageViewer.vue');

const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('⭐enterDrawMode 的返回值必须被看(它返回 false 是有意义的)', () => {
  const viewer = stripComments(fs.readFileSync(VIEWER, 'utf8'));
  assert.match(viewer, /if \(!canDrawBox\.value\.ok\) return false/,
    '前提:这个函数确实会返回 false 表示"没进去"');

  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.doesNotMatch(code, /^\s*imageViewerRef\.value\?\.enterDrawMode\?\.\(\)\s*$/m,
    '不许丢掉返回值 —— 丢了就没法知道承诺有没有兑现');
  assert.match(code, /const entered = imageViewerRef\.value\?\.enterDrawMode/,
    '要接住返回值');
  assert.match(code, /if \(entered === false\)/, '要对"没进去"这条路做处理');
});

test('⭐没进画框态时要说清原因和替代做法', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  const at = code.indexOf('if (entered === false)');
  assert.ok(at > 0, '找不到那条分支');
  const branch = code.slice(at, at + 600);
  assert.match(branch, /canDrawBox\?\.error/,
    '后端已经给了人话理由,用它,别另编一套(两套话术=两个读者)');
  assert.match(branch, /票已经补上了/,
    '要先说主诉求成了 —— 否则人以为整个动作失败了,会重复点');
  assert.match(branch, /手填|按店重切/,
    '要给下一步做什么;只说"失败了"等于把人晾在那');
});

test('⭐「本批共 N 条」只能在 block 态出现', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /selectedDeliveryPlan\.action === 'block' && blockedImageCount > 1/,
    "计数数的是 block,就只能在 block 态显示 —— 挂在 crop 态上是把两件事说成一件");
});

test('⭐计数要把"数的是什么"写进句子(光有数字必被误读)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /本批共 \{\{ blockedImageCount \}\} 张进不了包/,
    '「本批共 2 条」没主语 —— 站在"会被裁"的图上读它,会理解成"2 张要裁"');
});

test('⭐计数的口径本身没变(这次修的是显示时机与措辞,不是重新定义它)', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.match(code, /deliveryImagePlan\?\.action === 'block'\).length/,
    'blockedImageCount 仍然只数 block —— 它和「去第一条」跳转的口径必须一致');
  assert.match(code, /function gotoFirstBlockedImage/, '「去第一条」还在');
});

test('自检:strip 之后确实还剩下能匹配的东西(否则以上都是空跑)', () => {
  const code = stripComments(fs.readFileSync(VIEW, 'utf8'));
  assert.ok(code.length > 10000, `strip 之后只剩 ${code.length} 字符,处理跑偏了`);
  assert.match(code, /blockedImageCount/, 'strip 不该把要查的东西也删掉');
});
