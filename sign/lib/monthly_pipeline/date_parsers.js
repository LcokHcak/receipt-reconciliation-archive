'use strict';

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;
const DOT_DATE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const CJK_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse heterogeneous date input found in 团号表/账单 xlsx.
 * Returns ISO YYYY-MM-DD or null when unparsable.
 * Original text must be preserved by caller as *_raw.
 */
function parseCellDate(value, opts = {}) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return toIso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number') {
    // Excel serial (1900 system). ExcelJS usually yields Date already; guard anyway.
    const base = Date.UTC(1899, 11, 30);
    const ms = base + value * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const head = raw.split(/[~～\s]/)[0].trim();
  if (!head) return null;

  let m = ISO_DATE.exec(head);
  if (m) return toIso(m[1], m[2], m[3]);

  m = DOT_DATE.exec(head);
  if (m) return toIso(m[1], m[2], m[3]);

  m = CJK_DATE.exec(head);
  if (m) return toIso(m[1], m[2], m[3]);

  m = COMPACT_DATE.exec(head);
  if (m) return toIso(m[1], m[2], m[3]);

  m = SLASH_DATE.exec(head);
  if (m) {
    const year = m[3]
      ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]))
      : opts.fallbackYear || null;
    if (year) return toIso(year, m[1], m[2]);
  }

  return null;
}

/**
 * Parse a workspaceKey "YYYY-MM" and produce the fallback year for
 * partial dates like "4/29~".
 */
function fallbackYearFromWorkspace(workspaceKey) {
  if (!workspaceKey) return null;
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(workspaceKey));
  return m ? Number(m[1]) : null;
}

function isBefore(a, b) {
  if (!a || !b) return false;
  return a < b;
}

function isAfter(a, b) {
  if (!a || !b) return false;
  return a > b;
}

function isWithinWindow(target, start, end) {
  if (!target) return true;
  if (start && target < start) return false;
  if (end && target > end) return false;
  return true;
}

module.exports = {
  parseCellDate,
  fallbackYearFromWorkspace,
  isBefore,
  isAfter,
  isWithinWindow,
};
