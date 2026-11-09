'use strict';

/**
 * 客户组「护照是否齐」前后端对拍(2026-08-01)。
 *
 * 背景:前端 frontend/src/lib/reviewDisplay.js 自己实现了一份 groupHasPassport,
 * 注释写着「与后端 lib/validation/group_passport_rule 同口径」「此清单由 parity 测试锁平」。
 * 但翻遍 tests/,那条所谓的 parity 测试**只加载后端那份**,从没把前端的拿来比过 ——
 * 也就是说"锁平"这句话本身没有任何东西在保证它。典型的"一个事实两个读者 + 一句假承诺"。
 *
 * 这条测试真的把两份实现跑在同一批用例上对拍。前端只负责"要不要给审核员标缺护照",
 * 后端负责"能不能通过/结算",两者不一致的后果是:界面看着没问题、点确认却被拒(或反过来)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { groupHasPassport: backendHasPassport } = require('../lib/validation/group_passport_rule');

// 前端是 ESM 且依赖同文件里的若干 helper,整份剥掉 export 后当普通函数体跑,
// 拿出它导出的 groupHasPassport —— 复制一份实现来测,等于又造了第三个读者。
function loadFrontendHasPassport() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'reviewDisplay.js'), 'utf8',
  );
  // 该文件顶部 import 了别的模块;逐行剔掉 import 行,再把 export 关键字去掉。
  const body = src.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export /gm, '');
   
  return new Function(`
    ${body}
    return groupHasPassport;
  `)();
}

const passport = (over = {}) => ({ docTypeFinal: 'passport', passportNoFinal: 'EA1234567', ...over });
const receipt = (over = {}) => ({ docTypeFinal: 'receipt', receiptStoreFinal: 'THE SHILLA', ...over });

// 前端吃一个扁平任务数组,后端吃 {passportTasks, receiptTasks};这里从同一份数组拆。
function backendVerdict(tasks) {
  const docType = (t) => String(t.docTypeFinal || t.docTypeAuto || '');
  return backendHasPassport({
    passportTasks: tasks.filter((t) => docType(t) === 'passport'),
    receiptTasks: tasks.filter((t) => docType(t) === 'receipt'),
  });
}

const CASES = [
  { name: '免税:1 护照 + 1 小票', tasks: [passport(), receipt()] },
  { name: '免税:0 护照', tasks: [receipt()] },
  { name: '⭐免税:2 独立护照(后端认为取错要拦)', tasks: [passport(), passport(), receipt()] },
  { name: '乐天百货:同框票带护照号', tasks: [receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359' })] },
  { name: '乐天百货:同框票只有英文名', tasks: [receipt({ receiptStoreFinal: 'LOTTE_DEPT', extractedNameFinal: 'ZHANG SAN' })] },
  { name: '乐天百货:票上什么身份都没有', tasks: [receipt({ receiptStoreFinal: 'LOTTE_DEPT' })] },
  { name: '新世界百货:裸票(免护照店)', tasks: [receipt({ receiptStoreFinal: 'SHINSEGAE_DEPT' })] },
  { name: '现代百货:裸票(免护照店)', tasks: [receipt({ receiptStoreFinal: 'HYUNDAI_DEPT' })] },
  { name: '⭐免护照店 + 2 独立护照', tasks: [passport(), passport(), receipt({ receiptStoreFinal: 'SHINSEGAE_DEPT' })] },
  { name: '混合组:百货带身份 + 免税小票', tasks: [receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359' }), receipt()] },
  { name: '混合组:百货无身份 + 免税小票', tasks: [receipt({ receiptStoreFinal: 'SHINSEGAE_DEPT' }), receipt()] },
  { name: '空组', tasks: [] },
];

test('⭐前后端「护照是否齐」必须逐例一致(界面不标问题、点确认却被拒 = 最伤人的那种不一致)', () => {
  const frontendHasPassport = loadFrontendHasPassport();
  const diffs = [];
  for (const c of CASES) {
    const front = frontendHasPassport(c.tasks);
    const back = backendVerdict(c.tasks);
    if (front !== back) diffs.push(`${c.name}:前端=${front} 后端=${back}`);
  }
  assert.deepEqual(diffs, [], `前后端口径分歧:\n  ${diffs.join('\n  ')}`);
});

test('自检:对拍装置本身得管用(前端函数真的加载到了,不是恒 true/恒 false)', () => {
  const frontendHasPassport = loadFrontendHasPassport();
  assert.equal(typeof frontendHasPassport, 'function');
  assert.equal(frontendHasPassport([passport(), receipt()]), true, '正常组应判齐');
  assert.equal(frontendHasPassport([receipt()]), false, '免税店缺护照应判不齐');
});
