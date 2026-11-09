'use strict';

// 2026-07-20 百货交付重构(docs/plans/2026-07-20-百货交付重构-设计.md):
//   §3 规则5 新世界/现代百货上家专链:{上家}/{代理}/{交易编号夹}/{交易编号}.ext+护照.ext;
//      缺交易编码阻断(按上家区归因);不再进规则3模式夹。
//   §5 S活动判定源=模式名含S活动 OR 票级红标签 sActivityFlag(票面属性,查团号查不出)。
//
// ⚠️ 2026-07-31 拍板改口径(0727 反馈 14-3):**一票一夹,夹名=该票交易编号**,
//   夹里就那一张票 + 护照;「无独立护照 → 夹名 姓名待补_{客户号}」(0720 拍板 a)已作废,
//   缺护照改由 zip 根「导出说明.txt」按交易编号点名。改口径的理由见下方 test 上的注释。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createModeDeliveryExportService, summarizeZones, entryInZone,
} = require('../services/mode_delivery_export_service');
const { sanitize } = require('../services/batch_customer_data_export_service');

function makeDeptFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_dept_'));
  const mkImg = (rel) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    return rel;
  };
  let seq = 0;
  const t = (over) => ({ id: `task_${++seq}`, reviewed: true, docTypeFinal: 'receipt', sourceImagePath: '', sourceOriginalPath: '', ...over });
  const batch = { id: 'b_dept', name: 'dept批', tasks: [
    // 客户A:新世界百货,有独立护照,代理=张代理;无 upstream 值 → 档案默认 梁总
    t({ docTypeFinal: 'passport', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
      customerAgentName: '张代理', sourceOriginalPath: 'ws1/CL20260720-011/a-pp.jpg', sourceImagePath: mkImg('s/a_pp.jpg') }),
    t({ receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '2921-7193', customerAgentName: '张代理',
      sourceOriginalPath: 'ws1/CL20260720-011/a-r1.jpg', sourceImagePath: mkImg('s/a_r1.jpg') }),
    t({ receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '3001-0008', customerAgentName: '张代理',
      sourceOriginalPath: 'ws1/CL20260720-011/a-r2.jpg', sourceImagePath: mkImg('s/a_r2.jpg') }),
    // 客户B:现代百货,同客户两上家(贴卡票=金浦奥莱,其余档案默认 东方)→ 两上家各成夹,护照各一份
    t({ docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
      customerAgentName: '李代理', sourceOriginalPath: 'ws1/CL20260720-012/b-pp.jpg', sourceImagePath: mkImg('s/b_pp.jpg') }),
    t({ receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1622-0011', upstreamFinal: '金浦奥莱', customerAgentName: '李代理',
      sourceOriginalPath: 'ws1/CL20260720-012/b-r1.jpg', sourceImagePath: mkImg('s/b_r1.jpg') }),
    t({ receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1622-0999', customerAgentName: '李代理',
      sourceOriginalPath: 'ws1/CL20260720-012/b-r2.jpg', sourceImagePath: mkImg('s/b_r2.jpg') }),
    // 客户C:新世界百货,无独立护照(passportFree 店的常态)→ 夹名照样是交易编号;代理链退 sourceGroupLabel
    t({ receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '4400-5566', sourceGroupLabel: '王代理 王五',
      sourceOriginalPath: 'ws1/CL20260720-013/c-r1.jpg', sourceImagePath: mkImg('s/c_r1.jpg') }),
  ] };
  const svc = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
  return { root, batch, svc };
}

// ⭐0731 拍板改口径(14-3「文件夹要以交易编码命名」):**一票一夹,夹名=该票交易编号**,
// 夹里就那一张票 + 护照。此前是「一客户一夹,夹名=桶内最小交易编码;无独立护照就叫
// 姓名待补_{客户号}」(0720 拍板 a)——而 14-3 的主场新世界百货标了 passportFree
// (票面本就无护照),「没有独立护照」是常态,于是大多数夹叫 姓名待补_CLxxxx,
// 与需求正面冲突(用户截图 image64 圈的就是它)。本测试原来把旧行为整条钉死,
// 这次是按用户新拍板重写断言,不是为了让代码改绿。
test('规则5:一票一夹,夹名=该票交易编号;护照随每个夹各一份;不再有姓名待补夹;不再进模式夹', () => {
  const { root, batch, svc } = makeDeptFixture();
  try {
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);

    // 客户A:新世界默认上家=梁总;两张票 → 两个夹,各自以自己的交易编号命名,护照各一份
    assert.ok(rel.includes('梁总/张代理/2921-7193/2921-7193'), rel.join('\n'));
    assert.ok(rel.includes('梁总/张代理/2921-7193/护照'));
    assert.ok(rel.includes('梁总/张代理/3001-0008/3001-0008'), '第二张票自己一个夹,不再挤进首张票的夹');
    assert.ok(rel.includes('梁总/张代理/3001-0008/护照'), '每个夹里都要有护照,上家不用跨夹找');

    // 客户B:两上家各成夹(贴卡=金浦奥莱/默认=东方),护照各一份
    assert.ok(rel.includes('金浦奥莱/李代理/1622-0011/1622-0011'));
    assert.ok(rel.includes('金浦奥莱/李代理/1622-0011/护照'));
    assert.ok(rel.includes('东方/李代理/1622-0999/1622-0999'));
    assert.ok(rel.includes('东方/李代理/1622-0999/护照'));

    // 客户C:无独立护照 → 夹名照样是交易编号(不再叫姓名待补_);夹里没有护照文件
    assert.ok(rel.includes('梁总/王代理 王五/4400-5566/4400-5566'), '代理退 sourceGroupLabel;夹名=交易编号');
    assert.ok(!rel.some((r) => r.startsWith('梁总/王代理 王五/4400-5566/') && r.endsWith('/护照')),
      '这个客户确实没有护照图,夹里就不该有护照文件');

    // ⭐14-3 的核心一条:整个包里不许再出现「姓名待补」夹名
    assert.ok(!rel.some((r) => r.includes('姓名待补')),
      `夹名必须一律是交易编号,实际:${rel.filter((r) => r.includes('姓名待补')).join(' / ')}`);

    // 防一票两包:百货票不得再落规则3的模式夹(新世界百货/现代百货顶层夹不该存在)
    assert.ok(!rel.some((r) => r.startsWith('新世界百货/') || r.startsWith('现代百货/')), '百货票不再进通用模式夹');
    assert.equal(plan.customers, 3);

    // 渠道区汇总:上家名成区,customerDirs=夹数(一票一夹后=该区的票数)
    const zones = summarizeZones(plan);
    const zoneNames = zones.map((z) => z.zone).sort();
    assert.deepEqual(zoneNames, ['东方', '梁总', '金浦奥莱'].sort());
    assert.equal(zones.find((z) => z.zone === '梁总').customerDirs, 3, '梁总区=客户A两张票两夹+客户C一夹');

    // 切片谓词:上家区只含自己的夹
    const liangFiles = plan.files.filter((e) => entryInZone(e, '梁总', sanitize));
    assert.ok(liangFiles.length > 0);
    assert.ok(liangFiles.every((e) => e.dir.startsWith('梁总/')));

    // 缺护照回执(0728 image64):夹名不再喊「姓名待补」,信息改由这份名单承载,
    // 而且必须点到**交易编号**——上家就是按交易编号对账的。
    assert.equal(plan.namePendingCustomers.length, 1, '只有客户C缺护照');
    assert.equal(plan.namePendingCustomers[0].customerId, 'CL20260720-013');
    assert.equal(plan.namePendingCustomers[0].zone, '梁总');
    assert.deepEqual(plan.namePendingCustomers[0].folders, ['4400-5566']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('规则5:缺交易编码阻断(按上家区归因);切别的上家不被拦;整组未审跳过', async () => {
  const { root, batch, svc } = makeDeptFixture();
  try {
    // 抹掉客户A一张票的交易编码 → 阻断,zone=梁总
    const aTask = batch.tasks.find((x) => x.receiptNoFinal === '3001-0008');
    aTask.receiptNoFinal = '';
    aTask.receiptNoAuto = '';
    const plan = svc.planModeDelivery(batch);
    assert.ok(plan.missingDeptTransNo.some((s) => s.includes('CL20260720-011')), plan.missingDeptTransNo.join());
    assert.deepEqual(plan.missingDeptTransNoDetails.map((d) => d.label), plan.missingDeptTransNo, 'details 与字符串数组平行');
    assert.equal(plan.missingDeptTransNoDetails[0].zone, '梁总');

    // 全量导出被拦;切 梁总 被拦;切 东方 不被梁总的缺号拦
    await assert.rejects(() => svc.exportZip(batch), (err) => err.code === 'MODE_DELIVERY_RECEIPT_NO_MISSING');
    await assert.rejects(() => svc.exportZip(batch, { zone: '梁总' }), (err) => err.code === 'MODE_DELIVERY_RECEIPT_NO_MISSING');
    try {
      const result = await svc.exportZip(batch, { zone: '东方' });
      assert.equal(result.zone, '东方');
      result.cleanup();
    } catch (err) {
      assert.ok(['ZIP_UNAVAILABLE', 'ZIP_FAILED'].includes(err.code), `不该被别区阻断拦住,实际: ${err.code || err.message}`);
    }

    // 整组未审:百货客户也走 skipped 名单
    for (const x of batch.tasks) {
      if (String(x.sourceOriginalPath).includes('CL20260720-012')) x.reviewed = false;
    }
    const plan2 = svc.planModeDelivery(batch);
    assert.ok(plan2.skippedUnreviewed.includes('CL20260720-012'));
    assert.ok(!plan2.files.some((f) => f.dir.startsWith('金浦奥莱/')), '未审组的票不得进包');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('乐天百货(LOTTE_DEPT)不进通用模式桶:有独立《乐天百货交付包》,防一票两包/串错上家(审计HIGH line585)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_lottedept_'));
  try {
    const mkImg = (rel) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
      return rel;
    };
    const batch = { id: 'b_ld', name: 'n', tasks: [
      // 客户L:乐天百货(LOTTE_DEPT)带模式名——修复前会漏进「乐天SG-本司」通用夹,与它的独立乐天包一票两包
      { id: 'lpp', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
        sourceOriginalPath: 'ws1/CL20260722-031/pp.jpg', sourceImagePath: mkImg('s/lpp.jpg') },
      { id: 'lr', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: 'LDEPT-7788',
        sourceOriginalPath: 'ws1/CL20260722-031/r.jpg', sourceImagePath: mkImg('s/lr.jpg') },
      // 客户M:乐天免税店(LOTTE,非百货)同模式——对照,必须照常进模式夹(证明没误伤免税店)
      { id: 'mpp', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
        sourceOriginalPath: 'ws1/CL20260722-032/pp.jpg', sourceImagePath: mkImg('s/mpp.jpg') },
      { id: 'mr', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: '90335-26-003255',
        sourceOriginalPath: 'ws1/CL20260722-032/r.jpg', sourceImagePath: mkImg('s/mr.jpg') },
    ] };
    const svc = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);

    // 乐天百货客户(WANG YI)绝不产出任何通用/上家交付文件(有独立乐天百货交付包)
    assert.ok(!rel.some((r) => r.includes('WANG YI')), '乐天百货票不该进通用模式包:\n' + rel.join('\n'));
    assert.ok(!rel.some((r) => r.startsWith('乐天SG-本司/WANG YI')), '乐天百货票不该落模式夹');
    // 对照:乐天免税店同模式票照常进模式夹(修复只排乐天百货,不误伤免税店)
    assert.ok(rel.some((r) => r.startsWith('乐天SG-本司/LI SI')), '乐天免税店票仍进模式夹:\n' + rel.join('\n'));
    // 只有免税店客户产出交付文件;百货客户 modeReceipts/upstreamDept 皆空→continue 跳过
    assert.equal(plan.customers, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S活动票级红标签:普通模式勾 sActivityFlag 也出双份;未归类红标签票同样成立;缺票号阻断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_sflag_'));
  try {
    const mkImg = (rel) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
      return rel;
    };
    const batch = { id: 'b_sflag', name: 'n', tasks: [
      { id: 'pp', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
        sourceOriginalPath: 'ws1/CL20260720-021/pp.jpg', sourceImagePath: mkImg('s/pp.jpg') },
      // 普通模式(名字不含S活动)+ 红标签 → 模式夹一份 + S活动/{该模式}/{digits14 票号}一份
      { id: 'r1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: '90335-26-003255', sActivityFlag: true,
        sourceOriginalPath: 'ws1/CL20260720-021/r1.jpg', sourceImagePath: mkImg('s/r1.jpg') },
      // 同组普通票(无标签)→ 不复制
      { id: 'r2', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '乐天SG-本司', groupNoFinal: '26141846', receiptNoFinal: '11111111111111',
        sourceOriginalPath: 'ws1/CL20260720-021/r2.jpg', sourceImagePath: mkImg('s/r2.jpg') },
      // 未归类(模式空)+ 红标签 → S活动/未归类/ 也成立(票号无模式合同=原样)
      { id: 'r3', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE',
        modeRawPre: '', groupNoFinal: '', receiptNoFinal: '2222-3333', sActivityFlag: true,
        sourceOriginalPath: 'ws1/CL20260720-022/r3.jpg', sourceImagePath: mkImg('s/r3.jpg') },
    ] };
    const svc = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);
    assert.ok(rel.includes('乐天SG-本司/WANG YI EB23/WANG YI EB23_小票1'), rel.join('\n'));
    assert.ok(rel.includes('S活动/乐天SG-本司/9033526003255'), '红标签票按自己桶模式落 S活动 副本(digits14 去杠)');
    assert.ok(!rel.includes('S活动/乐天SG-本司/11111111111111'), '无标签普通票不复制');
    assert.ok(rel.includes('S活动/未归类/2222-3333'), '未归类红标签票也出副本(无合同原样)');

    // 红标签票缺票号 → 阻断(与模式名S活动同口径)
    const r1 = batch.tasks.find((x) => x.id === 'r1');
    r1.receiptNoFinal = '';
    r1.receiptNoAuto = '';
    const plan2 = svc.planModeDelivery(batch);
    assert.ok(plan2.missingSActivityReceiptNo.some((s) => s.includes('CL20260720-021')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 导出说明.txt(0728 截图驱动,image64:姓名待补夹全靠人翻才发现)────────────────
test('导出说明:姓名待补/复制失败有内容才生成;干净包不写;exportZip 落包根', () => {
  const { buildDeliveryNotes } = require('../services/mode_delivery_export_service');
  // 干净包:null 不写(不给收件人塞噪音)
  assert.equal(buildDeliveryNotes({}), null);
  assert.equal(buildDeliveryNotes({ namePending: [], copyFailed: [] }), null);
  // 缺护照:按**交易编号**点名(14-3 之后夹名不再喊「姓名待补」,信息位挪到这里),
  // 客户号仍附在后面(我们自己回查用),并给上家可执行的下一步
  const notes = buildDeliveryNotes({
    namePending: [{ customerId: 'CL20260720-013', zone: '梁总', folders: ['4400-5566', '4400-5567'] }],
    copyFailed: ['东方/李代理/1622-0999/1622-0999.jpg'],
  });
  const text = notes.join('\n');
  assert.match(text, /【没有护照图·夹里只有小票】2 个交易编号夹/, '数的是夹(=票),不是客户');
  assert.match(text, /4400-5566、4400-5567.*上家:梁总.*CL20260720-013/);
  assert.match(text, /按交易编号回报/, '给上家的行动指引:他手上只有交易编号');
  assert.doesNotMatch(text, /姓名待补_/, '夹名里已经没有这个前缀了,说明里也别再教人去找');
  assert.match(text, /【文件缺失】1 张/);
  assert.match(text, /1622-0999\.jpg/);
  // 复制失败超 20 条截断但报总数
  const many = buildDeliveryNotes({ copyFailed: Array.from({ length: 25 }, (_, i) => `f${i}.jpg`) });
  assert.match(many.join('\n'), /等共 25 张/);

  // ── 0729:「不用记」的图在包里、账不在单上 ──────────────────────────────
  // 0724 拍板这些行不进任何导出账单,但图照进包 → 包里图数 > 账单行数。差额合规,
  // 可此前没人告诉收件人,对账的只能回来问。生产实测这不是边角:全库台账 14653 行
  // 里 3774 行(25.8%)是「不用记」。
  const nr = buildDeliveryNotes({
    noRecordReceipts: 3, noRecordModes: ['新罗SG-新琪 不用记', '济州新罗SG-道辉 不用记'],
  });
  const nrText = nr.join('\n');
  assert.match(nrText, /【图在包里·账不在单上】本包含 3 张/);
  assert.match(nrText, /新罗SG-新琪 不用记/, '列出涉及模式,收件人能自查是哪几笔');
  assert.match(nrText, /不用回来核对/, '要明说这是正常的,否则等于换个地方制造疑问');
  // 0 张时不写(干净包不塞噪音,与其它段同规矩)
  assert.equal(buildDeliveryNotes({ noRecordReceipts: 0, noRecordModes: [] }), null);

  // 接线契约:统计口径必须与分桶同源(台账 mode_raw 优先的 resolveTaskMode),
  // 否则说明里的数字和包里实际内容对不上,反而制造新的对不上。
  const planSrc = fs.readFileSync(path.join(__dirname, '../services/mode_delivery_export_service.js'), 'utf8');
  assert.match(planSrc, /const mode = resolveTaskMode\(t\);[\s\S]{0,160}isNoRecordMode\(mode\)/,
    '统计走 resolveTaskMode(与分桶同源),不是任务快照');
  assert.match(planSrc, /noRecordReceipts: plan\.noRecordReceiptCount \|\| 0/, '计划统计接进说明');
  // 只数不滤:交付包里放什么不因这次改动而变(改了就是业务变更,得先拍板)
  assert.ok(!/isNoRecordMode\([^)]*\)\)\s*continue/.test(planSrc),
    '不得在交付计划里过滤「不用记」——那是业务变更,不是补说明');

  // 接线契约:exportZip 把说明写进包根(带 BOM 防中文乱码),姓名待补按选中渠道过滤
  const src = fs.readFileSync(path.join(__dirname, '../services/mode_delivery_export_service.js'), 'utf8');
  assert.match(src, /buildDeliveryNotes\(\{\s*\n?\s*namePending, copyFailed, skippedUnreviewed/);
  assert.ok(src.includes("导出说明.txt'), '\\ufeff'"), '写文件带 UTF-8 BOM(源码显式转义)');
  assert.match(src, /namePendingCustomers \|\| \[\]\)\.filter\(\(d\) => inSelected\(d\.zone\)\)/, '切片导出只列选中渠道的待补');
});

// ── 0729 生产核验:未审完客户组静默少发(0722 批实测 3 个)────────────────────────
test('导出说明:未审完客户组进【未进包】段(整组不进包是既有边界,但不能没人知道)', () => {
  const { buildDeliveryNotes } = require('../services/mode_delivery_export_service');
  const text = buildDeliveryNotes({ skippedUnreviewed: ['CL20260722-007', 'CL20260722-011'] }).join('\n');
  assert.match(text, /【未进包·还没审完】2 个客户组/);
  assert.match(text, /CL20260722-007/, '点名是哪几个,不给一个光秃秃的数字');
  assert.match(text, /审完后重新导出即可收进来/, '给出路不只报警');
  // 接线:exportZip 必须把计划里的名单喂进来(否则又变成"算了但没人看")
  const src = fs.readFileSync(path.join(__dirname, '../services/mode_delivery_export_service.js'), 'utf8');
  assert.match(src, /skippedUnreviewed: plan\.skippedUnreviewed/);
});

// ── 0729 静默排查 A2:源图取不到 = 包里少图,此前四处裸 continue,谁也不知道 ──────
test('导出说明:源图取不到的图要进【源图取不到】名单(兄弟服务早有,本文件此前漏了)', () => {
  const { buildDeliveryNotes } = require('../services/mode_delivery_export_service');
  const notes = buildDeliveryNotes({
    missingSource: ['CL20260729-001/task_0003(小票)', '现代:CL20260729-002/task_0007(护照)'],
  });
  const text = notes.join('\n');
  assert.match(text, /【源图取不到·没进包】2 张图/);
  assert.match(text, /现代:CL20260729-002/, '现代子计划算好却被上游丢弃的名单要并进来');
  assert.match(text, /不用找客户/, '这是我们这边的文件问题,别把锅甩给收件人');
});

// 归因修正:混为一谈会让上家白跑一趟——他手上根本没有能补的东西
test('导出说明:「护照图丢了」必须与「客户没交护照」分开,行动指引相反', () => {
  const { buildDeliveryNotes } = require('../services/mode_delivery_export_service');
  const lost = buildDeliveryNotes({
    passportSourceLost: [{ customerId: 'CL20260729-010', zone: '梁总', folders: ['4400-5566'] }],
  }).join('\n');
  assert.match(lost, /【护照图丢失·非客户问题】1 个客户/);
  assert.match(lost, /4400-5566.*上家:梁总/);
  assert.match(lost, /请勿向客户索要/, '客户交过,找他要是白跑一趟');
  assert.doesNotMatch(lost, /按交易编号回报/, '不得混进「客户没交护照」的指引');

  // 对照:真的没交护照 → 另一条,叫上家按交易编号回报姓名
  const pending = buildDeliveryNotes({
    namePending: [{ customerId: 'CL20260729-011', zone: '梁总', folders: ['4400-5567'] }],
  }).join('\n');
  assert.match(pending, /【没有护照图·夹里只有小票】1 个交易编号夹/);
  assert.match(pending, /按交易编号回报/);
  assert.doesNotMatch(pending, /护照图丢失/);

  // 接线契约:计划层必须按「有护照任务但文件全取不到」判定,不能只看 passportFiles 是否为空
  const src = fs.readFileSync(path.join(__dirname, '../services/mode_delivery_export_service.js'), 'utf8');
  assert.match(src, /const passportLost = passports\.length > 0 && passportFiles\.length === 0/);
  assert.match(src, /if \(passportLost\)[\s\S]{0,200}passportSourceLost\.push/, '丢图走独立名单');
  assert.doesNotMatch(src, /passports\.map\(\(t\) => resolveTaskFile\(batch\.id, t\)\)\.filter\(Boolean\)/,
    '旧写法把两种情况压成同一个空数组');
  // 现代子计划的 missingSource 不得再被原地丢弃
  assert.match(src, /hyundaiPlan\?\.missingSource/, '下游算好的名单必须并进来');
});

// ── 0731 与 14-3 同一处代码的两条侧修 ────────────────────────────────────
// 都是"同一个事实,两个读者"这个老原型:交易编号被两处各读一遍,一图一票护栏漏接一条链。

test('⭐夹名/文件名的交易编号必须与客户数据 Excel 那列同一个串(存量 8 位裸值补杠 4-4)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_dash_'));
  try {
    const mk = (rel) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
      return rel;
    };
    const batch = { id: 'b_dash', name: 'dash批', tasks: [
      { id: 'p1', reviewed: true, docTypeFinal: 'passport', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
        customerAgentName: '张代理', sourceOriginalPath: 'ws1/CL20260731-001/pp.jpg', sourceImagePath: mk('s/pp.jpg') },
      // 存量口径:8 位纯数字无杠(0727#13-4 之前入库的,以及人工省杠输入的)
      { id: 'r1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE_DEPT',
        receiptNoFinal: '39442108', customerAgentName: '张代理',
        sourceOriginalPath: 'ws1/CL20260731-001/r1.jpg', sourceImagePath: mk('s/r1.jpg') },
    ] };
    const svc = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
    const rel = svc.planModeDelivery(batch).files.map((f) => `${f.dir}/${f.baseName}`);

    // 这张票在客户数据 Excel 里是 3944-2108(formatReceiptNoForMode dash44)。
    // 交付包此前直接取存储裸值 → 夹叫 39442108、账单写 3944-2108,上家两边对不上号
    // (0731 核账报告 idx42 边界②)。现在两边同一个函数。
    assert.ok(rel.includes('梁总/张代理/3944-2108/3944-2108'),
      `夹名与文件名都应是票面形态 3944-2108,实际:${rel.join(' / ')}`);
    assert.ok(!rel.some((r) => r.includes('39442108')), '不许再出现裸值形态');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('⭐一图两票必须拦在规则5这条链上(此前只有规则1/3 接了护栏)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modedeliv_dup_'));
  try {
    const abs = path.join(root, 's/shared.jpg');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    // 同一张照片上两张新世界票,各自一个交易编号,谁也没有框
    const shared = 's/shared.jpg';
    const batch = { id: 'b_dup', name: 'dup批', tasks: [
      { id: 'r1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE_DEPT',
        receiptNoFinal: '5001-0001', customerAgentName: '张代理',
        sourceOriginalPath: 'ws1/CL20260731-002/shared.jpg', sourceImagePath: shared },
      { id: 'r2', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE_DEPT',
        receiptNoFinal: '5001-0002', customerAgentName: '张代理',
        sourceOriginalPath: 'ws1/CL20260731-002/shared.jpg', sourceImagePath: shared },
    ] };
    const svc = createModeDeliveryExportService({ resolveBatchRelativePath: (_b, rel) => path.join(root, rel) });
    const plan = svc.planModeDelivery(batch);
    const rel = plan.files.map((f) => `${f.dir}/${f.baseName}`);

    // 一票一夹之后这个 bug 更刺眼:两个交易编号夹里躺着一模一样的图 = 同一张照片报了两笔账
    assert.equal(rel.length, 0, `没框的共图票一张都不该出包,实际:${rel.join(' / ')}`);
    assert.equal(plan.imageBlocked.length, 2, '两张都要进阻断名单,不能静默');
    assert.ok(plan.imageBlocked.every((s) => s.includes('CL20260731-002')), plan.imageBlocked.join(' | '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
