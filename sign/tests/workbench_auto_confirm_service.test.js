'use strict';

/**
 * workbench_auto_confirm_service — 组级自动确认边界测试
 *
 * 红线:零假阳性。组级双命中(团号∈表 ∧ 小票号∈账单)+ 账单反验护照号。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkbenchAutoConfirmService } = require('../services/workbench_auto_confirm_service');

function fakeProbe({ tours = [], bills = {} } = {}) {
  const tourSet = new Set(tours.map((t) => String(t).trim()));
  const billMap = new Map(Object.entries(bills));
  return {
    monthOf: (d) => {
      const m = /^(\d{4})-(\d{2})/.exec(String(d || ''));
      return m ? `${m[1]}-${m[2]}` : '';
    },
    tourInTable: (t) => tourSet.has(String(t == null ? '' : t).trim()),
    billLookup: (rno) => billMap.get(String(rno == null ? '' : rno).trim()) || null,
  };
}

function validGroup(overrides = {}) {
  return {
    groupKey: 'g1',
    tasks: [
      {
        id: 't-pass', docTypeFinal: 'passport', docTypeConfidence: 0.95, machineState: 'completed',
        classificationConfirmed: true, extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EA1234567',
        chineseNameFinal: '张三', tourNo: '12345678', departureDate: '2026-01-15', reviewed: false,
      },
      {
        id: 't-r1', docTypeFinal: 'receipt', docTypeConfidence: 0.95, machineState: 'completed',
        classificationConfirmed: true, receiptStoreFinal: 'LOTTE', receiptNoFinal: '12345678901234',
        groupNoFinal: '12345678', purchaseDateFinal: '2026-01-10', departureDateFinal: '2026-01-15', reviewed: false,
      },
    ],
    ...overrides,
  };
}

const okProbe = fakeProbe({
  tours: ['12345678'],
  bills: { 12345678901234: { passportNo: 'EA1234567', name: 'ZHANG SAN', tourNo: '12345678' } },
});

function makeService(probe, { groups = [validGroup()], approveImpl } = {}) {
  const approved = [];
  const approveGroup = approveImpl || (async ({ groupKey }) => { approved.push(groupKey); });
  const svc = createWorkbenchAutoConfirmService({
    loadBatchGroups: async () => groups,
    approveGroup,
    probe,
  });
  return { svc, approved };
}

test('双命中 + 护照号对账单 → ok=true', () => {
  const { svc } = makeService(okProbe);
  const d = svc.evaluateGroup(validGroup());
  assert.equal(d.ok, true, JSON.stringify(d.blockedBy));
});

test('autoConfirmBatch:命中组复用 approveGroup 入账', async () => {
  const { svc, approved } = makeService(okProbe);
  const r = await svc.autoConfirmBatch({ batchId: 'b1' });
  assert.equal(r.confirmed, 1);
  assert.equal(r.scanned, 1);
  assert.deepEqual(approved, ['g1']);
});

test('小票号不在账单 → 拦截 receipt_not_in_bill', () => {
  const probe = fakeProbe({ tours: ['12345678'], bills: {} });
  const { svc } = makeService(probe);
  const d = svc.evaluateGroup(validGroup());
  assert.equal(d.ok, false);
  assert.ok(d.blockedBy.some((b) => b.includes('receipt_not_in_bill')), JSON.stringify(d.blockedBy));
});

test('团号不在团号表 → 拦截 group_code_not_in_table', () => {
  const probe = fakeProbe({ tours: [], bills: { 12345678901234: { passportNo: 'EA1234567' } } });
  const { svc } = makeService(probe);
  const d = svc.evaluateGroup(validGroup());
  assert.equal(d.ok, false);
  assert.ok(d.blockedBy.some((b) => b.includes('group_code_not_in_table')));
});

test('护照号与账单不一致 → 拦截 passport_no_mismatch_bill', () => {
  const probe = fakeProbe({
    tours: ['12345678'],
    bills: { 12345678901234: { passportNo: 'XX9999999' } }, // 账单权威护照号不同
  });
  const { svc } = makeService(probe);
  const d = svc.evaluateGroup(validGroup());
  assert.equal(d.ok, false);
  assert.ok(d.blockedBy.includes('passport_no_mismatch_bill'), JSON.stringify(d.blockedBy));
});

test('单张小票读错号(不在账单)→ 整组不放行', () => {
  const g = validGroup();
  g.tasks.push({
    id: 't-r2', docTypeFinal: 'receipt', docTypeConfidence: 0.95, machineState: 'completed',
    classificationConfirmed: true, receiptStoreFinal: 'LOTTE', receiptNoFinal: '99999999999999',
    groupNoFinal: '12345678', purchaseDateFinal: '2026-01-10', departureDateFinal: '2026-01-15', reviewed: false,
  });
  const { svc } = makeService(okProbe, { groups: [g] });
  const d = svc.evaluateGroup(g);
  assert.equal(d.ok, false);
  assert.ok(d.blockedBy.some((b) => b.includes('t-r2') && b.includes('receipt_not_in_bill')));
});

test('无小票组 → no_receipt', () => {
  const g = { groupKey: 'g2', tasks: [{ id: 'p', docTypeFinal: 'passport', passportNoFinal: 'EA1234567' }] };
  const { svc } = makeService(okProbe, { groups: [g] });
  assert.deepEqual(svc.evaluateGroup(g).blockedBy, ['no_receipt']);
});

test('两本护照组 → passport_count_not_1', () => {
  const g = validGroup();
  g.tasks.push({ id: 'p2', docTypeFinal: 'passport', passportNoFinal: 'EB7654321' });
  const { svc } = makeService(okProbe, { groups: [g] });
  assert.ok(svc.evaluateGroup(g).blockedBy.includes('passport_count_not_1'));
});

test('已审过的组不再扫', async () => {
  const g = validGroup();
  g.tasks.forEach((t) => { t.reviewed = true; });
  const { svc, approved } = makeService(okProbe, { groups: [g] });
  const r = await svc.autoConfirmBatch({ batchId: 'b1' });
  assert.equal(r.scanned, 0);
  assert.equal(r.confirmed, 0);
  assert.deepEqual(approved, []);
});

test('approveGroup 抛错 → 计入 skipped(approve_failed),不崩', async () => {
  const approveImpl = async () => { const e = new Error('boom'); e.code = 'X'; throw e; };
  const { svc } = makeService(okProbe, { approveImpl });
  const r = await svc.autoConfirmBatch({ batchId: 'b1' });
  assert.equal(r.confirmed, 0);
  assert.equal(r.skipped, 1);
  assert.ok(r.skips[0].blockedBy[0].includes('approve_failed'));
});

test('缺 batchId → 抛 BATCH_ID_REQUIRED', async () => {
  const { svc } = makeService(okProbe);
  await assert.rejects(() => svc.autoConfirmBatch({}), (e) => e.code === 'BATCH_ID_REQUIRED');
});
