'use strict';

// sidecar:千问预处理把每张(子)图的 analysis 落成 `<图>.qwen.json`,
// 批处理 qwen 模式按图片路径读回 → 字段从预处理带到批处理的唯一通道。
// 好处:不动 createImportedImageTask/桥接;按图片路径寻址,天然对齐任务。

const fs = require('node:fs');

const SIDECAR_SUFFIX = '.qwen.json';

function sidecarPath(imagePath) {
  return `${String(imagePath || '')}${SIDECAR_SUFFIX}`;
}

function writeSidecar(imagePath, analysis) {
  try {
    fs.writeFileSync(sidecarPath(imagePath), JSON.stringify(analysis ?? null), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// 读不到 / 解析失败 → 返回 null(调用方据此走兜底:就地调千问或转人工)
function readSidecar(imagePath) {
  try {
    const p = sidecarPath(imagePath);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasSidecar(imagePath) {
  return fs.existsSync(sidecarPath(imagePath));
}

// 缓存可复用判定(纯函数,ensureQwenSidecar 用):
//   ① prompt 版本不符 → 作废重调。旧 prompt 的错误结果会潜伏在队列里等着回放
//      (2026-07-03:改 prompt 前建档写的 sidecar 随图拷进批次,识别时把示例泄漏
//      的团号 71990 又放了出来;上午的按值扫描修复扫不到"还没识别"的任务)。
//   ② qwen_failed(API 故障期写入的失败兜底)→ 作废重调,别把故障永久缓存
//      (毒 sidecar 事故同源;qwen_no_document 是正常结论——航班截图等,照常复用)。
//   ③ 百货补救(2026-07-12 复审 HIGH):走过第二段的结果带 modelMeta.deptRescue,
//      其 promptVersion 与当前 DEPT_RESCUE_PROMPT_VERSION 不符同样作废——否则补救
//      prompt 迭代后旧补救结果潜伏回放,71990 同款坑在第二段重演;补救调用失败
//      (dept_rescue_failed)同 qwen_failed 待遇,瞬时网络抖动不该被永久缓存钉死。
const { DEPT_RESCUE_PROMPT_VERSION } = require('./qwen_client');
const { detectDeptRescueSignals } = require('./dept_rescue');

// ④ 存量百货嫌疑缓存(上线体检 HIGH#1):发布前生产落盘的百货 sidecar 没有
//    deptRescue 戳(旧适配器不存在两段式),promptVersion 又没升——按①②③全放行,
//    两段式/诚实闸/现代新规格对存量图永不生效。这里用**同一套信号大脑**兜:
//    缓存重建伪文档过 detectDeptRescueSignals,命中百货信号但没有补救戳 → 作废重调。
//    免税店常规缓存(店名正典/票号常规形态)信号恒不命中,海量缓存零打扰。
//    已知局限:护照+小票同框信号需要同图多文档,单条缓存看不见——那批存量错票
//    本就已切片成任务,修复走「改店→按此店重切」SOP,不靠缓存失效。
function isDeptSuspectWithoutRescue(analysis) {
  if (String(analysis.docTypeFinal || '') !== 'receipt') return false;
  if (analysis.modelMeta?.deptRescue) return false; // 走过两段式,版本另判
  const pseudoDoc = {
    type: 'receipt',
    fields: {
      storeFamily: analysis.receiptStoreAuto || '',
      receiptNo: analysis.receiptNoRawAuto || analysis.receiptNoAuto || '',
    },
  };
  return detectDeptRescueSignals([pseudoDoc]).hit;
}

// opts.model / opts.maxEdge:当前装配的 OCR 模型与分辨率。给了就必须与 sidecar 打的戳
// 一致才复用——换 qwen-vl-max→qwen3-vl-plus 或 1280→2400 后,旧戳(或无戳的更旧缓存)
// 一律作废重调,否则模型/分辨率切换对存量预处理是静默 no-op(2026-07-21 部署审计)。
// 不传 opts 时按老行为(只认 promptVersion),保持既有调用/测试兼容。
function isSidecarReusable(analysis, currentPromptVersion, opts = {}) {
  if (!analysis || typeof analysis !== 'object') return false;
  if (Number(analysis.promptVersion) !== Number(currentPromptVersion)) return false;
  const reasons = Array.isArray(analysis.reviewReasons) ? analysis.reviewReasons : [];
  if (reasons.includes('qwen_failed')) return false;
  if (reasons.includes('dept_rescue_failed')) return false;
  const rescueStamp = analysis.modelMeta?.deptRescue?.promptVersion;
  if (rescueStamp != null && Number(rescueStamp) !== Number(DEPT_RESCUE_PROMPT_VERSION)) return false;
  if (isDeptSuspectWithoutRescue(analysis)) return false;
  if (opts.model != null && String(analysis.ocrModel || '') !== String(opts.model)) return false;
  if (opts.maxEdge != null && Number(analysis.ocrMaxEdge || 0) !== Number(opts.maxEdge)) return false;
  // 0727#8:锐化开关戳。翻转(开↔关)后旧缓存作废重识别——预处理变了,缓存结果不再代表当前管线。
  if (opts.sharpen != null && Number(analysis.ocrSharpen || 0) !== (opts.sharpen ? 1 : 0)) return false;
  return true;
}

module.exports = { SIDECAR_SUFFIX, sidecarPath, writeSidecar, readSidecar, hasSidecar, isSidecarReusable };
