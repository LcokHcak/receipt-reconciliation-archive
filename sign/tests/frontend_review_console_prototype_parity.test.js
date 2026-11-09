const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

async function loadReviewDisplay() {
  return import(pathToFileURL(path.join(
    projectRoot,
    'frontend/src/lib/reviewDisplay.js'
  )).href);
}

test('review inspector 主操作区:确认(主)+重拍(次)外露,删除收进「更多」菜单', () => {
  const source = read('frontend/src/views/ReviewView.vue');

  assert.match(source, /review-primary-actions/);
  assert.match(source, /appendImageInputRef/);
  assert.match(source, /handleAppendImages/);
  assert.match(source, /type="file"/);
  assert.match(source, /'确认'/); // 确认按钮标签(合并结算后为动态:处理中…/确认)
  assert.match(source, /重拍 <span class="kbd-hint">R<\/span>/);
  assert.match(source, /追加图片/);
  // 2026-07-27 设计整改:删除是破坏性操作,一天点几百次确认的界面不该让它贴着主按钮
  assert.match(source, /删除这张图/, '删除收进「更多」菜单');
  assert.ok(!/class="danger-ghost-button"[^>]*deleteSelectedTask/.test(source), '删除不再是主操作区的外露按钮');
  // 快检结果与确认按钮联动:没过时降级为描边(不再是"闭眼按"的蓝色实心)
  assert.match(source, /fieldsQuickCheckPassed/);
  assert.match(source, /confirm-cta-caution/);
});

test('review page keeps the top chrome compact and moves ledger import into page actions', () => {
  const source = read('frontend/src/views/ReviewView.vue');

  assert.doesNotMatch(source, /<Breadcrumb/);
  assert.doesNotMatch(source, /from '..\/components\/Breadcrumb.vue'/);
  assert.doesNotMatch(source, /class="batch-actions-bar"/);
  assert.doesNotMatch(source, /去待补救处理/);
  assert.doesNotMatch(source, /查看台账/);

  const pageActions = source.match(/<div class="page-actions">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(pageActions, /<BatchSelector/);
  assert.match(pageActions, /importLedgerAndMatch/);
  assert.match(pageActions, /结算本批次/);
  assert.match(pageActions, /<MoreMenu/);
  assert.ok(
    pageActions.indexOf('<BatchSelector') < pageActions.indexOf('importLedgerAndMatch')
      && pageActions.indexOf('importLedgerAndMatch') < pageActions.indexOf('<MoreMenu'),
    'ledger import should sit between batch selector/refresh and MoreMenu',
  );
});

test('passport signature display is embedded in the field inspector like the prototype', () => {
  const reviewSource = read('frontend/src/views/ReviewView.vue');
  const signatureSource = read('frontend/src/components/SignatureEditor.vue');

  const fieldScroll = reviewSource.match(/<div[^>]*class="review-field-scroll"[^>]*>([\s\S]*?)<\/div>\s*<div class="review-action-dock">/)?.[1] || '';
  assert.match(fieldScroll, /<FieldEditor/);
  assert.match(fieldScroll, /<SignatureEditor/);
  assert.match(signatureSource, /签字展示/);
  assert.match(signatureSource, /signature-display/);
  assert.doesNotMatch(signatureSource, /class="panel signature-panel"/);
});

test('跳票不再闪动误点:表态块聚焦 preventScroll + 换票滚回顶部 + 改类型有数据先确认(2026-07-13 防回归)', () => {
  const stance = read('frontend/src/components/ReceiptStanceBlock.vue');
  const review = read('frontend/src/views/ReviewView.vue');
  const fieldEditor = read('frontend/src/components/FieldEditor.vue');

  // ① 表态块聚焦团号输入框必须 preventScroll,否则浏览器补滚导致面板"往上跳",按钮错位误点
  assert.match(stance, /tourInputRef\.value\?\.focus\?\.\(\{\s*preventScroll:\s*true/);
  // ② 换票时把字段滚动容器归零(配合 preventScroll 双保险)
  assert.match(review, /fieldScrollRef/);
  assert.match(review, /class="review-field-scroll"/);
  // ③ 改类型(破坏性,清空 OCR 字段不可逆)在已有识别数据时必须先 window.confirm——两个入口都要
  assert.match(stance, /async function retype\([\s\S]*?window\.confirm\(/);
  assert.match(review, /async function changeDocType\([\s\S]*?window\.confirm\(/);
  // ④ FieldEditor 聚焦同类反模式加固:preventScroll,不用 smooth 动画
  assert.match(fieldEditor, /focus\?\.\(\{\s*preventScroll:\s*true/);
  assert.doesNotMatch(fieldEditor, /scrollIntoView\?\.\(\{[^}]*behavior:\s*'smooth'/);
});

test('review queue exposes customer-group filters and friendly task names', () => {
  const source = read('frontend/src/components/GroupedTaskList.vue');

  assert.match(source, /customerNameById/);
  assert.match(source, /queueFilters/);
  assert.match(source, /activeFilter/);
  assert.match(source, /['"]全部['"]/);
  assert.match(source, /['"]待处理['"]/);
  assert.match(source, /['"]需重拍['"]/);
  assert.match(source, /['"]已通过['"]/);
  assert.match(source, /friendlyTaskName/);
});

test('queue time helpers format relative time and derive group creation time', async () => {
  const { formatQueueTime, groupCreatedAt, fullTimestamp } = await loadReviewDisplay();
  const base = Date.parse('2026-07-08T12:00:00Z');
  const iso = new Date(base).toISOString();

  // 相对时间分档(nowMs 注入,与时区无关)
  assert.equal(formatQueueTime(iso, base + 30 * 1000), '刚刚');
  assert.equal(formatQueueTime(iso, base + 8 * 60 * 1000), '8分钟前');
  assert.equal(formatQueueTime(iso, base + 3 * 3600 * 1000), '3小时前');
  // 超 24h → MM-DD HH:mm(本地时区解析+格式化,自洽)
  assert.match(formatQueueTime('2026-07-08T14:23:00', base + 40 * 3600 * 1000), /^07-08 14:23$/);
  // 无效时间返回空串
  assert.equal(formatQueueTime('', base), '');
  assert.equal(formatQueueTime('not-a-date', base), '');

  // 组时间 = 组内最早一张图的 createdAt;缺失/空组返回空串
  assert.equal(
    groupCreatedAt([
      { createdAt: '2026-07-08T12:05:00Z' },
      { createdAt: '2026-07-08T12:01:00Z' },
      { createdAt: '' },
    ]),
    '2026-07-08T12:01:00Z',
  );
  assert.equal(groupCreatedAt([]), '');

  // 完整时间戳(悬停提示)
  assert.match(fullTimestamp('2026-07-08T14:23:45'), /^2026-07-08 14:23:45$/);
  assert.equal(fullTimestamp(''), '');
});

test('per-ticket stance helpers: lock/exempt/sort behave per spec', async () => {
  const { isTaskStanceLocked, isTourExemptTask, sortTasksForReview, tourConfirmPendingCount } = await loadReviewDisplay();
  const receipt = (extra = {}) => ({ docTypeFinal: 'receipt', ...extra });
  // 锁定:小票+非豁免+未表态
  assert.equal(isTaskStanceLocked(receipt()), true);
  assert.equal(isTaskStanceLocked(receipt({ tourStance: 'matched' })), false);
  assert.equal(isTaskStanceLocked(receipt({ tourStance: 'none' })), false);
  // 护照/其它永不锁
  assert.equal(isTaskStanceLocked({ docTypeFinal: 'passport' }), false);
  // 豁免:机场"无"/百货 canonical 与原始文字
  assert.equal(isTourExemptTask(receipt({ groupNoAuto: '无' })), true);
  assert.equal(isTourExemptTask(receipt({ receiptStoreFinal: 'LOTTE_DEPT' })), true);
  assert.equal(isTourExemptTask(receipt({ receiptStoreAuto: '乐天百货' })), true);
  assert.equal(isTourExemptTask(receipt({ receiptStoreFinal: 'LOTTE' })), false);
  // 排序:护照→小票→其它,原图殿后,同类稳定
  const sorted = sortTasksForReview([
    { id: 'r1', docTypeFinal: 'receipt' },
    { id: 'p1', docTypeFinal: 'passport' },
    { id: 'o1', docTypeFinal: 'other' },
    { id: 'orig', docTypeFinal: 'receipt', autoSplitRole: 'original' },
    { id: 'r2', docTypeFinal: 'receipt' },
  ]);
  assert.deepEqual(sorted.map((t) => t.id), ['p1', 'r1', 'r2', 'o1', 'orig']);
  // 待匹配组数:按"存在未表态小票"的组去重
  assert.equal(tourConfirmPendingCount([
    receipt({ sourceGroupKey: 'g1' }),
    receipt({ sourceGroupKey: 'g1', tourStance: 'matched' }),
    receipt({ sourceGroupKey: 'g2', tourStance: 'none' }),
    { docTypeFinal: 'passport', sourceGroupKey: 'g3' },
  ]), 1);
});

test('sortReviewGroups orders groups by time and pending-first mode with deterministic tie-break', async () => {
  const { sortReviewGroups } = await loadReviewDisplay();
  const G = (label, createdAt, pendingCount = 0, rephotoCount = 0) => ({ label, createdAt, pendingCount, rephotoCount });
  const groups = [
    G('b', '2026-07-08T12:02:00Z', 0),       // 已通过(无待审)
    G('a', '2026-07-08T12:05:00Z', 2),       // 待审
    G('c', '2026-07-08T12:01:00Z', 0, 1),    // 需重拍(算待审)
  ];

  // newest:创建时间降序
  assert.deepEqual(sortReviewGroups(groups, 'newest').map((g) => g.label), ['a', 'b', 'c']);
  // oldest:创建时间升序
  assert.deepEqual(sortReviewGroups(groups, 'oldest').map((g) => g.label), ['c', 'b', 'a']);
  // pendingFirst:有待审工作的组(a,c)在前(组内按时间降序 a>c),已通过(b)沉底
  assert.deepEqual(sortReviewGroups(groups, 'pendingFirst').map((g) => g.label), ['a', 'c', 'b']);

  // 时间相同 → 按 label 兜底,确定性
  const tie = [G('z', '2026-07-08T12:00:00Z'), G('m', '2026-07-08T12:00:00Z'), G('a', '2026-07-08T12:00:00Z')];
  assert.deepEqual(sortReviewGroups(tie, 'newest').map((g) => g.label), ['a', 'm', 'z']);

  // 不改原数组
  const original = [G('a', '2026-07-08T12:00:00Z'), G('b', '2026-07-08T12:01:00Z')];
  const snapshot = original.map((g) => g.label);
  sortReviewGroups(original, 'newest');
  assert.deepEqual(original.map((g) => g.label), snapshot);
});

test('review display helpers prefer customer names and hide raw mojibake filenames', async () => {
  const {
    buildReviewGroupDisplay,
    friendlyTaskName,
    parseSourceReference,
  } = await loadReviewDisplay();

  const task = {
    id: 'task_0001',
    sourceOriginalPath: '20260514客户导入/CL20260514-001/images/乱码文件名.jpg',
    sourceFolderName: 'CL20260514-001',
    sourceGroupLabel: 'CL20260514-001',
    docTypeFinal: 'receipt',
    autoSplitRole: 'region',
  };

  assert.deepEqual(parseSourceReference(task), {
    workspaceKey: '20260514客户导入',
    customerId: 'CL20260514-001',
  });
  assert.deepEqual(buildReviewGroupDisplay(task, { 'CL20260514-001': 'AYC' }), {
    name: 'AYC',
    id: 'CL20260514-001',
  });
  assert.equal(friendlyTaskName(task, 2), '切图-小票-2');
  assert.equal(friendlyTaskName({ ...task, autoSplitRole: '', preprocessMessage: 'split_failed_keep_original' }, 1), '原图');
});

test('workbench store can append images to the selected review customer group', () => {
  const source = read('frontend/src/stores/workbench.js');

  assert.match(source, /appendCustomerImages/);
  assert.match(source, /appendImagesToSourceGroup/);
  assert.match(source, /batchId:\s*this\.currentBatch\.id/);
  assert.match(source, /appendedTasks/);
});

// ── 0801:破坏性操作的话术必须说清"不可逆" ──────────────────────────────────
test('⭐删除这张图:确认弹窗要说清删哪张 + 不可逆 + 墓碑(代码就是硬删,话不能软)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const view = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  const fn = /async function deleteSelectedTask\(\)[\s\S]*?\n\}/.exec(view);
  assert.ok(fn, '没定位到 deleteSelectedTask');
  const body = fn[0];
  assert.match(body, /selectedTaskFriendlyName/, '要说删的是哪一张(菜单里点的,视线不在图上)');
  assert.match(body, /不可逆/, '要说不可逆');
  assert.match(body, /不会自己回来/, '要说墓碑的后果(补图/追加时这张不会回来)');
  assert.match(body, /先把新的那条建好、验过,再回来删这条/, '给出更安全的顺序');
  assert.doesNotMatch(body, /confirm\('确认删除当前文件？'\)/, '旧的一句话文案不许回来');

  // 后端确实是硬删 + 墓碑,话术不是吓唬人
  const backend = fs2.readFileSync(path2.join(__dirname, '../services/workbench_write/task.js'), 'utf8');
  assert.match(backend, /removeTaskArtifacts\(batch\.id, task, batch\.tasks\)/, '文件真的删了');
  assert.match(backend, /batch\.deletedSourcePaths = tombstones/, '墓碑真的写了');
});
