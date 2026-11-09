'use strict';

// 千问字段的本地清洗(落审核台前)。
// 注意:最终字段归一仍交给 sign 的 normalizeOcrFieldsForDocType(适配器里调),
// 这里只做千问特有的提取/纠偏(团号取数字+共识、日期规整、店名粗映射)。

const { normalizeGroupNo } = require('../workbench_field_normalizer');

// 团号:格式因店而异——新罗/爱宝客约 5 位、乐天约 8 位;标签 G / GROUP / 团号 / 단체 等。
// 抽取优先级:① 标签后的数字 → ② 按该店期望长度(expectedLen,来自 TOUR_NO_LENGTH_BY_STORE)精确取
//   → ③ 兜底任意 4~8 位。\b 边界滤掉柜台码(3位)、13/14位小票号。
// ⚠️2026-07-10 审计修复:曾只认 \d{4,8} 的纯数字投影——字母团号(乐天R团 R2299001/首尔V团
// 26V00041,真实病例)在 OCR 源头被抽空或咬错尾段,后面中央归一救不回。现在标签/兜底两路都
// 允许字母数字混合团号 token,命中后统一过中央 normalizeGroupNo 出值(保字母/剥标签/"无"透传)。
function groupDigits(s, expectedLen) {
  const str = String(s || '').toUpperCase();
  // 机场票团号栏就写"无"(新世界机场)——合法业务值,原样透传给 sign 归一层。
  if (str.trim() === '无' || str.trim() === '无团号') return '无';
  // 长标签在前(GROUP/GT 先于 G,否则 "GT:79611" 里 G 先咬住 T 就匹配失败);
  // token 允许字母(要求 ≥4 位数字,防抓到纯字母词)。
  const labeled = str.match(/(?:GROUP|GT|G|团号|團號|단체)\s*[:：#.]?\s*((?=(?:[^0-9]*[0-9]){4})[A-Z0-9][A-Z0-9-]{3,9})/i);
  if (labeled) return normalizeGroupNo(labeled[1]);
  // 字母数字混合团号形态:26V00041(数字-字母-数字)/ R2299001(前导1-2字母+5-8数字)。
  const mixed = str.match(/\b(?:\d{1,3}[A-Z]\d{4,7}|[A-Z]{1,2}\d{5,8})\b/);
  if (mixed) return normalizeGroupNo(mixed[0]);
  if (expectedLen) {
    const exact = str.match(new RegExp(`\\b\\d{${expectedLen}}\\b`));
    if (exact) return exact[0];
  }
  const any = str.match(/\b\d{4,8}\b/);
  return any ? any[0] : '';
}

// 同一客户多张小票的团号取共识(出现最多的数字),滤掉一次性误读的柜台码
function consensusGroupNo(rawGroupNos = [], expectedLen) {
  const cands = rawGroupNos.map((g) => groupDigits(g, expectedLen)).filter(Boolean);
  if (!cands.length) return '';
  const freq = {};
  cands.forEach((g) => { freq[g] = (freq[g] || 0) + 1; });
  return Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || '';
}

// 日期规整成 YYYY-MM-DD(容 2026/01/24、2026.1.24 等)
function normalizeDate(v) {
  if (!v) return '';
  const m = String(v).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : String(v).trim();
}

// 免税店映射到 sign 校验器认的规范值(THE SHILLA / LOTTE / SHILLA IPARK)。
// 见 lib/validation/field_rules.js#normalizeStoreFamily —— 否则会误报 field_store_family_invalid。
// 济州/首尔 新罗免税店=THE SHILLA;新罗아이파크/HDC/爱宝客=SHILLA IPARK;乐天=LOTTE。
function normalizeStoreFamily(s) {
  const raw = String(s || '').trim();
  const t = raw.toUpperCase();
  // ⭐百货透传(2026-07-06 撞名防线延伸):「乐天百货/롯데백화점」若被下面 /乐天|LOTTE/ 咬住
  // 就成了 LOTTE 免税店 → isDeptStore=false → 百货短路(整图不切)永远不触发,恰好是最不能裁的店。
  // 含百货标记词 → 原样透传,交给 validation/field_rules.normalizeStoreFamily 的百货优先分支(LOTTE_DEPT 等)。
  // 注意 DEPARTMENT 不含连续子串 DEPT(D-E-P-A-R-T),两个都要列(与 field_rules.DEPT_KEYWORDS 对齐)
  if (/百货|백화점|DEPT|DEPARTMENT/i.test(raw)) return raw;
  // 只在明确 아이파크/IPARK 时判 SHILLA IPARK(不靠 HDC 法人名,济州新罗也由 HDC 运营但属 THE SHILLA)
  if (/IPARK|아이파크|爱宝客|愛寶客/.test(raw)) return 'SHILLA IPARK';
  if (/乐天|樂天|LOTTE|롯데/.test(t)) return 'LOTTE';
  if (/新罗|新羅|신라|SHILLA/.test(t)) return 'THE SHILLA';
  return raw; // 交给 sign 的 normalizeStoreFamily 再判
}

// 编造值形态检测(2026-07-06 #5):模型对个别图会现编"像样"的假值——实锤病例
// task_0162:小票号 0000-0000-0000-0000 / 团号 12345 / conf 0.95(不是毒缓存,是真输出),
// 12345 恰好 5 位还骗过新罗团号长度规则拿了绿灯。全同数字/从头顺子 = 典型编造形态,
// ≥4 位才判(防误伤短值);宁可置空转人工,不能带绿混过审。
function isJunkNumericValue(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  if (digits.length < 4) return false;
  if (/^(\d)\1+$/.test(digits)) return true; // 全同一数字(0000…/1111…)
  if ('1234567890'.startsWith(digits) || '0123456789'.startsWith(digits)) return true; // 从头顺子
  return false;
}

// ── 百货真字段清洗(P2,2026-07-06)──规则来自 store_profiles 档案,这里只做值归一。

// 金额:只留数字("3,500,000원"→"3500000")。百货金额=总金额(用户拍板),借位只在导出映射层。
function normalizeDeptAmount(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  return digits.replace(/^0+(?=\d)/, '');
}

// 门店:票面4位编号**原样保留**(2026-07-12 用户拍板:0001就是0001,不换门店名)。
// qwen 若吐了带杂质的串("0394 明洞점"),提取其中的4位数字码;纯门店名(明洞)不可逆
// 定码(明洞=0394或0001)→ 原样透传,校验标红人工照票面填码。
function normalizeDeptBranch(v) {
  const raw = String(v || '').trim();
  if (!raw) return raw;
  if (/^\d{4}$/.test(raw)) return raw; // 已是4位码,原样(保前导零)
  const m = raw.match(/(?:^|[^0-9])(\d{4})(?![0-9])/); // 不用 \b(韩文非词边界),且排除更长数字串误截
  if (m) return m[1]; // 串里带码 → 提码(排除更长数字串误截)
  return raw; // 纯名字/杂串 → 透传标红,人工照票面填
}

// 品牌:只要韩文(2026-07-12 用户拍板)。韩文按包含吸附白名单;票面/qwen 输出英文时
// 按别名表折到对应韩文(LOUIS VUITTON/LV→루이비통 等);对不上原样透传(校验标红人工选)。
const DEPT_BRAND_EN_ALIASES = Object.freeze([
  Object.freeze({ brand: '루이비통', re: /LOUIS\s*VUITTON|(?:^|[^A-Z])LV(?:[^A-Z]|$)/i }),
  Object.freeze({ brand: '반클리프 아펠', re: /VAN\s*CLEEF|ARPELS/i }),
  Object.freeze({ brand: '티파니', re: /TIFFANY/i }),
]);

function normalizeDeptBrand(v, brandList) {
  const raw = String(v || '').trim();
  if (!raw || !Array.isArray(brandList)) return raw;
  const hit = brandList.find((brand) => raw.includes(brand));
  if (hit) return hit;
  const alias = DEPT_BRAND_EN_ALIASES.find((a) => a.re.test(raw) && brandList.includes(a.brand));
  return alias ? alias.brand : raw;
}

module.exports = {
  groupDigits,
  consensusGroupNo,
  isJunkNumericValue,
  normalizeDate,
  normalizeStoreFamily,
  normalizeDeptAmount,
  normalizeDeptBranch,
  normalizeDeptBrand,
};
