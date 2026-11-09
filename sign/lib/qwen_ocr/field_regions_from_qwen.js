// 字段框(2026-07-29):把 qwen 返回的字段坐标转成审核台能画的形状。
//
// 背景:「字段框」这个功能 UI 一直在,但**生产数据是 0%** —— 7265 张小票 + 3029 本护照
// 一个字段坐标都没有。它读的是 `receiptFieldModelMeta.detections[label].box`,
// 那是 PaddleX 时代 receipt_field_model 阶段的产物;换成 qwen 之后那个阶段就不跑了,
// 于是按钮从上线起一直是灰的(`:disabled="!fieldRegionCount"`)。0729 拍板:补数据。
//
// 这里只做一件事,而且是最容易出错的那件:**坐标系换算**。
//   qwen 给的字段框 = 相对**整张照片**的归一化坐标
//   审核台看的图   = 按文档 bbox 裁出来的**切片**
// 不换算直接用,框会整片跑到左上角去,而且**不会报错** —— 和 0729 那次
// 「切片文件名前缀」事故同一类:判据对不上真实数据,只会静默画歪。

// 审核台认的字段名(和 review_field_regions 的 modelLabel 一一对应)。
// qwen 侧用驼峰,这里做映射,不让两边的命名互相污染。
const RECEIPT_FIELD_LABEL_BY_QWEN_KEY = Object.freeze({
  receiptNo: 'receipt_no_region',
  groupNo: 'group_no_region',
  purchaseDate: 'purchase_date_region',
  departureDate: 'departure_date_region',
  store: 'store_family_region',
});

const PASSPORT_FIELD_LABEL_BY_QWEN_KEY = Object.freeze({
  englishName: 'english_name_region',
  passportNo: 'passport_no_region',
  chineseName: 'chinese_name_region',
});

function toNormalizedBox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let v = raw.map(Number);
  if (v.some((n) => !Number.isFinite(n))) return null;
  // 和文档 bbox 同样的容错:模型偶尔按 0~1000 给,按最大值折回 0~1
  if (v.some((n) => n > 1.5)) {
    const max = Math.max(...v);
    const scale = max > 100 ? 1000 : 100;
    v = v.map((n) => n / scale);
  }
  const x1 = Math.min(v[0], v[2]);
  const y1 = Math.min(v[1], v[3]);
  const x2 = Math.max(v[0], v[2]);
  const y2 = Math.max(v[1], v[3]);
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return [x1, y1, x2, y2];
}

// 整图坐标 → 切片内坐标。cropBox 是这份切片对应的文档 bbox(整图归一化)。
// 不传 cropBox = 这张图没被裁过(整图直通),原样返回。
// 字段完全落在切片外 → 返回 null(不画,总比画错强)。
function toCropRelative(fieldBox, cropBox) {
  if (!cropBox) return fieldBox;
  const [cx1, cy1, cx2, cy2] = cropBox;
  const cw = cx2 - cx1;
  const ch = cy2 - cy1;
  if (!(cw > 0) || !(ch > 0)) return null;
  const left = (fieldBox[0] - cx1) / cw;
  const top = (fieldBox[1] - cy1) / ch;
  const right = (fieldBox[2] - cx1) / cw;
  const bottom = (fieldBox[3] - cy1) / ch;
  // 整块都在切片外 → 这个字段不是这张单据的,丢弃
  if (right <= 0 || bottom <= 0 || left >= 1 || top >= 1) return null;
  const clamped = [
    Math.max(0, Math.min(1, left)),
    Math.max(0, Math.min(1, top)),
    Math.max(0, Math.min(1, right)),
    Math.max(0, Math.min(1, bottom)),
  ];
  if (!(clamped[2] > clamped[0]) || !(clamped[3] > clamped[1])) return null;
  return clamped;
}

// 太小的框画出来是个点,只会干扰;太大的(占了大半张票)说明模型没定位到,不如不画。
const MIN_FIELD_AREA = 0.0004; // 0.04%
const MAX_FIELD_AREA = 0.6;

function plausibleFieldBox(box) {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  return area >= MIN_FIELD_AREA && area <= MAX_FIELD_AREA;
}

// 产出 review_field_regions 认识的 meta:{ source, fields, detections }。
// detections[label].box 用 {left,top,width,height},**归一化 0~1**
// (与文档框同口径;前端两层因此共用一套定位换算,不再有"两个坐标系"这个坑)。
function buildFieldModelMeta({ fieldBoxes, fields = {}, cropBox = null, docType = 'receipt' } = {}) {
  const labelMap = docType === 'passport'
    ? PASSPORT_FIELD_LABEL_BY_QWEN_KEY
    : RECEIPT_FIELD_LABEL_BY_QWEN_KEY;
  if (!fieldBoxes || typeof fieldBoxes !== 'object') return null;

  const detections = {};
  const outFields = {};
  for (const [qwenKey, label] of Object.entries(labelMap)) {
    const norm = toNormalizedBox(fieldBoxes[qwenKey]);
    if (!norm) continue;
    const rel = toCropRelative(norm, cropBox);
    if (!rel || !plausibleFieldBox(rel)) continue;
    detections[label] = {
      box: {
        left: rel[0],
        top: rel[1],
        width: rel[2] - rel[0],
        height: rel[3] - rel[1],
      },
    };
    const value = fields[qwenKey];
    if (value != null && String(value).trim()) outFields[label] = { value: String(value).trim() };
  }

  if (!Object.keys(detections).length) return null;
  return { source: 'qwen', fields: outFields, detections };
}

module.exports = {
  buildFieldModelMeta,
  toNormalizedBox,
  toCropRelative,
  plausibleFieldBox,
  RECEIPT_FIELD_LABEL_BY_QWEN_KEY,
  PASSPORT_FIELD_LABEL_BY_QWEN_KEY,
  MIN_FIELD_AREA,
  MAX_FIELD_AREA,
};
