'use strict';

// 百货两段式补救(2026-07-12 金标重放实证立项):
// 第一段版面 prompt 的百货判定打不过"店名先验"——乐天百货票被判成 LOTTE 免税店、
// 新世界百货票面根本没有"백화점"字样全部漏检(金标重放 5/14)。
// 但第一段输出里有【确定性信号】可在代码层接住(46 张免税店反例零误触发):
//   - Global Blue 退税单被单独输出成 receipt/GLOBAL BLUE(免税店购物没有 GB 单)
//   - 品牌专柜票被输出成 receipt/LOUIS VUITTON(免税店枚举名单里不可能出现品牌名)
//   - 거래번호 形态 4位-4位(百货 POS 特有;免税店是 BILL NO 四段/13-14位长号)
//   - 底部条码整串 ≥20 位被当票号抄进来(任何免税店票号都没这么长)
//   - 护照+小票同框(百货拍法;免税店也偶有,靠第二段自答"不是百货"兜精度)
// 信号命中 → 用聚焦 prompt 追加一次调用(buildDeptRescuePrompt),百货则整组字段替换。

// 用 validation/field_rules 的正典归一(乐天百货→LOTTE_DEPT),不是 qwen 侧粗映射
// (那个对百货名是"原样透传",isDeptStore 查档案键会查不到)。
const { normalizeStoreFamily } = require('../validation/field_rules');
const { isDeptStore } = require('../store_profiles');

const GLOBAL_BLUE_RE = /GLOBAL\s*BLUE|글로벌\s*블루/i;
// 品牌当店名:第一段把专柜票的 storeFamily 填成品牌名(实测 LOUIS VUITTON 原样出现)。
// 只列奢侈品牌——免税店枚举名(THE SHILLA/LOTTE/SHINSEGAE/HYUNDAI/SHILLA IPARK)绝不含这些词。
const LUXURY_BRAND_STORE_RE = /(LOUIS\s*VUITTON|VUITTON|\bDIOR\b|CHANEL|VAN\s*CLEEF|ARPELS|TIFFANY|GUCCI|HERMES|PRADA|CELINE|BULGARI|BVLGARI|CARTIER|루이비통|디올|샤넬|반클리프|티파니|구찌|에르메스|프라다)/i;
const TRANS_NO_SHAPE_RE = /^\d{4}\s*-\s*\d{4}$/; // 거래번호 票面形态

function detectDeptRescueSignals(documents = []) {
  const signals = new Set();
  let hasPassport = false;
  let hasReceipt = false;
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;
    if (doc.type === 'passport') hasPassport = true;
    if (doc.type !== 'receipt') continue;
    hasReceipt = true;
    const storeFamily = String(doc.fields?.storeFamily || '').trim();
    const receiptNo = String(doc.fields?.receiptNo || '').trim();
    if (GLOBAL_BLUE_RE.test(storeFamily)) signals.add('global_blue_doc');
    else if (LUXURY_BRAND_STORE_RE.test(storeFamily)) signals.add('brand_as_store');
    if (isDeptStore(normalizeStoreFamily(storeFamily))) signals.add('dept_store_direct');
    if (TRANS_NO_SHAPE_RE.test(receiptNo)) signals.add('trans_no_shape');
    if (receiptNo.replace(/\D/g, '').length >= 20) signals.add('barcode_length_no');
  }
  if (hasPassport && hasReceipt) signals.add('passport_receipt_combined');
  // 没有任何小票文档就无从补救(纯护照页/空图不触发)
  return { hit: hasReceipt && signals.size > 0, signals: [...signals] };
}

// ⭐条码日期锚推导(金标真票解剖,2026-07 两轮重放实证):
//   乐天票底部条码数字串 = 店码4 + 购买日期YYYYMMDD + 거래번호8 + 金额8(前导零填充)
//   新世界票                =        购买日期YYMMDD   + 거래번호8 + 金额8
// 模型直读"条码前4位"在压图下全靠编(二轮 0/9);让它整串照抄、代码里拿购买日期当锚
// 确定性切分——锚前的误读不影响锚后字段,日期找不到就整体放弃,绝不猜。
function deriveDeptReceiptFields({ barcodeDigits, purchaseDate } = {}) {
  const digits = String(barcodeDigits || '').replace(/\D/g, '');
  const date = String(purchaseDate || '').trim(); // YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const none = { branch: '', receiptNo: '', amount: '' };
  if (!digits || digits.length < 14 || !m) return none;
  const [, yyyy, mm, dd] = m;
  for (const anchor of [`${yyyy}${mm}${dd}`, `${yyyy.slice(2)}${mm}${dd}`]) {
    const idx = digits.indexOf(anchor);
    if (idx < 0) continue;
    // 锚重复出现(尤其6位短锚可能撞进交易号/金额段)→ 消歧失败,当没找到处理,绝不猜
    if (digits.indexOf(anchor, idx + 1) >= 0) continue;
    const after = digits.slice(idx + anchor.length);
    if (after.length < 8) continue;
    const receiptNo = after.slice(0, 8);
    // 金额段:交易号后 8 位前导零填充;不足 8 位(条码尾部被裁)就放弃金额
    const amountRaw = after.slice(8, 16);
    const amount = amountRaw.length === 8 ? String(Number(amountRaw)) : '';
    // 店码:锚前恰好还有 ≥4 位才取(锚前被误读裁短就放弃店码,不硬凑)
    const before = digits.slice(0, idx);
    const branch = anchor.length === 8 && before.length >= 4 ? before.slice(-4) : '';
    return {
      branch,
      receiptNo,
      amount: amount === '0' ? '' : amount,
    };
  }
  return none;
}

// 第二段返回的松散 JSON → 收口的补救对象。store 必须能归一成 *_DEPT 才算数,
// 防模型把免税店照片强答成百货(店名对不上就当"不是百货")。
function parseDeptRescue(parsed = {}) {
  const isDeptClaim = parsed && (parsed.isDept === true || parsed.isDept === 'true');
  const storeRaw = String(parsed?.store || '').trim();
  const storeCanonical = normalizeStoreFamily(storeRaw);
  const accepted = Boolean(isDeptClaim && storeCanonical && isDeptStore(storeCanonical));
  const text = (v) => String(v ?? '').trim();
  return {
    isDept: accepted,
    store: accepted ? storeRaw : '',
    receiptNo: text(parsed?.receiptNo),
    amount: text(parsed?.amount),
    purchaseDate: text(parsed?.purchaseDate),
    barcodeDigits: text(parsed?.barcodeDigits),
    branch: text(parsed?.branch),
    brand: text(parsed?.brand),
    englishName: text(parsed?.englishName),
    passportNo: text(parsed?.passportNo),
    confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : null,
  };
}

// 合并策略:护照/其他文档原样保留(身份共识链路不动),所有小票文档
// (含被当成独立小票的 Global Blue 单/品牌票碎片)替换成 1 个百货小票文档——
// 拆图闸门(isDeptStore→整图不切)只认它,GB 单不会再被切成独立小票碎片。
// 补救字段留空时回填第一段百货文档的同名字段(有就不浪费)。
function applyDeptRescue(documents = [], rescue) {
  if (!rescue || !rescue.isDept) return documents;
  const kept = documents.filter((d) => d && d.type !== 'receipt');
  const prevDept = documents.find(
    (d) => d && d.type === 'receipt' && isDeptStore(normalizeStoreFamily(String(d.fields?.storeFamily || '')))
  );
  const prevFields = prevDept?.fields || {};
  const pick = (rescueValue, prevValue) => (rescueValue !== '' ? rescueValue : String(prevValue ?? '').trim());
  const deptDoc = {
    type: 'receipt',
    typeZh: '小票',
    bbox: [0, 0, 1, 1],
    confidence: rescue.confidence,
    fields: {
      storeFamily: rescue.store,
      receiptNo: pick(rescue.receiptNo, prevFields.receiptNo),
      amount: pick(rescue.amount, prevFields.amount),
      purchaseDate: pick(rescue.purchaseDate, prevFields.purchaseDate),
      barcodeDigits: rescue.barcodeDigits || '',
      branch: pick(rescue.branch, prevFields.branch),
      brand: pick(rescue.brand, prevFields.brand),
      englishName: pick(rescue.englishName, prevFields.englishName),
      passportNo: pick(rescue.passportNo, prevFields.passportNo),
      groupNo: '',
      departureDate: '',
    },
  };
  return [...kept, deptDoc];
}

module.exports = { detectDeptRescueSignals, parseDeptRescue, applyDeptRescue, deriveDeptReceiptFields };
