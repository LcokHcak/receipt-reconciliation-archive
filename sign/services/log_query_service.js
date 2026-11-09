'use strict';

/**
 * 日志查询服务 — 给 Admin UI 提供日志读取能力。
 *
 * 背景：
 *   我们用 pino 写 JSON 行到 logs/app.log 和 logs/error.log。这个 service
 *   直接读文件尾部（tail）并解析 JSON，然后按条件过滤。不用数据库，避免
 *   写入开销，日志本身已经是持久化存储。
 *
 * 设计取舍：
 *   - tail 读取：只读最后 N 行，避免把整个日志载入内存。默认 1000。
 *   - 按级别/时间/关键词过滤：纯内存 filter，对 1000-5000 行足够快。
 *   - 不做索引：日志是 append-only，grep + jq 才是真实运维方式。这个
 *     service 是 admin UI 的前端替代品，10w 行/天的规模也够用。
 *   - 平台无关：不依赖 tail 命令；用 fs.read + 逆序行缓冲。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const LEVEL_NUMERIC = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

const LEVEL_LABEL = Object.freeze({
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
});

function parseLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    // pino 的 level 是数字；我们同时记下字符串 level 方便 UI
    const levelNum = typeof obj.level === 'number'
      ? obj.level
      : LEVEL_NUMERIC[String(obj.level || '').toLowerCase()] || 0;
    return {
      ...obj,
      level: levelNum,
      levelLabel: LEVEL_LABEL[levelNum] || String(obj.level || 'unknown'),
      // pino 的 time 是毫秒或 ISO 字符串
      time: obj.time || obj.ts || null,
    };
  } catch {
    return null;
  }
}

/**
 * 读一个日志文件的最后 maxLines 行。
 * 简单实现：直接用 readline 读全文，因为日志滚动后单文件不会太大（100MB 以下）。
 */
async function tailFile(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  const buffer = [];
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const parsed = parseLine(line);
      if (!parsed) return;
      buffer.push(parsed);
      if (buffer.length > maxLines) buffer.shift();
    });
    rl.on('close', () => resolve(buffer));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * 应用过滤：level / 关键词 / 时间范围。
 */
function applyFilter(logs, filter = {}) {
  const { level, levelAtLeast, q, startTime, endTime, event } = filter;
  return logs.filter((log) => {
    if (level && log.levelLabel !== level) return false;
    if (levelAtLeast && log.level < (LEVEL_NUMERIC[levelAtLeast] || 0)) return false;
    if (event && log.event !== event) return false;
    if (startTime) {
      const logTime = new Date(log.time).getTime();
      const start = new Date(startTime).getTime();
      if (logTime < start) return false;
    }
    if (endTime) {
      const logTime = new Date(log.time).getTime();
      const end = new Date(endTime).getTime();
      if (logTime > end) return false;
    }
    if (q) {
      const needle = String(q).toLowerCase();
      const haystack = JSON.stringify(log).toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * 公开接口：查询日志。
 */
async function queryLogs({
  source = 'app', // 'app' | 'error'
  maxLines = 1000,
  filter = {},
} = {}) {
  const filename = source === 'error' ? 'error.log' : 'app.log';
  const filePath = path.join(LOG_DIR, filename);
  const all = await tailFile(filePath, maxLines);
  const filtered = applyFilter(all, filter);
  // 最新的在最前
  return filtered.reverse();
}

/**
 * 统计：最近 24 小时错误数、慢请求数、按 event 分组计数。
 * 用于 Admin 仪表盘。
 */
async function getLogStats({ windowHours = 24, maxLines = 10000 } = {}) {
  const all = await tailFile(path.join(LOG_DIR, 'app.log'), maxLines);
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const recent = all.filter((log) => {
    const t = new Date(log.time).getTime();
    return t >= cutoff;
  });

  const errorCount = recent.filter((l) => l.level >= LEVEL_NUMERIC.error).length;
  const warnCount = recent.filter((l) => l.level === LEVEL_NUMERIC.warn).length;
  const slowRequestCount = recent.filter((l) => (
    l.event === 'http_request' && typeof l.durationMs === 'number' && l.durationMs > 5000
  )).length;

  // 按 event 分组
  const byEvent = new Map();
  for (const log of recent) {
    if (!log.event) continue;
    byEvent.set(log.event, (byEvent.get(log.event) || 0) + 1);
  }

  // 最近 5 条错误
  const recentErrors = recent
    .filter((l) => l.level >= LEVEL_NUMERIC.error)
    .slice(-5)
    .reverse();

  return {
    windowHours,
    totalLogs: recent.length,
    errorCount,
    warnCount,
    slowRequestCount,
    byEvent: Array.from(byEvent.entries())
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    recentErrors,
  };
}

/**
 * 实时流（SSE 用）：从指定 offset 之后读取。
 * 这里先不做真正的 tail -f，而是每次返回全量 tail，由客户端去重。
 * 生产规模足够简单。
 */
async function queryLogsSince({ since = 0, source = 'app', maxLines = 200 } = {}) {
  const filename = source === 'error' ? 'error.log' : 'app.log';
  const filePath = path.join(LOG_DIR, filename);
  const all = await tailFile(filePath, maxLines);
  const filtered = all.filter((log) => {
    const t = new Date(log.time).getTime();
    return t > since;
  });
  return filtered;
}

module.exports = {
  queryLogs,
  queryLogsSince,
  getLogStats,
  LEVEL_NUMERIC,
  LEVEL_LABEL,
};
