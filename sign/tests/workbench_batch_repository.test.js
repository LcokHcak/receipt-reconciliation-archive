const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkbenchBatchRepository } = require('../repositories/workbench_batch_repository');

function withTempBatchesRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-batches-'));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  const result = fn(root);
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

function createRepository(root, overrides = {}) {
  return createWorkbenchBatchRepository({
    batchesRoot: root,
    normalizeBatch: (batch) => ({ ...batch, normalized: true }),
    summarizeBatch: (batch) => ({
      id: batch.id,
      name: batch.name,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    }),
    ...overrides,
  });
}

function createBatch(id = 'batch_1') {
  return {
    id,
    name: 'Batch 1',
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
    tasks: [],
  };
}

function withSuppressedConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function writeBatchJson(repository, batch) {
  fs.mkdirSync(repository.batchDir(batch.id), { recursive: true });
  fs.writeFileSync(repository.batchJsonPath(batch.id), JSON.stringify(batch, null, 2), 'utf8');
}

test('saveBatch writes JSON and syncs the SQLite projection from the repository queue', () => {
  withTempBatchesRoot((root) => {
    const synced = [];
    const repository = createRepository(root, {
      sqliteSyncService: {
        syncBatch(batch) {
          synced.push({ id: batch.id, updatedAt: batch.updatedAt });
        },
      },
    });
    const batch = createBatch();
    fs.mkdirSync(repository.batchDir(batch.id), { recursive: true });

    repository.saveBatch(batch);

    const persisted = JSON.parse(fs.readFileSync(repository.batchJsonPath(batch.id), 'utf8'));
    assert.equal(persisted.id, batch.id);
    assert.equal(synced.length, 1);
    assert.equal(synced[0].id, batch.id);
    assert.equal(synced[0].updatedAt, persisted.updatedAt);
  });
});

test('saveBatch records persistence timings through the performance monitor', () => {
  withTempBatchesRoot((root) => {
    const labels = [];
    const repository = createRepository(root, {
      performanceMonitor: {
        measureSync(label, action, metadataFactory) {
          labels.push([label, metadataFactory]);
          const result = action();
          const metadata = metadataFactory(result);
          assert.deepEqual(metadata, { batchId: 'batch_perf_save' });
          return result;
        },
      },
    });
    const batch = createBatch('batch_perf_save');
    fs.mkdirSync(repository.batchDir(batch.id), { recursive: true });

    repository.saveBatch(batch);

    assert.deepEqual(labels.map(([label]) => label), ['workbench.batchRepository.saveBatch']);
  });
});

test('saveBatchAsync writes JSON through async persistence and invalidates the cache', async () => {
  await withTempBatchesRoot(async (root) => {
    const labels = [];
    const repository = createRepository(root, {
      performanceMonitor: {
        async measure(label, action, metadataFactory) {
          labels.push(label);
          const result = await action();
          const metadata = metadataFactory(result);
          if (label === 'workbench.batchRepository.saveBatchAsync') {
            assert.deepEqual(metadata, { batchId: 'batch_async_save' });
          }
          return result;
        },
        measureSync(label, action) {
          return action();
        },
      },
    });
    const batch = createBatch('batch_async_save');
    fs.mkdirSync(repository.batchDir(batch.id), { recursive: true });

    await repository.saveBatchAsync(batch);

    const persisted = JSON.parse(fs.readFileSync(repository.batchJsonPath(batch.id), 'utf8'));
    assert.equal(persisted.id, batch.id);
    assert.equal((await repository.listBatchesAsync())[0].id, batch.id);
    assert.deepEqual(labels, [
      'workbench.batchRepository.saveBatchAsync',
      'workbench.batchRepository.listBatchesAsync',
    ]);
  });
});

test('saveBatch keeps JSON writes successful when SQLite projection sync fails', () => {
  withTempBatchesRoot((root) => {
    const repository = createRepository(root, {
      sqliteSyncService: {
        syncBatch() {
          throw new Error('sqlite unavailable');
        },
      },
    });
    const batch = createBatch('batch_sqlite_error');
    fs.mkdirSync(repository.batchDir(batch.id), { recursive: true });

    assert.doesNotThrow(() => withSuppressedConsoleError(() => repository.saveBatch(batch)));

    const persisted = JSON.parse(fs.readFileSync(repository.batchJsonPath(batch.id), 'utf8'));
    assert.equal(persisted.id, batch.id);
  });
});

test('workbench entrypoint delegates batch persistence to the repository instead of owning a second write queue', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'passport_review_workbench.js'), 'utf8');

  assert.doesNotMatch(source, /const\s+batchWriteQueues\s*=\s*new\s+Map\(/);
  assert.doesNotMatch(source, /function\s+withBatchWrite\s*\(/);
  assert.doesNotMatch(source, /function\s+loadBatch\s*\(/);
  assert.doesNotMatch(source, /function\s+saveBatch\s*\(/);
});

test('listBatches caches summaries within the repository cache ttl', () => {
  withTempBatchesRoot((root) => {
    let normalizeCalls = 0;
    const repository = createRepository(root, {
      normalizeBatch: (batch) => {
        normalizeCalls += 1;
        return batch;
      },
    });
    writeBatchJson(repository, createBatch());

    assert.deepEqual(repository.listBatches().map((batch) => batch.id), ['batch_1']);
    assert.deepEqual(repository.listBatches().map((batch) => batch.id), ['batch_1']);

    assert.equal(normalizeCalls, 1);
  });
});

test('listBatchesAsync reads batch summaries without using the sync list path', async () => {
  await withTempBatchesRoot(async (root) => {
    let normalizeCalls = 0;
    const repository = createRepository(root, {
      normalizeBatch: (batch) => {
        normalizeCalls += 1;
        return batch;
      },
      performanceMonitor: {
        async measure(label, action, metadataFactory) {
          assert.equal(label, 'workbench.batchRepository.listBatchesAsync');
          const result = await action();
          assert.deepEqual(metadataFactory(result), { batchCount: 1 });
          return result;
        },
        measureSync() {
          throw new Error('sync list path should not run');
        },
      },
    });
    writeBatchJson(repository, createBatch());

    assert.deepEqual((await repository.listBatchesAsync()).map((batch) => batch.id), ['batch_1']);
    assert.deepEqual((await repository.listBatchesAsync()).map((batch) => batch.id), ['batch_1']);
    assert.equal(normalizeCalls, 1);
  });
});

test('saveBatch invalidates the cached batch list', () => {
  withTempBatchesRoot((root) => {
    const repository = createRepository(root);
    const batch = createBatch();
    writeBatchJson(repository, batch);

    assert.equal(repository.listBatches()[0].name, 'Batch 1');

    repository.saveBatch({
      ...batch,
      name: 'Renamed Batch',
    });

    assert.equal(repository.listBatches()[0].name, 'Renamed Batch');
  });
});

test('removeBatchDirectory invalidates the cached batch list', () => {
  withTempBatchesRoot((root) => {
    const repository = createRepository(root);
    writeBatchJson(repository, createBatch('batch_delete_me'));

    assert.deepEqual(repository.listBatches().map((batch) => batch.id), ['batch_delete_me']);

    repository.removeBatchDirectory('batch_delete_me');

    assert.deepEqual(repository.listBatches(), []);
  });
});

test('clearCache forces listBatches to read the latest batch files', () => {
  withTempBatchesRoot((root) => {
    const repository = createRepository(root);
    const batch = createBatch();
    writeBatchJson(repository, batch);

    assert.equal(repository.listBatches()[0].name, 'Batch 1');

    writeBatchJson(repository, {
      ...batch,
      name: 'External Update',
    });
    repository.clearCache();

    assert.equal(repository.listBatches()[0].name, 'External Update');
  });
});

test('listBatches records slow repository scans through the performance monitor', () => {
  withTempBatchesRoot((root) => {
    const logs = [];
    let now = 500;
    const repository = createRepository(root, {
      performanceMonitor: {
        measureSync(label, action, metadataFactory) {
          assert.equal(label, 'workbench.batchRepository.listBatches');
          const result = action();
          now += 125;
          const metadata = metadataFactory(result);
          logs.push(`[perf] ${label}: ${now - 500}ms batchCount=${metadata.batchCount}`);
          return result;
        },
      },
    });
    writeBatchJson(repository, createBatch());

    assert.deepEqual(repository.listBatches().map((batch) => batch.id), ['batch_1']);

    assert.deepEqual(logs, ['[perf] workbench.batchRepository.listBatches: 125ms batchCount=1']);
  });
});

// ── 按批次 mtime 的摘要缓存(2026-07-08 主线程瓶颈根治)──────────────────
// 生产病理:106 个批次(单个 6-8MB),每次审核员保存字段都 clearCache→下次列表
// 全量重读+解析 700MB JSON,主线程卡 10s,识别管道抢不到 CPU。
// 根治:摘要按 batchId 缓存,mtime+size 当版本键;保存只失效自己那一个,别的复用。

test('listBatches: 保存一个批次后,只有它被重新汇总,其余走缓存(核心提速属性)', () => {
  withTempBatchesRoot((root) => {
    const summarizeCalls = [];
    const repository = createRepository(root, {
      summarizeBatch: (batch) => {
        summarizeCalls.push(batch.id);
        return { id: batch.id, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt };
      },
    });
    writeBatchJson(repository, { ...createBatch('batch_1'), createdAt: '2026-05-07T00:00:00.000Z' });
    writeBatchJson(repository, { ...createBatch('batch_2'), name: 'B2', createdAt: '2026-05-06T00:00:00.000Z' });

    repository.listBatches(); // 首次:两个都汇总
    assert.deepEqual([...summarizeCalls].sort(), ['batch_1', 'batch_2']);
    summarizeCalls.length = 0;

    repository.saveBatch({ ...createBatch('batch_2'), name: 'B2v2', createdAt: '2026-05-06T00:00:00.000Z' });

    const list = repository.listBatches();
    assert.deepEqual(summarizeCalls, ['batch_2'], '只有被保存的批次重新汇总,batch_1 走缓存');
    assert.equal(list.find((b) => b.id === 'batch_2').name, 'B2v2', '被保存批次内容已更新');
  });
});

test('listBatchesAsync: 保存一个批次后,只有它被重新汇总(异步路径同属性)', async () => {
  await withTempBatchesRoot(async (root) => {
    const summarizeCalls = [];
    const repository = createRepository(root, {
      summarizeBatch: (batch) => {
        summarizeCalls.push(batch.id);
        return { id: batch.id, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt };
      },
    });
    writeBatchJson(repository, { ...createBatch('batch_1'), createdAt: '2026-05-07T00:00:00.000Z' });
    writeBatchJson(repository, { ...createBatch('batch_2'), name: 'B2', createdAt: '2026-05-06T00:00:00.000Z' });

    await repository.listBatchesAsync();
    assert.deepEqual([...summarizeCalls].sort(), ['batch_1', 'batch_2']);
    summarizeCalls.length = 0;

    await repository.saveBatchAsync({ ...createBatch('batch_1'), name: 'B1v2', createdAt: '2026-05-07T00:00:00.000Z' });

    const list = await repository.listBatchesAsync();
    assert.deepEqual(summarizeCalls, ['batch_1'], '只有被保存的批次重新汇总');
    assert.equal(list.find((b) => b.id === 'batch_1').name, 'B1v2');
  });
});

test('clearCache 同时清掉按批次的摘要缓存(保外部契约:强制全部重读)', () => {
  withTempBatchesRoot((root) => {
    const summarizeCalls = [];
    const repository = createRepository(root, {
      summarizeBatch: (batch) => {
        summarizeCalls.push(batch.id);
        return { id: batch.id, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt };
      },
    });
    writeBatchJson(repository, createBatch('batch_1'));
    repository.listBatches();
    summarizeCalls.length = 0;

    repository.clearCache();
    repository.listBatches();
    assert.deepEqual(summarizeCalls, ['batch_1'], 'clearCache 后必须重新汇总(摘要缓存已丢弃)');
  });
});

test('listBatches: 单个损坏的 batch.json 只跳过它自己,不拖垮整张列表', () => {
  withTempBatchesRoot((root) => {
    const repository = createRepository(root);
    writeBatchJson(repository, { ...createBatch('batch_ok'), createdAt: '2026-05-07T00:00:00.000Z' });
    // 造一个损坏(截断)的 batch.json
    fs.mkdirSync(repository.batchDir('batch_corrupt'), { recursive: true });
    fs.writeFileSync(repository.batchJsonPath('batch_corrupt'), '{ "id": "batch_corrupt", "tas', 'utf8');

    const list = withSuppressedConsoleError(() => repository.listBatches());
    assert.deepEqual(list.map((b) => b.id), ['batch_ok'], '坏批次被跳过,好批次照常返回');
  });
});

// ── 摘要缓存落盘(2026-07-28,生产 2.9s@163批 冷启动根治)────────────────────────
test('摘要缓存跨进程回灌:重启实例列表零重解析;文件动过仍按 mtime+size 重解析(绝无陈旧)', async () => {
  await withTempBatchesRoot(async (root) => {
    const counting = () => {
      let calls = 0;
      return {
        fn: (batch) => { calls += 1; return { id: batch.id, name: batch.name, createdAt: batch.createdAt, updatedAt: batch.updatedAt }; },
        calls: () => calls,
      };
    };

    // 第一个"进程":建 2 批,列表触发解析并落盘缓存
    const c1 = counting();
    const repo1 = createRepository(root, { summarizeBatch: c1.fn });
    fs.mkdirSync(repo1.batchDir('batch_a'), { recursive: true });
    fs.mkdirSync(repo1.batchDir('batch_b'), { recursive: true });
    repo1.saveBatch(createBatch('batch_a'));
    repo1.saveBatch({ ...createBatch('batch_b'), name: 'Batch 2' });
    const list1 = await repo1.listBatchesAsync();
    assert.equal(list1.length, 2);
    assert.ok(c1.calls() >= 2, '首个实例至少各解析一次');
    // 落盘是 2s debounce:等它写完
    await new Promise((r) => setTimeout(r, 2600));
    assert.ok(fs.existsSync(path.join(root, '.summary_cache.json')), '摘要缓存必须落盘');

    // 第二个"进程"(新实例=模拟重启):列表全量命中回灌缓存,summarizeBatch 零调用
    const c2 = counting();
    const repo2 = createRepository(root, { summarizeBatch: c2.fn });
    const list2 = await repo2.listBatchesAsync();
    assert.equal(list2.length, 2);
    assert.equal(c2.calls(), 0, '冷启动回灌后不得重解析任何批次(这正是 2.9s 的根治点)');
    assert.deepEqual(
      list2.map((b) => b.id).sort(),
      ['batch_a', 'batch_b'],
    );

    // 改其中一批(mtime/size 变)→ 只有它重解析,另一批仍走缓存
    await new Promise((r) => setTimeout(r, 20)); // 确保 mtime 前进
    const repo2b = createRepository(root, { summarizeBatch: c2.fn });
    repo2b.saveBatch({ ...createBatch('batch_a'), name: 'Batch 1 改' });
    const c3 = counting();
    const repo3 = createRepository(root, { summarizeBatch: c3.fn });
    const list3 = await repo3.listBatchesAsync();
    assert.equal(list3.find((b) => b.id === 'batch_a').name, 'Batch 1 改', '改过的批次必须出新值');
    assert.equal(c3.calls(), 1, '只重解析动过的那一批');

    // 坏缓存文件:回灌静默放弃,行为退回全量解析(不炸)
    fs.writeFileSync(path.join(root, '.summary_cache.json'), '{broken json');
    const c4 = counting();
    const repo4 = createRepository(root, { summarizeBatch: c4.fn });
    const list4 = await repo4.listBatchesAsync();
    assert.equal(list4.length, 2);
    assert.ok(c4.calls() >= 2, '坏缓存=冷启动老实解析');
  });
});

// ── 摘要缓存要认代码版本(0731 核账 #2 排查出的结构性风险)────────────────
// 缓存键只有 mtime+size,而缓存**会落盘并在重启时回灌**。
// 后果:summarizeBatch 一旦新增列表级字段,batch.json 此后没被改写过的批次会一直
// 命中旧缓存、喂出缺字段的摘要 —— 表现为管理员首页「已完成批次」表某些行空白,
// 而且不会自愈(那些批次可能几个月都不会再被写)。
// 已排除更坏的情况:缓存只用于 includeTasks:false,任务级字段每次重算。

test('⭐换了摘要结构版本后,旧盘缓存必须失效重算', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumver-'));
  const counting = () => {
    let n = 0;
    return { calls: () => n, fn: (b) => { n += 1; return { id: b.id, name: b.name, v: 'new' }; } };
  };

  const c1 = counting();
  const repo1 = createRepository(root, { summarizeBatch: c1.fn });
  fs.mkdirSync(repo1.batchDir('batch_a'), { recursive: true });
  repo1.saveBatch(createBatch('batch_a'));
  await repo1.listBatchesAsync();
  await new Promise((r) => setTimeout(r, 2600));

  // 手动把盘上缓存的版本戳改成"上一版",模拟「代码升了、batch.json 没动过」
  const cacheFile = path.join(root, '.summary_cache.json');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.ok('schemaVersion' in raw, '缓存文件必须记录摘要结构版本,否则没法判断新旧');
  raw.schemaVersion = -1;
  fs.writeFileSync(cacheFile, JSON.stringify(raw));

  // 新"进程"读到旧版本戳 → 必须重算,不能拿旧摘要糊弄
  const c2 = counting();
  const repo2 = createRepository(root, { summarizeBatch: c2.fn });
  await repo2.listBatchesAsync();
  assert.ok(c2.calls() >= 1, '版本戳对不上时还在吃旧缓存 —— 加了新字段的批次会一直缺字段');
});
