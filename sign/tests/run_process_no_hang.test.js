'use strict';

/**
 * 子进程封装不许挂死(2026-08-01)。
 *
 * 这条闸是 CI 上一次真事故长出来的:
 *   `npm test` 在 ubuntu-latest 上**挂死 18 分钟**,被 20 分钟 timeout 杀掉,
 *   日志里一条 "not ok" 都没有 —— 纯静默。而同一份代码在 Windows 本机 2374 全过。
 *
 * 分叉的原因很具体:本机既没有 `zip` 也没有真 `python3`(WindowsApps 占位符),
 * 打包代码每次都在 ENOENT 上立刻返回,**主分支从来没被执行过**;
 * Linux CI 上 `zip` 真实存在,才第一次跑进去。
 * 换句话说:本地全绿只证明了回退分支是对的。
 *
 * 病灶本身与平台无关:spawn 默认三个 stdio 都是管道,管道缓冲约 64KB。
 * 子进程往 stdout 写超过这个量就**阻塞在 write 上**等人读;
 * 而两处拷贝(batch_customer_data_export_service.runProcess / export_routes.runOk)
 * 都不消费 stdout —— 子进程永不退出,'close' 永不触发,await 永久挂起。
 * 生产里这意味着:一次输出稍大的打包 = 那个 HTTP 请求永远不返回。
 *
 * 下面用真子进程实测,不是模拟。验红方式:把 lib/run_process 的
 * stdio 改回默认(去掉那行 stdio),第 1 条必挂 → 测试超时失败。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runProcess, runOk } = require('../lib/run_process');

const ROOT = path.join(__dirname, '..');
// 每条用例自己兜底,免得闸自己也挂死(那就又回到"静默 18 分钟"了)
const guard = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}:${ms}ms 没返回 —— 挂死了`)), ms);
    if (t.unref) t.unref();
  }),
]);

const writeStdout = (bytes) => [process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}));process.exit(0)`]];

test('⭐子进程狂吐 stdout 不能把调用方挂死(64KB 管道缓冲那道坎)', async () => {
  const [cmd, args] = writeStdout(4 * 1024 * 1024); // 4MB,远超任何管道缓冲
  const res = await guard(runProcess(cmd, args, {}), 15000, '4MB stdout');
  assert.equal(res.ran, true);
  assert.equal(res.status, 0, '子进程应正常退出,而不是卡在 write 上');
});

test('小输出与边界值同样正常(证明上一条不是靠"总是超时"蒙过去的)', async () => {
  for (const bytes of [0, 1024, 64 * 1024, 65 * 1024]) {
    const [cmd, args] = writeStdout(bytes);
    const res = await guard(runProcess(cmd, args, {}), 15000, `${bytes}B`);
    assert.equal(res.status, 0, `${bytes} 字节时应正常返回`);
  }
});

test('⭐子进程读 stdin 不能永久等待(stdin 必须是 ignore,不是没人写的管道)', async () => {
  // 这个子进程会尝试同步读 stdin 直到 EOF。stdin 若是空管道且无人关闭,它会永远等。
  const script = 'try{require("fs").readFileSync(0,"utf8")}catch(e){};process.exit(0)';
  const res = await guard(
    runProcess(process.execPath, ['-e', script], {}), 15000, 'read stdin',
  );
  assert.equal(res.ran, true);
  assert.equal(res.status, 0, '子进程读 stdin 应立刻拿到 EOF,而不是永久等输入');
});

test('stderr 仍然收得到(修挂死不能把错误原因一起丢了)', async () => {
  const script = 'process.stderr.write("boom-详情");process.exit(3)';
  const res = await guard(runProcess(process.execPath, ['-e', script], {}), 15000, 'stderr');
  assert.equal(res.status, 3);
  assert.match(res.stderr, /boom-详情/, 'stderr 内容要原样带回,失败原因靠它');
});

test('stderr 狂吐也不挂死,且有上限不吃爆内存', async () => {
  const script = 'process.stderr.write("e".repeat(4*1024*1024));process.exit(1)';
  const res = await guard(runProcess(process.execPath, ['-e', script], {}), 20000, '4MB stderr');
  assert.equal(res.status, 1);
  assert.ok(res.stderr.length <= 64 * 1024 + 8192,
    `stderr 应有上限保护,实际收了 ${res.stderr.length} 字节`);
});

test('命令不存在 → ran:false(调用方据此走回退,不能报成"失败")', async () => {
  const res = await guard(
    runProcess('这个命令肯定不存在-zzz', [], {}), 15000, 'ENOENT',
  );
  assert.equal(res.ran, false, 'ENOENT 必须回 ran:false —— zip 缺失时靠它回退到 python3/JSZip');
});

test('⭐卡死的子进程会被超时杀掉,而不是让调用方永久挂着', async () => {
  const script = 'setInterval(()=>{},1000)'; // 永不退出
  const started = Date.now();
  const res = await guard(
    runProcess(process.execPath, ['-e', script], { timeoutMs: 1500 }), 15000, 'timeout kill',
  );
  assert.equal(res.timedOut, true, '应标记超时');
  assert.ok(Date.now() - started < 10000, '应在超时后立刻返回,不是等到测试兜底');
  assert.match(res.stderr, /未结束/, '要给人看得懂的原因');
});

test('runOk 是同一份实现的薄封装(不许再各写一份)', async () => {
  assert.equal(await guard(runOk(process.execPath, ['-e', 'process.exit(0)'], {}), 15000, 'ok'), true);
  assert.equal(await guard(runOk(process.execPath, ['-e', 'process.exit(2)'], {}), 15000, 'fail'), false);
  assert.equal(await guard(runOk('这个命令肯定不存在-zzz', [], {}), 15000, 'enoent'), false);
});

test('⭐两个原始调用点都不许再自己 spawn(否则修了一处、另一处照挂)', () => {
  const files = [
    'services/batch_customer_data_export_service.js',
    'routes/monthly/export_routes.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /spawn\s*\(/, `${rel} 不许再直接 spawn,走 lib/run_process`);
    assert.match(code, /require\(['"][^'"]*lib\/run_process['"]\)/, `${rel} 要引 lib/run_process`);
  }
});

test('自检:lib/run_process 确实把 stdout 关掉了(闸别只测行为不测根因)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'run_process.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /stdio:\s*\['ignore',\s*'ignore',\s*'pipe'\]/,
    'stdin/stdout 必须是 ignore —— 这是不挂死的根因,不是可选优化');
});
