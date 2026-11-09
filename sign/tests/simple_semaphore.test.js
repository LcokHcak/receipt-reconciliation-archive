const test = require('node:test');
const assert = require('node:assert/strict');

const { createSemaphore } = require('../lib/simple_semaphore');

test('createSemaphore 限并发到 maxConcurrent,不超发(竞态安全)', async () => {
  const sem = createSemaphore({ maxConcurrent: 2, maxQueue: 20 });
  let active = 0;
  let maxSeen = 0;
  const task = async () => {
    await sem.acquire();
    active += 1;
    maxSeen = Math.max(maxSeen, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    sem.release();
  };
  await Promise.all(Array.from({ length: 10 }, task));
  assert.equal(maxSeen, 2, '同时并发不应超过 maxConcurrent');
  assert.equal(sem.stats().active, 0);
});

test('createSemaphore 队列满时 acquire 抛 RESOURCE_BUSY', async () => {
  const sem = createSemaphore({ maxConcurrent: 1, maxQueue: 1 });
  await sem.acquire(); // 占满并发
  const queued = sem.acquire(); // 进等待队列(队列=1)
  await assert.rejects(() => sem.acquire(), /繁忙|busy/i); // 队列也满 → 拒
  sem.release(); // 放行队列里那个
  await queued;
  sem.release();
  assert.equal(sem.stats().active, 0);
});
