/**
 * 测试进程看门狗(2026-08-01)。
 *
 * 起因:CI(Linux)上交付导出测试会**间歇性**卡住 —— 本地 1.0 秒的文件,
 * 在 CI 上吃掉 120 秒以上。两次失败各挂不同文件,中间两次同样文件又是过的。
 * 已排除:不是打包子进程挂住(attempt/result 日志成对配平)、不是超时定太紧、
 * 不是计时起点问题(本地 --test-timeout=5000 跑全量 0 个超时)、
 * 不是机器慢(CI 整体只慢 2 倍,解释不了 1 秒→120 秒)。
 *
 * 卡住时最难受的是**拿不到任何信息**:node --test 把超时文件杀掉,
 * 它已完成但还在缓冲里的 TAP 输出会一起丢,所以连"跑到第几条"都不可靠。
 *
 * 这个看门狗只做一件事:某个测试文件跑超过阈值时,把**当时事件循环上还活着什么**
 * 打到 stderr(node --test 会把子进程 stderr 原样转成 `# ` 注释进日志)。
 * 下一次发作就是一份现场,而不是又一轮猜。
 *
 * 设计约束:
 * - 定时器 unref —— 它自己绝不能成为"拖住进程退出"的东西(今天刚修过两个那样的)。
 * - 正常文件几秒就跑完,永远不会触发,零成本。
 * - 用 process.getActiveResourcesInfo() 而不是 _getActiveHandles():
 *   后者在 Node 22+ **不返回 Timeout**,拿它排查会得出"没泄漏"的错误结论。
 */

const THRESHOLD_MS = Number(process.env.SIGN_TEST_STALL_WATCHDOG_MS || 60_000);
const started = Date.now();

let fired = 0;
const tick = () => {
  fired += 1;
  const seconds = Math.round((Date.now() - started) / 1000);
  const resources = process.getActiveResourcesInfo();
  // 汇总成 {类型: 个数},比一长串重复项好读
  const counts = resources.reduce((acc, r) => {
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {});
  const mem = process.memoryUsage();
  process.stderr.write(
    `[stall-watchdog] 本文件已跑 ${seconds}s(第 ${fired} 次报告)\n`
    + `[stall-watchdog]   活跃资源: ${JSON.stringify(counts)}\n`
    + `[stall-watchdog]   rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB\n`
    + `[stall-watchdog]   文件: ${process.argv[1] || '(未知)'}\n`,
  );
  // 只报三次就停:再多也是同样的内容,徒增噪音
  if (fired >= 3) clearInterval(timer);
};

const timer = setInterval(tick, THRESHOLD_MS);
if (typeof timer.unref === 'function') timer.unref();
