const { DOC_TYPES } = require('./package_constants');
const { laneOfMode, parseSlimModes } = require('./review_lane');
const {
  PROCESS_RESULTS,
  buildDeptReceiptFieldRuleSet,
  getDocTypeFieldRuleSet,
} = require('./workbench_definition');
// 店家/小票号校验统一走 field_rules(唯一真相源):店家白名单含新店(SHINSEGAE/HYUNDAI),
// 小票号受 RECEIPT_NO_STRICT 解禁开关控制。此文件旧的本地 3 店副本曾把结算卡死(Internal error)。
const {
  validateStoreFamily: validateStoreFamilyRule,
  validateReceiptNo: validateReceiptNoRule,
  TOUR_NO_LENGTH_BY_STORE,
} = require('./validation/field_rules');
// 百货档案(P2):百货小票必填集不同(无团号/无出境日期,多金额/门店/品牌/上家)。
const { getStoreProfile, FAMILY } = require('./store_profiles');
const { hasNoTourStance } = require('./no_tour');

const EDITABLE_FIELD_KEYS = Object.freeze([
  'extractedNameAuto',
  'extractedNameFinal',
  'chineseNameAuto',
  'chineseNameFinal',
  'passportNoAuto',
  'passportNoFinal',
  'receiptStoreAuto',
  'receiptStoreFinal',
  'receiptNoAuto',
  'receiptNoFinal',
  // raw 留底随票号同生同灭:改类型不清会往返残留(契约测试②抓的洞,2026-07-13)
  'receiptNoRawAuto',
  'groupNoAuto',
  'groupNoFinal',
  'purchaseDateAuto',
  'purchaseDateFinal',
  'departureDateAuto',
  'departureDateFinal',
  'receiptAmountAuto',
  'receiptDateAuto',
  'flightNoAuto',
  // 百货真字段(P2):改文档类型时同免税店字段一起清空,防残留串进新类型
  'receiptAmountFinal',
  'branchAuto',
  'branchFinal',
  'brandAuto',
  'brandFinal',
  'upstreamAuto',
  'upstreamFinal',
]);

// 店家白名单/小票号/团号长度全部以 field_rules 为唯一真相源——
// 本地长度表副本(RECEIPT_STORE_RULES)已删:field_rules 加了 SHINSEGAE:5 这里没跟上,
// 又是一次"改规则漏副本"(结算 Internal error 事故同款),2026-07-03 体检收口。
const AUTO_CONFIRM_DOC_TYPE_CONFIDENCE = 0.75;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeReceiptStore(value) {
  const normalized = normalizeText(value)
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (normalized === 'SHILLA I PARK') {
    return 'SHILLA IPARK';
  }
  if (normalized === 'LOTTE DUTY FREE') {
    return 'LOTTE';
  }
  if (normalized === 'THE SHILLA DUTY FREE') {
    return 'THE SHILLA';
  }
  if (normalized === 'SHILLA IPARK DUTY FREE') {
    return 'SHILLA IPARK';
  }
  return normalized;
}

function isStrictIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateFieldValue(field = {}, value = '', fieldValues = {}) {
  const text = normalizeText(value);
  const type = field.validation?.type || '';

  if (!text || !type) {
    return { valid: true, issue: '' };
  }

  if (type === 'chinese_name') {
    return /^[\u3400-\u9fff]{2,10}$/u.test(text)
      ? { valid: true, issue: '' }
      : { valid: false, issue: '仅限中文字符，2-10位' };
  }

  if (type === 'english_name') {
    return /^(?=.{2,50}$)[A-Za-z]+(?: [A-Za-z]+)*$/.test(text)
      ? { valid: true, issue: '' }
      : { valid: false, issue: '仅限英文字母，2-50位' };
  }

  if (type === 'passport_no') {
    // 国际通用:6-12 位字母或数字(兼容外国护照,如阿根廷 3 字母+6 数字)。
    return /^[A-Za-z0-9]{6,12}$/.test(text)
      ? { valid: true, issue: '' }
      : { valid: false, issue: '字母或数字,6-12位' };
  }

  if (type === 'receipt_store') {
    // 白名单以 field_rules 为准(5 店含新世界/现代),别再用本地 3 店旧副本——
    // 否则审核台放行的新店在结算闸被打回(操作员只看到 Internal error)。
    return validateStoreFamilyRule(text).ok
      ? { valid: true, issue: '' }
      : { valid: false, issue: '必须是审核台下拉里的免税店选项' };
  }

  if (type === 'receipt_no') {
    // 小票号解禁(RECEIPT_NO_STRICT=false):非空即通过,不限长度/字母/横线。
    // 收紧时只改 field_rules 一处,这里自动跟随;团号不受影响(走下面分支)。
    const storeRaw = fieldValues.receiptStoreFinal || fieldValues.receiptStoreAuto || '';
    const canonical = validateStoreFamilyRule(storeRaw).canonical || '';
    return validateReceiptNoRule(canonical, text).ok
      ? { valid: true, issue: '' }
      : { valid: false, issue: '小票号不能为空或不符合店家规则' };
  }

  if (type === 'group_no') {
    // 命中团号表(预匹配 matched)= 团号真实存在,格式检查直接通过——
    // 乐天R团/首尔V团等团号带英文字母,写死"纯数字"会把合法团号拦死。
    if (String(fieldValues.groupNoMatchStatus || '') === 'matched') {
      return { valid: true, issue: '' };
    }
    // 机场票团号栏合法值就是"无"(新世界机场),放行;结算按未命中走人工归桶。
    if (text === '无') {
      return { valid: true, issue: '' };
    }
    const store = normalizeReceiptStore(fieldValues.receiptStoreFinal || fieldValues.receiptStoreAuto || '');
    const groupNoLength = TOUR_NO_LENGTH_BY_STORE[store];
    // 放宽到字母数字(团号带字母的模式真实存在);长度规则只对"纯数字"生效。
    if (!/^[A-Za-z0-9]+$/.test(text)) {
      return { valid: false, issue: '团号只能是字母或数字' };
    }
    if (!/^\d+$/.test(text) || !groupNoLength) {
      return { valid: true, issue: '' };
    }
    return text.length === groupNoLength
      ? { valid: true, issue: '' }
      : { valid: false, issue: `${store} 需要 ${groupNoLength} 位纯数字` };
  }

  if (type === 'dept_amount') {
    // 百货金额:纯数字(存储口径=去掉千分位的总金额数字)。上家 Excel 借位在导出映射层。
    return /^\d+$/.test(text)
      ? { valid: true, issue: '' }
      : { valid: false, issue: '金额只填数字(不带逗号/货币符号)' };
  }

  // ── 百货校验 per 档案(P3):规则全从 store_profiles 档案读,这里零店名单 ──
  if (type === 'dept_receipt_no' || type === 'dept_branch' || type === 'dept_brand' || type === 'dept_upstream') {
    const storeRaw = fieldValues.receiptStoreFinal || fieldValues.receiptStoreAuto || '';
    const canonical = validateStoreFamilyRule(storeRaw).canonical || '';
    const profile = getStoreProfile(canonical);

    if (type === 'dept_receipt_no') {
      // 位数按"数字核"算(去杠后),杠位不强求——现代 2-6-3-5 补杠/去杠在导出层统一口径。
      // ⚠️ 这里原来写着「乐天百货 dash:false = 不打杠,出现 - 即红」—— 0731 核对时
      // 发现这句已经**不成立**:store_profiles.js:54 早就是 dash:true(0727#13-4 拍板,
      // 旧「8位不打-」作废)。代码本身没错(它读档案),错的是这行注释。
      // 留这一笔是因为**前端曾照着这句话硬写了一遍规则**,导致乐天百货带杠票确认点不动;
      // 注释腐了不报错,但会有人照着它写第二份实现。
      const rule = profile.rules?.receiptNo || {};
      const digitsOnly = text.replace(/-/g, '');
      if (!/^\d+$/.test(digitsOnly)) {
        return { valid: false, issue: '票号只能是数字(可带-)' };
      }
      if (rule.dash === false && text.includes('-')) {
        return { valid: false, issue: `交易编号不打-,${rule.digits || 8}位纯数字` };
      }
      if (rule.digits && digitsOnly.length !== rule.digits) {
        return { valid: false, issue: `需要 ${rule.digits} 位数字(当前 ${digitsOnly.length} 位)` };
      }
      return { valid: true, issue: '' };
    }

    if (type === 'dept_branch') {
      // 2026-07-12 用户拍板:门店=票面4位编号原样(0001就是0001),不再换门店名。
      // 只查格式(4位纯数字),不锁档案清单——新门店码随时出现,票面是啥就是啥;
      // 档案 rules.branch 的码清单(数组)仅作识别提示参考。
      if (/^\d{4}$/.test(text)) return { valid: true, issue: '' };
      const codes = Array.isArray(profile.rules?.branch) ? profile.rules.branch : [];
      const hint = codes.slice(0, 2).join('/');
      return { valid: false, issue: `门店填票面4位编号${hint ? `(如 ${hint})` : ''},不填门店名` };
    }

    if (type === 'dept_brand') {
      const allowed = profile.rules?.brand || [];
      if (!allowed.length || allowed.includes(text)) return { valid: true, issue: '' };
      return { valid: false, issue: `品牌只记:${allowed.join('/')}(其余后缀忽略)` };
    }

    // dept_upstream:枚举=档案 rules.upstream(新世界固定梁总/现代 金浦奥莱|东方)
    const allowed = profile.rules?.upstream || [];
    if (!allowed.length || allowed.includes(text)) return { valid: true, issue: '' };
    return { valid: false, issue: `上家必须是:${allowed.join('/')}` };
  }

  if (type === 'purchase_date' || type === 'departure_date') {
    if (!isStrictIsoDate(text)) {
      return { valid: false, issue: '格式必须是 YYYY-MM-DD' };
    }
    const purchaseDate = normalizeText(fieldValues.purchaseDateFinal || fieldValues.purchaseDateAuto || '');
    const departureDate = normalizeText(fieldValues.departureDateFinal || fieldValues.departureDateAuto || '');
    if (isStrictIsoDate(purchaseDate) && isStrictIsoDate(departureDate)) {
      if (type === 'purchase_date' && purchaseDate > departureDate) {
        return { valid: false, issue: '购买日期不能晚于离境日期' };
      }
      if (type === 'departure_date' && departureDate < purchaseDate) {
        return { valid: false, issue: '离境日期不能早于购买日期' };
      }
    }
    return { valid: true, issue: '' };
  }

  return { valid: true, issue: '' };
}

function normalizeDocType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'ticket') {
    return DOC_TYPES.OTHER;
  }
  if (
    normalized === DOC_TYPES.PASSPORT ||
    normalized === DOC_TYPES.RECEIPT ||
    normalized === DOC_TYPES.OTHER
  ) {
    return normalized;
  }
  return DOC_TYPES.PASSPORT;
}

function hasKnownDocTypeValue(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'ticket' || [
    DOC_TYPES.PASSPORT,
    DOC_TYPES.RECEIPT,
    DOC_TYPES.OTHER,
  ].includes(normalized);
}

function hasAutoConfirmedDocType(task = {}) {
  const confidence = Number(task.docTypeConfidence || 0);
  return (
    normalizeText(task.machineState) === 'completed'
    && confidence > AUTO_CONFIRM_DOC_TYPE_CONFIDENCE
    && hasKnownDocTypeValue(task.docTypeFinal || task.docTypeAuto)
  );
}

function normalizeReviewReasons(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  return normalizeText(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createDocTypeFields(overrides = {}) {
  const docTypeAuto = normalizeDocType(overrides.docTypeAuto || DOC_TYPES.PASSPORT);
  const docTypeFinal = normalizeDocType(overrides.docTypeFinal || docTypeAuto);

  return {
    docTypeAuto,
    docTypeFinal,
    docTypeConfidence: Number.isFinite(Number(overrides.docTypeConfidence))
      ? Number(overrides.docTypeConfidence)
      : 0,
    needsReview: Boolean(overrides.needsReview),
    reviewReasons: normalizeReviewReasons(overrides.reviewReasons),
    sourceOriginalPath: normalizeText(overrides.sourceOriginalPath),
    sourceFolderName: normalizeText(overrides.sourceFolderName),
    sourceFileName: normalizeText(overrides.sourceFileName),
    sourceKey: normalizeText(overrides.sourceKey),
  };
}

// ── 审核配置挂钩(配置台P3a,与 mode_record_matrix.setModeRuleResolver 同手法)──
// server 启动时挂 review_config_resolver:命中返回配置口径,null/异常一律回落出厂。
// 未挂钩(单测/脚本)=出厂行为逐字节一致——审核必填是热路径+安全面,绝不因配置挂掉。
let runtimeReviewConfigResolver = null;
function setReviewConfigResolver(resolver) {
  runtimeReviewConfigResolver = resolver || null;
}
function reviewConfig() {
  return runtimeReviewConfigResolver;
}

// 百货必填集缓存(按 canonical 店名;档案是冻结常量,进程内组装一次即可)
const deptRuleSetCache = new Map();

// SLIM 车道空规则集(冻结常量):小票免逐字段必填。
const SLIM_RECEIPT_RULE_SET = Object.freeze({ fields: Object.freeze([]), needsSignature: false });

// SLIM 车道资格(分车道审核,2026-07-10;fail-safe 全审):三个条件叠加缺一不可——
//   ①模式在 ENV 灰度白名单(WORKBENCH_SLIM_MODES,默认空=车道不存在)
//   ②团号命中表(交叉验证)③组级人工确认过(任务级回执 tourConfirmedAt,撤销即失效)。
// 单纯"信 OCR"的放行不存在(金标实锤 50% 兜底,用户拍板准比快重要)。
function isSlimLaneTask(task = {}) {
  // 纵深防御(reviewer):显式限定小票——护照/其他永不进 slim,即便哪天有脚本误写了下面两个字段。
  if (normalizeDocType(task.docTypeFinal || task.docTypeAuto || '') !== DOC_TYPES.RECEIPT) return false;
  // 人工背书判据(2026-07-10 票级两步流):本票表态 matched;兼容旧组级确认站写的 tourConfirmedAt。
  if (String(task.tourStance || '') !== 'matched' && !task.tourConfirmedAt) return false;
  if (String(task.groupNoMatchStatus || '') !== 'matched') return false;
  if (laneOfMode(task.modeRawPre, { slimModes: parseSlimModes(process.env.WORKBENCH_SLIM_MODES) }) === 'slim') {
    return true; // ENV 白名单=紧急覆盖通道,优先级最高(P3 拍板保留)
  }
  // P3a SLIM 收编:模式微调 review.slim=true 同样入车道(三条件已在上方查完)
  try {
    return reviewConfig()?.getModeReviewOverlay?.(task.modeRawPre)?.slim === true;
  } catch {
    return false;
  }
}

function getRequiredFieldRules(docType, task = {}) {
  const normalizedDocType = normalizeDocType(docType || DOC_TYPES.PASSPORT);
  if (normalizedDocType === DOC_TYPES.RECEIPT) {
    // 店按 Final 优先(审核员改店后必填集即时切换),canonical 化后查档案
    const storeRaw = normalizeText(task.receiptStoreFinal) || normalizeText(task.receiptStoreAuto);
    const canonical = validateStoreFamilyRule(storeRaw).canonical || '';
    const profile = getStoreProfile(canonical);
    if (profile.family === FAMILY.DEPT) {
      // P3a:店家档案字段接配置(C类勾选=改档案)。配置命中=按配置清单现算
      // (走同一个 buildDeptReceiptFieldRuleSet,字段定义仍出厂单源,绝无第二套组装逻辑);
      // 未配置/坏配置=null → 出厂缓存路径,行为零变化。
      try {
        const configuredFields = reviewConfig()?.getDeptFields?.(canonical) || null;
        if (configuredFields) {
          return buildDeptReceiptFieldRuleSet({ ...profile, fields: configuredFields });
        }
      } catch { /* 配置层异常按未配置处理 */ }
      if (!deptRuleSetCache.has(canonical)) {
        deptRuleSetCache.set(canonical, buildDeptReceiptFieldRuleSet(profile));
      }
      return deptRuleSetCache.get(canonical);
    }
    // SLIM 车道(不用记类,灰度):小票免逐字段;护照不走此分支,锚字段照旧人审。
    if (isSlimLaneTask(task)) {
      return SLIM_RECEIPT_RULE_SET;
    }
    // P3a 模式微调(时序墙拍板:仅 matched 后叠加;未命中=纯基线全查):
    // relax=从基线移除;require=从出厂词汇补回。字段定义仍出厂单源。
    if (String(task.groupNoMatchStatus || '') === 'matched') {
      try {
        const overlay = reviewConfig()?.getModeReviewOverlay?.(task.modeRawPre) || null;
        if (overlay && (overlay.relax.length || overlay.require.length)) {
          const base = baseRuleSetFor(normalizedDocType);
          const relax = new Set(overlay.relax);
          const factoryByKey = new Map(
            getDocTypeFieldRuleSet(DOC_TYPES.RECEIPT).fields.map((field) => [field.finalKey, field])
          );
          const fields = base.fields.filter((field) => !relax.has(field.finalKey));
          for (const key of overlay.require) {
            if (!fields.some((field) => field.finalKey === key) && factoryByKey.has(key)) {
              fields.push(factoryByKey.get(key));
            }
          }
          return Object.freeze({ fields: Object.freeze(fields), needsSignature: false });
        }
      } catch { /* 配置层异常=按无微调 */ }
    }
  }
  return baseRuleSetFor(normalizedDocType);
}

// P3a 基线通道:配置命中用配置(字段定义仍出厂),null 回落出厂。
function baseRuleSetFor(docType) {
  try {
    const configured = reviewConfig()?.getBaseRuleSet?.(docType) || null;
    if (configured) return configured;
  } catch { /* 回落出厂 */ }
  return getDocTypeFieldRuleSet(docType);
}

function getTaskRequiredFieldChecks(task = {}) {
  const docTypeFinal = normalizeDocType(task.docTypeFinal || DOC_TYPES.PASSPORT);
  const rules = getRequiredFieldRules(docTypeFinal, task);
  const fieldValues = {};
  // 团号预匹配状态带进校验:命中团号表 = 团号格式正确的最强证明(直接跳过格式检查)。
  fieldValues.groupNoMatchStatus = String(task.groupNoMatchStatus || '');
  // 无团号表态豁免(2026-07-20 现场报障:机场票点「无团号·直接确认」后仍被"团号必填"卡死)——
  // tourStance='none' 是人工背书"票上没有团号",团号字段随之免填;写入层会自动回填「无」
  // (services/workbench_write/task.js),这里的豁免兜住回填前的存量空值行。判定单源 lib/no_tour。
  const noTourStance = hasNoTourStance(task);
  const baseChecks = rules.fields.map((field) => {
    const finalValue = normalizeText(task[field.finalKey]);
    const autoValue = normalizeText(task[field.autoKey]);
    const value = finalValue || autoValue;
    fieldValues[field.finalKey] = value;
    fieldValues[field.autoKey] = autoValue;
    const exemptNoTour = noTourStance && field.finalKey === 'groupNoFinal' && !value;
    return {
      ...field,
      value,
      source: finalValue ? 'final' : (autoValue ? 'auto' : 'missing'),
      complete: Boolean(value) || exemptNoTour,
    };
  });
  const checks = baseChecks.map((field) => {
    const validation = validateFieldValue(field, field.value, fieldValues);
    return {
      ...field,
      valid: validation.valid,
      issue: validation.issue,
    };
  });
  const missingFields = checks.filter((item) => !item.complete);
  const invalidFields = checks.filter((item) => item.complete && !item.valid);

  return {
    docTypeFinal,
    classificationConfirmed: Boolean(task.classificationConfirmed || hasAutoConfirmedDocType(task)),
    needsSignature: rules.needsSignature,
    hasFinalSignature: Boolean(normalizeText(task.finalSignaturePath)),
    checks,
    missingFields,
    invalidFields,
  };
}

function deriveTaskState(task = {}) {
  const summary = getTaskRequiredFieldChecks(task);

  if (task.rephotoRequested) {
    return {
      processResult: PROCESS_RESULTS.REPHOTO,
      actionSuggestion: '原图信息不足或结果不可靠，请重新采集后再处理。',
    };
  }

  if (!summary.classificationConfirmed) {
    return {
      processResult: PROCESS_RESULTS.CLASSIFY,
      actionSuggestion: '先确认文档分类是否正确；如果分类改了，旧字段会被清空后重新填写。',
    };
  }

  if (summary.missingFields.length > 0) {
    return {
      processResult: PROCESS_RESULTS.FIELDS,
      actionSuggestion: `还缺少：${summary.missingFields.map((item) => item.label).join('、')}。`,
    };
  }

  if (summary.invalidFields.length > 0) {
    return {
      processResult: PROCESS_RESULTS.FIELDS,
      actionSuggestion: `格式不对：${summary.invalidFields.map((item) => `${item.label}（${item.issue}）`).join('、')}`,
    };
  }

  if (summary.needsSignature && !summary.hasFinalSignature) {
    return {
      processResult: PROCESS_RESULTS.SIGNATURE,
      actionSuggestion: '护照字段已齐，请先生成网站签字或手写补签。',
    };
  }

  if (task.reviewed) {
    return {
      processResult: PROCESS_RESULTS.APPROVED,
      actionSuggestion: '这条记录已完成终审，可以进入后续流程。',
    };
  }

  return {
    processResult: PROCESS_RESULTS.FINAL_REVIEW,
    actionSuggestion: '字段与签字已就绪，确认无误后即可终审通过。',
  };
}

function clearEditableFieldsForDocTypeSwitch(task = {}, nextDocType) {
  const docTypeFinal = normalizeDocType(nextDocType || task.docTypeFinal || DOC_TYPES.PASSPORT);
  const clearedTask = {
    ...task,
    docTypeFinal,
    classificationConfirmed: true,
    needsReview: false,
    reviewReasons: [],
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    rephotoReason: '', // 重拍原因(0727反馈#10)随标记同生共死,类型切换不留幽灵原因
    // 票级两步流残留清场(2026-07-13 登机牌病例):改类型必须连表态一起清——
    // 否则 其他→小票 往返后旧 tourStance 回放,两步流被静默跳过(免表态直接全审);
    // 回执也会把误分类期间的表态计成"无团号小票"。S标记/人选模式同属小票语义,一并清。
    tourStance: '',
    tourStancedAt: '',
    tourStancedBy: '',
    // 组级确认站回执(2026-07-14 审计#8):isSlimLaneTask 把 tourConfirmedAt 当与 tourStance
    // 等价的免审凭据——只清 tourStance 不清它,组级批量确认过的票改类型往返后仍带旧盖章,
    // 可绕两步流被 SLIM 车道免审放行。兄弟字段必须同一次清场。
    tourConfirmedAt: '',
    sActivityFlag: false,
    modeManualPick: '',
    modeManualPickTour: '',
  };

  EDITABLE_FIELD_KEYS.forEach((key) => {
    clearedTask[key] = '';
  });

  return clearedTask;
}

function shouldQueuePassportOcr(task) {
  if (!task) {
    return false;
  }

  return (
    normalizeDocType(task.docTypeFinal || DOC_TYPES.PASSPORT) === DOC_TYPES.PASSPORT &&
    task.sourceType !== 'manual' &&
    Boolean(task.sourceImagePath) &&
    task.machineState !== 'completed'
  );
}

module.exports = {
  setReviewConfigResolver,
  PROCESS_RESULTS,
  clearEditableFieldsForDocTypeSwitch,
  createDocTypeFields,
  deriveTaskState,
  getTaskRequiredFieldChecks,
  isSlimLaneTask,
  normalizeDocType,
  normalizeReviewReasons,
  shouldQueuePassportOcr,
};
