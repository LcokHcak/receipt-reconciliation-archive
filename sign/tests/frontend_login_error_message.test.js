'use strict';

/**
 * 登录失败不许一律说「用户名或密码不正确」(2026-08-01)。
 *
 * 原实现是无条件的 `catch (_error) { this.error = '用户名或密码不正确' }` ——
 * 不看状态码、也不用后端已经给好的话。于是这些全被说成"你密码错了":
 *
 *   · **429 被限流锁住**(lib/auth/rate_limiter:同 IP 60 秒内失败 5 次)。
 *     这条最伤:锁定期间**输对密码也进不去** —— 请求在 rate_limiter 就被拦掉,
 *     根本到不了 userService.authenticate。而界面告诉他"密码不对",
 *     于是他继续换密码试,每试一次都刷不到新窗口,最后去找管理员
 *     重置一个**根本没坏的密码**。
 *   · ERR_NETWORK(服务没起来 / 网断)、502/504(网关)、登录接口的任何 500。
 *     整组人以为账号坏了,没人会去看服务状态。
 *
 * 后端其实一直准备着「登录尝试过多,请稍后重试」和 Retry-After 秒数,一次都没显示过。
 *
 * 这条测试直接跑前端那个纯函数,不靠扫源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 前端是 ESM;剥掉 import 后取出 describeLoginError。
// humanErrorMessage 用真实现(它是同一套口径,打桩就测不出接线对不对)。
function loadDescribe() {
  const helper = fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'lib', 'errorMessage.js'), 'utf8',
  ).replace(/^export /gm, '');
  const store = fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'stores', 'auth.js'), 'utf8',
  );
  // 只取 describeLoginError 那一段(store 其余部分依赖 pinia,不进来)
  const start = store.indexOf('function describeLoginError');
  assert.ok(start > 0, '找不到 describeLoginError —— 这条闸的取段方式失效了');
  const end = store.indexOf('\nexport const useAuthStore');
  const fn = store.slice(start, end > start ? end : store.length);
   
  return new Function(`${helper}\n${fn}\nreturn describeLoginError;`)();
}

const describeLoginError = loadDescribe();

test('⭐被限流锁住时不许说密码错,并且要说清"换密码没用"', () => {
  const msg = describeLoginError({
    response: { status: 429, data: { error: '登录尝试过多，请稍后重试', retryAfter: 43 }, headers: {} },
  });
  assert.doesNotMatch(msg, /密码不正确/, '429 不是密码问题');
  assert.match(msg, /43 秒/, '后端算好了还要等多久,必须带上 —— 否则人还是会乱试');
  assert.match(msg, /换密码没有用/,
    '必须点破"锁定期间密码对也进不去",这正是那个死循环的成因');
});

test('限流响应没带 retryAfter 时也要给出正确方向(别把没有的数编出来)', () => {
  const msg = describeLoginError({ response: { status: 429, data: {}, headers: {} } });
  assert.doesNotMatch(msg, /密码不正确/);
  assert.doesNotMatch(msg, /\d+ 秒/, '没有秒数就别写秒数');
  assert.match(msg, /换密码没有用/);
});

test('⭐401 才是唯一能说"用户名或密码不正确"的情况', () => {
  const msg = describeLoginError({ response: { status: 401, data: {}, headers: {} } });
  assert.match(msg, /用户名或密码不正确/);
});

test('⭐服务没起来 / 网断不许说成密码错', () => {
  const msg = describeLoginError({ code: 'ERR_NETWORK', message: 'Network Error' });
  assert.doesNotMatch(msg, /密码不正确/, '连不上服务器和密码无关');
  assert.doesNotMatch(msg, /Network Error/, '不许把 axios 的英文原样吐给用户');
});

test('⭐网关 / 500 不许说成密码错', () => {
  for (const status of [502, 503, 504, 500]) {
    const msg = describeLoginError({
      response: { status, data: {}, headers: {} },
      message: `Request failed with status code ${status}`,
    });
    assert.doesNotMatch(msg, /密码不正确/, `${status} 和密码无关`);
    assert.doesNotMatch(msg, /Request failed/, `${status}:不许吐英文原文`);
  }
});

test('后端明确给了业务话就原样用(不许被我们的口径盖掉)', () => {
  const msg = describeLoginError({
    response: { status: 401, data: { error: '该账号已停用,请联系管理员' }, headers: {} },
  });
  assert.equal(msg, '该账号已停用,请联系管理员');
});

test('⭐store 里不许再出现无条件的密码错文案', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'stores', 'auth.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /catch\s*\([^)]*\)\s*\{\s*this\.error\s*=\s*'用户名或密码不正确'/,
    'catch 里不许无条件写死密码错 —— 那正是这条 bug');
});

test('自检:限流那条的真话确实来自后端(不是我们编的)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'auth_routes.js'), 'utf8');
  assert.match(src, /登录尝试过多/,
    '后端要有这句话;它变了的话前端这套文案也要跟着核对一遍');
});
