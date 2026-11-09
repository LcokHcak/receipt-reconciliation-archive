const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('current documentation deliverables cover operation, field semantics, and release risks', () => {
  const docs = fs.readdirSync(path.join(projectRoot, 'docs'));
  const sopPath = docs.find((name) => name.startsWith('SOP-') && name.includes('2026-06'));
  const fieldsPath = docs.find((name) => name.startsWith('UI') && name.includes('2026-06'));
  const releaseRiskPath = docs.find((name) => name.includes('2026-06-08'));

  assert.ok(sopPath, 'current SOP document exists');
  assert.ok(fieldsPath, 'current UI field semantics document exists');
  assert.ok(releaseRiskPath, 'current release-risk checklist exists');

  const sop = read(path.join('docs', sopPath));
  const fields = read(path.join('docs', fieldsPath));
  const releaseRisks = read(path.join('docs', releaseRiskPath));
  const readme = read('README.md');
  const startHere = read('START_HERE.md');
  const memory = read('AGENT_SHARED_MEMORY.md');

  for (const keyword of [
    'admin',
    'reviewer',
    'finance',
    'OCR',
    'bill-match',
    'delivery',
    'merge_streaming_service',
  ]) {
    assert.match(sop, new RegExp(keyword));
  }

  for (const keyword of [
    'receiptStoreFinal',
    'tour_match_status',
    'matchedBillRows',
    'store_bill',
    'missing_receipt',
  ]) {
    assert.match(fields, new RegExp(keyword));
  }

  for (const keyword of [
    'ManualEntryView',
    'SIGN_AUTH_COOKIE_SECURE',
    'npm audit',
    '92.4%',
  ]) {
    assert.match(releaseRisks, new RegExp(keyword));
  }

  assert.match(readme, /AGENT_SHARED_MEMORY\.md/);
  assert.match(startHere, /AGENT_SHARED_MEMORY\.md/);
  assert.match(memory, /deploy_push/);
  assert.match(memory, /final_delivery_export_service/);
});
