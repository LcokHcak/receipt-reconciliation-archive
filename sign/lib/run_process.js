'use strict';

/**
 * 跑一个子进程,**不会挂死**(2026-08-01)。
 *
 * 为什么单独成文件:这段逻辑原来有两份拷贝
 * (services/batch_customer_data_export_service.js 的 runProcess、
 *  routes/monthly/export_routes.js 的 runOk),两份都带同一个死锁:
 *
 *   spawn 默认 stdio 全是管道。管道缓冲约 64KB。
 *   子进程往 stdout 写超过这个量时会**阻塞在 write 上**等人来读;
 *   而我们只监听了 stderr,stdout 永远没人读 → 子进程永不退出
 *   → 'close' 永不触发 → await 永久挂起。整个请求/整个测试进程就停在那里。
 *
 * 实测(scripts/oneoff 探针,已删):stdout 1KB ✅ / 64KB ✅ / 1MB ❌ 永不返回。
 *
 * 这不是理论风险:CI 上 `npm test` 挂死 18 分钟被 20 分钟 timeout 杀掉,
 * 日志里一条 "not ok" 都没有 —— 而本机 Windows 因为既没有 `zip` 也没有真 `python3`,
 * runProcess 每次都在 ENOENT 上快速返回,**打包这段代码在本机从未真正执行过**。
 * 也就是说:本地全绿只证明了回退分支是对的。
 *
 * 三条对策,缺一不可:
 *   1. stdin 给 'ignore' —— 子进程若读 stdin(zip 某些交互场景)不会永久等输入;
 *   2. stdout 显式消费(默认 'ignore' 直接不建管道,想收就 resume 掉);
 *   3. 加超时 + kill 兜底 —— 上面两条都防不住"子进程自己卡住"(磁盘/NFS/等锁)。
 */

const { spawn } = require('node:child_process');

// 兜底超时:子进程再慢也不该超过这个数。打包几百 MB 也用不了 10 分钟;
// 超了说明卡住了,杀掉并按失败回报,而不是让调用方永久挂着。
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} [opts] 透传给 spawn;额外支持 timeoutMs。
 *   注意 stdio 由本函数接管,调用方传的 stdio 会被忽略(这正是本文件存在的意义)。
 * @returns {Promise<{ran: boolean, status?: number, stderr?: string, timedOut?: boolean}>}
 *   ran:false 表示命令不存在(ENOENT),调用方据此走回退。
 */
function runProcess(command, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOpts } = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        ...spawnOpts,
        // stdin 不给管道:子进程读 stdin 会立刻拿到 EOF 而不是永久等待
        // stdout 不给管道:我们从来不用它,不建管道就不可能被写满
        // stderr 留管道:失败原因要回报给人
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      // spawn 同步抛(路径非法等)也按'命令不存在'处理,调用方走回退
      resolve({ ran: false });
      return;
    }

    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // 杀掉再回报。SIGKILL 而非 SIGTERM:卡死的进程未必响应 TERM。
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      done({ ran: true, status: null, stderr: stderr || `超过 ${timeoutMs}ms 未结束,已强制结束`, timedOut: true });
    }, timeoutMs);
    // 兜底定时器本身不该拖住进程退出
    if (typeof timer.unref === 'function') timer.unref();

    if (child.stderr) {
      child.stderr.on('data', (d) => {
        // 上限保护:stderr 也可能狂吐,别把内存吃光
        if (stderr.length < 64 * 1024) stderr += d.toString();
      });
      child.stderr.on('error', () => { /* 管道提前断,不算致命 */ });
    }

    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') done({ ran: false });
      else done({ ran: true, status: 1, stderr: e.message });
    });
    child.on('close', (code) => done({ ran: true, status: code, stderr }));
  });
}

/** 只关心成不成的场景(原 export_routes.runOk)。 */
async function runOk(command, args, opts) {
  const res = await runProcess(command, args, opts);
  return res.ran && res.status === 0;
}

module.exports = { runProcess, runOk, DEFAULT_TIMEOUT_MS };
