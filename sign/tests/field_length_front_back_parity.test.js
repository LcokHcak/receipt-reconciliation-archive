'use strict';

/**
 * 票号/团号「长度规则」前后端对拍(2026-08-01)。
 *
 * 背景与上一处护照判定同型:同一条业务判据前后端各写一份,靠注释声称"已对齐"。
 * 实测抓到的是团号 —— 后端 2026-07-03 依据生产样本给**新世界免税店**加了 5 位规则
 * (TOUR_NO_LENGTH_BY_STORE.SHINSEGAE = 5),前端那张合并清单
 * STORES_WITH_LENGTH_RULE=['LOTTE','THE SHILLA','SHILLA IPARK'] 没跟上:
 *   validateTourNo('SHINSEGAE', '123456') → 后端 field_tour_no_invalid
 *   审核台 hasLenRule=false                → 界面一个提示都不给
 * 审核员看着没问题,存下去才被标问题。
 *
 * 还有一层更隐蔽的:票号与团号的**适用店不一样**(现代有票号长度、没有团号长度),
 * 一张合并清单表达不了;而前端长度是写死的 `LOTTE ? 14 : 13`,后端新世界/现代票号是 16。
 * 所以"只把 SHINSEGAE 加进旧清单"会让前端反过来要求 13 位 —— 比不校验更糟。
 * 这条测试因此逐店逐字段对拍**长度值本身**,不只是"这家店有没有规则"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  RECEIPT_NO_LENGTH_BY_STORE: BE_RECEIPT,
  TOUR_NO_LENGTH_BY_STORE: BE_TOUR,
  validateTourNo,
} = require('../lib/validation/field_rules');

// 前端是 ESM;剥掉 import/export 后取出两张表(复制一份常量来测=又造第三个读者)
function loadFrontendTables() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewFieldConfig.js'), 'utf8',
  );
  const body = src.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export /gm, '');
   
  return new Function(`
    ${body}
    return { RECEIPT_NO_LENGTH_BY_STORE, TOUR_NO_LENGTH_BY_STORE };
  `)();
}

test('⭐票号长度表:前后端逐店逐值一致', () => {
  const { RECEIPT_NO_LENGTH_BY_STORE: FE } = loadFrontendTables();
  assert.deepEqual({ ...FE }, { ...BE_RECEIPT },
    '前端票号长度表必须与 lib/validation/field_rules 完全一致(值也要一样,不只是店名)');
});

test('⭐团号长度表:前后端逐店逐值一致(新世界那条就是这么漏的)', () => {
  const { TOUR_NO_LENGTH_BY_STORE: FE } = loadFrontendTables();
  assert.deepEqual({ ...FE }, { ...BE_TOUR });
  assert.equal(FE.SHINSEGAE, 5, '后端 2026-07-03 加的这条,前端必须有');
  assert.ok(!('HYUNDAI' in FE), '现代没有团号长度规则——不许凭"看起来该有"补上去');
});

test('⭐两张表适用店不同,不能再用一张合并清单表达', () => {
  assert.ok('HYUNDAI' in BE_RECEIPT, '现代有票号长度');
  assert.ok(!('HYUNDAI' in BE_TOUR), '现代没有团号长度');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'components', 'FieldEditor.vue'), 'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /hasReceiptLenRule/, '票号的闸单独一个');
  assert.match(code, /hasTourLenRule/, '团号的闸单独一个');
  assert.doesNotMatch(code, /hasLenRule\b/, '合并闸不许再出现');
  assert.doesNotMatch(code, /receiptStore === 'LOTTE' \? 14 : 13/, '长度不许再写死');
  assert.doesNotMatch(code, /receiptStore === 'LOTTE' \? 8 : 5/, '长度不许再写死');
});

test('⭐输入框提示语按表生成,不写死位数(写死的话表一改它就说错)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewFieldConfig.js'), 'utf8',
  );
  const body = src.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export /gm, '');
   
  const { describeLengthRule, TOUR_NO_LENGTH_BY_STORE: FE_TOUR } = new Function(
    `${body}\nreturn { describeLengthRule, TOUR_NO_LENGTH_BY_STORE };`,
  )();
  const text = describeLengthRule(FE_TOUR);
  // 表里每一家店都得出现在提示里 —— 少一家就是"界面没说、后端却拦"的老路
  for (const store of Object.keys(FE_TOUR)) {
    assert.ok(text.includes(store), `提示语漏了 ${store}:${text}`);
  }
  assert.ok(text.includes('8位') && text.includes('5位'), `位数要念出来:${text}`);
  // 源码里不许再出现写死的旧提示
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /新罗系 5位/, '写死的位数提示不许再出现');
  assert.doesNotMatch(code, /新罗系 13位/, '写死的位数提示不许再出现');

  const reasons = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewReasons.js'), 'utf8',
  );
  assert.doesNotMatch(reasons, /LOTTE 8 \/ 新罗系 5/, '回执文案也别写死位数');
});

test('实跑一条:新世界 6 位团号,后端判不合格 → 前端也必须有长度可比', () => {
  const { TOUR_NO_LENGTH_BY_STORE: FE } = loadFrontendTables();
  assert.equal(validateTourNo('SHINSEGAE', '123456').ok, false, '后端拦');
  assert.equal(validateTourNo('SHINSEGAE', '12345').ok, true, '5 位放行');
  assert.equal(FE.SHINSEGAE, 5, '前端拿得到同一个期望值,才谈得上给同样的提示');
});

// ── 0801:英文名格的占位符要把「保存时会改写」这件事说出来,而且例子必须是真的 ────
//
// 病灶:0727#9 的姓␣名规范在**保存时**才生效(lib/workbench_field_normalizer
// normalizePassportEnglishName),而输入框显示的是原样、校验规则 /^[A-Z ]{2,50}$/ 还给绿标。
// 于是审核员看到 "VU DIEP KHANH HUYEN"、界面说合法、点确认后**变成** "VU DIEPKHANHHUYEN"。
// 改写本身是对的(那正是 0727#9 要的),错在没人告诉他。
//
// 没有在前端复制一份归一规则 —— 那条规则不简单(姓 + 多名合并),复制就是又一个"两个读者",
// 而"同一条规则两处实现"正是这一整天在修的坑。改成:占位符直接把规则和例子写出来。
// 但例子写错就是新的谎言,所以这条测试拿**后端真函数**核对占位符里的每个例子。
test('⭐英文名占位符:说清会合并,且例子与后端归一结果逐字一致', () => {
  const { normalizePassportEnglishName } = require('../lib/workbench_field_normalizer');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewFieldConfig.js'), 'utf8',
  );
  // 取出所有英文名占位符里的「X → Y」例子
  const examples = [...src.matchAll(/placeholder: '姓␣名,多个名会合并:([^→']+)→\s*([^']+)'/g)]
    .map((m) => ({ input: m[1].trim(), shown: m[2].trim() }));
  assert.ok(examples.length >= 2, `应有护照/百货两处占位符,实际 ${examples.length}`);

  for (const ex of examples) {
    assert.equal(normalizePassportEnglishName(ex.input), ex.shown,
      `占位符里的例子对不上后端真实归一结果:${ex.input} 实际会存成 `
      + `${normalizePassportEnglishName(ex.input)},而占位符写的是 ${ex.shown}`);
    assert.notEqual(ex.input, ex.shown, '例子要能体现"会被改写",不然等于没说');
  }
});
