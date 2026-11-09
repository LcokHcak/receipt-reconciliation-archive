'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroupingEngine } = require('../src/grouping/grouping-engine');

const engine = createGroupingEngine();

test('一个客户：护照+小票+行程 归为一组（护照号串组，航班号焊入行程）', () => {
  const records = [
    { id: 'p1', type: 'passport', passportNo: 'EM9314578', name: 'BAI FANGRUIYAN' },
    { id: 'r1', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572', name: 'BAI ***RUIYAN' },
    { id: 'f1', type: 'flight', flightNo: '9C8572' },
  ];
  const { clusters, unassigned } = engine.group(records);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].key, 'EM9314578');
  assert.deepEqual(clusters[0].recordIds.sort(), ['f1', 'p1', 'r1']);
  assert.equal(unassigned.length, 0);
});

test('两个客户按护照号分成两组，互不混入', () => {
  const records = [
    { id: 'a1', type: 'passport', passportNo: 'EM9314578', name: 'BAI FANGRUIYAN' },
    { id: 'a2', type: 'receipt', passportNo: 'EM9314578' },
    { id: 'b1', type: 'passport', passportNo: 'EK0053004', name: 'WANG XIAOTONG' },
    { id: 'b2', type: 'receipt', passportNo: 'EK0053004' },
  ];
  const { clusters } = engine.group(records);
  assert.equal(clusters.length, 2);
  const byKey = Object.fromEntries(clusters.map((c) => [c.key, c.recordIds.sort()]));
  assert.deepEqual(byKey['EM9314578'], ['a1', 'a2']);
  assert.deepEqual(byKey['EK0053004'], ['b1', 'b2']);
});

test('航班号是副键：多客户共享同一航班时，纯行程图歧义→留待人工', () => {
  const records = [
    { id: 'a1', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572' },
    { id: 'b1', type: 'receipt', passportNo: 'EK0053004', flightNo: '9C8572' },
    { id: 'f1', type: 'flight', flightNo: '9C8572' }, // 两簇都含此航班 → 歧义
  ];
  const { clusters, unassigned } = engine.group(records);
  assert.equal(clusters.length, 2);
  assert.deepEqual(unassigned, ['f1']);
});

test('重名不同护照：仅有姓名的记录不强行归并（避免错并）', () => {
  const records = [
    { id: 'a1', type: 'passport', passportNo: 'EQ28', name: 'CHEN XIU' },
    { id: 'b1', type: 'passport', passportNo: 'EK93', name: 'CHEN XIU' },
    { id: 'x1', type: 'receipt', name: 'CHEN XIU' }, // 两簇同名 → 歧义
  ];
  const { unassigned } = engine.group(records);
  assert.deepEqual(unassigned, ['x1']);
});

test('姓名唯一匹配时，无护照号的小票可归入', () => {
  const records = [
    { id: 'a1', type: 'passport', passportNo: 'EM9314578', name: 'BAI FANGRUIYAN' },
    { id: 'x1', type: 'receipt', name: 'BAI FANGRUIYAN' },
  ];
  const { clusters, unassigned } = engine.group(records);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].recordIds.sort(), ['a1', 'x1']);
  assert.equal(unassigned.length, 0);
});

test('什么键都没有的记录进 unassigned', () => {
  const records = [{ id: 'z1', type: 'other' }];
  const { clusters, unassigned } = engine.group(records);
  assert.equal(clusters.length, 0);
  assert.deepEqual(unassigned, ['z1']);
});

// —— 模糊匹配 / 格式校验（基于真实 OCR 失败样本）——

test('模糊匹配：0↔Q 类 OCR 误差(E01035708 vs EQ1035708)归为一组', () => {
  const records = [
    { id: 'p', type: 'passport', passportNo: 'EQ1035708', name: 'BAI YILAN', confidence: 0.95 },
    { id: 'r', type: 'receipt', passportNo: 'E01035708', flightNo: '9C7206', confidence: 0.9 },
  ];
  const fuzzy = createGroupingEngine({ fuzzy: true, maxDistance: 2, rejectInvalid: true });
  const { clusters } = fuzzy.group(records);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].recordIds.sort(), ['p', 'r']);
});

test('格式校验：航班图上的打码护照号(E68****25)当无号，改走航班桥接', () => {
  const records = [
    { id: 'p', type: 'passport', passportNo: 'EQ1035708', name: 'BAI YILAN', confidence: 0.95 },
    { id: 'r', type: 'receipt', passportNo: 'EQ1035708', flightNo: '9C7206', confidence: 0.9 },
    { id: 'f', type: 'flight', passportNo: 'E68****25', flightNo: '9C7206', confidence: 0.6 },
  ];
  const fuzzy = createGroupingEngine({ fuzzy: true, maxDistance: 2, rejectInvalid: true });
  const { clusters, unassigned } = fuzzy.group(records);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].recordIds.sort(), ['f', 'p', 'r']);
  assert.equal(unassigned.length, 0);
});

test('精度守护：两客户同航班(且OCR把航班号拍花)，纯航班图不错挂→留人工', () => {
  // CAO LEI(EH97) 与 BAI YILAN(EQ10) 同航班 9C7206；EH97 小票把航班拍成 3C7206
  const records = [
    { id: 'eq_p', type: 'passport', passportNo: 'EQ1035708', name: 'BAI YILAN', confidence: 0.95 },
    { id: 'eq_r', type: 'receipt', passportNo: 'EQ1035708', flightNo: '9C7206', confidence: 0.9 },
    { id: 'eh_p', type: 'passport', passportNo: 'EH9742220', name: 'CAO LEI', confidence: 0.95 },
    { id: 'eh_r', type: 'receipt', passportNo: 'EH9742220', flightNo: '3C7206', confidence: 0.9 },
    { id: 'eh_f', type: 'flight', flightNo: '9C7206', confidence: 0.8 }, // CAO LEI 的航班图
  ];
  const fuzzy = createGroupingEngine({ fuzzy: true, maxDistance: 2, rejectInvalid: true });
  const { clusters, unassigned } = fuzzy.group(records);
  // eh_f 的 9C7206 与 EQ10(9C7206) 和 EH97 小票(3C7206,距1) 都接近 → 歧义 → 不挂
  assert.ok(unassigned.includes('eh_f'));
  // 没有任何簇同时含 EQ 和 EH 两人的记录
  for (const c of clusters) {
    const hasEq = c.recordIds.some((id) => id.startsWith('eq'));
    const hasEh = c.recordIds.some((id) => id.startsWith('eh'));
    assert.ok(!(hasEq && hasEh), `簇 ${c.key} 错并了两个客户`);
  }
});

test('航班图按"航班号+离境日期"精确归组：同航班不同日期不混', () => {
  const records = [
    { id: 'a_p', type: 'passport', passportNo: 'EM9314578', name: 'A', confidence: 0.95 },
    { id: 'a_r', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572', departureDate: '2026-01-26', confidence: 0.9 },
    { id: 'b_p', type: 'passport', passportNo: 'EK0053004', name: 'B', confidence: 0.95 },
    { id: 'b_r', type: 'receipt', passportNo: 'EK0053004', flightNo: '9C8572', departureDate: '2026-02-10', confidence: 0.9 },
    { id: 'a_f', type: 'flight', flightNo: '9C8572', departureDate: '2026-01-26', confidence: 0.8 }, // 应归 A
  ];
  const eng = createGroupingEngine({ fuzzy: true, maxDistance: 2, rejectInvalid: true, bridgeFlights: true });
  const { clusters } = eng.group(records);
  const a = clusters.find((c) => c.key === 'EM9314578');
  assert.ok(a.recordIds.includes('a_f'), '航班图应按离境日期归到 A');
  const b = clusters.find((c) => c.key === 'EK0053004');
  assert.ok(!b.recordIds.includes('a_f'), '不应混入同航班不同日期的 B');
});

test('精度守护：两个明显不同的护照不因模糊而错并', () => {
  const records = [
    { id: 'a', type: 'passport', passportNo: 'EM9314578', confidence: 0.95 },
    { id: 'b', type: 'passport', passportNo: 'EK0053004', confidence: 0.95 },
  ];
  const fuzzy = createGroupingEngine({ fuzzy: true, maxDistance: 2, rejectInvalid: true });
  const { clusters } = fuzzy.group(records);
  assert.equal(clusters.length, 2);
});
