'use strict';

/**
 * tour_confirm_log_repository — 团号确认流水(2026-07-10,P2 先验 + 审计)。
 *
 * 存储:storage/tour_confirm_log/YYYY-MM-DD.jsonl(按日分文件追加)。
 *   - 追加写,无就地改 → 无丢写问题;先验查询只读当天(±1天)文件,永远小。
 *   - 将来 intake 接微信群:行里加 chatGroup 字段即可,查询函数已留参数位。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

function createTourConfirmLogRepository({ storageRoot }) {
  if (!storageRoot) throw new Error('storageRoot is required');
  const root = path.join(storageRoot, 'tour_confirm_log');

  function fileOf(date) {
    return path.join(root, `${String(date).slice(0, 10)}.jsonl`);
  }

  // 异步追加:调用点在批次写锁内,同步 IO 会卡整个事件循环(reviewer MEDIUM)。
  async function append(entry) {
    const date = String(entry?.confirmedAt || entry?.date || new Date().toISOString()).slice(0, 10);
    await fsp.mkdir(root, { recursive: true });
    await fsp.appendFile(fileOf(date), `${JSON.stringify({ ...entry, date })}\n`);
  }

  async function readDay(date) {
    try {
      const text = await fsp.readFile(fileOf(date), 'utf8');
      return text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  // 先验:某收票员(workspace)在 date(含前一天,跨夜班次)确认过的团号,按引用组数倒序。
  async function listPrior({ workspaceKey = '', date, includePrevDay = true } = {}) {
    const day = String(date || new Date().toISOString()).slice(0, 10);
    const days = [day];
    if (includePrevDay) {
      const prev = new Date(`${day}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() - 1);
      days.push(prev.toISOString().slice(0, 10));
    }
    const rows = (await Promise.all(days.map(readDay))).flat();
    const ws = String(workspaceKey || '').trim();
    const byTour = new Map();
    for (const row of rows) {
      if (ws && String(row.workspaceKey || '').trim() !== ws) continue;
      const tour = String(row.tourNo || '').trim();
      if (!tour) continue;
      if (!byTour.has(tour)) byTour.set(tour, { tourNo: tour, mode: String(row.mode || ''), count: 0, lastAt: '' });
      const e = byTour.get(tour);
      e.count += 1;
      if (String(row.confirmedAt || '') > e.lastAt) { e.lastAt = String(row.confirmedAt || ''); e.mode = String(row.mode || e.mode); }
    }
    return [...byTour.values()].sort((a, b) => b.count - a.count);
  }

  return { append, listPrior, readDay };
}

module.exports = { createTourConfirmLogRepository };
