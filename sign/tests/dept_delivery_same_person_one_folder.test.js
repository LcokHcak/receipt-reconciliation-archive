'use strict';

/**
 * 0727#13-2:「一个人多张小票,但是购买日期相同的,应该放在一个文件夹里」。
 *
 * 用户截图(647c31156f8c2dda7b695e1dd29a2e57.png)里的实况:
 *   7.22 VU DIEPKHANHHUYEN   /  7.22 VU DIEPKHANHHUYEN_5196
 *   7.26 ZHANG JIAJING       /  7.26 ZHANG JIAJING_3845
 * 同一个人、同一天,出了两个夹。
 *
 * 根因不是夹名规则(夹名一直是「{购买日期M.D} {英文名}」,同日同名本来就该同夹),
 * 而是**夹的「主人」按客户组 id 认**:同一个人被建成两个客户组(分两次上传/跨批次),
 * 第二个组被当成"撞名的另一个人",于是加了护照后4位的后缀。
 * 那个后缀本来是给「同名不同人」用的防串包措施(审计M6),打到同一个人身上就成了拆夹。
 *
 * 0731 改成按**人**认(护照号优先)。这条钉两头:同人必须合、同名不同人必须分。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');
const { STORE_FAMILIES } = require('../lib/validation/field_rules');

let root;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte-dir-'));
  fs.mkdirSync(path.join(root, 'source'), { recursive: true });
});
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function receipt(id, { customerId, passportNo, name, receiptNo, file }) {
  const abs = path.join(root, 'source', file);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, 'jpg-bytes-' + file);
  return {
    id,
    reviewed: true,
    docTypeFinal: 'receipt',
    // ⚠️ 必须写规范值 STORE_FAMILIES.LOTTE_DEPT('LOTTE_DEPT'),不能写中文显示名:
    // 分组用 normalizeStoreFamily(认中文别名),但取身份的 findDeptPassportDonor 走的是
    // store_profiles.isDeptStore(只认规范键)。写 '乐天百货' 的话票能进包、名字却取不到,
    // 夹名会退化成客户号——那是 fixture 假象,不是被测行为。
    receiptStoreFinal: STORE_FAMILIES.LOTTE_DEPT,
    receiptNoFinal: receiptNo,
    branchFinal: '0001',
    purchaseDateFinal: '2026-07-22',
    passportNoFinal: passportNo,
    extractedNameFinal: name,
    sourceImagePath: `source/${file}`,
    sourceOriginalPath: `2026-07/${customerId}/${file}`,
  };
}

function planOf(tasks) {
  const svc = createLotteDeptDeliveryExportService({
    resolveBatchRelativePath: (_batchId, rel) => path.join(root, rel),
  });
  return svc.planDelivery({ id: 'b1', tasks });
}

test('⭐同一个人被建成两个客户组 → 同一天的票必须进同一个夹(不许再出 _5196 那种后缀)', () => {
  const plan = planOf([
    receipt('t1', {
      customerId: 'CL20260722-001', passportNo: 'C12345196', name: 'VU DIEPKHANHHUYEN',
      receiptNo: '1001-0138', file: 'a.jpg',
    }),
    receipt('t2', {
      customerId: 'CL20260722-002', passportNo: 'C12345196', name: 'VU DIEPKHANHHUYEN',
      receiptNo: '1001-0139', file: 'b.jpg',
    }),
  ]);
  const dirs = [...new Set((plan.entries || []).map((e) => e.customerDir))];
  assert.deepEqual(dirs, ['7.22 VU DIEPKHANHHUYEN'],
    `同一本护照的两个客户组应合到一个夹,实际:${JSON.stringify(dirs)}`);
  assert.ok(!dirs.some((d) => /_\d{4}$/.test(d)),
    '不该再出现 _5196 这种把同一个人拆开的后缀');
});

test('⭐同名但**不同人**(护照号不同)仍必须分夹 —— 别把防串包的措施一起拆了', () => {
  const plan = planOf([
    receipt('t1', {
      customerId: 'CL20260722-001', passportNo: 'C11111111', name: 'ZHANG JIAJING',
      receiptNo: '1001-0140', file: 'c.jpg',
    }),
    receipt('t2', {
      customerId: 'CL20260722-002', passportNo: 'C22223845', name: 'ZHANG JIAJING',
      receiptNo: '1001-0141', file: 'd.jpg',
    }),
  ]);
  const dirs = [...new Set((plan.entries || []).map((e) => e.customerDir))];
  assert.equal(dirs.length, 2,
    `同名不同人必须分夹(审计M6 防串包),实际:${JSON.stringify(dirs)}`);
  assert.ok(dirs.some((d) => /_3845$/.test(d)), '第二个人应带护照后4位后缀');
});

test('没有护照号时退回客户组 id —— 行为和改动前一致,不会更差', () => {
  const plan = planOf([
    receipt('t1', {
      customerId: 'CL20260722-001', passportNo: '', name: 'NO PASSPORT',
      receiptNo: '1001-0142', file: 'e.jpg',
    }),
    receipt('t2', {
      customerId: 'CL20260722-002', passportNo: '', name: 'NO PASSPORT',
      receiptNo: '1001-0143', file: 'f.jpg',
    }),
  ]);
  const dirs = [...new Set((plan.entries || []).map((e) => e.customerDir))];
  assert.equal(dirs.length, 2, '认不出是不是同一个人时,保持分开(宁可多一个夹,不可串包)');
});

test('护照号写法不同(空格/小写/带杠)算同一个人', () => {
  const plan = planOf([
    receipt('t1', {
      customerId: 'CL20260722-001', passportNo: 'c123 45196', name: 'CASE TEST',
      receiptNo: '1001-0144', file: 'g.jpg',
    }),
    receipt('t2', {
      customerId: 'CL20260722-002', passportNo: 'C12345196', name: 'CASE TEST',
      receiptNo: '1001-0145', file: 'h.jpg',
    }),
  ]);
  const dirs = [...new Set((plan.entries || []).map((e) => e.customerDir))];
  assert.equal(dirs.length, 1, `护照号写法差异不该拆夹,实际:${JSON.stringify(dirs)}`);
});
