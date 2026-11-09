'use strict';

// 一票一图护栏的**端到端**测试(0729 切图改框选·第3期)。
// lib/delivery_render 的纯函数测试在 delivery_render.test.js;这里验的是
// **真的走一遍交付计划,重复图确实没进包、而且说明里说清了**。
// 判据 2:返回值里的名单若调用方不消费,等于没算 —— 所以必须端到端验一次。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLotteDeptDeliveryExportService, buildLotteDeliveryNotes } = require('../services/lotte_dept_delivery_export_service');

function touch(dir, rel) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
}
const mkService = (dir) => createLotteDeptDeliveryExportService({
  resolveBatchRelativePath: (batchId, rel) => path.join(dir, rel),
});
const CUSTOMER = 'CL20260708-001';
const baseTask = (over) => ({
  id: 't1',
  reviewed: true,
  sourceOriginalPath: `2607/${CUSTOMER}/x.jpg`,
  sourceGroupKey: CUSTOMER,
  docTypeFinal: 'receipt',
  receiptStoreFinal: 'LOTTE_DEPT',
  branchFinal: '0394',
  purchaseDateFinal: '2026-07-01',
  extractedNameFinal: 'AAA BBB',
  ...over,
});

test('⭐「同图补小票」产生的重复图不进包,且导出说明写清了怎么修', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one_per_img_'));
  try {
    touch(dir, 'source/shared.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        baseTask({ id: 'r1', receiptNoFinal: '1111-2222', sourceImagePath: 'source/shared.jpg' }),
        // 补出来的那条:同一个图片文件,没有框 —— 这就是生产上那 4 条的形状
        baseTask({ id: 'r2', receiptNoFinal: '3333-4444', sourceImagePath: 'source/shared.jpg' }),
      ],
    };
    const svc = mkService(dir);
    const plan = svc.planDelivery(batch);

    const shared = plan.entries.filter((e) => e.sourcePath === path.join(dir, 'source/shared.jpg')
      && e.baseName !== '护照');
    assert.equal(shared.length, 0,
      '两条小票共用一张图 → 一张都不能进包(进了就是同一张照片按两个票号报两笔账)');
    assert.equal(plan.imageBlocked.length, 2, '两条都要进名单');

    const notes = (buildLotteDeliveryNotes({ imageBlocked: plan.imageBlocked }) || []).join(String.fromCharCode(10));
    assert.ok(notes.includes('一票一图不成立'), '说明里要有这一段');
    // 2026-08-01 改断言:原来这里钉的是 notes.includes('查看原图') ——
    // 而审核台**没有**叫「查看原图」的控件(按钮是「回原图」/「看切片」),
    // 且这段名单里的 duplicate_crop_file 指向切片,manual_doc_box 直接 400 拒绝画框。
    // 也就是说这条断言在**保护那句错话**:它一直绿着,而操作员照着做必然撞墙。
    // 正确口径:把人指回**每条自己**的可行做法(逐条已由 describeBlock 给出),
    // 不给统一的一步。守则见 tests/delivery_notes_no_impossible_advice.test.js。
    assert.ok(!notes.includes('查看原图'),
      '不许指一个界面上不存在、且对切片任务做不到的动作');
    assert.ok(notes.includes('每条后面的括号里写了它自己的原因和可行做法'),
      '要把人指回逐条建议');
    assert.ok(notes.includes('不同原因的处理方式不一样'),
      '要明说没有统一的一步 —— 否则读的人还是会去找那"一个动作"');
    assert.ok(notes.includes('账已经在表里'), '要说清「只是图没进包」,别让人以为整笔丢了');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐健康批次:各自独立的图 → 一条都不拦,说明里也不出现这一段', () => {
  // 判据 5:护栏在健康生产数据上不能亮。今天绝大多数批次就是这个形状。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one_per_img_ok_'));
  try {
    touch(dir, 'source/a.jpg');
    touch(dir, 'source/b.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        baseTask({ id: 'r1', receiptNoFinal: '1111-2222', sourceImagePath: 'source/a.jpg' }),
        baseTask({ id: 'r2', receiptNoFinal: '3333-4444', sourceImagePath: 'source/b.jpg' }),
      ],
    };
    const svc = mkService(dir);
    const plan = svc.planDelivery(batch);
    assert.equal(plan.imageBlocked.length, 0, '健康数据上一条都不许拦');
    assert.equal(plan.entries.filter((e) => e.baseName === '1111-2222').length, 1);
    assert.equal(plan.entries.filter((e) => e.baseName === '3333-4444').length, 1);
    const notes = (buildLotteDeliveryNotes({ imageBlocked: plan.imageBlocked }) || []).join(String.fromCharCode(10));
    assert.equal(notes.includes('一票一图不成立'), false, '没问题就别写这一段');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐护照与小票同框(百货的正常形态)不受影响', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one_per_img_combined_'));
  try {
    touch(dir, 'source/combined.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        baseTask({ id: 'r1', receiptNoFinal: '1111-2222', sourceImagePath: 'source/combined.jpg' }),
        baseTask({
          id: 'p1', docTypeFinal: 'passport', passportNoFinal: 'E11111111',
          sourceImagePath: 'source/combined.jpg', modelMeta: { bbox: [0.55, 0.05, 0.98, 0.6] },
        }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.equal(plan.imageBlocked.length, 0, '同框票是乐天百货的设计,不是重复');
    assert.equal(plan.entries.filter((e) => e.baseName === '1111-2222').length, 1, '照样出图');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐⭐给补票任务画上框 → 交付包里出的是**裁好的**图,不是整图', async () => {
  // 0730 补上的一环:crop 这个 action 原来算出来了却没人执行,会掉到原样复制 =
  // 整图进包 = 同一张照片当成多笔交易,正是护栏要防的那件事。
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crop_e2e_'));
  try {
    fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
    const shared = path.join(dir, 'source', 'shared.jpg');
    // 1000x500 的图,左右各一张"票"
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#ffffff' } })
      .jpeg().toFile(shared);

    const batch = {
      id: 'b_crop',
      tasks: [
        baseTask({
          id: 'r1', receiptNoFinal: '1111-2222', sourceImagePath: 'source/shared.jpg',
          detectionBox: [0.02, 0.1, 0.44, 0.9], // 人在原图上画的左票
        }),
        baseTask({
          id: 'r2', receiptNoFinal: '3333-4444', sourceImagePath: 'source/shared.jpg',
          detectionBox: [0.56, 0.1, 0.98, 0.9], // 右票
        }),
      ],
    };
    const svc = mkService(dir);
    const plan = svc.planDelivery(batch);

    const e1 = plan.entries.find((e) => e.baseName === '1111-2222');
    assert.ok(e1, '有框了就该出图,不再被拦');
    assert.ok(e1.cropRect, '而且必须带 cropRect —— 没有它 exportZip 会原样复制整图');
    assert.ok(e1.cropRect.x2 < 1, '右边界要收进来,不能是整图');
    assert.equal(plan.imageBlocked.length, 0, '两条都有框 → 一条都不拦');

    // 真的裁一次,确认出来的图确实比原图窄
    const out = path.join(dir, 'out.jpg');
    const { renderCroppedDelivery } = require('../lib/delivery_render');
    const res = await renderCroppedDelivery({
      sourcePath: shared, destPath: out, rect: e1.cropRect, sharp,
    });
    assert.equal(res.cropped, true, res.reason);
    const meta = await sharp(out).metadata();
    assert.ok(meta.width < 1000, `裁出来应比原图窄,实为 ${meta.width}`);
    assert.ok(meta.width > 300, `也不能裁得太窄,实为 ${meta.width}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
