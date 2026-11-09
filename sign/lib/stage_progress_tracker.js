'use strict';

/**
 * 阶段进度追踪器 — 进程内单例。
 *
 * 阶段执行函数（tour_match / bill_match / merge / second_pass）在循环
 * 中调用 .update() 报告"当前进度 / 总量"；HTTP SSE handler 订阅
 * .subscribe() 把进度推给前端。
 *
 * 设计决定：
 *   - 进度只存内存（重启进程会丢，但阶段也会重跑，不影响正确性）
 *   - 单进程单例：依赖单 Node 进程的假设，符合 PM2 fork mode
 *   - 完成后 60 秒清理：让前端有时间看到最终状态
 *   - 计算 ETA：基于平均速率，简单线性外推
 */

const { EventEmitter } = require('node:events');

const PROGRESS_CLEANUP_MS = 60_000;

class StageProgressTracker extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);   // 多个浏览器订阅同一个 workspace 也行
    this.progress = new Map();  // key: `workspace:stage` → { status, current, total, startedAt, ... }
    this.cleanupTimers = new Map();
  }

  _key(workspaceKey, stage) {
    return `${workspaceKey}:${stage}`;
  }

  start({ workspaceKey, stage, total = 0 }) {
    const key = this._key(workspaceKey, stage);
    if (this.cleanupTimers.has(key)) {
      clearTimeout(this.cleanupTimers.get(key));
      this.cleanupTimers.delete(key);
    }
    const snap = {
      status: 'running',
      workspaceKey,
      stage,
      current: 0,
      total,
      progress: 0,
      startedAt: Date.now(),
      etaSec: null,
    };
    this.progress.set(key, snap);
    this.emit(key, snap);
    return snap;
  }

  update({ workspaceKey, stage, current, total }) {
    const key = this._key(workspaceKey, stage);
    const prev = this.progress.get(key);
    if (!prev) return null;
    const merged = {
      ...prev,
      current: Number(current) || 0,
      total: total != null ? Number(total) : prev.total,
    };
    if (merged.total > 0) {
      merged.progress = Math.min(1, merged.current / merged.total);
    }
    // ETA：基于平均速率
    const elapsedMs = Date.now() - merged.startedAt;
    if (merged.current > 0 && elapsedMs > 500) {
      const ratePerMs = merged.current / elapsedMs;
      const remaining = Math.max(0, merged.total - merged.current);
      merged.etaSec = Math.ceil(remaining / ratePerMs / 1000);
    }
    this.progress.set(key, merged);
    this.emit(key, merged);
    return merged;
  }

  complete({ workspaceKey, stage, stats = null }) {
    const key = this._key(workspaceKey, stage);
    const prev = this.progress.get(key);
    if (!prev) return;
    const finished = {
      ...prev,
      status: 'completed',
      progress: 1,
      current: prev.total || prev.current,
      finishedAt: Date.now(),
      stats,
      etaSec: 0,
    };
    this.progress.set(key, finished);
    this.emit(key, finished);
    this._scheduleCleanup(key);
  }

  fail({ workspaceKey, stage, error }) {
    const key = this._key(workspaceKey, stage);
    const prev = this.progress.get(key);
    if (!prev) return;
    const failed = {
      ...prev,
      status: 'failed',
      error: String(error?.message || error),
      finishedAt: Date.now(),
    };
    this.progress.set(key, failed);
    this.emit(key, failed);
    this._scheduleCleanup(key);
  }

  _scheduleCleanup(key) {
    if (this.cleanupTimers.has(key)) clearTimeout(this.cleanupTimers.get(key));
    const timer = setTimeout(() => {
      this.progress.delete(key);
      this.cleanupTimers.delete(key);
    }, PROGRESS_CLEANUP_MS);
    // unref(2026-08-01):这个定时器只是丢掉内存里的进度快照,没有任何理由拖住进程退出。
    // 不 unref 的代价实测出来了:跑过**一次** stage 就留一个 60 秒的活定时器,
    // 于是 node --test 里 tests/concurrency_pipeline_lock、stage_job_repository、
    // stage_lock_routes 三个文件各自「用例 1.2 秒 + 空转 60 秒」,墙钟 61~62 秒。
    // 三个文件白烧 3 分钟,而且**一个字都不输出** —— 正是"静默挂死"的同款指纹。
    //
    // 两个让它极难被发现的性质:
    //   ① process._getActiveHandles() 在 Node 22+ **不返回 Timeout**(实测 handles=0),
    //      靠它排查会得出"没泄漏"的错误结论;要用 process.getActiveResourcesInfo()。
    //   ② --test-timeout 管不了这一类:它约束单条用例的执行时长,
    //      不约束"最后一条用例结束"到"子进程退出"之间的空转。
    // 进程真要退出时本来也不需要跑这个清理(内存跟着进程一起没)。
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(key, timer);
  }

  get({ workspaceKey, stage }) {
    return this.progress.get(this._key(workspaceKey, stage)) || null;
  }

  /**
   * 订阅一个 (workspace, stage) 的进度。返回 unsubscribe 函数。
   */
  subscribe({ workspaceKey, stage }, listener) {
    const key = this._key(workspaceKey, stage);
    this.on(key, listener);
    // 立即推一次当前状态
    const current = this.progress.get(key);
    if (current) {
      setImmediate(() => listener(current));
    }
    return () => this.off(key, listener);
  }
}

// 单进程单例
const tracker = new StageProgressTracker();

module.exports = { tracker, StageProgressTracker };
