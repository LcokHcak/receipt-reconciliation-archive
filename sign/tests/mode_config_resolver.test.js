'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createModeConfigResolver, validateModeConfig } = require('../services/mode_config_resolver');
const {
  lookupModeRecordRule,
  setModeRuleResolver,
  composeModeRule,
} = require('../lib/mode_record_matrix');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-resolver-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const warns = [];
  const infos = [];
  const resolver = createModeConfigResolver({
    modeConfigRepository: repository,
    // 签名对齐生产 lib/request_logger:(msg, fields)——复核HIGH#1:mock 抄实现不抄真实契约=假绿
    logger: {
      warn: (msg, fields) => warns.push({ msg, fields }),
      info: (msg, fields) => infos.push({ msg, fields }),
    },
  });
  t.after(() => {
    setModeRuleResolver(null); // 全局挂钩必须复位,别串下一个测试
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository, resolver, warns, infos };
}

test('DB 空:resolver 返回 null;挂钩后 lookupModeRecordRule ≡ 出厂(逐字段)', (t) => {
  const { resolver } = makeHarness(t);
  assert.equal(resolver.getModeRecordRule('乐天SG-本司'), null);

  const factory = lookupModeRecordRule('乐天SG-本司');
  setModeRuleResolver(resolver.getModeRecordRule);
  assert.deepEqual(lookupModeRecordRule('乐天SG-本司'), factory);
  // 未知模式与空串也一致
  assert.deepEqual(lookupModeRecordRule('没见过的模式'), composeModeRule(null, '没见过的模式'));
  assert.deepEqual(lookupModeRecordRule(''), lookupModeRecordRule(''));
});

test('配置命中:规则跟配置走(覆盖出厂),带 configVersion 戳;尾巴动作按原串现算', (t) => {
  const { repository, resolver } = makeHarness(t);
  repository.saveNewVersion({
    kind: 'mode',
    name: '乐天SG-本司',
    payload: {
      modeLabel: '乐天SG-本司',
      columns: { ...ALL_COLUMNS, departureDate: false }, // 故意与出厂不同:不记出境日期
      receiptNoForm: 'digits13',                          // 出厂是 digits14
      actions: [],
    },
  });

  setModeRuleResolver(resolver.getModeRecordRule);
  const rule = lookupModeRecordRule('乐天SG-本司');
  assert.equal(rule.known, true);
  assert.equal(rule.receiptNoForm, 'digits13');
  assert.equal(rule.columns.departureDate, false);
  assert.equal(rule.configVersion, 1);
  // 尾巴动作与「不用记」仍按原串现算(composeModeRule 单一份)
  const suffixed = lookupModeRecordRule('乐天SG-本司（发小票17）不用记');
  assert.ok(suffixed.actions.includes('及时发上家'));
  assert.equal(suffixed.noRecord, true);
  assert.equal(suffixed.receiptNoForm, 'digits13');

  setModeRuleResolver(null);
  assert.equal(lookupModeRecordRule('乐天SG-本司').receiptNoForm, 'digits14'); // 摘钩即出厂
});

test('坏配置(schema 不过/坏 JSON):回落出厂 + config_fallback 留痕', (t) => {
  const { repository, resolver, warns } = makeHarness(t);
  repository.saveNewVersion({
    kind: 'mode',
    name: '乐天SG-本司',
    payload: { columns: { recordDate: 'yes' } }, // 非布尔=坏形状
  });
  setModeRuleResolver(resolver.getModeRecordRule);
  const rule = lookupModeRecordRule('乐天SG-本司');
  assert.equal(rule.receiptNoForm, 'digits14'); // 出厂值
  assert.ok(warns.some((entry) => entry.msg === 'config_fallback' && entry.fields?.reason));

  // 坏 JSON 同样回落
  repository.saveNewVersion({ kind: 'mode', name: '乐天H团（原乐天V）-本司', payload: '{oops' });
  resolver.invalidate();
  assert.equal(lookupModeRecordRule('乐天H团（原乐天V）-本司').receiptNoForm, 'digits14');
});

test('缓存按水位失效:改配置立刻生效,deactivate 立刻回落出厂', (t) => {
  const { repository, resolver } = makeHarness(t);
  setModeRuleResolver(resolver.getModeRecordRule);

  repository.saveNewVersion({
    kind: 'mode', name: '新罗SG-新琪',
    payload: { columns: { ...ALL_COLUMNS }, receiptNoForm: 'digits13' },
  });
  assert.equal(lookupModeRecordRule('新罗SG-新琪').configVersion, 1);

  repository.saveNewVersion({
    kind: 'mode', name: '新罗SG-新琪',
    payload: { columns: { ...ALL_COLUMNS }, receiptNoForm: '' },
  });
  assert.equal(lookupModeRecordRule('新罗SG-新琪').configVersion, 2); // 水位变了,免手动 invalidate

  repository.deactivate('mode', '新罗SG-新琪');
  // 显式变更计数器:activate/deactivate 也动水位,免手动 invalidate(回滚旧版本同理)
  const rule = lookupModeRecordRule('新罗SG-新琪');
  assert.equal(rule.configVersion, undefined); // 回到出厂(SLIM 简记)
  assert.equal(rule.columns.receiptNo, false);
});

test('validateModeConfig:未知列/非法票号形态/actions 非串都拒', () => {
  assert.equal(validateModeConfig({ columns: { ...ALL_COLUMNS } }).ok, true);
  assert.equal(validateModeConfig({ columns: { ...ALL_COLUMNS, extra: true } }).ok, false);
  assert.equal(validateModeConfig({ columns: { ...ALL_COLUMNS }, receiptNoForm: 'digits15' }).ok, false);
  assert.equal(validateModeConfig({ columns: { ...ALL_COLUMNS }, actions: [1] }).ok, false);
  assert.equal(validateModeConfig(null).ok, false);
});

test('别名桥:配置了正名,别名拼写(生产×10141)也吃到同一配置', (t) => {
  const { repository, resolver } = makeHarness(t);
  repository.saveNewVersion({
    kind: 'mode',
    name: '乐天H团（原乐天V）-本司',
    payload: { columns: { ...ALL_COLUMNS, departureDate: false }, receiptNoForm: 'digits14' },
  });
  const viaAlias = resolver.getModeRecordRule('乐天H团-本司（原乐天V-本司）');
  assert.ok(viaAlias, '别名应命中配置');
  assert.equal(viaAlias.configVersion, 1);
  assert.equal(viaAlias.columns.departureDate, false);
});

test('挂钩函数抛异常:lookupModeRecordRule 兜底回落出厂,不把台账导出打成500', (t) => {
  t.after(() => setModeRuleResolver(null));
  setModeRuleResolver(() => { throw new Error('db is closed'); });
  const rule = lookupModeRecordRule('乐天SG-本司');
  assert.equal(rule.receiptNoForm, 'digits14'); // 出厂值,没炸
});
