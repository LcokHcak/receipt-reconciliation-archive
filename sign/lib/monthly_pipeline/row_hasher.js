'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * Stable SHA-256 over a row's canonical JSON. Used as idempotency key
 * so re-importing the same xlsx does not duplicate rows.
 */
function hashRow(row) {
  const canonical = JSON.stringify(canonicalize(row));
  return createHash('sha256').update(canonical).digest('hex');
}

function hashFile(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Stream a file through SHA-256 so a large import (hundreds of MB) is never
 * read fully into memory just to compute its dedup hash. Async; non-blocking.
 */
function hashFileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  hashRow,
  hashFile,
  hashFileStream,
};
