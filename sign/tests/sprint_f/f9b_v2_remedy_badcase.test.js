'use strict';

/**
 * f9b_v2_remedy_badcase — Sprint F F9b contract tests
 *
 * 1. api/v2/badcases.js 提供 4 个 wrapper (走 axios client)
 * 2. 2 条路由都到位 + admin/reviewer 鉴权
 * 3. DailyRemedyView 复用 F4 ledger API,按 tourMatchStatus 拉需要补救的行
 * 4. DailyRemedyView submitMode 通过 updateLedgerFields 写 modeRaw + manualRemedyConfirm
 * 5. RemedyView MODE_OPTIONS 7 个模式齐全
 * 6. BadcaseView 4 个 API 都 import + Drawer 详情
 * 7. BadcaseView ALL_VERDICTS 4 个 (pending/wrong_match/should_match/acceptable)
 * 8. BadcaseView submitBadcaseVerdict 带 userNote + userVerdict
 * 9. 两个 view 都解码 service_unavailable (F2)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F9b t1: api/v2/badcases.js exports 4 wrappers via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/badcases.js'), true);
  const src = read('frontend/src/api/v2/badcases.js');
  ['fetchBadcases', 'fetchBadcaseSummary', 'fetchBadcaseDetail', 'submitBadcaseVerdict']
    .forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  assert.match(src, /from ['"]\.\.\/client['"]/);
  assert.match(src, /\/badcases/);
  assert.match(src, /\/verdict/);
});

test('F9b t2: monthly remedy route redirects to daily remedy; badcase remains monthly', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/remedy'));
  assert.ok(router.includes('/daily/remedy'));
  assert.equal(router.includes("name: 'v2-monthly-remedy'"), false);
  assert.equal(router.includes('../views/v2/RemedyView.vue'), false);
  assert.ok(router.includes('/monthly/v2/:workspaceKey/badcases'));
  assert.ok(router.includes("name: 'v2-monthly-badcases'"));
  ['DailyRemedyView.vue', 'BadcaseView.vue']
    .forEach((f) => assert.match(router, new RegExp(f), f));
  assert.match(router, /v2-monthly-badcases[\s\S]*?roles:\s*\[['"]admin['"]\s*,\s*['"]reviewer['"]\]/);
});

test('F9b t3: DailyRemedyView reuses F4 ledger API filtered by tourMatchStatus', () => {
  assert.equal(exists('frontend/src/views/DailyRemedyView.vue'), true);
  assert.equal(exists('frontend/src/views/v2/RemedyView.vue'), false);
  const view = read('frontend/src/views/DailyRemedyView.vue');
  assert.match(view, /from ['"]@\/api\/v2\/ledger['"]/);
  ['fetchLedger', 'updateLedgerFields']
    .forEach((n) => assert.match(view, new RegExp(n), n));
  // 0731:这份状态清单从视图里搬到了 lib/remedyStatuses.js —— 审核台页签的
  // 承接角标要用**同一份**口径,两处各自维护必然漂(角标显示 3、点进去看见 7)。
  // 断言跟着口径走:清单存在、只有一份、补救页从那儿引。
  assert.match(view, /import\s*\{\s*REMEDY_TOUR_STATUSES\s*\}\s*from\s*['"]@\/lib\/remedyStatuses['"]/,
    '补救页要引用共享的状态清单,不要再内联一份');
  const statuses = read('frontend/src/lib/remedyStatuses.js');
  assert.match(statuses, /REMEDY_TOUR_STATUSES\s*=\s*Object\.freeze\(\[/);
  ['tour_not_found', 'tour_ambiguous', 'date_out_of_window', 'mode_unresolved']
    .forEach((s) => assert.match(statuses, new RegExp(`'${s}'`), s));
  assert.match(view, /tourMatchStatus:\s*status/);
  assert.doesNotMatch(view, /ledgerStatus:\s*['"]remedy['"]/);
});

test('F9b t4: DailyRemedyView submitMode writes modeRaw + manual flag only', () => {
  const view = read('frontend/src/views/DailyRemedyView.vue');
  assert.match(view, /function submitMode|async function submitMode/);
  assert.match(view, /modeRaw:\s*mode/);
  assert.match(view, /manualRemedyConfirm:\s*true/);
  assert.doesNotMatch(view, /ready_to_post/);
  assert.doesNotMatch(view, /remedyReason:\s*null/);
});

test('F9b t5: DailyRemedyView 模式选项动态全枚举(不写死 7 枚举)', () => {
  const view = read('frontend/src/views/DailyRemedyView.vue');
  // 新设计(2026-06):待补救模式下拉 = 工作区台账出现的全部「组合模式」(店铺·分店·返点模式),
  // 与「模式分桶」同源 fetchModeMapping,不再写死老 7 枚举(也消除 蕊新/本司 拼写不一致)。
  assert.match(view, /fetchModeMapping/, '应从 fetchModeMapping 动态取模式全枚举');
  assert.match(view, /modeOptionsFor/, '应有 modeOptionsFor 提供下拉选项');
  // 不再硬编码老枚举(蕊新 兜底已删)
  assert.ok(!view.includes('蕊新'), '不应再写死 蕊新 兜底枚举');
});

test('F9b t6: BadcaseView imports 4 badcase APIs + uses Drawer', () => {
  assert.equal(exists('frontend/src/views/v2/BadcaseView.vue'), true);
  const view = read('frontend/src/views/v2/BadcaseView.vue');
  assert.match(view, /from ['"]@\/api\/v2\/badcases['"]/);
  ['fetchBadcases', 'fetchBadcaseSummary', 'fetchBadcaseDetail', 'submitBadcaseVerdict']
    .forEach((n) => assert.match(view, new RegExp(n), n));
  assert.match(view, /from ['"]@\/components\/ui\/drawer\.vue['"]/);
  assert.match(view, /from ['"]@\/components\/v2\/DataTable\.vue['"]/);
});

test('F9b t7: BadcaseView ALL_VERDICTS 4 values + 统一字典 label', () => {
  const view = read('frontend/src/views/v2/BadcaseView.vue');
  assert.match(view, /ALL_VERDICTS\s*=\s*\[\s*['"]pending['"]\s*,\s*['"]wrong_match['"]\s*,\s*['"]should_match['"]\s*,\s*['"]acceptable['"]\s*\]/);
  // verdict label 已统一到 lib/statusLabels.js(BADCASE_VERDICT);校验页面引用字典 + 字典含 label
  assert.match(view, /VERDICT_LABEL\s*=\s*BADCASE_VERDICT/);
  const labels = read('frontend/src/lib/statusLabels.js');
  ['未处理', '匹配错了', '应该匹配上', '可接受'].forEach((label) => assert.ok(labels.includes(label), label));
});

test('F9b t8: BadcaseView submitVerdict carries userNote + userVerdict', () => {
  const view = read('frontend/src/views/v2/BadcaseView.vue');
  assert.match(view, /function submitVerdict|async function submitVerdict/);
  assert.match(view, /submitBadcaseVerdict\(workspaceKey\.value,\s*id,\s*\{/);
  assert.match(view, /userNote:\s*noteDraft\.value/);
  assert.match(view, /userVerdict:\s*verdictDraft\.value/);
});

test('F9b t9: both views decode service_unavailable (F2 alignment)', () => {
  ['frontend/src/views/DailyRemedyView.vue', 'frontend/src/views/v2/BadcaseView.vue']
    .forEach((p) => assert.match(read(p), /service_unavailable/, p));
});
