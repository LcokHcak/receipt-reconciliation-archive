'use strict';

// 上传自动重试(2026-07-08):瞬断(部署重启窗口/主线程拥堵掐连接)的 Network Error
// 自动重试,用户无感。铁律:只重试「请求确定没被服务端处理」的失败形态——
// ERR_NETWORK(无响应)/502/503/504(Caddy 报后端不可达);
// 超时(ECONNABORTED)和 4xx 绝不重试(超时可能服务端仍在处理,重发=重复建客户)。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  return import(pathToFileURL(path.join(__dirname, '../frontend/src/api/uploadRetry.js')).href);
}

const noSleep = async () => {};

test('uploadRetry: ERR_NETWORK 重试后成功,重建请求(FormData 不复用)', async () => {
  const { postWithRetry } = await loadModule();
  let calls = 0;
  const result = await postWithRetry(() => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('Network Error');
      err.code = 'ERR_NETWORK';
      throw err;
    }
    return Promise.resolve({ data: { ok: true } });
  }, { sleep: noSleep });
  assert.equal(calls, 2, '第一次失败后重试一次即成功');
  assert.deepEqual(result.data, { ok: true });
});

test('uploadRetry: 502/503/504 视为瞬断可重试', async () => {
  const { isTransientUploadError } = await loadModule();
  for (const status of [502, 503, 504]) {
    assert.equal(isTransientUploadError({ response: { status } }), true, `${status} 应重试`);
  }
});

test('uploadRetry: 超时/4xx/500 不重试(重发有重复建档风险或无意义)', async () => {
  const { postWithRetry, isTransientUploadError } = await loadModule();
  assert.equal(isTransientUploadError({ code: 'ECONNABORTED' }), false, '超时不重试:服务端可能仍在处理');
  assert.equal(isTransientUploadError({ response: { status: 400 } }), false);
  assert.equal(isTransientUploadError({ response: { status: 409 } }), false);
  assert.equal(isTransientUploadError({ response: { status: 500 } }), false, '500=业务代码炸了,重试无意义');

  let calls = 0;
  await assert.rejects(
    () => postWithRetry(() => {
      calls += 1;
      const err = new Error('Request failed with status code 409');
      err.response = { status: 409 };
      throw err;
    }, { sleep: noSleep }),
    (err) => err.response?.status === 409
  );
  assert.equal(calls, 1, '非瞬断错误立即抛出,零重试');
});

test('uploadRetry: 重试耗尽后抛最后一次错误,默认最多 2 次重试', async () => {
  const { postWithRetry } = await loadModule();
  let calls = 0;
  const slept = [];
  await assert.rejects(
    () => postWithRetry(() => {
      calls += 1;
      const err = new Error('Network Error');
      err.code = 'ERR_NETWORK';
      err.attempt = calls;
      throw err;
    }, { sleep: async (ms) => { slept.push(ms); } }),
    (err) => err.code === 'ERR_NETWORK' && err.attempt === 3
  );
  assert.equal(calls, 3, '1 次原始 + 2 次重试');
  assert.equal(slept.length, 2, '两次重试各睡一次');
  assert.ok(slept[1] > slept[0], '退避间隔递增');
});

test('uploadRetry: 首次成功零开销(不睡不重试)', async () => {
  const { postWithRetry } = await loadModule();
  let calls = 0;
  const slept = [];
  const result = await postWithRetry(() => {
    calls += 1;
    return Promise.resolve({ data: 'ok' });
  }, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(calls, 1);
  assert.equal(slept.length, 0);
  assert.equal(result.data, 'ok');
});
