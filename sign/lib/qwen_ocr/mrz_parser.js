'use strict';

// 护照机读区(MRZ, TD3)解析 + 校验位验证。
// TD3 = 护照标准:2 行 × 44 字符。第2行:pos1-9 护照号, pos10 校验位, pos11-13 国籍,
// pos14-19 出生YYMMDD, pos20 校验, pos21 性别, pos22-27 有效期, pos28 校验。
// 用途:千问把 MRZ 当等宽机读文字读(比直视护照号区准),用校验位确认读对没,
// 纠正直读护照号(如 EQ→E0 第2字母误读)。校验位过 = 高可信。

function cleanMrz(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, '');
}

function charValue(c) {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55; // A=10
  return 0;
}

// 校验位:权重 7,3,1 循环求和 mod 10
function computeCheckDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += charValue(str[i]) * weights[i % 3];
  return sum % 10;
}

function parseName(line1) {
  const l1 = cleanMrz(line1);
  const namePart = l1.slice(5); // 跳过 P<CHN
  const [primary, secondary] = namePart.split('<<');
  const surname = (primary || '').replace(/</g, ' ').trim();
  const given = (secondary || '').replace(/</g, ' ').trim();
  // standard = 审核标准形态(0727反馈#9):姓(空格)名,名的多段合并——
  // PHAM<<THI<THUY<LINH → "PHAM THITHUYLINH"。MRZ 姓<<名结构性定序,顺序不可能反(#12)。
  const standard = [surname.replace(/\s+/g, ''), given.replace(/\s+/g, '')]
    .filter(Boolean).join(' ');
  return { surname, given, full: `${surname} ${given}`.trim(), standard };
}

function parseTd3(mrz1, mrz2) {
  const l2 = cleanMrz(mrz2);
  if (l2.length < 10) return null;

  const numField = l2.slice(0, 9);
  const numCheck = l2[9];
  const passportNo = numField.replace(/<+$/, '');
  const passportNoValid = String(computeCheckDigit(numField)) === numCheck;

  let nationality = '', birthDate = '', sex = '', expiryDate = '';
  if (l2.length >= 28) {
    nationality = l2.slice(10, 13).replace(/</g, '');
    birthDate = l2.slice(13, 19);
    sex = l2[20] && l2[20] !== '<' ? l2[20] : '';
    expiryDate = l2.slice(21, 27);
  }

  return {
    passportNo,
    passportNoValid,
    nationality,
    birthDate,
    sex,
    expiryDate,
    name: parseName(mrz1),
    ok: passportNo.length >= 5,
    numField,
    numCheck,
  };
}

// OCR-B 等宽字体易混字符(数字↔形近字母)。金标实锤主形态:护照号第2位 Q 被读成 0
// (EQ0727948→E00727948),直读和 MRZ 同一模型常"双双读错"逃过校验对比。
const CONFUSABLE = Object.freeze({
  0: ['O', 'Q', 'D'], O: ['0'], Q: ['0'], D: ['0'],
  1: ['I', 'L'], I: ['1'], L: ['1'],
  2: ['Z'], Z: ['2'],
  5: ['S'], S: ['5'],
  8: ['B'], B: ['8'],
  6: ['G'], G: ['6'],
});

// 校验位引导的单字符修复(#3,2026-07-06):MRZ 校验没过时,对号段逐位试易混替换,
// 哪个候选**通过校验位且格式合理**就采纳哪个(纯数学仲裁,不是猜)。
//   - 只修单字符(编辑距离1,主形态);候选不唯一=不敢定 → 不修
//   - 校验位字符本身被读成字母(1→I)→ 反向映射成数字后验原号段(错在校验位,号段本身对)
// 中国护照第二位数字/字母都合法(旧版E+8位数字仍在有效期),所以不能按位置写死,只能靠校验位。
function repairPassportNoByChecksum(numField, numCheck) {
  const field = String(numField || '');
  const check = String(numCheck || '');
  if (!field || !check) return '';

  if (/^\d$/.test(check)) {
    const found = new Set();
    for (let i = 0; i < field.length; i += 1) {
      for (const alt of CONFUSABLE[field[i]] || []) {
        const cand = field.slice(0, i) + alt + field.slice(i + 1);
        const candNo = cand.replace(/<+$/, '');
        if (!isPlausiblePassportNo(candNo)) continue;
        if (String(computeCheckDigit(cand)) === check) found.add(candNo);
      }
    }
    return found.size === 1 ? [...found][0] : '';
  }

  // 校验位读成了字母:错在校验位本身 → 数字反推后验原号段(号段不动,不叠加两处错)
  for (const alt of CONFUSABLE[check] || []) {
    if (!/^\d$/.test(alt)) continue;
    const no = field.replace(/<+$/, '');
    if (isPlausiblePassportNo(no) && String(computeCheckDigit(field)) === alt) return no;
  }
  return '';
}

const normAlnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 合理性闸:中国护照号 = 1~2 个字母 + 6~8 位数字,不含国籍码 CHN、不数字开头。
// MRZ 校验位只是 mod 10、约 10% 概率碰巧蒙过(实测出现过 6CHN02041、CHN781807 这类
// "校验过却明显错"的假阳性),必须叠加格式合理性才采信 MRZ 号,否则退回直读 + 转人工。
function isPlausiblePassportNo(no) {
  const s = normAlnum(no);
  if (!s || s.includes('CHN')) return false;
  return /^[A-Z]{1,2}\d{6,8}$/.test(s);
}

// 综合决策:直读号 + MRZ → 最佳护照号 + 来源 + 是否转人工。
//   - MRZ 校验过 **且格式合理** → 用 MRZ 号(最可信)
//   - MRZ 与直读一致 → 用该号(两路印证)
//   - MRZ 校验过但格式不合理(含 CHN/数字开头)= 假阳性 → 不采信,退回直读 + 转人工
//   - MRZ 校验没过且与直读不一致 → 双读冲突,保留直读 + 转人工
function resolvePassportNo(directNo, mrz1, mrz2) {
  const direct = normAlnum(directNo);
  const parsed = parseTd3(mrz1, mrz2);
  if (!parsed || !parsed.ok) {
    return { passportNo: direct, source: 'direct', needsReview: !direct, mrzValid: false };
  }
  const mrzNo = normAlnum(parsed.passportNo);
  if (parsed.passportNoValid && isPlausiblePassportNo(mrzNo)) {
    return { passportNo: mrzNo, source: 'mrz-valid', needsReview: false, mrzValid: true, agree: mrzNo === direct };
  }
  // 校验没过 → 单字符易混修复(#3):唯一候选过校验位+格式合理 = 数学仲裁采纳
  // (EQ0727948 被双双读成 E00727948 的病例:替换第2位 0→Q 后校验位吻合 → 自动纠正)
  if (!parsed.passportNoValid) {
    const repaired = repairPassportNoByChecksum(parsed.numField, parsed.numCheck);
    if (repaired) {
      return { passportNo: repaired, source: 'mrz-checksum-repaired', needsReview: false, mrzValid: true, agree: repaired === direct, repairedFrom: mrzNo };
    }
  }
  if (mrzNo && mrzNo === direct) {
    // 两路一致但校验位没过且修不出:直读和 MRZ 是同一模型读的,易混字符常"双双读错",
    // 一致≠印证(E0↔EQ 病例正是走这里免审拿了绿灯)→ 保值但标未验证转人工(前端黄灯)。
    return { passportNo: direct, source: 'agree', needsReview: true, mrzValid: parsed.passportNoValid };
  }
  return {
    passportNo: direct,
    source: parsed.passportNoValid ? 'mrz-implausible' : 'direct-conflict',
    needsReview: true,
    mrzValid: false,
  };
}

module.exports = { parseTd3, parseMrzName: parseName, resolvePassportNo, computeCheckDigit, cleanMrz, isPlausiblePassportNo, repairPassportNoByChecksum };
