'use strict';

// T6-B 上传后台队列:uploadQueueCore 纯逻辑运行时验证 + 视图/store 接线契约。
// 红线:单飞串行保序(串图前科)/失败不堵队列且可见/超时=歧义(重发有重复建档风险,
// 与 api/uploadRetry 的 ECONNABORTED 不自动重试语义对齐)/识别不占上行不阻塞下一单。
// 前端无 Vitest——核心用 Node test 直测,Vue 接线走源码契约(仓库既有模式)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadCore() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/uploadQueueCore.js'
  )).href);
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej });
  return { promise, resolve, reject };
}

// pump 是 fire-and-forget 异步循环:每步之间用宏任务把微任务队列排干
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((res) => setImmediate(res));
  }
}

function okPayload(customerId) {
  return { customer: { customerId }, customers: [{ customerId }] };
}

test('单飞串行:第二单必须等第一单上传落定才开始(保序红线)', async () => {
  const { createUploadQueueCore } = await loadCore();
  const started = [];
  const gates = new Map();
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => {
      started.push(agentName);
      const d = deferred();
      gates.set(agentName, d);
      return d.promise;
    },
  });
  core.enqueue({ agentName: 'A', files: [{ name: 'a.jpg' }], workspaceKey: 'w', batchId: 'b1' });
  core.enqueue({ agentName: 'B', files: [{ name: 'b.jpg' }], workspaceKey: 'w', batchId: 'b1' });
  await settle();
  assert.deepEqual(started, ['A'], 'B 不得在 A 在飞时开始上传');
  assert.equal(core.counts().pending, 2);

  gates.get('A').resolve(okPayload('C1'));
  await settle();
  assert.deepEqual(started, ['A', 'B'], 'A 落定后 B 立刻接力');
  gates.get('B').resolve(okPayload('C2'));
  await settle();
  assert.deepEqual(core.state.items.map((it) => it.status), ['done', 'done']);
  assert.equal(core.state.items[0].customerId, 'C1');
});

test('失败不堵队列:A 上传报错标 failed(带服务端错误文案),B 照常传', async () => {
  const { createUploadQueueCore } = await loadCore();
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => {
      if (agentName === 'A') {
        const err = new Error('Request failed');
        err.response = { data: { error: '当前批次不存在' } };
        return Promise.reject(err);
      }
      return Promise.resolve(okPayload('C2'));
    },
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'gone' });
  core.enqueue({ agentName: 'B', files: [{}], workspaceKey: 'w', batchId: 'b1' });
  await settle();
  const [a, b] = core.state.items;
  assert.equal(a.status, 'failed');
  assert.equal(a.ambiguous, false, '非超时失败可直接重试,不标歧义');
  assert.equal(a.error, '当前批次不存在');
  assert.equal(b.status, 'done');
  assert.deepEqual(core.counts(), { queued: 0, active: 0, failed: 1, pending: 0 });
});

test('超时 ECONNABORTED=歧义失败:提示先核看板防重复建档(与 uploadRetry 不自动重试语义对齐)', async () => {
  const { createUploadQueueCore } = await loadCore();
  const core = createUploadQueueCore({
    uploadApi: () => {
      const err = new Error('timeout of 600000ms exceeded');
      err.code = 'ECONNABORTED';
      return Promise.reject(err);
    },
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b1' });
  await settle();
  const [a] = core.state.items;
  assert.equal(a.status, 'failed');
  assert.equal(a.ambiguous, true);
  assert.match(a.error, /可能已建档/);
  assert.match(a.error, /看板/);
});

test('重试:失败项文件仍在手可重传;成功后不可再重试;移除后彻底出队', async () => {
  const { createUploadQueueCore } = await loadCore();
  let attempt = 0;
  const seenFiles = [];
  const core = createUploadQueueCore({
    uploadApi: ({ files }) => {
      attempt += 1;
      seenFiles.push(files);
      if (attempt === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(okPayload('C9'));
    },
  });
  const marker = { name: 'x.jpg' };
  const id = core.enqueue({ agentName: 'A', files: [marker], workspaceKey: 'w', batchId: 'b1' });
  await settle();
  assert.equal(core.state.items[0].status, 'failed');

  assert.equal(core.retry(id), true);
  await settle();
  assert.equal(core.state.items[0].status, 'done');
  assert.equal(seenFiles.length, 2);
  assert.equal(seenFiles[1][0], marker, '重试用的是原 File 引用,不是空数组');

  assert.equal(core.retry(id), false, '成功项不可重试');
  assert.equal(core.remove(id), true, '完成项可移除');
  assert.equal(core.retry(id), false, '移除后不可重试');
  assert.equal(core.state.items.length, 0);
});

test('识别不阻塞下一单:A 转识别中时 B 即开始上传;识别失败 A 仍 done 但带补救提示', async () => {
  const { createUploadQueueCore } = await loadCore();
  const started = [];
  const uploadGates = new Map();
  const ppGates = new Map();
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => {
      started.push(agentName);
      const d = deferred();
      uploadGates.set(agentName, d);
      return d.promise;
    },
    preprocessApi: (workspaceKey, customerId) => {
      const d = deferred();
      ppGates.set(customerId, d);
      return d.promise;
    },
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b1' });
  core.enqueue({ agentName: 'B', files: [{}], workspaceKey: 'w', batchId: 'b1' });
  await settle();
  uploadGates.get('A').resolve(okPayload('C1'));
  await settle();
  assert.equal(core.state.items[0].status, 'recognizing', 'A 进识别中');
  assert.deepEqual(started, ['A', 'B'], 'A 识别期间 B 的上传已在飞(识别不占上行)');

  ppGates.get('C1').reject(new Error('qwen down'));
  uploadGates.get('B').resolve(okPayload('C2'));
  await settle();
  ppGates.get('C2').resolve({});
  await settle();
  const [a, b] = core.state.items;
  assert.equal(a.status, 'done', '识别失败不算建档失败');
  assert.match(a.note, /重新识别/);
  assert.equal(b.status, 'done');
});

test('autoPreprocess=false 不调识别;进度回调驱动 progress;在飞项不许移除', async () => {
  const { createUploadQueueCore } = await loadCore();
  let ppCalls = 0;
  let progressCb = null;
  const gate = deferred();
  const core = createUploadQueueCore({
    uploadApi: ({ onUploadProgress }) => {
      progressCb = onUploadProgress;
      return gate.promise;
    },
    preprocessApi: () => { ppCalls += 1; return Promise.resolve({}) },
  });
  const id = core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b1', autoPreprocess: false });
  await settle();
  assert.equal(core.state.items[0].status, 'uploading');
  assert.equal(core.remove(id), false, '上传中不许移除');
  progressCb({ loaded: 512, total: 1024 });
  assert.equal(core.state.items[0].progress, 50);
  gate.resolve(okPayload('C1'));
  await settle();
  assert.equal(core.state.items[0].status, 'done');
  assert.equal(ppCalls, 0, '关掉自动识别就不发识别请求');
});

test('重试排位:失败项重试后插到既有排队项之前(先修先传),且不打断在飞项', async () => {
  const { createUploadQueueCore } = await loadCore();
  const started = [];
  const gates = [];
  let failFirstB = true;
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => {
      started.push(agentName);
      if (agentName === 'B' && failFirstB) {
        failFirstB = false;
        return Promise.reject(new Error('boom'));
      }
      const d = deferred();
      gates.push({ agentName, d });
      return d.promise;
    },
  });
  const idB = core.enqueue({ agentName: 'B', files: [{}], workspaceKey: 'w', batchId: 'b' });
  await settle();
  assert.equal(core.state.items[0].status, 'failed');

  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b' });
  core.enqueue({ agentName: 'C', files: [{}], workspaceKey: 'w', batchId: 'b' });
  await settle();
  // A 在飞,C 排队;此刻重试 B → B 应插到 C 前面
  assert.equal(core.retry(idB), true);
  assert.deepEqual(core.state.items.map((it) => it.agentName), ['A', 'B', 'C'], 'B 插到第一个排队位');
  assert.equal(core.state.items[0].status, 'uploading', '在飞的 A 不被打断');

  gates.find((g) => g.agentName === 'A').d.resolve(okPayload('CA'));
  await settle();
  gates.find((g) => g.agentName === 'B').d.resolve(okPayload('CB'));
  await settle();
  gates.find((g) => g.agentName === 'C').d.resolve(okPayload('CC'));
  await settle();
  assert.deepEqual(started, ['B', 'A', 'B', 'C'], '重试的 B 排在 C 之前上传');
  assert.deepEqual(core.state.items.map((it) => it.status), ['done', 'done', 'done']);
});

test('onPreprocessSettled:识别成/败都回调(看板即刷靠它,复核 H1);关自动识别不回调', async () => {
  const { createUploadQueueCore } = await loadCore();
  const settled = [];
  let mode = 'ok';
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => Promise.resolve(okPayload(`C_${agentName}`)),
    preprocessApi: () => (mode === 'ok' ? Promise.resolve({}) : Promise.reject(new Error('down'))),
    onPreprocessSettled: (item) => settled.push(`${item.agentName}:${item.status}`),
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b' });
  await settle();
  mode = 'fail';
  core.enqueue({ agentName: 'B', files: [{}], workspaceKey: 'w', batchId: 'b' });
  await settle();
  core.enqueue({ agentName: 'N', files: [{}], workspaceKey: 'w', batchId: 'b', autoPreprocess: false });
  await settle();
  assert.deepEqual(settled, ['A:done', 'B:done'], '成败都回调且状态已终局;关自动识别的 N 不回调');
  assert.match(core.state.items[1].note, /重新识别/);
});

test('M1 隔离:preprocessApi 同步抛不污染上传结果——已建档项仍 done 不误标 failed', async () => {
  const { createUploadQueueCore } = await loadCore();
  const core = createUploadQueueCore({
    uploadApi: () => Promise.resolve(okPayload('C1')),
    preprocessApi: () => { throw new Error('sync boom') },
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'w', batchId: 'b' });
  await settle();
  const [a] = core.state.items;
  assert.equal(a.status, 'done', '上传已成功,识别同步抛只算识别失败');
  assert.match(a.note, /重新识别/);
});

test('完成项自动瘦身:纯完成项只留最近 30 条;失败项和带识别失败注记的不裁', async () => {
  const { createUploadQueueCore } = await loadCore();
  let n = 0;
  const core = createUploadQueueCore({
    uploadApi: ({ agentName }) => (agentName === 'FAIL'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve(okPayload(`C${(n += 1)}`))),
  });
  core.enqueue({ agentName: 'FAIL', files: [{}], workspaceKey: 'w', batchId: 'b' });
  for (let i = 0; i < 35; i += 1) {
    core.enqueue({ agentName: `A${i}`, files: [{}], workspaceKey: 'w', batchId: 'b', autoPreprocess: false });
  }
  await settle(80);
  const doneCount = core.state.items.filter((it) => it.status === 'done').length;
  const failedCount = core.state.items.filter((it) => it.status === 'failed').length;
  assert.equal(doneCount, 30, '35 条完成裁到 30');
  assert.equal(failedCount, 1, '失败项永不自动裁');
  assert.equal(core.state.items.filter((it) => it.status === 'done')[0].agentName, 'A5', '裁的是最老的');
});

test('上传成功回调 onCustomersPayload 收到 payload+队列项(店侧看板回填的钩子)', async () => {
  const { createUploadQueueCore } = await loadCore();
  const calls = [];
  const core = createUploadQueueCore({
    uploadApi: () => Promise.resolve(okPayload('C1')),
    onCustomersPayload: (payload, item) => calls.push({ payload, item }),
  });
  core.enqueue({ agentName: 'A', files: [{}], workspaceKey: 'ws-7', batchId: 'b1' });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].item.workspaceKey, 'ws-7');
  assert.equal(calls[0].payload.customer.customerId, 'C1');
});

// ---- 接线契约(源码断言,仓库既有前端测试模式) ----

const viewSource = fs.readFileSync(path.join(__dirname, '../frontend/src/views/CustomerLibraryView.vue'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../frontend/src/stores/uploadQueue.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '../frontend/src/api/customer.js'), 'utf8');

test('契约:建档=校验+入队+立刻清表单,不再 await 整段上传', () => {
  assert.match(viewSource, /uploadQueue\.enqueue\(\{/);
  assert.match(viewSource, /已入队/);
  // 入队快照四要素:代理/文件/工作区/批次(+自动识别开关)
  assert.match(viewSource, /workspaceKey:\s*customer\.activeWorkspace/);
  assert.match(viewSource, /batchId:\s*activeBatchId\.value/);
  assert.match(viewSource, /autoPreprocess:\s*autoPreprocess\.value/);
  // 建档函数不再直接走单飞旧路径
  assert.doesNotMatch(viewSource, /await customer\.createCustomerWithFiles/);
  // 批次前置三连校验仍在(与后端双保险)
  assert.match(viewSource, /activeBatchValid\.value/);
});

test('契约:队列面板可见(审核人员要看的失败/进度签)+关页守卫+重试按钮', () => {
  assert.match(viewSource, /上传队列/);
  assert.match(viewSource, /queueStatusLabel/);
  assert.match(viewSource, /retryQueueItem\(item\)/);
  assert.match(viewSource, /uploadQueue\.remove\(item\.id\)/);
  assert.match(storeSource, /beforeunload/);
  // M3:守卫连失败项一起拦(真失败=没建档,File 只在前端手里,关页即丢)
  assert.match(storeSource, /pending > 0 \|\| failed > 0/);
  // 看板回填防串台:只在仍停在同一工作区时回写
  assert.match(storeSource, /item\.workspaceKey === customerStore\.activeWorkspace/);
  assert.match(storeSource, /createCustomerFromFiles/);
});

test('契约:H1 修复闭环——识别落定即刷看板 + 轮询门禁纳入队列在飞态 + M2 歧义重试硬闸', () => {
  // 识别落定 → loadCustomers(自动追批次的 watch 依赖看板新鲜度)
  assert.match(storeSource, /onPreprocessSettled/);
  assert.match(storeSource, /loadCustomers\(item\.workspaceKey\)/);
  // 轮询兜底:队列有 uploading/recognizing 也该轮询(队列走裸 api 不设 actionLoading)
  assert.match(viewSource, /uploadQueue\.summary\.active > 0/);
  // 歧义(超时)重试必须过 confirm 硬闸,按钮文案区分「核对后重试」
  assert.match(viewSource, /item\.ambiguous && !window\.confirm/);
  assert.match(viewSource, /核对后重试/);
  // 旧单飞路径已删干净(store 里不残留死代码;留档注释提旧名属预期,只禁函数定义)
  const customerStoreSource = fs.readFileSync(path.join(__dirname, '../frontend/src/stores/customer.js'), 'utf8');
  assert.doesNotMatch(customerStoreSource, /async createCustomerWithFiles/);
});

test('契约:前端不压缩(用户拍板)——上传 api 原样透传 File,无 canvas/toBlob 压缩路径', () => {
  assert.doesNotMatch(apiSource, /toBlob|canvas|compress/i);
  assert.doesNotMatch(storeSource, /toBlob|canvas|compress/i);
});

// ---- 0727反馈#1:上传失败可找回(查看原图/在看板找) ----

test('filesOf:排队/失败项 File 在手可预览;成功即释放;返回副本不泄内部数组', async () => {
  const { createUploadQueueCore } = await loadCore();
  const gate = deferred();
  const core = createUploadQueueCore({ uploadApi: () => gate.promise });
  const idA = core.enqueue({ agentName: 'A', files: [{ name: 'a1.jpg' }, { name: 'a2.jpg' }], workspaceKey: 'w', batchId: 'b' });
  const idB = core.enqueue({ agentName: 'B', files: [{ name: 'b1.jpg' }], workspaceKey: 'w', batchId: 'b' });
  await settle();
  // A 在传、B 排队:两者都握着 File(在传项预览合法——File 引用上传期间有效)
  assert.deepEqual(core.filesOf(idA).map((f) => f.name), ['a1.jpg', 'a2.jpg']);
  assert.deepEqual(core.filesOf(idB).map((f) => f.name), ['b1.jpg']);
  // 副本语义:调用方改返回数组不影响下次取
  core.filesOf(idA).pop();
  assert.equal(core.filesOf(idA).length, 2, 'filesOf 必须返回副本');

  gate.reject(Object.assign(new Error('boom'), { response: { data: { error: '服务端拒绝' } } }));
  await settle();
  // A 失败:File 仍在手(找回的根基);B 接力在飞
  assert.equal(core.state.items[0].status, 'failed');
  assert.equal(core.filesOf(idA).length, 2, '失败项必须还能看原图');
  assert.equal(core.filesOf('uq_nonexistent').length, 0, '未知 id 回空数组不炸');
});

test('契约:查看原图接线——store 暴露 filesOf,视图有预览弹层且关闭必 revoke objectURL', () => {
  assert.match(storeSource, /filesOf:\s*\(id\)\s*=>\s*core\.filesOf\(id\)/);
  assert.match(viewSource, /uploadQueue\.filesOf\(item\.id\)/);
  assert.match(viewSource, /URL\.createObjectURL/);
  assert.match(viewSource, /URL\.revokeObjectURL/, '关弹层不 revoke = 每次预览漏一批 blob');
  assert.match(viewSource, /onUnmounted\(closeQueuePreview\)/, '离开页面也要清');
  assert.match(viewSource, /查看原图/);
  // done 项 File 已释放 → 降级为看板定位(客户号搜索 + 滚动到看板)
  assert.match(viewSource, /在看板找/);
  assert.match(viewSource, /locateQueueCustomer/);
  assert.match(viewSource, /boardFilter\.value = 'all'/, '定位必须先解除状态筛选,否则组可能被藏住');
});
