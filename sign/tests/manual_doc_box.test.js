'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeManualBox, canAcceptManualBox, MIN_BOX_AREA, MAX_BOX_AREA,
} = require('../lib/manual_doc_box');
const { planDeliveryImage } = require('../lib/delivery_render');

test('正常拖框:规整成 [x1,y1,x2,y2],倒着拖也认', () => {
  assert.deepEqual(normalizeManualBox([0.1, 0.2, 0.5, 0.8]).box, [0.1, 0.2, 0.5, 0.8]);
  // 从右下往左上拖
  assert.deepEqual(normalizeManualBox([0.5, 0.8, 0.1, 0.2]).box, [0.1, 0.2, 0.5, 0.8]);
});

test('⭐误触画出的点不收,而且要说人话', () => {
  const r = normalizeManualBox([0.5, 0.5, 0.505, 0.505]);
  assert.equal(r.box, undefined);
  assert.ok(r.error.includes('误触'), `错误要说清怎么办,实为:${r.error}`);
  assert.ok(r.error.includes('整张单据'));
});

test('⭐框住几乎整张图 → 拒收(那样交付照样出整图,等于没框)', () => {
  const r = normalizeManualBox([0.01, 0.01, 0.99, 0.99]);
  assert.equal(r.box, undefined);
  assert.ok(r.error.includes('整图'), r.error);
  assert.ok(MAX_BOX_AREA < 1);
});

test('极细长条:面积够但一边太短 → 拒收', () => {
  // 0.005 宽 × 1 高 = 面积 0.005 刚好过面积闸,但宽只有 0.5%
  const r = normalizeManualBox([0.5, 0, 0.505, 1]);
  assert.equal(r.box, undefined);
  assert.ok(r.error.includes('太窄'), r.error);
});

test('⭐超出图片范围 / 非数字 → 拒收,不静默修正', () => {
  // 判据:悄悄把荒谬的框改成"合理"的,操作员会以为自己框对了
  assert.ok(normalizeManualBox([-0.5, 0, 0.5, 1]).error.includes('超出'));
  assert.ok(normalizeManualBox([0, 0, 1.5, 1]).error.includes('超出'));
  assert.ok(normalizeManualBox([0, 0, 'x', 1]).error.includes('非数字'));
  assert.ok(normalizeManualBox([0, 0, 1]).error.includes('格式'));
  assert.ok(normalizeManualBox(null).error.includes('格式'));
});

test('浮点毛刺容忍:1.0000001 当 1', () => {
  const r = normalizeManualBox([0, 0, 1.0000001, 0.9]);
  assert.ok(r.box, r.error);
  assert.equal(r.box[2], 1);
});

test('⭐指向切片的任务不能手画框 —— 坐标系根本不同', () => {
  // 生产上那 2 条 duplicate_crop_file 卡在这儿
  const r = canAcceptManualBox({ sourceImagePath: 'source/task_0103__1002-abc_receipt_1.jpg' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('对不上'), r.error);
  // ⚠️ 拒绝理由必须指向**真的存在的操作**。原来写「需要先把它改回指向原图」——
  // 那个操作不存在,等于又给人指一个做不到的动作(0730 上午刚修过同一类毛病)。
  assert.ok(!r.error.includes('改回指向原图'), '不能指向不存在的操作');
  assert.ok(r.error.includes('按店重切'), '要给出他真的能做的路');
  // 0731:「补小票」这条**同样做不到**,而且这个错误信念被钉在三个文件里,
  // 所以它一直没被戳破。证据是拿真批次跑出来的:
  //   119 条任务里 7 条是切片任务 → 7 条**全都**没有整图兄弟任务
  //   (qwen 流程原图 reference 不进批次),所以「去原图那条任务上补小票」无处可去;
  //   退一步就算在另一条切片任务上补票也没用 —— createManualReceiptTaskFromSource
  //   照抄源任务的 sourceImagePath,新任务还是切片、还是不能框。
  // 等 P2-a(补票时把原图拷进批次)落地,这条才会变成真话,到时再加回来。
  // P2-a 之后补小票会把整张原图拷进批次,补出来的任务能画框 —— 这句话才成立。
  // 端到端证据在 tests/manual_receipt_from_original.test.js:
  // 拷进批次的新路径必须真的过 canAcceptManualBox。
  assert.ok(r.error.includes('补小票'), '补小票现在是真能走的路了');
  assert.ok(!r.error.includes('原图那条任务'),
    '但说法必须是"就在这条上补" —— "原图那条任务"在 qwen 流程里不存在');
});

test('指向整图的任务可以框(那 4 条 duplicate_image_no_box 就是这种)', () => {
  assert.equal(canAcceptManualBox({ sourceImagePath: 'source/task_0001__01-abc.jpg' }).ok, true);
});

test('没有图片的任务不能框', () => {
  assert.equal(canAcceptManualBox({}).ok, false);
  assert.equal(canAcceptManualBox({ sourceImagePath: '  ' }).ok, false);
});

test('⭐⭐端到端:画完框后交付计划从 block 变 crop', () => {
  // 这条是整个第 2 期的意义所在 —— 导出说明里那句「框出各自的范围后重新导出」
  // 在这个功能之前是做不到的。
  const before = planDeliveryImage({
    task: { sourceImagePath: 'source/shared.jpg' },
    sharesImageFile: true,
  });
  assert.equal(before.action, 'block');
  assert.equal(before.reason, 'duplicate_image_no_box');

  const drawn = normalizeManualBox([0.02, 0.1, 0.44, 0.9]);
  assert.ok(drawn.box, drawn.error);
  const after = planDeliveryImage({
    task: { sourceImagePath: 'source/shared.jpg', detectionBox: drawn.box },
    sharesImageFile: true,
    siblingBoxes: [{ left: 0.56, top: 0.1, width: 0.42, height: 0.8 }],
  });
  assert.equal(after.action, 'crop', '画完框就该能出图了');
  assert.ok(after.rect.x2 < 1, '而且是裁过的,不是整图');
});

test('面积闸的两个常数是真的在用(不是摆设)', () => {
  assert.ok(MIN_BOX_AREA > 0 && MIN_BOX_AREA < 0.05);
  // 刚好卡在闸上的框应该过
  const side = Math.sqrt(MIN_BOX_AREA) + 0.001;
  assert.ok(normalizeManualBox([0.1, 0.1, 0.1 + side, 0.1 + side]).box);
});

// ── 响应层白名单(0730 生产实测抓到)──────────────────────────────────
// 手画框实测:框**已经落盘**(SSH 到服务器读 batch.json 确认),但 API 响应里没有
// → 操作员画完框看不到任何确认,以为没生效。根因是 lib/workbench_normalizers.js
// 是个**字段白名单**,不在名单里的字段读不回前端;漏字段不报错,只会让功能像"没做"。

test('⭐响应白名单必须带上文档框字段,否则画完框界面看不到', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../lib/workbench_normalizers.js'), 'utf8');
  for (const field of ['detectionBox', 'manualBox', 'docBoxSource']) {
    assert.ok(src.includes(`${field}:`), `${field} 不在响应白名单里 —— 前端读不到`);
  }
  // detectionBox 是数组,别被 `|| ''` 漂成空串(文档框读它时会当成没有框)
  assert.ok(src.includes('detectionBox: Array.isArray(task.detectionBox) ? task.detectionBox : null'),
    'detectionBox 要按数组归一,不能用 || \'\' 漂成空串');
});

test('⭐传 null / [] = 清除(画错了要能撤销,不能只让人覆盖)', () => {
  const { isClearRequest } = require('../lib/manual_doc_box');
  assert.equal(isClearRequest(null), true);
  assert.equal(isClearRequest(undefined), true);
  assert.equal(isClearRequest([]), true);
  assert.equal(isClearRequest([0.1, 0.2, 0.3, 0.4]), false);
  assert.equal(isClearRequest([0.1]), false, '残缺数组不是清除,应该走校验被打回');
});

test('清除路径要真的删字段,不是写个空值', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/workbench_write/task.js'), 'utf8');
  assert.ok(src.includes('delete task.manualBox'), '留个空值会让「有没有人工框」判不清');
  assert.ok(src.includes('delete task.detectionBox'));
  assert.ok(src.includes('delete task.docBoxSource'));
});

// ── 死路 UI(0730 用户实测踩到)────────────────────────────────────────
// 他在一条指向切片文件的任务上点「画框」→ 后端 400 拒绝,
// 而**按钮一直是可点的** → 点了、失败了、提示没变,以为系统坏了。
// 做不到的时候按钮必须置灰,并把后端给的原因放在悬停上。

test('⭐canDrawBox 要随任务下发,规则的单一真相源在后端', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../lib/workbench_batch_response.js'), 'utf8');
  assert.ok(src.includes("require('./manual_doc_box')"), '响应层要引入判断');
  assert.ok(src.includes('canDrawBox: canAcceptManualBox(task)'), '要挂到任务上');

  const vue = fs2.readFileSync(path2.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
  // 前端只消费,不许复制规则(复制就会漂)
  assert.ok(!vue.includes('SPLIT_FILE_RE'), '前端不能自己判断切片文件名');
  assert.ok(vue.includes('props.task?.canDrawBox'), '前端读后端下发的结果');
  assert.ok(vue.includes(':disabled="!canDrawBox.ok"'), '做不到就置灰,不能还可点');
  assert.ok(vue.includes(':title="drawBoxTitle"'), '悬停要说明为什么不行');
  assert.ok(vue.includes("'画框(这条不行)'"), '按钮文字本身就要说清');
  // 置灰要用灰阶而不是红 —— 红色会让人以为"点这里能解决",而它恰恰不能
  const i = vue.indexOf('.draw-box-toggle.is-blocked');
  assert.notEqual(i, -1, '要有置灰样式');
  const block = vue.slice(i, vue.indexOf('}', i));
  assert.ok(block.includes('#98a2b3') || block.includes('#f9fafb'), '置灰用灰阶');
  assert.ok(block.includes('not-allowed'), '光标也要表明点不了');
});

test('旧后端没下发 canDrawBox 时保守当"能"(不倒退成全部不可用)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vue = fs2.readFileSync(path2.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
  const i = vue.indexOf('const canDrawBox = computed');
  const block = vue.slice(i, i + 300);
  assert.ok(block.includes("return { ok: true, error: '' }"), '缺字段时默认可用');
});
