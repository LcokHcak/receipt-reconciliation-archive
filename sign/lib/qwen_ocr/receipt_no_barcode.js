'use strict';

// 票号条码本地解码(2026-07-21 90% 冲刺三批,"不翻倍"方案):
// 新罗/爱宝客/现代把票号印成顶部 Code39(*0126300701581*),乐天/济州印在票底,
// 本地 WASM 解码=零 API 的地面真值。只在"锚点未过/漏识别"路径上先试条码,
// 解出且过该店锚点规格才采信——省下二遍 API 调用;解不出再走放大重读。
// 实测(174 张金标切片,tmp/errfix_barcode_probe.js):解码命中≈2-4成
// (压缩图细条纹易糊,COMPRESS_MAX_SIDE=2400 是存量上限),命中者零误码
// (不匹配的全是营销 QR,已按格式排除);命中即等于免费修对/免费互证。
// CPU:仅弱值路径触发,单图两轮解码 ~0.3-0.6s,远小于一次 API 调用。

const sharp = require('sharp');
const { checkReceiptNoAnchors } = require('./receipt_no_anchors');

const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const alnum = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// 只认一维码(票号载体);QR 是营销链接/领取指引,一律不看
const FORMATS = ['Code39', 'Code128', 'ITF'];

let readBarcodesFn = null;
async function loadReader() {
  if (!readBarcodesFn) {
    // 惰性加载:WASM 初始化有一次性开销,不走条码路径的进程零成本
    ({ readBarcodes: readBarcodesFn } = require('zxing-wasm/reader'));
  }
  return readBarcodesFn;
}

// 图 → 一维码载荷列表(原尺寸 + 2 倍放大各一轮:压缩图细条纹放大后常反而可读)。
// 任何失败返回 [](解码是白捡不是闸门,绝不阻断)。
async function decodeReceiptNoBarcodes(imagePath) {
  try {
    const readBarcodes = await loadReader();
    const variants = [
      (img) => img,
      (img) => img.resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: false }),
    ];
    for (const v of variants) {
      try {
        const { data, info } = await v(sharp(imagePath).rotate()).ensureAlpha()
          .raw().toBuffer({ resolveWithObject: true });
        const results = await readBarcodes(
          { data: new Uint8ClampedArray(data), width: info.width, height: info.height },
          { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 4 }
        );
        const hits = (results || [])
          .filter((r) => r.isValid && String(r.text || '').trim())
          .map((r) => ({ fmt: String(r.format || ''), text: String(r.text).trim() }));
        if (hits.length) return hits;
      } catch { /* 换下一轮 */ }
    }
  } catch { /* WASM 加载失败等:当没有条码 */ }
  return [];
}

// 载荷 → 该任务的票号候选:必须整体通过店锚点规格(定长/前缀/嵌入日期)才算数。
// 多个合格候选时优先与一遍读数数字一致的;都不一致且多于一个 → 判不了,放弃(绝不猜)。
// receiptCount:整张图里有几张小票(条码是解整张图的,同图多票时孤条码无法归属)。
function pickBarcodeReceiptNo({ hits, storeFamily, firstPass, purchaseDate, receiptCount = 1 } = {}) {
  const cands = [];
  for (const h of (hits || [])) {
    const payload = alnum(h.text);
    if (payload.length < 10 || payload.length > 20) continue;
    const { suspect } = checkReceiptNoAnchors({ storeFamily, receiptNo: payload, purchaseDate });
    if (!suspect) cands.push({ ...h, payload });
  }
  if (!cands.length) return null;
  const first = digits(firstPass);
  const same = cands.find((c) => first && digits(c.payload) === first);
  if (same) return { value: same.payload, fmt: same.fmt, agreesWithFirstPass: true };
  // 孤条码不与本票一遍一致:同图多票时无法归属(可能是别张票的条码,采了=把对的读错成别人的号)——
  // 深度审计 HIGH 跨票污染。只有整张图确定就一张小票时,孤条码才必然是本票的,可采。
  if (cands.length === 1 && Number(receiptCount) <= 1) {
    return { value: cands[0].payload, fmt: cands[0].fmt, agreesWithFirstPass: false };
  }
  return null; // 多候选无一致 / 同图多票的孤条码 → 分不清是谁的票号,放弃(绝不跨票污染)
}

module.exports = { decodeReceiptNoBarcodes, pickBarcodeReceiptNo, RECEIPT_NO_BARCODE_FORMATS: FORMATS };
