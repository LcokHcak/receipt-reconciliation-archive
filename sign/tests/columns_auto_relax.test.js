'use strict';

// T3(2026-07-21 拍板):「记哪些列」单一真相源自动驱动免审。
// resolver 把 payload.columns 中不记的 小票号/购买日期/出境日期 派生进 overlay.relax,
// 与显式 review.relax 取并集;店家/团号/姓名/护照号不派生;显式 require 可补回(消费方 require 后于 relax)。

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createReviewConfigResolver } = require('../services/review_config_resolver');
const { getTaskRequiredFieldChecks, setReviewConfigResolver } = require('../lib/workbench_task_flow');

function makeResolver() {
  const db = new DatabaseSync(':memory:');
  const repo = createModeConfigRepository({ db });
  const resolver = createReviewConfigResolver({ modeConfigRepository: repo, logger: { warn() {} } });
  return { db, repo, resolver };
}

const FULL_COLUMNS = { recordDate: true, agent: true, purchaseDate: true, receiptNo: true, groupNo: true, name: true, passportNo: true, departureDate: true };

test('T3 派生矩阵:不记的 小票号/日期 自动进 relax;记的不进;name/passportNo/groupNo 永不派生', (t) => {
  const { db, repo, resolver } = makeResolver();
  t.after(() => { try { db.close(); } catch { /* noop */ } });
  repo.saveNewVersion({
    kind: 'mode', name: '新罗V团-新琪', createdBy: 't',
    payload: { modeLabel: '新罗V团-新琪', columns: { ...FULL_COLUMNS, purchaseDate: false, receiptNo: false, name: false, passportNo: false, departureDate: false } },
  });
  const ov = resolver.getModeReviewOverlay('新罗V团-新琪');
  assert.ok(ov, '仅 columns 无 review 段也要产 overlay(此前 !review 直接 null=派生落空)');
  assert.deepEqual([...ov.relax].sort(), ['departureDateFinal', 'purchaseDateFinal', 'receiptNoFinal'].sort(), '三列派生;name/passportNo 不跟随');
  assert.equal(ov.slim, false);
  // 全记模式:无派生、无显式 → overlay 为 null(行为与改动前一致)
  repo.saveNewVersion({ kind: 'mode', name: '乐天SG-本司', createdBy: 't', payload: { modeLabel: '乐天SG-本司', columns: { ...FULL_COLUMNS } } });
  assert.equal(resolver.getModeReviewOverlay('乐天SG-本司'), null, '全记且无显式 review → null');
});

test('T3 并集与 require 补回:显式 relax ∪ 派生;require 在消费方后于 relax 生效', (t) => {
  const { db, repo, resolver } = makeResolver();
  t.after(() => { try { db.close(); } catch { /* noop */ } });
  repo.saveNewVersion({
    kind: 'mode', name: '现代-JEOCU', createdBy: 't',
    payload: {
      modeLabel: '现代-JEOCU',
      columns: { ...FULL_COLUMNS, purchaseDate: false, departureDate: false, name: false, passportNo: false },
      review: { relax: ['receiptNoFinal'], require: ['purchaseDateFinal'] },
    },
  });
  const ov = resolver.getModeReviewOverlay('现代-JEOCU');
  assert.deepEqual([...ov.relax].sort(), ['departureDateFinal', 'purchaseDateFinal', 'receiptNoFinal'].sort(), '显式∪派生');
  assert.deepEqual([...ov.require], ['purchaseDateFinal'], 'require 原样透传');

  // 消费方:matched 后必填=基线 −relax +require → 购买日期被 require 补回,出境日期/小票号免审
  setReviewConfigResolver(resolver);
  t.after(() => setReviewConfigResolver(null));
  const task = {
    docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'HYUNDAI', groupNoMatchStatus: 'matched', modeRawPre: '现代-JEOCU',
    tourStance: 'matched', groupNoFinal: '70020',
  };
  const checks = getTaskRequiredFieldChecks(task).checks;
  const keys = checks.map((c) => c.finalKey);
  assert.ok(!keys.includes('departureDateFinal'), '出境日期派生免审');
  assert.ok(!keys.includes('receiptNoFinal'), '小票号显式免审');
  assert.ok(keys.includes('purchaseDateFinal'), 'require 把购买日期补回');
  assert.ok(keys.includes('receiptStoreFinal'), '店家锚永在');
});

test('T3 时序墙+3列模式效果:未命中全审;命中后必填只剩 店家+团号', (t) => {
  const { db, repo, resolver } = makeResolver();
  t.after(() => { try { db.close(); } catch { /* noop */ } });
  repo.saveNewVersion({
    kind: 'mode', name: '济州新罗SG-道辉', createdBy: 't',
    payload: { modeLabel: '济州新罗SG-道辉', columns: { ...FULL_COLUMNS, purchaseDate: false, receiptNo: false, name: false, passportNo: false, departureDate: false } },
  });
  setReviewConfigResolver(resolver);
  t.after(() => setReviewConfigResolver(null));
  const base = {
    docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'THE SHILLA', modeRawPre: '济州新罗SG-道辉 不用记', // 带尾巴串,canonical 归一命中
    tourStance: 'matched', groupNoFinal: '71234',
  };
  const matchedKeys = getTaskRequiredFieldChecks({ ...base, groupNoMatchStatus: 'matched' }).checks.map((c) => c.finalKey).sort();
  assert.deepEqual(matchedKeys, ['groupNoFinal', 'receiptStoreFinal'], '3列模式命中后=店+团号,其余全免');
  const missKeys = getTaskRequiredFieldChecks({ ...base, groupNoMatchStatus: 'not_found' }).checks.map((c) => c.finalKey);
  assert.ok(missKeys.includes('receiptNoFinal') && missKeys.includes('purchaseDateFinal'), '未命中=纯基线全审(时序墙)');
});

test('T3 保守回落:显式 review 段不合法 → 整体 null(派生也不叠,防半生效)', (t) => {
  const { db, repo, resolver } = makeResolver();
  t.after(() => { try { db.close(); } catch { /* noop */ } });
  repo.saveNewVersion({
    kind: 'mode', name: '坏配置模式', createdBy: 't',
    payload: { modeLabel: '坏配置模式', columns: { ...FULL_COLUMNS, receiptNo: false }, review: { relax: ['receiptStoreFinal'] } }, // 锚字段=非法
  });
  assert.equal(resolver.getModeReviewOverlay('坏配置模式'), null, '非法显式段 → 回落全审');
});

test('T4 listModeRelaxMap:全模式有效免审映射(减 require 补回),供前端折叠+豁免同源', (t) => {
  const { db, repo, resolver } = makeResolver();
  t.after(() => { try { db.close(); } catch { /* noop */ } });
  repo.saveNewVersion({
    kind: 'mode', name: '新罗V团-新琪', createdBy: 't',
    payload: { modeLabel: '新罗V团-新琪', columns: { ...FULL_COLUMNS, purchaseDate: false, receiptNo: false, departureDate: false } },
  });
  repo.saveNewVersion({
    kind: 'mode', name: '现代-JEOCU', createdBy: 't',
    payload: { modeLabel: '现代-JEOCU', columns: { ...FULL_COLUMNS, purchaseDate: false }, review: { require: ['purchaseDateFinal'] } },
  });
  repo.saveNewVersion({ kind: 'mode', name: '乐天SG-本司', createdBy: 't', payload: { modeLabel: '乐天SG-本司', columns: { ...FULL_COLUMNS } } });
  const map = resolver.listModeRelaxMap();
  assert.deepEqual([...map['新罗V团-新琪']].sort(), ['departureDateFinal', 'purchaseDateFinal', 'receiptNoFinal'].sort());
  assert.equal(map['现代-JEOCU'], undefined, 'require 补回后有效免审为空 → 不下发');
  assert.equal(map['乐天SG-本司'], undefined, '全记模式不下发');
});
