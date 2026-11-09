'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDocRegionIndex,
  buildTaskDocRegions,
  originalGroupKeyOf,
  normalizeDetectionBox,
  containmentRatio,
  SUSPECT_CONTAINMENT_RATIO,
} = require('../lib/review_doc_regions');

// 夹具照**生产真实产出的形状**搭(0729 判据 8):切片任务的 sourceOriginalPath 是
// `工作区/客户号/NN-<base>_receipt_N.jpg`,框在 detectionBox 上,归一化 [x1,y1,x2,y2]。
function splitTask({ id, base = 'abc123', seq = 1, box, receiptNo = '', docType = 'receipt', dir = 'ws1/CL20260722-012' }) {
  return {
    id,
    sourceOriginalPath: `${dir}/0${seq}-${base}_${docType}_${seq}.jpg`,
    detectionBox: box,
    docTypeFinal: docType,
    receiptNoFinal: receiptNo,
  };
}

test('同一张原图的兄弟框全部返回,当前任务标 isCurrent', () => {
  const tasks = [
    splitTask({ id: 't1', seq: 1, box: [0, 0, 0.45, 1] }),
    splitTask({ id: 't2', seq: 2, box: [0.55, 0, 1, 1] }),
  ];
  const index = buildDocRegionIndex(tasks);
  const regions = buildTaskDocRegions(tasks[0], index);

  assert.equal(regions.length, 2, '两张票同图 → 两个框都要画出来,否则「哪块没被框住」看不出来');
  assert.deepEqual(regions.map((r) => r.taskId), ['t1', 't2']);
  assert.deepEqual(regions.map((r) => r.isCurrent), [true, false]);
  // 归一化成 {left,top,width,height},和字段框同一套坐标约定
  assert.deepEqual(regions[0].box, { left: 0, top: 0, width: 0.45, height: 1 });
});

test('组里只有一个框 → 返回空(单框没有回找价值,画出来只是噪音)', () => {
  const only = splitTask({ id: 't1', seq: 1, box: [0.1, 0.1, 0.9, 0.9] });
  assert.deepEqual(buildTaskDocRegions(only, buildDocRegionIndex([only])), []);
});

test('⭐不同原图的任务绝不串组', () => {
  const tasks = [
    splitTask({ id: 'a1', base: 'AAA', seq: 1, box: [0, 0, 0.5, 1] }),
    splitTask({ id: 'a2', base: 'AAA', seq: 2, box: [0.5, 0, 1, 1] }),
    splitTask({ id: 'b1', base: 'BBB', seq: 1, box: [0, 0, 0.5, 1] }),
    splitTask({ id: 'b2', base: 'BBB', seq: 2, box: [0.5, 0, 1, 1] }),
  ];
  const index = buildDocRegionIndex(tasks);
  assert.deepEqual(buildTaskDocRegions(tasks[0], index).map((r) => r.taskId), ['a1', 'a2']);
  assert.deepEqual(buildTaskDocRegions(tasks[2], index).map((r) => r.taskId), ['b1', 'b2']);
});

test('⭐同一个 base 但不同客户目录也不串组', () => {
  const tasks = [
    splitTask({ id: 'x', dir: 'ws1/CL-001', seq: 1, box: [0, 0, 0.5, 1] }),
    splitTask({ id: 'y', dir: 'ws1/CL-002', seq: 2, box: [0.5, 0, 1, 1] }),
  ];
  const index = buildDocRegionIndex(tasks);
  assert.deepEqual(buildTaskDocRegions(tasks[0], index), [], '不同客户 → 各自单框 → 空');
});

test('没有框的任务不参与(整图直通的百货任务没有 detectionBox)', () => {
  const tasks = [
    { id: 'whole', sourceOriginalPath: 'ws1/CL-001/photo.jpg', docTypeFinal: 'receipt' },
    splitTask({ id: 't1', seq: 1, box: [0, 0, 0.5, 1] }),
    splitTask({ id: 't2', seq: 2, box: [0.5, 0, 1, 1] }),
  ];
  const index = buildDocRegionIndex(tasks);
  assert.deepEqual(buildTaskDocRegions(tasks[0], index), []);
  assert.equal(buildTaskDocRegions(tasks[1], index).length, 2);
});

test('⭐一个框套住另一个但票号不同 → **不标** suspect(生产实测 94.5% 是这种)', () => {
  // 生产样本里有 100% 被完全套住的:大框罩住整张图,小框只框住其中一张票
  const tasks = [
    splitTask({ id: 'big', seq: 1, box: [0, 0, 1, 1] }),
    splitTask({ id: 'small', seq: 2, box: [0.1, 0.1, 0.4, 0.4] }),
  ];
  // 口径 v3(两轮生产实测后定的):纯几何重叠**不是**可操作信号 ——
  // 2439 对重叠里 2306 对(94.5%)是两张**不同**的票,票号各自填对了。
  // 因为字段是从整图抽的、不是从切片抽的,框重叠不影响字段正确性。
  const tasksDiff = [
    { ...tasks[0], receiptNoFinal: 'A-0001' },
    { ...tasks[1], receiptNoFinal: 'A-0002' },
  ];
  const regions = buildTaskDocRegions(tasksDiff[0], buildDocRegionIndex(tasksDiff));
  const small = regions.find((r) => r.taskId === 'small');
  assert.equal(small.suspect, false, '票号不同 = 两张真的票,不该报可疑');
  assert.equal(small.overlapRatio, 1, '但几何值仍要留着供排查');
});

test('⭐⭐框重叠 **且票号相同** → 才是真缺陷(同一张票出了两条任务)', () => {
  // 生产实测:2439 对重叠里 130 对票号相同 = 0.506% 的任务。
  // 这个量级才配得上红标(判据 5:亮 4.47% 的提醒等于没提醒)。
  const tasks = [
    splitTask({ id: 'big', seq: 1, box: [0, 0, 1, 1], docType: 'receipt', receiptNo: '2615-1624' }),
    splitTask({ id: 'small', seq: 2, box: [0.1, 0.1, 0.4, 0.4], docType: 'receipt', receiptNo: '26151624' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  // 票号归一化后相同(去横线),两条都要标,并互相指认
  assert.deepEqual(regions.map((r) => r.suspect), [true, true]);
  assert.equal(regions.find((r) => r.taskId === 'big').duplicateOf, 'small');
  assert.equal(regions.find((r) => r.taskId === 'small').duplicateOf, 'big');
});

test('票号有一边是空 → 不报可疑(填不出来是另一类问题,别混在一起)', () => {
  const tasks = [
    splitTask({ id: 'big', seq: 1, box: [0, 0, 1, 1], docType: 'receipt', receiptNo: '26151624' }),
    splitTask({ id: 'small', seq: 2, box: [0.1, 0.1, 0.4, 0.4], docType: 'receipt', receiptNo: '' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  assert.deepEqual(regions.map((r) => r.suspect), [false, false]);
});

test('⭐两张票挨着轻微重叠 → 不标 suspect(否则健康数据上天天亮红)', () => {
  // 0729 判据 5:加提醒前先问它在健康生产数据上会不会亮。
  // 实测 125 组(15.5%)是这种 5%~50% 的轻压,票本身就挨着,是正常的。
  const tasks = [
    splitTask({ id: 't1', seq: 1, box: [0, 0, 0.52, 1] }),
    splitTask({ id: 't2', seq: 2, box: [0.48, 0, 1, 1] }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  assert.deepEqual(regions.map((r) => r.suspect), [false, false]);
  assert.ok(regions[0].overlapRatio < SUSPECT_CONTAINMENT_RATIO);
});

test('标签优先用票号(操作员就是按票号回找的)', () => {
  const tasks = [
    splitTask({ id: 't1', seq: 1, box: [0, 0, 0.5, 1], receiptNo: '1042-4829' }),
    splitTask({ id: 't2', seq: 2, box: [0.5, 0, 1, 1], docType: 'passport' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  assert.deepEqual(regions.map((r) => r.label), ['1042-4829', '护照']);
});

test('索引可省略:单任务写回路径也能算(不会静默返回空)', () => {
  // applyComputedFields 有 8 处单任务调用(写操作后原地换任务),那条路径不传索引。
  const one = splitTask({ id: 't1', seq: 1, box: [0, 0, 0.5, 1] });
  assert.deepEqual(buildTaskDocRegions(one), [], '只有它自己 → 空,不抛错');
});

test('退化框丢弃:零宽/零高/非数字', () => {
  assert.equal(normalizeDetectionBox([0.1, 0.1, 0.1, 0.5]), null, '零宽');
  assert.equal(normalizeDetectionBox([0.1, 0.2, 0.5, 0.2]), null, '零高');
  assert.equal(normalizeDetectionBox([0.1, 'x', 0.5, 0.9]), null);
  assert.equal(normalizeDetectionBox(null), null);
  assert.equal(normalizeDetectionBox([0.1, 0.2]), null);
  // 坐标反着给也要能用(min/max 归位),否则模型偶尔倒序就整块框消失
  assert.deepEqual(normalizeDetectionBox([0.5, 0.9, 0.1, 0.2]), { left: 0.1, top: 0.2, width: 0.4, height: 0.7 });
});

test('分组键:切片名解析出 base,没切过的图用自己的路径', () => {
  assert.equal(originalGroupKeyOf({ sourceOriginalPath: 'ws/c1/03-abc_receipt_2.jpg' }), 'ws/c1/abc');
  assert.equal(originalGroupKeyOf({ sourceOriginalPath: 'ws/c1/03-abc_passport_1.png' }), 'ws/c1/abc');
  assert.equal(originalGroupKeyOf({ sourceOriginalPath: 'ws/c1/plain.jpg' }), 'ws/c1/plain.jpg');
  assert.equal(originalGroupKeyOf({}), null);
});

test('containmentRatio 用 min(面积) 当分母,不是 IoU', () => {
  const big = { left: 0, top: 0, width: 1, height: 1 };
  const small = { left: 0, top: 0, width: 0.2, height: 0.2 };
  // IoU 只有 0.04,但小框其实被完全吃掉 —— 这正是我们要抓的形态
  assert.equal(containmentRatio(big, small), 1);
  const apart = { left: 0.8, top: 0.8, width: 0.1, height: 0.1 };
  assert.equal(containmentRatio(small, apart), 0);
});

test('⭐⭐可疑判定只看小票之间 —— 护照压着小票是正常形态,不是框错了', () => {
  // 生产实测(72262 条任务):不收窄 → 4507 条(6.24%)被标可疑,
  // 样本全是 receipt+passport 配对、重叠比一模一样,纯误报。
  // 乐天百货整个业务就是护照+小票同框,把它当"框错了"会让红标亮在 6% 的任务上。
  const tasks = [
    splitTask({ id: 'r1', seq: 1, box: [0.05, 0.05, 0.6, 0.9], docType: 'receipt', receiptNo: 'A' }),
    splitTask({ id: 'p1', seq: 2, box: [0.1, 0.1, 0.4, 0.5], docType: 'passport' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  // 护照框完全落在小票框内 —— 几何上"被吃掉 100%",但业务上完全正常
  assert.deepEqual(regions.map((r) => r.suspect), [false, false], '护照-小票重叠不算可疑');
  assert.deepEqual(regions.map((r) => r.overlapRatio), [0, 0]);
});

test('⭐两张小票严重重叠 + 票号相同 → 标(v3 口径)', () => {
  const tasks = [
    splitTask({ id: 'big', seq: 1, box: [0, 0, 1, 1], docType: 'receipt', receiptNo: 'A' }),
    splitTask({ id: 'small', seq: 2, box: [0.1, 0.1, 0.4, 0.4], docType: 'receipt', receiptNo: 'A' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  assert.equal(regions.find((r) => r.taskId === 'small').suspect, true);
});

test('⭐两边票号都是空 → 不报可疑(空 === 空 会假成立)', () => {
  // 验红时抓到的空档:上一条测试只覆盖「一边空」,而漏字段的写法
  // (去掉 `entry.receiptNoKey && other.receiptNoKey` 前置判断)只在**两边都空**时才出错
  // —— '' === '' 会成立,于是一堆"都填不出票号"的任务被当成重复票。
  // 生产实测这种有 3 对。填不出票号是另一类问题,别混进"重复记录"里。
  const tasks = [
    splitTask({ id: 'a', seq: 1, box: [0, 0, 1, 1], docType: 'receipt', receiptNo: '' }),
    splitTask({ id: 'b', seq: 2, box: [0.1, 0.1, 0.4, 0.4], docType: 'receipt', receiptNo: '' }),
  ];
  const regions = buildTaskDocRegions(tasks[0], buildDocRegionIndex(tasks));
  assert.deepEqual(regions.map((r) => r.suspect), [false, false]);
  assert.deepEqual(regions.map((r) => r.duplicateOf), ['', '']);
});
