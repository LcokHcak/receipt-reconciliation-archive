const test = require('node:test');
const assert = require('node:assert/strict');

const { createTourConfirmService } = require('../services/tour_confirm_service');
const { createSourceGroup } = require('../lib/source_group_utils');

// ── 测试挂具:mock 预匹配服务(lookupTour/prematchTask)──────────────────────
function makeService({ table = {}, slim = '', requireConfirm = '' } = {}) {
  const prematchCalls = [];
  const logRows = [];
  const sendbacks = [];
  const svc = createTourConfirmService({
    groupCodePrematchHolder: {
      service: {
        lookupTour(batchId, tourNo) {
          const hit = table[String(tourNo).trim()];
          // 契约与真实实现一致(group_code_prematch_service):mismatchModes 是 ' / ' 拼接的字符串!
          // 上次 mock 用数组导致 CRITICAL 漂移(店不符永远 422)从测试网漏过——别再改回数组。
          if (!hit) return { status: 'not_found', mode: '', mismatchModes: '' };
          if (hit.storeMismatch) return { status: 'store_mismatch', mode: '', mismatchModes: hit.modes.join(' / ') };
          return { status: 'matched', mode: hit.mode, mismatchModes: '' };
        },
        prematchTask(batchId, task) { prematchCalls.push(task.id); return true; },
      },
    },
    tourConfirmLogRepo: { append: (row) => logRows.push(row) },
    sendbackQueueRepo: { enqueue: (row) => sendbacks.push(row) },
    slimModesEnv: () => slim,
    requireConfirmEnv: () => requireConfirm,
    now: () => '2026-07-10T02:00:00.000Z',
  });
  return { svc, prematchCalls, logRows, sendbacks };
}

function receipt(id, { auto = '', final = '', status = '', store = 'THE SHILLA', suggestion = '' } = {}) {
  return {
    id, sourceGroupKey: 'group_a', docTypeFinal: 'receipt',
    groupNoAuto: auto, groupNoFinal: final, groupNoMatchStatus: status,
    receiptStoreFinal: store, groupNoSuggestion: suggestion,
  };
}

function makeBatch(tasks, groupOverrides = {}) {
  return {
    id: 'batch_t', monthlyWorkspaceKey: '260710-小票06',
    sourceGroups: [createSourceGroup({ key: 'group_a', folderPath: 'CL-001', label: '蜜蜂', ...groupOverrides })],
    tasks,
  };
}

test('buildCandidates:聚合票数/命中票数/fuzzy/冲突/空号清单', () => {
  const { svc } = makeService({ table: { 71203: { mode: '乐天SG-本司' } } });
  const batch = makeBatch([
    receipt('t1', { auto: '71203', status: 'matched' }),
    receipt('t2', { auto: '71203', status: 'matched' }),
    receipt('t3', { auto: '7l208', status: 'not_found', suggestion: '71203' }),
    receipt('t4', {}), // 空号
    { id: 'p1', sourceGroupKey: 'group_a', docTypeFinal: 'passport' },
  ]);
  const out = svc.buildCandidates(batch, 'group_a');
  assert.equal(out.counts.receipts, 4);
  assert.equal(out.counts.passports, 1);
  assert.equal(out.candidates[0].tourNo, '71203');
  assert.equal(out.candidates[0].votes, 2);
  assert.equal(out.candidates[0].matchedVotes, 2);
  assert.equal(out.candidates[0].tableStatus, 'matched');
  assert.equal(out.candidates[0].mode, '乐天SG-本司');
  assert.equal(out.conflict, true); // 71203 与 7l208 两个读数并存
  assert.deepEqual(out.fuzzy, [{ taskId: 't3', read: '7l208', suggestion: '71203' }]);
  assert.deepEqual(out.emptyReceiptTaskIds, ['t4']);
  assert.equal(out.exempt.isExempt, false);
});

test('豁免:整组无小票 / 机场票"无" / 百货票', () => {
  const { svc } = makeService();
  assert.equal(svc.buildCandidates(makeBatch([
    { id: 'p1', sourceGroupKey: 'group_a', docTypeFinal: 'passport' },
  ]), 'group_a').exempt.reason, 'no_receipts');
  assert.equal(svc.buildCandidates(makeBatch([
    receipt('t1', { auto: '无' }),
  ]), 'group_a').exempt.reason, 'dept_or_airport');
  assert.equal(svc.buildCandidates(makeBatch([
    receipt('t1', { auto: '123', store: '乐天百货' }),
  ]), 'group_a').exempt.reason, 'dept_or_airport');
  // 生产实际存 canonical 枚举(审计实锤:只认"百货"字样时 LOTTE_DEPT 永不豁免)
  assert.equal(svc.buildCandidates(makeBatch([
    receipt('t1', { auto: '123', store: 'LOTTE_DEPT' }),
  ]), 'group_a').exempt.reason, 'dept_or_airport');
});

test('confirmTour:命中表→盖章+回填空票/OCR票+重跑预匹配;人工改过/matched异值票不覆盖', async () => {
  const { svc, prematchCalls, logRows, sendbacks } = makeService({ table: { 71203: { mode: '乐天SG-本司' } } });
  const batch = makeBatch([
    receipt('t1', { auto: '71203', status: 'matched' }),          // 值==确认值:不改值但盖回执
    receipt('t2', {}),                                            // 空号:回填
    receipt('t3', { auto: '7l208', status: 'not_found' }),        // OCR 读歪:回填纠正
    receipt('t4', { auto: '70000', final: '70455' }),             // 人工改过:绝不覆盖 → 例外
    receipt('t5', { auto: '71993', status: 'matched' }),          // matched 但异值:绝不覆盖 → 例外
  ]);
  const out = svc.confirmTour(batch, 'group_a', { tourNo: '71203', source: 'majority', operator: '后勤09' });

  assert.equal(out.tourConfirm.status, 'confirmed');
  assert.equal(out.tourConfirm.mode, '乐天SG-本司');
  assert.deepEqual(out.backfilledTaskIds.sort(), ['t2', 't3']);
  assert.deepEqual(out.exceptions.map((e) => e.taskId).sort(), ['t4', 't5']);
  const byId = Object.fromEntries(batch.tasks.map((t) => [t.id, t]));
  assert.equal(byId.t2.groupNoFinal, '71203');
  assert.equal(byId.t3.groupNoFinal, '71203');
  assert.equal(byId.t4.groupNoFinal, '70455', '人工值不动');
  assert.equal(byId.t5.groupNoFinal, '', 'matched异值票不动');
  // 回填过/同值票拿到任务级确认回执;例外票没有
  assert.ok(byId.t1.tourConfirmedAt && byId.t2.tourConfirmedAt && byId.t3.tourConfirmedAt);
  assert.ok(!byId.t4.tourConfirmedAt && !byId.t5.tourConfirmedAt);
  // 重跑预匹配只对非例外票
  assert.deepEqual(prematchCalls.sort(), ['t1', 't2', 't3']);
  // 组级盖章落 sourceGroups
  assert.equal(batch.sourceGroups[0].tourConfirm.tourNo, '71203');
  assert.equal(batch.sourceGroups[0].tourConfirm.confirmedBy, '后勤09');
  // 先验流水写了(advisory 微任务落地,等一拍再断言)
  await new Promise((r) => setImmediate(r));
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].workspaceKey, '260710-小票06');
  // 非时效模式不入回发队列
  assert.equal(sendbacks.length, 0);
});

test('confirmTour:未命中表 422;allowPendingTable→表外待核;店不符必须选模式', () => {
  const { svc, logRows } = makeService({
    table: { 70299: { storeMismatch: true, modes: ['现代-JEOCU', '新世界SG-振华 不用记'] } },
  });
  const batch = makeBatch([receipt('t1', { auto: '99999' })]);
  assert.throws(() => svc.confirmTour(batch, 'group_a', { tourNo: '99999' }), /未命中团号表/);

  const out = svc.confirmTour(batch, 'group_a', { tourNo: '99999', allowPendingTable: true });
  assert.equal(out.tourConfirm.status, 'pending_table');
  assert.equal(logRows.length, 0, '表外待核不进先验');

  const batch2 = makeBatch([receipt('t1', { auto: '70299' })]);
  assert.throws(() => svc.confirmTour(batch2, 'group_a', { tourNo: '70299' }), /对应多个模式/);
  const ok = svc.confirmTour(batch2, 'group_a', { tourNo: '70299', mode: '现代-JEOCU' });
  assert.equal(ok.tourConfirm.mode, '现代-JEOCU');
});

test('confirmTour:发12号/S活动等时效模式确认即入回发队列', async () => {
  const { svc, sendbacks } = makeService({ table: { 26115282: { mode: '乐天B团-joy(发12号)' } } });
  const batch = makeBatch([receipt('t1', { auto: '26115282' })]);
  const out = svc.confirmTour(batch, 'group_a', { tourNo: '26115282' });
  assert.equal(out.sendbackAction, 'send_12');
  await new Promise((r) => setImmediate(r)); // 入队是 advisory 微任务
  assert.equal(sendbacks.length, 1);
  assert.equal(sendbacks[0].action, 'send_12');
});

test('confirmTour 幂等:同内容重复提交不堆 revisions(双标签页/重试)', async () => {
  const { svc } = makeService({ table: { 71203: { mode: '乐天SG-本司' } } });
  const batch = makeBatch([receipt('t1', { auto: '71203', status: 'matched' })]);
  svc.confirmTour(batch, 'group_a', { tourNo: '71203' });
  svc.confirmTour(batch, 'group_a', { tourNo: '71203' }); // 重复提交
  assert.equal(batch.sourceGroups[0].tourConfirm.revisions.length, 0, '同内容不算更正');
  svc.confirmTour(batch, 'group_a', { tourNo: '71203', mode: '乐天SG-本司' }); // 仍同内容
  assert.equal(batch.sourceGroups[0].tourConfirm.revisions.length, 0);
});

test('unconfirmTour:旧确认进revisions+清任务回执;slim曾生效强制清reviewed;已结算409', () => {
  const { svc } = makeService({
    table: { 55555: { mode: '新世界SG-振华 不用记' } },
    slim: '新世界SG-振华 不用记',
  });
  const batch = makeBatch([
    receipt('t1', { auto: '55555' }),
    receipt('t2', {}),
  ]);
  svc.confirmTour(batch, 'group_a', { tourNo: '55555' });
  // 模拟按 slim 车道免审通过
  batch.tasks[0].reviewed = true;
  batch.tasks[1].reviewed = true;

  const out = svc.unconfirmTour(batch, 'group_a', { operator: 'admin01', reason: '选错团' });
  assert.equal(out.wasSlim, true);
  assert.equal(out.reviewCleared, 2);
  assert.equal(batch.tasks[0].reviewed, false);
  assert.equal(batch.tasks[0].tourConfirmedAt, '');
  const tc = batch.sourceGroups[0].tourConfirm;
  assert.equal(tc.status, '');
  assert.equal(tc.revisions.length, 1);
  assert.equal(tc.revisions[0].tourNo, '55555');

  // 已结算组不许撤
  const settled = makeBatch([receipt('t1', { auto: '55555' })], { settlementStatus: 'settled' });
  svc.confirmTour(settled, 'group_a', { tourNo: '55555' });
  settled.sourceGroups[0].settlementStatus = 'settled';
  assert.throws(() => svc.unconfirmTour(settled, 'group_a', {}), /已结算/);
});

test('assertTourConfirmed 硬闸:ENV关不拦;开了拦未确认,放行已确认/豁免/表外待核', () => {
  const off = makeService({ table: { 71203: { mode: 'M' } } });
  const batchU = makeBatch([receipt('t1', { auto: '71203' })]);
  off.svc.assertTourConfirmed(batchU, 'group_a'); // 默认关,不抛

  const on = makeService({ table: { 71203: { mode: 'M' } }, requireConfirm: 'true' });
  assert.throws(() => on.svc.assertTourConfirmed(batchU, 'group_a'), /团号还没确认/);
  on.svc.confirmTour(batchU, 'group_a', { tourNo: '71203' });
  on.svc.assertTourConfirmed(batchU, 'group_a'); // 已确认放行

  const exemptBatch = makeBatch([{ id: 'p1', sourceGroupKey: 'group_a', docTypeFinal: 'passport' }]);
  on.svc.assertTourConfirmed(exemptBatch, 'group_a'); // 豁免放行
});
