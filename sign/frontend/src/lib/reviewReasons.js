/**
 * Review reason 编码 → 中文 label。
 *
 * 编码来自后端两个地方：
 *   - lib/validation/field_rules.js   (rule-set v2 字段校验)
 *   - 各匹配/分类 service 旧的字符串
 *
 * 这里集中维护，前端只看 label，新增校验时同步加一条即可。
 */

const REVIEW_REASON_LABELS = {
  // 字段规则 (lib/validation/field_rules.js REASONS)
  field_chinese_name_invalid: '中文姓名格式异常（应为 2-10 位汉字）',
  field_english_name_invalid: '英文姓名格式异常（应为 2-50 位字母）',
  field_passport_no_invalid: '护照号格式异常（应为 6-12 位字母或数字）',
  field_store_family_invalid: '免税店未在识别范围内（请从下拉里选)',
  field_receipt_no_invalid: '小票号位数与免税店不匹配（LOTTE 14 / 新罗系 13;其余店暂不校验长度）',
  // 位数不写死(2026-08-01):后端给新世界加了 5 位规则之后,「新罗系 5」这句就已经不全了。
  // 具体位数在审核台的输入框提示里按表生成,这里只说是哪一类问题。
  field_tour_no_invalid: '团号位数与免税店不匹配(具体位数看团号框下的提示;表里没有的店不校验长度)',
  field_purchase_date_invalid: '购买日期格式异常（应为 YYYY-MM-DD）',
  field_departure_date_invalid: '出境日期格式异常（应为 YYYY-MM-DD）',
  field_date_range_invalid: '购买日期晚于出境日期',

  // 旧的匹配/分类原因
  passport_field_model_passport_no_conflict: '护照号识别冲突',
  passport_field_model_extracted_name_conflict: '英文姓名识别冲突',
  passport_field_model_chinese_name_conflict: '中文姓名识别冲突',
  receipt_field_model_receipt_no_conflict: '小票号定位与正则不一致',
  receipt_field_model_group_no_conflict: '团号定位与正则不一致',
  receipt_field_model_purchase_date_conflict: '购买日期定位与正则不一致',
  receipt_field_model_departure_date_conflict: '出境日期定位与正则不一致',
  receipt_field_model_receipt_store_conflict: '免税店判断与正则不一致',

  // 阶段错误
  agent_mismatch: '代理与团号表不一致',
  mode_unresolved: '模式未归类（历史记录；新流程在账单管理里勾选归桶/不参与）',
  ambiguous_match: '匹配候选多于一条',
  fuzzy_match: '模糊匹配，置信度低',
  field_conflict: '字段冲突需人工确认',
  second_pass_candidate: '二次扫漏发现可能的小票',

  // 千问 OCR 后端(lib/qwen_ocr)
  qwen_low_confidence: 'AI 识别置信度低，请核对',
  qwen_confidence_unknown: 'AI 未给出置信度，请核对',
  qwen_crop_fallback: '切图异常已回退原图，请核对该单据',
  qwen_no_document: '未识别出单据，请人工判断',
  // 同图多单据/切图不足(L142 + splitImage 兜底):这张照片里疑似还有别的单据没被切出来，
  // 请走「同图补小票」补齐或「按此店重切」——避免同框第二张单据漏收。
  multi_doc_uncut: '照片里疑似有多张单据(护照/小票同框或多票并排)，只识别出其中一张，请用「同图补小票」补齐漏收的',
  suspect_uncut_wide: '照片偏横宽，疑似两张单据左右并排却没被切开，请核对是否漏收第二张',
  qwen_other_region: '照片里还有未识别的单据区域，请核对是否漏收',
  qwen_failed: 'AI 识别失败，请重拍或人工录入',
  qwen_content_rejected: '图片被识别平台判为敏感内容(常见于护照人脸/证件)已跳过，请人工录入',
  passport_no_unverified: '护照号未经机读区校验，请核对',
  // 编造值过滤(2026-07-06 #5):模型对个别图现编"像样"假值(全0小票号/12345团号/年份漂移)
  qwen_junk_receipt_no: 'AI 疑似编造小票号(全0/顺子)已清空，请照票面填写',
  qwen_junk_group_no: 'AI 疑似编造团号(如12345)已清空，请照票面填写',
  qwen_suspect_date_year: '日期年份偏离当年，请对照票面核对',
  // 票号结构锚点(2026-07-20 识别错误矩阵 P1/P2):定长/嵌入日期自检未过只标红不改值
  qwen_receipt_no_shape_suspect: '票号与该店固定形态不符(新世界/现代16位、乐天14位且9开头)，请照票面核对',
  qwen_receipt_no_date_anchor_suspect: '票号内嵌日期段与购买日期对不上(两者必有一处误读)，请核对票号和购买日期',
  receipt_no_second_pass_fixed: '票号两遍识别不一致(已取放大重读值)，请对照票面确认',
  receipt_no_second_pass_mismatch: '票号两遍识别不一致且都符合形态(疑个位混淆)，请对照票面逐位核对',
  receipt_no_barcode_adopted: '票号已按票面条形码解码值纠正(与AI读数不一致)，请对照票面确认',
  qwen_date_year_conflict: '购买与出境日期年份对不上(相隔应在同年或跨年元旦)，疑有一处年份误读，请核对',
  // 百货两段式(2026-07-12):거래번호 标签直读与底部条码推导不一致 → 已取条码值,请对票面核对
  dept_receipt_no_cross_mismatch: '交易编号两处识别不一致(已取条码推导值)，请对照票面核对',
  dept_amount_cross_mismatch: '金额两处识别不一致(已取条码推导值)，请对照票面核对',
  // 诚实闸:AI 读出的值不符合票面形态(4位-4位)/无条码可交叉 → 宁可空红转人工,不带绿混对账
  dept_receipt_no_unverified: 'AI 读的交易编号不像票面形态(4位-4位)已清空，请照票面填写',
  dept_receipt_no_single_source: '交易编号仅单一来源识别(条码/标签未互证)，请对照票面核对',
  dept_amount_unverified: '金额无条码可交叉验证，请对照票面 합계 核对',
  dept_rescue_failed: '百货补救识别调用失败(已按初判兜底)，请核对或重识别',
  dept_multi_receipt_suspect: '照片里疑似有多张不同交易的百货小票(已并成一档)，请核实是否漏收',
  dept_upstream_confirm: '上家已默认"东方"——照片里贴了金浦奥莱积分卡就改成金浦奥莱',
};

// reason → 审核台字段(*Final)键:供 FieldEditor 高亮"要核对的字段"
const REVIEW_REASON_FIELD = {
  field_chinese_name_invalid: 'chineseNameFinal',
  passport_field_model_chinese_name_conflict: 'chineseNameFinal',
  field_english_name_invalid: 'extractedNameFinal',
  passport_field_model_extracted_name_conflict: 'extractedNameFinal',
  field_passport_no_invalid: 'passportNoFinal',
  passport_field_model_passport_no_conflict: 'passportNoFinal',
  passport_no_unverified: 'passportNoFinal',
  field_store_family_invalid: 'receiptStoreFinal',
  receipt_field_model_receipt_store_conflict: 'receiptStoreFinal',
  field_receipt_no_invalid: 'receiptNoFinal',
  receipt_field_model_receipt_no_conflict: 'receiptNoFinal',
  qwen_junk_receipt_no: 'receiptNoFinal',
  qwen_receipt_no_shape_suspect: 'receiptNoFinal',
  qwen_receipt_no_date_anchor_suspect: 'receiptNoFinal',
  receipt_no_second_pass_fixed: 'receiptNoFinal',
  receipt_no_second_pass_mismatch: 'receiptNoFinal',
  receipt_no_barcode_adopted: 'receiptNoFinal',
  qwen_date_year_conflict: 'purchaseDateFinal',
  dept_receipt_no_cross_mismatch: 'receiptNoFinal',
  dept_amount_cross_mismatch: 'receiptAmountFinal',
  dept_receipt_no_unverified: 'receiptNoFinal',
  dept_receipt_no_single_source: 'receiptNoFinal',
  dept_amount_unverified: 'receiptAmountFinal',
  dept_upstream_confirm: 'upstreamFinal',
  field_tour_no_invalid: 'groupNoFinal',
  receipt_field_model_group_no_conflict: 'groupNoFinal',
  qwen_junk_group_no: 'groupNoFinal',
  qwen_suspect_date_year: 'purchaseDateFinal',
  field_purchase_date_invalid: 'purchaseDateFinal',
  receipt_field_model_purchase_date_conflict: 'purchaseDateFinal',
  field_departure_date_invalid: 'departureDateFinal',
  receipt_field_model_departure_date_conflict: 'departureDateFinal',
  field_date_range_invalid: 'departureDateFinal',
};

// 严重 reason(图/识别根本性问题)→ 低档 → 建议重拍;其余 needsReview → 中档(字段级,可编辑修)
const SEVERE_REVIEW_REASONS = new Set([
  'qwen_no_document', 'qwen_failed', 'qwen_content_rejected', 'qwen_crop_fallback', 'qwen_confidence_unknown', 'ocr_failed',
]);

export function reviewReasonFieldKey(code) {
  return REVIEW_REASON_FIELD[String(code || '').trim()] || '';
}

export function hasSevereReviewReason(reasons) {
  return Array.isArray(reasons) && reasons.some((r) => SEVERE_REVIEW_REASONS.has(String(r || '').trim()));
}

/** 把单个原因编码翻译成中文，找不到时回退到原编码（方便排查未覆盖项）。 */
export function reviewReasonLabel(code) {
  if (code == null) return '';
  const key = String(code).trim();
  if (!key) return '';
  return REVIEW_REASON_LABELS[key] || key;
}

/**
 * 把 reviewReasons 数组渲染成中文短句串，去重去空。
 *
 * @param {string[] | undefined} reasons
 * @param {string} [separator='｜']
 */
export function reviewReasonsText(reasons, separator = '｜') {
  if (!Array.isArray(reasons) || reasons.length === 0) return '';
  const seen = new Set();
  const out = [];
  for (const code of reasons) {
    const label = reviewReasonLabel(code);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.join(separator);
}

export { REVIEW_REASON_LABELS };
