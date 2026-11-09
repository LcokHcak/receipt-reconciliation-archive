'use strict';

// 复核HIGH-1/MEDIUM-2(2026-07-16):重结算失败回滚走 _fetchFullById→insertMany 完整行往返。
// 此前 insertMany 列清单缺 conflict_fields/manual_locked_fields/mode_confirmed_at/mode_confirmed_by
// (迁移后加的列),mapRow 缺 rawPayload——回滚会静默丢手动锁/渠道确认戳。真 SQLite 集成测试锁死
// (此前全 mock 捕获不到 shape gap)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');

const WS = '2026-01';

test('往返:删前快照→insertMany 重插,手动锁/渠道确认/冲突标记/rawPayload 全保留', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-roundtrip-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  repo.insertMany([{
    workspaceKey: WS, receiptNo: 'R900', tourNo: 'T9', name: 'WANG WEI', passportNo: 'E9',
    shop: '乐天免税店', purchaseDate: '2026-01-10', modeFolder: '乐天首尔',
    tourMatchStatus: 'matched', billMatchStatus: 'unmatched',
    rowHash: 'rt-900', importedAt: 't', sourceType: 'workbench',
    sourceBatchId: 'batch_rt', sourceCustomerId: 'CL20260116-001',
  }]);
  const inserted = repo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === 'rt-900');
  assert.ok(inserted, '种子行应插入成功');

  // 给行打上"迁移后加的列"的真实值(手动锁/渠道确认/冲突标记/rawPayload)
  db.prepare(`UPDATE daily_receipt_export SET
      manual_locked_fields = ?, mode_confirmed_at = ?, mode_confirmed_by = ?,
      conflict_fields = ?, raw_payload = ?
    WHERE workspace_key = ? AND id = ?`).run(
    '["tourNo","receiptNo"]', '2026-01-15T00:00:00Z', 'op1',
    JSON.stringify([{ field: 'tourNo', dailyValue: 'a', billValue: 'b' }]),
    JSON.stringify({ srcRow: 42 }),
    WS, inserted.id,
  );

  // 快照 → 删 → 重插(restoreOldRows 同款链路)
  const snapshot = repo._fetchFullById({ workspaceKey: WS, id: inserted.id });
  assert.equal(snapshot.manualLockedFields, '["tourNo","receiptNo"]', '快照应含手动锁');
  assert.deepEqual(snapshot.rawPayload, { srcRow: 42 }, '快照应含 rawPayload(复核MEDIUM-2)');
  assert.equal(repo.deleteMany({ workspaceKey: WS, ids: [inserted.id] }), 1);

  const result = repo.insertMany([snapshot]);
  assert.equal(result.inserted, 1, '重插应成功');

  const restored = repo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === 'rt-900');
  const full = repo._fetchFullById({ workspaceKey: WS, id: restored.id });
  // 核心列
  assert.equal(full.receiptNo, 'R900');
  assert.equal(full.tourNo, 'T9');
  assert.equal(full.modeFolder, '乐天首尔');
  // 复核HIGH-1 的 4 列:此前静默丢,现在必须保留
  assert.equal(full.manualLockedFields, '["tourNo","receiptNo"]', '手动锁不得丢(复核HIGH-1)');
  assert.equal(full.modeConfirmedAt, '2026-01-15T00:00:00Z', '渠道确认戳不得丢');
  assert.equal(full.modeConfirmedBy, 'op1');
  assert.deepEqual(full.conflictFields, [{ field: 'tourNo', dailyValue: 'a', billValue: 'b' }], '冲突标记不得丢');
  assert.deepEqual(full.rawPayload, { srcRow: 42 }, 'rawPayload 不得丢(复核MEDIUM-2)');
});
