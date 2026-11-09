'use strict';

/**
 * e2e 必须**跑得起来**(2026-08-01)。
 *
 * 实况:整套 e2e 一条都跑不了,而且这状态已经持续到没人发现 —— 因为 package.json 里
 * 压根没有 e2e 的 npm 脚本,唯一的跑法是敲 `npx playwright test`,而那条路正好是坏的:
 *
 *   package.json 把 playwright 钉死 1.58.2,@playwright/test 是 ^1.60.0(装成 1.60.0)。
 *   npm 于是把 playwright@1.60.0 装成 @playwright/test 的**嵌套**依赖。
 *   `npx playwright` 解析到顶层 1.58.2 的 CLI,而 spec 文件 import 的 @playwright/test
 *   是 1.60.0(自带 1.60.0 runner)—— 两个 runner 实例,报
 *   「Playwright Test did not expect test() to be called here」,然后 "No tests found"。
 *
 * 文档红线里写着交付前要过 `npm test + build + e2e_gate`,而 e2e 这一环其实是空的。
 * 这条测试把它拉进 npm test:版本一旦再劈叉,这里先红,而不是等谁哪天手动跑才发现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const installedVersion = (name) => {
  const p = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
  return fs.existsSync(p) ? readJson(p).version : null;
};

test('⭐e2e 有明确的入口脚本,且不依赖 `npx playwright`(它会解析到另一个版本)', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const script = pkg.scripts?.['test:e2e'];
  assert.ok(script, 'package.json 缺 test:e2e —— 没有入口,坏了也没人会发现');
  assert.match(script, /@playwright\/test\/cli\.js/,
    'e2e 入口要直接指向 @playwright/test 自带的 CLI,和 spec 里 import 的是同一份');
  assert.doesNotMatch(script, /^npx playwright/,
    '`npx playwright` 解析到顶层 playwright 包的 CLI,可能与 @playwright/test 版本不一致');
});

// 2026-08-01 已定方向并落地:**向上对齐**,playwright 1.58.2 → 1.60.0,
// 配 `npx playwright install chromium` 下载 chromium-1223(112MB)。实跑 13 passed。
// 于是这条从 { todo } 变回硬闸 —— 再劈叉就直接把 npm test 拉红。
// 留个背景给后来人:劈叉的后果不是"某条用例挂",是两个 runner 实例互相不认,
// "did not expect test() to be called here" → No tests found → **整套 e2e 静默变 0 条**。
// 注:spec 本身走 playwright.config.js 的 channel:'chrome'(系统 Chrome),不吃 revision;
//     吃 revision 的是 scripts/e2e_gate.js 那条 chromium.launch()。
test('⭐playwright 与 @playwright/test 的版本必须对齐(劈叉=整套 e2e 跑不了)', () => {
  const test160 = installedVersion('@playwright/test');
  const standalone = installedVersion('playwright');
  if (!test160 || !standalone) return; // 没装依赖的环境(CI 冷启动前)不强求

  const minor = (v) => v.split('.').slice(0, 2).join('.');
  assert.equal(minor(standalone), minor(test160),
    `playwright(${standalone}) 与 @playwright/test(${test160}) 版本劈叉。`
    + '后果不是"某条用例挂",是**整套 e2e 一条都跑不起来**'
    + '(两个 runner 实例 → "did not expect test() to be called here" → No tests found)。'
    + '注意 scripts/e2e_gate.js 等 4 个脚本直接 require("playwright"),不能靠删依赖了事,'
    + '得把两个版本对齐。');
});

test('e2e 用例目录不为空(有入口但没用例,等于闸门开着)', () => {
  const dir = path.join(ROOT, 'frontend', 'e2e');
  assert.ok(fs.existsSync(dir), 'frontend/e2e 应存在');
  const specs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.spec.js')) specs.push(e.name);
    }
  };
  walk(dir);
  assert.ok(specs.length >= 5, `e2e 用例太少(${specs.length}),闸门形同虚设`);
});

// ── 0801 CI 事故长出来的第二道闸 ─────────────────────────────────────
// 那次的实际体验是:CI 跑 `npm test` **静默 18 分钟**,被 20 分钟 job timeout 杀掉,
// 日志里一条 "not ok" 都没有,只在最后留下 `Terminate orphan process: npm test`。
// 你拿到的信息量是零 —— 不知道是哪个文件、哪条用例、什么原因。
//
// node --test 默认**没有**用例超时,一个 await 不 settle 就能拖死整批。
// 加上 --test-timeout 之后,同样的挂死会变成一条指名道姓的失败。
// 这条闸盯着它别被人顺手删掉。
test('⭐npm test 必须带 --test-timeout(否则挂死=静默烧完 CI 时间,查不出是谁)', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const script = String(pkg.scripts?.test || '');
  const m = script.match(/--test-timeout=(\d+)/);
  assert.ok(m, `npm test 缺 --test-timeout。现在是:${script}`);
  const ms = Number(m[1]);
  // 上限:CI 的 job timeout 是 20 分钟,单条用例超时必须远小于它,
  // 否则先撞 job timeout,等于没加。
  assert.ok(ms <= 5 * 60 * 1000, `单条用例超时 ${ms}ms 太长,会先撞 CI 的 20 分钟 job timeout`);
  // 下限:本机最慢的用例(真子进程 + 4MB stdout)约 1.5 秒,给足余量;
  // 太短会让 CI 上偶发的慢机器误红。
  assert.ok(ms >= 30 * 1000, `单条用例超时 ${ms}ms 太短,慢机器上会误红`);
});

test('⭐CI 的 job timeout 要大于单条用例超时(否则用例超时报不出来就先被杀)', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(job, 'CI 应显式设 timeout-minutes');
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const perTest = Number(String(pkg.scripts?.test || '').match(/--test-timeout=(\d+)/)?.[1] || 0);
  assert.ok(Number(job[1]) * 60 * 1000 > perTest * 2,
    `CI job timeout ${job[1]} 分钟,单条用例超时 ${perTest}ms —— job 要留得下至少两条用例超时的余量`);
});

// ── 0801:CI 里「构建产物」类的闸必须在 npm test **之前**就有产物 ──────────
// tests/frontend_design_hard_rules.test.js 那条扫 dist CSS 的硬闸,在 dist 不存在时 t.skip。
// dist 被 .gitignore 忽略(0 个跟踪文件),而 CI 原来把 Frontend build 排在 Test **之后**,
// 于是那条闸在 CI 上每次都跳过 —— 只有本机(有历史构建产物)才真跑。
// 和 e2e 那次同一个形状:闸在,但永远不被触发。
test('⭐CI 里前端构建必须排在 npm test 之前(否则扫产物的闸每次都 skip)', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const buildAt = ci.indexOf('npm run build');
  const testAt = ci.indexOf('run: npm test');
  assert.ok(buildAt > 0, 'CI 应有前端构建步骤');
  assert.ok(testAt > 0, 'CI 应有 npm test 步骤');
  assert.ok(buildAt < testAt,
    'Frontend build 必须排在 npm test 之前 —— 否则 dist 还不存在,'
    + '扫构建产物的硬闸(frontend_design_hard_rules)会静默 skip,等于没有这道闸');
});

test('⭐那条扫产物的闸确实是「没产物就跳过」,所以顺序才要紧(判据别写在空气里)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'frontend_design_hard_rules.test.js'), 'utf8');
  assert.match(src, /existsSync\(DIST\)/, '它靠 DIST 是否存在决定跑不跑');
  assert.match(src, /t\.skip\(/, '不存在时是 skip —— skip 在汇总里不算失败,所以完全无声');
});

// ── 0801:卡住时要留下现场 ────────────────────────────────────────────
// CI 上交付导出测试会间歇性卡住(本地 1 秒 → CI 120 秒以上),而 node --test
// 杀掉超时文件时,**已完成但还在缓冲里的 TAP 输出会一起丢** —— 连"跑到第几条"都不可靠。
// tests/_stall_watchdog.mjs 在文件跑超阈值时把事件循环上还活着什么打到 stderr。
// 正常文件几秒就完,永远不触发(实测全量 75 秒、零输出)。
test('⭐npm test 必须挂上卡顿看门狗(否则下次卡住又是一次没现场的猜)', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const script = String(pkg.scripts?.test || '');
  assert.match(script, /--import=\.\/tests\/_stall_watchdog\.mjs/,
    `npm test 缺卡顿看门狗。现在是:${script}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'tests', '_stall_watchdog.mjs')),
    '看门狗文件不在了 —— 脚本里挂着一个不存在的 --import 会让整套测试起不来');
});

test('⭐看门狗自己不许拖住进程退出(它要是不 unref,就成了它在制造卡顿)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', '_stall_watchdog.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.match(code, /timer\.unref\(\)/, '看门狗的定时器必须 unref');
  assert.match(code, /getActiveResourcesInfo/,
    '要用 getActiveResourcesInfo —— _getActiveHandles 在 Node 22+ 不返回 Timeout,会得出"没泄漏"的错误结论');
});

// ── 0801 收口:e2e 终于**真的会被跑** ──────────────────────────────────
// 在此之前它是一道"存在但从不触发"的闸,三层挡着,每一层单独看都像小事:
//   ① package.json 没有入口脚本 → 只能手敲 npx playwright(而那条路正好是坏的);
//   ② playwright 与 @playwright/test 版本劈叉 → 整套一条都跑不起来;
//   ③ playwright.config 的 webServer 命令写死 `npm.cmd` —— **Windows 专有**,
//      Linux 上没这个命令,所以就算接进 CI 也起不来。
// 13 条用例本地全过、看着像有闸,实际没有任何自动化在跑它。
// ①② 今天上午修了,③ 和"接进 CI"是这一笔。下面把三层一起钉住。
test('⭐CI 必须真的跑 e2e(否则前面那些修复只是让它"能跑",不是"在跑")', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run test:e2e/, 'CI 里要有 e2e 步骤');
  assert.match(ci, /playwright install[^\n]*chromium/,
    'CI 上没有系统 Chrome,必须先装 playwright 自带的 chromium');
});

test('⭐webServer 命令不许写死 Windows 专有的 npm.cmd', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8');
  const code = cfg.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /process\.platform === 'win32'/,
    '要按平台分支 —— 写死 npm.cmd 等于 e2e 在 Linux 上永远起不来');
  assert.match(code, /'npm run build && npm run preview/,
    'Linux 分支要用裸 npm');
});

test('⭐channel 要能被环境变量切成"用自带 chromium"', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8');
  const code = cfg.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /PLAYWRIGHT_CHANNEL === '' \? undefined/,
    "空串要能表达'不指定 channel' —— 否则 CI 上会去找一个不存在的系统 Chrome");
});

// ── 自检:这套断言用的"剥注释再匹配"本身别失灵 ──────────────────────────
// 今天我在别的闸上踩过四次「空跑」:取段取到了参数解构、indexOf 找到别处的一对、
// 拿 markdown 的 ** 去匹配纯文本、变异脚本改了 0 字节还以为验红了。
// 每一次都是"断言在跑,但跑在一个空壳上"。所以每道闸都该有一条自检。
test('自检:剥注释后仍剩下能匹配的内容(否则上面全是空跑)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  const cfg = strip(fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8'));
  assert.ok(cfg.length > 300, `playwright.config 剥完只剩 ${cfg.length} 字符,剥法跑偏了`);
  assert.match(cfg, /webServer/, '剥注释不该把要查的东西也删掉');

  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes('npm test') && ci.includes('npm run lint'),
    'CI 文件读到的内容不对劲');

  // 反向对照:一段**不该匹配**的文本必须真的匹配不上,
  // 证明这些正则不是"什么都匹配"
  assert.doesNotMatch(strip('// PLAYWRIGHT_CHANNEL === \'\' ? undefined'),
    /PLAYWRIGHT_CHANNEL === '' \? undefined/,
    '写在注释里的不算数 —— 剥注释这一步必须真的在剥');
});
