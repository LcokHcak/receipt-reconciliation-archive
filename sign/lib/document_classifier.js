const path = require('node:path');

const { DOC_TYPES } = require('./package_constants');

const CATEGORY_KEYWORDS = {
  [DOC_TYPES.PASSPORT]: [
    { pattern: /people'?s republic of china/i, weight: 6 },
    { pattern: /\bpassport\b/i, weight: 5 },
    { pattern: /\bpassport no\b/i, weight: 4 },
    { pattern: /\bnationality\b/i, weight: 3 },
    { pattern: /\bsurname\b/i, weight: 3 },
    { pattern: /\bgiven names?\b/i, weight: 3 },
    { pattern: /\bsex\b/i, weight: 2 },
    { pattern: /\bp<chn/i, weight: 6 },
    { pattern: /\bchn\b/i, weight: 2 },
    { pattern: /护照/, weight: 5 },
    { pattern: /护照号/, weight: 4 },
    { pattern: /姓名/, weight: 3 },
    { pattern: /国籍/, weight: 2 },
  ],
  [DOC_TYPES.RECEIPT]: [
    { pattern: /\blotte duty free\b/i, weight: 7 },
    { pattern: /\bthe shilla\b/i, weight: 7 },
    { pattern: /\btheshilla\b/i, weight: 7 },
    { pattern: /\bshilla ipark\b/i, weight: 8 },
    { pattern: /\bipark\b/i, weight: 6 },
    { pattern: /\bduty free\b/i, weight: 5 },
    { pattern: /\bshopping card\b/i, weight: 7 },
    { pattern: /\bgold pass\b/i, weight: 6 },
    { pattern: /\bspecial coupon\b/i, weight: 6 },
    { pattern: /\bbusiness registration\b/i, weight: 5 },
    { pattern: /\bunit-price\b/i, weight: 5 },
    { pattern: /\bqty\b/i, weight: 5 },
    { pattern: /\bprice\b/i, weight: 4 },
    { pattern: /\bclerk\b/i, weight: 4 },
    { pattern: /\bsaledt\b/i, weight: 5 },
    { pattern: /\bsale date\b/i, weight: 5 },
    { pattern: /\bdate of departure\b/i, weight: 6 },
    { pattern: /\bapproval no\b/i, weight: 5 },
    { pattern: /\bwechatpay\b/i, weight: 5 },
    { pattern: /\bitem description\b/i, weight: 4 },
    { pattern: /\bamount\b/i, weight: 3 },
    { pattern: /\btotal\b/i, weight: 3 },
    { pattern: /\bref\.?\s*no\b/i, weight: 3 },
    { pattern: /\bsku\b/i, weight: 3 },
    { pattern: /小票/, weight: 5 },
    { pattern: /付款金额/, weight: 4 },
    { pattern: /收款凭证/, weight: 4 },
    { pattern: /出境日期/, weight: 4 },
    { pattern: /团号/, weight: 3 },
  ],
};

const FILE_HINTS = {
  [DOC_TYPES.PASSPORT]: [
    { pattern: /passport/i, weight: 4 },
    { pattern: /护照/, weight: 4 },
  ],
  [DOC_TYPES.RECEIPT]: [
    { pattern: /receipt/i, weight: 4 },
    { pattern: /小票/, weight: 4 },
    { pattern: /账单/, weight: 3 },
    { pattern: /wechat/i, weight: 2 },
  ],
};

const OTHER_SIGNALS = [
  { pattern: /\bboarding pass\b/i, weight: 7 },
  { pattern: /\bflight\b/i, weight: 4 },
  { pattern: /\bflight status\b/i, weight: 5 },
  { pattern: /\bgate\b/i, weight: 4 },
  { pattern: /\bseat\b/i, weight: 4 },
  { pattern: /\bterminal\b/i, weight: 4 },
  { pattern: /\bboarding time\b/i, weight: 5 },
  { pattern: /\bcheck[- ]?in\b/i, weight: 5 },
  { pattern: /\bitinerary\b/i, weight: 5 },
  { pattern: /\border details\b/i, weight: 4 },
  { pattern: /\bairport\b/i, weight: 4 },
  { pattern: /\bairline\b/i, weight: 4 },
  { pattern: /\bfrom [a-z]{3} to [a-z]{3}\b/i, weight: 5 },
  { pattern: /\b(?:mu|cz|ca|ke|oz|9c|jl|nh|fm|ho|lj|7c)\d{3,4}\b/i, weight: 5 },
  { pattern: /机票/, weight: 5 },
  { pattern: /登机牌/, weight: 6 },
];

const OTHER_FILE_HINTS = [
  { pattern: /ticket/i, weight: 4 },
  { pattern: /boarding/i, weight: 4 },
  { pattern: /机票/, weight: 4 },
];

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function applyPatterns(input, patterns) {
  return patterns.reduce((total, rule) => (rule.pattern.test(input) ? total + rule.weight : total), 0);
}

function scoreDocumentText(ocrText = '', fileName = '') {
  const normalizedText = normalizeText(ocrText);
  const normalizedFileName = normalizeText(path.basename(fileName || ''));

  let passport = applyPatterns(normalizedText, CATEGORY_KEYWORDS[DOC_TYPES.PASSPORT]) +
    applyPatterns(normalizedFileName, FILE_HINTS[DOC_TYPES.PASSPORT]);

  let receipt = applyPatterns(normalizedText, CATEGORY_KEYWORDS[DOC_TYPES.RECEIPT]) +
    applyPatterns(normalizedFileName, FILE_HINTS[DOC_TYPES.RECEIPT]);

  let other = normalizedText ? 1 : 0;
  other += applyPatterns(normalizedText, OTHER_SIGNALS);
  other += applyPatterns(normalizedFileName, OTHER_FILE_HINTS);

  const timeMatches = normalizedText.match(/\b\d{1,2}:\d{2}\b/g) || [];
  const flightMatches = normalizedText.match(/\b(?:mu|cz|ca|ke|oz|9c|jl|nh|fm|ho|lj|7c)\d{3,4}\b/g) || [];
  const airportMentions = (normalizedText.match(/\bairport\b/g) || []).length;

  if (timeMatches.length >= 2) {
    other += 3;
  }
  if (flightMatches.length >= 1) {
    other += 3;
  }
  if (airportMentions >= 1) {
    other += 2;
  }

  const retailSignal = /duty free|shopping card|gold pass|special coupon|business registration|approval|wechatpay|unit-price|qty|item description|ceo boojin lee|clerk/i.test(
    normalizedText
  );

  if (retailSignal) {
    receipt += 8;
    passport = Math.max(0, passport - 6);
    other = Math.max(0, other - 7);
  }

  return { passport, receipt, other };
}

function classifyDocument({ fileName = '', ocrText = '' } = {}) {
  const scores = scoreDocumentText(ocrText, fileName);
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestType, bestScore] = ranked[0];
  const [, secondScore = 0] = ranked[1] || [];
  const reviewReasons = [];

  let docType = bestType;
  let needsReview = false;

  if (bestScore < 3) {
    docType = DOC_TYPES.OTHER;
    needsReview = true;
    reviewReasons.push('weak_signal');
  }

  if (bestScore - secondScore <= 1) {
    needsReview = true;
    reviewReasons.push('ambiguous_scores');
  }

  const mixedPassportReceipt =
    scores.passport >= 8 &&
    scores.receipt >= 8;
  if (mixedPassportReceipt) {
    needsReview = true;
    reviewReasons.push('mixed_passport_receipt');
  }

  const confidence = bestScore <= 0 ? 0 : Number((bestScore / Math.max(bestScore + secondScore, 1)).toFixed(3));

  return {
    docType,
    confidence,
    scores,
    needsReview,
    reviewReasons,
  };
}

module.exports = {
  classifyDocument,
  normalizeText,
  scoreDocumentText,
};
