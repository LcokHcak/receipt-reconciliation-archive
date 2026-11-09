'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildFinalDeliveryNotes } = require('../services/monthly/final_delivery_export_service');

// 0729 静默排查 A1:月度最终交付的 warnings(七类)原本只写进 交付清单.json,
//   ① run() 返回值不带 → 路由无从转发 → 前端只看到一个干净的成功页;
//   ② 只勾「客户数据包」下载时,交付清单.json 属于 data 组,根本不进那个 zip。
// 于是交付出去的客户资料包安静地缺图/账单是空壳,等客户自己发现再回来找。

test('干净导出不写说明(不给收件人塞噪音,与多模式交付包同规矩)', () => {
  assert.equal(buildFinalDeliveryNotes({}), '');
  assert.equal(buildFinalDeliveryNotes({ warnings: [] }), '');
  assert.equal(buildFinalDeliveryNotes({ warnings: [null, 'x'] }), '', '脏值不算内容');
});

test('说明按「谁该做什么」分组,且给出行动指引而不只是罗列', () => {
  const text = buildFinalDeliveryNotes({
    workspaceKey: '2026-07',
    producedAt: '2026-07-29T03:00:00.000Z',
    warnings: [
      { type: 'image_source_missing', customer: 'WANG YI', passportNo: 'EB2345678' },
      { type: 'customer_bill_missing', customer: 'LI SI', passportNo: 'EK9876543' },
      { type: 'cjk_font_missing', customer: 'ZHANG SAN' },
      { type: 'unreceived_export_failed', message: '磁盘写满' },
      { type: 'backfill_customer_skipped', customer: 'ZHAO LIU' },
    ],
  });
  assert.match(text, /工作区 2026-07/);
  assert.match(text, /【客户资料缺图·交付前必看】共 1 条[\s\S]*WANG YI/);
  assert.match(text, /【客户账单缺失（用了空壳表）】[\s\S]*别直接发给客户/,
    '空壳账单必须明确警告别发出去');
  assert.match(text, /【中文字体不可用[\s\S]*别直接发出去/);
  assert.match(text, /【有一整份表没能生成】[\s\S]*未收清单:磁盘写满/);
  assert.match(text, /【未收补录客户·没出 PDF】[\s\S]*属正常/,
    '正常情况要说明是正常的,否则每次都当故障查');
});

test('新增的 warning 类型没登记时,要报「其它情况」而不是装作没有', () => {
  const text = buildFinalDeliveryNotes({ warnings: [{ type: '未来某个新类型' }] });
  assert.match(text, /【其它情况】共 1 条/);
  assert.match(text, /未来某个新类型/);
  assert.match(text, /交付清单\.json/, '指向完整名单');
});

test('单类超 30 条截断但报总数(名单再长也不能刷屏)', () => {
  const many = Array.from({ length: 42 }, (_, i) => ({ type: 'image_source_missing', customer: `C${i}` }));
  const text = buildFinalDeliveryNotes({ warnings: many });
  assert.match(text, /共 42 条/);
  assert.match(text, /…等共 42 条/);
});

// 接线契约:两个缺口都必须堵上,否则说明写了也没人看得见
test('接线:run() 返回 warnings + notesPath;说明进每一种勾选组合;响应回传聚合', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../services/monthly/final_delivery_export_service.js'), 'utf8');
  assert.match(svc, /const notesPath = path\.join\(packageDir, '交付说明\.txt'\)/);
  assert.match(svc, /notesPath: notesText \? notesPath : ''/, '没内容就不留路径,路由据此跳过');
  assert.match(svc, /return \{[\s\S]{0,400}warnings,\s*\n\s*notesPath/, 'run() 必须把 warnings 交出来');
  assert.ok(svc.includes("`\\uFEFF${notesText}`"), '写文件带 UTF-8 BOM(防中文乱码)');

  const routes = fs.readFileSync(path.join(__dirname, '../routes/monthly/export_routes.js'), 'utf8');
  // 说明的 add 必须在两个 packageTypes 分支**之外**,否则只勾客户包时又被漏掉
  const fnStart = routes.indexOf('function collectFinalDeliveryArchiveEntries');
  const body = routes.slice(fnStart, routes.indexOf('function topLevelDeliveryPath'));
  const notesIdx = body.indexOf('result.notesPath');
  const customerBranch = body.indexOf("packageTypes.includes('customer')");
  assert.ok(notesIdx > 0, '打包时要带上交付说明');
  assert.ok(notesIdx > customerBranch, '说明在所有分支之后无条件加入');
  assert.ok(!/packageTypes\.includes\([^)]*\)[^}]*result\.notesPath/.test(body),
    '说明不得挂在某个 packageTypes 分支里');

  assert.match(routes, /warnings: Object\.entries\(/, '响应必须回传 warnings 聚合');
});
