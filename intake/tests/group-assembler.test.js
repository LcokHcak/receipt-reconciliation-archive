'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroupAssembler } = require('../src/assembly/group-assembler');

const T0 = Date.UTC(2026, 0, 24, 10, 0, 0);
const min = (n) => T0 + n * 60 * 1000;

test('干净批次：同客户护照+小票+航班连发 → 收全', () => {
  const events = [
    { id: 'a_p', type: 'passport', passportNo: 'EM9314578', name: 'BAI FANGRUIYAN', sender: 'agent1', ts: min(0) },
    { id: 'a_r', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) },
    { id: 'a_f', type: 'flight', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) },
  ];
  const { complete, incomplete } = createGroupAssembler().assemble(events);
  assert.equal(complete.length, 1);
  assert.equal(incomplete.length, 0);
  assert.deepEqual(complete[0].recordIds.sort(), ['a_f', 'a_p', 'a_r']);
});

test('共享航班(挂团)：两客户同航班同日，发送上下文按时间窗各归各家', () => {
  // A 和 B 同航班 9C8572 同日；航班图内容上无法区分(都没护照号)
  const events = [
    { id: 'a_p', type: 'passport', passportNo: 'EM9314578', name: 'A', sender: 'agent1', ts: min(0) },
    { id: 'a_r', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) },
    { id: 'a_f', type: 'flight', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) },
    { id: 'b_p', type: 'passport', passportNo: 'EK0053004', name: 'B', sender: 'agent1', ts: min(120) },
    { id: 'b_r', type: 'receipt', passportNo: 'EK0053004', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(121) },
    { id: 'b_f', type: 'flight', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(121) },
  ];
  const { complete, unassigned } = createGroupAssembler().assemble(events);
  assert.equal(complete.length, 2);
  assert.equal(unassigned.length, 0);
  const a = complete.find((g) => g.key === 'EM9314578');
  const b = complete.find((g) => g.key === 'EK0053004');
  assert.ok(a.recordIds.includes('a_f') && !a.recordIds.includes('b_f'), 'A 的航班图归 A');
  assert.ok(b.recordIds.includes('b_f') && !b.recordIds.includes('a_f'), 'B 的航班图归 B');
});

test('缺件：只有护照+小票，标记为未收全并列出缺的航班', () => {
  const events = [
    { id: 'c_p', type: 'passport', passportNo: 'EP3039996', name: 'C', sender: 'agent2', ts: min(0) },
    { id: 'c_r', type: 'receipt', passportNo: 'EP3039996', flightNo: 'MU5060', departureDate: '2026-01-06', sender: 'agent2', ts: min(1) },
  ];
  const { complete, incomplete } = createGroupAssembler().assemble(events);
  assert.equal(complete.length, 0);
  assert.equal(incomplete.length, 1);
  assert.deepEqual(incomplete[0].missing, ['flight']);
  assert.equal(incomplete[0].sender, 'agent2'); // 知道催谁补
});

test('噪音(闲聊/表情)不污染客户组', () => {
  const events = [
    { id: 'a_p', type: 'passport', passportNo: 'EM9314578', name: 'A', sender: 'agent1', ts: min(0) },
    { id: 'noise1', type: 'other', sender: 'agent1', ts: min(0) },
    { id: 'noise2', type: 'other', sender: 'client9', ts: min(2) },
  ];
  const { groups, unassigned } = createGroupAssembler().assemble(events);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].recordIds, ['a_p']);
  assert.ok(unassigned.includes('noise1') && unassigned.includes('noise2'));
});

test('发送上下文歧义：同发送者同窗两客户，航班图不硬归 → 留人工', () => {
  const events = [
    { id: 'a_p', type: 'passport', passportNo: 'EM9314578', name: 'A', sender: 'agent1', ts: min(0) },
    { id: 'a_r', type: 'receipt', passportNo: 'EM9314578', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(0) },
    { id: 'b_p', type: 'passport', passportNo: 'EK0053004', name: 'B', sender: 'agent1', ts: min(1) },
    { id: 'b_r', type: 'receipt', passportNo: 'EK0053004', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) },
    { id: 'x_f', type: 'flight', flightNo: '9C8572', departureDate: '2026-01-26', sender: 'agent1', ts: min(1) }, // 同窗两客户
  ];
  const { unassigned } = createGroupAssembler().assemble(events);
  assert.ok(unassigned.includes('x_f'), '同发送者同窗多客户时航班图应留人工，不瞎归');
});
