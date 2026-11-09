/**
 * Input validation for task PATCH payloads.
 *
 * Keeps the write path honest: rejects XSS-looking payloads in enumerated
 * fields, clamps string fields to sensible sizes so the batch JSON does not
 * balloon, and normalizes date strings.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error, status }` on reject.
 */

const VALID_DOC_TYPES = new Set([
  'passport',
  'receipt',
  'ticket',
  'other',
  '', // empty string means "clear", allowed
]);

const VALID_SIGNATURE_STYLES = new Set([
  'regular',
  'cursive',
  'block',
  'auto',
  '',
]);

// Final-field string length caps. Chosen so typical OCR output fits with
// plenty of slack, but a rogue 5 MB paste is refused.
const STRING_FIELD_CAPS = {
  originalFileName: 512,
  extractedNameFinal: 200,
  passportNoFinal: 50,
  chineseNameFinal: 100,
  receiptStoreFinal: 200,
  receiptNoFinal: 50,
  groupNoFinal: 50,
  reviewNote: 2000,
  // 票级表态(两步流,2026-07-10)
  tourStancedBy: 50,
  modeManualPick: 200,
  modeManualPickTour: 50,
};

const VALID_TOUR_STANCES = new Set(['', 'matched', 'none']);

const DATE_FIELDS = ['purchaseDateFinal', 'departureDateFinal'];

// ISO-date-ish — accept YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD, or empty.
// Does not validate month/day ranges (28 vs 31) because partial OCR results
// may be valid business data that the reviewer corrects later.
const DATE_RE = /^\d{4}[-/]?\d{2}[-/]?\d{2}$|^$/;

function validateTaskPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be an object' };
  }

  if (body.docTypeFinal !== undefined) {
    const value = String(body.docTypeFinal ?? '');
    if (!VALID_DOC_TYPES.has(value)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid docTypeFinal: ${value.slice(0, 40)}`,
      };
    }
  }

  if (body.signatureStyle !== undefined) {
    const value = String(body.signatureStyle ?? '');
    if (!VALID_SIGNATURE_STYLES.has(value)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid signatureStyle: ${value.slice(0, 40)}`,
      };
    }
  }

  if (body.tourStance !== undefined && !VALID_TOUR_STANCES.has(String(body.tourStance ?? ''))) {
    return { ok: false, status: 400, error: `Invalid tourStance: ${String(body.tourStance).slice(0, 40)}` };
  }
  if (body.sActivityFlag !== undefined && typeof body.sActivityFlag !== 'boolean') {
    return { ok: false, status: 400, error: 'sActivityFlag must be a boolean' };
  }

  for (const [field, cap] of Object.entries(STRING_FIELD_CAPS)) {
    const value = body[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      return {
        ok: false,
        status: 400,
        error: `${field} must be a string`,
      };
    }
    if (value.length > cap) {
      return {
        ok: false,
        status: 400,
        error: `${field} exceeds ${cap} characters`,
      };
    }
  }

  for (const field of DATE_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (typeof value !== 'string' || !DATE_RE.test(value.trim())) {
      return {
        ok: false,
        status: 400,
        error: `${field} must be a date string (YYYY-MM-DD)`,
      };
    }
  }

  return { ok: true };
}

module.exports = {
  validateTaskPatch,
  VALID_DOC_TYPES,
  VALID_SIGNATURE_STYLES,
  STRING_FIELD_CAPS,
};
