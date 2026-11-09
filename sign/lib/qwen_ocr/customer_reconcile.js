'use strict';

// P1.1 跨图护照共识:一个客户的多张图(护照图、小票图)分散时,
// 用"全客户 sidecar"汇集护照号,在**可信**时(某图 MRZ 已验证 或 多源一致)
// 回写那些自身未验证、且与共识不一致的 护照/小票 sidecar。
//
// 安全原则:不做无依据的猜测——分歧且无 MRZ 锚点时不回写,保留 needsReview 让人工定。
// paddle 模式没有 sidecar → 自然 no-op(不影响默认路径)。

const fs = require('node:fs');
const path = require('node:path');

const { DOC_TYPES } = require('../package_constants');
const { SIDECAR_SUFFIX, readSidecar, writeSidecar } = require('./sidecar');

const normAlnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 护照号形态闸。**刻意不写死成大陆格式**:第一版用 /^[A-Z]{1,2}\d{7,8}$/,
// 拿生产数据一比就发现会误伤——客人里有台湾(**9 位纯数字**,如 316264111,
// 姓名是 CHOU HSUEHHSIN 这种威妥玛拼音)和港澳/其它国家格式(AW991951、CD804681、
// K4497728G、P299494ED)。按国别写规则永远追不全,只会把合法客人挡在跨图纠正之外。
//
// 改成按**结构**判定,只需要把真正的残串挡掉即可 —— 生产实测的残串长这样:
//   E / 494 / E5323 / E0890 / 5565 / CHNEQ72 / CHNEFBO(国籍码粘半截)
// 以及 MRZ 整段被当成号码的 44 字符长串。
// 规则:8~12 位字母数字,且至少 6 位数字。上面每一个残串都被挡下,
// 而实测出现过的各国合法号(大陆 1677 / 台湾 / 港澳 43)全部放行。
function plausiblePassportNo(no) {
  let s = String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // MRZ 国籍码 CHN 粘在前面是常见污染,剥掉后若成形就认(CHNEQ72 这类剥完仍不成形,照样挡)
  if (s.startsWith('CHN') && s.length > 3) {
    const stripped = s.slice(3);
    if (looksLikePassport(stripped)) s = stripped;
  }
  return looksLikePassport(s);
}

function looksLikePassport(s) {
  if (s.length < 8 || s.length > 12) return false;
  const digits = (s.match(/\d/g) || []).length;
  return digits >= 6;
}

// 从候选选可信护照号:① 任一 MRZ 验证过 → 用它;② 否则在**形态合法**的候选里取多数票
// (≥2 且唯一最高)→ 用它;③ 都不满足(分歧无锚点)→ 返回 null,不猜。
//
// ⭐0729 生产数据实测后加的形态闸:原来任何字符串都能参选并获胜,于是 OCR 残串
// 直接被写成护照号。全库 3786 条纯共识改写按**结构**重新分类:
//   大陆格式 1677 / 台湾9位 3 / 港澳等 43 / **真残串 2063**
//   (残串实样:E、494、E5323、E0890、5565、CHNEQ72、CHNEFBO、CHNE951、1422)
// 更糟的是其中一批还被标成"不用复核",388 条与审核确认后的夹名护照号直接冲突。
// ⚠️第一版我用大陆格式正则统计,把台湾/港澳的合法号也算进了"垃圾",数字报高了;
// 按国别写规则永远追不全 —— 见 plausiblePassportNo 上方注释。
// 成因很实在:免税店小票上**印着**护照号,同一台 POS 同一字体,OCR 很可能把两张
// 小票**同样地读错** → 两票错读压过一票正读,还因为"有共识"被当成可信。
function pickTrustedPassport(candidates) {
  const valid = candidates.find((c) => c.mrzValid && c.no);
  if (valid) return { no: valid.no, source: 'mrz-valid' };
  const freq = {};
  // 只有形态合法的才有投票权:残串再多票也不该赢
  candidates.forEach((c) => { if (c.no && plausiblePassportNo(c.no)) freq[c.no] = (freq[c.no] || 0) + 1; });
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  if (sorted.length && freq[sorted[0]] >= 2 && (sorted.length === 1 || freq[sorted[0]] > freq[sorted[1]])) {
    return { no: sorted[0], source: 'consensus' };
  }
  return null;
}

function reconcileCustomerPassport(imagesDir) {
  if (!imagesDir || !fs.existsSync(imagesDir)) return { updated: 0 };
  let files;
  try {
    files = fs.readdirSync(imagesDir).filter((f) => f.endsWith(SIDECAR_SUFFIX));
  } catch {
    return { updated: 0 };
  }
  if (files.length < 2) return { updated: 0 };

  const entries = files
    .map((f) => {
      const imagePath = path.join(imagesDir, f.slice(0, -SIDECAR_SUFFIX.length));
      return { imagePath, analysis: readSidecar(imagePath) };
    })
    .filter((e) => e.analysis);

  // 汇集护照号候选(护照图 + 小票上印的护照号)
  const candidates = [];
  for (const { analysis } of entries) {
    const no = normAlnum(analysis.passportNoAuto);
    if (!no) continue;
    candidates.push({ no, mrzValid: Boolean(analysis.modelMeta && analysis.modelMeta.mrzValid) });
  }
  if (candidates.length < 2) return { updated: 0 };

  const picked = pickTrustedPassport(candidates);
  if (!picked) return { updated: 0 }; // 分歧无锚点 → 不猜,留人工

  let updated = 0;
  for (const { imagePath, analysis } of entries) {
    const isDoc = analysis.docTypeFinal === DOC_TYPES.PASSPORT || analysis.docTypeFinal === DOC_TYPES.RECEIPT;
    if (!isDoc) continue;
    if (analysis.modelMeta && analysis.modelMeta.mrzValid) continue; // 自身 MRZ 验证过 → 最可信,不动

    const valueDiffers = normAlnum(analysis.passportNoAuto) !== picked.no;
    const hadUnverified = (analysis.reviewReasons || []).includes('passport_no_unverified');
    // 值一致 且 本就无未验证标记 → 无事可做
    if (!valueDiffers && !hadUnverified) continue;

    // 值不一致 → 用可信共识纠正;值一致但曾标未验证 → 被跨图佐证,清标。
    // ⭐0729:清标只认 MRZ。纯共识(source=consensus)是**弱证据** ——
    // 它只说明"至少两处读出了同一个值",而同一台 POS、同一字体的两张小票很可能
    // **同样地读错**;把它当成"已核实"直接清标,等于把一个错误升格成绿灯,
    // 那张任务会落进「一眼过」档、可能被批量通过,再没人看第二眼。
    // 全库实测:1005 条纯共识改写被标成"不用复核",其中 388 条与人工确认值直接冲突。
    // 值仍然采纳(跨图纠正确实能修掉大部分单点 OCR 抖动),但标记留着,让它继续排在复核里。
    // 区分两种情况,只收紧危险的那种:
    //   值**不变**、被另一处读出同样的值 = 真佐证 → 照旧清标(既有产品决定,别一起关掉)
    //   值**被改写**、而依据只是共识  = 弱证据 → 必须留在复核里
    // 危险的只有后者:实样 CAO ZIYU_EK9330357 被共识改成 E86015380 且 needsReview=false,
    // 与人工确认的夹名护照号直接冲突,而系统说它不用看。全库这类 388 条。
    const weakOverwrite = valueDiffers && picked.source !== 'mrz-valid';
    const reasons = (analysis.reviewReasons || [])
      .filter((r) => r !== 'passport_no_unverified' || weakOverwrite);
    // 本来就没标记、值却被弱证据改写的,要**补上**标记(filter 只能保留,补不了)
    if (weakOverwrite && !reasons.includes('passport_no_unverified')) {
      reasons.push('passport_no_unverified');
    }
    const next = {
      ...analysis,
      passportNoAuto: picked.no,
      reviewReasons: [...new Set(reasons)],
      modelMeta: {
        ...(analysis.modelMeta || {}),
        passportSource: `xreconcile-${valueDiffers ? '' : 'corroborated-'}${picked.source}`,
        reconciled: true,
      },
    };
    next.needsReview = next.reviewReasons.length > 0;
    writeSidecar(imagePath, next);
    updated += 1;
  }
  return { updated, picked: picked.no, source: picked.source };
}

module.exports = { reconcileCustomerPassport, plausiblePassportNo };
