'use strict';

/**
 * 「不许有东西拖住进程退出 / 掀翻进程」(2026-08-01)。
 *
 * 这三条都是 0801 CI 那次静默挂死之后顺藤摸出来的,共同点是**都不会报错**:
 * 没有失败、没有告警、日志里一个字都没有,只是慢或者只是死。
 *
 * ① lib/stage_progress_tracker 的 60 秒清理定时器没 unref。
 *    跑过**一次** stage 就留一个活定时器,于是三个测试文件各自
 *    「用例跑 1.2 秒 + 空转 60 秒」。实测墙钟 62/61/62 秒 → 修完 1/1/2 秒。
 *    白烧的 3 分钟里一个字都不输出 —— 和"挂死"在日志上长得一模一样。
 *
 * ② lib/graceful_shutdown 的 drain 超时定时器只在**输掉**竞速时才有意义,
 *    赢了从不 clear,继续活到 10 秒到期。
 *
 * ③ lib/python_process_pool 的 spawn 没挂 'error' 监听。
 *    ChildProcess 是 EventEmitter,没人听 'error' 就直接抛 → uncaughtException
 *    → graceful_shutdown 接成「整个服务退出」。python 路径写错的后果因此不是
 *    "这次识别失败",而是**全服务崩 + PM2 重启循环**。
 *
 * 排查这类问题有个坑值得记下来:Node 22+ 的 process._getActiveHandles()
 * **不返回 Timeout**(实测 handles=0),靠它会得出"没泄漏"的错误结论;
 * 要用 process.getActiveResourcesInfo()。而 --test-timeout 也管不了这一类 ——
 * 它约束单条用例的执行时长,不约束"最后一条用例结束"到"子进程退出"之间的空转。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 在**干净的子进程**里跑一段代码,回报它自己观察到的活资源。
// 必须开子进程:本测试进程自己有一堆无关的活句柄,在这里数是数不准的。
function activeResourcesAfter(code) {
  const script = `${code}
    // 让本 tick 的事件排完,再看还剩什么
    setImmediate(() => {
      process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()));
      process.exit(0);
    });`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  return JSON.parse(out.slice(out.lastIndexOf('[')));
}

test('⭐stage 进度清理定时器不许拖住进程(实测代价:三个测试文件白烧 3 分钟)', () => {
  const res = activeResourcesAfter(`
    const m = require('./lib/stage_progress_tracker');
    const tr = m.tracker || m.stageProgressTracker || m;
    tr.start({ workspaceKey: 'w', stage: 'merge' });
    tr.complete({ workspaceKey: 'w', stage: 'merge', stats: {} });
  `);
  assert.ok(!res.includes('Timeout'),
    `跑完一个 stage 后还剩活定时器 ${JSON.stringify(res)} —— 会让进程空转到它到期为止。`
    + '清理定时器只是丢内存快照,必须 unref()。');
});

test('⭐进程真的能立刻退出(上一条只看资源清单,这条量真实墙钟)', () => {
  const started = Date.now();
  execFileSync(process.execPath, ['-e', `
    const m = require('./lib/stage_progress_tracker');
    const tr = m.tracker || m.stageProgressTracker || m;
    tr.start({ workspaceKey: 'w', stage: 'merge' });
    tr.complete({ workspaceKey: 'w', stage: 'merge', stats: {} });
  `], { cwd: ROOT, timeout: 30000 });
  const ms = Date.now() - started;
  // 清理定时器是 60 秒;只要还挂着,这里就会等满 60 秒(或被 timeout 打断)。
  assert.ok(ms < 15000, `进程等了 ${ms}ms 才退出 —— 说明还有东西挂在事件循环上`);
});

test('⭐graceful_shutdown 的 drain 超时定时器,赢了竞速也要收摊——但不许 unref', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'lib', 'graceful_shutdown.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /finally\s*\{[\s\S]{0,200}clearTimeout\(timer\)/,
    'drain 赢了竞速时也要 clearTimeout —— 原来只有输的那条路才管超时定时器');

  // 这条断言是被 CI 打回来才写对的:我第一版让它 unref,CI 报
  // 「Promise resolution is still pending but the event loop has already resolved」。
  // 因为这个定时器承载的是**活性保证**(drain 卡住也要让关机继续),
  // unref 之后若它是事件循环里唯一活着的东西,进程先退出、超时永不触发,
  // race 两边都不 settle —— 兜底把自己兜没了。
  // 与之相对,stage_progress_tracker 那个到期只是丢内存快照,unref 才是对的。
  assert.doesNotMatch(code, /timer\.unref\(\)/,
    '兜底/超时类定时器不许 unref:它到期要做的事是"必须发生"的');
});

test('两类定时器的判据要写在代码里,别只活在这次的记忆里', () => {
  const gs = require('node:fs').readFileSync(path.join(ROOT, 'lib', 'graceful_shutdown.js'), 'utf8');
  // 只查"有没有把理由留下",不查具体措辞——措辞会改,理由不该丢
  assert.ok(gs.includes('不能') && gs.includes('unref'),
    'graceful_shutdown 里要留下"为什么这个不能 unref",否则下一个人还会照着另一处的写法加回来');
  const sp = require('node:fs').readFileSync(path.join(ROOT, 'lib', 'stage_progress_tracker.js'), 'utf8');
  assert.ok(sp.includes('unref'), 'stage_progress_tracker 里要留下"为什么这个该 unref"');
});

test('⭐python worker 起不来只能失败这一次,不许掀翻整个服务', () => {
  // 在子进程里真的构造一个指向不存在解释器的 worker。
  // 修之前:ChildProcess emit 'error' 没人听 → 抛 → uncaughtException;
  // 而生产里 graceful_shutdown 会把 uncaughtException 变成"整个服务退出"。
  const out = execFileSync(process.execPath, ['-e', `
    let uncaught = null;
    process.on('uncaughtException', (e) => { uncaught = e.code || e.message; });
    const m = require('./lib/python_process_pool');
    const C = m.PythonWorkerProcess
      || Object.values(m).find((v) => typeof v === 'function' && /Worker/.test(v.name));
    if (!C) { process.stdout.write('NO_CLASS'); process.exit(0); }
    try {
      new C({ id: 't', pythonExe: '肯定不存在的解释器-zzz', workerScriptPath: 'x.py' });
    } catch (e) {
      process.stdout.write('THREW_SYNC:' + (e.code || e.message)); process.exit(0);
    }
    setTimeout(() => {
      process.stdout.write(uncaught ? 'UNCAUGHT:' + uncaught : 'HANDLED');
      process.exit(0);
    }, 1200);
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });

  assert.notEqual(out.trim(), 'NO_CLASS', '拿不到 worker 类的话这条闸等于没有');
  assert.ok(!out.startsWith('UNCAUGHT'),
    `spawn 失败冒成了 uncaughtException(${out})。ChildProcess 是 EventEmitter,`
    + "必须挂 'error' 监听,否则 graceful_shutdown 会把它变成全服务退出 + PM2 重启循环。");
  assert.equal(out.trim(), 'HANDLED', `期望被 'error' 监听接住,实际:${out}`);
});

test('自检:这套探针确实分得清"有定时器"和"没定时器"', () => {
  // 正对照:故意留一个不 unref 的定时器,必须被看见
  const dirty = activeResourcesAfter("setTimeout(() => {}, 60000);");
  assert.ok(dirty.includes('Timeout'), '探针连明摆着的定时器都看不见,那前面几条全是假绿');
  // 负对照:unref 过的不该算
  const clean = activeResourcesAfter("const t = setTimeout(() => {}, 60000); t.unref();");
  assert.ok(!clean.includes('Timeout'), 'unref 过的定时器不该被算成拖住进程');
});
