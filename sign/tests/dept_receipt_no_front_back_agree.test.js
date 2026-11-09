'use strict';

/**
 * 百货交易编号:前端校验和后端校验必须对同一个值给同一个结论。
 *
 * 0731 实锤:前端 FieldEditor.vue 对 LOTTE_DEPT 写死 /^\d{8}$/,报错「8位纯数字,不打-」——
 * 那是 0727#13-4 **已经作废**的旧口径。权威档案 lib/store_profiles.js 是
 * { digits:8, dash:true, transNo44:true },后端 workbench_task_flow.js 读档案判,是对的。
 *
 * 后果不是"提示不准":ReviewView.confirmAndNext → FieldEditor.validateForSubmit 会把
 * 格式错算进 invalidFields 并**早退**,所以 OCR 按新口径写进来的 1001-0138
 * 会让「确认」按钮点了没反应 —— 乐天百货整店卡审。
 * 而同一个输入框的 placeholder 写的还是「票面 4位-4位,带杠照抄」:
 * 提示叫他带杠,校验又骂他带杠。
 *
 * 这条钉的是**两侧一致**,不是某一侧的具体正则 —— 口径将来还会变(已经变过一次),
 * 变的时候两边必须一起变。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getStoreProfile } = require('../lib/store_profiles');
// 店族键从 field_rules 取(store_profiles 只是消费方,不导出这张表)
const { STORE_FAMILIES } = require('../lib/validation/field_rules');

// 从 .vue 源码里抠出前端那段判据并求值 —— 不复制一份规则到测试里,
// 复制就等于再造第三个真相源(今天已经因为"一个事实多处读法"改过两回)。
function frontendChecker() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'components', 'FieldEditor.vue'), 'utf8',
  );
  const block = (src.match(/receiptNoFinal:\s*\(\(\)\s*=>\s*\{([\s\S]*?)\n    \}\)\(\)/) || [])[1];
  assert.ok(block, '没在 FieldEditor.vue 里定位到 receiptNoFinal 的校验块 —— 结构变了,断言要跟着改');
  // 用同名变量把那段逻辑跑起来:v=输入值,receiptStore=店族键
   
  const fn = new Function('draft', 'receiptStore', 'RECEIPT_NO_STRICT', 'hasLenRule',
    'receiptNo', 'receiptNoLength', `return ((() => {${block}\n})())`);
  return (value, store) => fn({ receiptNoFinal: value }, store, false, false, value, 0);
}

function backendCheck(value, familyKey) {
  const profile = getStoreProfile(familyKey);
  const rule = (profile && profile.rules && profile.rules.receiptNo) || {};
  const digitsOnly = String(value).replace(/-/g, '');
  if (!/^\d+$/.test(digitsOnly)) return '票号只能是数字(可带-)';
  if (rule.dash === false && String(value).includes('-')) return '交易编号不打-';
  if (rule.digits && digitsOnly.length !== rule.digits) return `需要 ${rule.digits} 位数字`;
  return '';
}

const CASES = [
  // [店族, 值, 说明]
  [STORE_FAMILIES.LOTTE_DEPT, '1001-0138', '乐天百货:OCR 现在就是这么写的(4-4 带杠)'],
  [STORE_FAMILIES.LOTTE_DEPT, '10010138', '乐天百货:存量 8 位不带杠,仍应放行'],
  [STORE_FAMILIES.LOTTE_DEPT, '100-1013-8', '乐天百货:杠位不对但数字核仍是 8 位'],
  [STORE_FAMILIES.LOTTE_DEPT, '1001013', '乐天百货:只有 7 位,两侧都该拒'],
  [STORE_FAMILIES.LOTTE_DEPT, '1001-013A', '乐天百货:混字母,两侧都该拒'],
  [STORE_FAMILIES.HYUNDAI_DEPT, '1622-0011', '现代百货:4-4 带杠'],
  [STORE_FAMILIES.HYUNDAI_DEPT, '16220011', '现代百货:去杠'],
  [STORE_FAMILIES.HYUNDAI_DEPT, '162200', '现代百货:位数不足,两侧都该拒'],
];

test('⭐百货交易编号:前端和后端对同一个值必须给同一个结论(放行/拒绝)', () => {
  const check = frontendChecker();
  const mismatch = [];
  for (const [family, value, why] of CASES) {
    const feMsg = String(check(value, family) || '');
    const beMsg = String(backendCheck(value, family) || '');
    const fePass = feMsg === '';
    const bePass = beMsg === '';
    if (fePass !== bePass) {
      mismatch.push(`${why}\n      值=${value}  前端${fePass ? '放行' : '拒绝:' + feMsg}`
        + `  后端${bePass ? '放行' : '拒绝:' + beMsg}`);
    }
  }
  assert.deepEqual(mismatch, [],
    '前后端对同一张票结论相反 —— 后端放行、前端拒绝时,「确认」按钮会点了没反应\n'
    + '(confirmAndNext → validateForSubmit 见 invalid 直接早退),整店卡审:\n    '
    + mismatch.join('\n    '));
});

test('⭐乐天百货必须收带杠的票号 —— 旧「8位不打-」口径已被 0727#13-4 作废', () => {
  const check = frontendChecker();
  assert.equal(check('1001-0138', STORE_FAMILIES.LOTTE_DEPT), '',
    'OCR 按 dash44 写进来的值被前端拒了');
  assert.equal(backendCheck('1001-0138', STORE_FAMILIES.LOTTE_DEPT), '');
  const profile = getStoreProfile(STORE_FAMILIES.LOTTE_DEPT);
  assert.notEqual(profile.rules.receiptNo.dash, false,
    '档案若改回 dash:false,得同时改前端和 placeholder,别只改一处');
});

test('输入框提示语和校验不能互相打架', () => {
  const cfg = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewFieldConfig.js'), 'utf8',
  );
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'components', 'FieldEditor.vue'), 'utf8',
  );
  // 提示语在教人「带杠照抄」,校验就不能再说「不打-」
  assert.match(cfg, /带杠照抄/, 'placeholder 应教人照票面带杠抄');
  assert.ok(!/不打-/.test(src.replace(/\/\/.*$/gm, '')),
    '校验文案还在说「不打-」,和 placeholder 的「带杠照抄」互相打架');
});
