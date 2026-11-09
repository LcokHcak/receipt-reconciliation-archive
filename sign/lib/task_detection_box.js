'use strict';

// 「这条任务的框在哪」——单一真相源(0731)。
//
// 为什么必须收成一处:同一个事实,原来有两套读法。
//   review_doc_regions.js  读 task.detectionBox || task.modelMeta?.bbox
//   delivery_render.js     只读 task.detectionBox
// 而本地真数据里,119 条任务中 **90 条的框只存在 modelMeta.bbox**
// (切片 7/7、整图 83/108;真正写了 detectionBox 的只有 1 条)。
//
// 后果不是"样式差一点"这种小事:交付侧 planDeliveryImage 拿不到框,
// 就会把这条任务判成 duplicate_image_no_box —— **"没框"**,
// 于是明明框好好在那儿,交付却拦下来说"你没框"。审核台那边同时还画得好好的,
// 两边说法相反,操作员没法判断该信谁。
//
// 这类 bug 的形态是固定的:一个事实、两处各自维护的读法,谁也不报错,
// 只在某类数据上分道扬镳。所以修法不是"给交付也加个 ||",是把读法收成一处。

/**
 * 取这条任务的检测框(原图归一化 [x1,y1,x2,y2]),取不到返回 null。
 * 不做归一化/退化判断 —— 各消费方自己的规矩不同(交付要 padding,审核要转 rect),
 * 这里只负责回答"框在哪个字段上"这一件事。
 */
function taskDetectionBox(task) {
  if (!task || typeof task !== 'object') return null;
  const direct = task.detectionBox;
  if (Array.isArray(direct) && direct.length === 4) return direct;
  const meta = task.modelMeta && task.modelMeta.bbox;
  if (Array.isArray(meta) && meta.length === 4) return meta;
  return null;
}

module.exports = { taskDetectionBox };
