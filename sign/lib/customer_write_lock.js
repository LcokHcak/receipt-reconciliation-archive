'use strict';

/**
 * 按客户的串行写锁(进程内单例)。
 *
 * 客户记录 customer.json 的"读 → 改 → 写"(追加图片 / 审图 / 删图 / 终审)
 * 不是原子的:并发操作同一个客户时,后写覆盖先写 → 丢更新(实测 20 并发追加 → 只剩 1)。
 * 用同一个客户号为 key 把这些操作排队串行执行,杜绝丢更新。不同客户互不阻塞。
 *
 * 单 Node 进程足够(本系统就是单进程 pm2 fork)。
 */

const chains = new Map(); // key(`${workspaceKey}/${customerId}`) -> 链尾 Promise

function withCustomerWriteLock(key, fn) {
  const k = String(key || '');
  const prev = chains.get(k) || Promise.resolve();
  const result = prev.then(() => fn());
  // 不论本次成功失败都让后续排队继续(swallow 仅用于链,不影响 result 的错误透传)
  const chain = result.then(() => {}, () => {});
  chains.set(k, chain);
  chain.finally(() => { if (chains.get(k) === chain) chains.delete(k); });
  return result;
}

function customerLockKey(workspaceKey, customerId) {
  return `${String(workspaceKey || '').trim()}/${String(customerId || '').trim()}`;
}

module.exports = { withCustomerWriteLock, customerLockKey };
