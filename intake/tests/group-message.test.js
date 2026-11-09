'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGroupMessage } = require('../src/parsing/group-message');

test('解析标准团号消息：团号+有效期+护照+姓名', () => {
  const r = parseGroupMessage('乐天B团号 26144790~6/12 EN7296496 SUN XIAO');
  assert.deepEqual(r.groupNos, [{ groupNo: '26144790', validUntil: '6/12' }]);
  assert.deepEqual(r.passports, [{ passportNo: 'EN7296496', name: 'SUN XIAO' }]);
  assert.ok(r.modes.includes('B团'));
  assert.equal(r.isBareNumber, false);
});

test('解析 SG 团号消息', () => {
  const r = parseGroupMessage('乐天SG团号 26144924~6/12 EQ9627254 ZOU YA');
  assert.equal(r.groupNos[0].groupNo, '26144924');
  assert.equal(r.passports[0].passportNo, 'EQ9627254');
  assert.equal(r.passports[0].name, 'ZOU YA');
  assert.ok(r.modes.includes('SG'));
});

test('裸数字消息标记为 bareNumber（需上下文）', () => {
  const r = parseGroupMessage('2563');
  assert.equal(r.isBareNumber, true);
  assert.equal(r.bareNumber, '2563');
  assert.deepEqual(r.passports, []);
});

test('多行：一个团号挂多本护照', () => {
  const text = '乐天B团团号 26143139~6/5\nER8529180 JI XUAN\nEL2276892 SUN LULU\nEH3927475 GU ZHENG';
  const r = parseGroupMessage(text);
  assert.equal(r.groupNos[0].groupNo, '26143139');
  assert.equal(r.groupNos[0].validUntil, '6/5');
  assert.equal(r.passports.length, 3);
  assert.equal(r.passports[2].name, 'GU ZHENG');
});

test('S-H-PKG 挂三个：识别多个模式', () => {
  const r = parseGroupMessage('S-H-PKG 挂三个写一下哈谢谢');
  assert.ok(r.modes.includes('S'));
  assert.ok(r.modes.includes('H'));
  assert.ok(r.modes.includes('PKG'));
});
