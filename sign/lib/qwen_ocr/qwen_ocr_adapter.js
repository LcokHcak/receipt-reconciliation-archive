'use strict';

// 千问 OCR 后端适配器 —— 把"一张图"变成与 PaddleX 同构的 analysis 对象数组。
//
// 设计:复用 sign 自己的 createDocTypeFields / normalizeOcrFieldsForDocType / validateAll,
// 只把"字段来源"从"PaddleX OCR + 规则解析"换成"千问一次调用返回的结构化字段"。
// → 产出的 analysis 与 analyzeDocumentOcr 的 `base` 同结构,下游(审核台/桥接/台账)零改动。
//
// 默认不被装配根启用(SIGN_OCR_BACKEND=paddle);P1 才接线。

const path = require('node:path');
const { buildFieldModelMeta } = require('./field_regions_from_qwen');
const fs = require('node:fs');
const sharp = require('sharp');

const { DOC_TYPES } = require('../package_constants');
const { createDocTypeFields } = require('../workbench_task_flow');
const { normalizeOcrFieldsForDocType } = require('../workbench_field_normalizer');
const { validateAll, TOUR_NO_LENGTH_BY_STORE, REASONS } = require('../validation/field_rules');
const { getStoreProfile, FAMILY } = require('../store_profiles');

const {
  analyzeImage: callQwen, buildDeptRescuePrompt, buildReceiptNoRepairPrompt, parseJsonLoose,
  QWEN_PROMPT_VERSION, DEPT_RESCUE_PROMPT_VERSION, RECEIPT_NO_REPAIR_PROMPT_VERSION,
} = require('./qwen_client');
const {
  detectDeptRescueSignals, parseDeptRescue, applyDeptRescue, deriveDeptReceiptFields,
} = require('./dept_rescue');
const { resolvePassportNo, parseMrzName } = require('./mrz_parser');
const { collectPassportCandidates, pickPassportNo } = require('./passport_resolver');
const {
  groupDigits, normalizeDate, normalizeStoreFamily,
  normalizeDeptAmount, normalizeDeptBrand,
  isJunkNumericValue,
} = require('./field_normalizer');
const { withRetry } = require('./concurrency_pool');
const { checkReceiptNoAnchors, decideReceiptNoRepair, isAnchorReason } = require('./receipt_no_anchors');
const { decodeReceiptNoBarcodes, pickBarcodeReceiptNo } = require('./receipt_no_barcode');

// P2 票号二遍重读(2026-07-20 错误矩阵;二批 90% 冲刺扩全五店):
//   店集合 QWEN_RECEIPT_NO_REPAIR_STORES(逗号分隔 canonical 店名)
//   模式  QWEN_RECEIPT_NO_REPAIR_MODE:anchor=锚点未过/漏识别才二遍(省调用);
//         always=启用店每张小票都双读(串尾个位混淆唯一解;两遍一致=互证,
//         不一致按锚点仲裁,仲裁不了保一遍值+mismatch 红标转人工)
// 三批选型(2026-07-21,80 张生产随机样本投影,用户拍板"不翻倍"):
//   A 全店 anchor 触发二遍+条码 = 88.2%(约 +25% 调用)
//   D 新世界/现代 always 双读+其余 anchor+条码 = 89.8%(约 +35%,⭐默认)
//   E 全店 always+条码 = 91.1%(调用翻倍,要冲顶且接受成本再 env 升)
// 条码层零 API 每张白检;双读一致 29/30 全对、分歧保一遍 8:3。
//   QWEN_RECEIPT_NO_REPAIR_MODE:anchor|always(全局档,always=全店双读)
//   QWEN_RECEIPT_NO_REPAIR_ALWAYS_STORES:anchor 档下仍强制双读的店(D 档的实现)
const DEFAULT_REPAIR_STORES = 'LOTTE,SHINSEGAE,HYUNDAI,THE SHILLA,SHILLA IPARK';
const DEFAULT_ALWAYS_STORES = 'SHINSEGAE,HYUNDAI';
function parseStoreList(raw, fallback) {
  return new Set(String(raw == null || raw === '' ? fallback : raw)
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}
function resolveRepairConfig() {
  const stores = parseStoreList(process.env.QWEN_RECEIPT_NO_REPAIR_STORES, DEFAULT_REPAIR_STORES);
  const mode = String(process.env.QWEN_RECEIPT_NO_REPAIR_MODE || 'anchor').trim().toLowerCase() === 'always'
    ? 'always' : 'anchor';
  const alwaysStores = mode === 'always'
    ? stores
    : parseStoreList(process.env.QWEN_RECEIPT_NO_REPAIR_ALWAYS_STORES, DEFAULT_ALWAYS_STORES);
  return { stores, mode, alwaysStores };
}

const normAlnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 与 paddle_document_analyzer.runFieldValidation 同口径,保证 reviewReasons 一致
function runFieldValidation(docType, base) {
  if (docType === DOC_TYPES.PASSPORT) {
    const { reasons } = validateAll({
      chineseName: base.chineseNameAuto,
      englishName: base.extractedNameAuto,
      passportNo: base.passportNoAuto,
      storeFamily: 'LOTTE',
      receiptNo: 'placeholder',
      tourNo: 'placeholder',
      purchaseDate: '',
      departureDate: '',
    });
    // 2026-06-30 中文名下线:不再因中文名 OCR 异常把任务推进复核队列(审核台已不审中文名)。
    return reasons.filter((r) => (
      r === 'field_english_name_invalid'
      || r === 'field_passport_no_invalid'
    ));
  }
  if (docType === DOC_TYPES.RECEIPT) {
    const { reasons } = validateAll({
      chineseName: base.chineseNameAuto,
      englishName: base.extractedNameAuto,
      passportNo: base.passportNoAuto,
      storeFamily: base.receiptStoreAuto,
      receiptNo: base.receiptNoAuto,
      tourNo: base.groupNoAuto,
      purchaseDate: base.purchaseDateAuto,
      departureDate: base.departureDateAuto,
    });
    // 百货(P2):票面上本来就没有团号/出境日期(档案未声明这两个字段),
    // 免税店口径的这几条对百货是必然误报 → 剔除;百货专属校验(8位交易编号/品牌白名单)在 P3。
    const profile = getStoreProfile(base.receiptStoreAuto);
    if (profile.family === FAMILY.DEPT) {
      const drop = new Set([REASONS.TOUR_NO, REASONS.DEPARTURE_DATE, REASONS.DATE_RANGE]);
      return reasons.filter((r) => !drop.has(r));
    }
    return reasons;
  }
  return [];
}

function qwenTypeToDocType(type) {
  if (type === 'passport') return DOC_TYPES.PASSPORT;
  if (type === 'receipt') return DOC_TYPES.RECEIPT;
  return DOC_TYPES.OTHER;
}

// 单个千问文档 → analysis(同 base 结构)
function buildAnalysisForDoc(doc, ctx) {
  const { sourcePath, sourceKey, confidenceThreshold, resolvedPassport } = ctx;
  const docType = qwenTypeToDocType(doc.type);
  const conf = typeof doc.confidence === 'number' ? doc.confidence : null; // null = 千问没给置信度

  const base = {
    ...createDocTypeFields({
      docTypeAuto: docType,
      docTypeFinal: docType,
      docTypeConfidence: conf ?? 0,
      needsReview: false,
      reviewReasons: [],
      sourceOriginalPath: sourcePath,
      sourceFolderName: sourcePath ? path.basename(path.dirname(sourcePath)) : '',
      sourceFileName: sourcePath ? path.basename(sourcePath) : '',
      sourceKey,
    }),
    lineCount: 0,
    averageOcrScore: conf ?? 0,
    ocrPreview: '',
    ocrText: '',
    ocrError: '',
    extractedNameAuto: '',
    chineseNameAuto: '',
    passportNoAuto: '',
    receiptNoAuto: '',
    groupNoAuto: '',
    purchaseDateAuto: '',
    departureDateAuto: '',
    receiptAmountAuto: '',
    receiptStoreAuto: '',
    receiptDateAuto: '',
    flightNoAuto: '',
    // 百货真字段(P2):门店/品牌(乐天百货)、上家(新世界/现代)。免税店恒空。
    branchAuto: '',
    brandAuto: '',
    upstreamAuto: '',
    classificationSource: 'qwen',
    // prompt 版本戳:sidecar 缓存据此判新旧,改 prompt 后旧缓存自动作废(isSidecarReusable)
    promptVersion: QWEN_PROMPT_VERSION,
    // 模型/分辨率戳(2026-07-21 换模型部署审计):切 QWEN_OCR_MODEL / QWEN_MAX_EDGE 后,
    // 旧模型/旧分辨率生成的 sidecar 必须作废重调——否则换 qwen3-vl-plus + 高清是静默 no-op
    // (旧 qwen-vl-max@1280 缓存 promptVersion 相同被当有效复用)。isSidecarReusable 据此拒绝。
    ocrModel: ctx.model || '',
    ocrMaxEdge: ctx.maxEdge || 0,
    ocrSharpen: ctx.sharpen ? 1 : 0, // 0727#8:锐化开关戳,翻转后旧 sidecar 作废(model 戳同款铁律)
    modelMeta: { backend: 'qwen', confidence: conf, bbox: doc.bbox, type: doc.type },
  };

  const f = doc.fields || {};
  const extraReasons = [];

  if (docType === DOC_TYPES.PASSPORT) {
    base.extractedNameAuto = String(f.englishName || '').trim();
    // 姓名优先取 MRZ 结构解析(0727反馈#12 姓/名顺序偶尔反):MRZ 姓<<名 的 << 分隔
    // 把顺序钉死,直读视觉区没有这个结构保障。只依赖 mrz1(第2行缺/坏不连坐);
    // 要求姓/名两段俱全才接管(半截不如直读);
    // 格式(姓␣名合并,#9)由下方 normalizeOcrFieldsForDocType→normalizePassportEnglishName 统一收口。
    const mrzName = f.mrz1 ? parseMrzName(f.mrz1) : null;
    if (mrzName?.surname && mrzName?.given && /^[A-Z ]+$/.test(mrzName.full)) {
      base.extractedNameAuto = mrzName.full;
      base.modelMeta.nameSource = 'mrz';
    }
    base.chineseNameAuto = String(f.chineseName || '').trim();
    // 每本护照优先用自己的 MRZ(同图多护照不会串号);自己 MRZ 没过才退到同图跨源(护照+小票)结果
    const own = resolvePassportNo(f.passportNo, f.mrz1, f.mrz2);
    let chosen = own;
    if (!own.mrzValid && resolvedPassport && resolvedPassport.mrzValid) chosen = resolvedPassport;
    else if (!own.passportNo && resolvedPassport && resolvedPassport.passportNo) chosen = resolvedPassport;
    base.passportNoAuto = chosen.passportNo || '';
    base.modelMeta.passportSource = chosen.source;
    base.modelMeta.mrzValid = Boolean(chosen.mrzValid);
    if (chosen.needsReview) extraReasons.push('passport_no_unverified');
  } else if (docType === DOC_TYPES.RECEIPT) {
    base.extractedNameAuto = String(f.englishName || '').trim(); // 小票也印客人英文名
    base.receiptStoreAuto = normalizeStoreFamily(f.storeFamily);
    base.receiptNoAuto = String(f.receiptNo || '').trim();
    // 团号按店自适应长度(新罗/爱宝客5位、乐天8位);单票,客户级共识在跨图 reconcile 做
    base.groupNoAuto = groupDigits(f.groupNo, TOUR_NO_LENGTH_BY_STORE[base.receiptStoreAuto]);
    base.purchaseDateAuto = normalizeDate(f.purchaseDate);
    base.departureDateAuto = normalizeDate(f.departureDate);
    base.receiptDateAuto = base.purchaseDateAuto;
    if (f.passportNo) base.passportNoAuto = normAlnum(f.passportNo);
  }

  // 字段归一(复用 sign,保证与 PaddleX 路径一致)
  Object.assign(base, normalizeOcrFieldsForDocType(base.docTypeFinal, base));

  // 百货真字段(P2):店归一成 *_DEPT 后按档案接 qwen 的 amount/branch/brand。
  // "借位"(金额填团号列/上家填姓名列)只发生在导出映射层,这里永远真字段(用户拍板)。
  if (base.docTypeFinal === DOC_TYPES.RECEIPT) {
    const profile = getStoreProfile(base.receiptStoreAuto);
    if (profile.family === FAMILY.DEPT) {
      const declared = new Set(profile.fields || []);
      if (declared.has('receiptAmount')) base.receiptAmountAuto = normalizeDeptAmount(f.amount);
      if (declared.has('brand')) base.brandAuto = normalizeDeptBrand(f.brand, profile.rules?.brand);
      // ⭐条码日期锚推导 + 诚实闸(四轮金标重放定稿;只对 transNo44 口径的店接管):
      // 远景照小字连裁片放大都读不稳,模型会产出"像样的错号"(日期当票号/5321编两处),
      // 8位错号能骗过格式校验带绿混进对账——比空值危险得多。收口:
      //   票号只信两种来源:①条码日期锚推导(锚前误读不传染锚后) ②票面 4-4 带杠形态直读;
      //   两来源都在且不一致 → 交叉标红;都没有 → 清空+标红转人工(票面就在审核员眼前,照抄即可)。
      // 现代百货(16位 2-6-3-5)无 transNo44 旗标 → 不进闸,票号走中央 normalizeReceiptNo
      // 透传,长度对错交给 P3 档案校验(复审 HIGH:硬套 4-4 会把现代票号整店废掉)。
      const transNo44 = profile.rules?.receiptNo?.transNo44 === true;
      const derived = transNo44 ? deriveDeptReceiptFields({
        barcodeDigits: f.barcodeDigits, purchaseDate: base.purchaseDateAuto,
      }) : { branch: '', receiptNo: '', amount: '' };
      if (transNo44) {
        const labelRaw = String(f.receiptNo || '').trim();
        // 4-4 带杠形态,且前后两段不同(四轮病例:模型编 "5321-5321" 同串重复,真票两段从不相同)
        const labelShapeOk = /^\d{4}\s*-\s*\d{4}$/.test(labelRaw)
          && labelRaw.slice(0, 4) !== labelRaw.replace(/\D/g, '').slice(-4);
        const labelDigits8 = labelShapeOk ? labelRaw.replace(/\D/g, '') : '';
        // 双源互证(五轮定稿):条码推导 + 标签直读一致才配绿灯;单一来源保值但标红
        // (五轮实测:单来源误读 0218-6312/1343-0579 一位之差能骗过一切形态校验)。
        if (derived.receiptNo && labelDigits8) {
          base.receiptNoAuto = derived.receiptNo;
          if (labelDigits8 !== derived.receiptNo) extraReasons.push('dept_receipt_no_cross_mismatch');
        } else if (derived.receiptNo || labelDigits8) {
          base.receiptNoAuto = derived.receiptNo || labelDigits8;
          extraReasons.push('dept_receipt_no_single_source');
        } else {
          base.receiptNoAuto = ''; // 非 4-4 形态(日期/杂串/授权号)一律不采——错绿比空红危险
          if (labelRaw) extraReasons.push('dept_receipt_no_unverified');
        }
        if (base.receiptNoAuto && profile.rules?.receiptNo?.dash === true) {
          base.receiptNoAuto = base.receiptNoAuto.replace(/^(\d{4})(\d{4})$/, '$1-$2');
        }
        // raw 留底同步(复审 MEDIUM):诚实闸改写后,receiptNoRawAuto 若仍是标签残留,
        // 就违背"raw=当前值归一化前原串"的契约(下游导出有相等性兜底,但别赌巧合)。
        base.receiptNoRawAuto = base.receiptNoAuto;
      }
      // 店码:只信条码推导。模型直读店码是编造重灾区(四轮实证 0/9~3/9),一律不采;
      // 空值走审核台必填闸,审核员照票面 4 位码补——比纠正一个像样的错码快。
      if (declared.has('branch')) base.branchAuto = derived.branch || '';
      // 金额:条码推导优先(与标签直读不一致标红);无条码交叉时保标签值但标"未验证",
      // 金额是钱,宁可审核员多看一眼。(现代百货档案无金额字段,declared 不含自然跳过)
      if (declared.has('receiptAmount')) {
        const labelAmount = String(base.receiptAmountAuto || '');
        if (derived.amount) {
          if (labelAmount && labelAmount !== derived.amount) {
            extraReasons.push('dept_amount_cross_mismatch');
          }
          base.receiptAmountAuto = derived.amount;
        } else if (labelAmount && transNo44) {
          extraReasons.push('dept_amount_unverified');
        }
      }
      // 上家:新世界固定=梁总(档案默认);现代默认=东方("无卡=东方"是规则本体,2026-07-12),
      // 但贴金浦奥莱积分卡要人工翻 → 档案 upstreamConfirm 旗标让默认值带红标,审核员看一眼贴没贴卡。
      if (declared.has('upstream')) {
        base.upstreamAuto = String(profile.defaults?.upstream || '');
        if (base.upstreamAuto && profile.rules?.upstreamConfirm === true) {
          extraReasons.push('dept_upstream_confirm');
        }
      }
      // 百货无团号:清掉 groupDigits 可能从票面乱抓的数字(柜台码/会员号),预匹配对空团号=中性无徽章
      base.groupNoAuto = '';
    } else {
      // ⭐票号结构锚点自检(2026-07-20 错误矩阵 P1):新世界/现代 16 位+嵌入日期、
      // 乐天 14 位+9 开头+年份段、济州 906=G 误读嫌疑——不符只标红不改值不清值
      // (位数不符→不给绿;错绿比空红危险,真旧格式票人工放行)。规格与数据依据
      // 见 receipt_no_anchors.js。
      const anchor = checkReceiptNoAnchors({
        storeFamily: base.receiptStoreAuto,
        receiptNo: base.receiptNoAuto,
        purchaseDate: base.purchaseDateAuto,
      });
      extraReasons.push(...anchor.reasons);
    }
  }

  // reviewReasons:低置信/置信未知 + 护照未验证 + sign 字段校验
  if (conf == null) extraReasons.push('qwen_confidence_unknown');
  else if (conf < confidenceThreshold) extraReasons.push('qwen_low_confidence');
  const validationReasons = runFieldValidation(base.docTypeFinal, base);
  const allReasons = [...new Set([...extraReasons, ...validationReasons].map((r) => String(r || '').trim()).filter(Boolean))];
  base.reviewReasons = allReasons;
  base.needsReview = allReasons.length > 0;

  // 字段框(0729 拍板「补数据」):把 qwen 给的字段坐标换算成切片内坐标,落成审核台
  // **已有的** receiptFieldModelMeta / passportFieldModelMeta 形状 —— 不新造结构。
  // 字段框这功能死掉正是因为两边形状对不上(PaddleX 时代的 detections 没人再生产)。
  // 坐标是相对整图的,而任务图是按 doc.bbox 裁出来的切片,必须换算,否则整片画到左上角。
  // 字段框采纳闸(2026-07-29 金标实拍 + 0730 拍板):
  //   百货 → **不给**。用户拍板:百货不需要字段框。实拍也证实那是最差场景
  //          (3~5 个文档合影,短字段乱铺:passportNo 画到签证页中间、MRZ 框画到护照外、
  //           Global Blue 单上六个框沿左边缘等距竖排 —— 那是在铺,不是在定位)。
  //   免税店 / 护照 → 给。实拍:单张票 receiptNo/日期/姓名精确落在值所在行;
  //          混合图(票+护照)护照三个字段准、小票 receiptNo 准。
  // 画错位置比不画更坏 —— 操作员照着错地方找,找不到就再不信这个功能。
  const deptFamily = base.docTypeFinal === DOC_TYPES.RECEIPT
    && getStoreProfile(base.receiptStoreAuto).family === FAMILY.DEPT;
  const fieldMeta = deptFamily ? null : buildFieldModelMeta({
    fieldBoxes: doc.fieldBoxes,
    fields: doc.fields || {},
    cropBox: Array.isArray(doc.bbox) && doc.bbox.length === 4 ? doc.bbox : null,
    docType,
  });
  if (fieldMeta) {
    if (docType === DOC_TYPES.PASSPORT) base.passportFieldModelMeta = fieldMeta;
    else if (docType === DOC_TYPES.RECEIPT) base.receiptFieldModelMeta = fieldMeta;
  }

  // 垃圾值过滤(#5):编造值置空+标红,绝不带绿混过审(缓存回放路径由 sanitizeReceiptJunk 在
  // ensureQwenSidecar 读取处兜同一逻辑)。
  return sanitizeReceiptJunk(base);
}

// 编造值过滤(2026-07-06 #5,实锤病例 task_0162:清晰图 conf0.95 却输出
// 小票号 0000-0000-0000-0000/团号 12345/日期 2023——12345 恰好 5 位骗过新罗长度规则拿绿灯):
//   - 小票号/团号 全同数字或从头顺子 → 置空 + qwen_junk_* 转人工(置空后必填闸自然卡住,操作员照票面填)
//   - 日期年份偏离当年 >1 年 → 保留值 + qwen_suspect_date_year 提醒核对(可能是模型把 2026 看成 2023)
// 幂等:挂两处(适配器生成 / sidecar 缓存读取)重复跑无副作用。
function sanitizeReceiptJunk(analysis) {
  if (!analysis || analysis.docTypeFinal !== DOC_TYPES.RECEIPT) return analysis;
  const reasons = new Set(analysis.reviewReasons || []);
  const before = reasons.size;
  if (isJunkNumericValue(analysis.receiptNoAuto)) {
    analysis.receiptNoAuto = '';
    analysis.receiptNoRawAuto = '';
    reasons.add('qwen_junk_receipt_no');
  }
  if (isJunkNumericValue(analysis.groupNoAuto)) {
    analysis.groupNoAuto = '';
    reasons.add('qwen_junk_group_no');
  }
  const nowYear = new Date().getFullYear();
  for (const key of ['purchaseDateAuto', 'departureDateAuto']) {
    const m = /^(\d{4})-/.exec(String(analysis[key] || ''));
    if (m && Math.abs(Number(m[1]) - nowYear) > 1) reasons.add('qwen_suspect_date_year');
  }
  // 购买/出境年份互斥自检(2026-07-20 错误矩阵 P3):免税店购买与出境相隔几天,
  // 年份只能相同或跨年(购买 12 月→出境次年 1 月);其余组合必有一处年份误读
  // (病例:出境 2025 购买 2026 之类的单侧漂移,±1 年宽容带里 qwen_suspect_date_year 抓不住)。
  const pm = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(analysis.purchaseDateAuto || ''));
  const dm = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(analysis.departureDateAuto || ''));
  if (pm && dm) {
    const py = Number(pm[1]); const dy = Number(dm[1]);
    const crossNewYear = dy === py + 1 && pm[2] === '12' && dm[2] === '01';
    if (dy !== py && !crossNewYear) reasons.add('qwen_date_year_conflict');
  }
  if (reasons.size !== before) {
    analysis.reviewReasons = [...reasons];
    analysis.needsReview = true;
  }
  return analysis;
}

// 百货补救裁片:从 pass-1 的小票 bbox 裁出品牌小票放大图(远景照里 거래번호/条码
// 小字在整图压缩下不可读,三轮重放实证模型会转而编造)。裁片只进第二段调用,
// 不落盘——百货"整图不切"的存储口径不变。失败返回 null,第二段退化为单图。
async function cropReceiptForRescue(imagePath, documents, maxEdge, quality, logger = null) {
  try {
    const receipts = (documents || []).filter((d) => d?.type === 'receipt' && Array.isArray(d.bbox));
    if (!receipts.length) return null;
    const area = (d) => Math.max(0, d.bbox[2] - d.bbox[0]) * Math.max(0, d.bbox[3] - d.bbox[1]);
    // 选"品牌小票"本体:GB 退税单裁了没用(字段在专柜小票上),有别的就跳过 GB
    const nonGb = receipts.filter((d) => !/GLOBAL\s*BLUE|글로벌/i.test(String(d.fields?.storeFamily || '')));
    const pool = nonGb.length ? nonGb : receipts;
    const target = pool.sort((a, b) => area(b) - area(a))[0];
    const meta = await sharp(imagePath).metadata();
    let W = Number(meta.width || 0);
    let H = Number(meta.height || 0);
    if (Number(meta.orientation) >= 5) [W, H] = [H, W]; // rotate() 后宽高互换,与拆图服务同口径
    if (!W || !H) return null;
    const pad = 0.03;
    // 先定整数 left/top,再用同一基准反推宽高并钳进图界——两次独立取整在 bbox 顶边时
    // 会凑出 left+width 超界 1px,sharp extract 抛错被吞(复审 MEDIUM)
    const left = Math.max(0, Math.round(Math.max(0, target.bbox[0] - pad) * W));
    const top = Math.max(0, Math.round(Math.max(0, target.bbox[1] - pad) * H));
    const width = Math.min(W - left, Math.round(Math.min(1, target.bbox[2] + pad) * W) - left);
    const height = Math.min(H - top, Math.round(Math.min(1, target.bbox[3] + pad) * H) - top);
    if (width < 32 || height < 32) return null; // bbox 退化就别裁了
    const buf = await sharp(imagePath).rotate()
      .extract({ left, top, width, height })
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (err) {
    if (logger?.warn) logger.warn('[qwen_ocr] dept_rescue 裁片失败(退化单图): %s', err?.message || err);
    return null;
  }
}

// P2 票号区裁片(2026-07-20 错误矩阵):锚点未过的乐天票,裁小票 bbox 上部(票号
// 恒在上部信息区:大字票号行在 SaleDT 上方)放大重读。裁片只进二遍调用不落盘;
// 失败返回 null,二遍直接放弃(保一遍值+锚点红标,不阻断)。
async function cropReceiptNoRegion(imagePath, docBbox, maxEdge, quality, logger = null) {
  try {
    const b = Array.isArray(docBbox) && docBbox.length === 4 ? docBbox : [0, 0, 1, 1];
    const meta = await sharp(imagePath).metadata();
    let W = Number(meta.width || 0);
    let H = Number(meta.height || 0);
    if (Number(meta.orientation) >= 5) [W, H] = [H, W]; // rotate() 后宽高互换,与拆图服务同口径
    if (!W || !H) return null;
    const padX = 0.04;
    const x1 = Math.max(0, b[0] - padX);
    const x2 = Math.min(1, b[2] + padX);
    // 纵向取小票上部 45%(含少量上沿留白):五店票号/日期标签行都在这一段
    const y1 = Math.max(0, b[1] - 0.02);
    const y2 = Math.min(1, b[1] + Math.max(0.12, (b[3] - b[1]) * 0.45));
    const left = Math.max(0, Math.round(x1 * W));
    const top = Math.max(0, Math.round(y1 * H));
    const width = Math.min(W - left, Math.round(x2 * W) - left);
    const height = Math.min(H - top, Math.round(y2 * H) - top);
    if (width < 32 || height < 32) return null;
    const buf = await sharp(imagePath).rotate()
      .extract({ left, top, width, height })
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (err) {
    if (logger?.warn) logger.warn('[qwen_ocr] receipt_no 裁片失败(放弃二遍): %s', err?.message || err);
    return null;
  }
}

// 长边压缩 → base64 data URL(控制图 token)。sharp 失败(格式异常等)→ 回退原图字节,不丢这张图。
// sharpen(0727反馈#8 调研落地):环境闸 QWEN_SHARPEN=1 打开 sharp 默认锐化(缩放后、压缩前)。
// ⚠️默认关:锐化改变全量识别输入(可能救低对比小字,也可能放大 JPEG 噪点),
// 打开前必须跑金标重放(2000金标/90核验同套)对比命中率,别裸开上生产。
// sidecar 复用戳带 ocrSharpen:开关翻转后旧缓存自动作废重识别(model/maxEdge 戳同款铁律)。
async function imageToBase64(imagePath, maxEdge, quality, sharpenOn = false) {
  try {
    let pipe = sharp(imagePath).rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    if (sharpenOn) pipe = pipe.sharpen();
    const buf = await pipe.jpeg({ quality }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
  }
}

function createQwenOcrBackend({
  apiKey = process.env.DASHSCOPE_API_KEY,
  baseUrl = process.env.QWEN_BASE_URL,
  model = process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
  fallbackModel = process.env.QWEN_FALLBACK_MODEL || '',
  maxEdge = Number(process.env.QWEN_MAX_EDGE) || 1280,
  quality = 82,
  // 0727#8:锐化预处理环境闸,默认关(开前必须金标重放验证,见 imageToBase64 注释)
  sharpen = String(process.env.QWEN_SHARPEN || '') === '1',
  confidenceThreshold = Number(process.env.QWEN_CONF_THRESHOLD) || 0.6,
  fetchImpl = globalThis.fetch,
  logger = null,
} = {}) {
  if (!apiKey || !baseUrl) {
    throw new Error('createQwenOcrBackend: 缺少 DASHSCOPE_API_KEY / QWEN_BASE_URL');
  }
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0, errors: 0, fallbacks: 0 };
  const cache = new Map(); // resolve(imagePath) → analyses[]

  // 模型回退(2026-07-21 部署审计):主模型 403/404/不可用 → 换 QWEN_FALLBACK_MODEL 重试一次,
  // 防 qwen3-vl-plus 权限/配额出问题时全链路 OCR 静默瘫痪。内容审核/限流等其它错不回退(那是图/速率问题)。
  async function callWithFallback(args) {
    try {
      // L487:回传实际所用 model(callQwen 只返 documents/usage/raw,不含 model),供打 ocrModel 戳
      // 诚实反映——回退结果戳成 fallbackModel,主模型恢复后 isSidecarReusable 判不可复用→重识别。
      const r = await callQwen({ ...args, model });
      return { ...r, usedModel: model };
    } catch (err) {
      if (fallbackModel && err && err.modelUnavailable) {
        if (logger?.warn) logger.warn('[qwen_ocr] 主模型 %s 不可用(%s),回退 %s', model, err.status, fallbackModel);
        usage.fallbacks += 1;
        const r = await callQwen({ ...args, model: fallbackModel });
        return { ...r, usedModel: fallbackModel };
      }
      throw err;
    }
  }

  // 一张图 → analysis[](每个文档一条,同 base 结构)
  async function extractAnalyses(imagePath, { sourceKey = '', useCache = true } = {}) {
    const key = path.resolve(imagePath);
    if (useCache && cache.has(key)) return cache.get(key);

    const imageBase64Url = await imageToBase64(imagePath, maxEdge, quality, sharpen);
    const result = await withRetry(() => callWithFallback({ imageBase64Url, apiKey, baseUrl, fetchImpl }));
    usage.promptTokens += result.usage.prompt_tokens || 0;
    usage.completionTokens += result.usage.completion_tokens || 0;
    usage.calls += 1;

    // ⭐百货两段式补救(金标重放实证:一段式判定 5/14、交易编号 0/5):
    // 一段输出出现确定性百货信号 → 用聚焦 prompt 追加一次调用重问;确认百货则
    // 整组文档替换(护照保留、GB单/品牌碎片并成 1 个百货小票)。第二段自答
    // "不是百货"或调用失败 → 一段结果原样保留,只多花一次调用,不伤免税店链路。
    let documents = result.documents;
    const rescueSignals = detectDeptRescueSignals(documents);
    let deptRescueMeta = null;
    if (rescueSignals.hit) {
      // 多票坍缩预警(复审 MEDIUM):补救会把所有小票并成 1 档("一票一档"业务规则)。
      // 一段碎片(GB单/同票重复框)是常态不预警;但 ≥2 个"各自带不同票号"的非GB小票
      // 更像两笔真交易 → 采纳补救时标 dept_multi_receipt_suspect 让审核员核实是否漏收。
      const distinctReceiptNos = new Set(
        documents
          .filter((d) => d?.type === 'receipt' && !/GLOBAL\s*BLUE|글로벌/i.test(String(d.fields?.storeFamily || '')))
          .map((d) => String(d.fields?.receiptNo || '').replace(/\D/g, ''))
          .filter((s) => s.length >= 6)
      );
      try {
        // 第二段 = 全景 + 品牌小票放大裁片(远景照小字不可读,三轮重放实证:整图再高清
        // 模型也读不稳条码/거래번호 → 裁片放大后以裁片为准)。只对信号命中的少数图多花 token。
        const rescueMaxEdge = Number(process.env.QWEN_DEPT_RESCUE_MAX_EDGE) || 2048;
        const rescueImages = [imageBase64Url];
        const crop = await cropReceiptForRescue(imagePath, documents, rescueMaxEdge, 90, logger);
        if (crop) rescueImages.push(crop);
        const second = await withRetry(() => callQwen({
          imageBase64Urls: rescueImages, apiKey, baseUrl, model, fetchImpl, systemPrompt: buildDeptRescuePrompt(),
        }));
        usage.promptTokens += second.usage.prompt_tokens || 0;
        usage.completionTokens += second.usage.completion_tokens || 0;
        usage.calls += 1;
        const rescue = parseDeptRescue(parseJsonLoose(second.raw));
        deptRescueMeta = {
          signals: rescueSignals.signals,
          promptVersion: DEPT_RESCUE_PROMPT_VERSION,
          accepted: rescue.isDept,
          confidence: rescue.confidence,
          crop: Boolean(crop),
          multiSuspect: Boolean(rescue.isDept && distinctReceiptNos.size >= 2),
        };
        if (rescue.isDept) documents = applyDeptRescue(documents, rescue);
      } catch (err) {
        usage.errors += 1;
        deptRescueMeta = { signals: rescueSignals.signals, promptVersion: DEPT_RESCUE_PROMPT_VERSION, error: String(err?.message || err).slice(0, 200) };
        if (logger?.warn) logger.warn('[qwen_ocr] dept_rescue %s 失败(保留一段结果): %s', path.basename(imagePath), err?.message || err);
      }
    }

    const resolvedPassport = pickPassportNo(collectPassportCandidates(documents));
    const analyses = documents.map((doc) => buildAnalysisForDoc(doc, {
      sourcePath: imagePath, sourceKey, confidenceThreshold, resolvedPassport,
      // 模型/分辨率/锐化戳 → sidecar,切换后旧缓存作废(部署审计)。L487:用实际所用模型(回退时=
      // fallbackModel),否则回退结果被戳成主模型→主模型恢复后仍判可复用→降级结果永不重识别。
      model: result.usedModel || model, maxEdge, sharpen,
      docCount: documents.length, // 字段框只在单文档图上采纳,见 buildAnalysisForDoc
    }));
    // 补救痕迹进 modelMeta:审核台/排查凭 deptRescue 字段还原"这张走过第二段"。
    // 失败态必须进 reviewReasons(复审 HIGH):isSidecarReusable 只认 reviewReasons/
    // 版本戳,光躺在 modelMeta 里的 error 会让"补救失败的一段结果"被永久缓存钉死。
    if (deptRescueMeta) {
      for (const a of analyses) {
        if (a.docTypeFinal !== DOC_TYPES.RECEIPT) continue;
        a.modelMeta.deptRescue = deptRescueMeta;
        const stamps = [];
        if (deptRescueMeta.error) stamps.push('dept_rescue_failed');
        if (deptRescueMeta.multiSuspect) stamps.push('dept_multi_receipt_suspect');
        if (stamps.length) {
          a.reviewReasons = [...new Set([...(a.reviewReasons || []), ...stamps])];
          a.needsReview = true;
        }
      }
    }

    // ⭐P2 票号放大二遍(2026-07-20 错误矩阵;二批扩五店+全量双读模式):
    //   anchor 模式:锚点未过/漏识别才二遍;二遍过全部锚点且与一遍不同 → 换值+fixed 旗;
    //   always 模式:启用店每张都双读——一遍锚点全过时二遍只做互证:两遍一致=互证通过
    //   (agreed 留痕),不一致=保一遍值+mismatch 红标(两个"都合法"的读数分不出谁对,
    //   人工照票面定);一遍锚点未过时与 anchor 模式同策。失败是保险不是闸门,绝不阻断。
    const repairCfg = resolveRepairConfig();
    // 整张图里的小票张数:条码是解整张图的,同图多票时孤条码无法归属到具体某张
    // (深度审计 HIGH 跨票污染:只解出#1的条码却被采纳给#2,把对的读数覆盖错)。
    const receiptCount = analyses.filter((x) => x.docTypeFinal === DOC_TYPES.RECEIPT).length;
    for (const a of analyses) {
      if (a.docTypeFinal !== DOC_TYPES.RECEIPT) continue;
      if (!repairCfg.stores.has(a.receiptStoreAuto)) continue;
      const anchorFails = (a.reviewReasons || []).filter(isAnchorReason);
      const weak = anchorFails.length > 0 || !a.receiptNoAuto; // 锚点未过或漏识别
      const wantSecond = weak || repairCfg.alwaysStores.has(a.receiptStoreAuto);
      try {
        // ⭐条码本地解码(三批"不翻倍"层,零 API,启用店每张白检):解出且过店锚点规格
        // → 与一遍一致=免费互证;不一致=采条码值+红标(条码是印刷载荷,但仍留人工过目;
        // 结构完美却读错的串尾混淆唯一的零成本解就在这)。命中即跳过 API 二遍。
        {
          const hits = await decodeReceiptNoBarcodes(imagePath);
          const pick = pickBarcodeReceiptNo({
            hits, storeFamily: a.receiptStoreAuto,
            firstPass: a.receiptNoAuto, purchaseDate: a.purchaseDateAuto,
            receiptCount, // 同图多票时孤条码不归属本票 → 不采,防跨票污染
          });
          if (pick) {
            a.modelMeta.receiptNoBarcode = { fmt: pick.fmt, value: pick.value, agreed: pick.agreesWithFirstPass };
            if (!pick.agreesWithFirstPass) {
              Object.assign(a, normalizeOcrFieldsForDocType(a.docTypeFinal, { receiptNoAuto: pick.value }));
              const kept = (a.reviewReasons || []).filter((r) => !isAnchorReason(r));
              a.reviewReasons = [...new Set([...kept, 'receipt_no_barcode_adopted'])];
              a.needsReview = true;
            }
            continue; // 条码已定夺,不花 API 二遍
          }
        }
        if (!wantSecond) continue; // 强值且非双读店:条码白检完就收工
        const repairMaxEdge = Number(process.env.QWEN_RECEIPT_NO_REPAIR_MAX_EDGE) || 1600;
        const crop = await cropReceiptNoRegion(imagePath, a.modelMeta?.bbox, repairMaxEdge, 90, logger);
        if (!crop) continue;
        // 二遍模型可独立指定(QWEN_REPAIR_MODEL):重读是"读一行放大数字"的窄任务,
        // 用便宜档(qwen-vl-ocr/plus)不占主模型 TPM;缺省跟主模型
        const repairModel = String(process.env.QWEN_REPAIR_MODEL || '').trim() || model;
        const second = await withRetry(() => callQwen({
          imageBase64Url: crop, apiKey, baseUrl, model: repairModel, fetchImpl,
          systemPrompt: buildReceiptNoRepairPrompt(a.receiptStoreAuto),
        }));
        usage.promptTokens += second.usage.prompt_tokens || 0;
        usage.completionTokens += second.usage.completion_tokens || 0;
        usage.calls += 1;
        const reread = String(parseJsonLoose(second.raw)?.receiptNo ?? '').trim();
        const decision = decideReceiptNoRepair({
          storeFamily: a.receiptStoreAuto,
          firstPass: a.receiptNoAuto,
          secondPass: reread,
          purchaseDate: a.purchaseDateAuto,
        });
        const agreed = Boolean(decision.agreed);
        // 一遍强值(锚点全过)绝不被二遍翻案——双读只互证不夺权;弱值才允许换值
        const adopt = weak && Boolean(decision.adopt);
        a.modelMeta.receiptNoRepair = {
          promptVersion: RECEIPT_NO_REPAIR_PROMPT_VERSION, mode: repairCfg.mode,
          from: a.receiptNoAuto, reread, adopted: adopt, agreed,
        };
        if (adopt) {
          // 与主路径同一中央归一(保字母保横线,raw=归一前原串)
          Object.assign(a, normalizeOcrFieldsForDocType(a.docTypeFinal, { receiptNoAuto: decision.value }));
          const kept = (a.reviewReasons || []).filter((r) => !isAnchorReason(r));
          a.reviewReasons = [...new Set([...kept, 'receipt_no_second_pass_fixed'])];
          a.needsReview = true;
        } else if (!weak && !agreed && reread) {
          // 双读互证失败(两遍都像样却不同,串尾个位混淆的形态)→ 保一遍值,红标转人工
          a.reviewReasons = [...new Set([...(a.reviewReasons || []), 'receipt_no_second_pass_mismatch'])];
          a.needsReview = true;
        }
      } catch (err) {
        usage.errors += 1;
        if (logger?.warn) logger.warn('[qwen_ocr] receipt_no 二遍 %s 失败(保一遍值): %s', path.basename(imagePath), err?.message || err);
      }
    }

    if (logger?.debug) logger.debug('[qwen_ocr] %s → %d docs', path.basename(imagePath), analyses.length);
    if (useCache) cache.set(key, analyses);
    return analyses;
  }

  return {
    extractAnalyses,
    getUsage: () => ({ ...usage, model }),
    clearCache: () => cache.clear(),
  };
}

module.exports = {
  createQwenOcrBackend, buildAnalysisForDoc, runFieldValidation, sanitizeReceiptJunk,
  cropReceiptNoRegion, imageToBase64,
};
