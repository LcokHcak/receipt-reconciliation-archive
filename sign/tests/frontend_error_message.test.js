'use strict';

/**
 * 前端错误文案:后端没回话的那一半,不许把英文原样吐给用户(2026-08-01)。
 *
 * 病灶:全站十几处写成 `error.response?.data?.error || error.message`。
 * 后端给了中文就用中文 —— 这一半对;可**后端没来得及回话**的那一半(断网、超时、
 * 服务没起来、网关掐断)根本没有 response.data.error,于是直接吐 axios 的英文:
 *   Network Error / timeout of 30000ms exceeded / Request failed with status code 502
 * 用户截图里满屏的就是这些。而这恰恰是最常见的一类失败 —— 真出事的时候,
 * 界面说的反而是最看不懂的话。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadHelper() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'errorMessage.js'), 'utf8',
  );
  const body = src.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export /gm, '');
   
  return new Function(`${body}\nreturn humanErrorMessage;`)();
}

const humanErrorMessage = loadHelper();

test('后端给了中文 → 原样用(业务话优先,不许被兜底覆盖)', () => {
  const err = { response: { status: 400, data: { error: '本组已产生结算台账,票据不可删除' } } };
  assert.equal(humanErrorMessage(err, '删除失败'), '本组已产生结算台账,票据不可删除');
});

test('⭐断网 → 说人话,不是 Network Error', () => {
  const err = { code: 'ERR_NETWORK', message: 'Network Error' };
  const msg = humanErrorMessage(err, '保存失败');
  assert.ok(!/Network Error/.test(msg), `不许出现英文原文:${msg}`);
  assert.match(msg, /保存失败/);
  assert.match(msg, /连不上服务器/);
});

test('⭐超时 → 说人话,而且**不能催人重试**(服务端可能已经做完了)', () => {
  const err = { code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' };
  const msg = humanErrorMessage(err, '上传失败');
  assert.ok(!/timeout of/.test(msg), `不许出现英文原文:${msg}`);
  assert.match(msg, /可能已经处理完/, '超时≠没做,重发可能造成重复建档');
  assert.match(msg, /先刷新看看结果/);
  // 没有 code、只有 message 的形态也要认(不同 axios 版本行为不一)
  assert.match(humanErrorMessage({ message: 'timeout of 5000ms exceeded' }, 'x'), /可能已经处理完/);
});

test('⭐有 HTTP 状态但没 body → 按状态说人话', () => {
  const of = (status) => humanErrorMessage({ response: { status, data: {} }, message: `Request failed with status code ${status}` }, '操作失败');
  assert.match(of(401), /登录已过期/);
  assert.match(of(403), /没有权限/);
  assert.match(of(404), /不在了/);
  assert.match(of(409), /撞上了/);
  assert.match(of(502), /暂时没响应/);
  assert.match(of(500), /服务器出错/);
  for (const s of [401, 403, 404, 409, 502, 500]) {
    assert.ok(!/Request failed with status code/.test(of(s)), `${s} 还在吐英文`);
  }
});

test('认不出的形态 → 兜底话 + 原文(不吞排查信息)', () => {
  const msg = humanErrorMessage({ message: 'Something exotic happened' }, '导出失败');
  assert.match(msg, /导出失败/);
  assert.match(msg, /Something exotic happened/, '认不出就把原文带出来,不能吞掉');
  assert.equal(humanErrorMessage({}, '导出失败'), '导出失败');
  assert.equal(humanErrorMessage(null, '导出失败'), '导出失败');
});

test('接线:store 与审核台不再直接吐 error.message', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'frontend/src/stores/workbench.js',
    'frontend/src/stores/myTodos.js',
    'frontend/src/views/ReviewView.vue',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!code.includes('error.response?.data?.error || error.message'),
      `${rel} 还有直接吐 error.message 的写法`);
    assert.match(code, /humanErrorMessage/, `${rel} 应改走共用出口`);
  }
});
