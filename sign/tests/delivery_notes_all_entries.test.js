'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildHyundaiDeliveryNotes } = require('../services/hyundai_delivery_export_service');
const { buildCustomerDataNotes } = require('../services/batch_customer_data_export_service');

// 0729 静默排查 A3/A4:这两个交付入口算出了「少发了什么」,却
//   · 只写 console.warn / logger.warn(服务器日志,操作员看不到)
//   · handler 拿到 result 只用 zipPath/downloadName/cleanup 就 res.download,其余字段原地丢
//   · zip 里没有任何说明文件
// 结果:收件人拿到的包可能缺图,谁都不知道,只能等他自己数出来再回来问。

test('现代包:三份名单都要进导出说明;干净包不写', () => {
  assert.equal(buildHyundaiDeliveryNotes({}), null, '干净包不塞噪音');

  const text = buildHyundaiDeliveryNotes({
    skippedUnreviewed: ['CL20260729-001'],
    missingSource: ['CL20260729-002/task_0007(小票1622-0011)'],
    copyFailed: ['小票/1622-0999.jpg'],
  }).join('\n');
  assert.match(text, /现代免税店交付包 · 导出说明/);
  assert.match(text, /【未进包·还没审完】1 个客户组/);
  assert.match(text, /【源图取不到·没进包】1 张图/);
  assert.match(text, /不用找客户/, '源图问题是我们这边的事,别甩给收件人');
  assert.match(text, /【文件缺失】1 张图/);
});

test('客户数据包:两类缺图分开报(发现时机不同,处置也不同)', () => {
  assert.equal(buildCustomerDataNotes({}), null);

  const text = buildCustomerDataNotes({
    missingSource: ['CL20260729-010/护照.jpg'],
    copyFailed: ['王五 EB23/小票1.jpg'],
  }).join('\n');
  assert.match(text, /客户数据包 · 导出说明/);
  assert.match(text, /【源图取不到·没进包】[\s\S]*客户档案里登记了这些图,但磁盘上取不到/,
    '列清单时就没有 = 图从没进过包');
  assert.match(text, /【复制失败】[\s\S]*重新导出通常能解决/,
    '复制失败更像临时故障,指引要不一样');
});

test('超 20 条截断但报总数(两个入口同规矩)', () => {
  const many = Array.from({ length: 33 }, (_, i) => `x${i}.jpg`);
  assert.match(buildHyundaiDeliveryNotes({ copyFailed: many }).join('\n'), /…等共 33 张/);
  assert.match(buildCustomerDataNotes({ missingSource: many }).join('\n'), /…等共 33 张/);
});

test('接线:两个服务都把说明写进包根,且带 BOM 防中文乱码', () => {
  const hy = fs.readFileSync(path.join(__dirname, '../services/hyundai_delivery_export_service.js'), 'utf8');
  assert.match(hy, /buildHyundaiDeliveryNotes\(\{[\s\S]{0,200}missingSource: plan\.missingSource/);
  assert.ok(hy.includes("path.join(staging, '导出说明.txt')"), '写进包根');
  assert.ok(hy.includes('`\\uFEFF${notes.join('), 'BOM');

  const cd = fs.readFileSync(path.join(__dirname, '../services/batch_customer_data_export_service.js'), 'utf8');
  assert.match(cd, /buildCustomerDataNotes\(\{ missingSource: plan\.missingSource, copyFailed \}\)/);
  assert.ok(cd.includes("path.join(staging, '导出说明.txt')"), '写进包根');
  assert.ok(cd.includes('`\\uFEFF${notes.join('), 'BOM');
});

// 更隐蔽的一层:图在**列清单阶段**就被吞掉,连 copyFailed 都覆盖不到
test('客户数据包:列清单时 stat 失败的图不得再静默,要进 plan.missingSource', () => {
  const cd = fs.readFileSync(path.join(__dirname, '../services/batch_customer_data_export_service.js'), 'utf8');
  assert.match(cd, /function listCustomerRecordImages\(customerDir, wantedFileNames = new Set\(\), missingOut = \[\]\)/);
  assert.match(cd, /\} catch \{[\s\S]{0,400}missingOut\.push\(relativePath\)/,
    'catch 里必须记下来,不能只留一句「其余照常导出」');
  assert.doesNotMatch(cd, /\/\/ Missing images are ignored; the rest of the batch can still export\./,
    '旧的"忽略即可"注释已不成立');
  // \r? 容错:仓库是 CRLF,把行尾写死成 \n 会静默失配(今天已在别处踩过一次)
  assert.match(cd, /const missingSource = \[\];[\s\S]{0,900}missingSource,\r?\n/, 'planExport 要把它交出去');
});

// 0729 真实数据核验发现:段与段之间没有空行,「…不用回来核对。」后面直接顶着
// 「【未进包·还没审完】」,几十行糊成一片没法扫读。这类问题只有看真实产物才看得出来
// —— 单元测试里每段就一两行,挤在一起也不难看。
test('导出说明:段与段之间要有空行(四个入口同规矩)', () => {
  const { buildDeliveryNotes } = require('../services/mode_delivery_export_service');
  const { buildExportPlanNotes } = require('../services/export_plan_execute_service');

  const check = (lines, label) => {
    const idxs = lines.map((l, i) => (l.startsWith('【') ? i : -1)).filter((i) => i > 0);
    assert.ok(idxs.length >= 2, `${label}:这条用例应产出至少两段`);
    for (const i of idxs) {
      assert.equal(lines[i - 1], '', `${label}:第 ${i} 行的段标题前必须留空行`);
    }
  };

  check(buildDeliveryNotes({
    noRecordReceipts: 3, noRecordModes: ['甲 不用记'],
    skippedUnreviewed: ['CL-1'], missingSource: ['CL-2/t1(小票)'],
    passportSourceLost: [{ customerId: 'CL-3', zone: '梁总', folder: 'a/b' }],
    copyFailed: ['x.jpg'],
  }), '多模式包');

  check(buildHyundaiDeliveryNotes({
    skippedUnreviewed: ['CL-1'], missingSource: ['CL-2/t1(小票)'], copyFailed: ['小票/x.jpg'],
  }), '现代包');

  check(buildCustomerDataNotes({ missingSource: ['CL-1/a.jpg'], copyFailed: ['夹/b.jpg'] }), '客户数据包');

  check(buildExportPlanNotes({
    skipped: [{ customerId: 'CL-1', reason: '整组未审核完' }], copyFailed: ['x.jpg'],
  }), '自定义计划');

  // 标题与首段之间本来就有空行,不该再多插一个(连续空行=排版噪音)
  const one = buildDeliveryNotes({ skippedUnreviewed: ['CL-1'] });
  assert.equal(one[1], '', '标题后一个空行');
  assert.notEqual(one[2], '', '不得出现连续空行');
});
