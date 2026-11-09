'use strict';

/**
 * 「这条任务的框在哪」必须只有一套读法。
 *
 * 0731 实锤:同一个事实,两处各自维护 ——
 *   review_doc_regions  读 detectionBox || modelMeta.bbox
 *   delivery_render     只读 detectionBox
 * 而真数据里 119 条任务有 **90 条的框只存在 modelMeta.bbox**
 * (切片 7/7、整图 83/108;真写了 detectionBox 的只有 1 条)。
 *
 * 后果不是样式差一点:交付侧把这些任务判成 duplicate_image_no_box ——
 * 字面意思「你没框」,而审核台同时把框画得好好的。两边说法相反,
 * 操作员没法判断该信谁,而且交付会拦下本来能出的图。
 *
 * 这类 bug 的形态固定:一个事实、两处读法、谁都不报错,只在某类数据上分道扬镳。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { taskDetectionBox } = require('../lib/task_detection_box');
const { planDeliveryImage } = require('../lib/delivery_render');
const { buildDocRegionIndex } = require('../lib/review_doc_regions');

const BOX = [0.1, 0.1, 0.6, 0.6];

test('访问器:两个字段都认,都没有才是 null', () => {
  assert.deepEqual(taskDetectionBox({ detectionBox: BOX }), BOX);
  assert.deepEqual(taskDetectionBox({ modelMeta: { bbox: BOX } }), BOX, '真数据里 90/119 是这形态');
  assert.deepEqual(taskDetectionBox({ detectionBox: BOX, modelMeta: { bbox: [0, 0, 1, 1] } }), BOX,
    'detectionBox 优先(它是显式落库的那个)');
  assert.equal(taskDetectionBox({}), null);
  assert.equal(taskDetectionBox({ detectionBox: [1, 2] }), null, '长度不对不算框');
  assert.equal(taskDetectionBox(null), null);
});

test('⭐框在 modelMeta.bbox 时,交付不许再说"你没框"', () => {
  const withDirect = planDeliveryImage({
    task: { sourceImagePath: 'source/a.jpg', detectionBox: BOX }, sharesImageFile: true,
  });
  const withMeta = planDeliveryImage({
    task: { sourceImagePath: 'source/a.jpg', modelMeta: { bbox: BOX } }, sharesImageFile: true,
  });
  const noBox = planDeliveryImage({
    task: { sourceImagePath: 'source/a.jpg' }, sharesImageFile: true,
  });

  assert.equal(withDirect.action, 'crop');
  assert.equal(withMeta.action, 'crop',
    '框就在 modelMeta.bbox 上,交付却判 no_box —— 这正是要修的');
  assert.equal(withMeta.reason, withDirect.reason, '框在哪个字段上,不该改变交付的判断');
  assert.equal(noBox.action, 'block', '真没框还是要拦 —— 别把这次放宽变成一律放行');
  assert.equal(noBox.reason, 'duplicate_image_no_box');
});

test('⭐审核台和交付必须对同一条任务给出同一个"有没有框"', () => {
  const mk = (id, boxField) => ({
    id,
    sourceImagePath: 'source/a.jpg',
    sourceOriginalPath: '2026-07/CL20260701-001/a.jpg',
    ...boxField,
  });
  const cases = [
    ['detectionBox', mk('t1', { detectionBox: BOX })],
    ['modelMeta.bbox', mk('t2', { modelMeta: { bbox: BOX } })],
    ['没有框', mk('t3', {})],
  ];
  for (const [name, task] of cases) {
    const reviewSeesBox = [...buildDocRegionIndex([task]).values()].flat().length > 0;
    const deliverySeesBox = planDeliveryImage({ task, sharesImageFile: true }).action !== 'block';
    assert.equal(reviewSeesBox, deliverySeesBox,
      `${name}:审核台看到框=${reviewSeesBox}、交付看到框=${deliverySeesBox} —— 两边说法必须一致`);
  }
});

test('读法只有一处:两个消费方都走 lib/task_detection_box', () => {
  const strip = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const f of ['lib/delivery_render.js', 'lib/review_doc_regions.js']) {
    const src = strip(f);
    assert.match(src, /taskDetectionBox/, `${f} 要走共用访问器`);
    assert.ok(!/detectionBox\s*\|\|\s*task\.modelMeta/.test(src),
      `${f} 里还留着自己那套 || 读法 —— 两份必漂,这次就是这么漂的`);
  }
});
