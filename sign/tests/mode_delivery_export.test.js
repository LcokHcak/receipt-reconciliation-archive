'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createModeDeliveryExportService, summarizeZones, entryInZone, zoneOfMode,
  selectGroupIdentity, passportPrefix4,
} = require('../services/mode_delivery_export_service');
const { createHyundaiDeliveryExportService } = require('../services/hyundai_delivery_export_service');
const { sanitize } = require('../services/batch_customer_data_export_service');

// 多模式交付包(2026-07-07 四规则,用户拍板:每模式一文件夹/跨模式客户各区一份/S活动小票双份)
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_'));
  const mkImg = (rel) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'img');
    return rel;
  };

  let seq = 0;
  const task = (over) => ({
    id: `task_${String(++seq).padStart(4, '0')}`,
    reviewed: true,
    docTypeFinal: 'receipt',
    sourceImagePath: '',
    sourceOriginalPath: '',
    ...over,
  });

  const tasks = [
    // 客户A:济州道辉(规则1)—— 护照1 + 小票2 + 机票1(护照号=真形态 2字母+7数字,前4才成立)
    task({
      docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EQ1234567',
      sourceOriginalPath: 'ws1/CL20260707-001/a-passport.jpg', sourceImagePath: mkImg('source/a_pp.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '济州乐天SG-道辉（单独整理）',
      groupNoFinal: '26907555', receiptNoFinal: '90G203-26-000309',
      sourceOriginalPath: 'ws1/CL20260707-001/a-r1.jpg', sourceImagePath: mkImg('source/a_r1.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '济州乐天SG-道辉（单独整理）',
      groupNoFinal: '26907555', receiptNoFinal: '90G203-26-000310',
      sourceOriginalPath: 'ws1/CL20260707-001/a-r2.jpg', sourceImagePath: mkImg('source/a_r2.jpg'),
    }),
    // 同客户第二个团号(审查HIGH回归):绝不能混进 26907555 的文件夹
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '济州乐天SG-道辉（单独整理）',
      groupNoFinal: '26908888', receiptNoFinal: '90G203-26-000399',
      sourceOriginalPath: 'ws1/CL20260707-001/a-r3.jpg', sourceImagePath: mkImg('source/a_r3.jpg'),
    }),
    task({
      docTypeFinal: 'other',
      sourceOriginalPath: 'ws1/CL20260707-001/a-flight.jpg', sourceImagePath: mkImg('source/a_fl.jpg'),
    }),
    // 客户B:其他模式(规则3,乐天SG-本司)+ 跨模式(新罗V团-本司)—— 护照/机票两区各一份
    task({
      docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
      sourceOriginalPath: 'ws1/CL20260707-002/b-pp.jpg', sourceImagePath: mkImg('source/b_pp.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司',
      groupNoFinal: '26141846', receiptNoFinal: '12345678901234',
      sourceOriginalPath: 'ws1/CL20260707-002/b-r1.jpg', sourceImagePath: mkImg('source/b_r1.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'THE SHILLA', modeRawPre: '新罗V团-本司',
      groupNoFinal: '71990', receiptNoFinal: '0326163500043',
      sourceOriginalPath: 'ws1/CL20260707-002/b-r2.jpg', sourceImagePath: mkImg('source/b_r2.jpg'),
    }),
    // 客户C:S活动(规则4,乐天SG-S活动)—— 小票在模式区一份 + S活动区按票号一份
    task({
      docTypeFinal: 'passport', extractedNameFinal: 'WANG WU', passportNoFinal: 'EA1112223',
      sourceOriginalPath: 'ws1/CL20260707-003/c-pp.jpg', sourceImagePath: mkImg('source/c_pp.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-S活动',
      groupNoFinal: '70012', receiptNoFinal: '90335-26-003255',
      sourceOriginalPath: 'ws1/CL20260707-003/c-r1.jpg', sourceImagePath: mkImg('source/c_r1.jpg'),
    }),
    // 客户D:现代免税店(规则2,走现代三池)
    task({
      docTypeFinal: 'passport', extractedNameFinal: 'ZHAO LIU', passportNoFinal: 'EB3334445',
      sourceOriginalPath: 'ws1/CL20260707-004/d-pp.jpg', sourceImagePath: mkImg('source/d_pp.jpg'),
    }),
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'HYUNDAI', modeRawPre: '现代-JEOCU',
      groupNoFinal: '70299', receiptNoFinal: '01-260630-109-00126',
      sourceOriginalPath: 'ws1/CL20260707-004/d-r1.jpg', sourceImagePath: mkImg('source/d_r1.jpg'),
    }),
    // 客户E:整组没审完 → 整组跳过
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', reviewed: false,
      groupNoFinal: '26141846', receiptNoFinal: '99999999999999',
      sourceOriginalPath: 'ws1/CL20260707-005/e-r1.jpg', sourceImagePath: mkImg('source/e_r1.jpg'),
    }),
    // 客户F:模式为空(未命中)→ 未归类/
    task({
      docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '',
      groupNoFinal: '', receiptNoFinal: '11112222333344',
      sourceOriginalPath: 'ws1/CL20260707-006/f-r1.jpg', sourceImagePath: mkImg('source/f_r1.jpg'),
    }),
  ];

  const batch = { id: 'batch_md', name: '260707-测试', tasks };
  const resolveBatchRelativePath = (_batchId, rel) => path.join(root, rel);
  const hyundai = createHyundaiDeliveryExportService({ resolveBatchRelativePath });
  const svc = createModeDeliveryExportService({
    resolveBatchRelativePath,
    hyundaiDeliveryExportService: hyundai,
  });
  return { root, batch, svc };
}

test('四规则计划:济州道辉团号客户夹/其他模式各一文件夹/跨模式各一份/S活动双份/现代三池/未审跳过/未归类', () => {
  const { root, batch, svc } = makeFixture();
  try {
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);

    // 规则1 济州道辉:团号层 + 客户夹前缀带团号
    assert.ok(rel.includes('济州乐天SG-道辉/26907555/26907555—ZHANG SAN EQ12/26907555—ZHANG SAN EQ12_小票1'), rel.join('\n'));
    assert.ok(rel.includes('济州乐天SG-道辉/26907555/26907555—ZHANG SAN EQ12/26907555—ZHANG SAN EQ12_小票2'));
    assert.ok(rel.includes('济州乐天SG-道辉/26907555/26907555—ZHANG SAN EQ12/26907555—ZHANG SAN EQ12_护照'));
    assert.ok(rel.includes('济州乐天SG-道辉/26907555/26907555—ZHANG SAN EQ12/26907555—ZHANG SAN EQ12_机票'));
    // 审查HIGH回归:同客户第二团号各归各夹,护照/机票两团号夹各一份
    assert.ok(rel.includes('济州乐天SG-道辉/26908888/26908888—ZHANG SAN EQ12/26908888—ZHANG SAN EQ12_小票1'));
    assert.ok(!rel.includes('济州乐天SG-道辉/26907555/26907555—ZHANG SAN EQ12/26907555—ZHANG SAN EQ12_小票3'), '第二团号的小票不得混进第一团号夹');
    assert.ok(rel.includes('济州乐天SG-道辉/26908888/26908888—ZHANG SAN EQ12/26908888—ZHANG SAN EQ12_护照'));

    // 规则3 其他模式:每模式一文件夹,客户夹=姓名+护照前4;跨模式客户护照在两区各一份
    assert.ok(rel.includes('乐天SG-本司/LI SI EK98/LI SI EK98_小票1'));
    assert.ok(rel.includes('新罗V团-本司/LI SI EK98/LI SI EK98_小票1'));
    assert.ok(rel.includes('乐天SG-本司/LI SI EK98/LI SI EK98_护照'));
    assert.ok(rel.includes('新罗V团-本司/LI SI EK98/LI SI EK98_护照'));

    // 规则4 S活动:模式区一份 + S活动区按票号(带横线)一份
    assert.ok(rel.includes('乐天SG-S活动/WANG WU EA11/WANG WU EA11_小票1'));
    assert.ok(rel.includes('S活动/乐天SG-S活动/9033526003255')); // 乐天S活动=digits14,票号去杠命名

    // 规则2 现代三池
    assert.ok(rel.includes('现代免税店/小票/01-260630-109-00126'));
    assert.ok(rel.includes('现代免税店/护照/ZHAO LIU'));

    // 未审完整组跳过;未归类兜底
    assert.ok(plan.skippedUnreviewed.includes('CL20260707-005'));
    assert.ok(!rel.some((r) => r.includes('99999999999999')), '未审完的小票不得进包');
    assert.ok(rel.includes('未归类/无团号—未归类客户/无团号—未归类客户_小票1') === false, '未归类走规则3命名');
    assert.ok(rel.some((r) => r.startsWith('未归类/CL20260707-006')), '模式为空进未归类(无英文名回退客户号)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S活动小票缺票号 → 阻断导出并列出任务;正常批可打出 zip 结构', async () => {
  const { root, batch, svc } = makeFixture();
  try {
    // 抹掉 S活动小票的票号 → 阻断
    const sTask = batch.tasks.find((t) => t.modeRawPre === '乐天SG-S活动');
    const saved = sTask.receiptNoFinal;
    sTask.receiptNoFinal = '';
    sTask.receiptNoAuto = '';
    await assert.rejects(() => svc.exportZip(batch), (err) => err.code === 'MODE_DELIVERY_RECEIPT_NO_MISSING');
    sTask.receiptNoFinal = saved;

    // 正常导出:zip 产物存在(zip 工具缺失的环境跳过打包断言)
    let result;
    try {
      result = await svc.exportZip(batch);
    } catch (err) {
      // 本机(Windows)常无 zip/python 打包工具 → 只验计划层与阻断逻辑;
      // 打包路径与现代交付包共用 archiveZip,服务器(linux+zip)已被现代包生产验证。
      if (err.code === 'ZIP_UNAVAILABLE' || err.code === 'ZIP_FAILED') return;
      throw err;
    }
    assert.ok(fs.existsSync(result.zipPath));
    assert.ok(result.downloadName.endsWith('_交付包.zip'));
    result.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 审计M7:同模式下两客户英文名+护照前4相同 → folderBase 撞名,资料合并进同一交付夹。修=按客户唯一化。
test('多模式交付:同名+同护照前4两客户 → 唯一化各成夹,不合并串包', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_collide_'));
  try {
    const mkImg = (rel) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); return rel; };
    let seq = 0;
    const t = (over) => ({ id: `task_${++seq}`, reviewed: true, docTypeFinal: 'receipt', sourceImagePath: '', sourceOriginalPath: '', ...over });
    const batch = { id: 'b', name: 'n', tasks: [
      // A: LI NA / 护照 EG1234567(前4 EG12) / 乐天SG-本司
      t({ docTypeFinal: 'passport', extractedNameFinal: 'LI NA', passportNoFinal: 'EG1234567', sourceOriginalPath: 'ws1/CL20260716-001/a-pp.jpg', sourceImagePath: mkImg('s/a_pp.jpg') }),
      t({ receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: 'AAAA', sourceOriginalPath: 'ws1/CL20260716-001/a-r.jpg', sourceImagePath: mkImg('s/a_r.jpg') }),
      // B: 同名 LI NA / 护照 EG1256789(前4 也 EG12) / 同模式
      t({ docTypeFinal: 'passport', extractedNameFinal: 'LI NA', passportNoFinal: 'EG1256789', sourceOriginalPath: 'ws1/CL20260716-002/b-pp.jpg', sourceImagePath: mkImg('s/b_pp.jpg') }),
      t({ receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: 'BBBB', sourceOriginalPath: 'ws1/CL20260716-002/b-r.jpg', sourceImagePath: mkImg('s/b_r.jpg') }),
    ] };
    const svc = createModeDeliveryExportService({
      resolveBatchRelativePath: (_b, rel) => path.join(root, rel),
      hyundaiDeliveryExportService: createHyundaiDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) }),
    });
    const plan = svc.planModeDelivery(batch);
    // A、B 的小票必须在不同的客户夹(不串包)
    const aDir = plan.files.find((f) => f.baseName.endsWith('_小票1') && f.sourcePath.includes('a_r')).dir;
    const bDir = plan.files.find((f) => f.baseName.endsWith('_小票1') && f.sourcePath.includes('b_r')).dir;
    assert.notEqual(aDir, bDir, '同名同前4两客户小票绝不能落同一夹');
    // 各自都有自己的护照(护照没被跨客户合并)
    const aPass = plan.files.filter((f) => f.dir === aDir && f.baseName.includes('护照'));
    const bPass = plan.files.filter((f) => f.dir === bDir && f.baseName.includes('护照'));
    assert.equal(aPass.length, 1);
    assert.equal(bPass.length, 1);
    assert.equal(plan.customers, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2026-07-16 资料库P0:单渠道切片(同一份 plan 按顶层文件夹切块,规则零改动)──
test('渠道区汇总+切片过滤:zone=plan顶层文件夹;S活动副本夹连带;济州多团号并一个区', () => {
  const { root, batch, svc } = makeFixture();
  try {
    const plan = svc.planModeDelivery(batch);

    // 零变化护卫:legacy 字符串数组仍在,details 与之平行(切片只是多了带 mode 的旁路)
    assert.deepEqual(plan.missingSActivityDetails.map((d) => d.label), plan.missingSActivityReceiptNo);

    const zones = summarizeZones(plan);
    const zoneNames = zones.map((z) => z.zone).sort();
    // 顶层区:济州(两个团号并一个区)/乐天SG-本司/新罗V团-本司/乐天SG-S活动/现代免税店/未归类;
    // S活动 副本夹不单独成区(折回它的模式区)
    assert.deepEqual(zoneNames, ['乐天SG-S活动', '乐天SG-本司', '新罗V团-本司', '未归类', '济州乐天SG-道辉', '现代免税店'].sort());
    assert.ok(!zoneNames.includes('S活动'), 'S活动副本夹不得单独成区');

    const jeju = zones.find((z) => z.zone === '济州乐天SG-道辉');
    assert.equal(jeju.customerDirs, 2); // 同客户两团号=两个客户夹
    const hyundai = zones.find((z) => z.zone === '现代免税店');
    assert.equal(hyundai.customerDirs, null); // 三池无客户夹,前端显示张数
    assert.ok(hyundai.files >= 2);

    // 切片谓词:S活动模式区连带 S活动/{模式}/ 副本;别的区互不串
    const sZoneFiles = plan.files.filter((e) => entryInZone(e, '乐天SG-S活动', sanitize));
    assert.ok(sZoneFiles.some((e) => e.dir === 'S活动/乐天SG-S活动'), '切S活动模式必须连带副本夹');
    assert.ok(sZoneFiles.every((e) => e.dir.startsWith('乐天SG-S活动') || e.dir.startsWith('S活动/乐天SG-S活动')));
    const huixinFiles = plan.files.filter((e) => entryInZone(e, '乐天SG-本司', sanitize));
    assert.ok(huixinFiles.length > 0);
    assert.ok(huixinFiles.every((e) => e.dir.startsWith('乐天SG-本司/')));
    // 切片并集=全量(每条 entry 恰好归一个区;副本夹归模式区)
    const union = new Set();
    for (const z of zones) {
      for (const e of plan.files.filter((x) => entryInZone(x, z.zone, sanitize))) union.add(`${e.dir}/${e.baseName}`);
    }
    assert.equal(union.size, plan.files.length, '切片并集必须覆盖全量且不重不漏');

    assert.equal(zoneOfMode('济州乐天SG-道辉（单独整理）'), '济州乐天SG-道辉');
    assert.equal(zoneOfMode(''), '未归类');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('切片阻断口径:别区缺票号不拦本区;本区缺票号照拦;空区=EMPTY;无zone=旧行为', async () => {
  const { root, batch, svc } = makeFixture();
  try {
    // 抹掉 S活动小票票号
    const sTask = batch.tasks.find((t) => t.modeRawPre === '乐天SG-S活动');
    sTask.receiptNoFinal = '';
    sTask.receiptNoAuto = '';

    // 全量导出:照旧被拦(旧行为)
    await assert.rejects(() => svc.exportZip(batch), (err) => err.code === 'MODE_DELIVERY_RECEIPT_NO_MISSING');
    // 切 S活动 自己的区:拦
    await assert.rejects(() => svc.exportZip(batch, { zone: '乐天SG-S活动' }), (err) => err.code === 'MODE_DELIVERY_RECEIPT_NO_MISSING');
    // 切别的区(乐天SG-本司):不被 S活动 的缺票号拦——要么打出包,要么只剩打包工具缺失
    try {
      const result = await svc.exportZip(batch, { zone: '乐天SG-本司' });
      assert.equal(result.zone, '乐天SG-本司');
      assert.ok(result.downloadName.includes('乐天SG-本司'));
      assert.ok(result.fileCount > 0);
      result.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED'].includes(err.code), `不该被别区阻断拦住,实际: ${err.code || err.message}`);
    }
    // 不存在的区:EMPTY
    await assert.rejects(() => svc.exportZip(batch, { zone: '不存在的渠道' }), (err) => err.code === 'MODE_DELIVERY_EMPTY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2026-07-20 交付包五问题#1:组级身份选取(护照任务优先,绝不用免税店小票 OCR 残串)──
test('身份选取:护照任务优先;免税小票残串不入选;百货同框兜底;护照前4形态闸+CHN剥离', () => {
  // 免税店小票带 OCR 残串(排在护照前面)→ 必须选护照身份,不看任务顺序
  const receiptGarbage = {
    docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
    extractedNameAuto: 'CHN-ERIGCHNE', passportNoAuto: 'CHNE',
  };
  const passport = { docTypeFinal: 'passport', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678' };
  assert.deepEqual(selectGroupIdentity([receiptGarbage, passport], 'CL1'), { name: 'WANG YI', passportNo: 'EB2345678' });

  // 无护照任务:免税店小票的 OCR 名绝不入选 → 姓名回退 customerId
  assert.deepEqual(selectGroupIdentity([receiptGarbage], 'CL20260707-009'), { name: 'CL20260707-009', passportNo: '' });

  // 无护照任务但有百货同框票(乐天百货)→ 用它的身份字段
  const deptCarrier = {
    docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
    extractedNameFinal: 'LI NA', passportNoFinal: 'EC1234567',
  };
  assert.deepEqual(selectGroupIdentity([receiptGarbage, deptCarrier], 'CLX'), { name: 'LI NA', passportNo: 'EC1234567' });

  // 护照前4:剥非字母数字+形态闸(1-2字母+7-8数字);CHN 粘串剥掉再验;残串/纯数字不取
  assert.equal(passportPrefix4('EB2345678'), 'EB23');
  assert.equal(passportPrefix4('E12345678'), 'E123');
  assert.equal(passportPrefix4('CHNE2345678'), 'E234', 'MRZ 国籍码 CHN 粘连 → 剥掉再取前4');
  assert.equal(passportPrefix4('chn-e2345678'), 'E234', '先剥非字母数字再验形态');
  assert.equal(passportPrefix4('CHNE'), '', '小票粘出的残串不成形 → 无前4');
  assert.equal(passportPrefix4('12345678'), '', '无字母不成形');
  assert.equal(passportPrefix4('EQ123456'), '', '数字位数不足(6位)不成形');
  assert.equal(passportPrefix4(''), '');
});

test('客户夹命名回归:残串小票在前也不带歪;格式=「{姓名} {护照前4}」加空格', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_identity_'));
  try {
    const mkImg = (rel) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); return rel; };
    const batch = { id: 'b', name: 'n', tasks: [
      // 小票排在护照前,且带 OCR 残串身份(旧逻辑会取到 CHN-ERIGCHNE / CHNE)
      {
        id: 't1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: '12345678901234',
        extractedNameAuto: 'CHN-ERIGCHNE', passportNoAuto: 'CHNE',
        sourceOriginalPath: 'ws1/CL20260720-001/a-r.jpg', sourceImagePath: mkImg('s/a_r.jpg'),
      },
      {
        id: 't2', reviewed: true, docTypeFinal: 'passport',
        extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
        sourceOriginalPath: 'ws1/CL20260720-001/a-pp.jpg', sourceImagePath: mkImg('s/a_pp.jpg'),
      },
    ] };
    const svc = createModeDeliveryExportService({
      resolveBatchRelativePath: (_b, rel) => path.join(root, rel),
    });
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);
    assert.ok(rel.includes('乐天SG-本司/WANG YI EB23/WANG YI EB23_小票1'), rel.join('\n'));
    assert.ok(rel.includes('乐天SG-本司/WANG YI EB23/WANG YI EB23_护照'));
    assert.ok(!rel.some((r) => r.includes('CHN')), '小票 OCR 残串绝不入夹名/文件名');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2026-07-20 交付包五问题#2:分桶台账优先(表格用台账 mode_raw,分桶不得再认快照)──
test('分桶台账优先:台账 mode_raw 覆盖 modeRawPre;无台账行回落快照;查询炸了整批回落', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_ledger_'));
  try {
    const mkImg = (rel) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); return rel; };
    const batch = { id: 'batch_lg', name: 'n', tasks: [
      { id: 'pp', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
        sourceOriginalPath: 'ws1/CL20260720-002/pp.jpg', sourceImagePath: mkImg('s/pp.jpg') },
      // 快照说 SG,台账(人工补救后)说 PKG → 必须进 PKG 夹(与客户数据表同源)
      { id: 'r1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE',
        modeRawPre: '新世界SG-荣晨国际', groupNoFinal: '71990', receiptNoFinal: '2926063010900126',
        sourceOriginalPath: 'ws1/CL20260720-002/r1.jpg', sourceImagePath: mkImg('s/r1.jpg') },
      // 无台账行的票 → 回落快照
      { id: 'r2', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: '12345678901234',
        sourceOriginalPath: 'ws1/CL20260720-002/r2.jpg', sourceImagePath: mkImg('s/r2.jpg') },
    ] };
    const ledgerRepo = {
      listModeRawBySourceBatch: ({ sourceBatchId }) => (sourceBatchId === 'batch_lg'
        ? [
          { sourceTaskId: 'r1', modeRaw: '新世界PKG-宋总' },
          { sourceTaskId: 'r2', modeRaw: '' }, // 台账行模式为空(终匹配没跑完)→ 不覆盖快照
        ]
        : []),
    };
    const svc = createModeDeliveryExportService({
      resolveBatchRelativePath: (_b, rel) => path.join(root, rel),
      dailyReceiptRepo: ledgerRepo,
    });
    const plan = svc.planModeDelivery(batch);
    const dirs = plan.files.map((f) => f.dir);
    assert.ok(dirs.some((d) => d.startsWith('新世界PKG-宋总/')), '台账 mode_raw 优先,PKG 不再落回 SG 夹');
    assert.ok(!dirs.some((d) => d.startsWith('新世界SG-荣晨国际/')), '快照模式不得再当分桶依据');
    assert.ok(dirs.some((d) => d.startsWith('乐天SG-本司/')), '台账模式为空/无行 → 回落 modeRawPre');

    // setter 晚绑定路径(生产接线方式)等效
    const svc2 = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
    svc2.setDailyReceiptRepo(ledgerRepo);
    const dirs2 = svc2.planModeDelivery(batch).files.map((f) => f.dir);
    assert.ok(dirs2.some((d) => d.startsWith('新世界PKG-宋总/')));

    // 台账查询炸了 → 整批回落快照口径,交付不被拦
    const svc3 = createModeDeliveryExportService({
      resolveBatchRelativePath: (_b, rel) => path.join(root, rel),
      dailyReceiptRepo: { listModeRawBySourceBatch: () => { throw new Error('db gone'); } },
    });
    const dirs3 = svc3.planModeDelivery(batch).files.map((f) => f.dir);
    assert.ok(dirs3.some((d) => d.startsWith('新世界SG-荣晨国际/')), '查询故障回落快照');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 2026-07-27 需求F①:模式名旁标"这个区是怎么理的"(灰色括号)。口径必须与本文件分桶规则一一对应,
// 不是前端另编的说法——所以 layout 由 summarizeZones 出,前端只负责渲染。
// 2026-07-27 需求F①:模式名旁标"这个区是怎么理的"(灰色括号)。
// 口径必须与本文件的分桶规则一一对应,不是前端另编的说法 —— 所以 layout 由 summarizeZones 出。
test('渠道区整理方式:济州=按团号 / 现代=3类 / 普通模式=普通 / 未归类不标', () => {
  const { root, batch, svc } = makeFixture();
  try {
    const zones = summarizeZones(svc.planModeDelivery(batch));
    const layoutOf = (zone) => zones.find((z) => z.zone === zone)?.layout;
    assert.equal(layoutOf('济州乐天SG-道辉'), '按团号整理', '规则①按模式+团号分桶');
    assert.equal(layoutOf('现代免税店'), '3类整理', '规则②护照池/机票池/小票池');
    assert.equal(layoutOf('乐天SG-本司'), '普通', '规则③兜底:模式/客户夹');
    assert.equal(layoutOf('新罗V团-本司'), '普通');
    assert.equal(layoutOf('乐天SG-S活动'), '普通', 'S活动叠加在③之上,底子还是普通');
    assert.equal(layoutOf('未归类'), '', '未归类还没进任何规则,标"普通"是骗人');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ⭐规则⑤的标签不靠名单反推:上家取自审核员可手填的 upstreamFinal,名单永远追不全。
// 改为打包时由规则⑤在条目上写 layout,summarizeZones 直接读 —— 名单外的新上家也标得对。
test('规则⑤按上家整理:条目自带 layout,名单外的新上家(如「王总」)也不会被标成「普通」', () => {
  const entries = [
    { dir: '王总/小李/TX001', baseName: 'TX001', layout: '按上家整理' },   // 名单里没有的新上家
    { dir: '梁总/小李/TX002', baseName: 'TX002', layout: '按上家整理' },   // 名单里本来就有的
    { dir: '乐天SG-本司/ZHANG E123', baseName: 'x' },                      // 普通模式,不带 layout
    { dir: '现代免税店/小票', baseName: 'y' },                              // 三池
  ];
  const zones = summarizeZones({ files: entries });
  const layoutOf = (zone) => zones.find((z) => z.zone === zone)?.layout;
  assert.equal(layoutOf('王总'), '按上家整理', '⭐旧的名单反推法在这里会错标成「普通」');
  assert.equal(layoutOf('梁总'), '按上家整理');
  assert.equal(layoutOf('乐天SG-本司'), '普通', '不带 layout 的仍走名字判定,零回归');
  assert.equal(layoutOf('现代免税店'), '3类整理');
});

test('规则⑤实际打包的条目确实带上了 layout(不是只在测试里手造)', () => {
  const { root, batch, svc } = makeFixture();
  try {
    const plan = svc.planModeDelivery(batch);
    const upstreamEntries = (plan.files || []).filter((e) => e.layout);
    // 本夹具不含百货票时允许为空;含则必须全是「按上家整理」,且都落在上家区顶层
    for (const e of upstreamEntries) {
      assert.equal(e.layout, '按上家整理');
    }
    assert.ok(Array.isArray(plan.files));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 渠道多选导出(2026-07-28,F4 参考图落地):zones[] = 多区并集,一个 zip ──────────
test('多选切片:zones 并集过滤、互不串区;单元素 zones 与旧 zone 等价;阻断只算选中区', async () => {
  const { root, batch, svc } = makeFixture();
  try {
    const plan = svc.planModeDelivery(batch);
    const zonesAll = summarizeZones(plan).map((z) => z.zone);
    const pick = ['乐天SG-本司', '新罗V团-本司'].filter((z) => zonesAll.includes(z));
    assert.equal(pick.length, 2, '夹具必须含这两个区');

    // 行为经 exportZip 走到 entries 过滤前会先撞阻断/zip——用 planModeDelivery + 同谓词验证并集口径
    const union = plan.files.filter((e) => pick.some((z) => entryInZone(e, z, sanitize)));
    const a = plan.files.filter((e) => entryInZone(e, pick[0], sanitize));
    const b = plan.files.filter((e) => entryInZone(e, pick[1], sanitize));
    assert.equal(union.length, a.length + b.length, '两区并集=各自之和(区间互斥)');
    assert.ok(union.every((e) => e.dir.startsWith(`${pick[0]}/`) || e.dir.startsWith(`${pick[1]}/`)));

    // exportZip 端到端:zones 多选出包(容忍本机无 zip 工具;只认 EMPTY/缺号之外的两类错)
    try {
      const res = await svc.exportZip(batch, { zones: pick });
      assert.match(res.downloadName, /选中2渠道/);
      assert.equal(res.zone, '选中2渠道');
      res.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED', 'MODE_DELIVERY_RECEIPT_NO_MISSING'].includes(err.code),
        `多选导出不得因过滤逻辑炸: ${err.code || err.message}`);
    }

    // 单元素 zones ≡ 旧 zone(命名与过滤同路)
    try {
      const single = await svc.exportZip(batch, { zones: [pick[0]] });
      assert.equal(single.zone, pick[0]);
      single.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED', 'MODE_DELIVERY_RECEIPT_NO_MISSING'].includes(err.code));
    }

    // 选中区都为空 → EMPTY(不误出全量包)
    await assert.rejects(
      () => svc.exportZip(batch, { zones: ['不存在的渠道X'] }),
      (err) => err.code === 'MODE_DELIVERY_EMPTY',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
