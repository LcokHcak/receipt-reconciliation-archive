'use strict';

// 切片文件名的两种判据 —— **它们不是一回事**,分开命名是这个模块存在的全部理由。
//
// 0731 实测:同一个概念散在四处,而且其中两处**同名不同义**:
//   delivery_render.js      SPLIT_FILE_RE = /_(receipt|…)_\d+\.\w+$/        (只看后缀)
//   review_doc_regions.js   SPLIT_FILE_RE = /^\d+-(.+?)_(receipt|…)_\d+…$/  (要求 NN- 前缀)
//   task_original_image.js  SPLIT_NAME_RE / SPLIT_NAME_SUFFIX_RE            (上面两个各一份)
//   task_resplit_service.js 现拼字符串
// 拿真数据跑,230 个文件名里 **7 个两套判据结论相反** —— 全是切片任务的
// sourceImagePath。今天各自用在对的字段上,所以还不是活 bug;
// 但两个同名常量表达两件事,下一个人 import 错一个不会有任何报错。
//
// 差别的根子在**两种文件名活在两个地方**:
//   客户库里:  NN-<base>_receipt_1.jpg        ← 有 NN- 前缀,能反解出 <base>
//   批次里:    task_0004__NN-<base>_receipt_1.jpg  ← 前面还挂了 task_NNNN__
// 所以"能不能反解出原图 base"只对客户库名成立,而"是不是切片"两种名都要能判。

// ⚠️ 四种切片角色都要认(receipt/passport/region/other)。
// 只认 receipt 是这个仓库反复犯过的错 —— 护照和小票常常同框。
//
// ⚠️ 判"是不是切片"**只能按后缀**,不能锚定开头:批次侧文件名带 task_NNNN__ 前缀。
// 锚开头在生产上误拦过 **51371 条小票里的 14971 条(29%)**,已部署过一次,
// 靠全库回放才发现。教训原话:文件名格式必须拿**生产真实值**验证,
// 不能照着客户库那份格式写。
/** 后缀式:这个文件名是不是一个切片?两种命名都适用(批次内 / 客户库)。 */
const SLICE_SUFFIX_RE = /_(?:receipt|passport|region|other)_\d+\.\w+$/;

/** 全名式:**仅**客户库命名,能反解出原图 base(捕获组 1)。批次内名匹配不上,这是设计。 */
const LIBRARY_SLICE_RE = /^\d+-(.+?)_(?:receipt|passport|region|other)_\d+\.\w+$/;

function baseNameOf(p) {
  return String(p || '').split('\\').join('/').split('/').pop() || '';
}

/** 这条路径指向的是不是切片文件。传整路径或纯文件名都行。 */
function isSliceFileName(pathOrName) {
  return SLICE_SUFFIX_RE.test(baseNameOf(pathOrName));
}

/**
 * 从**客户库**切片名反解原图 base;不是客户库切片名则返回 ''。
 * 批次内名(task_0004__…)返回 '' —— 那不是失败,是它本来就没带可反解的结构。
 */
function librarySliceBase(pathOrName) {
  const m = baseNameOf(pathOrName).match(LIBRARY_SLICE_RE);
  return m ? m[1] : '';
}

module.exports = {
  SLICE_SUFFIX_RE,
  LIBRARY_SLICE_RE,
  isSliceFileName,
  librarySliceBase,
};
