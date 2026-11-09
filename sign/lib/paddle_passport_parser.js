const { normalizePassportEnglishName } = require('./workbench_field_normalizer');

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMrz(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9<]/g, '');
}

function cleanEnglishName(value) {
  return normalizePassportEnglishName(
    String(value || '')
      .toUpperCase()
      .replace(/</g, ' ')
      .replace(/[^A-Z\s'-]/g, ' ')
  );
}

function normalizeAlnum(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractPassportLikeTokens(value) {
  return normalizeAlnum(value).match(/[A-Z]{1,2}\d{7,8}/g) || [];
}

function hasPassportContext(value) {
  return /(passport|document|护照|证件)/i.test(String(value || ''));
}

function looksLikeEnglishNameLine(value) {
  const tokens = cleanEnglishName(String(value || '').replace(/,/g, ' ')).split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) {
    return false;
  }
  if (tokens.some((token) => token === 'CHN' || token === 'PRC' || token.length === 1 || token.length > 12)) {
    return false;
  }
  return true;
}

function hasCjk(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

function extractCandidateAfterLabel(text, labels) {
  const source = String(text || '');
  const lowered = source.toLowerCase();
  for (const label of labels) {
    const position = lowered.indexOf(String(label).toLowerCase());
    if (position >= 0) {
      return normalizeSpaces(source.slice(position + String(label).length).replace(/^[\s:：-]+/, ''));
    }
  }
  return '';
}

function sortLines(lines = []) {
  return [...lines].sort((left, right) => {
    const leftBox = left?.box || {};
    const rightBox = right?.box || {};
    return (
      Math.round(Number(leftBox.top || 0) / 10) - Math.round(Number(rightBox.top || 0) / 10)
      || Number(leftBox.left || 0) - Number(rightBox.left || 0)
    );
  });
}

function parseMrz(lines) {
  const line1Candidates = [];
  const line2Candidates = [];

  for (const line of lines) {
    const text = normalizeSpaces(line.text);
    const normalized = normalizeMrz(text);
    const compact = normalizeAlnum(text);

    if (normalized.startsWith('P<') && normalized.length >= 20) {
      line1Candidates.push(normalized);
    }

    let score = 0;
    if (/^[A-Z]{1,2}\d{7,8}/.test(compact)) {
      score += 30;
    }
    if (compact.includes('CHN')) {
      score += 15;
    }
    if (normalized.length >= 20) {
      score += 10;
    }
    if (normalized.includes('<')) {
      score += 5;
    }
    if (score > 0 && (
      /^[A-Z]{1,2}\d{7,8}/.test(compact)
      || normalized.length >= 20
      || normalized.includes('<')
    )) {
      line2Candidates.push({ score, normalized, compact });
    }
  }

  const line1 = line1Candidates[0] || '';
  const bestLine2 = [...line2Candidates].sort((left, right) => (
    right.score - left.score
    || right.compact.length - left.compact.length
    || left.compact.localeCompare(right.compact)
  ))[0];
  const line2 = bestLine2 ? (bestLine2.normalized || bestLine2.compact) : '';

  let englishName = '';
  let passportNo = '';

  if (line1.startsWith('P<') && line1.length > 5) {
    const namePart = line1.slice(5);
    if (namePart.includes('<<')) {
      const [surname, given] = namePart.split('<<', 2);
      englishName = cleanEnglishName(`${surname} ${String(given || '').replace(/</g, ' ')}`);
    }
  }

  if (line2) {
    const candidateNo = normalizeSpaces(line2.slice(0, 9).replace(/</g, ''));
    passportNo = /^[A-Z]{1,2}\d{7,8}$/.test(candidateNo) ? candidateNo : '';
  }

  return {
    englishName,
    passportNo,
  };
}

function extractPassportNumber(lines, mrzResult) {
  const labelPatterns = ['passport no', 'passport number', 'document no', '护照号', '护照号码', '号码'];
  const candidates = [];

  lines.forEach((line, index) => {
    const text = normalizeSpaces(line.text);
    const inline = extractCandidateAfterLabel(text, labelPatterns);
    const previousText = index > 0 ? normalizeSpaces(lines[index - 1].text) : '';
    const nextText = index + 1 < lines.length ? normalizeSpaces(lines[index + 1].text) : '';
    const targets = [];

    if (inline) {
      targets.push({ text: inline, score: 35 });
    }
    if (hasPassportContext(text)) {
      targets.push({ text, score: 25 });
    }
    if (hasPassportContext(previousText)) {
      targets.push({ text, score: 22 });
    }
    if (hasPassportContext(nextText)) {
      targets.push({ text, score: 18 });
    }
    targets.push({ text, score: 10 });

    targets.forEach(({ text: candidateText, score: baseScore }) => {
      const normalized = normalizeAlnum(candidateText);
      extractPassportLikeTokens(candidateText).forEach((token) => {
        let score = baseScore;
        if (/^[A-Z]{1,2}\d{7,8}$/.test(token)) {
          score += 10;
        }
        if (normalized.length === 9) {
          score += 8;
        }
        if (normalized.includes('CHN')) {
          score += 6;
        }
        candidates.push({ token, score });
      });
    });
  });

  if (mrzResult.passportNo) {
    candidates.push({ token: mrzResult.passportNo, score: 60 });
  }

  return [...candidates].sort((left, right) => (
    right.score - left.score || left.token.localeCompare(right.token)
  ))[0]?.token || '';
}

function extractChineseName(lines) {
  const candidates = [];

  lines.forEach((line, index) => {
    const text = normalizeSpaces(line.text);
    if (!text) {
      return;
    }

    const inline = extractCandidateAfterLabel(text, ['姓名', '中文名']);
    if (inline && hasCjk(inline)) {
      const value = inline.replace(/[^\u4e00-\u9fff]/g, '');
      if (value.length >= 2 && value.length <= 8) {
        candidates.push({ value, score: 50 });
      }
    }

    const pure = text.replace(/[^\u4e00-\u9fff]/g, '');
    if (!pure || pure.length < 2 || pure.length > 4) {
      return;
    }
    if (/^(中华人民共和国|护照|姓名|中文名|国籍|性别|出生日期|签发日期|有效期至|出生地|签发地|签发机关)$/.test(pure)) {
      return;
    }

    let score = 10;
    if (/(姓名|中文名)/.test(text)) {
      score += 30;
    }
    if (index > 0 && /(姓名|中文名)/.test(lines[index - 1].text || '')) {
      score += 15;
    }
    if (!text.includes('/')) {
      score += 12;
    }

    const previousText = index > 0 ? String(lines[index - 1].text || '') : '';
    const nextText = index + 1 < lines.length ? String(lines[index + 1].text || '') : '';
    if (extractPassportLikeTokens(previousText).length || extractPassportLikeTokens(nextText).length) {
      score += 15;
    }
    if ((previousText.includes(',') && looksLikeEnglishNameLine(previousText))
      || (nextText.includes(',') && looksLikeEnglishNameLine(nextText))) {
      score += 18;
    }

    lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).forEach((nearby) => {
      const nearbyText = String(nearby.text || '');
      if (hasPassportContext(nearbyText) || extractPassportLikeTokens(nearbyText).length || nearbyText.toUpperCase().includes('CHN')) {
        score += 6;
      }
      if (nearbyText.includes(',') && looksLikeEnglishNameLine(nearbyText)) {
        score += 10;
      } else if (looksLikeEnglishNameLine(nearbyText)) {
        score += 6;
      }
    });

    candidates.push({ value: pure, score });
  });

  return [...candidates].sort((left, right) => (
    right.score - left.score || left.value.localeCompare(right.value)
  ))[0]?.value || '';
}

function extractEnglishName(lines, mrzResult) {
  let surname = '';
  let given = '';
  const candidates = [];
  const labelKeywords = ['姓名', '中文名', 'name', 'surname', 'given', 'given names'];
  const noiseKeywords = ['passport', 'signature', 'authority', 'republic', 'country', 'nationality', 'date', 'birth', 'issue', 'expiry', 'bearer'];

  lines.forEach((line, index) => {
    const text = normalizeSpaces(line.text);
    const lowered = text.toLowerCase();
    const inlineSurname = extractCandidateAfterLabel(text, ['surname']);
    const inlineGiven = extractCandidateAfterLabel(text, ['given names', 'given name']);

    if (inlineSurname) {
      surname = cleanEnglishName(inlineSurname) || surname;
    } else if (lowered.includes('surname') && index + 1 < lines.length) {
      surname = cleanEnglishName(lines[index + 1].text) || surname;
    }

    if (inlineGiven) {
      given = cleanEnglishName(inlineGiven) || given;
    } else if ((lowered.includes('given names') || lowered.includes('given name')) && index + 1 < lines.length) {
      given = cleanEnglishName(lines[index + 1].text) || given;
    }

    if (/(姓名|中文名|name)/i.test(text) && index + 1 < lines.length) {
      const nextText = String(lines[index + 1].text || '');
      const cleanedNext = cleanEnglishName(nextText);
      if (cleanedNext && !hasCjk(nextText) && looksLikeEnglishNameLine(nextText)) {
        candidates.push({ value: cleanedNext, score: 30 });
      }
    }
    if (/(姓名|中文名|name)/i.test(text) && index + 2 < lines.length) {
      const nextText = String(lines[index + 2].text || '');
      const cleanedNext = cleanEnglishName(nextText);
      if (cleanedNext && !hasCjk(nextText) && looksLikeEnglishNameLine(nextText)) {
        candidates.push({ value: cleanedNext, score: 22 });
      }
    }

    const cleaned = cleanEnglishName(text);
    const tokens = cleaned.split(' ').filter(Boolean);
    if (cleaned && looksLikeEnglishNameLine(text)) {
      let score = 0;
      if (text === text.toUpperCase()) {
        score += 10;
      }
      if (/surname|given/i.test(text)) {
        score += 12;
      }
      if (labelKeywords.some((keyword) => lowered.includes(keyword))) {
        score -= 8;
      }
      if (noiseKeywords.some((keyword) => lowered.includes(keyword))) {
        score -= 20;
      }
      if (tokens.some((token) => token === 'CHN' || token === 'PRC')) {
        score -= 15;
      }
      if (/\d/.test(cleaned)) {
        score -= 15;
      }
      if (score > 0) {
        candidates.push({ value: cleaned, score });
      }
    }
  });

  if (surname || given) {
    return normalizeSpaces(`${surname} ${given}`);
  }
  if (mrzResult.englishName) {
    return mrzResult.englishName;
  }

  return [...candidates].sort((left, right) => (
    right.score - left.score || left.value.localeCompare(right.value)
  ))[0]?.value || '';
}

function extractPassportFieldsFromOcr(input = {}) {
  const lines = sortLines(Array.isArray(input.lines) ? input.lines : []);
  const mrzResult = parseMrz(lines);

  return {
    englishName: extractEnglishName(lines, mrzResult),
    chineseName: extractChineseName(lines),
    passportNo: extractPassportNumber(lines, mrzResult),
    mrzEnglishName: mrzResult.englishName,
    mrzPassportNo: mrzResult.passportNo,
  };
}

module.exports = {
  cleanEnglishName,
  extractCandidateAfterLabel,
  extractPassportFieldsFromOcr,
  extractPassportLikeTokens,
  looksLikeEnglishNameLine,
  normalizeAlnum,
  normalizeMrz,
  normalizeSpaces,
  parseMrz,
  sortLines,
};
