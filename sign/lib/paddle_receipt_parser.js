const {
  extractPassportLikeTokens,
  normalizeSpaces,
  sortLines,
} = require('./paddle_passport_parser');
const { detectReceiptStoreFamily } = require('./receipt_store_family');

function firstMatch(text, expressions) {
  for (const expression of expressions) {
    const match = String(text || '').match(expression);
    if (match) {
      return match[1] || match[0];
    }
  }
  return '';
}

function cleanAmount(value) {
  const normalized = String(value || '').replace(/[^0-9.,]/g, '').replace(/,/g, '');
  if (!normalized) {
    return '';
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : normalized;
}

function normalizeAlphaNumUpper(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeReceiptCompact(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z:./-]/g, '');
}

function pad2(value) {
  return String(value || '').padStart(2, '0');
}

function isValidMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function formatDateParts(year, month, day, hour = '', minute = '', includeTime = false) {
  const date = `${String(year)}-${pad2(month)}-${pad2(day)}`;
  if (!includeTime || hour === '' || minute === '') {
    return date;
  }
  return `${date} ${pad2(hour)}:${pad2(minute)}`;
}

function extractNormalizedDateTime(value, options = {}) {
  const includeTime = options.includeTime !== false;
  const compact = normalizeReceiptCompact(value);
  if (!compact) {
    return '';
  }

  const patterns = [
    /([12]\d{3})[./-](\d{1,2})[./-](\d{1,2})(?:([0-2]?\d):?([0-5]\d))?/,
    /([12]\d{3})[./-](\d{2})(\d{2})(?:([0-2]?\d):?([0-5]\d))?/,
    /(\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:([0-2]?\d):?([0-5]\d))?/,
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) {
      continue;
    }

    let year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] === undefined ? '' : Number(match[4]);
    const minute = match[5] === undefined ? '' : Number(match[5]);

    if (match[1].length === 2) {
      year += 2000;
    }
    if (!isValidMonthDay(month, day)) {
      continue;
    }

    const hasValidTime = hour !== '' && minute !== '' && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    return formatDateParts(year, month, day, hour, minute, includeTime && hasValidTime);
  }

  return '';
}

function isSaleLabel(value) {
  const compact = normalizeAlphaNumUpper(value);
  return compact.includes('SALEDATE') || compact.includes('SALEDT') || compact.includes('DATEOFSALE') || compact.includes('DATETIME');
}

function isDepartureLabel(value) {
  const compact = normalizeAlphaNumUpper(value);
  return compact.includes('DATEOFDEPART')
    || compact.includes('DATEOFDEBART')
    || compact.includes('DATEOFDEPARTUC')
    || compact.includes('DEPARTURE')
    || compact.includes('DEBARTURE')
    || compact.includes('DEPARTUCE')
    || compact.includes('OUTDATE')
    || compact.includes('LEAVEDATE');
}

function isGroupLabel(value) {
  const compact = normalizeAlphaNumUpper(value);
  return compact === 'G'
    || compact === 'GROUP'
    || compact === 'GROUPNO'
    || compact === 'GROUPNUMBER'
    || compact === 'TOUR'
    || compact === 'TOURNO'
    || compact === 'GNO';
}

function extractLabelledDate(lines, labelMatcher, options = {}) {
  for (let index = 0; index < lines.length; index += 1) {
    const text = normalizeSpaces(lines[index].text);
    const sameLineValue = labelMatcher(text) ? extractNormalizedDateTime(text, options) : '';
    if (sameLineValue) {
      return sameLineValue;
    }
    if (!labelMatcher(text)) {
      continue;
    }

    for (let offset = 1; offset <= 2; offset += 1) {
      const nextLine = lines[index + offset];
      if (!nextLine) {
        break;
      }
      const nextValue = extractNormalizedDateTime(nextLine.text, options);
      if (nextValue) {
        return nextValue;
      }
    }
  }

  return '';
}

function extractStoreFallback(lines) {
  const upperLines = lines
    .map((line) => normalizeSpaces(line.text).toUpperCase())
    .filter(Boolean)
    .slice(0, 8);

  return upperLines[0] || '';
}

function extractStoreInfo(lines, joinedText) {
  const family = detectReceiptStoreFamily({ lines, joinedText });
  return {
    storeFamilyKey: family.key || '',
    storeFamily: family.displayName || '',
    storeName: family.displayName || extractStoreFallback(lines),
  };
}

function normalizeReceiptNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\*/g, '')
    .replace(/^[^0-9A-Z]+/, '')
    .replace(/[^0-9A-Z-]+$/, '')
    .replace(/[^0-9-]/g, '');
}

function isLikelyReceiptNumber(value) {
  const normalized = normalizeReceiptNumber(value);
  const digits = normalized.replace(/[^0-9]/g, '');
  if (!normalized || digits.length < 10) {
    return false;
  }
  if (/^20\d{6,10}$/.test(digits)) {
    return false;
  }
  if (/^[12]\d{3}[./-]\d{1,2}[./-]\d{1,2}/.test(normalized)) {
    return false;
  }
  return /^[0-9-]+$/.test(normalized);
}

function extractReceiptNumber(lines, joinedText, storeFamilyKey = '') {
  const candidates = [];
  const familyExpressions = {
    THE_SHILLA: [/\b(?:NO\.?\s*)?(03-\d{3}-\d{3}-\d{4}-\d)\b/i, /\b(03\d{10,})\b/],
    SHILLA_IPARK: [/\b(?:NO\.?\s*)?(21-\d{3}-\d{3}-\d{4}-\d)\b/i, /\b(21\d{10,})\b/],
    LOTTE: [/\b(\d{6}-\d{2}-\d{6})\b/i, /\b(\d{14,})\b/],
  };
  const addCandidate = (value, score) => {
    const normalized = normalizeReceiptNumber(value);
    if (isLikelyReceiptNumber(normalized)) {
      candidates.push({ value: normalized, score });
    }
  };

  lines.forEach((line) => {
    const text = normalizeSpaces(line.text);
    const upperText = normalizeAlphaNumUpper(text);
    if (isSaleLabel(upperText) || isGroupLabel(upperText) || isDepartureLabel(upperText)) {
      return;
    }

    (familyExpressions[storeFamilyKey] || []).forEach((expression) => {
      addCandidate(firstMatch(text, [expression]), 70);
    });
    addCandidate(firstMatch(text, [/\b(?:NO|REF\.?\s*NO|RECEIPT\s*NO|APPROVAL\s*NO)\b[^0-9]*([0-9-]{8,})/i]), 60);
    addCandidate(firstMatch(text, [/\*([0-9-]{10,})\*/]), 50);
    addCandidate(firstMatch(text, [/\b([0-9]{6,}-\d{2}-\d{5,})\b/]), 45);
    if (isLikelyReceiptNumber(text)) {
      addCandidate(text, text.includes('-') ? 40 : 32);
    }
  });

  (familyExpressions[storeFamilyKey] || []).forEach((expression) => {
    addCandidate(firstMatch(joinedText, [expression]), 55);
  });
  addCandidate(firstMatch(joinedText, [/\b(?:NO|REF\.?\s*NO|RECEIPT\s*NO|APPROVAL\s*NO)\b[^0-9]*([0-9-]{8,})/i]), 35);
  addCandidate(firstMatch(joinedText, [/\*([0-9-]{10,})\*/]), 30);

  return candidates
    .sort((left, right) => right.score - left.score || right.value.length - left.value.length)
    [0]?.value || '';
}

function extractReceiptAmount(lines, joinedText) {
  const scored = [];
  const addCandidate = (value, score) => {
    const cleaned = cleanAmount(value);
    if (cleaned) {
      scored.push({ value: cleaned, score });
    }
  };

  lines.forEach((line) => {
    const text = normalizeSpaces(line.text);
    const explicit = firstMatch(text, [
      /\bTOTAL\b[^0-9]*([0-9][0-9,]*\.?[0-9]*)/i,
      /\bAMOUNT\b[^0-9]*([0-9][0-9,]*\.?[0-9]*)/i,
      /\bPRICE\b[^0-9]*([0-9][0-9,]*\.?[0-9]*)/i,
    ]);
    if (explicit) {
      addCandidate(explicit, /\bTOTAL\b/i.test(text) ? 40 : 30);
    }
  });

  addCandidate(firstMatch(joinedText, [/\bTOTAL\b[^0-9]*([0-9][0-9,]*\.?[0-9]*)/i]), 35);
  addCandidate(firstMatch(joinedText, [/\bAMOUNT\b[^0-9]*([0-9][0-9,]*\.?[0-9]*)/i]), 25);

  return scored.sort((left, right) => right.score - left.score || Number(right.value) - Number(left.value))[0]?.value || '';
}

function extractReceiptPassportNo(lines, joinedText) {
  const labelled = [];

  lines.forEach((line) => {
    const text = normalizeSpaces(line.text);
    if (/passport/i.test(text)) {
      extractPassportLikeTokens(text).forEach((token) => labelled.push(token));
    }
  });

  if (labelled.length) {
    return labelled[0];
  }

  if (/passport/i.test(joinedText)) {
    return extractPassportLikeTokens(joinedText)[0] || '';
  }

  return '';
}

function extractReceiptEnglishName(lines, joinedText) {
  const direct = [];

  lines.forEach((line) => {
    const text = normalizeSpaces(line.text);
    const candidate = firstMatch(text, [
      /\bNAME\b[^A-Z]*([A-Z][A-Z*\s'-]{2,})/i,
      /\bGUEST\b[^A-Z]*([A-Z][A-Z*\s'-]{2,})/i,
    ]);
    if (candidate) {
      direct.push(candidate.replace(/\s+/g, ' ').trim().toUpperCase());
    }
  });

  if (direct.length) {
    return direct[0];
  }

  return firstMatch(joinedText, [
    /\bNAME\b[^A-Z]*([A-Z][A-Z*\s'-]{2,})/i,
    /\bGUEST\b[^A-Z]*([A-Z][A-Z*\s'-]{2,})/i,
  ]).replace(/\s+/g, ' ').trim().toUpperCase();
}

function extractReceiptSaleDate(lines, _joinedText) {
  return extractLabelledDate(lines, isSaleLabel, { includeTime: true });
}

function extractGroupNo(lines, joinedText) {
  const candidates = [];
  const addCandidate = (value, score) => {
    const normalized = String(value || '').replace(/[^0-9]/g, '');
    if (/^\d{5,8}$/.test(normalized)) {
      candidates.push({ value: normalized, score });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const text = normalizeSpaces(lines[index].text);
    addCandidate(firstMatch(text, [/\b(?:GROUP|GROUP NO|GROUPNO|TOUR|TOUR NO|G)\b[^0-9]*([0-9]{5,8})/i]), 40);
    if (!isGroupLabel(text)) {
      continue;
    }
    for (let offset = 1; offset <= 2; offset += 1) {
      const nextLine = lines[index + offset];
      if (!nextLine) {
        break;
      }
      addCandidate(firstMatch(normalizeSpaces(nextLine.text), [/\b([0-9]{5,8})\b/]), 35 - offset);
    }
  }

  addCandidate(firstMatch(joinedText, [/\b(?:GROUP|GROUP NO|GROUPNO|TOUR|TOUR NO|G)\b[^0-9]*([0-9]{5,8})/i]), 20);

  return candidates
    .sort((left, right) => right.score - left.score || right.value.length - left.value.length)
    [0]?.value || '';
}

function extractDepartureDate(lines, _joinedText) {
  return extractLabelledDate(lines, isDepartureLabel, { includeTime: false });
}

function extractFlightNo(lines, joinedText) {
  const expressions = [/\b((?:MU|CZ|CA|KE|OZ|9C|JL|NH|FM|HO|LJ|7C)\d{3,4})\b/i];

  for (const line of lines) {
    const value = firstMatch(normalizeSpaces(line.text), expressions);
    if (value) {
      return value.toUpperCase();
    }
  }

  return String(firstMatch(joinedText, expressions) || '').toUpperCase();
}

function extractReceiptFieldsFromOcr(input = {}) {
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const lines = sortLines(rawLines);
  const joinedText = normalizeSpaces((input.joinedText || input.joined_text || '').replace(/\n+/g, ' '));
  const storeInfo = extractStoreInfo(lines, joinedText);
  const saleDate = extractReceiptSaleDate(lines, joinedText);

  return {
    englishName: extractReceiptEnglishName(lines, joinedText),
    passportNo: extractReceiptPassportNo(lines, joinedText),
    receiptNo: extractReceiptNumber(lines, joinedText, storeInfo.storeFamilyKey),
    groupNo: extractGroupNo(lines, joinedText),
    amount: extractReceiptAmount(lines, joinedText),
    storeName: storeInfo.storeName,
    storeFamily: storeInfo.storeFamily,
    saleDate,
    purchaseDate: saleDate,
    departureDate: extractDepartureDate(lines, joinedText),
    flightNo: extractFlightNo(lines, joinedText),
  };
}

module.exports = {
  cleanAmount,
  extractReceiptFieldsFromOcr,
};
