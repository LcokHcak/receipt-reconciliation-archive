'use strict';

/**
 * 测试进程里 require logger 不许留下 worker 线程(2026-08-01)。
 *
 * 这是 #55「CI 间歇性挂死」的**真因**,查了大半天:
 *
 *   pino 一旦配了 transport(pino-pretty 或 pino/file 都算),就会起一个
 *   **worker 线程**(thread-stream)。那个线程把进程钉在事件循环上 ——
 *   测试文件里的用例早跑完了,进程就是不退出,node --test 干等到超时把它杀掉。
 *
 * 症状极难认:
 *   · 日志里**一条 not ok 都没有**,只是某个文件静默烧掉 120 秒;
 *   · 间歇发作(worker 启动与主线程结束之间有竞态,赢了就正常退);
 *   · **每次换一个文件**(先是 mode_delivery,后是 lotte_dept)——
 *     于是一直被往"那个测试有问题"的方向带。
 * 我为此排除过:打包子进程挂住(attempt/result 日志成对配平)、超时定太紧
 * (本地这两个文件 1.0/1.3 秒)、计时起点(本地 5 秒超时跑全量 0 个超时)、
 * 机器慢(CI 整体只慢 2 倍)。全不是。
 *
 * 最后是靠 tests/_stall_watchdog.mjs 打出的现场认出来的:
 *   活跃资源: {"MessagePort":1,"Timeout":1}
 *   文件: .../node_modules/thread-stream/...      ← 根本不是我们的测试文件
 * MessagePort 就是 worker 通道,thread-stream 就是 pino 的写线程。
 *
 * 修法:测试进程(node 自设 NODE_TEST_CONTEXT)一律不配 transport,
 * 直接同步写 —— 测试不需要彩色日志,也不需要写日志文件。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// 在**干净子进程**里量:本测试进程自己有一堆无关句柄,在这里数不准。
function activeAfterRequire({ testContext }) {
  const code = `
    require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))});
    setImmediate(() => {
      process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()));
      process.exit(0);
    });`;
  const env = { ...process.env };
  if (testContext) env.NODE_TEST_CONTEXT = 'child-v8';
  else delete env.NODE_TEST_CONTEXT;
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env,
  });
  return JSON.parse(out.slice(out.lastIndexOf('[')));
}

test('⭐测试进程里 require logger 不许留下 worker(MessagePort)', () => {
  const res = activeAfterRequire({ testContext: true });
  assert.ok(!res.includes('MessagePort'),
    `require logger 之后还挂着 ${JSON.stringify(res)} —— `
    + 'MessagePort = pino transport 的 worker 线程,它会把测试进程钉住不退出,'
    + '表现为"某个文件静默烧满超时",而日志里一条 not ok 都没有');
});

test('⭐进程能立刻退出(上一条只看清单,这条量真实墙钟)', () => {
  const started = Date.now();
  execFileSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))});`,
  ], { cwd: ROOT, timeout: 30000, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  const ms = Date.now() - started;
  assert.ok(ms < 10000, `进程等了 ${ms}ms 才退出 —— 还有东西挂在事件循环上`);
});

test('自检:非测试进程里 transport 仍然生效(别把生产日志一起关了)', () => {
  // 反向对照。这条同时证明上面两条不是"探针本身看不见 worker"蒙过去的。
  const res = activeAfterRequire({ testContext: false });
  assert.ok(res.includes('MessagePort'),
    '非测试环境应该仍然起 transport worker(彩色日志/写文件靠它);'
    + `实际 ${JSON.stringify(res)} —— 若这里也没有,说明 transport 被整个关掉了,`
    + '生产日志会退回裸 stdout,那是另一个问题');
});

test('⭐判据用的是 node 自设的标记,不是我们自己约定的环境变量', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'logger.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /process\.env\.NODE_TEST_CONTEXT/,
    '要用 node --test 自己设的 NODE_TEST_CONTEXT —— '
    + '自定义变量需要每个入口都记得传,漏一个就退回挂死');
  assert.match(code, /transport: isNodeTest \? undefined :/,
    '测试里必须整个不给 transport(给了就有 worker,不管指向哪)');
});
