'use strict';

/**
 * 按月度工作区(workspaceKey)串行化 tour_match 重跑。
 *
 * 流式逐客户结算下,30 个审核员每审完一个客户就触发一次增量 tour_match。tour_match_service.run
 * 会先删除该批 pending 行上的 open error_record / pending_review 再重建(见 tour_match_service
 * 的 reprocess 逻辑)——同一 workspace 上两个 run 并发就会互相删/建踩花。这里用 per-workspace
 * 的 promise 链做互斥(与 lib/customer_write_lock 同款),保证同一 workspace 的 tour_match 串行,
 * 不同 workspace 仍并行。
 */

const chains = new Map(); // workspaceKey -> 链尾 Promise

function withWorkspaceTourMatchLock(workspaceKey, fn) {
  const key = String(workspaceKey || '');
  const prev = chains.get(key) || Promise.resolve();
  const result = prev.then(() => fn());
  // 链尾吞掉结果与异常,避免一个失败把后续都拒掉(每个调用者各自拿到自己的 result)。
  const chain = result.then(() => {}, () => {});
  chains.set(key, chain);
  chain.finally(() => {
    if (chains.get(key) === chain) chains.delete(key);
  });
  return result;
}

module.exports = { withWorkspaceTourMatchLock };
