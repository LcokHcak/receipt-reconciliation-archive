'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { score } = require('../src/scoring/group-scorer');

test('完美分组：precision/recall/f1 = 1，覆盖率 1', () => {
  const predicted = [
    { key: 'P1', recordIds: ['a1', 'a2'] },
    { key: 'P2', recordIds: ['b1', 'b2'] },
  ];
  const truthByRecord = new Map([
    ['a1', 'P1'], ['a2', 'P1'], ['b1', 'P2'], ['b2', 'P2'],
  ]);
  const r = score({ predicted, truthByRecord });
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.f1, 1);
  assert.equal(r.coverage, 1);
});

test('错并（两客户并成一簇）：precision 下降', () => {
  const predicted = [{ key: 'X', recordIds: ['a1', 'b1'] }];
  const truthByRecord = new Map([['a1', 'P1'], ['b1', 'P2']]);
  const r = score({ predicted, truthByRecord });
  assert.equal(r.pairs.tp, 0);
  assert.equal(r.pairs.fp, 1);
  assert.equal(r.precision, 0);
});

test('漏归（同客户被拆开）：recall 下降', () => {
  const predicted = [
    { key: 'A', recordIds: ['a1'] },
    { key: 'B', recordIds: ['a2'] },
  ];
  const truthByRecord = new Map([['a1', 'P1'], ['a2', 'P1']]);
  const r = score({ predicted, truthByRecord });
  assert.equal(r.pairs.fn, 1);
  assert.equal(r.recall, 0);
});

test('未归组记录拉低覆盖率', () => {
  const predicted = [{ key: 'P1', recordIds: ['a1'] }];
  const truthByRecord = new Map([['a1', 'P1'], ['a2', 'P1']]);
  const r = score({ predicted, truthByRecord });
  assert.equal(r.totalRecords, 2);
  assert.equal(r.assignedRecords, 1);
  assert.equal(r.coverage, 0.5);
});
