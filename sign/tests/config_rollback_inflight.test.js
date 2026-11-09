'use strict';

/**
 * 点2:配置版本 activate 回滚对「在飞审核」的影响(配置台↔审核链路,docs/边界测试设计.md 域4)。
 *
 * 链路(全真实件,不 mock resolver):
 *   POST /modes/:name/activate [routes/config_console_routes.js:226]
 *     → modeConfigRepository.activateVersion(翻 active 位 + stamp bump)[repositories/mode_config_repository.js:164]
 *     → review_config_resolver.ensureFresh 按水位清缓存 [services/review_config_resolver.js:116]
 *     → workbench_task_flow.getRequiredFieldRules 即时换版 [lib/workbench_task_flow.js:356]
 *
 * 关键事实(源码勘察实证):
 *   - PATCH(services/workbench_write/task.js updateTask)只做 validateTaskPatch 格式校验 + recalc,
 *     **不卡必填集**;必填集卡在「确认」闸=lib/workbench_group_review.getTaskFinalApprovalIssue:101
 *     (approveSourceGroupTasks:168 逐票查)。所以"提交 PATCH 被新必填卡住"的真实形态是
 *     "PATCH 落库成功、终审确认被卡"——本文件按确认闸锁行为。
 *   - 前端 payload 白名单=出厂富定义 ∪ extraAllowedKeys(断点⑥,frontend/src/lib/reviewFieldConfig.js:376);
 *     extras 由 runtimeReviewConfig 按 /api/review-config 注入(configVersion>0 才有,拉不到=[])。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createReviewConfigResolver } = require('../services/review_config_resolver');
const {
  getTaskRequiredFieldChecks,
  deriveTaskState,
  setReviewConfigResolver,
  PROCESS_RESULTS,
} = require('../lib/workbench_task_flow');
const { getTaskFinalApprovalIssue } = require('../lib/workbench_group_review');
const { PROFILES } = require('../lib/store_profiles');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

const MODE = '乐天SG-本司';

// 在飞任务:操作员在配置A(relax 出境日期)生效期间审到"除出境日期全齐"
const INFLIGHT_TASK = Object.freeze({
  id: 'task_inflight',
  docTypeAuto: 'receipt',
  docTypeFinal: 'receipt',
  classificationConfirmed: true,
  receiptStoreFinal: 'LOTTE',
  receiptNoFinal: '12345678901234',
  groupNoFinal: '26907555',
  purchaseDateFinal: '2026-07-01',
  departureDateFinal: '', // relax 目标字段,未填
  modeRawPre: MODE,
  groupNoMatchStatus: 'matched', // 模式微调时序墙:仅 matched 后叠加
});

function fieldKeys(task) {
  return getTaskRequiredFieldChecks(task).checks.map((c) => c.finalKey);
}

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-rollback-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const resolver = createReviewConfigResolver({
    modeConfigRepository: repository,
    logger: { warn: () => {}, info: () => {} },
  });
  t.after(() => {
    setReviewConfigResolver(null); // 全局钩子必复位(review_config_resolver.test.js 同约定)
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository, resolver };
}

async function loadFrontendPure() {
  return import(pathToFileURL(path.join(__dirname, '../frontend/src/lib/reviewFieldConfig.js')).href);
}

/**
 * 模拟 runtimeReviewConfig 的注入契约(不直接 import:那会拖 vue/api client,
 * frontend_review_runtime_config.test.js 同款分层手法):
 *   /api/review-config [routes/config_console_routes.js:790] → stores[family].configVersion = active 版本号|0
 *   runtimeDeptFields [frontend/src/lib/runtimeReviewConfig.js:46]:configVersion>0 才返回 fields,否则 null
 *   runtimeDeptExtraPayloadKeys [runtimeReviewConfig.js:76]:fields 短名 → DEPT_KEY_TO_FINAL 映射,null→[]
 */
function extrasFor(repository, family, DEPT_KEY_TO_FINAL) {
  const row = repository.getActive('store', family);
  const configVersion = row?.version || 0;
  if (!(configVersion > 0)) return [];
  const fields = Array.isArray(row?.payload?.fields) ? row.payload.fields : null;
  if (!fields) return [];
  return fields.map((key) => DEPT_KEY_TO_FINAL[key]).filter(Boolean);
}

// ── 主场景:回滚收紧(配置A relax → activate 回配置B 无relax)────────────────────

test('回滚收紧:relax 下确认可过 → activate 回旧版 → 同一在飞任务被出境日期卡(即时换版,无需手动失效)', (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);

  // v1 = 配置B(无 review 微调);v2 = 配置A(relax 出境日期),保存即生效
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: { columns: { ...ALL_COLUMNS } } });
  repository.saveNewVersion({
    kind: 'mode', name: MODE,
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['departureDateFinal'] } },
  });

  // 配置A 生效:出境日期不在必填集,确认闸放行
  assert.ok(!fieldKeys(INFLIGHT_TASK).includes('departureDateFinal'), '配置A relax 生效');
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '', '配置A 下确认可过');
  assert.equal(deriveTaskState(INFLIGHT_TASK).processResult, PROCESS_RESULTS.FINAL_REVIEW);

  // 一键回滚到 v1(路由 activate 的存储层动作;stamp bump 是缓存失效的全部依据)
  const stampBefore = repository.maxStamp();
  repository.activateVersion('mode', MODE, 1);
  assert.equal(repository.maxStamp(), stampBefore + 1, 'activate 翻 active 位不产新行,也必须 bump stamp');

  // 同一任务、同一进程、零手动 invalidate:必填集即时收紧,确认被卡(如实锁行为)
  assert.ok(fieldKeys(INFLIGHT_TASK).includes('departureDateFinal'), '回滚后出境日期回到必填集');
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '还缺出境日期', '在飞任务确认被新必填卡住(合理阻断)');
  assert.equal(deriveTaskState(INFLIGHT_TASK).processResult, PROCESS_RESULTS.FIELDS);
});

test('回滚收紧≠死循环:被卡字段在前端 payload 出厂白名单内,补值即通过(断点⑥并集兜住出厂字段)', async (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: { columns: { ...ALL_COLUMNS } } });
  repository.saveNewVersion({
    kind: 'mode', name: MODE,
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['departureDateFinal'] } },
  });
  repository.activateVersion('mode', MODE, 1); // 回滚,出境日期重新必填

  const { buildReviewFieldPayload } = await loadFrontendPure();
  // 操作员在草稿里补出境日期;extras=[](免税店无店档案配置)→ 纯出厂白名单
  const payload = buildReviewFieldPayload('receipt', { ...INFLIGHT_TASK, departureDateFinal: '2026-07-05' }, []);
  assert.equal(payload.departureDateFinal, '2026-07-05', '出厂字段在白名单内,补的值不被置空');
  // 其余已填值也原样保留(字段集变窄→变宽的往返里,出厂侧值绝不丢)
  assert.equal(payload.receiptNoFinal, '12345678901234');
  assert.equal(payload.groupNoFinal, '26907555');

  const patched = { ...INFLIGHT_TASK, ...payload };
  assert.equal(getTaskFinalApprovalIssue(patched), '', '补值后确认通过——被卡但可解,非死循环');
});

test('回滚放宽:被卡任务 activate 到 relax 版本后立即可过;配置放宽不清已填值(丢数据红线)', async (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: { columns: { ...ALL_COLUMNS } } }); // v1 无relax,active
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '还缺出境日期', 'v1 下被卡(前置状态)');

  repository.saveNewVersion({
    kind: 'mode', name: MODE,
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['departureDateFinal'] } },
  }); // v2 relax,保存即生效
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '', '放宽即时生效,同任务确认可过');

  // 红线:另一张已填出境日期的票,配置放宽后前端保存不清它(并集只增不减,出厂侧恒在)
  const { buildReviewFieldPayload } = await loadFrontendPure();
  const filled = buildReviewFieldPayload('receipt', { ...INFLIGHT_TASK, departureDateFinal: '2026-07-05' }, []);
  assert.equal(filled.departureDateFinal, '2026-07-05', '配置放宽(relax)绝不清已填值');

  // 往返回滚:v2(relax)→ activate v1 → 再 activate v2,行为可逆无残留
  repository.activateVersion('mode', MODE, 1);
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '还缺出境日期');
  repository.activateVersion('mode', MODE, 2);
  assert.equal(getTaskFinalApprovalIssue(INFLIGHT_TASK), '');
});

// ── 店档案通道:配置加字段(extraAllowedKeys)× 回落 ────────────────────────────

test('店档案配置加字段:后端必填与前端 extras 同源生效;deactivate 回落后必填即时退场', async (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);
  const { buildReviewFieldPayload, DEPT_KEY_TO_FINAL } = await loadFrontendPure();

  // 乐天百货出厂档案无「上家」(store_profiles.js LOTTE_DEPT.fields)——配置勾上=配置加字段
  const factoryFields = [...PROFILES.LOTTE_DEPT.fields];
  assert.ok(!factoryFields.includes('upstream'), '前提:出厂档案不含上家(否则本例失义)');
  repository.saveNewVersion({
    kind: 'store', name: 'LOTTE_DEPT',
    payload: { fields: [...factoryFields, 'upstream'] },
  });

  const deptTask = {
    docTypeAuto: 'receipt', docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT', extractedNameFinal: 'HOANG NGOC BAO', passportNoFinal: 'EJ9626615',
    receiptNoFinal: '12345678', receiptAmountFinal: '3500000', branchFinal: '0394',
    brandFinal: '루이비통', purchaseDateFinal: '2026-07-01', upstreamFinal: '',
  };

  // 后端:配置命中 → 上家进必填集,没填=确认被卡
  assert.ok(fieldKeys(deptTask).includes('upstreamFinal'), '配置加的字段进后端必填集');
  assert.equal(getTaskFinalApprovalIssue(deptTask), '还缺上家');

  // 前端:extras 注入(runtimeReviewConfig 契约模拟)→ 填的值保留 → 确认通过(断点⑥闭环)
  const extras = extrasFor(repository, 'LOTTE_DEPT', DEPT_KEY_TO_FINAL);
  assert.ok(extras.includes('upstreamFinal'), 'configVersion>0 → extras 含配置补充键');
  const payload = buildReviewFieldPayload('receipt', { ...deptTask, upstreamFinal: ' 梁总 ' }, extras);
  assert.equal(payload.upstreamFinal, '梁总', 'extras 并集白名单保住配置字段的已填值');
  assert.equal(getTaskFinalApprovalIssue({ ...deptTask, ...payload }), '', '前后端同源:填值→保存→确认全通');

  // deactivate 回落出厂:后端必填即时退场,没填上家的票不再被卡
  repository.deactivate('store', 'LOTTE_DEPT');
  assert.ok(!fieldKeys(deptTask).includes('upstreamFinal'), '回落后配置字段退出必填集');
  assert.equal(getTaskFinalApprovalIssue(deptTask), '', '回落后确认不再被上家卡');
});

test('配置回落后的已填值:出厂字段保留(红线);配置加的字段下次保存被清(真实行为=切店清残留同款语义,如实锁死)', async (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);
  const { buildReviewFieldPayload, DEPT_KEY_TO_FINAL } = await loadFrontendPure();

  repository.saveNewVersion({
    kind: 'store', name: 'LOTTE_DEPT',
    payload: { fields: [...PROFILES.LOTTE_DEPT.fields, 'upstream'] },
  });
  // 配置生效期间操作员已把上家落库
  const stored = {
    docTypeAuto: 'receipt', docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT', extractedNameFinal: 'HOANG NGOC BAO', passportNoFinal: 'EJ9626615',
    receiptNoFinal: '12345678', receiptAmountFinal: '3500000', branchFinal: '0394',
    brandFinal: '루이비통', purchaseDateFinal: '2026-07-01', upstreamFinal: '梁总',
  };

  // 配置回落(deactivate → /api/review-config configVersion=0 → runtimeDeptFields null → extras=[])
  repository.deactivate('store', 'LOTTE_DEPT');
  const extrasAfter = extrasFor(repository, 'LOTTE_DEPT', DEPT_KEY_TO_FINAL);
  assert.deepEqual(extrasAfter, [], 'configVersion=0 → extras 空数组(runtimeReviewConfig.js:49 契约)');

  const payload = buildReviewFieldPayload('receipt', stored, extrasAfter);
  // 红线侧:出厂富定义字段的已填值一个不丢
  assert.equal(payload.brandFinal, '루이비통');
  assert.equal(payload.receiptAmountFinal, '3500000');
  assert.equal(payload.branchFinal, '0394');
  assert.equal(payload.passportNoFinal, 'EJ9626615');
  // ⚠️真实行为:配置加的字段回落后不在白名单(出厂∪extras 都没它)→ 下次保存置空。
  // 与「切店清残留」同一套白名单语义(reviewFieldConfig.js:379 注释),红线原文只承诺出厂侧
  // (reviewFieldConfig.js:373「配置放宽某**出厂字段**时…绝不被清」)。业务上这意味着:
  // 店档案回滚后,配置期已填的上家会在该票下一次保存时静默丢——要保值须先导出或回滚前清点。
  // 如实锁死;若业务判定这是丢数据,应改 runtime 层在 extras 之外并入「任务已有非空值」的键。
  assert.equal(payload.upstreamFinal, '', '配置加的字段:回落后下次保存被清(当前实现语义)');
  // 后端侧此时已不必填,清掉不会引发确认死循环
  assert.equal(getTaskFinalApprovalIssue({ ...stored, ...payload }), '', '值被清但不再必填,不产生卡审');
});

test('拉取失败窗口(如实锁行为):后端配置必填 + 前端 extras 拉不到=[] → 保存清值→确认被卡(60s TTL 自愈窗口)', async (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);
  const { buildReviewFieldPayload } = await loadFrontendPure();

  repository.saveNewVersion({
    kind: 'store', name: 'LOTTE_DEPT',
    payload: { fields: [...PROFILES.LOTTE_DEPT.fields, 'upstream'] },
  });
  const stored = {
    docTypeAuto: 'receipt', docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT', extractedNameFinal: 'HOANG NGOC BAO', passportNoFinal: 'EJ9626615',
    receiptNoFinal: '12345678', receiptAmountFinal: '3500000', branchFinal: '0394',
    brandFinal: '루이비통', purchaseDateFinal: '2026-07-01', upstreamFinal: '梁总',
  };
  assert.equal(getTaskFinalApprovalIssue(stored), '', '配置生效+值已填=可确认(前置)');

  // runtimeReviewConfig 拉取失败静默吞(runtimeReviewConfig.js:33 catch)→ extras=[](配置仍在后端生效)
  const payloadOnFetchFail = buildReviewFieldPayload('receipt', stored, []);
  assert.equal(payloadOnFetchFail.upstreamFinal, '', '失败窗口内保存会清配置字段的值');
  assert.equal(
    getTaskFinalApprovalIssue({ ...stored, ...payloadOnFetchFail }),
    '还缺上家',
    '清值后确认被后端必填卡——窗口期真实存在,自愈=TTL 60s 重拉后 extras 恢复(设计取舍:审核台永不因配置台挂)'
  );
});
