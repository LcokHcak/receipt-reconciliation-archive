'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroupCodePrematchService, MATCH_STATUS, normalizeTourNo } = require('../services/group_code_prematch_service');

// 内存版 repo 桩:batchId → { tourNo → rows }
function makeRepo(data = {}) {
  return {
    countByBatch: (batchId) => Object.values(data[batchId] || {}).flat().length,
    findByTour: ({ batchId, tourNo }) => (data[batchId]?.[tourNo] || []),
    listTourNosByBatch: (batchId) => Object.keys(data[batchId] || {}),
  };
}

const NOW = () => '2026-07-02T10:00:00.000Z';

test('normalizeTourNo 与结算终匹配同口径(剥前缀字母/后缀-_)', () => {
  assert.equal(normalizeTourNo('R26147854'), '26147854');
  assert.equal(normalizeTourNo('26147854-2'), '26147854');
  assert.equal(normalizeTourNo(' 26147854 '), '26147854');
  assert.equal(normalizeTourNo(''), '');
});

test('lookupTour:精确命中/归一化兜底/未命中/表未就绪', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: { 26147854: [{ tourNo: '26147854', mode: '乐天SG-本司' }] },
    }),
    now: NOW,
  });
  assert.deepEqual(svc.lookupTour('b1', '26147854'), { status: 'matched', mode: '乐天SG-本司' });
  // 归一化兜底:R前缀(乐天R团)剥掉后命中
  assert.deepEqual(svc.lookupTour('b1', 'R26147854'), { status: 'matched', mode: '乐天SG-本司' });
  assert.deepEqual(svc.lookupTour('b1', '99999999'), { status: 'not_found', mode: '' });
  // 表未就绪(批次没有任何团号行)
  assert.deepEqual(svc.lookupTour('b_empty', '26147854'), { status: 'pending_table', mode: '' });
  // 空团号
  assert.deepEqual(svc.lookupTour('b1', ''), { status: '', mode: '' });
  // 团号"无"(机场票合法值):不查表,中性状态,不误报未命中
  assert.deepEqual(svc.lookupTour('b1', '无'), { status: 'no_group', mode: '' });
  assert.equal(MATCH_STATUS.NO_GROUP, 'no_group');
});

test('近似纠错(金标:团号错误主形态=差1字符):唯一候选→FUZZY建议;多候选/太短→不猜', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        26141846: [{ tourNo: '26141846', mode: '乐天SG-本司' }],
        26146097: [{ tourNo: '26146097', mode: '乐天H团-本司' }],
      },
      // 两个互近候选(只差1位)→ 对错一个字符的输入会撞出多候选
      b2: {
        71990: [{ tourNo: '71990', mode: 'A' }],
        71991: [{ tourNo: '71991', mode: 'B' }],
      },
    }),
    now: NOW,
  });

  // 金标真实案例①:漏一位 2614846 → 建议 26141846
  const miss = svc.lookupTour('b1', '2614846');
  assert.equal(miss.status, 'fuzzy_candidate');
  assert.equal(miss.suggestion, '26141846');
  // 金标真实案例②:0认成9 26146047 → 建议 26146097
  assert.equal(svc.lookupTour('b1', '26146047').suggestion, '26146097');
  // 精确命中不受影响
  assert.equal(svc.lookupTour('b1', '26141846').status, 'matched');
  // 多候选不敢猜 → not_found(71992 与 71990/71991 都差1位)
  assert.equal(svc.lookupTour('b2', '71992').status, 'not_found');
  // 太短(<5位)不启用
  assert.equal(svc.lookupTour('b1', '2614').status, 'not_found');

  // prematchTask 带出建议字段;命中后建议清空
  const task = { docTypeFinal: 'receipt', groupNoFinal: '2614846' };
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'fuzzy_candidate');
  assert.equal(task.groupNoSuggestion, '26141846');
  task.groupNoFinal = '26141846'; // 审核员点"采用"后保存
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'matched');
  assert.equal(task.groupNoSuggestion, '');
});

test('prematchTask:小票任务打标,护照任务清空,Final优先于Auto', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        11111: [{ tourNo: '11111', mode: '新罗V团-新琪' }],
        22222: [{ tourNo: '22222', mode: '爱宝客SG-本司' }],
      },
    }),
    now: NOW,
  });

  const receipt = { docTypeFinal: 'receipt', groupNoAuto: '11111', groupNoFinal: '22222' };
  assert.equal(svc.prematchTask('b1', receipt), true);
  assert.equal(receipt.modeRawPre, '爱宝客SG-本司'); // Final 优先
  assert.equal(receipt.groupNoMatchStatus, 'matched');
  assert.equal(receipt.groupNoMatchedAt, NOW());

  // 未命中
  const miss = { docTypeFinal: 'receipt', groupNoFinal: '33333' };
  svc.prematchTask('b1', miss);
  assert.equal(miss.groupNoMatchStatus, 'not_found');
  assert.equal(miss.modeRawPre, '');
  assert.equal(miss.groupNoMatchedAt, '');

  // 护照任务:清空(曾是小票后来改类型的残留也会被清)
  const passport = { docTypeFinal: 'passport', groupNoFinal: '11111', modeRawPre: '残留', groupNoMatchStatus: 'matched' };
  svc.prematchTask('b1', passport);
  assert.equal(passport.groupNoMatchStatus, '');
  assert.equal(passport.modeRawPre, '');

  // 幂等:同值再跑返回 changed=false
  assert.equal(svc.prematchTask('b1', receipt), false);
});

test('sweepBatch:整批补跑返回统计', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: { 11111: [{ tourNo: '11111', mode: '新罗V团-新琪' }] },
    }),
    now: NOW,
  });
  const batch = {
    id: 'b1',
    tasks: [
      { docTypeFinal: 'receipt', groupNoFinal: '11111' },
      { docTypeFinal: 'receipt', groupNoFinal: '99999' },
      { docTypeFinal: 'passport' },
    ],
  };
  const r = svc.sweepBatch(batch);
  assert.deepEqual({ total: r.total, matched: r.matched }, { total: 3, matched: 1 });
  assert.equal(batch.tasks[0].modeRawPre, '新罗V团-新琪');
  assert.equal(batch.tasks[1].groupNoMatchStatus, 'not_found');
});

// 团号多店消歧(2026-07-07,70299病例):同团号两行属两家店,预匹配按票店出模式;
// 票店与候选全不符 → store_mismatch 黄徽章(带候选模式),绝不把现代模式亮给新世界小票。
test('lookupTour/prematchTask:同团号多店按票店消歧;全别店=store_mismatch', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: { 70299: [
        { tourNo: '70299', mode: '新世界SG-振华 不用记' },
        { tourNo: '70299', mode: '现代-JEOCU' },
      ] },
    }),
    now: NOW,
  });
  // 新世界小票 → 振华;现代小票 → JEOCU
  assert.deepEqual(svc.lookupTour('b1', '70299', 'SHINSEGAE'), { status: 'matched', mode: '新世界SG-振华 不用记' });
  assert.deepEqual(svc.lookupTour('b1', '70299', 'HYUNDAI'), { status: 'matched', mode: '现代-JEOCU' });
  // 乐天小票 + 此团号 → 店不符(带候选模式供徽章提示)
  const mm = svc.lookupTour('b1', '70299', 'LOTTE');
  assert.equal(mm.status, 'store_mismatch');
  assert.ok(mm.mismatchModes.includes('新世界SG-振华 不用记') && mm.mismatchModes.includes('现代-JEOCU'));
  // 票店未知 + 多模式 → mode_ambiguous 人选(2026-07-12 用户拍板推翻旧"默取首行":
  // 一号多模式系统绝不默配,店读不出来更不能猜)
  assert.equal(svc.lookupTour('b1', '70299', '').status, 'mode_ambiguous');

  // prematchTask:店从任务字段取(Final优先),mismatch 时写 modeStoreMismatch 供徽章
  const task = {
    docTypeFinal: 'receipt', groupNoFinal: '70299',
    receiptStoreFinal: 'SHINSEGAE', receiptStoreAuto: '',
  };
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'matched');
  assert.equal(task.modeRawPre, '新世界SG-振华 不用记');
  assert.equal(task.modeStoreMismatch, '');

  const lotteTask = {
    docTypeFinal: 'receipt', groupNoFinal: '70299',
    receiptStoreFinal: 'LOTTE', receiptStoreAuto: '',
  };
  svc.prematchTask('b1', lotteTask);
  assert.equal(lotteTask.groupNoMatchStatus, 'store_mismatch');
  assert.equal(lotteTask.modeRawPre, '');
  assert.ok(lotteTask.modeStoreMismatch.includes('现代-JEOCU'));
  // 改店成现代再保存 → 即时翻绿
  lotteTask.receiptStoreFinal = 'HYUNDAI';
  svc.prematchTask('b1', lotteTask);
  assert.equal(lotteTask.groupNoMatchStatus, 'matched');
  assert.equal(lotteTask.modeRawPre, '现代-JEOCU');
  assert.equal(lotteTask.modeStoreMismatch, '');
});

test('prematchTask 尊重人工选模式(号不变保人选,号变自动作废)', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        70299: [
          { tourNo: '70299', mode: '新世界SG-振华 不用记' },
          { tourNo: '70299', mode: '现代-JEOCU' },
        ],
      },
    }),
    now: NOW,
  });
  // 同团号两店模式、票店消歧不了 → store_mismatch;审核员人选了新世界
  const task = {
    docTypeFinal: 'receipt',
    groupNoFinal: '70299',
    receiptStoreFinal: 'LOTTE', // 票店与两候选都不符 → 消歧失败场景
    modeManualPick: '新世界SG-振华 不用记',
    modeManualPickTour: '70299',
  };
  svc.prematchTask('b1', task);
  assert.equal(task.modeRawPre, '新世界SG-振华 不用记', '号不变:模式以人选为准');
  assert.equal(task.groupNoMatchStatus, 'matched', 'store_mismatch 被人选解除');
  assert.equal(task.modeStoreMismatch, '', '候选提示清空');

  // 团号改了 → 人选自动作废,回查表结果
  task.groupNoFinal = '99999999';
  svc.prematchTask('b1', task);
  assert.equal(task.modeManualPick, '', '号变:人选作废');
  assert.equal(task.modeManualPickTour, '');
  assert.equal(task.groupNoMatchStatus, 'not_found');
});

// ── 同店多模式撞号(2026-07-12 用户拍板:人选,系统绝不默取第一行)──
// 审计实锤:新罗V团-新琪 ⇆ 新罗V团-本司 ×3 团号,两行同属 THE SHILLA,店消歧裁不了,
// 旧逻辑静默取表里第一行 → 代理错。现在必须 MODE_AMBIGUOUS + 候选串,审核员点选。
test('lookupTour:同店双代理撞号 → mode_ambiguous+候选,绝不默配', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        70715: [
          { tourNo: '70715', mode: '新罗V团-新琪' },
          { tourNo: '70715', mode: '新罗V团-本司' },
        ],
      },
    }),
    now: NOW,
  });
  const r = svc.lookupTour('b1', '70715', 'THE SHILLA');
  assert.equal(r.status, 'mode_ambiguous');
  assert.equal(r.mode, '', '绝不默取任何一行');
  assert.ok(r.mismatchModes.includes('新罗V团-新琪') && r.mismatchModes.includes('新罗V团-本司'));
  // 票店为空(店没读出来)同样不敢默配
  const r2 = svc.lookupTour('b1', '70715', '');
  assert.equal(r2.status, 'mode_ambiguous');
});

test('lookupTour:跨店撞号仍由店消歧自动裁(70690 病例,新表两行)', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        70690: [
          { tourNo: '70690', mode: '新罗V团-本司' },
          { tourNo: '70690', mode: '新世界SG-振华 不用记' },
        ],
      },
    }),
    now: NOW,
  });
  assert.deepEqual(svc.lookupTour('b1', '70690', 'SHINSEGAE'), { status: 'matched', mode: '新世界SG-振华 不用记' });
  assert.deepEqual(svc.lookupTour('b1', '70690', 'THE SHILLA'), { status: 'matched', mode: '新罗V团-本司' });
});

test('lookupTour:单行命中保守边界不变(票店≠模式店的历史行为不翻案)', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: { 70690: [{ tourNo: '70690', mode: '新罗V团-本司' }] }, // 旧表只有一行(报障批次形态)
    }),
    now: NOW,
  });
  assert.deepEqual(svc.lookupTour('b1', '70690', 'SHINSEGAE'), { status: 'matched', mode: '新罗V团-本司' });
});

test('prematchTask:mode_ambiguous 人选后翻 matched,换团号自动作废', () => {
  const svc = createGroupCodePrematchService({
    batchGroupCodeRepo: makeRepo({
      b1: {
        70715: [
          { tourNo: '70715', mode: '新罗V团-新琪' },
          { tourNo: '70715', mode: '新罗V团-本司' },
        ],
      },
    }),
    now: NOW,
  });
  const task = { docTypeFinal: 'receipt', groupNoFinal: '70715', receiptStoreFinal: 'THE SHILLA' };
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'mode_ambiguous');
  assert.equal(task.modeRawPre, '');
  assert.ok(task.modeStoreMismatch.includes('新罗V团-本司'), '候选串给足供前端出按钮');
  // 人选一个 → matched
  task.modeManualPick = '新罗V团-本司';
  task.modeManualPickTour = '70715';
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'matched');
  assert.equal(task.modeRawPre, '新罗V团-本司');
  assert.equal(task.modeStoreMismatch, '');
  // 团号改了 → 人选作废回查表
  task.groupNoFinal = '99999999';
  svc.prematchTask('b1', task);
  assert.equal(task.groupNoMatchStatus, 'not_found');
  assert.equal(task.modeManualPick, '');
});
