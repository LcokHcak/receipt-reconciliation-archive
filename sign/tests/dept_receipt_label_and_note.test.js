'use strict';

/**
 * 百货两处「用户看得见的说法」对齐(2026-08-01,核账报告 idx40 的纯文案漂移)。
 *
 * ① 备注列会把 mode_record_matrix 的 note **逐行**写进每日收票 Excel
 *    (workbench_receipt_export:368 notes.push(rule.note))。新世界/现代那两条一直写着
 *    「导出借位:金额→团号列/上家→姓名列」,而 0731 用户口径「什么字段就填什么列」
 *    已经把借位连根拔掉 —— 谁照着这句去对账就对错列。
 *
 * ② 后端字段契约里百货票号的标签判据是 `rules.receiptNo.dash === false → 交易编号`,
 *    依据是"乐天百货 8 位不打杠"。可 0727#13-4 之后三家百货全部 dash:true,
 *    这个分支**永不成立** —— 实测改动前三家标签全是"小票号",而前端硬编码"交易编号",
 *    审核台看着对、后端那份(配置台/校验回执/契约口径)已经漂了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupModeRecordRule } = require('../lib/mode_record_matrix');
const { buildDeptReceiptFieldRuleSet } = require('../lib/workbench_definition');
const { getStoreProfile } = require('../lib/store_profiles');

const DEPT_STORES = ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT'];

test('⭐备注列不许再教人"借位"——那句会写进每一行百货票', () => {
  for (const mode of ['新世界百货', '现代百货', '乐天百货']) {
    const note = String(lookupModeRecordRule(mode).note || '');
    assert.ok(note, `${mode} 应有备注`);
    assert.ok(!note.includes('借位:'), `${mode} 的备注还在教借位:${note}`);
    assert.ok(!/金额→团号列|上家.*→姓名列/.test(note), `${mode} 的备注还在指错列:${note}`);
  }
  // 反面:0731 的真口径要说出来
  assert.match(lookupModeRecordRule('新世界百货').note, /各有专列|不再借位/);
});

test('⭐百货票号在后端契约里就叫「交易编号」——判据不能挂在"打不打杠"上', () => {
  for (const store of DEPT_STORES) {
    const profile = getStoreProfile(store);
    // 前提复述:三家现在都是带杠,所以旧判据 dash===false 永不成立
    assert.equal(profile.rules?.receiptNo?.dash, true, `${store} 应是带杠(旧判据据此永不命中)`);
    const field = buildDeptReceiptFieldRuleSet(profile).fields
      .find((f) => f.validation?.type === 'dept_receipt_no');
    assert.ok(field, `${store} 应有百货票号字段`);
    assert.equal(field.label, '交易编号',
      `${store} 的后端标签应是「交易编号」(0727#13-1 口径:百货就叫交易编号,与打杠无关)`);
  }
});

test('判据不再读 dash(读了就等于把标签绑在一个会变的格式细节上)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workbench_definition.js'), 'utf8');
  const block = /const deptReceiptNoDef = Object\.freeze\(\{[\s\S]*?\}\);/.exec(src);
  assert.ok(block, '没定位到 deptReceiptNoDef');
  const code = block[0].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /dash === false/, '标签不许再按 dash 判');
  assert.match(code, /label: '交易编号'/);
});

test('⭐「查看规则」里的列清单必须与真表逐列一致(手抄的东西一定会漂)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { getBuiltinPlanSpec } = require('../lib/builtin_export_plan_specs');
  // 真表:library_mode_export_service 的 COLUMNS(表头即用户看到的列名)
  const svcSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'monthly', 'library_mode_export_service.js'), 'utf8',
  );
  const block = /const COLUMNS = Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(svcSrc);
  assert.ok(block, '没定位到 COLUMNS');
  const headers = [...block[1].matchAll(/\['([^']+)',\s*'[a-z_]+'\]/g)].map((m) => m[1]);
  assert.ok(headers.length >= 15, `真表列数解析异常:${headers.length}`);

  const spec = getBuiltinPlanSpec('library_excel');
  assert.ok(spec?.rules?.length, '没拿到 library_excel 的规则说明(闸接错了就等于没闸)');
  const text = spec.rules.map((r) => `${r.files || ''} ${r.note || ''}`).join(' ');
  for (const h of headers) {
    assert.ok(text.includes(h), `规则说明漏了真表里的列「${h}」`);
  }
  assert.ok(text.includes(`共 ${headers.length}`),
    `规则说明里的列数要和真表对上(真表 ${headers.length} 列)`);
});
