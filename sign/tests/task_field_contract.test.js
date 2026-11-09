'use strict';

/**
 * 任务字段契约守卫(2026-07-13 架构体检防线,针对"同一份知识写在N处靠人记"元根因):
 *
 * 病史:任务级字段的知识散在四处清单(normalizeTask 白名单 / EDITABLE_FIELD_KEYS /
 * 改类型清场 / snapshot),漏任一处=一次生产事故——
 *   - normalizeTask 漏 owner 三件套 → 批次无主(操作员看不到自己批次狂建重复)
 *   - 清场漏 tourStance 三件套 → 登机牌改类型后旧表态回放,回执计数被污染
 *
 * 本测试把字段分类事实**声明一次**,机器交叉核对各处清单:
 * 以后加任务级字段,先在这里登记——漏同步哪处,哪处红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchNormalizers } = require('../lib/workbench_normalizers');
const { clearEditableFieldsForDocTypeSwitch } = require('../lib/workbench_task_flow');
const { DOC_TYPES } = require('../lib/package_constants');

// ── 字段契约:单一声明处已升正为 lib/field_registry.js(配置台P0/T1)──
//   本测试从注册表派生同形状 FIELD_CONTRACT,守卫逻辑一行不动:
//   persisted=normalizeTask 必须保留;clearOnSwitch=改类型必须清场。
//   以后加任务级字段:先进 lib/field_registry.js 登记(带 contract 三件套)。
const { FIELD_REGISTRY, contractEntries } = require('../lib/field_registry');

const FIELD_CONTRACT = contractEntries();

function buildTaskWithSentinels() {
  const task = {
    id: 'task_contract',
    docTypeAuto: DOC_TYPES.RECEIPT,
    docTypeFinal: DOC_TYPES.RECEIPT,
    sourceOriginalPath: 'ws/CL1/01-a.jpg',
  };
  for (const f of FIELD_CONTRACT) task[f.key] = f.sentinel;
  return task;
}

test('契约①:persisted 字段必须活过 normalizeTask(白名单漏项=存盘即抹,批次无主事故同款)', () => {
  const { normalizeTask } = createWorkbenchNormalizers();
  const out = normalizeTask(buildTaskWithSentinels());
  for (const f of FIELD_CONTRACT.filter((x) => x.persisted)) {
    assert.deepEqual(out[f.key], f.sentinel, `normalizeTask 白名单漏了 ${f.key}(存盘即抹)`);
  }
});

test('契约②:clearOnSwitch 字段在改文档类型时必须清场(登机牌表态回放事故同款)', () => {
  const cleared = clearEditableFieldsForDocTypeSwitch(buildTaskWithSentinels(), DOC_TYPES.OTHER);
  for (const f of FIELD_CONTRACT.filter((x) => x.clearOnSwitch)) {
    const expected = 'clearedValue' in f ? f.clearedValue : '';
    assert.deepEqual(cleared[f.key], expected, `改类型清场漏了 ${f.key}(残留会跨类型串数据)`);
  }
  // 反向:不该清的别误清
  for (const f of FIELD_CONTRACT.filter((x) => !x.clearOnSwitch)) {
    assert.deepEqual(cleared[f.key], f.sentinel, `${f.key} 不在清场清单里,不该被误清`);
  }
});

// ── 交叉锁定:前端百货面板必须与 store_profiles 档案一致(手抄副本漂移防线)──
// 病史:reviewFieldConfig 的 DEPT_FIELD_CONFIGS 是档案的人肉副本,旧测试是快照式
// (hardcode 期望),改档案前端测试不会红。这里改成**从档案派生期望**。
const PROFILE_FIELD_TO_FINAL_KEY = {
  passportNo: 'passportNoFinal',
  extractedName: 'extractedNameFinal',
  receiptNo: 'receiptNoFinal',
  receiptAmount: 'receiptAmountFinal',
  branch: 'branchFinal',
  brand: 'brandFinal',
  upstream: 'upstreamFinal',
  purchaseDate: 'purchaseDateFinal',
};

test('契约③:百货审核面板字段 = store_profiles 档案派生(改档案漏同步前端 → 这里红)', async () => {
  const { PROFILES, FAMILY, getStoreProfile } = require('../lib/store_profiles');
  const { getReviewFieldConfig } = await import('../frontend/src/lib/reviewFieldConfig.js');
  for (const [storeKey, profile] of Object.entries(PROFILES)) {
    if (profile.family !== FAMILY.DEPT) continue;
    const cfg = getReviewFieldConfig('receipt', storeKey);
    const cfgKeys = new Set(cfg.fields.map((f) => f.key));
    for (const profileField of profile.fields) {
      const finalKey = PROFILE_FIELD_TO_FINAL_KEY[profileField];
      assert.ok(finalKey, `${storeKey} 档案字段 ${profileField} 没有面板键映射——先补 PROFILE_FIELD_TO_FINAL_KEY`);
      assert.ok(cfgKeys.has(finalKey), `${storeKey} 档案声明了 ${profileField},面板缺 ${finalKey}(手抄副本漂移)`);
    }
    // 枚举选项同源:上家/品牌按钮必须等于档案 rules(多/少/改名都算漂移)
    const upstreamField = cfg.fields.find((f) => f.key === 'upstreamFinal');
    if (upstreamField && Array.isArray(profile.rules?.upstream)) {
      assert.deepEqual(
        upstreamField.options.map((o) => o.value), [...profile.rules.upstream],
        `${storeKey} 上家选项与档案 rules.upstream 漂移`
      );
    }
    const brandField = cfg.fields.find((f) => f.key === 'brandFinal');
    if (brandField && Array.isArray(profile.rules?.brand) && Array.isArray(brandField.options)) {
      assert.deepEqual(
        brandField.options.map((o) => o.value), [...profile.rules.brand],
        `${storeKey} 品牌选项与档案 rules.brand 漂移`
      );
    }
  }
  assert.ok(getStoreProfile('LOTTE_DEPT').family === FAMILY.DEPT, '档案自检');
});

// ── 谓词一致性:'这张票算不算完成/通过' 的两套前端实现不许分叉(714/716 打架土壤)──
test('契约④:taskStatus 与 reviewDisplay 对"已通过"判定一致', async () => {
  const { getTaskStatusState } = await import('../frontend/src/lib/taskStatus.js');
  const { isTaskApproved } = await import('../frontend/src/lib/reviewDisplay.js');
  const fixtures = [
    { reviewed: true },
    { reviewed: false, processResult: 'approved' },
    { reviewed: false, processResult: '已通过' },
    { reviewed: false, processResult: '' },
    { reviewed: false, processResult: 'classify' },
    { reviewed: false, rephotoRequested: true },
    { reviewed: true, rephotoRequested: true }, // 重拍优先显示,但"算通过"口径两边必须一致解读
  ];
  for (const t of fixtures) {
    const badgeApproved = getTaskStatusState(t).label === '已通过';
    const displayApproved = isTaskApproved(t) && !t.rephotoRequested; // 徽章重拍优先
    assert.equal(
      badgeApproved, displayApproved,
      `谓词分叉: ${JSON.stringify(t)} → 徽章=${badgeApproved} 队列=${displayApproved}`
    );
  }
});

test('字段注册表:key 唯一、label 非空、source 合法(配置台词汇表基线)', () => {
  const keys = FIELD_REGISTRY.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, '注册表 key 重复');
  for (const field of FIELD_REGISTRY) {
    assert.ok(String(field.label || '').trim(), `${field.key} 缺 label`);
    assert.ok(['manual', 'ocr', 'derived'].includes(field.source), `${field.key} source 非法`);
    assert.ok(Array.isArray(field.docTypes) && field.docTypes.length, `${field.key} 缺 docTypes`);
  }
  // 契约条目数守恒:搬家绝不许弄丢守卫面(2026-07-14 搬家时=17 条,只许增不许减)
  assert.ok(contractEntries().length >= 17, '契约条目变少了——有人删了守卫字段?');
});

test('反向守卫(毒字段探测):未注册的野字段绝不被 normalizeTask 保留(白名单不漏水)', () => {
  const { normalizeTask } = createWorkbenchNormalizers({ DOC_TYPES });
  const task = buildTaskWithSentinels();
  task.__unregisteredPoisonField = '毒';
  task.someRandomNewField = '毒2';
  const normalized = normalizeTask(task);
  assert.equal(normalized.__unregisteredPoisonField, undefined);
  assert.equal(normalized.someRandomNewField, undefined);
});
