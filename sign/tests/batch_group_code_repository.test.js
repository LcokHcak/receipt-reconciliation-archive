'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createBatchGroupCodeRepository } = require('../repositories/batch_group_code_repository');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'lib', 'storage', 'migrations');

function setup() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS_DIR, { logger: null });
  return { db, repo: createBatchGroupCodeRepository({ db }) };
}

test('batch_group_code repo stores batch-scoped group codes and exposes modes', () => {
  const { repo } = setup();
  const result = repo.insertMany([
    {
      batchId: 'batch-1',
      sourceWorkspaceKey: '2026-05',
      tourNo: 'T001',
      mode: 'lotte-sg',
      rowHash: 'hash-1',
      importedAt: '2026-05-26T00:00:00.000Z',
    },
    {
      batchId: 'batch-1',
      sourceWorkspaceKey: '2026-05',
      tourNo: 'T002',
      mode: 'shilla-v',
      rowHash: 'hash-2',
      importedAt: '2026-05-26T00:00:00.000Z',
    },
    {
      batchId: 'batch-2',
      sourceWorkspaceKey: '2026-05',
      tourNo: 'T001',
      mode: 'other-batch-mode',
      rowHash: 'hash-3',
      importedAt: '2026-05-26T00:00:00.000Z',
    },
  ]);

  assert.equal(result.inserted, 3);
  assert.equal(repo.countByBatch('batch-1'), 2);
  assert.deepEqual(repo.listModesByBatch('batch-1'), ['lotte-sg', 'shilla-v']);
  assert.equal(repo.findByTour({ batchId: 'batch-1', tourNo: 'T001' })[0].mode, 'lotte-sg');
  assert.equal(repo.findByTour({ batchId: 'batch-2', tourNo: 'T001' })[0].mode, 'other-batch-mode');
});

// 2026-07-07 团号多店消歧(70299病例):同团号**不同模式**是合法业务数据(团在新世界、
// 现代各有消费),必须共存;只有"同团号同模式"才算重复导入去重。0013 的 UNIQUE(batch,tour)
// 曾让后行覆盖前行 → 新世界行被现代行吃掉 → 新世界小票结算错桶。
test('batch_group_code repo:同团号不同模式共存;同团号同模式才去重覆盖', () => {
  const { repo } = setup();
  const first = repo.insertMany([
    { batchId: 'batch-1', tourNo: '70299', mode: '新世界SG-振华 不用记', rowHash: 'hash-a', importedAt: '2026-07-06T00:00:00.000Z' },
    { batchId: 'batch-1', tourNo: '70299', mode: '现代-JEOCU', rowHash: 'hash-b', importedAt: '2026-07-06T00:01:00.000Z' },
  ]);
  assert.equal(first.inserted, 2);
  assert.equal(repo.countByBatch('batch-1'), 2, '两店两行必须共存');
  const modes = repo.findByTour({ batchId: 'batch-1', tourNo: '70299' }).map((r) => r.mode).sort();
  assert.deepEqual(modes, ['新世界SG-振华 不用记', '现代-JEOCU'].sort());

  // 同团号同模式重复导入 → 覆盖不膨胀
  repo.insertMany([
    { batchId: 'batch-1', tourNo: '70299', mode: '现代-JEOCU', rowHash: 'hash-b2', importedAt: '2026-07-06T00:02:00.000Z' },
  ]);
  assert.equal(repo.countByBatch('batch-1'), 2, '重复行覆盖,总数不变');

  // mode 为 NULL 的行也按"同团号同空模式"去重(COALESCE 表达式索引)
  repo.insertMany([
    { batchId: 'batch-1', tourNo: 'T009', mode: null, rowHash: 'n1', importedAt: '2026-07-06T00:03:00.000Z' },
    { batchId: 'batch-1', tourNo: 'T009', mode: null, rowHash: 'n2', importedAt: '2026-07-06T00:04:00.000Z' },
  ]);
  assert.equal(repo.findByTour({ batchId: 'batch-1', tourNo: 'T009' }).length, 1, 'NULL 模式重复也去重');
});

test('batch_group_code repo replaces one batch without touching another batch', () => {
  const { repo } = setup();
  repo.insertMany([
    { batchId: 'batch-1', tourNo: 'T001', mode: 'old-a', rowHash: 'old-a', importedAt: '2026-05-26T00:00:00.000Z' },
    { batchId: 'batch-1', tourNo: 'T002', mode: 'old-b', rowHash: 'old-b', importedAt: '2026-05-26T00:00:00.000Z' },
    { batchId: 'batch-2', tourNo: 'T001', mode: 'kept', rowHash: 'kept', importedAt: '2026-05-26T00:00:00.000Z' },
  ]);

  const result = repo.replaceBatch({
    batchId: 'batch-1',
    rows: [
      { batchId: 'batch-1', tourNo: 'T003', mode: 'new', rowHash: 'new', importedAt: '2026-05-26T01:00:00.000Z' },
    ],
  });

  assert.equal(result.inserted, 1);
  assert.equal(repo.countByBatch('batch-1'), 1);
  assert.equal(repo.findByTour({ batchId: 'batch-1', tourNo: 'T001' }).length, 0);
  assert.equal(repo.findByTour({ batchId: 'batch-1', tourNo: 'T003' })[0].mode, 'new');
  assert.equal(repo.findByTour({ batchId: 'batch-2', tourNo: 'T001' })[0].mode, 'kept');
});
