'use strict';

/**
 * 门店码"生效边界"的保存时提醒(2026-08-01)。
 *
 * 边界本身是有意留的、代码和界面都写了:配置台的门店码清单只喂审核台点选,
 * 台账/交付包的码→店名映射运行时仍读 lib/store_profiles 出厂表。
 * 问题在**告知时机** —— 那是段静态说明,没人逐字读;管理员加了「0999 江南」,
 * 审核台点得到,月底出交付包才发现夹名是「0999」,那时包已经发出去了。
 *
 * ⚠️ 这条测试是**重写过**的。第一版把逻辑留在组件里、断言只扫源码文本
 * (有没有出现 `unmapped`、有没有出现"不在出厂表里"),验红时把计算改成
 * `const unmapped = []` **照样通过** —— 那等于没测。
 * 今天这是第四次栽在"断言写得太松"上,所以这次把逻辑抽成纯函数,直接测行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadLib() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'branchCodeMapping.js'), 'utf8',
  );
  const body = src.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export /gm, '');
   
  return new Function(`${body}\nreturn { unmappedBranchCodes, branchSaveMessage };`)();
}

const { unmappedBranchCodes, branchSaveMessage } = loadLib();
const FACTORY = { '0001': '明洞', '0394': '明洞', '0002': '蚕室', '0005': '釜山' };

test('⭐出厂表没有的码要被挑出来(它们在交付包里只会显示码本身)', () => {
  const picked = unmappedBranchCodes(
    [{ code: '0001' }, { code: '0999' }, { code: '0005' }, { code: '1234' }],
    FACTORY,
  );
  assert.deepEqual(picked, ['0999', '1234']);
});

test('全都在出厂表里 → 一个都不挑(有结果才提醒,不添噪音)', () => {
  assert.deepEqual(unmappedBranchCodes([{ code: '0001' }, { code: '0002' }], FACTORY), []);
  assert.equal(branchSaveMessage([]), '门店码清单已保存,审核台点选即刻生效');
});

test('出厂表里"有这个码但店名是空的" → 仍算没映射(交付包照样只能显示码)', () => {
  assert.deepEqual(unmappedBranchCodes([{ code: '0007' }], { ...FACTORY, '0007': '   ' }), ['0007']);
});

test('去重 + 保持输入顺序;脏输入不炸', () => {
  assert.deepEqual(
    unmappedBranchCodes([{ code: '0999' }, { code: ' 0999 ' }, { code: '' }, {}, null], FACTORY),
    ['0999'],
  );
  assert.deepEqual(unmappedBranchCodes(null, null), []);
  assert.deepEqual(unmappedBranchCodes([{ code: '0001' }], null), ['0001'], '没有出厂表=全都没映射');
});

test('⭐提示语要点名 + 说清后果(不能只说"保存成功")', () => {
  const msg = branchSaveMessage(['0999', '1234']);
  assert.match(msg, /0999、1234/, '要点名是哪几个');
  assert.match(msg, /不在出厂表里/);
  assert.match(msg, /按码原样显示/, '要说清后果:台账/交付包里看到的是码');
  assert.match(msg, /需要改代码/, '要说清怎样才能真生效,别让人以为再存一次就好');
});

test('接线:配置台保存走这两个纯函数,不在组件里另写一套', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'views', 'ConfigConsoleView.vue'), 'utf8',
  );
  assert.match(view, /from '\.\.\/lib\/branchCodeMapping'/);
  assert.match(view, /setMessage\(branchSaveMessage\(/);
  assert.match(view, /unmappedBranchCodes\(cleaned,/);
});
