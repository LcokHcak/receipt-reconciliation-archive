// 交付出图(2026-07-29 切图改框选·第 3 期):按框裁一份交付图。
//
// 用户定的两条硬约束(它们唯一确定了这个模块的行为):
//   ① 交付必须是**单小票切好的**
//   ② 可以带上隔壁票**一点**,但画面里**不能出现两张完整的小票**
//
// 约束 ② 是这里所有算法的来源。它比"完全避开隔壁"宽松得多,而且**可计算** ——
// 生产实测多票图的框间距中位只有 0.3%、75% 的组间距 <2%,
// "避开隔壁"根本没有空间;"不让隔壁完整入镜"则总是有解(除非框本身就错了)。
//
// 堵的是什么洞:`createManualReceiptTaskFromSource` 把 sourceImagePath 原样复制、
// 不带任何框,于是「同图补小票」产生的任务和源任务**指向同一个图片文件**。
// 交付按票号命名出图 → 同一张照片被当成两笔交易发两次。
// 实测生产已有 4 条这样的任务(都还没导出,**已上膛未走火**)。

const path = require('node:path');
const { buildDocRegionIndex, originalGroupKeyOf } = require('./review_doc_regions');
const { taskDetectionBox } = require('./task_detection_box');
const { SLICE_SUFFIX_RE } = require('./slice_file_name');

// 已经物理裁过的切片文件名。这类任务的图**就是**那张单据,交付直接用,行为零变化。
//
// ⚠️ 只能按**后缀**认,不能锚定开头。批次里的实际文件名带 `task_XXXX__` 前缀:
//   source/task_0103__1002-<hash>_receipt_1.jpg
// 而客户库里的同一张是 `1002-<hash>_receipt_1.jpg`(无前缀)。
// 第一版按 /^\d+-.../ 锚开头,于是**每一条真实切片都被判成"不是切片"** ——
// 生产实测 51371 条小票里 14971 条被误拦(29%),已部署过一次,靠全库回放才发现。
// 教训:文件名格式必须拿**生产真实值**验证,不能照着客户库那份格式写。
// 0731 收敛:这个判据原来在四个地方各写一份,其中**两处同名不同义**
//(review_doc_regions 的 SPLIT_FILE_RE 要求 NN- 前缀,这里的不要求;
// 真数据里 230 个文件名有 7 个两者结论相反)。单一真相源在 lib/slice_file_name。
// 这里保留 SPLIT_FILE_RE 这个导出名 —— manual_doc_box / task_handlers 都在用。
const SPLIT_FILE_RE = SLICE_SUFFIX_RE;

// 每边想外扩多少(占该框自身边长的比例)。框略小时把票切掉一角是最常见的抱怨,
// 留余量比裁得紧重要。真正的上限由"不让隔壁完整入镜"兜住,不靠这个数。
const DEFAULT_PAD_RATIO = 0.15;

// 裁片最小边长(归一化)。比这还小说明框已经退化,裁出来是个噪点。
const MIN_CROP_SIDE = 0.02;

function toBox(value) {
  if (!value || typeof value !== 'object') return null;
  const left = Number(value.left);
  const top = Number(value.top);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { left, top, width, height };
}

const rightOf = (b) => b.left + b.width;
const bottomOf = (b) => b.top + b.height;

function isAlreadyCropped(task = {}) {
  const rel = String(task.sourceImagePath || '').trim();
  if (!rel) return false;
  return SPLIT_FILE_RE.test(path.posix.basename(rel.split('\\').join('/')));
}

// 矩形 crop 是否**完整包含**框 b。这是约束 ② 的直接翻译:
// 画面里出现一张完整的隔壁票 = 违规。
function fullyContains(crop, b) {
  return crop.x1 <= b.left && crop.y1 <= b.top
    && crop.x2 >= rightOf(b) && crop.y2 >= bottomOf(b);
}

// 两个区间是否有重叠(用来判断"朝这个方向扩会不会碰到这个兄弟框")
function overlaps1d(a1, a2, b1, b2) {
  return Math.min(a2, b2) - Math.max(a1, b1) > 0;
}

// 按框算交付裁剪矩形。
//
// 规则:每边想扩 padRatio,但**朝着某个兄弟框扩时,最多扩到那个框的中线为止**。
// 为什么用中线而不是"兄弟框的边缘":
//   用边缘只能保证不越界,遇到框重叠就无解;
//   用中线,无论框怎么摆都有确定答案,而且"最多带隔壁半张"天然符合"带一点"。
function computeCropRect(box, siblings = [], padRatio = DEFAULT_PAD_RATIO) {
  const padX = box.width * padRatio;
  const padY = box.height * padRatio;
  let x1 = box.left - padX;
  let x2 = rightOf(box) + padX;
  let y1 = box.top - padY;
  let y2 = bottomOf(box) + padY;

  for (const s of siblings) {
    const midX = s.left + s.width / 2;
    const midY = s.top + s.height / 2;
    // 只有在另一轴上确实重叠时,朝这个方向扩才会碰到它
    if (overlaps1d(box.top, bottomOf(box), s.top, bottomOf(s))) {
      if (s.left < box.left) x1 = Math.max(x1, midX);       // 左邻:别越过它的中线
      if (rightOf(s) > rightOf(box)) x2 = Math.min(x2, midX); // 右邻:同理
    }
    if (overlaps1d(box.left, rightOf(box), s.left, rightOf(s))) {
      if (s.top < box.top) y1 = Math.max(y1, midY);
      if (bottomOf(s) > bottomOf(box)) y2 = Math.min(y2, midY);
    }
  }

  // 中线钳位可能把边推到本框里面(兄弟框和本框重叠时),那就退回本框自身的边 —— 至少不裁掉自己
  x1 = Math.min(x1, box.left);
  y1 = Math.min(y1, box.top);
  x2 = Math.max(x2, rightOf(box));
  y2 = Math.max(y2, bottomOf(box));

  return {
    x1: Math.max(0, x1),
    y1: Math.max(0, y1),
    x2: Math.min(1, x2),
    y2: Math.min(1, y2),
  };
}

// 决定这条任务的交付图怎么出。返回 { action, reason, rect }。
//   'as-is'  照旧用原文件(今天所有已切片任务 + 一图一票的百货 → 行为零变化)
//   'crop'   按框现裁
//   'block'  出不了合规的图,**不许进包**,写进「导出说明.txt」
function planDeliveryImage({
  task = {},
  siblingBoxes = [],
  sharesImageFile = false,
  padRatio = DEFAULT_PAD_RATIO,
} = {}) {
  const siblings = (siblingBoxes || []).map(toBox).filter(Boolean);
  // 框都是**原图坐标系**的。所以只有当任务指向整张原图时,按框裁才有意义;
  // 指向切片文件时框对不上 —— 这不是"暂不支持",是坐标系根本不同。
  // 0731:这里原来**只读 task.detectionBox**,而审核台那侧读的是
  // detectionBox || modelMeta.bbox。真数据里 119 条任务有 90 条的框只在
  // modelMeta.bbox 上 —— 于是交付把"框好好在那儿"的任务判成 duplicate_image_no_box
  //(字面意思就是"你没框"),审核台同时还画得好好的,两边说法相反。
  // 收成 lib/task_detection_box 单一读法。
  const detected = taskDetectionBox(task);
  const box = toBox(detected && {
    left: Math.min(detected[0], detected[2]),
    top: Math.min(detected[1], detected[3]),
    width: Math.abs(detected[2] - detected[0]),
    height: Math.abs(detected[3] - detected[1]),
  }) || toBox(task.manualBox);

  // ① 最要紧的一条:**有别的任务用同一个图片文件**。
  //    交付按票号命名出图,同一张照片会被当成多笔交易发多次,上家会认为我们重复报账。
  //    这就是「同图补小票」的现状(createManualReceiptTaskFromSource 原样复制
  //    sourceImagePath 且不带框),生产实测已有 4 条这样的任务、都还没导出 —— 已上膛未走火。
  if (sharesImageFile) {
    if (isAlreadyCropped(task)) {
      // 两条任务共用同一个**切片**文件:框是原图坐标系,在切片上裁不出正确区域。
      // 只能等人在原图上重新框(第2期),现在必须拦住。
      return { action: 'block', reason: 'duplicate_crop_file', rect: null };
    }
    if (!box) {
      return { action: 'block', reason: 'duplicate_image_no_box', rect: null };
    }
    // 有框且指向整图 → 按框裁,下面走通用路径
  } else {
    // ② 图本身已经是切片,且没人跟它共用 → 它就是那张单据,照旧(今天绝大多数任务)
    if (isAlreadyCropped(task)) {
      return { action: 'as-is', reason: 'already_cropped', rect: null };
    }
    // ③ 整图直通且这张图上只有它一个 → 照旧(百货就是这种,一图一票)
    //
    // ⚠️ 但**人工框优先**:审核员手画的框是一句明确的人类指令(这条任务对应的是这一块)。
    // 走到这里还 as-is 的话,框存下来了、界面上也画出来了,交付却当没看见,且不报错 ——
    // 又是一次「我画了框,然后呢?」。模型给的框不算(它就是"没切开"那个判断本身),
    // 只认 docBoxSource === 'manual'。
    if (!siblings.length && String(task.docBoxSource || '') !== 'manual') {
      return { action: 'as-is', reason: 'single_document', rect: null };
    }
  }

  // 整图 + 有兄弟框 + 自己没框:**照旧出图,不拦**。
  //
  // 第一版这里是 block,结果在生产上误拦 29%。复盘发现它不只是"太严",而是**冗余**:
  // 真正危险的是"两条记录出同一张图",而那个形态一定表现为**共用同一个图片文件**,
  // 已经被上面 ① 精确抓住(生产实测自然产生的共用 = 0 条,补票产生的 = 6 条)。
  // 这里再拦一次,拦的是"有兄弟但自己没框"——那只说明模型没给这条框,
  // 不代表会出重复图。宁可保守:护栏错拦会让交付包**少图**,而少图同样是事故。
  if (!box) {
    return { action: 'as-is', reason: 'no_box_keep_current', rect: null };
  }

  const rect = computeCropRect(box, siblings, padRatio);

  if (rect.x2 - rect.x1 < MIN_CROP_SIDE || rect.y2 - rect.y1 < MIN_CROP_SIDE) {
    return { action: 'block', reason: 'crop_too_small', rect };
  }

  // ④ 成品校验(约束 ② 的最后一道):裁出来的画面里若有一张**完整**的兄弟单据,
  //    违规。规则负责大多数情况,这道闸兜住剩下的(框本身就错时中线规则救不了)。
  const contained = siblings.filter((s) => fullyContains(rect, s));
  if (contained.length) {
    return { action: 'block', reason: 'contains_full_sibling', rect, containedCount: contained.length };
  }

  return { action: 'crop', reason: 'cropped_by_box', rect };
}

// 按矩形裁一份交付图落盘。
//
// 和 passport_mask.maskPassportRegion 走同一条 sharp 管线、同一套 EXIF 口径:
// **必须先 rotate() 再量宽高**,否则手机竖拍的图宽高互换、裁出来是错的一块
// (0729 我在金标脚本里就是这么撞的:直接用 metadata 的 width/height 导致 composite 报错)。
//
// 失败一律返回 { cropped:false, reason },**绝不静默回退用整图** —— 回退整图就是
// 「同一张照片当成多笔交易」那件事本身,那正是这个模块存在的理由。
async function renderCroppedDelivery({ sourcePath, destPath, rect, sharp }) {
  if (!sharp) return { cropped: false, reason: 'no_sharp' };
  if (!rect || !(rect.x2 > rect.x1) || !(rect.y2 > rect.y1)) {
    return { cropped: false, reason: 'rect_invalid' };
  }
  try {
    const uprightBuf = await sharp(sourcePath).rotate().toBuffer();
    const meta = await sharp(uprightBuf).metadata();
    const W = Number(meta.width || 0);
    const H = Number(meta.height || 0);
    if (!W || !H) return { cropped: false, reason: 'no_dimensions' };
    const px = toPixelRect(rect, W, H);
    if (px.width < 8 || px.height < 8) return { cropped: false, reason: 'region_too_small' };
    await sharp(uprightBuf).extract(px).jpeg({ quality: 92 }).toFile(destPath);
    return { cropped: true, pixelRect: px };
  } catch (error) {
    return { cropped: false, reason: `sharp_failed:${error?.message || error}` };
  }
}

// 归一化矩形 → 像素 extract 参数。EXIF 转正后宽高可能互换,和 passport_mask/裁片服务同口径。
function toPixelRect(rect, width, height) {
  const left = Math.max(0, Math.round(rect.x1 * width));
  const top = Math.max(0, Math.round(rect.y1 * height));
  const right = Math.min(width, Math.round(rect.x2 * width));
  const bottom = Math.min(height, Math.round(rect.y2 * height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 把「原图坐标系的护照框」重映射进「按框裁出来的那张票」的坐标系(0731)。
 *
 * 为什么需要它:0730 拍板「交付时先按框裁、再打码,顺序不能反」。裁完之后,
 * 原图坐标的护照框对这张裁片就不成立了 —— 必须换算,否则会涂错地方。
 *
 * 返回 null = 护照压根不在这张票的框里(两张票各一个框、护照只压着其中一张,
 * 是乐天百货同框票的常态)→ 这张裁片不需要打码,别硬涂。
 *
 * @param {number[]} bbox 原图归一化 [x1,y1,x2,y2]
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect 裁剪框(原图归一化)
 */
function remapBboxIntoCrop(bbox, rect) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !rect) return null;
  const nums = bbox.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const w = Number(rect.x2) - Number(rect.x1);
  const h = Number(rect.y2) - Number(rect.y1);
  if (!(w > 0) || !(h > 0)) return null;
  const bx1 = Math.min(nums[0], nums[2]);
  const by1 = Math.min(nums[1], nums[3]);
  const bx2 = Math.max(nums[0], nums[2]);
  const by2 = Math.max(nums[1], nums[3]);
  // 先裁到交集(护照可能只有一部分落在这张票里),再换算到裁片的 0~1
  const ix1 = Math.max(bx1, Number(rect.x1));
  const iy1 = Math.max(by1, Number(rect.y1));
  const ix2 = Math.min(bx2, Number(rect.x2));
  const iy2 = Math.min(by2, Number(rect.y2));
  if (!(ix2 - ix1 > 0) || !(iy2 - iy1 > 0)) return null; // 完全不重叠
  const out = [
    (ix1 - Number(rect.x1)) / w,
    (iy1 - Number(rect.y1)) / h,
    (ix2 - Number(rect.x1)) / w,
    (iy2 - Number(rect.y1)) / h,
  ].map((v) => Math.min(1, Math.max(0, v)));
  // 交集小到打不出有意义的遮罩(擦边)→ 当作不需要打码,交给调用方按"没护照"处理。
  // 阈值和 passport_mask.MIN_AREA_RATIO 是两回事:那边判"这框像不像护照",
  // 这边只判"值不值得涂"。
  if (!(out[2] - out[0] > 0.01) || !(out[3] - out[1] > 0.01)) return null;
  return out;
}

const BLOCK_REASON_TEXT = Object.freeze({
  duplicate_image_no_box: '这张图同时挂在多条小票记录上,又没有框,分不出哪块是哪张票',
  // ⚠️ 这里**不能**说「在原图上重新框出各自的范围」—— 切片任务不能手画框
  // (框是原图坐标系,在切片上对不上,lib/manual_doc_box 会直接拒)。
  // 那等于第三次给操作员指一个做不到的动作。只说他真能做的两条路。
  // 0731 上午:上一版的②「删掉这条、在原图那条任务上补小票重建再框」实测做不到 ——
  // qwen 流程原图不进批次(真批次 7 条切片任务里 0 条有整图兄弟),而补小票照抄
  // 源任务的 sourceImagePath,建出来还是切片。当天下午做了 P2-a(补票时把原图
  // 拷进批次)才让它成立,而且说法要改:不是"去原图那条任务",是**就在这条上**补。
  duplicate_crop_file: '这条记录和另一条共用同一个切片文件,没法分辨哪块是哪张票。'
    + '可行做法:①在其中一条上点「补小票」,补出来的那条会指向整张原图,可以在上面框;'
    + '②或者「更多」里「按店重切」让系统拿原图重切一次',
  no_box_multi_doc: '这张原图上有多张单据,但这条记录没有框,裁不出单张小票',
  crop_too_small: '按框裁出来的区域太小,不是一张完整小票',
  contains_full_sibling: '按框裁出来的画面里还有一整张别的小票,不符合「一票一图」',
});

function describeBlock(reason) {
  return BLOCK_REASON_TEXT[reason] || `无法出图(${reason})`;
}

// 给交付服务用的工厂:传一个批次,返回 (task) => plan。
// 一次 O(n) 建两张索引(谁和谁共用图片文件 / 谁和谁来自同一张原图),
// 之后每条任务 O(1)。**刻意不缓存跨批次**,理由同 review_doc_regions。
function createDeliveryImagePlanner(batch, { padRatio = DEFAULT_PAD_RATIO } = {}) {
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  // ⚠️ 只数**小票之间**的碰撞。护照和小票共用一个文件是乐天百货的正常设计
  // (combined=true:票面本来就护照+小票同框,交付里同一个文件既出「交易编号.jpg」
  // 又出「护照.jpg」)。第一版没收窄,护栏在健康的百货数据上直接亮了 ——
  // 判据 5:加拦截前先问它在健康生产数据上会不会亮。
  const byFile = new Map();
  for (const t of tasks) {
    if (String(t?.docTypeFinal || t?.docTypeAuto || '') !== 'receipt') continue;
    const rel = String(t?.sourceImagePath || '').trim();
    if (!rel) continue;
    byFile.set(rel, (byFile.get(rel) || 0) + 1);
  }
  const docIndex = buildDocRegionIndex(tasks);

  return function planFor(task) {
    const rel = String(task?.sourceImagePath || '').trim();
    const sharesImageFile = rel ? (byFile.get(rel) || 0) > 1 : false;
    // 兄弟也只算**小票**。用户的约束原话是「不能整个画面出现完整的两个小票」——
    // 护照出现在画面里是靠打码处理的(passport_mask),不是靠裁。
    // 把护照当兄弟会让百货同框票(护照+小票一张图)全部被误拦。
    const group = docIndex.get(originalGroupKeyOf(task) || '') || [];
    const siblingBoxes = group
      .filter((e) => e.taskId !== task?.id && e.docType === 'receipt')
      .map((e) => e.box);
    return planDeliveryImage({ task, siblingBoxes, sharesImageFile, padRatio });
  };
}

module.exports = {
  createDeliveryImagePlanner,
  renderCroppedDelivery,
  planDeliveryImage,
  computeCropRect,
  isAlreadyCropped,
  fullyContains,
  toPixelRect,
  remapBboxIntoCrop,
  describeBlock,
  DEFAULT_PAD_RATIO,
  MIN_CROP_SIDE,
  SPLIT_FILE_RE,
};
