'use strict';

const { normalizeStoreFamily } = require('./validation/field_rules');
const { getStoreProfile, FAMILY } = require('./store_profiles');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeUpperWords(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePassportEnglishName(value) {
  let normalized = normalizeUpperWords(value);
  for (;;) {
    const before = normalized;
    normalized = normalized
      .replace(/^(?:MSL|MSLI|MSLL|MLZ|MLZI|MLZZ)\s+/, '')
      .replace(/^PO\s+CHN\s+/, '')
      .replace(/^POCHN\s+/, '')
      .replace(/^POCHN(?=[A-Z])/, '');
    normalized = normalizeUpperWords(normalized);
    if (normalized === before) {
      break;
    }
  }
  // 审核标准(0727反馈#9):姓(空格)名,名的多段合并——首词=姓,其余名段拼死
  // (PHAM THI THUY LINH → PHAM THITHUYLINH)。护照名段空格是排版不是语义,
  // 越南/马来名 3~4 段全分写,台账/账单两侧排版随缘,统一成单一形态才可对账。
  // 两词以内已是标准形态不动;Auto/Final 同走此函数,人工输入也被收口。
  const parts = normalized.split(' ');
  if (parts.length > 2) {
    normalized = `${parts[0]} ${parts.slice(1).join('')}`;
  }
  return normalized;
}

function normalizeChineseName(value) {
  return String(value || '').replace(/[^\u3400-\u9fff]/gu, '').slice(0, 10);
}

function normalizeAlphaNumUpper(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeTrimmedText(value) {
  return String(value || '').trim();
}

// 团号:保留字母(乐天R团/首尔V团团号带英文,《所有模式小票具体记录流程》确认),
// 但剥"标签式前缀"——字母块后带分隔符的是票面标签(G 25184 / G-12345 → 25184);
// 字母与数字连写的是真团号(R2299001 原样保留)。旧 normalizeDigits 会把 R 剥掉致团号表匹配失败。
function normalizeGroupNo(value) {
  const raw = String(value || '').toUpperCase().trim();
  // 机场票(新世界机场等)团号栏就写"无"——是合法业务值不是没填。
  // 旧逻辑会把"无"剥成空串 → 必填卡死审核。保留特殊记号原样通过。
  if (raw === '无' || raw === '无团号') return '无';
  const label = raw.match(/^([A-Z]+)[\s\-_:：]+(.*\d.*)$/);
  const core = label ? label[2] : raw;
  return core.replace(/[^A-Z0-9]/g, '');
}

function stripReceiptNoLabel(value) {
  return String(value || '')
    .trim()
    .replace(/^\s*(?:NO|RECEIPT\s*NO|REF\.?\s*NO|APPROVAL\s*NO)\s*[:：.]?\s*/i, '');
}

function normalizeReceiptNoDigits(value) {
  const withoutLabel = stripReceiptNoLabel(value)
    .replace(/^0[.．](?=(?:03|21)[-./．\s])/, '');
  return normalizeDigits(withoutLabel);
}

// 小票号存储口径(2026-07 解禁):保留字母(济州乐天V特殊 90G331…)**和横线**
// (新世界/现代 BILL NO 要求带杠 19 位,《所有模式小票具体记录流程》),只去空格/点/标签前缀。
// 审核员输入什么就存什么——之前存时剥杠、导出再还原的方案在生产被证伪:
// 操作员手补带杠票号被"改没了",观感就是"改不过来"。
// 对账/查重等"匹配"场景仍用 normalizeReceiptNoDigits 的纯数字投影(数字核不变,新旧数据可比)。
function normalizeReceiptNo(value) {
  const withoutLabel = stripReceiptNoLabel(value)
    .replace(/^0[.．](?=(?:03|21)[-./．\s])/, '');
  return String(withoutLabel)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeReceiptStore(value) {
  const canonical = normalizeStoreFamily(value);
  if (canonical) {
    return canonical;
  }
  return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function pad2(value) {
  return String(value || '').padStart(2, '0');
}

function toValidIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return '';
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return '';
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) {
    return '';
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function normalizeOcrDate(value) {
  const source = String(value || '').trim();
  if (!source) {
    return '';
  }

  const compact = source.replace(/[年月]/g, '-').replace(/[日]/g, ' ');
  const fullYear = compact.match(/([12]\d{3})[./-](\d{1,2})[./-](\d{1,2})/);
  if (fullYear) {
    return toValidIsoDate(fullYear[1], fullYear[2], fullYear[3]);
  }

  const shortYear = compact.match(/\b(\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (shortYear) {
    return toValidIsoDate(2000 + Number(shortYear[1]), shortYear[2], shortYear[3]);
  }

  return '';
}

function setIfPresent(target, source, key, normalizer) {
  if (hasOwn(source, key)) {
    target[key] = normalizer(source[key]);
  }
}

function normalizeOcrFieldsForDocType(docType, fields = {}) {
  const normalizedDocType = String(docType || '').trim().toLowerCase();
  const next = {};

  setIfPresent(next, fields, 'extractedNameAuto', normalizedDocType === 'passport'
    ? normalizePassportEnglishName
    : normalizeUpperWords);
  setIfPresent(next, fields, 'passportNoAuto', normalizeAlphaNumUpper);
  setIfPresent(next, fields, 'chineseNameAuto', normalizeChineseName);

  if (normalizedDocType === 'receipt') {
    setIfPresent(next, fields, 'receiptStoreAuto', normalizeReceiptStore);
    // raw 留底:归一化前的 OCR 原串(带杠/带字母),导出层按模式还原格式用;
    // 审核员永远只看归一后的值,不为格式做二次操作。
    if (hasOwn(fields, 'receiptNoAuto') && !hasOwn(fields, 'receiptNoRawAuto')) {
      next.receiptNoRawAuto = String(fields.receiptNoAuto || '').trim();
    }
    setIfPresent(next, fields, 'receiptNoAuto', normalizeReceiptNo);
    // 团号保留字母(乐天R团/首尔V团 团号带英文;《所有模式小票具体记录流程》确认):
    // 旧的 normalizeDigits 会把 R2299001 剥成 2299001,团号表精确匹配必失败。
    setIfPresent(next, fields, 'groupNoAuto', normalizeGroupNo);
    setIfPresent(next, fields, 'purchaseDateAuto', normalizeOcrDate);
    setIfPresent(next, fields, 'departureDateAuto', normalizeOcrDate);
  } else if (normalizedDocType === 'passport') {
    if (hasOwn(fields, 'departureDateAuto')) {
      next.departureDateAuto = '';
    }
    if (hasOwn(fields, 'purchaseDateAuto')) {
      next.purchaseDateAuto = '';
    }
  }

  return next;
}

function normalizeEditableFieldsForDocType(docType, fields = {}) {
  const normalizedDocType = String(docType || '').trim().toLowerCase();
  const next = {};

  if (normalizedDocType === 'receipt') {
    setIfPresent(next, fields, 'receiptStoreFinal', normalizeReceiptStore);
    setIfPresent(next, fields, 'receiptNoFinal', normalizeReceiptNo); // 保字母,同 Auto 口径
    setIfPresent(next, fields, 'groupNoFinal', normalizeGroupNo); // 团号保留字母+剥标签前缀,同上
    setIfPresent(next, fields, 'purchaseDateFinal', normalizeOcrDate);
    setIfPresent(next, fields, 'departureDateFinal', normalizeOcrDate);
    // 百货真字段(P2):金额只留数字;门店/品牌/上家为中/韩文名,只去首尾空白
    setIfPresent(next, fields, 'receiptAmountFinal', normalizeDigits);
    setIfPresent(next, fields, 'branchFinal', normalizeTrimmedText);
    setIfPresent(next, fields, 'brandFinal', normalizeTrimmedText);
    setIfPresent(next, fields, 'upstreamFinal', normalizeTrimmedText);
    // 百货身份字段(2026-07-12 报障#2):乐天/新世界百货护照+小票同框,姓名/护照号
    // 就登记在小票任务上(qwen 跨源共识已回填 Auto);此前 receipt 白名单不收这俩,
    // 审核员在百货面板改了也存不进——归一与护照任务同口径。
    // 按店收窄(复审 MEDIUM,别靠"前端会置空"的巧合):百货店 → 放行任意值;
    // 非百货/店未知 → 只接受空串(切回免税店时清残留),非空值一律不收——
    // 免税店小票的身份真相永远在护照任务上,不给"小票带私货护照号"开口子。
    const storeCanonical = normalizeStoreFamily(String(fields.receiptStoreFinal || ''));
    const isDeptForIdentity = /_DEPT$/.test(storeCanonical);
    for (const [key, normalize] of [
      ['extractedNameFinal', normalizePassportEnglishName],
      ['passportNoFinal', normalizeAlphaNumUpper],
    ]) {
      if (!hasOwn(fields, key)) continue;
      const value = String(fields[key] || '').trim();
      if (isDeptForIdentity) {
        next[key] = normalize(fields[key]);
      } else if (value === '') {
        next[key] = ''; // 清残留放行
      }
      // 非百货 + 非空值:不进 next(丢弃,与放行前的历史行为一致)
    }
    // 改店按目标店白名单清残留(2026-07-14 审计中危):PATCH 带 receiptStoreFinal=改店信号,
    // 目标店档案没有的百货字段一律置空——乐天百货→新世界百货 残留 branch/brand、
    // 百货→免税店 残留全四件。靠"前端面板会置空"是巧合不是防线(原子定型 PATCH 不走面板)。
    // ⚠️触发条件必须是"店字段=非空字符串"(明确改店),不能用 hasOwn:updateTask 的调用方
    // 把全部键作为对象字面量传入(缺席=undefined 但键存在),hasOwn 恒真会让清残留在
    // **每次小票 PATCH** 上触发——不带店的单字段 PATCH(canonical='')会把百货任务
    // 随请求携带的金额/上家经 `??` 合并冲成空(自查发现,险些引入)。
    if (typeof fields.receiptStoreFinal === 'string' && fields.receiptStoreFinal.trim()) {
      const targetProfile = getStoreProfile(storeCanonical);
      const allowedDeptFinals = targetProfile.family === FAMILY.DEPT
        ? new Set((targetProfile.fields || []).map((f) => `${f}Final`))
        : new Set(); // 免税店:百货四件全清
      for (const key of ['receiptAmountFinal', 'branchFinal', 'brandFinal', 'upstreamFinal']) {
        if (!allowedDeptFinals.has(key)) next[key] = '';
      }
    }
  } else if (normalizedDocType === 'passport') {
    setIfPresent(next, fields, 'extractedNameFinal', normalizePassportEnglishName);
    setIfPresent(next, fields, 'passportNoFinal', normalizeAlphaNumUpper);
    setIfPresent(next, fields, 'chineseNameFinal', normalizeChineseName);
    if (hasOwn(fields, 'purchaseDateFinal')) {
      next.purchaseDateFinal = '';
    }
    if (hasOwn(fields, 'departureDateFinal')) {
      next.departureDateFinal = '';
    }
  }

  return next;
}

module.exports = {
  normalizeEditableFieldsForDocType,
  normalizeGroupNo,
  normalizeOcrDate,
  normalizeOcrFieldsForDocType,
  normalizePassportEnglishName,
  normalizeReceiptNo,
  normalizeReceiptNoDigits,
};
