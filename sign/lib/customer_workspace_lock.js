'use strict';

/**
 * Per-workspace 读写锁(进程内单例,写者优先)。
 *
 * 建档类(建/补图/预处理)走 shared:同 workspace 内多客户**并发**,零串行化——
 * 不能用纯 FIFO 链(customer_write_lock 那种),否则 18s 预处理会阻塞兄弟客户建档,
 * 30 并发吞吐回归。deleteWorkspace 走 exclusive:等在飞 shared 全部 drain 后独占整库
 * rmSync,杜绝「rmSync 删一半、await 让点后的建档 op 尾部 saveCustomer 重建目录复活
 * 残壳」竞态(L631,bf25f7e 单客户锁的工作区级同构)。
 *
 * 写者优先:exclusive 一旦在等,新 shared 排队等它——防写者饿死(admin 删库不会被
 * 源源不断的建档挤到永远排不上)。exclusive 之间 FIFO。错误经 finally 释放,不 wedge 链。
 * 单 Node 进程(pm2 fork)足够。
 *
 * 锁序铁律(防死锁):workspace-shared 恒**外层**、per-customer 恒**内层**;
 * exclusive 从不嵌在 shared 内;无跨 workspace 嵌套。
 */

const locks = new Map(); // key -> { readers, writing, waitingWriters:[resolve], waitingReaders:[resolve] }

function stateFor(key) {
  let st = locks.get(key);
  if (!st) {
    st = { readers: 0, writing: false, waitingWriters: [], waitingReaders: [] };
    locks.set(key, st);
  }
  return st;
}

function maybeCleanup(key, st) {
  if (st.readers === 0 && !st.writing && st.waitingWriters.length === 0 && st.waitingReaders.length === 0) {
    locks.delete(key);
  }
}

// 释放后推进:写者优先——先放一个等待写者(预授予 writing=true);无写者则放**全部**等待读者。
function wakeNext(key, st) {
  if (st.waitingWriters.length > 0) {
    const resolve = st.waitingWriters.shift();
    st.writing = true; // 预授予:被唤醒的 acquireExclusive 直接进临界区
    resolve();
    return;
  }
  if (st.waitingReaders.length > 0) {
    const readers = st.waitingReaders.splice(0);
    st.readers += readers.length; // 预授予:全部读者可并发
    for (const r of readers) r();
    return;
  }
  maybeCleanup(key, st);
}

function acquireShared(key) {
  const st = stateFor(key);
  // 写者优先:有写者在写、或有写者在等 → 排队(被唤醒时 readers 已由 wakeNext 递增)
  if (st.writing || st.waitingWriters.length > 0) {
    return new Promise((resolve) => { st.waitingReaders.push(resolve); });
  }
  st.readers += 1;
  return Promise.resolve();
}

function releaseShared(key) {
  const st = locks.get(key);
  if (!st) return;
  st.readers -= 1;
  if (st.readers === 0) wakeNext(key, st);
  else maybeCleanup(key, st);
}

function acquireExclusive(key) {
  const st = stateFor(key);
  // 有读者/写者/其它等待写者 → 排队 FIFO(被唤醒时 writing 已由 wakeNext 置 true)
  if (st.readers > 0 || st.writing || st.waitingWriters.length > 0) {
    return new Promise((resolve) => { st.waitingWriters.push(resolve); });
  }
  st.writing = true;
  return Promise.resolve();
}

function releaseExclusive(key) {
  const st = locks.get(key);
  if (!st) return;
  st.writing = false;
  wakeNext(key, st);
}

async function withWorkspaceShared(key, fn) {
  const k = String(key || '');
  await acquireShared(k);
  try {
    return await fn();
  } finally {
    releaseShared(k);
  }
}

async function withWorkspaceExclusive(key, fn) {
  const k = String(key || '');
  await acquireExclusive(k);
  try {
    return await fn();
  } finally {
    releaseExclusive(k);
  }
}

// 仅供测试:断言无泄漏(所有锁释放后 map 应清空)。
function _activeKeyCount() {
  return locks.size;
}

module.exports = { withWorkspaceShared, withWorkspaceExclusive, _activeKeyCount };
