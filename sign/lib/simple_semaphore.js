'use strict';

// 极简进程内并发闸:限制同时进行的重操作(如客户文件夹导出=复制大量图+打包zip,
// 30人同时点会顶爆内存/磁盘)。限并发 maxConcurrent + 有界等待队列 maxQueue;
// 队列也满时 acquire 抛 EXPORT_BUSY(拒绝而非无限堆积)。
function createSemaphore({ maxConcurrent = 2, maxQueue = 6, busyMessage = '服务繁忙,请稍后再试' } = {}) {
  let active = 0;
  const queue = [];

  async function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    if (queue.length >= maxQueue) {
      const err = new Error(busyMessage);
      err.code = 'RESOURCE_BUSY';
      throw err;
    }
    // 被 release 唤醒时槽位已由 release 直接转交(active 不减也不加),这里不再自增,避免竞态超发。
    await new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    const next = queue.shift();
    if (next) {
      next(); // 有等待者:把槽位原子转交给它,active 保持不变
    } else {
      active = Math.max(0, active - 1);
    }
  }

  function stats() {
    return { active, queued: queue.length, maxConcurrent, maxQueue };
  }

  return { acquire, release, stats };
}

module.exports = { createSemaphore };
