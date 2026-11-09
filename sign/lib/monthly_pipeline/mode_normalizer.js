'use strict';

const STANDARD_MODES = Object.freeze(['PKG', 'SG', 'H', 'B', 'V', 'F', 'FIT']);

const EXACT = new Map([
  ['PKG', 'PKG'],
  ['SG', 'SG'],
  ['H', 'H'],
  ['B', 'B'],
  ['V', 'V'],
  ['F', 'F'],
  ['FIT', 'FIT'],
]);

const RULES = [
  { pattern: /\bPKG\b/i, code: 'PKG' },
  { pattern: /SG/i, code: 'SG' },
  { pattern: /H团|\bH\b|乐天H/i, code: 'H' },
  { pattern: /B团|\bB\b|乐天B/i, code: 'B' },
  { pattern: /V团|\bV\b|济州V|新罗济州V/i, code: 'V' },
  { pattern: /F团|\bF\b/i, code: 'F' },
  { pattern: /FIT|散客/i, code: 'FIT' },
];

/**
 * Map raw mode text to one of the 7 standard modes, or UNKNOWN.
 * @param {string} raw original text from xlsx (可能含 "爱宝客SG"、"H团"、"新罗济州V" 等)
 * @returns {{ code: string, isKnown: boolean }}
 */
function normalizeMode(raw) {
  const text = (raw || '').toString().trim();
  if (!text) return { code: 'UNKNOWN', isKnown: false };
  const exact = EXACT.get(text.toUpperCase());
  if (exact) return { code: exact, isKnown: true };
  for (const { pattern, code } of RULES) {
    if (pattern.test(text)) return { code, isKnown: true };
  }
  return { code: 'UNKNOWN', isKnown: false };
}

module.exports = {
  STANDARD_MODES,
  normalizeMode,
};
