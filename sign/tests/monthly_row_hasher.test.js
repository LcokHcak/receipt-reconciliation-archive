'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hashRow, hashFile } = require('../lib/monthly_pipeline/row_hasher');

test('hashRow produces stable hashes regardless of key order', () => {
  const a = hashRow({ a: 1, b: 'x', c: null });
  const b = hashRow({ c: null, b: 'x', a: 1 });
  assert.equal(a, b);
});

test('hashRow trims strings before hashing', () => {
  const a = hashRow({ name: 'ZHANG SAN' });
  const b = hashRow({ name: '  ZHANG SAN  ' });
  assert.equal(a, b);
});

test('hashRow changes when a value changes', () => {
  const a = hashRow({ name: 'ZHANG SAN', no: 1 });
  const b = hashRow({ name: 'ZHANG SAN', no: 2 });
  assert.notEqual(a, b);
});

test('hashRow walks nested structures stably', () => {
  const a = hashRow({ items: [{ id: 1, brand: 'CHANEL' }, { id: 2, brand: 'OMEGA' }] });
  const b = hashRow({ items: [{ brand: 'CHANEL', id: 1 }, { brand: 'OMEGA', id: 2 }] });
  assert.equal(a, b);
});

test('hashFile hashes raw buffers', () => {
  const h = hashFile(Buffer.from('hello'));
  assert.equal(h.length, 64);
  assert.match(h, /^[a-f0-9]+$/);
});
