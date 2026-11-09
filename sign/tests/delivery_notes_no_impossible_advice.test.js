'use strict';

/**
 * 交付包里那张纸不许指一个做不到的动作(2026-08-01)。
 *
 * 「导出说明.txt」写进 zip 根目录,是发给**上家/结算对方**的东西。
 * 里面写错一步,对方按它做、做不成,结论只会是"你们系统坏了"。
 *
 * 实况:【图片没进包·一票一图不成立】那段,逐条已经带了
 * lib/delivery_render.describeBlock 给出的**各自可行**的做法;
 * 可紧跟其后有一句一网打尽的尾巴:
 *   「请在审核台打开对应任务,点『查看原图』框出各自的范围后重新导出。」
 * 三处错:
 *   ① 它把上面逐条的正确建议全推翻了;
 *   ② duplicate_crop_file 这类的图是**切片**,lib/manual_doc_box.canAcceptManualBox
 *      对切片任务直接返回 ok:false 并 400 拒,前端按钮就是禁用的「画框(这条不行)」;
 *   ③ 审核台里根本没有叫「查看原图」的控件 —— 按钮是「回原图」/「看切片」,
 *      而且 0730 主态翻转后原图已经是默认视图。
 *
 * 最说明问题的是:lib/delivery_render.js 里**两处注释**白纸黑字写过
 * 「那等于第三次给操作员指一个做不到的动作」,而两个交付服务里那句话原封没动 ——
 * 同一条规矩没有单一出口,靠注释提醒是拦不住的。所以立这道跨文件的闸。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 所有会写进「导出说明.txt」的地方
const NOTE_SOURCES = [
  'services/mode_delivery_export_service.js',
  'services/lotte_dept_delivery_export_service.js',
  'services/hyundai_delivery_export_service.js',
  'services/batch_customer_data_export_service.js',
  'lib/delivery_render.js',
];

// 界面上**不存在**的控件名 / 对部分任务做不到的动作
const IMPOSSIBLE = [
  { pattern: /点「查看原图」框出/, why: '审核台没有叫「查看原图」的按钮(是「回原图」/「看切片」),且切片任务根本不许画框' },
  { pattern: /在原图上重新框出各自的范围/, why: '切片任务的框对不上原图坐标系,manual_doc_box 会 400 拒' },
];

test('⭐导出说明里不许出现"做不到的动作"', () => {
  const hits = [];
  for (const rel of NOTE_SOURCES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    // 注释里可以提这些字样(那是在解释"为什么不能这么写"),只查真正会被 push 出去的行
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const { pattern, why } of IMPOSSIBLE) {
      if (pattern.test(code)) hits.push(`${rel}:${pattern} —— ${why}`);
    }
  }
  assert.deepEqual(hits, [],
    `这些交付说明指了做不到的动作:\n  ${hits.join('\n  ')}`);
});

test('⭐阻断段要把人指回"每条自己的做法",不许给统一的一步', () => {
  for (const rel of [
    'services/mode_delivery_export_service.js',
    'services/lotte_dept_delivery_export_service.js',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /每条后面的括号里写了它自己的原因和可行做法/,
      `${rel}:要指回逐条建议`);
    assert.match(src, /不同原因的处理方式不一样/,
      `${rel}:要明说没有统一的一步 —— 否则读的人还是会找那"一个动作"`);
  }
});

test('⭐逐条建议本身还在(这次修的是那句尾巴,不是把建议删了)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delivery_render.js'), 'utf8');
  assert.match(src, /可行做法:①在其中一条上点「补小票」/,
    'duplicate_crop_file 的逐条做法不许丢 —— 它是这类唯一真能走通的路');
  assert.match(src, /按店重切/, '第二条出路也要留着');
});

test('⭐切片任务确实不许画框(上面几条的前提,别哪天前提变了没人发现)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'manual_doc_box.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /ok:\s*false/,
    'canAcceptManualBox 要有拒绝分支;它若哪天放开了,上面的话术要跟着改');
});

test('自检:闸真能抓到(把那句话塞回去必须被逮住)', () => {
  const fake = 'lines.push("  请在审核台打开对应任务,点「查看原图」框出各自的范围后重新导出。");';
  const code = fake.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const caught = IMPOSSIBLE.some(({ pattern }) => pattern.test(code));
  assert.ok(caught, '闸对已知的坏话术都认不出来,那它等于没有');
  // 反向:注释里提这几个字不该被误判
  const inComment = '// ⚠️ 不能说 点「查看原图」框出各自的范围';
  const stripped = inComment.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!IMPOSSIBLE.some(({ pattern }) => pattern.test(stripped)),
    '注释里解释"为什么不能这么写"不该被当成违规');
});
