'use strict';

// 交付护栏判定前移到审核阶段(0730)。
//
// 现状是反的:护栏在**导出时**才体现(写进「导出说明.txt」),审核链路里零出口。
// 于是操作员的顺序是:审完 → 结算 → 导出 → 读那张纸发现有图没进包 → 回审核台找那几条 → 修 → 重导。
// 判定逻辑一个字没新写(还是 planDeliveryImage),这里只把结果提前送到审核台。

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDeliveryImagePlan } = require('../lib/workbench_batch_response');
const { createDeliveryImagePlanner } = require('../lib/delivery_render');

const receipt = (over) => ({ docTypeFinal: 'receipt', ...over });

test('⭐照旧出图 → 返回 null,界面什么都不显示(不制造噪音)', () => {
  const batch = { tasks: [receipt({ id: 'r1', sourceImagePath: 'source/01-a_receipt_1.jpg', sourceOriginalPath: 'ws/c/01-a_receipt_1.jpg' })] };
  const planFor = createDeliveryImagePlanner(batch);
  assert.equal(buildDeliveryImagePlan(planFor, batch.tasks[0]), null);
});

test('⭐⭐被拦 → 带人话理由,审核时就能看见(以前要等导出后读那张纸)', () => {
  const batch = {
    tasks: [
      receipt({ id: 'r1', sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg' }),
      receipt({ id: 'r2', sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg' }),
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  const plan = buildDeliveryImagePlan(planFor, batch.tasks[0]);
  assert.equal(plan.action, 'block');
  assert.equal(plan.reason, 'duplicate_image_no_box');
  assert.ok(plan.hint.includes('分不出哪块是哪张票'), `hint 要是人话,实为:${plan.hint}`);
  assert.doesNotMatch(plan.hint, /^[a-z_]+$/, '不能把英文 reason 甩给操作员');
});

test('画完框 → action 变 crop,并说清交付时会裁', () => {
  const batch = {
    tasks: [
      receipt({ id: 'r1', sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg', detectionBox: [0.02, 0.1, 0.44, 0.9] }),
      receipt({ id: 'r2', sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg', detectionBox: [0.56, 0.1, 0.98, 0.9] }),
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  const plan = buildDeliveryImagePlan(planFor, batch.tasks[0]);
  assert.equal(plan.action, 'crop');
  assert.ok(plan.hint.includes('按框裁'), plan.hint);
});

test('⭐护照/机票不算 —— 它们不按票号单独出图,算了只会平白多一块红', () => {
  // ⚠️ 夹具必须是「去掉 docType 闸就会真的算出非 as-is」的形状,否则这条测试是空的。
  // 第一版我用了两本没框的护照 —— 那种情况判定本来就返回 as-is,
  // 把闸拆掉照样过,通过的理由是错的(验红时抓到)。
  // 现在:护照指向整图、自己有框、同图还有一张小票的框 → 拆掉闸就会算出 crop。
  const batch = {
    tasks: [
      {
        id: 'p1', docTypeFinal: 'passport',
        sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg',
        detectionBox: [0.02, 0.05, 0.44, 0.4],
      },
      receipt({
        id: 'r1',
        sourceImagePath: 'source/shared.jpg', sourceOriginalPath: 'ws/c/shared.jpg',
        detectionBox: [0.56, 0.5, 0.98, 0.95],
      }),
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  // 先证明这个夹具确实"有东西可算"(否则下一行的 null 又是白过)
  const rawPlan = planFor(batch.tasks[0]);
  assert.notEqual(rawPlan.action, 'as-is', '夹具要能触发非 as-is,否则这条测试是空的');
  // 但因为它是护照,前移到审核台的判定应当直接跳过
  assert.equal(buildDeliveryImagePlan(planFor, batch.tasks[0]), null, '护照不该出现交付判定提示');
});

test('planner 抛错不得让整个响应炸 —— 审核台不能因为一条判定挂掉', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(buildDeliveryImagePlan(boom, receipt({ id: 'x' })), null);
});

test('接线:summarizeBatch 整批只建一次 planner(否则 O(n²))', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../lib/workbench_batch_response.js'), 'utf8');
  assert.ok(src.includes('const deliveryPlanner = createDeliveryImagePlanner(batch)'), '批量路径建一次');
  assert.ok(src.includes('deliveryImagePlan: buildDeliveryImagePlan(planFor, task)'), '挂到任务上');
});

test('⭐前端接线:被拦的要标红橙,而且给全批计数 + 跳转', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  assert.ok(src.includes('delivery-plan-bar'), '要有提示条');
  assert.ok(src.includes('这张图进不了交付包'), '被拦要说清后果,不是术语');
  assert.ok(src.includes('selectedDeliveryPlan.hint'), '人话理由要显示出来');
  // 别让人一条条点着才发现全批有几条
  assert.ok(src.includes('blockedImageCount'), '要有全批计数');
  assert.ok(src.includes('function gotoFirstBlockedImage'), '要能一键跳到第一条');
  // block=红橙(硬规则:红橙=要处理);crop 是正常路径,不该抢注意力
  const i = src.indexOf('.delivery-plan-bar.block {');
  assert.notEqual(i, -1, 'block 要有独立样式');
  const block = src.slice(i, src.indexOf('}', i));
  assert.match(block, /#fef2f2|#fecaca/, 'block 用红橙');
})

test('⭐⭐提示条必须包在中栏容器里 —— 直接当 grid 兄弟会把右侧字段栏挤出屏幕', () => {
  // 0730 生产截图实证的严重回归:审核台三栏是
  //   grid-template-columns: 280px minmax(420px, 1fr) 380px
  // 写死的三列。我把 .delivery-plan-bar 作为 ImageViewer 的兄弟插进去,
  // 它成了**第 4 个 grid item**,右侧 .review-inspector 被挤到网格定义之外 ——
  // 凡是有交付判定的任务,**审核员看不到字段编辑栏、没法改字段**。
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vue = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  const colAt = vue.indexOf('<div class="review-image-col">');
  assert.notEqual(colAt, -1, '中栏要有包裹容器');
  const barAt = vue.indexOf('class="delivery-plan-bar"');
  const viewerAt = vue.indexOf('class="review-image-panel"');
  assert.ok(colAt < barAt && colAt < viewerAt, '提示条和图都要在容器**里面**');

  const css = fs2.readFileSync(path2.join(__dirname, '../frontend/src/style.css'), 'utf8');
  assert.ok(css.includes('.review-image-col {'), '容器要有样式');
  assert.ok(css.includes('.review-image-col > .delivery-plan-bar { flex: none; }'), '提示条不抢高度');
  // 图在 flex 列里不能再用 100vh 定高,否则加上提示条就溢出
  assert.ok(css.includes('.review-image-col > .review-image-panel { flex: 1; min-height: 0; height: auto; }'),
    '图要改成 flex:1 + height:auto');
  // 窄屏断点也要带上新容器,否则窄屏下它仍定死 100vh
  const bp = css.indexOf('.review-queue-panel,\n  .review-image-col,');
  assert.notEqual(bp, -1, '窄屏断点要一起放开高度');
});
