const { taskDetectionBox } = require('./task_detection_box');
const { LIBRARY_SLICE_RE } = require('./slice_file_name');
// 文档框(2026-07-29 切图改框选·第 1 期):同一张原图上「识别出了哪几张单据」的框。
//
// 和字段框(review_field_regions.js)的关系——两者天然互斥,不会同屏打架:
//   字段框:切片坐标系,看**切片**时显示(ImageViewer 在 showOriginal 时主动清空它,
//           因为切片坐标放到原图上对不上)
//   文档框:原图坐标系,看**原图**时显示 ← 本文件
//
// 为什么需要它(生产实测,最近 40 批 7265 条小票任务):
//   多票同图 808/6121 张原图 = 13.2%,受影响任务 1952/7265 = 26.9%
//   最多的一张图上有 9 张票
// 而「少切了一张」这种错**今天在界面上根本发现不了**——那条记录压根没产生过。
// 把兄弟框画在原图上,操作员一眼能看出「这块没被框住」。
//
// 数据来源是切图时就落好的 detectionBox,**不用重跑识别**(实测 808 组框 100% 齐全)。

// 切片文件名格式:`NN-<base>_(receipt|passport|region|other)_N.ext`
// 这里要的是**能反解出原图 base**那一种,所以用「客户库全名式」而不是后缀式 ——
// 它作用在 sourceOriginalPath(客户库路径)上。批次内名(task_NNNN__…)匹配不上,
// 那是设计不是缺陷:批次内名本来就没带可反解的结构。
// 0731 收敛:这个判据原来四处各一份、两处同名不同义,现在单一真相源在 lib/slice_file_name。
const SPLIT_FILE_RE = LIBRARY_SLICE_RE;

// 一个框被另一个框吃掉多少算「可疑」。0.5 不是拍脑袋:生产实测 808 个多票组里
//   ≥50% 被套住 92 组(11.4%)—— 抽样全是真缺陷(有 100% 完全套住的)
//   5%~50%     125 组(15.5%)—— 票本身挨着,多半正常
// 阈值定在 50% 正好卡在这两档中间。
const SUSPECT_CONTAINMENT_RATIO = 0.5;

const DOC_TYPE_LABELS = Object.freeze({
  receipt: '小票',
  passport: '护照',
  other: '待定',
});

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// detectionBox 是模型给的归一化 [x1,y1,x2,y2];这里转成和字段框一致的
// {left,top,width,height},让前端两层覆盖物能共用同一套定位样式。
function normalizeDetectionBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [x1, y1, x2, y2] = box.map(toFiniteNumber);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  // 退化框(零宽/零高)直接丢弃:画出来是一条线,只会干扰视线
  if (!(width > 0) || !(height > 0)) return null;
  return { left, top, width, height };
}

// 同一张原图的分组键 = 客户目录 + 原图 base。
// 切片名里带 base,没切过的图用自己的路径当键(自成一组,没有兄弟)。
function originalGroupKeyOf(task = {}) {
  const rel = String(task.sourceOriginalPath || task.sourceImagePath || '').trim();
  if (!rel) return null;
  const parts = rel.split('/');
  const fileName = parts.pop() || '';
  const dir = parts.join('/');
  const matched = fileName.match(SPLIT_FILE_RE);
  return matched ? `${dir}/${matched[1]}` : rel;
}

function docTypeOf(task = {}) {
  return String(task.docTypeFinal || task.docTypeAuto || task.docType || '').trim();
}

// 框上的标签:优先票号(操作员就是按票号回找的),没有就退到单据类型。
// 标签只在悬停时显示,静止时画面保持干净(见 ImageViewer 的 .doc-region-label)。
function labelOf(task = {}) {
  const docType = docTypeOf(task);
  if (docType === 'receipt') {
    const receiptNo = String(task.receiptNoFinal || task.receiptNoAuto || '').trim();
    if (receiptNo) return receiptNo;
  }
  return DOC_TYPE_LABELS[docType] || DOC_TYPE_LABELS.other;
}

// 票号归一化:去掉横线/空格/大小写差异再比。判「重复任务」用它。
function normalizeReceiptNoKey(task = {}) {
  const raw = String(task.receiptNoFinal || task.receiptNoAuto || '').trim();
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function areaOf(box) {
  return box.width * box.height;
}

function intersectionArea(a, b) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

// 「小框被大框吃掉多少」——这是判断「一个框罩住了两张票」最直接的信号。
// 用 min(面积) 当分母而不是并集(IoU):两张票并排轻微重叠时 IoU 很小,
// 而「一个框套住另一个」时本比值接近 1,正是我们要抓的形态。
function containmentRatio(a, b) {
  const overlap = intersectionArea(a, b);
  if (overlap <= 0) return 0;
  const smaller = Math.min(areaOf(a), areaOf(b));
  return smaller > 0 ? overlap / smaller : 0;
}

// 建索引:同一张原图下的任务归到一组。O(n),每个响应建一次。
// 刻意不做缓存——脏索引会让操作员看到别的图的框,而这种错没有任何报错,
// 正是 0729 一整天在修的那类静默错误。宁可每次重算。
function buildDocRegionIndex(tasks = []) {
  const index = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== 'object') continue;
    const key = originalGroupKeyOf(task);
    if (!key) continue;
    const box = normalizeDetectionBox(taskDetectionBox(task));
    if (!box) continue; // 没框的任务(整图直通)不参与:画不出来,也没有兄弟关系可言
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      taskId: task.id,
      box,
      docType: docTypeOf(task),
      label: labelOf(task),
      // 归一化票号:判「同一张票被框了两次」要靠它,不能靠框的几何形状(见下)
      receiptNoKey: normalizeReceiptNoKey(task),
    });
  }
  return index;
}

// 给一条任务算出「这张原图上的所有文档框」,标出哪个是它自己。
// 组里只有它自己一个框时返回空数组——单框没有回找价值,画出来只是噪音。
function buildTaskDocRegions(task = {}, index = null) {
  const key = originalGroupKeyOf(task);
  if (!key) return [];
  const group = (index instanceof Map ? index : buildDocRegionIndex([task])).get(key);
  if (!Array.isArray(group) || group.length < 2) {
    // 单单据的图默认不画框(「单张图没有『哪一块』可言,多余的框是噪音」)——
    // 这条对**模型框**成立,对**人工框**不成立。
    // 0730 金标实跑闭环测试抓到:审核员在整图上拖了框,框存下来了、交付判定也当场
    // 变成「按框裁」(deliveryImagePlan: crop/cropped_by_box),但界面上一条框都不画,
    // 于是又是一次「我画了框,然后呢?还是显示这个」—— 生效了却零反馈。
    // 人工框是操作员特意画的,必须看得见、也才能核对和重画。
    if (String(task.docBoxSource || '') !== 'manual') return [];
    const box = normalizeDetectionBox(task.manualBox || taskDetectionBox(task));
    if (!box) return [];
    return [{
      taskId: task.id,
      isCurrent: true,
      box,
      docType: String(task.docTypeFinal || task.docTypeAuto || '').trim(),
      label: String(task.receiptNoFinal || task.receiptNoAuto || '').trim(),
      suspect: false,
      duplicateOf: '',
      overlapRatio: 0,
    }];
  }

  return group.map((entry) => {
    // 「可疑」的口径经过两轮生产实测才定下来,过程值得留着:
    //
    // v1 纯几何(任何两个框重叠 ≥50%)→ 72262 条任务里亮 4507 条(6.24%),
    //    样本全是 receipt+passport 配对、重叠比一模一样 —— 护照压着小票是最常见的
    //    正常拍照形态(乐天百货整个业务就是护照+小票同框),纯误报。
    // v2 只算小票之间 → 降到 3232 条(4.47%),但**全部已审完**,而且样本里
    //    「票01-264-020-0004-1」和「-2」重叠 1.0 却是**两张不同的票**,审核员都填对了。
    //    因为**字段是从整图抽的、不是从切片抽的**(既有设计)—— 框重叠不影响字段正确性。
    //    所以纯几何重叠**不是可操作的信号**,亮 4.47% 只会让人学会无视。
    // v3(现在)几何重叠 **且 票号相同** = 同一张票被框了两次 / 拆出了重复任务。
    //    生产实测:2439 对重叠里只有 **130 对**票号相同(5.3%),
    //    折算 0.506% 的任务 —— 这个量级才配得上红标,而且是真缺陷。
    let worst = 0;
    let duplicateOf = '';
    for (const other of group) {
      if (other === entry) continue;
      if (entry.docType !== 'receipt' || other.docType !== 'receipt') continue;
      const ratio = containmentRatio(entry.box, other.box);
      if (ratio > worst) worst = ratio;
      if (ratio >= SUSPECT_CONTAINMENT_RATIO
        && entry.receiptNoKey && other.receiptNoKey
        && entry.receiptNoKey === other.receiptNoKey) {
        duplicateOf = other.taskId;
      }
    }
    const suspect = Boolean(duplicateOf);
    return {
      taskId: entry.taskId,
      isCurrent: entry.taskId === task.id,
      box: entry.box,
      docType: entry.docType,
      label: entry.label,
      // suspect = 框重叠 **且** 票号和另一条相同 → 同一张票出了两条任务。
      // duplicateOf 指向那一条,便于界面直接说「和 XXX 是同一张」。
      // overlapRatio 仍是纯几何值(排查用),但**不再单独作为告警依据**。
      suspect,
      duplicateOf,
      overlapRatio: Number(worst.toFixed(3)),
    };
  });
}

module.exports = {
  buildDocRegionIndex,
  buildTaskDocRegions,
  originalGroupKeyOf,
  normalizeDetectionBox,
  containmentRatio,
  SUSPECT_CONTAINMENT_RATIO,
};
