'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { agentMatches, normalizeAgentTokens } = require('../lib/monthly_pipeline/matching/field_diff');

// 这些是用 1/2/3 月真实团号表/收票数据审计出来的"同一个人不同写法",
// 归一化必须把它们判为同一人(否则会有假"代理不符"涌进待补救)。
test('同一个人的不同写法 → 视为匹配', () => {
  assert.equal(agentMatches('西雅国际/涛士', '西雅国际'), true, '一格两导游(收票只写其一)');
  assert.equal(agentMatches('陈灏铭/梓陌', '梓陌'), true, '一格两导游');
  assert.equal(agentMatches('蜜蜂登记群', '蜜蜂'), true, '同人+登记群');
  assert.equal(agentMatches('涛士现场', '涛士'), true, '同人+现场');
  assert.equal(agentMatches('陈强E87617470', '陈强'), true, '同人+护照码');
  assert.equal(agentMatches('HUANHUAN', 'huanhuan'), true, '大小写');
});

// 关键安全性:两个真正不同的人,绝不能被合并(否则就是匹配错误)。
test('不同的人 → 仍判为不匹配(进待补救)', () => {
  assert.equal(agentMatches('涛士', '蜜蜂'), false, '两个不同导游');
  assert.equal(agentMatches('蜜蜂', '备用'), false, '占位词"备用"不等于真实代理');
  assert.equal(agentMatches('杨博涵', '主号'), false, '占位词"主号"不等于真实代理');
  assert.equal(agentMatches('泰峰', '台湾返点'), false, '不同的名/标签');
  assert.equal(agentMatches('新琪', '载弘'), false, '不同的人');
});

// 任一方为空 → 不算冲突(沿用旧逻辑:缺数据不拦截)。
test('缺数据 → 不算冲突', () => {
  assert.equal(agentMatches('', '涛士'), true);
  assert.equal(agentMatches('涛士', ''), true);
  assert.equal(agentMatches(null, '涛士'), true);
});

// "备用/主号"这类占位词不能被剥成空字符串后误判为"空→不比对"。
test('占位词不被剥成空', () => {
  assert.deepEqual(normalizeAgentTokens('备用'), ['备用']);
  assert.deepEqual(normalizeAgentTokens('主号'), ['主号']);
  // 但"现场"作为后缀(前面有名字)才剥;单独"现场"保留
  assert.deepEqual(normalizeAgentTokens('涛士现场'), ['涛士']);
  assert.deepEqual(normalizeAgentTokens('现场'), ['现场']);
});
