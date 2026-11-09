'use strict';

// P2d 改店重切:task_resplit_service 单测。
// 场景:审核员改店/点重切 → 按(新)店档案用客户库原图重切 → 旧派生任务删除 → 新切片归回同批次。
// 铁律覆盖:已审保护(409)/墓碑剔除(新切片不得被墓碑挡回)/家族替换顺序重建/未切坍缩/盘面清理。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTaskResplitService } = require('../services/task_resplit_service');

const WS = '2607';
const CUST = 'cust_001';
const BATCH_ID = 'batch_x';

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
}

// 标准夹具:一张原图切成 2 张小票(01-a_original + 02-a_receipt_1 + 03-a_receipt_2),
// 批次里 2 个派生任务;另有一张无关图(04-b.jpg)+其任务,断言绝不被误伤。
function buildFixture(dir) {
  const imagesDir = path.join(dir, 'images');
  const files = ['01-a_original.jpg', '02-a_receipt_1.jpg', '03-a_receipt_2.jpg', '04-b.jpg'];
  for (const f of files) {
    touch(path.join(imagesDir, f));
    fs.writeFileSync(path.join(imagesDir, `${f}.qwen.json`), '{}');
  }
  const customer = {
    customerId: CUST,
    images: [
      { imageId: 'img_001', originalFileName: 'a.jpg', relativePath: 'images/01-a_original.jpg', autoSplit: true, autoSplitRole: 'original', sortOrder: 1 },
      { imageId: 'img_002', originalFileName: 'a.jpg', relativePath: 'images/02-a_receipt_1.jpg', autoSplit: true, autoSplitRole: 'region', sortOrder: 2 },
      { imageId: 'img_003', originalFileName: 'a.jpg', relativePath: 'images/03-a_receipt_2.jpg', autoSplit: true, autoSplitRole: 'region', sortOrder: 3 },
      { imageId: 'img_004', originalFileName: 'b.jpg', relativePath: 'images/04-b.jpg', sortOrder: 4 },
    ],
  };
  const batch = {
    id: BATCH_ID,
    tasks: [
      { id: 'task_0001', sourceOriginalPath: `${WS}/${CUST}/02-a_receipt_1.jpg`, reviewed: false },
      { id: 'task_0002', sourceOriginalPath: `${WS}/${CUST}/03-a_receipt_2.jpg`, reviewed: false },
      { id: 'task_0003', sourceOriginalPath: `${WS}/${CUST}/04-b.jpg`, reviewed: false },
    ],
    deletedSourcePaths: [`${WS}/${CUST}/02-a_receipt_1.jpg`],
  };
  return { imagesDir, customer, batch };
}

function buildDeps(dir, { customer, batch, splitResult, splitSpy }) {
  const saved = { customers: [], batches: [] };
  const removedArtifacts = [];
  const appends = [];
  const deps = {
    customerLibraryRepository: {
      loadCustomer: () => JSON.parse(JSON.stringify(customer)),
      saveCustomer: (c) => { saved.customers.push(c); Object.assign(customer, c); return c; },
      customerDir: () => dir,
    },
    batchRepository: {
      hasBatch: () => true,
      loadBatch: () => batch,
      saveBatchAsync: async (b) => { saved.batches.push(b); },
    },
    customerBatchBridgeService: {
      appendCustomerToBatch: async (args) => { appends.push(args); return { batch, appendedTasks: 2, appendedCustomers: 1 }; },
    },
    documentSplitService: {
      splitImage: async (args) => {
        if (splitSpy) splitSpy(args);
        if (typeof splitResult === 'function') return splitResult(args);
        return splitResult;
      },
    },
    removeTaskArtifacts: (batchId, task) => { removedArtifacts.push(task.id); },
    enabled: true,
  };
  return { deps, saved, removedArtifacts, appends };
}

// 造出"新切片落盘"效果的 splitResult(2 张新小票 + 新原图 ref,块前缀 1000 起)
function makeSplitOutputs(imagesDir) {
  const outs = [
    { fileName: '1001-a_original.jpg', originalFileName: 'a.jpg', source: 'uploaded_original', autoSplit: true, autoSplitRole: 'original' },
    { fileName: '1002-a_receipt_1.jpg', originalFileName: 'a.jpg', source: 'uploaded_split', autoSplit: true, autoSplitRole: 'region', docTypeHint: 'receipt' },
    { fileName: '1003-a_receipt_2.jpg', originalFileName: 'a.jpg', source: 'uploaded_split', autoSplit: true, autoSplitRole: 'region', docTypeHint: 'receipt' },
  ];
  for (const o of outs) touch(path.join(imagesDir, o.fileName));
  return { splitApplied: true, outputs: outs };
}

test('resplit: 正常重切——旧任务删+墓碑剔+家族替换+顺序重建+归队+强制重调+override归一', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    let seenArgs = null;
    const { deps, removedArtifacts, appends } = buildDeps(dir, {
      customer, batch,
      splitResult: () => makeSplitOutputs(imagesDir),
      splitSpy: (a) => { seenArgs = a; },
    });
    const svc = createTaskResplitService(deps);
    const result = await svc.resplitTask({
      batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '乐天百货', operatorUser: null,
    });

    // splitImage 调用形态
    assert.equal(seenArgs.forceRefresh, true, '重切必须强制重调(毒缓存不得回放)');
    assert.equal(seenArgs.storeFamilyOverride, 'LOTTE_DEPT', '店家归一后传入(乐天百货→LOTTE_DEPT)');
    assert.ok(seenArgs.sourcePath.endsWith('01-a_original.jpg'), '输入必须是家族的 _original 原图');
    assert.ok(seenArgs.startIndex >= 1000, '新序号块不得与旧前缀撞名');

    // 旧派生任务删除(无关任务不动)
    const taskIds = batch.tasks.map((t) => t.id);
    assert.ok(!taskIds.includes('task_0001') && !taskIds.includes('task_0002'), '旧派生任务应删除');
    assert.ok(taskIds.includes('task_0003'), '无关任务不得误伤');
    assert.deepEqual(removedArtifacts.sort(), ['task_0001', 'task_0002'], '批次侧文件应清理');

    // 墓碑剔除:家族路径不在墓碑里(否则新切片被挡回)
    assert.ok(!batch.deletedSourcePaths.some((p) => p.includes('-a_')), '家族墓碑应剔除');

    // customer.images:家族替换为新产物,无关图保留,sortOrder 连续
    const basenames = customer.images.map((r) => path.posix.basename(r.relativePath));
    assert.deepEqual(basenames, ['1001-a_original.jpg', '1002-a_receipt_1.jpg', '1003-a_receipt_2.jpg', '04-b.jpg']);
    customer.images.forEach((r, i) => {
      assert.equal(r.sortOrder, i + 1, 'sortOrder 连续无空洞');
      assert.equal(r.imageId, `img_${String(i + 1).padStart(3, '0')}`);
    });

    // 归队:appendCustomerToBatch 被调(同批次同客户)
    assert.equal(appends.length, 1);
    assert.equal(appends[0].batchId, BATCH_ID);
    assert.equal(appends[0].customerId, CUST);

    // 盘面清理:旧家族文件+sidecar 删除,新文件保留,无关文件保留
    assert.ok(!fs.existsSync(path.join(imagesDir, '02-a_receipt_1.jpg')), '旧切片应删');
    assert.ok(!fs.existsSync(path.join(imagesDir, '02-a_receipt_1.jpg.qwen.json')), '旧sidecar应删');
    assert.ok(!fs.existsSync(path.join(imagesDir, '01-a_original.jpg')), '旧原图已被新原图ref替代,应删');
    assert.ok(fs.existsSync(path.join(imagesDir, '1001-a_original.jpg')), '新产物保留');
    assert.ok(fs.existsSync(path.join(imagesDir, '04-b.jpg')), '无关文件保留');

    assert.equal(result.removedTaskIds.length, 2);
    assert.equal(result.appendedTasks, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 已审保护——家族任一任务已审 → 409 且数据零变化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_rv_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    batch.tasks[1].reviewed = true; // task_0002 已审
    const { deps, saved } = buildDeps(dir, { customer, batch, splitResult: () => makeSplitOutputs(imagesDir) });
    const svc = createTaskResplitService(deps);
    await assert.rejects(
      () => svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null }),
      (err) => err.status === 409,
      '已审任务在家族里必须 409'
    );
    assert.equal(saved.customers.length, 0, '客户数据不得动');
    assert.equal(saved.batches.length, 0, '批次数据不得动');
    assert.equal(batch.tasks.length, 3, '任务不得删');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 重切后仍是单文档(splitApplied=false)——家族坍缩为可进批次的单记录,原图文件保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_one_'));
  try {
    const { customer, batch } = buildFixture(dir);
    const { deps } = buildDeps(dir, { customer, batch, splitResult: { splitApplied: false, outputs: [] } });
    const svc = createTaskResplitService(deps);
    await svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '乐天百货', operatorUser: null });

    const familyRecords = customer.images.filter((r) => r.relativePath.includes('-a_'));
    assert.equal(familyRecords.length, 1, '家族坍缩为单记录');
    assert.equal(path.posix.basename(familyRecords[0].relativePath), '01-a_original.jpg', '记录指向原图文件');
    assert.ok(!familyRecords[0].autoSplitRole, 'autoSplitRole 必须清除(original 角色进不了批次)');
    assert.ok(fs.existsSync(path.join(dir, 'images', '01-a_original.jpg')), '原图文件保留(仍被引用)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: enabled=false(paddle后端)→ 501', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_pd_'));
  try {
    const { customer, batch } = buildFixture(dir);
    const { deps } = buildDeps(dir, { customer, batch, splitResult: { splitApplied: false, outputs: [] } });
    deps.enabled = false;
    const svc = createTaskResplitService(deps);
    await assert.rejects(
      () => svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null }),
      (err) => err.status === 501
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 切片存在但家族缺 _original → 409 不动数据(绝不拿切片当原图重切)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_no_'));
  try {
    const { customer, batch } = buildFixture(dir);
    customer.images = customer.images.filter((r) => r.autoSplitRole !== 'original');
    const { deps, saved } = buildDeps(dir, { customer, batch, splitResult: { splitApplied: false, outputs: [] } });
    const svc = createTaskResplitService(deps);
    await assert.rejects(
      () => svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null }),
      (err) => err.status === 409
    );
    assert.equal(saved.customers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 同 base 多个 _original(撞名歧义)→ 409 拒绝,防误删别的原图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_amb_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    touch(path.join(imagesDir, '2001-a_original.jpg'));
    customer.images.push({
      imageId: 'img_005', originalFileName: 'a.jpg', relativePath: 'images/2001-a_original.jpg',
      autoSplit: true, autoSplitRole: 'original', sortOrder: 5,
    });
    const { deps, saved } = buildDeps(dir, { customer, batch, splitResult: { splitApplied: false, outputs: [] } });
    const svc = createTaskResplitService(deps);
    await assert.rejects(
      () => svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null }),
      (err) => err.status === 409
    );
    assert.equal(saved.customers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 未切过的整图任务(无家族)——以图自身为输入重切', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_self_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    let seenArgs = null;
    const { deps } = buildDeps(dir, {
      customer, batch,
      splitResult: () => {
        const outs = [
          { fileName: '1001-b_original.jpg', originalFileName: 'b.jpg', source: 'uploaded_original', autoSplit: true, autoSplitRole: 'original' },
          { fileName: '1002-b_receipt_1.jpg', originalFileName: 'b.jpg', source: 'uploaded_split', autoSplit: true, autoSplitRole: 'region', docTypeHint: 'receipt' },
          { fileName: '1003-b_receipt_2.jpg', originalFileName: 'b.jpg', source: 'uploaded_split', autoSplit: true, autoSplitRole: 'region', docTypeHint: 'receipt' },
        ];
        for (const o of outs) touch(path.join(imagesDir, o.fileName));
        return { splitApplied: true, outputs: outs };
      },
      splitSpy: (a) => { seenArgs = a; },
    });
    const svc = createTaskResplitService(deps);
    await svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0003', storeFamily: '', operatorUser: null });
    assert.ok(seenArgs.sourcePath.endsWith('04-b.jpg'), '未切过的图以自身为重切输入');
    assert.equal(seenArgs.storeFamilyOverride, '', '不改店时无 override(纯漏切重试)');
    const basenames = customer.images.map((r) => path.posix.basename(r.relativePath));
    assert.ok(basenames.includes('1002-b_receipt_1.jpg') && !basenames.includes('04-b.jpg'), '家族替换生效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-07-12 审计 HIGH:qwen 长跑期间的并发覆盖 ─────────────────────────────
// withBatchWrite 超时只放行队列不取消底层动作:重切抱着 t=0 快照,完工整批覆盖,
// 吞掉超时窗内别人落盘的写入。修法=split 完成后重载 fresh 批次再应用增删。
// 夹具用"克隆式存储"(loadBatch 回克隆/saveBatchAsync 提交回存储)模拟真实文件语义。

function buildStoreDeps(dir, { customer, batch, splitResult, onSplitPending }) {
  const store = { batch: JSON.parse(JSON.stringify(batch)) };
  const saved = { customers: [] };
  const deps = {
    customerLibraryRepository: {
      loadCustomer: () => JSON.parse(JSON.stringify(customer)),
      saveCustomer: (c) => { saved.customers.push(c); Object.assign(customer, c); return c; },
      customerDir: () => dir,
    },
    batchRepository: {
      hasBatch: () => true,
      loadBatch: () => JSON.parse(JSON.stringify(store.batch)),
      saveBatchAsync: async (b) => { store.batch = JSON.parse(JSON.stringify(b)); },
    },
    customerBatchBridgeService: {
      appendCustomerToBatch: async () => ({ batch: store.batch, appendedTasks: 2, appendedCustomers: 1 }),
    },
    documentSplitService: {
      splitImage: async (args) => {
        if (onSplitPending) await onSplitPending(store); // 模拟长跑期间的并发世界
        if (typeof splitResult === 'function') return splitResult(args);
        return splitResult;
      },
    },
    removeTaskArtifacts: () => {},
    enabled: true,
  };
  return { deps, store, saved };
}

test('resplit 并发安全: qwen 长跑期间别人落盘的写入不被旧快照吞掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_race_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    const { deps, store } = buildStoreDeps(dir, {
      customer, batch,
      splitResult: () => makeSplitOutputs(imagesDir),
      onSplitPending: async (s) => {
        // 并发写入者:qwen 还在跑,另一个操作员对无关任务 task_0003 落盘了字段编辑,
        // 且批次追加了一个全新任务(模拟同批次别的客户的建档追加)
        s.batch.tasks.find((t) => t.id === 'task_0003').reviewNote = '并发写入的备注';
        s.batch.tasks.push({ id: 'task_9999', sourceOriginalPath: 'other/cust_z/x.jpg', reviewed: true });
      },
    });
    const svc = createTaskResplitService(deps);
    await svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null });

    const finalTasks = store.batch.tasks;
    const t3 = finalTasks.find((t) => t.id === 'task_0003');
    assert.equal(t3?.reviewNote, '并发写入的备注', '并发字段编辑被旧快照吞掉了');
    assert.ok(finalTasks.some((t) => t.id === 'task_9999'), '并发追加的任务被旧快照吞掉了');
    // 本职工作照常:旧派生任务删干净
    assert.ok(!finalTasks.some((t) => t.id === 'task_0001' || t.id === 'task_0002'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit 并发安全: 长跑期间家族任务被审核 → 409 且客户库/批次零写入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_race2_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    const { deps, store, saved } = buildStoreDeps(dir, {
      customer, batch,
      splitResult: () => makeSplitOutputs(imagesDir),
      onSplitPending: async (s) => {
        s.batch.tasks.find((t) => t.id === 'task_0002').reviewed = true; // 中途被审核通过
      },
    });
    const svc = createTaskResplitService(deps);
    await assert.rejects(
      () => svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '', operatorUser: null }),
      (e) => e.code === 'resplit_blocked_reviewed'
    );
    assert.equal(saved.customers.length, 0, '中止时客户库不得已被改写');
    assert.ok(store.batch.tasks.some((t) => t.id === 'task_0001'), '中止时批次不得已被改写');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resplit: 家族含 _other_ 切片也一并替换/删除(2026-07-14 复审 HIGH:漏它=旧other任务与文件永久残留)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit_'));
  try {
    const { imagesDir, customer, batch } = buildFixture(dir);
    // 家族追加一张 other 切片(qwen 2026-07-14 起会产 _other_N)+其批次任务
    touch(path.join(imagesDir, '05-a_other_1.jpg'));
    fs.writeFileSync(path.join(imagesDir, '05-a_other_1.jpg.qwen.json'), '{}');
    customer.images.push({ imageId: 'img_005', originalFileName: 'a.jpg', relativePath: 'images/05-a_other_1.jpg', autoSplit: true, autoSplitRole: 'region', sortOrder: 5 });
    batch.tasks.push({ id: 'task_0004', sourceOriginalPath: `${WS}/${CUST}/05-a_other_1.jpg`, reviewed: false });

    const { deps } = buildDeps(dir, { customer, batch, splitResult: () => makeSplitOutputs(imagesDir) });
    const svc = createTaskResplitService(deps);
    const result = await svc.resplitTask({ batchId: BATCH_ID, taskId: 'task_0001', storeFamily: '乐天百货', operatorUser: null });

    // other 任务必须随家族一起删(曾漏在 familyRe 外→重切后残留旧任务指向旧图)
    assert.ok(result.removedTaskIds.includes('task_0004'), 'other 切片任务必须进家族删除');
    assert.ok(!batch.tasks.some((t) => t.id === 'task_0004'));
    // customer.images 不残留旧 other 记录
    assert.ok(!customer.images.some((r) => /_other_/.test(r.relativePath)), '旧 other 记录必须被家族替换掉');
    // 盘面不残留旧 other 文件+sidecar
    assert.ok(!fs.existsSync(path.join(imagesDir, '05-a_other_1.jpg')), '旧 other 文件应删');
    assert.ok(!fs.existsSync(path.join(imagesDir, '05-a_other_1.jpg.qwen.json')), '旧 other sidecar 应删');
    // 无关文件/任务照旧不误伤
    assert.ok(fs.existsSync(path.join(imagesDir, '04-b.jpg')));
    assert.ok(batch.tasks.some((t) => t.id === 'task_0003'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
