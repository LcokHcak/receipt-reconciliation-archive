'use strict';

// 乐天百货交付包(P4;2026-07-20 重构=docs/plans/2026-07-20-百货交付重构-设计.md §1):
//   门店大夹=店名(明洞/蚕室/釜山/仁川,一店两码并一夹,未识别码原样)
//   → 客户夹《{购买日期M.D} {英文名}》(加空格;姓名=组级身份选取器 selectGroupIdentity)
//   → 双图({交易编号}.jpg=小票整图 + 护照.jpg=独立护照图;⭐无独立护照 → 同框整图兜底,不阻断)。
// 铁律:整组已审才交付;缺交易编号/缺门店 → 阻断名单(绝不静默出残包)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');

function touch(dir, rel) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  return p;
}

function mkService(dir) {
  return createLotteDeptDeliveryExportService({
    resolveBatchRelativePath: (batchId, rel) => path.join(dir, rel),
  });
}

const CUSTOMER = 'CL20260708-001';
function mkTask(over) {
  return {
    id: over.id || 't1',
    reviewed: true,
    sourceOriginalPath: `2607/${CUSTOMER}/x.jpg`,
    sourceGroupKey: CUSTOMER,
    ...over,
  };
}

test('乐天百货交付包:店名大夹(一店两码并一夹)/「日期 空格 姓名」客户夹/双图;混店客户只取乐天百货票', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_dep_'));
  try {
    touch(dir, 'source/r1.jpg');
    touch(dir, 'source/r2.jpg');
    touch(dir, 'source/r3.jpg');
    touch(dir, 'source/p1.jpg');
    touch(dir, 'source/other_receipt.jpg');
    const batch = {
      id: 'b1', name: '7.8批',
      tasks: [
        // 免税店残串小票排最前:夹名绝不能取它的 OCR 名(身份选取器护照优先)
        mkTask({ id: 'r9', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', receiptNoFinal: '03261635001590', extractedNameAuto: 'CHN-ERIGCHNE', sourceImagePath: 'source/other_receipt.jpg' }),
        mkTask({ id: 'r1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/r1.jpg' }),
        // 0001 也是明洞:必须并进同一店名夹(2026-07-20 重构F2,旧代码裂成 明洞(0394)/明洞(0001) 两夹)
        mkTask({ id: 'r2', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '55556666', branchFinal: '0001', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/r2.jpg' }),
        mkTask({ id: 'r3', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '87654321', branchFinal: '0348', purchaseDateFinal: '2026-07-02', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/r3.jpg' }),
        mkTask({ id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/p1.jpg' }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.equal(plan.customers, 1);
    assert.equal(plan.missingReceiptNo.length + plan.missingBranch.length, 0);
    assert.deepEqual(plan.passportFallback, [], '有独立护照,不进兜底名单');

    // 明洞夹(0394+0001 并一夹)3 文件(两票+护照) + 蚕室夹 2 文件 → 5
    assert.equal(plan.fileCount, 5);
    const keys = plan.entries.map((e) => `${e.branch}/${e.customerDir}/${e.baseName}`).sort();
    assert.deepEqual(keys, [
      '明洞/7.1 QIN SHIHUANG/1234-5678',
      '明洞/7.1 QIN SHIHUANG/5555-6666',
      '明洞/7.1 QIN SHIHUANG/护照',
      '蚕室/7.2 QIN SHIHUANG/8765-4321',
      '蚕室/7.2 QIN SHIHUANG/护照',
    ]);
    // 护照图=独立护照任务的图
    const passportEntry = plan.entries.find((e) => e.branch === '明洞' && e.baseName === '护照');
    assert.ok(passportEntry.sourcePath.endsWith('p1.jpg'));
    // 免税店残串名绝不入夹名
    assert.ok(!keys.some((k) => k.includes('CHN')), '免税店小票 OCR 残串不得当夹名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-07-20 拍板a:无独立护照任务 → 同框整图充当护照图,不再阻断(乐天护照口径冲突的修法)
test('乐天百货交付包:无独立护照 → 护照.jpg=同框整图兜底,进 passportFallback 名单不阻断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_nopass_'));
  try {
    touch(dir, 'source/r1.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        mkTask({ id: 'r1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678', sourceImagePath: 'source/r1.jpg' }),
      ],
    };
    const svc = mkService(dir);
    const plan = svc.planDelivery(batch);
    assert.equal(plan.customers, 1);
    assert.deepEqual(plan.passportFallback, [CUSTOMER]);

    const keys = plan.entries.map((e) => `${e.branch}/${e.customerDir}/${e.baseName}`).sort();
    assert.deepEqual(keys, [
      '明洞/7.1 WANG YI/1234-5678',
      '明洞/7.1 WANG YI/护照',
    ]);
    // 护照图=同框整图本图(票面自带打码护照)
    const passportEntry = plan.entries.find((e) => e.baseName === '护照');
    assert.ok(passportEntry.sourcePath.endsWith('r1.jpg'), '无独立护照时护照图用同框整图');

    // 导出不再被"缺护照"阻断(本机可能无 zip 工具,只认这两类错)
    try {
      const result = await svc.exportZip(batch);
      assert.ok(fs.existsSync(result.zipPath));
      assert.equal(result.passportFallback.length, 1);
      result.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED'].includes(err.code), `无护照不得阻断,实际: ${err.code || err.message}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 审计M6:两个不同客户同英文名+同门店+同购买日撞夹 → 必须各自成夹,第二人护照不得丢、小票不得并入他人夹
test('乐天百货交付包:同名同门店同日两客户撞夹 → 唯一化各成夹,护照不丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_collide_'));
  try {
    for (const f of ['a_r.jpg', 'a_p.jpg', 'b_r.jpg', 'b_p.jpg']) touch(dir, `source/${f}`);
    const mk = (cust, over) => ({
      id: over.id, reviewed: true,
      sourceOriginalPath: `2607/${cust}/x.jpg`, sourceGroupKey: cust, ...over,
    });
    const batch = {
      id: 'b1', name: '撞名批',
      tasks: [
        // 客户A(CL...-001):WANG WEI / 明洞 / 7.1
        mk('CL20260708-001', { id: 'ar', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: 'AAAA1111', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'WANG WEI', passportNoFinal: 'E11111111', sourceImagePath: 'source/a_r.jpg' }),
        mk('CL20260708-001', { id: 'ap', docTypeFinal: 'passport', extractedNameFinal: 'WANG WEI', passportNoFinal: 'E11111111', sourceImagePath: 'source/a_p.jpg' }),
        // 客户B(CL...-002):同名 WANG WEI / 同门店(0001 也是明洞) / 同日 7.1
        mk('CL20260708-002', { id: 'br', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: 'BBBB2222', branchFinal: '0001', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'WANG WEI', passportNoFinal: 'E22222222', sourceImagePath: 'source/b_r.jpg' }),
        mk('CL20260708-002', { id: 'bp', docTypeFinal: 'passport', extractedNameFinal: 'WANG WEI', passportNoFinal: 'E22222222', sourceImagePath: 'source/b_p.jpg' }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.equal(plan.customers, 2, '两个客户都进包');
    assert.deepEqual(plan.passportFallback, [], '两人护照都在,不进兜底名单');

    // 两人不能落进同一客户夹(0394/0001 并同一明洞店夹,撞夹判定在店名层);各自都得有自己的护照
    const dirs = new Set(plan.entries.map((e) => `${e.branch}/${e.customerDir}`));
    assert.equal(dirs.size, 2, '同名两客户必须各成一夹,绝不合并');
    for (const d of dirs) {
      const inDir = plan.entries.filter((e) => `${e.branch}/${e.customerDir}` === d);
      assert.ok(inDir.some((e) => e.baseName === '护照'), `${d} 必须有自己的护照`);
      assert.ok(inDir.some((e) => e.baseName !== '护照'), `${d} 必须有小票`);
    }
    // A、B 的小票不在同一夹(不串包)
    const aReceiptDir = plan.entries.find((e) => e.baseName === 'AAAA1111');
    const bReceiptDir = plan.entries.find((e) => e.baseName === 'BBBB2222');
    assert.notEqual(`${aReceiptDir.branch}/${aReceiptDir.customerDir}`, `${bReceiptDir.branch}/${bReceiptDir.customerDir}`, 'A、B 小票绝不能同夹');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('乐天百货交付包:未审组跳过并列名单;缺票号/缺门店进阻断名单;未识别门店码原样成夹', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_dep2_'));
  try {
    touch(dir, 'source/r1.jpg');
    touch(dir, 'source/r2.jpg');
    touch(dir, 'source/r3.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        // 客户A:未审 → skipped
        mkTask({ id: 'a1', sourceGroupKey: 'CL20260708-010', sourceOriginalPath: '2607/CL20260708-010/x.jpg', reviewed: false, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '11111111', branchFinal: '0394', purchaseDateFinal: '2026-07-01', sourceImagePath: 'source/r1.jpg' }),
        // 客户B:票号为空+缺门店 → 双阻断
        mkTask({ id: 'b1t', sourceGroupKey: 'CL20260708-011', sourceOriginalPath: '2607/CL20260708-011/x.jpg', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '', branchFinal: '', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'LI LEI', sourceImagePath: 'source/r2.jpg' }),
        // 客户C:未识别门店码 0999 → 码原样成夹,不拦
        mkTask({ id: 'c1', sourceGroupKey: 'CL20260708-012', sourceOriginalPath: '2607/CL20260708-012/x.jpg', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '22223333', branchFinal: '0999', purchaseDateFinal: '2026-07-03', extractedNameFinal: 'HAN MEI', passportNoFinal: 'E33333333', sourceImagePath: 'source/r3.jpg' }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.deepEqual(plan.skippedUnreviewed, ['CL20260708-010']);
    assert.ok(plan.missingReceiptNo.some((s) => s.includes('CL20260708-011')));
    assert.ok(plan.missingBranch.some((s) => s.includes('CL20260708-011')));
    const c = plan.entries.find((e) => e.baseName === '2222-3333');
    assert.equal(c.branch, '0999', '未识别门店码原样成夹(不丢票)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('乐天百货交付包:exportZip 阻断缺项,无票时报 NO_LOTTE_DEPT_RECEIPTS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_dep3_'));
  try {
    const svc = mkService(dir);
    await assert.rejects(
      () => svc.exportZip({ id: 'b1', tasks: [] }),
      (err) => err.code === 'NO_LOTTE_DEPT_RECEIPTS'
    );
    touch(dir, 'source/r1.jpg');
    const batch = {
      id: 'b1',
      tasks: [mkTask({ id: 'r1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '', branchFinal: '0394', purchaseDateFinal: '2026-07-01', sourceImagePath: 'source/r1.jpg' })],
    };
    await assert.rejects(
      () => svc.exportZip(batch),
      (err) => err.code === 'LOTTE_DEPT_DELIVERY_BLOCKED'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('乐天百货交付包:源图磁盘缺失的小票不静默丢,记入 missingSource(交付前可见)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_dep_missrc_'));
  try {
    touch(dir, 'source/r_ok.jpg');
    touch(dir, 'source/p1.jpg');
    const batch = {
      id: 'b1', name: '7.8批',
      tasks: [
        // 源图在的百货小票
        mkTask({ id: 'r_ok', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/r_ok.jpg' }),
        // 源图磁盘缺失的百货小票(ghost 未 touch)
        mkTask({ id: 'r_ghost', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '99998888', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/r_ghost.jpg' }),
        mkTask({ id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'QIN SHIHUANG', sourceImagePath: 'source/p1.jpg' }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.equal(plan.missingReceiptNo.length, 0, '缺的是源图不是票号');
    assert.equal(plan.missingBranch.length, 0, '缺的是源图不是门店');
    assert.equal(plan.missingSource.length, 1, '源图缺失的百货小票记入 missingSource,不再静默丢');
    assert.match(plan.missingSource[0], /r_ghost/, 'missingSource 含任务定位');
    assert.equal(plan.customers, 1, '客户仍进包(另一张有效),但缺图已可见');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 0727反馈#13-3:护照打码——同框票的交易编号图带 maskBbox,打包时涂黑 ──────────
test('打码计划:护照与小票同文件且 bbox 可信 → 条目带 maskBbox;独立护照/无bbox → 不带', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_mask_'));
  try {
    touch(dir, 'source/combined.jpg');
    touch(dir, 'source/receipt_only.jpg');
    touch(dir, 'source/standalone_passport.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        // 客户A:同框(护照任务与小票任务同一源文件,bbox 可信)→ 打码
        mkTask({ id: 'a_r', sourceGroupKey: 'CL20260709-101', sourceOriginalPath: '2607/CL20260709-101/x.jpg', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '1111-2222', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'AAA BBB', sourceImagePath: 'source/combined.jpg' }),
        mkTask({ id: 'a_p', sourceGroupKey: 'CL20260709-101', sourceOriginalPath: '2607/CL20260709-101/x.jpg', docTypeFinal: 'passport', extractedNameFinal: 'AAA BBB', passportNoFinal: 'E11111111', sourceImagePath: 'source/combined.jpg', modelMeta: { bbox: [0.55, 0.05, 0.98, 0.6] } }),
        // 客户B:护照是独立照片(不同源文件)→ 小票图上没护照,不打码
        mkTask({ id: 'b_r', sourceGroupKey: 'CL20260709-102', sourceOriginalPath: '2607/CL20260709-102/x.jpg', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '3333-4444', branchFinal: '0001', purchaseDateFinal: '2026-07-02', extractedNameFinal: 'CCC DDD', sourceImagePath: 'source/receipt_only.jpg' }),
        mkTask({ id: 'b_p', sourceGroupKey: 'CL20260709-102', sourceOriginalPath: '2607/CL20260709-102/y.jpg', docTypeFinal: 'passport', extractedNameFinal: 'CCC DDD', passportNoFinal: 'E22222222', sourceImagePath: 'source/standalone_passport.jpg', modelMeta: { bbox: [0.1, 0.1, 0.9, 0.9] } }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    const entryA = plan.entries.find((e) => e.baseName === '1111-2222');
    assert.deepEqual(entryA.maskBbox, [0.55, 0.05, 0.98, 0.6], '同框票必须带护照 bbox');
    const entryB = plan.entries.find((e) => e.baseName === '3333-4444');
    assert.equal(entryB.maskBbox, null, '独立护照客户的小票图不打码');
    // 护照.jpg 条目永远不打码(拍板a:全清晰度供上家核身份)
    for (const e of plan.entries.filter((x) => x.baseName === '护照')) {
      assert.ok(!e.maskBbox, '护照图自身不打码');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 0729 打码数据链修复:生产真实形状(上面那条测的形状生产根本不出现)──────────
// 乐天百货 store_profiles 是 split='none' + combined=true:识别侧「整图不切」,
// 会把护照分析**并进小票**,所以同框图**不产生独立护照任务**。
// 上面那条测试构造的是「独立护照任务 + 同源文件」——那形状只存在于测试里。
// 后果:代码路径被测得好好的,真实数据却永远走不到,打码静默失效
// (0729 全库核验:7 批 352 张同框票,0 张拿到过护照框)。
// 教训:测试夹具要照着**生产真实产出的形状**搭,照着代码分支搭会测出假安全感。
test('打码计划(生产形状):无独立护照任务,护照区在小票 modelMeta.passportBbox → 仍要打码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_mask_merged_'));
  try {
    touch(dir, 'source/dept_combined.jpg');
    touch(dir, 'source/dept_nobox.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        // 同框票:护照被合并进本任务,位置留在 modelMeta.passportBbox(无独立护照任务)
        mkTask({
          id: 'm_r', sourceGroupKey: 'CL20260729-201', sourceOriginalPath: '2607/CL20260729-201/x.jpg',
          docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '7777-8888',
          branchFinal: '0394', purchaseDateFinal: '2026-07-20', extractedNameFinal: 'MERGED CASE',
          sourceImagePath: 'source/dept_combined.jpg',
          modelMeta: { bbox: [0, 0, 1, 1], passportBbox: [0.02, 0.62, 0.97, 0.98] },
        }),
        // 对照:识别没给出护照区(旧数据/图里就没护照)→ 仍旧不遮,并进 unmaskable 名单
        mkTask({
          id: 'n_r', sourceGroupKey: 'CL20260729-202', sourceOriginalPath: '2607/CL20260729-202/x.jpg',
          docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '9999-0000',
          branchFinal: '0001', purchaseDateFinal: '2026-07-20', extractedNameFinal: 'NO BOX',
          sourceImagePath: 'source/dept_nobox.jpg',
          modelMeta: { bbox: [0, 0, 1, 1] },
        }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    const merged = plan.entries.find((e) => e.baseName === '7777-8888');
    assert.deepEqual(merged.maskBbox, [0.02, 0.62, 0.97, 0.98], '同框合并档必须能拿到护照区');
    const nobox = plan.entries.find((e) => e.baseName === '9999-0000');
    assert.equal(nobox.maskBbox, null, '没有护照区就不遮(宁可不遮,绝不黑掉整张交付图)');
    assert.ok((plan.unmaskable || []).some((s) => s.includes('9999-0000')),
      '遮不了的必须进 unmaskable,靠导出说明置顶告警,不能静默');
    assert.ok(!(plan.unmaskable || []).some((s) => s.includes('7777-8888')),
      '能遮的不该再报警');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打码计划:同框 passportBbox 不可信(全图)→ 不采纳(与独立护照任务同一把闸)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_mask_merged2_'));
  try {
    touch(dir, 'source/c.jpg');
    const plan = mkService(dir).planDelivery({
      id: 'b1',
      tasks: [mkTask({
        id: 'r', sourceGroupKey: 'CL20260729-203', sourceOriginalPath: '2607/CL20260729-203/x.jpg',
        docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '1212-3434',
        branchFinal: '0394', purchaseDateFinal: '2026-07-20', extractedNameFinal: 'FULL BOX',
        sourceImagePath: 'source/c.jpg',
        modelMeta: { bbox: [0, 0, 1, 1], passportBbox: [0, 0, 1, 1] },
      })],
    });
    assert.equal(plan.entries.find((e) => e.baseName === '1212-3434').maskBbox, null,
      '全图框 = 会黑掉整张交付图,面积闸必须继续拦住');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打码计划:bbox 不可信(全图/残缺)→ 不带 maskBbox(宁可不遮,绝不错遮盖掉小票)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_mask2_'));
  try {
    touch(dir, 'source/c1.jpg');
    const batch = {
      id: 'b1',
      tasks: [
        mkTask({ id: 'r', sourceGroupKey: 'CL20260709-103', sourceOriginalPath: '2607/CL20260709-103/x.jpg', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '5555-6666', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'EEE', sourceImagePath: 'source/c1.jpg' }),
        // bbox=[0,0,1,1] 全图:plausibleBbox 拒(错遮=黑掉整张交付图)
        mkTask({ id: 'p', sourceGroupKey: 'CL20260709-103', sourceOriginalPath: '2607/CL20260709-103/x.jpg', docTypeFinal: 'passport', passportNoFinal: 'E3', sourceImagePath: 'source/c1.jpg', modelMeta: { bbox: [0, 0, 1, 1] } }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.equal(plan.entries.find((e) => e.baseName === '5555-6666').maskBbox, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 0728 红批注核对:顶层夹日期=批次收票日(规范《收票日期+乐天百货小票》),非导出日 ──
test('exportZip 顶层夹用批次 createdAt(KST)而非导出当天;createdAt 坏值回退不炸', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_daylabel_'));
  try {
    touch(dir, 'source/r1.jpg');
    const mk = (createdAt) => ({
      id: 'b1', createdAt,
      tasks: [
        mkTask({ id: 'r1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '1234-5678', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678', sourceImagePath: 'source/r1.jpg' }),
      ],
    });
    const svc = mkService(dir);
    // 收票日 2026-07-21(KST 白天)→ 顶层夹 7.21,与导出当天无关
    try {
      const res = await svc.exportZip(mk('2026-07-21T03:00:00.000Z')); // KST 12:00
      assert.match(res.downloadName, /^7\.21乐天百货小票/);
      res.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED'].includes(err.code), `不得因日期取值炸: ${err.code || err.message}`);
    }
    // createdAt 坏值 → 回退导出当天(不炸即可,不断言具体日期)
    try {
      const res2 = await svc.exportZip(mk('not-a-date'));
      assert.match(res2.downloadName, /乐天百货小票/);
      res2.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED'].includes(err.code));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 导出说明.txt(0728 静默缺口):回执原本只在 exportZip 返回值里,handler 流 zip 全丢 ──
test('导出说明:打码回退/国籍缺失/缺图有内容才生成;干净包不写;exportZip 落包根', () => {
  const { buildLotteDeliveryNotes } = require('../services/lotte_dept_delivery_export_service');
  assert.equal(buildLotteDeliveryNotes({}), null, '干净包不写说明(不给收件人塞噪音)');
  const notes = buildLotteDeliveryNotes({
    maskFallback: ['明洞/7.1 QIN SHIHUANG/1234-5678.jpg'],
    nationalityMissing: ['蚕室/7.2 WANG YI/2222-3333.jpg'],
    copyFailed: ['釜山/7.3 LI SI/4444-5555.jpg'],
    missingSource: ['CL20260708-009/task_9(小票9999-0000)'],
  });
  const text = notes.join('\n');
  assert.match(text, /【护照未打码】1 张.*人工确认/, '未打码原样出包必须显式提醒');
  assert.match(text, /1234-5678\.jpg/);
  assert.match(text, /【国籍未印出】1 张/);
  assert.match(text, /【文件缺失】1 张/);
  assert.match(text, /【源图缺失】1 张/);
  // 超 20 条截断但报总数
  const many = buildLotteDeliveryNotes({ copyFailed: Array.from({ length: 23 }, (_, i) => `f${i}.jpg`) });
  assert.match(many.join('\n'), /等共 23 张/);

  // 接线契约:exportZip 写包根,带 UTF-8 BOM(源码显式转义)
  const src = fs.readFileSync(path.join(__dirname, '../services/lotte_dept_delivery_export_service.js'), 'utf8');
  assert.match(src, /buildLotteDeliveryNotes\(\{\s*maskFallback, nationalityMissing, copyFailed, missingSource: plan\.missingSource,/);
  assert.ok(src.includes(String.raw`导出说明.txt'), '\ufeff'`), '写文件带 UTF-8 BOM(源码显式转义)');
});

// ── 2026-07-29 生产核验实锤:乐天百货打码结构性不触发,且此前完全静默 ────────────
test('未能定位护照区 → 记 unmaskable 名单 + 导出说明置顶告警(不再静默出裸护照)', () => {
  const { buildLotteDeliveryNotes } = require('../services/lotte_dept_delivery_export_service');
  const notes = buildLotteDeliveryNotes({ unmaskable: ['明洞/7.26 CUI ZIYING/9559-0049'] });
  const text = notes.join('\n');
  assert.match(text, /护照未遮盖/, '合规风险条目');
  assert.match(text, /原样出包\(护照信息可见\)/, '把后果说清楚,不用"未打码"这种轻描淡写');
  assert.match(text, /9559-0049/, '列出具体是哪张');
  // 置顶:发包前第一眼就得看见(排在打码失败/国籍/缺图之前)
  const idxUnmask = text.indexOf('护照未遮盖');
  const withAll = buildLotteDeliveryNotes({
    unmaskable: ['a'], maskFallback: ['b'], nationalityMissing: ['c'], copyFailed: ['d'], missingSource: ['e'],
  }).join('\n');
  assert.ok(idxUnmask >= 0 && withAll.indexOf('护照未遮盖') < withAll.indexOf('护照未打码'), '风险最高的排最前');
});

test('planDelivery:同框票拿不到护照 bbox 时进 unmaskable(乐天 split=none 的结构性场景)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte_unmask_'));
  try {
    touch(dir, 'source/c1.jpg');
    const batch = {
      id: 'bU', name: 'U批', createdAt: '2026-07-26T03:00:00.000Z',
      tasks: [
        // 乐天百货同框票:整图直通、无独立护照任务 → 拿不到护照 bbox(生产实况)
        mkTask({ id: 'u1', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
          receiptNoFinal: '9559-0049', branchFinal: '0394', purchaseDateFinal: '2026-07-26',
          extractedNameFinal: 'CUI ZIYING', sourceImagePath: 'source/c1.jpg' }),
      ],
    };
    const plan = mkService(dir).planDelivery(batch);
    assert.deepEqual(plan.unmaskable, ['明洞/7.26 CUI ZIYING/9559-0049'], '拿不到 bbox 的交易编号图必须记名单(门店/客户夹/交易编号 三段定位)');
    assert.ok(plan.entries.every((e) => !e.maskBbox), '本场景确实无从打码——名单不是多余的');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('乐天导出说明:未审完客户组同样进【未进包】段', () => {
  const { buildLotteDeliveryNotes } = require('../services/lotte_dept_delivery_export_service');
  const text = buildLotteDeliveryNotes({ skippedUnreviewed: ['CL20260727-053'] }).join('\n');
  assert.match(text, /【未进包·还没审完】1 个客户组/);
  assert.match(text, /CL20260727-053/);
  const src = fs.readFileSync(path.join(__dirname, '../services/lotte_dept_delivery_export_service.js'), 'utf8');
  assert.match(src, /skippedUnreviewed: plan\.skippedUnreviewed/);
});
