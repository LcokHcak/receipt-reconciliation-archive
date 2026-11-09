const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 0730 P2 评审挖出、我逐条核实过的三个 P0 —— 合起来的后果是「画框功能一次也没通过」。
//
// P0-1 handleDocBoxDraw 读 workbench.batchId,而 store 里没有这个键(state 是
//      batches/currentBatch/tasks…,getter 只有 latestBatchId/metrics)→ 恒 undefined
//      → 函数当场 return,**保存请求从来没发出去过**,而且零报错。
// P0-2 整图任务的 originalImageUrl 是 ''(selectedOriginalImageUrl 对 isWholeImageTask 直接返回 ''),
//      而画框按钮 v-if="showOriginal && originalImageUrl" → 整图任务永远没有按钮。
//      切片任务有按钮,但后端 canAcceptManualBox 必拒。
//      → **能画的地方没按钮,有按钮的地方后端拒绝。**
// P0-3 前端用 taskGroupKey(客户级:sourceGroupKey/sourceFolderPath)回溯原图,
//      后端正确口径是 originalGroupKeyOf(每张照片级:目录+base)。
//      同一客户下多张整图时会取到**别的照片** → 在照片 X 上画的框存到照片 Y 上,零报错。
//
// 修法:originalImageUrl 由**后端**算好下发(按每张照片的口径),前端只消费。

const { buildOriginalImageUrl, isWholeImageTask } = require('../lib/task_original_image');

// 断言看的是**代码**,不是散文:这些修复的注释里会引用旧写法(「原来写的是 workbench.batchId」),
// 不剥注释的话正则会把说明文字也算成"还在用旧写法"。
const LINE_COMMENT = new RegExp('//[^\\n]*', 'g');
const stripComments = (s) => String(s).replace(LINE_COMMENT, '');

const toUrl = (batchId, rel) => (rel ? `/storage/${batchId}/${rel}` : '');

function makeBatch(tasks) {
  return { id: 'b1', tasks };
}

test('切片任务 → 指向同一张照片的整图兄弟', () => {
  const crop = {
    id: 't2', sourceOriginalPath: 'ws/c1/01-photoA_receipt_1.jpg',
    sourceImagePath: 'source/t2__01-photoA_receipt_1.jpg',
  };
  const orig = {
    id: 't1', sourceOriginalPath: 'ws/c1/01-photoA_original.jpg',
    sourceImagePath: 'source/t1__01-photoA_original.jpg',
    autoSplitRole: 'original',
  };
  const url = buildOriginalImageUrl(makeBatch([orig, crop]), crop, toUrl);
  assert.equal(url, '/storage/b1/source/t1__01-photoA_original.jpg');
});

test('⭐同一客户下有别的照片时,绝不能回溯到那一张(P0-3)', () => {
  // 关键:两张照片同属一个客户组,但 base 不同。按客户级键找会命中 photoB 的原图。
  const cropA = {
    id: 't2', sourceGroupKey: 'cust1',
    sourceOriginalPath: 'ws/c1/01-photoA_receipt_1.jpg',
    sourceImagePath: 'source/t2__01-photoA_receipt_1.jpg',
  };
  const origB = {
    id: 't9', sourceGroupKey: 'cust1',
    sourceOriginalPath: 'ws/c1/02-photoB_original.jpg',
    sourceImagePath: 'source/t9__02-photoB_original.jpg',
    autoSplitRole: 'original',
  };
  const url = buildOriginalImageUrl(makeBatch([origB, cropA]), cropA, toUrl);
  assert.ok(!url.includes('photoB'),
    `回溯到别的照片了:${url} —— 在照片 A 上画的框会存到照片 B 上`);
  // photoA 的整图不在批次里 → 退回按任务取图的端点,而不是给个错的
  assert.equal(url, '/api/batches/b1/tasks/t2/original-image');
});

test('⭐护照切片也要能回溯(别只认 receipt)', () => {
  const pass = {
    id: 't3', sourceOriginalPath: 'ws/c1/01-photoA_passport_1.jpg',
    sourceImagePath: 'source/t3__01-photoA_passport_1.jpg',
  };
  const orig = {
    id: 't1', sourceOriginalPath: 'ws/c1/01-photoA_original.jpg',
    sourceImagePath: 'source/t1__01-photoA_original.jpg',
    autoSplitRole: 'original',
  };
  assert.equal(buildOriginalImageUrl(makeBatch([orig, pass]), pass, toUrl),
    '/storage/b1/source/t1__01-photoA_original.jpg');
});

test('任务本身就是整图 → 空串(它不需要"另一张原图")', () => {
  const orig = {
    id: 't1', sourceOriginalPath: 'ws/c1/photo.jpg',
    sourceImagePath: 'source/t1__photo.jpg', preprocessMessage: 'no_split_detected',
  };
  assert.equal(buildOriginalImageUrl(makeBatch([orig]), orig, toUrl), '');
});

test('没有客户库引用 → 空串(不瞎给端点)', () => {
  const t = { id: 't1', sourceOriginalPath: '', sourceImagePath: 'source/t1__x.jpg' };
  assert.equal(buildOriginalImageUrl(makeBatch([t]), t, toUrl), '');
});

// ⚠️ 这条原来断言"前后端口径必须一致"——**那个前提是错的**,0731 查实并纠正:
// 前端 reviewDisplay.isOriginalLikeTask 判的是「整图**参考件**,不参与审核」,
// 本文件的 isWholeImageTask 判的是「文件是不是切片」。两者在"一图一单据"上结论相反。
// 现在改成钉住**它们必须保持分离**,防止有人再"统一"一次。
test('⭐两个判据必须保持分离 —— 合并会把真任务当参考件踢出审核流', () => {
  assert.equal(isWholeImageTask({ autoSplitRole: 'original' }), true);
  assert.equal(isWholeImageTask({ preprocessMessage: 'no_split_detected' }), true);
  assert.equal(isWholeImageTask({ preprocessMessage: 'keep_original' }), true);
  assert.equal(isWholeImageTask({ autoSplitRole: 'receipt' }), false);
  assert.equal(isWholeImageTask({}), false);

  // 决定性差异:一图一单据的真实任务(文件是整图、但没有任何 original 标记)——
  // 本函数说 true(文件是整图,能画框),而"参考件"判定必须说 false(它要审)。
  const realTask = { sourceImagePath: 'source/t1__photo.jpg' };
  assert.equal(isWholeImageTask(realTask), true, '文件是整图 → 能画框');

  // 前端那份不许长成本函数的样子(不许改成看文件名),否则真任务会被踢出审核流
  const feSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/lib/reviewDisplay.js'), 'utf8');
  const i = feSrc.indexOf('export function isOriginalLikeTask');
  const body = feSrc.slice(i, feSrc.indexOf('\n}', i));
  assert.ok(!body.includes('sourceImagePath'),
    '前端"参考件"判定改成看文件名了 —— 一图一单据的真任务会被整体踢出审核流');
  for (const token of ["role === 'original'", 'keep_original', 'no_split_detected']) {
    assert.ok(body.includes(token), `前端参考件判定少了 ${token}`);
  }
});

// ── 接线 ────────────────────────────────────────────────────────────────

test('⭐后端要把 originalImageUrl 下发到任务上', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/workbench_batch_response.js'), 'utf8');
  assert.ok(src.includes('buildOriginalImageUrl'), '响应层没算 originalImageUrl');
  assert.ok(src.includes('isOriginalImage'), '还要下发「这条任务本身就是整图」');
});

test('⭐前端不许再自己回溯原图(那份用的是客户级键,会取到别的照片)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  const i = src.indexOf('const selectedOriginalImageUrl');
  assert.notEqual(i, -1);
  // 改完之后它是一行式 computed,没有 `\n})` 结尾 —— 按行取,别把后面别处的代码卷进来
  const body = stripComments(src.slice(i, src.indexOf('\n', i)));
  assert.ok(!body.includes('taskGroupKey'), '还在用客户级键回溯 —— 会取到同客户的别张照片');
  assert.ok(body.includes('originalImageUrl'), '要改成消费后端下发的值');
});

test('⭐画框保存要用真的 batchId(store 里没有 workbench.batchId 这个键)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  const i = src.indexOf('async function handleDocBoxDraw');
  assert.notEqual(i, -1);
  const body = stripComments(src.slice(i, src.indexOf('\n}', i)));
  assert.ok(!/workbench\.batchId/.test(body),
    'workbench.batchId 恒为 undefined —— 保存请求根本发不出去,而且零报错');
  assert.ok(body.includes('currentBatch'), '要用 currentBatch');
});

test('⭐整图任务也要能画框 —— 它恰恰是唯一后端允许画的那一类', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
  const i = src.indexOf('class="draw-box-toggle"');
  const head = src.slice(Math.max(0, i - 400), i);
  assert.ok(head.includes('onOriginalView'),
    '画框按钮还只认 originalImageUrl → 整图任务永远没有按钮,而切片任务后端必拒');
  // 而 onOriginalView 必须真的把"任务本身就是整图"算进去,否则改了个名字没改行为
  const j = src.indexOf('const onOriginalView');
  const decl = src.slice(j, src.indexOf('))', j));
  assert.ok(decl.includes('props.isOriginalImage'), 'onOriginalView 没认整图任务');
});

// ── 金标全量实跑(2026-07-30,20 客户 / 83 张真实图)抓到的回归 ────────────
// 实测:83/83 任务的 autoSplitRole 和 preprocessMessage **都是空字符串**,
// 于是 isWholeImageTask 全判 false → buildOriginalImageUrl 一路走到端点兜底
// → originalImageUrl 非空 → imageUrl computed 直接换成 /original-image 直出。
// 后果就是 0727#11 那条:整图任务从 1600px 预览变成 /storage 直出 5-12MB,
// 而这批任务占真实业务数据的绝大多数。
//
// 正确判据不是"有没有标记",而是**这条任务的文件本身是不是切片**——
// 和 canAcceptManualBox 用的是同一个事实,也就不会两处漂。

test('⭐任务文件本身就是整图 → 不给 originalImageUrl(否则绕过预览直出原图)', () => {
  const whole = {
    id: 't1', sourceOriginalPath: 'ws/c1/photo.jpg',
    sourceImagePath: 'source/t1__photo.jpg',
    // 注意:没有 autoSplitRole,也没有 preprocessMessage —— 金标实跑里 83/83 都这样
  };
  assert.equal(buildOriginalImageUrl(makeBatch([whole]), whole, toUrl), '',
    '整图任务还给了 originalImageUrl —— 会绕过 1600px 预览直出原图(0727#11 重演)');
});

test('⭐整图任务要被标成 isOriginalImage(否则画框按钮的门开错了)', () => {
  assert.equal(isWholeImageTask({ sourceImagePath: 'source/t1__photo.jpg' }), true,
    '光看 autoSplitRole/preprocessMessage 不够 —— 真实数据里这俩常常是空的');
  assert.equal(isWholeImageTask({ sourceImagePath: 'source/t2__01-abc_receipt_1.jpg' }), false,
    '切片任务不能算整图');
  // 老标记仍然认(存量数据靠它)
  assert.equal(isWholeImageTask({ autoSplitRole: 'original' }), true);
  assert.equal(isWholeImageTask({ preprocessMessage: 'no_split_detected' }), true);
});

test('切片任务照旧给端点兜底(这条不能被上面两条改坏)', () => {
  const crop = {
    id: 't2', sourceOriginalPath: 'ws/c1/01-photoA_receipt_1.jpg',
    sourceImagePath: 'source/t2__01-photoA_receipt_1.jpg',
  };
  assert.equal(buildOriginalImageUrl(makeBatch([crop]), crop, toUrl),
    '/api/batches/b1/tasks/t2/original-image');
});
