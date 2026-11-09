'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  resolveHttpRequestTimeoutMs,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  MIN_SANE_TIMEOUT_MS,
} = require('../lib/http_timeout_config');

const root = path.join(__dirname, '..');

// 0729:这个文件原来只有一条**源码字符串断言**(断言 `server.requestTimeout = ...` 这行字存在),
// 是全仓库唯一"没有任何行为测试兜底"的测试文件。改成行为测试之后,一测就测出真 bug:
// 原实现 `Number.parseInt(v, 10) > 0 ? parsed : DEFAULT` 会**只取前缀数字**,于是
//     30m / 30min / 30 * 60 * 1000(直接从代码里复制的写法)→ 全部被读成 **30 毫秒**
//     1e6 → 1 毫秒
// 30 毫秒的请求超时 = 每一次上传都会立刻断,而这个系统要传 98MB 的 SMG 总账。
// 配错的人只会看到"上传全都失败",完全想不到是超时被解析成了毫秒级。

test('默认值:没配 / 空 / 未定义 → 30 分钟', () => {
  assert.equal(DEFAULT_HTTP_REQUEST_TIMEOUT_MS, 30 * 60 * 1000);
  for (const v of [undefined, null, '', '   ']) {
    assert.equal(resolveHttpRequestTimeoutMs(v), DEFAULT_HTTP_REQUEST_TIMEOUT_MS, `输入 ${JSON.stringify(v)}`);
  }
});

test('正常值:纯毫秒数字照收', () => {
  assert.equal(resolveHttpRequestTimeoutMs('1800000'), 1800000);
  assert.equal(resolveHttpRequestTimeoutMs('60000'), 60000);
  assert.equal(resolveHttpRequestTimeoutMs(' 120000 '), 120000, '两边空白要容忍');
});

test('⭐带单位的写法必须回落默认,不能被读成毫秒级', () => {
  const logs = [];
  const logger = { error: (m) => logs.push(m) };
  // 这五种都是现实中很可能写出来的,原实现全部静默变成 30ms / 1ms
  for (const v of ['30m', '30min', '30 * 60 * 1000', '1e6', '1800000ms']) {
    assert.equal(
      resolveHttpRequestTimeoutMs(v, { logger }),
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      `"${v}" 不该被前缀解析成一个荒谬的小数字`,
    );
  }
  assert.equal(logs.length, 5, '每一次配错都要大声报出来,不能悄悄用默认值糊过去');
  assert.match(logs[0], /不是纯毫秒数字/);
  assert.match(logs[0], /别写 30m/, '错误信息要直接给出正确写法');
});

test('⭐下限护栏:低于 1 秒当配错处理(单位写错的兜底)', () => {
  const logs = [];
  const logger = { error: (m) => logs.push(m) };
  assert.equal(MIN_SANE_TIMEOUT_MS, 1000);
  for (const v of ['1', '30', '999']) {
    assert.equal(resolveHttpRequestTimeoutMs(v, { logger }), DEFAULT_HTTP_REQUEST_TIMEOUT_MS, `${v}ms 太短`);
  }
  assert.equal(resolveHttpRequestTimeoutMs('1000'), 1000, '正好 1 秒是允许的边界');
  assert.equal(logs.length, 3);
  assert.match(logs[0], /单位是/, '要点破单位');
});

test('非法值:0 / 负数 / 非数字 → 回落默认', () => {
  for (const v of ['0', '-5', 'abc', 'NaN']) {
    assert.equal(resolveHttpRequestTimeoutMs(v, { logger: { error() {} } }), DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  }
});

test('logger 缺席不得抛错(server 启动早期可能还没装配日志)', () => {
  assert.doesNotThrow(() => resolveHttpRequestTimeoutMs('30m', { logger: null }));
  assert.doesNotThrow(() => resolveHttpRequestTimeoutMs('30m', {}));
});

// 接线契约(这条**是**源码断言,但它有上面 6 条行为测试兜底,是补充不是替代)
test('接线:server 用解析结果设 requestTimeout', () => {
  const src = fs.readFileSync(path.join(root, 'workbench_server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/http_timeout_config'\)/, '改用抽出的模块');
  assert.match(src, /const\s+httpRequestTimeoutMs\s*=\s*resolveHttpRequestTimeoutMs\(\)/);
  assert.match(src, /server\.requestTimeout\s*=\s*httpRequestTimeoutMs/);
  assert.doesNotMatch(src, /function resolveHttpRequestTimeoutMs/, '旧的内联实现已下线');
});
