'use strict';

// 跨源护照号决策:护照文档(经 MRZ 校验/纠正)+ 小票上印的护照号 → 选最可信的一个。
// 选号优先级:MRZ 校验通过 > 多源共识(出现最多) > 任意。
// 标记:无 MRZ 校验通过且多源不一致/仅单一未验证源 → needsReview(转人工)。

const { resolvePassportNo } = require('./mrz_parser');

const normAlnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// documents: 千问返回的文档数组(含 passport/receipt,fields 里有 passportNo / mrz1 / mrz2)
function collectPassportCandidates(documents = []) {
  const cands = [];
  for (const d of documents) {
    if (d.type === 'passport') {
      const r = resolvePassportNo(d.fields?.passportNo, d.fields?.mrz1, d.fields?.mrz2);
      if (r.passportNo) cands.push({ no: r.passportNo, mrzValid: r.mrzValid, source: 'passport' });
    } else if (d.type === 'receipt' && d.fields?.passportNo) {
      cands.push({ no: normAlnum(d.fields.passportNo), mrzValid: false, source: 'receipt' });
    }
  }
  return cands;
}

function pickPassportNo(candidates = []) {
  const valid = candidates.find((c) => c.mrzValid && c.no);
  if (valid) {
    return { passportNo: valid.no, source: 'mrz-valid', mrzValid: true, needsReview: false };
  }
  if (!candidates.length) {
    return { passportNo: '', source: 'none', mrzValid: false, needsReview: true };
  }
  const freq = {};
  candidates.forEach((c) => { if (c.no) freq[c.no] = (freq[c.no] || 0) + 1; });
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const picked = sorted[0] || '';
  // 多源且一致(只有一个不同值)→ 较可信;否则转人工
  const agreed = sorted.length === 1 && candidates.length >= 2;
  return {
    passportNo: picked,
    source: agreed ? 'consensus' : 'unverified',
    mrzValid: false,
    needsReview: !agreed, // 无校验通过且未达共识 → 人工确认
  };
}

// 便捷:直接从文档数组得到最终护照号决策
function resolveCustomerPassport(documents = []) {
  return pickPassportNo(collectPassportCandidates(documents));
}

module.exports = { collectPassportCandidates, pickPassportNo, resolveCustomerPassport };
