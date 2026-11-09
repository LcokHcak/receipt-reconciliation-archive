const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('C3 unreceived view wires tabs, filters, batch action, and row resolution', () => {
  const source = read('frontend/src/views/v2/UnreceivedView.vue');
  assert.match(source, /getUnreceived/);
  // activeTab 断言已撤(lint 死代码清理):可切页签早已下线,视图只剩静态「未收」徽章锚点
  assert.match(source, /unreceived-known-tab/);
  assert.match(source, /selectedIds/);
  // B3: 处理动作必须落库(调真实接口),不再只 console.log + 本地消项
  assert.match(source, /resolveUnreceived\(workspaceKey\.value/);
  assert.doesNotMatch(source, /console\.log\(\{ type: 'resolve-unreceived'/);
  assert.match(source, /removeResolvedRows/);
  assert.match(source, /StatusBadge[^>]*variant="test"/);
});

test('L635 未收补录诚实反馈:notFound 如实告知未变更、不弹假成功、不乐观抹行', () => {
  const source = read('frontend/src/views/v2/UnreceivedView.vue');
  const fnStart = source.indexOf('async function batchBackfill');
  assert.ok(fnStart > 0, '应存在 batchBackfill');
  const body = source.slice(fnStart, fnStart + 1400);
  // 后端返回的 backfilled/notFound/skipped 必须被读取并据实反馈
  assert.match(body, /result\?\.backfilled/, '读取真实 backfilled 计数');
  assert.match(body, /result\?\.notFound/, '读取 notFound 明细');
  assert.match(body, /未找到对应行/, 'notFound 如实告知(未变更)');
  // 成功文案只在真有落库/跳过时给(不再无条件弹「已补录N条」)
  assert.match(body, /if \(bf > 0 \|\| skipped > 0\)/, '成功文案带 backfilled>0 守卫');
  // 不再无条件调 removeResolvedRows(...)(乐观抹行)——batchBackfill 体内不得再有该调用
  assert.doesNotMatch(body, /removeResolvedRows\(/, 'L635:batchBackfill 不再乐观移除未补上的行,列表以 loadUnreceived 为准');
});

test('SMG替换窗口:未收视图消费 importing 标志 → 横幅提示 + 导入中禁用导出(审计MEDIUM)', () => {
  const source = read('frontend/src/views/v2/UnreceivedView.vue');
  // 从后端 payload 读取 importing 标
  assert.match(source, /importing\.value = Boolean\(payload\.importing\)/);
  // 横幅 + 导入中禁用导出按钮
  assert.match(source, /data-testid="unreceived-importing-banner"/);
  assert.match(source, /:disabled="!totalRows \|\| importing"/);
});

test('C3 unreceived components expose table, filters, suggestions, and dialog', () => {
  const files = [
    'frontend/src/components/v2/UnreceivedTable.vue',
    'frontend/src/components/v2/UnreceivedFilters.vue',
    'frontend/src/components/v2/LinkSuggestion.vue',
    'frontend/src/components/v2/ResolutionDialog.vue',
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(file), true, file);
  }
  assert.match(read(files[0]), /emit\('link'/);
  assert.match(read(files[0]), /emit\('delay'/);
  assert.match(read(files[0]), /emit\('void'/);
  assert.match(read(files[1]), /priority_1/);
  assert.match(read(files[2]), /匹配度/);
  assert.match(read(files[3]), /处理原因/);
});

test('C3 unreceived mock includes bill-side orphan data and known missing receipts', async () => {
  const { getUnreceived } = await import('../frontend/src/mocks/v2/index.js');
  const data = getUnreceived('demo-2026-05');
  assert.ok(data.orphanBills.length >= 23);
  assert.ok((data.knownMissing || data.missingReceipts || []).length >= 1);
  assert.ok(data.orphanBills.some((bill) => bill.candidates.length >= 2));
  assert.ok(new Set(data.orphanBills.map((bill) => bill.priority)).size >= 6);
});
