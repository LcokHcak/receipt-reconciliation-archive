'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  planDeliveryImage,
  computeCropRect,
  isAlreadyCropped,
  fullyContains,
  toPixelRect,
  describeBlock,
  DEFAULT_PAD_RATIO,
} = require('../lib/delivery_render');

const box = (left, top, width, height) => ({ left, top, width, height });
// 任务上的框是模型给的 [x1,y1,x2,y2]
const det = (x1, y1, x2, y2) => [x1, y1, x2, y2];

// ————————————————————————————————————————————————
// 一、行为零变化的两类(今天所有任务都走这两条,不能被改坏)
// ————————————————————————————————————————————————

test('已经物理裁过的切片 → 照旧用原文件', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/03-abc_receipt_2.jpg', detectionBox: det(0, 0, 0.5, 1) },
    siblingBoxes: [box(0.5, 0, 0.5, 1)],
  });
  assert.equal(plan.action, 'as-is', '切片文件就是那张单据,交付行为一个字不能变');
  assert.equal(plan.reason, 'already_cropped');
});

test('整图直通且图上只有它一张 → 照旧(百货就是这种)', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg' },
    siblingBoxes: [],
  });
  assert.equal(plan.action, 'as-is');
  assert.equal(plan.reason, 'single_document');
});

test('isAlreadyCropped 认得四种切片角色,也认得反斜杠路径', () => {
  for (const role of ['receipt', 'passport', 'region', 'other']) {
    assert.equal(isAlreadyCropped({ sourceImagePath: `ws/c/01-b_${role}_1.jpg` }), true, role);
  }
  assert.equal(isAlreadyCropped({ sourceImagePath: 'ws\\c\\01-b_receipt_1.jpg' }), true, '反斜杠也要认');
  assert.equal(isAlreadyCropped({ sourceImagePath: 'ws/c/photo.jpg' }), false);
  assert.equal(isAlreadyCropped({}), false);
});

// ————————————————————————————————————————————————
// 二、堵的那个洞:同图多任务但没框
// ————————————————————————————————————————————————

test('⭐整图 + 有兄弟框 + 自己没框 → **照旧出图,不拦**', () => {
  // 第一版这里是 block,生产回放测出误拦 29%(14971/51371)。它不只是太严,而是冗余:
  // 真正危险的「两条记录出同一张图」一定表现为共用同一个图片文件,已被上面那条精确抓住。
  // 护栏错拦会让交付包少图,而少图同样是事故 —— 所以这条改成保守放行。
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg' },
    siblingBoxes: [box(0, 0, 0.45, 1)],
  });
  assert.equal(plan.action, 'as-is');
  assert.equal(plan.reason, 'no_box_keep_current');
});

test('⭐切片文件名带 task_XXXX__ 前缀也要认出来(批次里的真实形态)', () => {
  // 批次里是 source/task_0103__1002-<hash>_receipt_1.jpg,客户库里是 1002-<hash>_receipt_1.jpg。
  // 按开头锚定会把每一条真实切片都判成「不是切片」—— 这就是那次 29% 误拦的根因。
  assert.equal(isAlreadyCropped({ sourceImagePath: 'source/task_0103__1002-abc_receipt_1.jpg' }), true);
  assert.equal(isAlreadyCropped({ sourceImagePath: '1002-abc_receipt_1.jpg' }), true);
  assert.equal(isAlreadyCropped({ sourceImagePath: 'source/task_0103__photo.jpg' }), false);
});

test('⭐⭐两条任务共用同一个图片文件 + 没框 → 阻断(「同图补小票」的现状)', () => {
  // createManualReceiptTaskFromSource 把 sourceImagePath 原样复制且不带框。
  // 不拦的话:同一张照片按两个票号进包 = 上家看到同一笔交易报了两次。
  // 生产实测已有 4 条这样的任务,都还没导出 —— 已上膛未走火。
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg' },
    sharesImageFile: true,
  });
  assert.equal(plan.action, 'block');
  assert.equal(plan.reason, 'duplicate_image_no_box');
  assert.ok(describeBlock(plan.reason).includes('分不出哪块是哪张票'));
});

test('⭐⭐共用的是**切片**文件时也要拦 —— 这是最容易漏掉的一条', () => {
  // 我第一版判据写错就错在这:补出来的任务复制的往往是切片路径,
  // 于是 isAlreadyCropped 命中、直接放行 as-is,护栏形同虚设。
  // 而框是原图坐标系的,在切片上裁不出正确区域 —— 只能拦。
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/01-abc_receipt_1.jpg', detectionBox: det(0, 0, 0.5, 1) },
    sharesImageFile: true,
  });
  assert.equal(plan.action, 'block', '切片被共用,有框也不能裁 —— 坐标系不同');
  assert.equal(plan.reason, 'duplicate_crop_file');
});

test('共用文件 + 指向整图 + 有框 → 可以裁(第2期画完框就走这条)', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg', detectionBox: det(0, 0, 0.45, 1) },
    sharesImageFile: true,
    siblingBoxes: [box(0.55, 0, 0.45, 1)],
  });
  assert.equal(plan.action, 'crop');
});

// ————————————————————————————————————————————————
// 三、外扩规则:想扩 15%,朝兄弟框最多扩到中线
// ————————————————————————————————————————————————

test('那一侧没有兄弟 → 扩满 15%', () => {
  const rect = computeCropRect(box(0.4, 0.4, 0.2, 0.2), [], DEFAULT_PAD_RATIO);
  assert.ok(Math.abs(rect.x1 - (0.4 - 0.03)) < 1e-9, `左边应扩 0.03,实为 ${0.4 - rect.x1}`);
  assert.ok(Math.abs(rect.x2 - (0.6 + 0.03)) < 1e-9);
});

// 中线是**上限**不是目标:想扩 15%,够不到中线就停在 15%,够到了才被中线截住。
test('⭐贴着的邻居:扩 15% 带进一点隔壁,但邻居不完整', () => {
  // 生产实测框间距中位仅 0.3%,这是最常见的形态
  const self = box(0, 0, 0.49, 1);
  const neighbour = box(0.5, 0, 0.5, 1); // 中线 0.75,15% 只扩到 0.5635,够不着
  const rect = computeCropRect(self, [neighbour], DEFAULT_PAD_RATIO);
  assert.ok(Math.abs(rect.x2 - (0.49 + 0.49 * 0.15)) < 1e-9, `没够到中线就按 15% 停,实为 ${rect.x2}`);
  assert.ok(rect.x2 > neighbour.left, '确实带进了一点隔壁 —— 用户说的「可以带一点」');
  assert.equal(fullyContains(rect, neighbour), false, '但邻居绝不能完整入镜');
});

test('⭐窄邻居:15% 会把它整个吞掉时,中线闸截住', () => {
  const self = box(0, 0, 0.5, 1);            // padX = 0.075 → 想扩到 0.575
  const narrow = box(0.52, 0, 0.03, 1);      // 只有 0.52~0.55 宽,中线 0.535
  const rect = computeCropRect(self, [narrow], DEFAULT_PAD_RATIO);
  assert.ok(Math.abs(rect.x2 - 0.535) < 1e-9, `应被中线截在 0.535,实为 ${rect.x2}`);
  assert.equal(fullyContains(rect, narrow), false, '不截住的话这张窄票会完整出现在别人的交付图里');
});

test('另一轴不重叠的兄弟不参与钳位(上下排的票不该限制左右扩)', () => {
  const self = box(0.4, 0, 0.2, 0.3);
  const below = box(0.4, 0.6, 0.2, 0.3); // 只在 y 上有关系
  const rect = computeCropRect(self, [below], DEFAULT_PAD_RATIO);
  assert.ok(Math.abs(rect.x1 - (0.4 - 0.03)) < 1e-9, '左右照样扩满 15%,不被上下邻居影响');
  assert.ok(Math.abs(rect.y2 - (0.3 + 0.045)) < 1e-9, '向下按 15% 扩,没够到下方邻居中线 0.75');
  assert.equal(fullyContains(rect, below), false);
});

test('钳位不得把边推进本框内部(重叠框时至少保住自己)', () => {
  const self = box(0.3, 0, 0.4, 1);
  const overlapping = box(0.2, 0, 0.4, 1); // 中线 0.4,落在 self 里面
  const rect = computeCropRect(self, [overlapping], DEFAULT_PAD_RATIO);
  assert.ok(rect.x1 <= 0.3, `左边不能被推到 0.3 右侧,实为 ${rect.x1}`);
});

test('裁剪矩形永远钳在图内 [0,1]', () => {
  const rect = computeCropRect(box(0, 0, 1, 1), [], DEFAULT_PAD_RATIO);
  assert.deepEqual(rect, { x1: 0, y1: 0, x2: 1, y2: 1 });
});

// ————————————————————————————————————————————————
// 四、最后一道闸:成品里不许有完整的第二张票
// ————————————————————————————————————————————————

test('⭐裁出来完整包含了兄弟框 → 阻断(约束②的兜底)', () => {
  // 框本身就错的形态:一个大框罩住整张图,小框只框住其中一张票。
  // 中线规则救不了这种 —— 大框紧裁也会把小框整个包进去。
  // 实测这种「一个框吃掉另一个 ≥50%」占多票组的 11.4%。
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg', detectionBox: det(0, 0, 1, 1) },
    siblingBoxes: [box(0.1, 0.1, 0.3, 0.3)],
  });
  assert.equal(plan.action, 'block');
  assert.equal(plan.reason, 'contains_full_sibling');
  assert.equal(plan.containedCount, 1);
  assert.ok(describeBlock(plan.reason).includes('一票一图'));
});

test('⭐正常的并排两张票 → 放行并裁(不能把健康数据也拦了)', () => {
  // 判据 5:加拦截前先问它在健康生产数据上会不会亮。
  // 并排两张票是最常见的多票形态,必须能正常出图。
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg', detectionBox: det(0, 0, 0.48, 1) },
    siblingBoxes: [box(0.52, 0, 0.48, 1)],
  });
  assert.equal(plan.action, 'crop');
  assert.ok(plan.rect.x2 > 0.48, '要带上一点隔壁');
  assert.ok(plan.rect.x2 < 1, '但不能带全');
});

test('退化框裁出来太小 → 阻断,不产出噪点图', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg', detectionBox: det(0.5, 0.5, 0.505, 0.505) },
    siblingBoxes: [box(0, 0, 0.4, 1)],
  });
  assert.equal(plan.action, 'block');
  assert.equal(plan.reason, 'crop_too_small');
});

test('fullyContains 只在四边都罩住时为真', () => {
  const rect = { x1: 0, y1: 0, x2: 0.5, y2: 0.5 };
  assert.equal(fullyContains(rect, box(0.1, 0.1, 0.2, 0.2)), true);
  assert.equal(fullyContains(rect, box(0.4, 0.1, 0.2, 0.2)), false, '右边露出去了就不算完整');
  assert.equal(fullyContains(rect, box(0, 0, 0.5, 0.5)), true, '正好贴边也算完整');
});

// ————————————————————————————————————————————————
// 五、像素换算
// ————————————————————————————————————————————————

test('toPixelRect 四舍五入并钳在画布内', () => {
  const r = toPixelRect({ x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 }, 1000, 500);
  assert.deepEqual(r, { left: 100, top: 100, width: 500, height: 300 });
  const edge = toPixelRect({ x1: -0.5, y1: -0.5, x2: 2, y2: 2 }, 800, 600);
  assert.deepEqual(edge, { left: 0, top: 0, width: 800, height: 600 }, '越界要钳回画布');
});

test('每个阻断原因都有人话说明(要写进导出说明.txt给操作员看)', () => {
  for (const reason of ['no_box_multi_doc', 'crop_too_small', 'contains_full_sibling']) {
    const text = describeBlock(reason);
    assert.ok(text.length > 8, `${reason} 的说明太短`);
    assert.doesNotMatch(text, /^[a-z_]+$/, '不能直接把英文 reason 甩给操作员');
  }
});

// ————————————————————————————————————————————————
// 六、工厂:从整个批次一次算出每条任务怎么出图
// ————————————————————————————————————————————————

const { createDeliveryImagePlanner } = require('../lib/delivery_render');

test('⭐工厂能认出「同图补小票」并拦住它', () => {
  const batch = {
    tasks: [
      { id: 't1', sourceImagePath: 'ws/c/01-abc_receipt_1.jpg', detectionBox: det(0, 0, 0.45, 1),
        docTypeFinal: 'receipt', sourceOriginalPath: 'ws/c/01-abc_receipt_1.jpg' },
      // 补出来的:复制了同一个 sourceImagePath,没框
      { id: 't2', sourceImagePath: 'ws/c/01-abc_receipt_1.jpg',
        docTypeFinal: 'receipt', sourceOriginalPath: 'ws/c/01-abc_receipt_1.jpg' },
      // 无关任务,不该被误伤
      { id: 't3', sourceImagePath: 'ws/c/02-xyz_receipt_1.jpg', detectionBox: det(0, 0, 1, 1),
        docTypeFinal: 'receipt', sourceOriginalPath: 'ws/c/02-xyz_receipt_1.jpg' },
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  assert.equal(planFor(batch.tasks[0]).action, 'block', '共用文件的两条都要拦 —— 分不清哪条对应哪张票');
  assert.equal(planFor(batch.tasks[1]).action, 'block');
  assert.equal(planFor(batch.tasks[2]).action, 'as-is', '无关任务必须照旧,不能误伤');
});

test('⭐健康批次:每条任务都是独立切片 → 全部照旧,零拦截', () => {
  // 判据 5:护栏在健康生产数据上不能亮。今天绝大多数批次就是这个形状。
  const batch = {
    tasks: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      sourceImagePath: `ws/c/0${i}-base${i}_receipt_1.jpg`,
      sourceOriginalPath: `ws/c/0${i}-base${i}_receipt_1.jpg`,
      detectionBox: det(0, 0, 0.5, 1),
      docTypeFinal: 'receipt',
    })),
  };
  const planFor = createDeliveryImagePlanner(batch);
  const actions = batch.tasks.map((t) => planFor(t).action);
  assert.deepEqual(actions, Array(6).fill('as-is'), '健康数据上一个都不许拦');
});

test('百货整图直通(一图一票)照旧,不被当成多单据', () => {
  const batch = {
    tasks: [{ id: 'd1', sourceImagePath: 'ws/c/photo.jpg', sourceOriginalPath: 'ws/c/photo.jpg',
      docTypeFinal: 'receipt' }],
  };
  assert.equal(createDeliveryImagePlanner(batch)(batch.tasks[0]).action, 'as-is');
});

test('⭐⭐护照和小票共用同一文件是百货的正常设计,绝不能拦', () => {
  // 乐天百货 combined=true:票面本来就护照+小票同框,交付里同一个文件
  // 既出「交易编号.jpg」又出「护照.jpg」。第一版没收窄判据,护栏在健康的
  // 百货数据上直接亮了 —— 判据 5 的活教材。
  const batch = {
    tasks: [
      { id: 'r1', docTypeFinal: 'receipt', sourceImagePath: 'ws/c/photo.jpg', sourceOriginalPath: 'ws/c/photo.jpg' },
      { id: 'p1', docTypeFinal: 'passport', sourceImagePath: 'ws/c/photo.jpg', sourceOriginalPath: 'ws/c/photo.jpg' },
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  assert.equal(planFor(batch.tasks[0]).action, 'as-is', '百货一图一票,护照同框不算重复');
});

test('但两条**小票**共用同一文件照样拦', () => {
  const batch = {
    tasks: [
      { id: 'r1', docTypeFinal: 'receipt', sourceImagePath: 'ws/c/photo.jpg', sourceOriginalPath: 'ws/c/photo.jpg' },
      { id: 'r2', docTypeFinal: 'receipt', sourceImagePath: 'ws/c/photo.jpg', sourceOriginalPath: 'ws/c/photo.jpg' },
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  assert.equal(planFor(batch.tasks[0]).action, 'block');
});

test('⭐⭐护照的框不算「兄弟小票」—— 百货同框票不能因此被拦', () => {
  // 用户的约束原话是「不能整个画面出现完整的两个**小票**」。
  // 护照在画面里靠打码处理,不靠裁。把它当兄弟会让百货同框票全线误拦
  // —— 这是同一个根因的第二次误伤(第一次是共用文件计数没排除护照)。
  const batch = {
    tasks: [
      { id: 'a_r', docTypeFinal: 'receipt', sourceImagePath: 'source/combined.jpg',
        sourceOriginalPath: '2607/CL-101/x.jpg' },
      { id: 'a_p', docTypeFinal: 'passport', sourceImagePath: 'source/combined.jpg',
        sourceOriginalPath: '2607/CL-101/x.jpg', modelMeta: { bbox: [0.55, 0.05, 0.98, 0.6] } },
    ],
  };
  const planFor = createDeliveryImagePlanner(batch);
  assert.equal(planFor(batch.tasks[0]).action, 'as-is', '同框票照旧出图,打码那条路不受影响');
});

// ————————————————————————————————————————————————
// 七、真的裁出图来(0730):crop 这个 action 原来算出来了但**没人执行** ——
// 会掉到 as-is 用整图,正是护栏要防的那件事。今天 crop 计数是 0 所以没炸,
// 但第 2 期一让人画框就会炸。这几条锁住渲染这一步。
// ————————————————————————————————————————————————

const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');
const sharp = require('sharp');
const { renderCroppedDelivery } = require('../lib/delivery_render');

test('⭐按框真的裁出一份图,尺寸对得上', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dr_render_'));
  try {
    const src = nodePath.join(dir, 'src.jpg');
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#fff' } }).jpeg().toFile(src);
    const dest = nodePath.join(dir, 'out.jpg');
    const res = await renderCroppedDelivery({
      sourcePath: src, destPath: dest, rect: { x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 }, sharp,
    });
    assert.equal(res.cropped, true, res.reason);
    const meta = await sharp(dest).metadata();
    assert.equal(meta.width, 500, '0.1~0.6 of 1000');
    assert.equal(meta.height, 300, '0.2~0.8 of 500');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐裁失败绝不静默回退整图 —— 回退整图就是那个事故本身', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dr_fail_'));
  try {
    const missing = nodePath.join(dir, 'nope.jpg');
    const res = await renderCroppedDelivery({
      sourcePath: missing, destPath: nodePath.join(dir, 'o.jpg'), rect: { x1: 0, y1: 0, x2: 1, y2: 1 }, sharp,
    });
    assert.equal(res.cropped, false);
    assert.match(res.reason, /sharp_failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('退化矩形 / 缺 sharp 都返回 false 而不是抛', async () => {
  assert.equal((await renderCroppedDelivery({ rect: null, sharp })).cropped, false);
  assert.equal((await renderCroppedDelivery({ rect: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 }, sharp })).reason, 'rect_invalid');
  assert.equal((await renderCroppedDelivery({ rect: { x1: 0, y1: 0, x2: 1, y2: 1 }, sharp: null })).reason, 'no_sharp');
});

test('⭐裁出来太小(框退化)也不出图', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dr_small_'));
  try {
    const src = nodePath.join(dir, 's.jpg');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).jpeg().toFile(src);
    const res = await renderCroppedDelivery({
      sourcePath: src, destPath: nodePath.join(dir, 'o.jpg'),
      rect: { x1: 0.5, y1: 0.5, x2: 0.52, y2: 0.52 }, sharp,
    });
    assert.equal(res.cropped, false);
    assert.equal(res.reason, 'region_too_small');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐⭐拒绝理由不得指向不存在的操作(同一毛病第三次了)', () => {
  // 0730 生产实测读到 duplicate_crop_file 的原话是「需要在原图上重新框出各自的范围」——
  // 但切片任务**不能手画框**(lib/manual_doc_box 会直接拒:框是原图坐标系,在切片上对不上)。
  // 上午已经在 manual_doc_box 改过同一句,这里漏了。第三次同类毛病,所以钉住。
  const text = describeBlock('duplicate_crop_file');
  assert.ok(!text.includes('在原图上重新框出'), '不能指向做不到的操作');
  assert.ok(text.includes('按店重切'), '要给真能做的路');
  // 「补小票」这条出路 0731 上午实测是假的(补出来还是切片),当天下午做了 P2-a
  // (补票时把原图拷进批次)才成立。所以它现在可以在,但**说法必须是"就在这条上补"**,
  // 不能再写"去原图那条任务" —— 那条任务在 qwen 流程里根本不存在。
  assert.ok(text.includes('补小票'), '补小票现在是真能走的路了(P2-a)');
  assert.ok(!text.includes('原图那条任务'), '不能再指向不存在的"原图那条任务"');

  // 另两个理由也过一遍:必须是人话,且不能只是术语
  for (const reason of ['duplicate_image_no_box', 'no_box_multi_doc', 'crop_too_small', 'contains_full_sibling']) {
    const t = describeBlock(reason);
    assert.ok(t.length > 8, `${reason} 说明太短`);
    assert.doesNotMatch(t, /^[a-z_]+$/, `${reason} 不能把英文 reason 甩给操作员`);
  }
});

test('两处「切片不能手画框」的说法要一致 —— 别一处改了另一处没改', () => {
  // ⚠️ 断言**函数真实返回的文案**,不是扫源码 —— 第一版扫整个文件,结果被我自己
  // 那句注释(「不能说…改回指向原图」)命中而失败。行为断言比源码断言可靠。
  const { canAcceptManualBox } = require('../lib/manual_doc_box');
  const cropTask = { sourceImagePath: 'source/task_0103__1002-abc_receipt_1.jpg' };
  const r = canAcceptManualBox(cropTask);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('改回指向原图'), 'manual_doc_box 侧也不能指向不存在的操作');
  assert.ok(r.error.includes('按店重切'), 'manual_doc_box 侧要给真能做的路');
  assert.ok(r.error.includes('补小票'), 'manual_doc_box 侧也要给「补小票」这条路(P2-a 之后为真)');

  // 两处说的是同一件事,给出的出路也该一致 —— 而且必须**同时**一致,
  // 「一处改了另一处没改」正是这条用例存在的理由。
  const deliveryText = describeBlock('duplicate_crop_file');
  assert.ok(deliveryText.includes('按店重切'), '交付侧也要给「按店重切」这条路');
  assert.ok(deliveryText.includes('补小票'), '交付侧也要给「补小票」这条路');
  assert.ok(!deliveryText.includes('原图那条任务'), '交付侧也不许指向不存在的任务');
});

// ── 人工框 vs「一图一票」短路(0730 P2 设计评审查出)────────────────────
// 判定顺序:整图 + 没兄弟 → as-is「一图一票,照旧出图」。
// 模型没给框时这条是对的(百货就是一图一票)。但审核员**手画了框**之后还走它,
// 就又是一次"我画了框,然后呢?"—— 框存下来了、界面上也画了,交付却当没看见,且不报错。
// 人工框是一句明确的人类指令(这条任务对应的是这一块),必须压过这个短路。

test('⭐手画框要压过「一图一票照旧出图」的短路', () => {
  const plan = planDeliveryImage({
    task: {
      sourceImagePath: 'ws/c1/photo.jpg',
      detectionBox: [0.1, 0.2, 0.5, 0.8],
      manualBox: [0.1, 0.2, 0.5, 0.8],
      docBoxSource: 'manual',
    },
    siblingBoxes: [],
  });
  assert.equal(plan.action, 'crop', `人工框被吞了:${JSON.stringify(plan)}`);
  assert.ok(plan.rect, '要给出裁剪矩形');
});

test('模型框(非人工)在一图一票时仍然照旧出图 —— 不动这条既有行为', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg', detectionBox: [0.1, 0.2, 0.5, 0.8] },
    siblingBoxes: [],
  });
  assert.equal(plan.action, 'as-is');
  assert.equal(plan.reason, 'single_document');
});

test('人工把框清掉之后回到照旧出图(清框要能真的撤销)', () => {
  const plan = planDeliveryImage({
    task: { sourceImagePath: 'ws/c1/photo.jpg' },  // setTaskDocBox 清框会 delete 掉这几个字段
    siblingBoxes: [],
  });
  assert.equal(plan.action, 'as-is');
  assert.equal(plan.reason, 'single_document');
});
