'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { detectLedgerConsistency } = require('../../services/monthly/ledger_consistency');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-02';

function makeCtx() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
           VALUES ('${WS}', 2026, 2, 'open', 't', 't')`);
  const dr = createDailyReceiptRepository({ db });
  return { db, dr };
}

let seq = 0;
const row = (o) => ({
  workspaceKey: WS, receiptNo: o.receiptNo, name: o.name, passportNo: o.passportNo,
  tourNo: 'T1', agent: 'A', modeRaw: '乐天SG-本司', shop: '乐天首尔',
  purchaseDate: '2026-02-10', rowHash: `d${seq++}`, importedAt: 't',
});

test('同护照多名 + 同名多护照 → 写进 conflict_fields,出现在账单核对', () => {
  const { dr } = makeCtx();
  dr.insertMany([
    // 同一护照 P1,两个姓名(一护照几姓名)
    row({ receiptNo: 'R1', name: 'ZHANG SAN', passportNo: 'P1' }),
    row({ receiptNo: 'R2', name: 'ZHANG SHAN', passportNo: 'P1' }),
    // 同一姓名 LI SI,两个护照(一姓名两护照)
    row({ receiptNo: 'R3', name: 'LI SI', passportNo: 'P2' }),
    row({ receiptNo: 'R4', name: 'LI SI', passportNo: 'P3' }),
    // 干净的:不应被标
    row({ receiptNo: 'R5', name: 'WANG WU', passportNo: 'P4' }),
  ]);

  const res = detectLedgerConsistency({ dailyReceiptRepo: dr }).run({ workspaceKey: WS });
  assert.equal(res.nameConflictRows, 2, 'R1/R2 各标一条姓名存疑');
  assert.equal(res.passportConflictRows, 2, 'R3/R4 各标一条护照存疑');

  // 这 4 行都该出现在账单核对(conflict_fields 非空),干净的 R5 不出现
  const conflicts = dr.listBillReviewConflicts({ workspaceKey: WS });
  const receiptNos = conflicts.map((r) => r.receiptNo).sort();
  assert.deepEqual(receiptNos, ['R1', 'R2', 'R3', 'R4']);

  // R1 的标记:field=name,kind=consistency,billValue 含另一个姓名
  const r1 = conflicts.find((r) => r.receiptNo === 'R1');
  const m = (r1.conflictFields || []).find((c) => c.kind === 'consistency');
  assert.ok(m, 'R1 有 consistency 标记');
  assert.equal(m.field, 'name');
  assert.equal(m.billValue, null, '一致性冲突无账单侧单值');
  assert.match(m.note, /ZHANG SHAN/);

  // R3 的标记:field=passportNo
  const r3 = conflicts.find((r) => r.receiptNo === 'R3');
  const m3 = (r3.conflictFields || []).find((c) => c.kind === 'consistency');
  assert.equal(m3.field, 'passportNo');
  assert.match(m3.note, /P3/);
});

test('幂等:重复跑不叠加;修正后冲突消失', () => {
  const { dr } = makeCtx();
  dr.insertMany([
    row({ receiptNo: 'R1', name: 'ZHANG SAN', passportNo: 'P1' }),
    row({ receiptNo: 'R2', name: 'ZHANG SHAN', passportNo: 'P1' }),
  ]);
  const svc = detectLedgerConsistency({ dailyReceiptRepo: dr });
  svc.run({ workspaceKey: WS });
  svc.run({ workspaceKey: WS }); // 第二次
  const after2 = dr.listBillReviewConflicts({ workspaceKey: WS });
  const r1 = after2.find((r) => r.receiptNo === 'R1');
  // 不叠加:仍只有 1 条 consistency 标记
  assert.equal((r1.conflictFields || []).filter((c) => c.kind === 'consistency').length, 1);

  // 把 R2 姓名改成和 R1 一致(修正)→ 再跑 → 冲突消失
  const r2id = after2.find((r) => r.receiptNo === 'R2').id;
  dr.applyFieldUpdates({ id: r2id, workspaceKey: WS, updates: { name: 'ZHANG SAN' } });
  svc.run({ workspaceKey: WS });
  assert.equal(dr.listBillReviewConflicts({ workspaceKey: WS }).length, 0, '修正后无冲突');
});
