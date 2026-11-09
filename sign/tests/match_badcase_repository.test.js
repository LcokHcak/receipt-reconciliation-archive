'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMatchBadcaseRepository, KIND, VERDICT } = require('../repositories/match_badcase_repository');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-badcase-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createMatchBadcaseRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
  return { db, repo };
}

test('match_badcase: insertMany + list by stage/kind/verdict', (t) => {
  const { repo } = setup(t);
  repo.insertMany([
    {
      workspaceKey: WS, stage: 'tour_match', kind: KIND.TOUR_NOT_FOUND,
      ruleVersion: '2026-05-11-baseline',
      sourceTable: 'daily_receipt_export', sourceId: 1, dailyReceiptId: 1,
      receiptNo: 'R100', tourNo: 'X999', purchaseDate: '2026-01-14',
      snapshot: { input: { tourNo: 'X999' }, decision: 'tour_not_found' },
      createdAt: '2026-01-15T00:00:00Z',
    },
    {
      workspaceKey: WS, stage: 'bill_match', kind: KIND.AMBIGUOUS_MATCH,
      ruleVersion: '2026-05-11-baseline',
      sourceTable: 'store_bill', sourceId: 7, storeBillId: 7,
      receiptNo: 'R200', tourNo: 'T1',
      snapshot: { candidates: [{ id: 10 }, { id: 11 }] },
      createdAt: '2026-01-15T00:00:01Z',
    },
    {
      workspaceKey: WS, stage: 'bill_match', kind: KIND.FIELD_CONFLICT,
      ruleVersion: '2026-05-11-baseline',
      snapshot: { conflicts: [{ field: 'tourNo' }] },
      createdAt: '2026-01-15T00:00:02Z',
    },
  ]);

  const all = repo.list({ workspaceKey: WS });
  assert.equal(all.length, 3);

  const tour = repo.list({ workspaceKey: WS, stage: 'tour_match' });
  assert.equal(tour.length, 1);
  assert.equal(tour[0].kind, KIND.TOUR_NOT_FOUND);
  assert.equal(tour[0].snapshot.decision, 'tour_not_found');

  const ambig = repo.list({ workspaceKey: WS, kind: KIND.AMBIGUOUS_MATCH });
  assert.equal(ambig.length, 1);
  assert.equal(ambig[0].snapshot.candidates.length, 2);

  assert.equal(repo.count({ workspaceKey: WS }), 3);
});

test('match_badcase: setVerdict updates note + verdict + reviewer', (t) => {
  const { repo } = setup(t);
  repo.insertMany([{
    workspaceKey: WS, stage: 'bill_match', kind: KIND.FUZZY_MATCH,
    snapshot: {}, createdAt: '2026-01-15T00:00:00Z',
  }]);
  const [row] = repo.list({ workspaceKey: WS });

  const changes = repo.setVerdict({
    id: row.id, workspaceKey: WS,
    userNote: '这条应该按 P2 匹配上',
    userVerdict: VERDICT.SHOULD_MATCH,
    reviewedBy: 'alice',
  });
  assert.equal(changes, 1);

  const after = repo.findById({ id: row.id, workspaceKey: WS });
  assert.equal(after.userNote, '这条应该按 P2 匹配上');
  assert.equal(after.userVerdict, VERDICT.SHOULD_MATCH);
  assert.equal(after.reviewedBy, 'alice');
  assert.ok(after.reviewedAt);
});

test('match_badcase: summary groups by stage+kind', (t) => {
  const { repo } = setup(t);
  repo.insertMany([
    { workspaceKey: WS, stage: 'tour_match', kind: KIND.TOUR_NOT_FOUND, snapshot: {}, createdAt: 't' },
    { workspaceKey: WS, stage: 'tour_match', kind: KIND.TOUR_NOT_FOUND, snapshot: {}, createdAt: 't' },
    { workspaceKey: WS, stage: 'bill_match', kind: KIND.UNMATCHED, snapshot: {}, createdAt: 't' },
  ]);
  const sum = repo.summary(WS);
  const map = Object.fromEntries(sum.map((r) => [`${r.stage}/${r.kind}`, r.n]));
  assert.equal(map['tour_match/tour_not_found'], 2);
  assert.equal(map['bill_match/unmatched'], 1);
});

test('match_badcase: filter by rule_version', (t) => {
  const { repo } = setup(t);
  repo.insertMany([
    { workspaceKey: WS, stage: 'bill_match', kind: KIND.UNMATCHED,
      ruleVersion: 'v1', snapshot: {}, createdAt: 't' },
    { workspaceKey: WS, stage: 'bill_match', kind: KIND.UNMATCHED,
      ruleVersion: 'v2', snapshot: {}, createdAt: 't' },
  ]);
  const v1 = repo.list({ workspaceKey: WS, ruleVersion: 'v1' });
  assert.equal(v1.length, 1);
  assert.equal(v1[0].ruleVersion, 'v1');
});
