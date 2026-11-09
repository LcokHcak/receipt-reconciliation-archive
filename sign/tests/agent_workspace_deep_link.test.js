'use strict';

// V2 Task11:深链构造 / returnTo 白名单 / stale 引用。
// 纯模块行为用 Node 直接验;各页面接线用源码断言锁住;浏览器实际定位归 Task 12 Playwright。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

async function loadLinks() {
  return import(pathToFileURL(path.join(root, 'frontend/src/lib/agentWorkspaceLinks.js')).href);
}

test('sanitizeReturnTo:只放行 /agents 前缀;拒绝出站/控制字符/其它站内路径', async () => {
  const { sanitizeReturnTo } = await loadLinks();

  // 放行:代理页含完整 query(月份/代理/游标)
  const good = '/agents?month=2026-07&agentKey=%E6%B0%B8%E4%B9%90&cursor=abc';
  assert.equal(sanitizeReturnTo(good), good);
  assert.equal(sanitizeReturnTo('/agents'), '/agents');

  // 拒绝:劫持面
  assert.equal(sanitizeReturnTo('http://evil.com/agents'), '');
  assert.equal(sanitizeReturnTo('https://evil.com'), '');
  assert.equal(sanitizeReturnTo('//evil.com'), '');
  assert.equal(sanitizeReturnTo('javascript:alert(1)'), '');
  assert.equal(sanitizeReturnTo(`/agents?x=${String.fromCharCode(1)}`), '');
  // 拒绝:白名单外站内路径(不做开放跳板)
  assert.equal(sanitizeReturnTo('/settings'), '');
  assert.equal(sanitizeReturnTo('/agentsX'), ''); // 前缀伪装
  assert.equal(sanitizeReturnTo(''), '');
  // 拒绝:.. / . 路径段穿越(复审 HIGH:/agents/../settings 曾放行)
  assert.equal(sanitizeReturnTo('/agents/../settings'), '');
  assert.equal(sanitizeReturnTo('/agents/../../evil'), '');
  assert.equal(sanitizeReturnTo('/agents/./x'), '');
});

test('白名单文件本体必须是纯文本(不许字面控制字节,否则 git 当二进制丢失可审计性)', () => {
  const src = read('frontend/src/lib/agentWorkspaceLinks.js');
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    assert.ok(code >= 32 || code === 10 || code === 13, `位置 ${i} 存在字面控制字节 ${code}`);
  }
  // 控制字符正则必须以转义序列形式存在
  assert.ok(src.includes('x00-') && src.includes('x1f'), '控制字符类应为 \\x00-\\x1f 转义写法');
});

test('buildReviewDeepLink:view 白名单兜底 queue;returnTo 过白名单;无批次返回 null', async () => {
  const { buildReviewDeepLink } = await loadLinks();

  // 「本批次按代理」已下线(2026-07-17):旧 view=agent 链接统一兜底 queue,定位参数保留
  const link = buildReviewDeepLink({
    batchId: 'b1', view: 'agent', group: 'CL-1', returnTo: '/agents?month=2026-07',
  });
  assert.deepEqual(link, {
    name: 'review',
    params: { batchId: 'b1' },
    query: { view: 'queue', group: 'CL-1', returnTo: '/agents?month=2026-07' },
  });

  // 非法 view → queue;恶意 returnTo → 丢弃
  const fallback = buildReviewDeepLink({ batchId: 'b1', view: 'hack', returnTo: 'http://evil.com' });
  assert.equal(fallback.query.view, 'queue');
  assert.ok(!('returnTo' in fallback.query));

  assert.equal(buildReviewDeepLink({ batchId: '' }), null);

  // 旧回发深链:view 兜底 queue,task 定位参数保留
  const sb = buildReviewDeepLink({ batchId: 'b1', view: 'sendback', task: 'wt_x' });
  assert.equal(sb.query.view, 'queue');
  assert.equal(sb.query.task, 'wt_x');
});

test('isRefPresent:空引用不算 stale;命中/未命中', async () => {
  const { isRefPresent, STALE_GROUP_MESSAGE, STALE_TASK_MESSAGE } = await loadLinks();
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.equal(isRefPresent(items, '', (x) => x.id), true);
  assert.equal(isRefPresent(items, 'a', (x) => x.id), true);
  assert.equal(isRefPresent(items, 'zz', (x) => x.id), false);
  assert.match(STALE_GROUP_MESSAGE, /客户组已变化/);
  assert.match(STALE_TASK_MESSAGE, /任务已变化/);
});

test('接线:ReviewView returnTo 回跳+stale 横幅;面板接定位参数', () => {
  const review = read('frontend/src/views/ReviewView.vue');
  // 「本批次按代理」已下线(2026-07-17):审核台单视图,不再消费 ?view= 切页签,
  // REVIEW_VIEWS/queueTab 引用必须清干净(残留=半拆状态)
  assert.doesNotMatch(review, /REVIEW_VIEWS/);
  assert.doesNotMatch(review, /queueTab/);
  assert.match(review, /sanitizeReturnTo\(route\.query\.returnTo\)/); // 白名单过滤
  // 返回按钮文案按 returnTo 的真实来源取(2026-08-01):原来硬编码「返回代理工作台」,
  // 而资料库的格式预检也往这儿深链,跳过来会说错地方。这条断言原本钉的就是那个硬编码。
  assert.match(review, /returnToLabel/, '文案走白名单同一张表,不各写各的');
  assert.match(review, /← 返回\{\{ returnToName \}\}/);
  assert.match(review, /deepLinkStaleMessage/); // stale 显式横幅

  // 代理工作台侧用统一构造器(不许手拼 query 漂移)
  const workspace = read('frontend/src/views/AgentWorkspaceView.vue');
  assert.match(workspace, /buildReviewDeepLink/);
  assert.match(workspace, /returnTo:\s*route\.fullPath/);
});
