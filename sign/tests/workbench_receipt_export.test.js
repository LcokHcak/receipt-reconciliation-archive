const test = require('node:test');
const assert = require('node:assert/strict');

let buildReceiptExportRows = () => [];
let formatBusinessDate = () => '';
let formatDateParts = () => '';
let getCustomerIdDate = () => '';
let resolveReceiptCollectedDate = () => '';
let resolveCollectedDateFromLedgerRow = () => '';
let isNoRecordMode = () => false;
try {
  ({
    buildReceiptExportRows, formatBusinessDate, formatDateParts,
    getCustomerIdDate, resolveReceiptCollectedDate, resolveCollectedDateFromLedgerRow, isNoRecordMode,
  } = require('../lib/workbench_receipt_export'));
} catch (_error) {
  buildReceiptExportRows = () => [];
  formatBusinessDate = () => '';
  formatDateParts = () => '';
}

test('收票日期口径:客户建档日(createdAt→KST)优先 > 客户编号 CLyyyymmdd > 任务建档日', () => {
  // createdAt 优先(2026-07-15 16:00 UTC = KST 07-16)
  assert.equal(
    resolveReceiptCollectedDate({
      customerContext: { createdAt: '2026-07-15T16:00:00.000Z', customerId: 'CL20260710-001' },
      task: {},
    }),
    '2026-07-16',
    'createdAt 转 KST 优先',
  );
  // 无 createdAt → 回落客户编号内嵌日期(天生 KST)
  assert.equal(
    resolveReceiptCollectedDate({ customerContext: { customerId: 'CL20260710-001' }, task: {} }),
    '2026-07-10',
  );
  // 都无 → 回落任务建档日
  assert.equal(
    resolveReceiptCollectedDate({ customerContext: {}, task: { createdAt: '2026-07-01', sourceFolderName: 'x' } }),
    '2026-07-01',
  );
});

test('台账行收票日期:source_customer_id 的 CLyyyymmdd(上传日),不用行内 receipt_date(审核通过日)', () => {
  assert.equal(
    resolveCollectedDateFromLedgerRow({ source_customer_id: 'CL20260710-042', receipt_date: '2026-07-20' }),
    '2026-07-10',
    '取上传日,不取审核通过日 2026-07-20',
  );
  assert.equal(getCustomerIdDate('CL20260710-001'), '2026-07-10');
  assert.equal(getCustomerIdDate('不是编号'), '');
});

test('isNoRecordMode:识别「不用记」尾巴模式', () => {
  assert.equal(isNoRecordMode('乐天SG-本司不用记'), true);
  assert.equal(isNoRecordMode('乐天SG-本司'), false);
  assert.equal(isNoRecordMode(''), false);
});

test('formatDateParts 取 Asia/Seoul 当天(KST 凌晨 UTC 仍是前一天)——乐天百货顶层夹日期不再错一天(审计MEDIUM)', () => {
  // 2026-07-15 16:00 UTC = 2026-07-16 01:00 KST:KST 已跨到 16 号,toISOString(UTC)仍是 15 号
  const at0100Kst = new Date('2026-07-15T16:00:00.000Z');
  assert.equal(at0100Kst.toISOString().slice(0, 10), '2026-07-15', 'UTC 口径(旧 bug)=前一天');
  assert.equal(formatDateParts(at0100Kst), '2026-07-16', 'KST 口径=当天');
  // 08:59 KST(23:59 UTC 前一天)仍属当天 KST
  assert.equal(formatDateParts(new Date('2026-07-15T23:59:00.000Z')), '2026-07-16');
  // KST 白天不受影响
  assert.equal(formatDateParts(new Date('2026-07-16T05:00:00.000Z')), '2026-07-16');
});

test('buildReceiptExportRows emits daily receipt rows and carries passport/customer context', () => {
  const customerContextByGroup = new Map([
    ['group-a', {
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      createdAt: '2026-04-19T15:30:00.000Z',
    }],
  ]);
  const rows = buildReceiptExportRows([
    {
      id: 'passport-1',
      sourceGroupKey: 'group-a',
      originalFileName: 'passport.jpg',
      sourceType: 'image',
      docTypeFinal: 'passport',
      docTypeAuto: 'passport',
      extractedNameFinal: 'KIM MINSU',
      chineseNameFinal: 'JIN MIN ZHU',
      passportNoFinal: 'M12345678',
      groupNoFinal: 'TEAM-9',
      departureDateFinal: '2026-04-20',
      purchaseDateFinal: '',
      purchaseDateAuto: '',
      receiptStoreFinal: '',
      receiptStoreAuto: '',
      receiptNoFinal: '',
      receiptNoAuto: '',
      processResult: 'approved',
      reviewed: true,
      reviewedAt: '2026-04-17T10:00:00.000Z',
      reviewNote: '',
      needsReview: false,
      signatureStyle: 'cursive',
      signatureJobStatus: '',
      finalSignatureSource: '',
      signatureJobError: '',
      sourceImagePath: 'source/passport.jpg',
      signatureRegionPath: '',
      finalSignaturePath: '',
    },
    {
      id: 'receipt-1',
      sourceGroupKey: 'group-a',
      originalFileName: 'receipt-1.jpg',
      sourceType: 'image',
      docTypeFinal: 'receipt',
      docTypeAuto: 'receipt',
      extractedNameFinal: '',
      chineseNameFinal: '',
      passportNoFinal: '',
      groupNoFinal: '',
      departureDateFinal: '',
      purchaseDateFinal: '2026-04-16',
      purchaseDateAuto: '',
      receiptStoreFinal: 'LOTTE',
      receiptStoreAuto: '',
      receiptNoFinal: 'RCPT-001',
      receiptNoAuto: '',
      processResult: 'approved',
      reviewed: true,
      reviewedAt: '',
      reviewNote: 'first receipt',
      needsReview: false,
      signatureStyle: 'cursive',
      signatureJobStatus: '',
      finalSignatureSource: '',
      signatureJobError: '',
      sourceImagePath: 'source/receipt-1.jpg',
      signatureRegionPath: '',
      finalSignaturePath: '',
    },
    {
      id: 'receipt-draft',
      sourceGroupKey: 'group-a',
      originalFileName: 'draft_receipt.jpg',
      sourceType: 'image',
      docTypeFinal: 'receipt',
      docTypeAuto: 'receipt',
      receiptStoreFinal: 'LOTTE',
      receiptNoFinal: 'DRAFT-001',
      processResult: 'needs_fields',
      reviewed: false,
    },
    {
      id: 'receipt-2',
      sourceGroupKey: 'group-a',
      originalFileName: 'manual_receipt.jpg',
      sourceType: 'manual',
      docTypeFinal: 'receipt',
      docTypeAuto: 'receipt',
      extractedNameFinal: '',
      chineseNameFinal: '',
      passportNoFinal: '',
      groupNoFinal: '',
      departureDateFinal: '',
      purchaseDateFinal: '',
      purchaseDateAuto: '',
      receiptStoreFinal: '',
      receiptStoreAuto: 'THE SHILLA',
      receiptNoFinal: 'RCPT-002',
      receiptNoAuto: '',
      processResult: 'approved',
      reviewed: true,
      reviewedAt: '',
      reviewNote: 'second receipt',
      needsReview: false,
      signatureStyle: 'cursive',
      signatureJobStatus: '',
      finalSignatureSource: '',
      signatureJobError: '',
      sourceImagePath: 'source/receipt-1.jpg',
      signatureRegionPath: '',
      finalSignaturePath: '',
    },
  ], { customerContextByGroup });

  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), [
    'chinese_name',
    'passport_name',
    'passport_no',
    'receipt_store',
    'receipt_no',
    'group_no',
    'receipt_amount',
    'upstream',
    'purchase_date',
    'departure_date',
    'agent',
    'receipt_date',
    'mode',
    'note',
  ]);
  assert.equal(rows[0].receipt_store, 'LOTTE');
  assert.equal(rows[0].receipt_no, 'RCPT-001');
  assert.equal(rows[0].passport_name, 'KIM MINSU');
  assert.equal(rows[0].chinese_name, 'JIN MIN ZHU');
  assert.equal(rows[0].passport_no, 'M12345678');
  assert.equal(rows[0].group_no, 'TEAM-9');
  assert.equal(rows[0].departure_date, '2026-04-20');
  assert.equal(rows[0].agent, 'Agent Han');
  assert.equal(rows[0].receipt_date, '2026-04-20');
  assert.equal(rows[0].mode, '');

  assert.equal(rows[1].receipt_store, 'THE SHILLA');
  assert.equal(rows[1].receipt_no, 'RCPT-002');
  assert.equal(rows[1].passport_name, 'KIM MINSU');
  assert.equal(rows[1].passport_no, 'M12345678');
  assert.equal(rows[1].group_no, 'TEAM-9');
});

test('buildReceiptExportRows exports only the approved records it receives from batch export', () => {
  const rows = buildReceiptExportRows([
    {
      id: 'passport-1',
      sourceGroupKey: 'group-a',
      docTypeFinal: 'passport',
      extractedNameFinal: 'KIM MINSU',
      passportNoFinal: 'M12345678',
      reviewed: true,
    },
    {
      id: 'receipt-1',
      sourceGroupKey: 'group-a',
      docTypeFinal: 'receipt',
      receiptStoreFinal: 'LOTTE',
      receiptNoFinal: '90182325003077',
      reviewed: true,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].receipt_no, '90182325003077');
  assert.equal(rows[0].passport_no, 'M12345678');
});

test('buildReceiptExportRows resolves passport context once per group instead of once per receipt', () => {
  let docTypeReads = 0;
  const createTask = (task) => ({
    ...task,
    get docTypeFinal() {
      docTypeReads += 1;
      return task.docTypeFinal;
    },
  });
  const tasks = [
    createTask({
      id: 'passport-1',
      sourceGroupKey: 'group-a',
      docTypeFinal: 'passport',
      extractedNameFinal: 'KIM MINSU',
      passportNoFinal: 'M12345678',
      reviewed: true,
    }),
    ...Array.from({ length: 80 }, (_item, index) => createTask({
      id: `receipt-${index}`,
      sourceGroupKey: 'group-a',
      docTypeFinal: 'receipt',
      receiptStoreFinal: 'LOTTE',
      receiptNoFinal: `9018232500${String(index).padStart(4, '0')}`,
      reviewed: true,
    })),
  ];

  const rows = buildReceiptExportRows(tasks);

  assert.equal(rows.length, 80);
  assert.equal(rows[0].passport_no, 'M12345678');
  assert.ok(docTypeReads <= 200, `expected linear doc type reads, got ${docTypeReads}`);
});

// 导出表头 ↔ 台账检测器,是一根**没人看得见的绳子**。
// isDailyLedgerHeaderRow 靠表头字符串判定「这张表是不是每日台账」,
// 只改导出侧的话,系统 0731 之后自己导出的表会被判成"不是台账"而**整张跳过**——
// 而跳过是静默的,现场表现是"导出的东西回读时凭空少了一批",没有任何报错指向表头。
// 0731 改名时就是先撞上这根绳子才没改瞎。这条把两侧绑在一起。
test('⭐导出表头必须能被台账检测器认出来(两侧同改,别只改一边)', () => {
  const { RECEIPT_EXPORT_HEADERS } = require('../lib/workbench_receipt_export');
  const { isDailyLedgerHeaderRow } = require('../lib/monthly_pipeline/daily_receipt_mapper');
  assert.ok(isDailyLedgerHeaderRow([...RECEIPT_EXPORT_HEADERS]),
    `导出表头 ${JSON.stringify(RECEIPT_EXPORT_HEADERS)} 不被 isDailyLedgerHeaderRow 认可`
    + ' —— 改了导出表头就要同步 daily_receipt_mapper 的 FIELD_ALIASES.receiptNo');

  // 旧表头也必须继续认:存量台账不能因为我们改了个名字就读不进来
  assert.ok(isDailyLedgerHeaderRow(['中文姓名', '小票号', '团号', '购买日期']),
    '旧表头「小票号」必须继续被认');
});

test('receipt export headers include receipt store before receipt number', () => {
  const { RECEIPT_EXPORT_HEADERS } = require('../lib/workbench_receipt_export');

  assert.deepEqual(RECEIPT_EXPORT_HEADERS, [
    '中文姓名',
    '英文姓名',
    '护照号码',
    '免税店',
    // 0731 拍板:跟 export_plan_engine / field_registry 对齐。审核台对百货显示的是
    // 「交易编号」,表头只写「小票号」时,审核员填的名字和表上的名字对不上。
    '小票号/交易编号',
    '团号',
    // 0731 拆百货借位后新增:金额和上家各有自己的列,不再借团号/姓名的位
    '金额',
    '上家',
    '购买日期',
    '离境日期',
    '代理',
    '收票日期',
    '模式',
    '备注',
  ]);
  // ⚠️ 用列**索引**比顺序时,名字必须跟上面那份全集用同一个字符串。
  // 0731 改名时这里没跟着改,indexOf('小票号') 返回 -1,断言变成 3 < -1 —— 真红。
  // 幸好它红了:如果当初写的是 includes 之类的模糊匹配,就会一路绿着放过去。
  assert.ok(
    RECEIPT_EXPORT_HEADERS.indexOf('免税店') < RECEIPT_EXPORT_HEADERS.indexOf('小票号/交易编号'),
    '免税店列要排在票号列前面',
  );
});

// —— 模式记录矩阵在导出层的行为(统一审核+出口过滤,《所有模式小票具体记录流程》) ——

function makeMatrixTask(overrides = {}) {
  return {
    id: 'task-m1',
    sourceGroupKey: 'group-m',
    docTypeFinal: 'receipt',
    reviewed: true,
    processResult: 'approved',
    receiptStoreFinal: 'THE SHILLA',
    receiptNoFinal: '1234567890123',
    groupNoFinal: '25184',
    purchaseDateFinal: '2026-07-01',
    departureDateFinal: '2026-07-03',
    chineseNameFinal: '张三',
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'EG1234567',
    createdAt: '2026-07-01T02:00:00.000Z',
    ...overrides,
  };
}

test('简记模式(新罗SG-新琪):导出抹掉"不用记录"列,只留收票日期/代理/团号', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched',
    modeRawPre: '新罗SG-新琪',
  })]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.mode, '新罗SG-新琪');
  assert.equal(row.group_no, '25184');       // 记录
  assert.ok(row.receipt_date);               // 记录
  assert.equal(row.receipt_no, '');          // 不用记录
  assert.equal(row.purchase_date, '');       // 不用记录
  assert.equal(row.chinese_name, '');        // 不用记录
  assert.equal(row.passport_name, '');       // 不用记录
  assert.equal(row.passport_no, '');         // 不用记录
  assert.equal(row.departure_date, '');      // 不用记录
  assert.equal(row.receipt_store, 'THE SHILLA'); // 系统列恒保留
});

test('未知/未命中模式 = 普通模式:全列照记,不做任何过滤', () => {
  // 未命中(not_found):mode 空,全记
  const missRows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'not_found',
    modeRawPre: '',
  })]);
  assert.equal(missRows[0].mode, '');
  assert.equal(missRows[0].receipt_no, '1234567890123');
  assert.equal(missRows[0].passport_no, 'EG1234567');

  // 命中但模式是矩阵没有的新模式:照常全记(用户拍板:未知=普通,绝不特殊拦)
  const unknownRows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched',
    modeRawPre: '全新渠道-某代理',
  })]);
  assert.equal(unknownRows[0].mode, '全新渠道-某代理');
  assert.equal(unknownRows[0].receipt_no, '1234567890123');
  assert.equal(unknownRows[0].chinese_name, '张三');
});

test('机场票走真实预匹配状态(no_group):团号"无"+票号15/17开头 → 推断机场模式,raw 还原带杠', () => {
  // 机场票没有团号表行,预匹配真实产出是 no_group(不是 matched)——
  // 导出层按 Excel 自己的判定口径(团号无 + 票号前两位15/17)推断机场模式。
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'no_group',
    modeRawPre: '',
    receiptNoFinal: '150123456789012',
    receiptNoRawAuto: '15-0123-4567-89012',
    groupNoFinal: '无',
  })]);
  assert.equal(rows[0].mode, '新世界机场-振华');
  assert.equal(rows[0].receipt_no, '15-0123-4567-89012'); // raw 还原带杠
  assert.equal(rows[0].group_no, '无');
  assert.ok(rows[0].note.includes('机场'));
});

test('团号"无"但票号不是15/17开头:不推断机场,按普通模式全记', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'no_group',
    modeRawPre: '',
    receiptNoFinal: '99123456789012',
    groupNoFinal: '无',
  })]);
  assert.equal(rows[0].mode, '');
  assert.equal(rows[0].receipt_no, '99123456789012'); // 全记,不动格式
  assert.equal(rows[0].chinese_name, '张三');
});

test('审核员改过票号 → raw 与终值不一致,以人为准输出归一值', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched',
    modeRawPre: '现代-JEOCU',
    receiptNoFinal: '999999999',           // 人工改过
    receiptNoRawAuto: '15-0123-4567-89012', // OCR 原串已过时
  })]);
  assert.equal(rows[0].receipt_no, '999999999');
});

test('带动作模式:发小票17/18群、S活动红标签进备注列', () => {
  const r17 = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '新罗PKG-孙恩子（发小票17）',
  })]);
  assert.ok(r17[0].note.includes('及时发上家'));

  const s = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-S活动',
  })]);
  assert.ok(s[0].note.includes('S活动红标签'));
});

test('「不用记」尾巴:整行不进表(2026-07-24 拍板,逆转 07-21 保留标注)', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-本司不用记',
  })]);
  assert.equal(rows.length, 0, '代理标注不用记的票不出现在任何导出表');
});

test('「不用记」不误伤同组正常票:混组只删不用记那张', () => {
  const rows = buildReceiptExportRows([
    makeMatrixTask({ groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-本司不用记' }),
    makeMatrixTask({ groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-本司' }),
  ]);
  assert.equal(rows.length, 1, '同组的正常票照常导出');
});

test('formatBusinessDate uses Asia Seoul business day for ISO timestamps', () => {
  assert.equal(formatBusinessDate('2026-05-03T15:30:00.000Z'), '2026-05-04');
  assert.equal(formatBusinessDate('2026-05-04'), '2026-05-04');
  assert.equal(formatBusinessDate('2026/05/04 12:30'), '2026-05-04');
});

// 小票号导出去杠/补杠(2026-07-07,金标实测结构):digits模式去杠、dashed19按2-6-3-5、letters留字母
test('小票号导出:新罗(digits13)带杠存储 → 台账去杠输出纯13位', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '新罗PKG-孙恩子',
    receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '03-264-442-0025-5',
  })]);
  assert.equal(rows[0].receipt_no, '0326444200255'); // 2-3-3-4-1 去杠=13位
});

test('小票号导出:乐天(digits14)带杠存储 → 去杠输出纯14位', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-本司',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '906234-26-001803',
  })]);
  assert.equal(rows[0].receipt_no, '90623426001803'); // 6-2-6 去杠=14位
});

test('小票号导出:乐天S活动带杠 → 去杠(digits14)', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-S活动',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '903254-26-006304',
  })]);
  assert.equal(rows[0].receipt_no, '90325426006304');
});

test('小票号导出:现代(dashed19)干净16位数字 → 按2-6-3-5补杠', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '现代-JEOCU',
    receiptStoreFinal: 'HYUNDAI', receiptNoFinal: '0126070534900117', receiptNoRawAuto: '',
    groupNoFinal: '69141',
  })]);
  assert.equal(rows[0].receipt_no, '01-260705-349-00117'); // 2-6-3-5
});

test('小票号导出:现代(dashed19)已带杠 → 原样保留', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '现代-JEOCU',
    receiptStoreFinal: 'HYUNDAI', receiptNoFinal: '01-260705-349-00117',
  })]);
  assert.equal(rows[0].receipt_no, '01-260705-349-00117');
});

test('小票号导出:济州乐天V特殊(letters14)带杠带字母 → 去杠留字母', () => {
  const rows = buildReceiptExportRows([makeMatrixTask({
    groupNoMatchStatus: 'matched', modeRawPre: '济州乐天V团特殊-道辉',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '90G331-26-00777S',
  })]);
  assert.equal(rows[0].receipt_no, '90G3312600777S'); // 去杠,字母保留
});

// 0731 拆借位后口径反转:金额进金额列、上家进上家列,团号/姓名列还原成真字段。
// 原断言锁的是「借位」本身(金额在团号列、上家在姓名列),那正是用户要拆的「串」。
test('百货P4导出:模式=店名常量(不依赖matched);金额/上家各归各列,不再借团号/姓名列', () => {
  const mk = (over) => ({
    id: 'r1', sourceGroupKey: 'g1', docTypeFinal: 'receipt', docTypeAuto: 'receipt',
    processResult: 'approved', reviewed: true,
    purchaseDateFinal: '2026-07-01', groupNoMatchStatus: '',
    ...over,
  });

  // 新世界百货:金额借位团号列、上家(梁总)借位姓名列;模式列=新世界百货
  const [ssg] = buildReceiptExportRows([mk({
    receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '123-456789',
    receiptAmountFinal: '99000', upstreamFinal: '梁总',
    extractedNameFinal: 'KIM MINSU', passportNoFinal: 'M12345678',
  })]);
  assert.equal(ssg.mode, '新世界百货', '百货模式=常量,不依赖团号命中');
  assert.equal(ssg.receipt_amount, '99000', '新世界:金额进金额列');
  assert.equal(ssg.upstream, '梁总', '新世界:上家进上家列');
  assert.equal(ssg.group_no, '', '团号列不许再塞金额');
  assert.equal(ssg.passport_name, 'KIM MINSU', '姓名列还原成真姓名,不再塞上家');

  // 现代百货(2026-07-12 实票纠正):交易编号8位4-4带杠原样;金额借团号列;上家借姓名列
  const [hyu] = buildReceiptExportRows([mk({
    receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1622-0011',
    receiptAmountFinal: '1020000',
    upstreamFinal: '金浦奥莱', extractedNameFinal: 'LEE JIA',
  })]);
  assert.equal(hyu.mode, '现代百货');
  assert.equal(hyu.upstream, '金浦奥莱', '现代:上家进上家列');
  assert.equal(hyu.passport_name, 'LEE JIA', '姓名列还原成真姓名');
  assert.equal(hyu.receipt_no, '1622-0011', '8位带杠原样,不再按16位补杠');
  assert.equal(hyu.receipt_amount, '1020000', '现代:金额进金额列');
  assert.equal(hyu.group_no, '', '团号列不许再塞金额');

  // 乐天百货:无借位,模式列=乐天百货;交易编号 dash44(0727拍板:存量8位补杠按票面 4-4)
  const [lot] = buildReceiptExportRows([mk({
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678',
    receiptAmountFinal: '3500000', branchFinal: '明洞', brandFinal: '루이비통',
    extractedNameFinal: 'WANG WEI',
  })]);
  assert.equal(lot.mode, '乐天百货');
  assert.equal(lot.passport_name, 'WANG WEI', '乐天百货姓名列不借位');
  assert.equal(lot.receipt_no, '1234-5678');

  // 免税店零回归:未命中模式仍空、姓名/团号列原值
  const [df] = buildReceiptExportRows([mk({
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '03261635001590',
    groupNoFinal: '70123456', extractedNameFinal: 'ZHAO SI',
  })]);
  assert.equal(df.mode, '');
  assert.equal(df.passport_name, 'ZHAO SI');
  assert.equal(df.group_no, '70123456');
});

// ── 0727反馈#13/#14:dash44 形态(百货交易编号按票面 4-4 带杠) ─────────────────
test('dash44:8位存量/省杠输入补杠 4-4;已带杠原样;非8位不硬凑', () => {
  const { formatReceiptNoByMode } = require('../lib/workbench_receipt_export');
  const mk = (no) => ({ docTypeFinal: 'receipt', receiptNoFinal: no });
  assert.equal(formatReceiptNoByMode(mk('12345678'), '乐天百货'), '1234-5678', '存量去杠8位补杠');
  assert.equal(formatReceiptNoByMode(mk('2921-7193'), '新世界百货'), '2921-7193', '已带杠原样');
  assert.equal(formatReceiptNoByMode(mk('1622-0011'), '现代百货'), '1622-0011');
  assert.equal(formatReceiptNoByMode(mk('123456'), '乐天百货'), '123456', '非8位不硬凑(错绿比空红危险)');
  assert.equal(formatReceiptNoByMode(mk(''), '乐天百货'), '');
});

// ── 不要串:什么字段就填什么列(0731 用户口径)────────────────────────────
// 原来百货走 exportMap「借位」:金额塞进**团号列**、上家塞进**姓名列**。
// 审核层一直存的是真字段(金额=金额、上家=上家),借位只在导出层——
// 但导出的表是给上家看的,列名说的是团号/姓名,值却是金额/上家,读表的人没法核。
// 用户口径:「审核台 UI 是什么字段,表格就填进什么字段,不要串」。
//
// 借位当初存在的原因是这张表**没有金额列和上家列**,所以拆借位必须先补列,
// 否则等于把金额和上家从交付文件里删掉。

const DEPT_TASK = {
  id: 't-dept', docTypeFinal: 'receipt', reviewed: true, machineState: 'completed',
  processResult: 'approved', sourceGroupKey: 'g-dept',
  receiptStoreFinal: 'SHINSEGAE_DEPT',
  receiptNoFinal: '2970-6421',
  receiptAmountFinal: '680000',
  upstreamFinal: '梁总',
  purchaseDateFinal: '2026-06-28',
  groupNoFinal: '', extractedNameFinal: '', passportNoFinal: '',
  sourceImagePath: 'source/dept-1.jpg',
};

test('⭐百货金额进金额列、上家进上家列 —— 不许再借团号/姓名列', () => {
  const rows = buildReceiptExportRows([DEPT_TASK], {
    customerContextByGroup: new Map([['g-dept', { agentName: '英兰' }]]),
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.receipt_amount, '680000', '金额没进自己的列');
  assert.equal(r.upstream, '梁总', '上家没进自己的列');
  // 借来的两个列位必须还回去:百货没团号、票面没护照姓名,就该是空的
  assert.equal(r.group_no, '', '团号列还塞着金额 —— 这就是"串"');
  assert.equal(r.passport_name, '', '姓名列还塞着上家 —— 这就是"串"');
});

test('免税店一行不动(拆借位不能波及非百货)', () => {
  const rows = buildReceiptExportRows([{
    ...DEPT_TASK, id: 't-df', receiptStoreFinal: 'LOTTE',
    groupNoFinal: 'TEAM-9', extractedNameFinal: 'KIM MINSU',
    receiptAmountFinal: '', upstreamFinal: '',
  }], { customerContextByGroup: new Map([['g-dept', { agentName: '英兰' }]]) });
  assert.equal(rows[0].group_no, 'TEAM-9');
  assert.equal(rows[0].passport_name, 'KIM MINSU');
});

test('⭐借位机器要连根拔掉 —— 留着"看起来还活着"的死代码,下一个人会把它接回去', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const read = (p) => fs2.readFileSync(path2.join(__dirname, p), 'utf8');

  // ① 导出层:借位函数和它的列位词表都不该再存在
  const exp = read('../lib/workbench_receipt_export.js');
  assert.ok(!exp.includes('applyDeptExportMap'), '借位函数还在(已无人调用的死代码)');
  assert.ok(!exp.includes('EXPORT_MAP_COLUMN_TO_ROW_KEY'), '借位列位词表还在');

  // ② 店档案:不该再声明 exportMap —— 它现在描述的是一个不发生的行为
  const prof = read('../lib/store_profiles.js');
  assert.ok(!prof.includes('exportMap'), 'store_profiles 还声明着 exportMap');

  // ③ 配置台:不该再展示「台账借位」那一行(界面上的假话比死代码更贵)
  const cfg = read('../frontend/src/views/ConfigConsoleView.vue');
  assert.ok(!cfg.includes('台账借位'), '配置台还在展示已经不存在的借位规则');
});
