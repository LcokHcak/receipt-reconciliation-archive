'use strict';

// P3c-3 契约:审核台运行时拉配置——只过滤百货面板**渲染**,清场语义(置空白名单)绝不接过滤器。
// 雷点回放:buildReviewFieldPayload 把字段集当"不在集=置空"的白名单;若接 Runtime 过滤,
// 配置放宽某字段 → 票上已填的该字段在下次保存时被清掉(丢数据)。这条测试锁死分界。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('runtimeReviewConfig:60s TTL+静默失败+configVersion>0 才过滤(出厂店零变化)', () => {
  const lib = read('frontend/src/lib/runtimeReviewConfig.js');
  for (const marker of [
    "get('/review-config')",     // 公开端点(登录即可,非 admin)
    'TTL_MS = 60_000',           // 60s 缓存
    '.catch(',                   // 拉取失败静默,审核台永不因配置挂
    'configVersion > 0',         // 出厂(=0)不过滤=逐字节零变化
    'ref(',                      // Vue ref:拉到后面板 computed 自动重渲
  ]) {
    assert.ok(lib.includes(marker), `runtimeReviewConfig 缺 ${marker}`);
  }
});

test('reviewFieldConfig 保持纯模块;过滤器纯函数;清场语义绝不接过滤(丢数据红线)', () => {
  const lib = read('frontend/src/lib/reviewFieldConfig.js');
  // ⭐纯度红线:node 口径测试直接执行本文件,引入 vue/axios 会 15 连红(实测教训)
  assert.ok(!lib.includes("from './runtimeReviewConfig"), 'reviewFieldConfig 禁止 import runtime 模块(纯度)');
  assert.ok(lib.includes('export function applyDeptFieldFilter'), '缺纯过滤器导出');
  assert.ok(lib.includes('export function getDeptPanelBase'), '缺纯定位器导出');
  assert.ok(lib.includes('DEPT_KEY_TO_FINAL'), '缺短名→finalKey 映射');
  assert.ok(lib.includes('FALLBACK_DEPT_FIELD_DEFS'), '缺兜底格(配置勾了但富定义没有的字段)');
  assert.ok(lib.includes("field.key === 'receiptStoreFinal' || wanted.has(field.key)"), '店字段必须恒保留');

  // ⭐红线:清场语义必须用原版 getReviewFieldConfig,不许接 Runtime 过滤(否则配置放宽=保存清值丢数据)
  const payloadFn = lib.slice(lib.indexOf('export function buildReviewFieldPayload'));
  const payloadBody = payloadFn.slice(0, payloadFn.indexOf('\n}'));
  assert.ok(payloadBody.includes('getReviewFieldConfig('), 'buildReviewFieldPayload 须用原版字段集');
  assert.ok(!payloadBody.includes('getReviewFieldConfigRuntime('), 'buildReviewFieldPayload 禁用 Runtime 过滤版(丢数据雷)');

  // 组合版在 runtime 模块:过滤只发生在百货定位命中分支(小票/护照面板不碰——"别影响我的小票")
  const runtime = read('frontend/src/lib/runtimeReviewConfig.js');
  assert.ok(runtime.includes('export function getReviewFieldConfigRuntime'), '缺组合版导出');
  const runtimeFn = runtime.slice(runtime.indexOf('export function getReviewFieldConfigRuntime'));
  const runtimeBody = runtimeFn.slice(0, runtimeFn.indexOf('\n}'));
  assert.ok(runtimeBody.includes('getDeptPanelBase(docType, store)'), 'Runtime 过滤仅限百货定位命中');
  assert.ok(runtimeBody.includes('return getReviewFieldConfig(docType, store)'), '非百货必须原样走老函数');
});

test('FieldEditor 渲染点用 Runtime 版;后端公开端点存在', () => {
  const editor = read('frontend/src/components/FieldEditor.vue');
  assert.ok(editor.includes('getReviewFieldConfigRuntime(docType.value, draft.receiptStoreFinal)'), '面板渲染须走 Runtime 版');

  const routes = read('routes/config_console_routes.js');
  assert.ok(routes.includes("app.get('/api/review-config'"), '缺公开 review-config 端点');
  // 公开端点不得挂 requireAdmin 真调用(审核员也要拉);但必须有显式登录闸(复核MEDIUM)
  const idx = routes.indexOf("app.get('/api/review-config'");
  const seg = routes.slice(idx, idx + 600);
  assert.ok(!seg.includes('if (!requireAdmin(req, res))'), 'review-config 必须登录即可,不能卡 admin');
  assert.ok(seg.includes("if (!req.user) return res.status(401)"), 'review-config 需自带显式登录闸(不吃 requireAdmin 兜底)');
});

// ── 行为级(真执行,复核MEDIUM:字符串契约测不出逻辑错)──
const path2 = require('node:path');
const { pathToFileURL } = require('node:url');
const loadPure = () => import(pathToFileURL(path2.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewFieldConfig.js')));

test('applyDeptFieldFilter 真执行:null=同一引用;子集过滤店字段恒留;兜底格补尾', async () => {
  const { applyDeptFieldFilter, getDeptPanelBase } = await loadPure();
  const base = getDeptPanelBase('receipt', '现代百货');
  assert.ok(base && base.canonical === 'HYUNDAI_DEPT');

  // 零变化:没配置(null)必须返回**同一个对象**,不是等价副本
  assert.equal(applyDeptFieldFilter(base.config, null), base.config);
  // 配置=全集 → 同一引用(no-op 判定)。2026-07-17 起现代出厂无票级护照两项。
  const fullShortNames = ['receiptNo', 'receiptAmount', 'upstream', 'purchaseDate'];
  assert.equal(applyDeptFieldFilter(base.config, fullShortNames), base.config);
  // 旧 v1 配置还带 passportNo(出厂已下线该格)→ 兜底格补尾,不是同一引用;
  // 部署后应在配置台「回到默认」清掉旧 v1,这里锁"不崩且可见"的过渡行为。
  const legacy = applyDeptFieldFilter(base.config, [...fullShortNames, 'passportNo']);
  assert.notEqual(legacy, base.config);
  const legacyPassport = legacy.fields.find((f) => f.key === 'passportNoFinal');
  assert.ok(legacyPassport, '旧配置勾的字段以兜底格出现,不静默丢');
  // 复核 HIGH(2026-07-17):兜底身份格必须 optional——票面无护照,必填=永远填不满整店卡审
  assert.equal(legacyPassport.optional, true, '兜底护照格必须选填,否则旧v1配置部署即卡审');

  // 子集:去掉上家 → upstream 格消失,店字段(receiptStoreFinal)恒保留
  const filtered = applyDeptFieldFilter(base.config, ['receiptNo', 'receiptAmount', 'purchaseDate']);
  const keys = filtered.fields.map((f) => f.key);
  assert.ok(!keys.includes('upstreamFinal'));
  assert.ok(keys.includes('receiptStoreFinal'));
  assert.ok(keys.includes('receiptNoFinal'));

  // 配置勾了富定义没有的字段(现代没有 brand 格)→ 兜底格补尾,绝不出现"后端必审前端没格"
  const withBrand = applyDeptFieldFilter(base.config, ['receiptNo', 'brand']);
  const brandField = withBrand.fields.find((f) => f.key === 'brandFinal');
  assert.ok(brandField, '兜底格必须出现');
  assert.equal(withBrand.fields[withBrand.fields.length - 1].key, 'brandFinal');
});

test('getDeptPanelBase 真执行:护照/免税店小票/other 一律 null(小票红线:过滤永不波及)', async () => {
  const { getDeptPanelBase } = await loadPure();
  assert.equal(getDeptPanelBase('passport', ''), null);
  assert.equal(getDeptPanelBase('receipt', 'LOTTE'), null);      // 免税店小票
  assert.equal(getDeptPanelBase('other', '现代百货'), null);
  assert.ok(getDeptPanelBase('receipt', '乐天百货'));
});

test('断点⑥接线:runtime 包装导出齐全;FieldEditor/ReviewView 保存与草稿全走并集版', () => {
  const runtime = read('frontend/src/lib/runtimeReviewConfig.js');
  for (const marker of [
    'export function runtimeDeptExtraPayloadKeys',
    'export function buildReviewFieldPayloadRuntime',
    'export function normalizeReviewFieldsForTaskRuntime',
  ]) {
    assert.ok(runtime.includes(marker), `runtimeReviewConfig 缺 ${marker}`);
  }
  const editor = read('frontend/src/components/FieldEditor.vue');
  assert.ok(editor.includes('buildReviewFieldPayloadRuntime(docType.value, draft)'), '保存 payload 须走并集版');
  assert.ok(editor.includes('normalizeReviewFieldsForTaskRuntime(task || {})'), '草稿初始化须走并集版');
  const review = read('frontend/src/views/ReviewView.vue');
  assert.ok(review.includes('buildReviewFieldPayloadRuntime('), '批量通过须走并集版');
});
