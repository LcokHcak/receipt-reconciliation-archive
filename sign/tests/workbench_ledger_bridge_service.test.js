'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchLedgerBridgeService, computeLedgerReceiptNo } = require('../services/workbench_ledger_bridge_service');

// ⚠️ 购买日期不能写死(2026-08-01 实炸):桥接会校验「未来最多 90 天、历史 ±6 个月」,
// 而这几条用例原来钉的是 '2026-01-29'。7-31 那天它还在窗口内,日期一翻到 8-1 就出界,
// 三条用例集体变红——不是代码回归,是夹具里的定时炸弹,CI 到了那天自己会炸。
// 凡是被时间窗校验的字段,夹具一律相对**当天**生成。
function monthsAgoISO(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const IN_WINDOW_PURCHASE_DATE = monthsAgoISO(2); // 稳稳落在 6 个月窗口里,离两端都远
const IN_WINDOW_MONTH = IN_WINDOW_PURCHASE_DATE.slice(0, 7); // 对应的月度工作区键

test('ledger bridge writes normalized receipt identifiers from approved groups', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        insertedRows.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: {
      getOrThrow() {},
    },
  });

  const result = await service.syncApprovedGroup({
    batchId: 'batch_1',
    workspaceKey: IN_WINDOW_MONTH,
    operator: 'reviewer1',
    groupTasks: [
      {
        id: 'passport_1',
        docTypeFinal: 'passport',
        extractedNameFinal: 'YAN JIAMIN',
        passportNoFinal: 'EP6233431',
      },
      {
        id: 'receipt_1',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_1',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0.03-261-635-0019-5',
        groupNoFinal: 'G-84940',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  assert.equal(result.inserted, 1);
  // 2026-07-20 五问题#5修①:未命中模式的兜底口径=normalizeReceiptNo(保字母保杠,
  // 剥"0."标签前缀/空格)——不再数字投影(旧值 '0326163500195' 丢了票面横线)。
  assert.equal(insertedRows[0].receiptNo, '03-261-635-0019-5');
  assert.equal(insertedRows[0].tourNo, '84940');
});

test('字母团号写台账不剥字母(2026-07-10 生产病例:26V00041 曾被 \\D 剥成 2600041,终匹配永不命中)', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        insertedRows.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: { getOrThrow() {} },
  });

  await service.syncApprovedGroup({
    batchId: 'batch_v',
    workspaceKey: '2026-07',
    operator: 'reviewer1',
    groupTasks: [
      { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'CHEN QIANG', passportNoFinal: 'EK1234567' },
      {
        id: 'r1', docTypeFinal: 'receipt', sourceGroupKey: 'g1',
        receiptStoreFinal: 'LOTTE', receiptNoFinal: '90203626000574',
        groupNoFinal: '26V00041', purchaseDateFinal: '2026-07-09',
      },
    ],
  });

  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].tourNo, '26V00041', '真字母团号必须原样入台账(乐天首尔V团)');
});

test('ledger bridge uses the group passport identity instead of noisy receipt OCR names', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        insertedRows.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: {
      getOrThrow() {},
    },
  });

  await service.syncApprovedGroup({
    batchId: 'batch_1',
    workspaceKey: IN_WINDOW_MONTH,
    groupTasks: [
      {
        id: 'passport_1',
        docTypeFinal: 'passport',
        extractedNameFinal: 'LI YUXIN',
        passportNoFinal: 'EJ9650087',
        chineseNameFinal: '李雨芯',
      },
      {
        id: 'receipt_1',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_1',
        extractedNameFinal: 'ALIPAY',
        passportNoFinal: 'WRONG123',
        chineseNameFinal: '支付',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0326146800180',
        groupNoFinal: '71990',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].name, 'LI YUXIN');
  assert.equal(insertedRows[0].passportNo, 'EJ9650087');
  assert.equal(insertedRows[0].remark, '李雨芯');
});

test('ledger bridge keeps receipt date as intake date and carries customer agent label', () => {
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: {
      getOrThrow() {},
    },
  });

  const row = service._taskToLedgerRow({
    batchId: 'batch_1',
    workspaceKey: IN_WINDOW_MONTH,
    operator: 'reviewer1',
    agentId: 7,
    agentCode: '9号',
    receiptDate: '2026-05-16',
    groupTasks: [
      {
        id: 'passport_1',
        docTypeFinal: 'passport',
        extractedNameFinal: 'BAI XUE',
        passportNoFinal: 'EF7053101',
        chineseNameFinal: '白雪',
      },
      {
        id: 'receipt_1',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'CL20260516-001',
        sourceGroupLabel: '阿海',
        receiptStoreFinal: 'SHILLA IPARK',
        receiptNoFinal: '2126113001739',
        groupNoFinal: '32028',
        purchaseDateFinal: '2026-01-12',
        receiptDateAuto: '2026-01-12',
      },
    ],
    task: {
      id: 'receipt_1',
      docTypeFinal: 'receipt',
      sourceGroupKey: 'CL20260516-001',
      sourceGroupLabel: '阿海',
      receiptStoreFinal: 'SHILLA IPARK',
      receiptNoFinal: '2126113001739',
      groupNoFinal: '32028',
      purchaseDateFinal: '2026-01-12',
      receiptDateAuto: '2026-01-12',
    },
  });

  assert.equal(row.receiptDate, '2026-05-16');
  assert.equal(row.purchaseDate, '2026-01-12');
  assert.equal(row.agent, '阿海');
  assert.equal(row.remark, '白雪');
});


test('ledger bridge dedupes repeated uploads by receipt business identity, not task id', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        insertedRows.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: {
      getOrThrow() {},
    },
  });

  await service.syncApprovedGroup({
    batchId: 'batch_old',
    workspaceKey: IN_WINDOW_MONTH,
    operator: 'reviewer1',
    groupTasks: [
      { id: 'passport_old', docTypeFinal: 'passport', extractedNameFinal: 'YAN JIAMIN', passportNoFinal: 'EP6233431' },
      {
        id: 'receipt_old',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_old',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0326163500195',
        groupNoFinal: '71990',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  await service.syncApprovedGroup({
    batchId: 'batch_new',
    workspaceKey: IN_WINDOW_MONTH,
    operator: 'reviewer1',
    groupTasks: [
      { id: 'passport_new', docTypeFinal: 'passport', extractedNameFinal: 'YAN JIAMIN', passportNoFinal: 'EP6233431' },
      {
        id: 'receipt_new',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_new',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0.03-261-635-0019-5',
        groupNoFinal: '71990',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  assert.equal(insertedRows.length, 2);
  assert.equal(insertedRows[0].rowHash, insertedRows[1].rowHash);
});

test('ledger bridge hashes one receipt independently from noisy passport OCR fields', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: {
      insertMany(rows) {
        insertedRows.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    workspaceService: {
      getOrThrow() {},
    },
  });

  await service.syncApprovedGroup({
    batchId: 'batch_old',
    workspaceKey: IN_WINDOW_MONTH,
    groupTasks: [
      { id: 'passport_old', docTypeFinal: 'passport', passportNoFinal: 'EJ9650087' },
      {
        id: 'receipt_old',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_old',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0326146800180',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  await service.syncApprovedGroup({
    batchId: 'batch_new',
    workspaceKey: IN_WINDOW_MONTH,
    groupTasks: [
      { id: 'passport_new', docTypeFinal: 'passport', passportNoFinal: 'EJ9659999' },
      {
        id: 'receipt_new',
        docTypeFinal: 'receipt',
        sourceGroupKey: 'group_new',
        receiptStoreFinal: 'THE SHILLA',
        receiptNoFinal: '0326146800180',
        purchaseDateFinal: IN_WINDOW_PURCHASE_DATE,
      },
    ],
  });

  assert.equal(insertedRows.length, 2);
  assert.equal(insertedRows[0].rowHash, insertedRows[1].rowHash);
});

test('桥接成功后标脏 tour_match(派生新鲜度:导出跟最新台账走);桥接0条不标脏', async () => {
  const marks = [];
  const recompute = { markDirty: (ws, stage) => marks.push(`${ws}:${stage}`) };
  const makeService = (insertedCount) => createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany: (rows) => ({ inserted: insertedCount, skipped: rows.length - insertedCount }) },
    workspaceService: { getOrThrow() {} },
    derivationRecomputeService: recompute,
  });
  const tasks = [
    { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'A B', passportNoFinal: 'EP1234567' },
    { id: 'r1', docTypeFinal: 'receipt', sourceGroupKey: 'g1', receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '1-2-3', groupNoFinal: 'G-1', purchaseDateFinal: IN_WINDOW_PURCHASE_DATE },
  ];

  const r1 = await makeService(1).syncApprovedGroup({ batchId: 'b1', workspaceKey: IN_WINDOW_MONTH, operator: 'r', groupTasks: tasks });
  assert.equal(r1.inserted, 1);
  assert.deepEqual(marks, [`${IN_WINDOW_MONTH}:tour_match`], '有新台账进库 → 标脏 tour_match');

  marks.length = 0;
  await makeService(0).syncApprovedGroup({ batchId: 'b1', workspaceKey: IN_WINDOW_MONTH, operator: 'r', groupTasks: tasks });
  assert.deepEqual(marks, [], '0 条插入(全 skip)不标脏');
});

test('setter 注入 recompute 服务(构造晚于 bridge 的接线路径)', async () => {
  const marks = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany: (rows) => ({ inserted: rows.length, skipped: 0 }) },
    workspaceService: { getOrThrow() {} },
  });
  service.setDerivationRecomputeService({ markDirty: (ws, stage) => marks.push(`${ws}:${stage}`) });
  await service.syncApprovedGroup({
    batchId: 'b1', workspaceKey: IN_WINDOW_MONTH, operator: 'r',
    groupTasks: [
      { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'A B', passportNoFinal: 'EP1234567' },
      { id: 'r1', docTypeFinal: 'receipt', sourceGroupKey: 'g1', receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '1-2-3', groupNoFinal: 'G-1', purchaseDateFinal: IN_WINDOW_PURCHASE_DATE },
    ],
  });
  assert.deepEqual(marks, [`${IN_WINDOW_MONTH}:tour_match`]);
});

test('百货P4:桥接注模式常量+真字段落正列,tourMatchStatus=matched 不进团号匹配队列', () => {
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany(rows) { return { inserted: rows.length, skipped: 0 }; } },
    workspaceService: { getOrThrow() {} },
  });
  const base = {
    batchId: 'batch_1', workspaceKey: '2026-07', operator: 'r1',
    agentId: 1, agentCode: '1号', receiptDate: '2026-07-08', groupTasks: [],
  };

  // 乐天百货:模式=常量,金额→grossKrw,门店/品牌落正列,无团号但状态=matched(不用团号匹配)
  const lotte = service._taskToLedgerRow({
    ...base,
    task: {
      id: 't1', docTypeFinal: 'receipt', sourceGroupKey: 'CL20260708-001',
      receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678',
      receiptAmountFinal: '3500000', branchFinal: '0394', brandFinal: '루이비통',
      purchaseDateFinal: '2026-07-01', groupNoFinal: '',
    },
  });
  assert.equal(lotte.modeRaw, '乐天百货', '模式=档案常量');
  assert.equal(lotte.tourMatchStatus, 'matched', '百货无团号,不进团号匹配队列');
  assert.equal(lotte.branch, '明洞(0394)', '门店列记店名+码(2026-07-13);存储码不变、只格式化输出列');
  assert.equal(lotte.brand, '루이비통');
  assert.equal(lotte.grossKrw, 3500000, '金额落总卖出￦列');

  // 新世界百货:上家=梁总落正列
  const ssg = service._taskToLedgerRow({
    ...base,
    task: {
      id: 't2', docTypeFinal: 'receipt', sourceGroupKey: 'CL20260708-002',
      receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '123-456789',
      receiptAmountFinal: '99000', upstreamFinal: '梁总', purchaseDateFinal: '2026-07-02',
    },
  });
  assert.equal(ssg.modeRaw, '新世界百货');
  assert.equal(ssg.upstream, '梁总');
  assert.equal(ssg.grossKrw, 99000);

  // 免税店零回归:modeRaw 仍 null、tourMatchStatus 仍 pending、无 branch/upstream/brand
  const dutyFree = service._taskToLedgerRow({
    ...base,
    task: {
      id: 't3', docTypeFinal: 'receipt', sourceGroupKey: 'CL20260708-003',
      receiptStoreFinal: 'LOTTE', receiptNoFinal: '03261635001590',
      groupNoFinal: '70123456', purchaseDateFinal: '2026-07-03',
    },
  });
  assert.equal(dutyFree.modeRaw, null, '免税店模式仍走团号匹配');
  assert.equal(dutyFree.tourMatchStatus, 'pending');
  assert.ok(!dutyFree.branch && !dutyFree.upstream && !dutyFree.brand);
});

test('百货交易编号台账原样保杠(2026-07-14 审计#1);去重哈希用数字投影与存量兼容', () => {
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany(rows) { return { inserted: rows.length, skipped: 0 }; } },
    workspaceService: { getOrThrow() {} },
  });
  const base = { batchId: 'b1', workspaceKey: '2026-07', operator: 'r1', agentId: 1, agentCode: '1号', receiptDate: '2026-07-08', groupTasks: [] };

  // 新世界百货 2921-7193 / 现代百货 1622-0011:存储保杠(曾被 normalizeReceiptNoDigits 剥成纯数字)
  const ssg = service._taskToLedgerRow({ ...base, task: {
    id: 't1', docTypeFinal: 'receipt', sourceGroupKey: 'CL-1', receiptStoreFinal: 'SHINSEGAE_DEPT',
    receiptNoFinal: '2921-7193', upstreamFinal: '梁总', receiptAmountFinal: '99000', purchaseDateFinal: '2026-07-01',
  } });
  assert.equal(ssg.receiptNo, '2921-7193', '新世界百货交易编号带杠原样存(store_profiles dash:true)');
  const hyu = service._taskToLedgerRow({ ...base, task: {
    id: 't2', docTypeFinal: 'receipt', sourceGroupKey: 'CL-2', receiptStoreFinal: 'HYUNDAI_DEPT',
    receiptNoFinal: '1622-0011', upstreamFinal: '东方', receiptAmountFinal: '50000', purchaseDateFinal: '2026-07-02',
  } });
  assert.equal(hyu.receiptNo, '1622-0011');

  // 去重哈希兼容:同一张票,修复前存的是纯数字——两种存储形态的 rowHash 必须一致(重结算不重复入账)
  const legacy = service._taskToLedgerRow({ ...base, task: {
    id: 't3', docTypeFinal: 'receipt', sourceGroupKey: 'CL-1', receiptStoreFinal: 'SHINSEGAE_DEPT',
    receiptNoFinal: '29217193', upstreamFinal: '梁总', receiptAmountFinal: '99000', purchaseDateFinal: '2026-07-01',
  } });
  assert.equal(ssg.rowHash, legacy.rowHash, '百货哈希用数字投影,与修复前存量行去重兼容');

  // 免税店零回归:digits14 模式照旧剥杠出纯数字;dashed19 模式照旧保杠(走模式合同,不受本修影响)
  const duty = service._taskToLedgerRow({ ...base, task: {
    id: 't4', docTypeFinal: 'receipt', sourceGroupKey: 'CL-3', receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '0326-1635-001590', groupNoFinal: '70123456', modeRawPre: '乐天SG-本司', purchaseDateFinal: '2026-07-03',
  } });
  assert.equal(duty.receiptNo, '03261635001590', '免税店 digits14 模式口径不变');
});

// 2026-07-20 五问题#5修①:未命中模式兜底不再剥字母/横线(存储路径禁数字化投影);
// 去重哈希仍用数字投影(哈希≠存储),与修复前存纯数字的存量行兼容。
test('兜底口径保字母保杠:济州乐天V字母票/带杠票原样入台账;rowHash 数字投影与存量兼容', async () => {
  const insertedRows = [];
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany(rows) { insertedRows.push(...rows); return { inserted: rows.length, skipped: 0 }; } },
    workspaceService: { getOrThrow() {} },
  });
  const passport = { id: 'p1', docTypeFinal: 'passport', extractedNameFinal: 'A B', passportNoFinal: 'EQ1234567' };

  // 无 modeRawPre(未命中模式)的济州乐天V字母票 → 存储保 G 保杠
  await service.syncApprovedGroup({
    batchId: 'b1', workspaceKey: '2026-07', operator: 'r',
    groupTasks: [passport, {
      id: 'r1', docTypeFinal: 'receipt', sourceGroupKey: 'g1', receiptStoreFinal: 'LOTTE',
      receiptNoFinal: '90G331-26-000309', groupNoFinal: '26907555', purchaseDateFinal: '2026-07-01',
    }],
  });
  assert.equal(insertedRows[0].receiptNo, '90G331-26-000309', '兜底不再剥G剥杠(丢G病根)');

  // 同一张票"修复前存量形态"(纯数字)重结算 → rowHash 必须一致(哈希=数字投影,不产生重复行)
  await service.syncApprovedGroup({
    batchId: 'b2', workspaceKey: '2026-07', operator: 'r',
    groupTasks: [passport, {
      id: 'r2', docTypeFinal: 'receipt', sourceGroupKey: 'g2', receiptStoreFinal: 'LOTTE',
      receiptNoFinal: '9033126000309', groupNoFinal: '26907555', purchaseDateFinal: '2026-07-01',
    }],
  });
  assert.equal(insertedRows.length, 2);
  assert.equal(insertedRows[0].rowHash, insertedRows[1].rowHash, '哈希≠存储:兜底行去重哈希用数字投影');

  // 口径单一真相 computeLedgerReceiptNo:三条路各归各(已知模式合同零回归)
  const fallback = computeLedgerReceiptNo({ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', receiptNoFinal: '90G331-26-000309' });
  assert.deepEqual(fallback, { receiptNo: '90G331-26-000309', hashProjection: 'digits' });
  const letters14 = computeLedgerReceiptNo({ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '济州乐天V团特殊-道辉', receiptNoFinal: '90G331-26-000309' });
  assert.deepEqual(letters14, { receiptNo: '90G33126000309', hashProjection: null }, 'letters14 剥杠保字母(合同不变)');
  const dashed19 = computeLedgerReceiptNo({ docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE', modeRawPre: '新世界机场-振华', receiptNoFinal: '29-260630-109-00126' });
  assert.deepEqual(dashed19, { receiptNo: '29-260630-109-00126', hashProjection: null }, 'dashed19 保杠(合同不变)');
  const digits14 = computeLedgerReceiptNo({ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '9033-5260-032550' });
  assert.deepEqual(digits14, { receiptNo: '90335260032550', hashProjection: null }, 'digits14 剥杠纯数字(合同不变)');
  const dept = computeLedgerReceiptNo({ docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '2921-7193' });
  assert.deepEqual(dept, { receiptNo: '2921-7193', hashProjection: null }, '百货原样(哈希投影由 dailyRowHashOf 按 shop 判定)');
});

test('百货同框护照跨票传播:组内2张百货小票,只1张读到护照 → 另一张落台账也带同一护照身份(修 reviewer HIGH)', () => {
  const service = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany(rows) { return { inserted: rows.length, skipped: 0 }; } },
    workspaceService: { getOrThrow() {} },
  });
  // 一个客户组:两张乐天百货合影票(无独立护照任务),只有 carrier 读到护照角。
  const carrier = {
    id: 't1', docTypeFinal: 'receipt', sourceGroupKey: 'CL-001',
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', receiptAmountFinal: '1000000',
    passportNoFinal: 'EQ9753359', extractedNameFinal: 'JIANG XINHAN', chineseNameFinal: '姜昕含',
    purchaseDateFinal: '2026-07-01',
  };
  const blank = {
    id: 't2', docTypeFinal: 'receipt', sourceGroupKey: 'CL-001',
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '87654321', receiptAmountFinal: '2000000',
    passportNoFinal: '', extractedNameFinal: '', purchaseDateFinal: '2026-07-01',
  };
  const base = { batchId: 'b1', workspaceKey: '2026-07', operator: 'r1', agentId: 1, agentCode: '1号', receiptDate: '2026-07-08' };

  // 没读到护照的那张票:身份从组内 carrier 借位补全,而不是静默落空。
  const blankRow = service._taskToLedgerRow({ ...base, task: blank, groupTasks: [carrier, blank] });
  assert.equal(blankRow.passportNo, 'EQ9753359', '空身份票应从组内捐赠者借到护照号');
  assert.equal(blankRow.name, 'JIANG XINHAN', '空身份票应从组内捐赠者借到英文名');
  assert.equal(blankRow.remark, '姜昕含', '空身份票应从组内捐赠者借到中文名');

  // carrier 本身照常落自己的身份(不受影响)。
  const carrierRow = service._taskToLedgerRow({ ...base, task: carrier, groupTasks: [carrier, blank] });
  assert.equal(carrierRow.passportNo, 'EQ9753359');

  // 没有任何捐赠者时不凭空捏造:孤张空身份票 passportNo 仍为 null(交人工补)。
  const loneRow = service._taskToLedgerRow({ ...base, task: blank, groupTasks: [blank] });
  assert.equal(loneRow.passportNo, null, '无捐赠者不捏造身份');

  // 免税店:有独立护照任务时不走借位(护照任务才是权威),百货捐赠逻辑不误伤免税组。
  const dutyReceipt = {
    id: 't3', docTypeFinal: 'receipt', sourceGroupKey: 'CL-002',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '03261635001590', groupNoFinal: '70123456', purchaseDateFinal: '2026-07-03',
  };
  const passport = { id: 'p1', docTypeFinal: 'passport', passportNoFinal: 'EP6233431', extractedNameFinal: 'YAN JIAMIN' };
  const dutyRow = service._taskToLedgerRow({ ...base, task: dutyReceipt, groupTasks: [passport, dutyReceipt] });
  assert.equal(dutyRow.passportNo, 'EP6233431', '免税店身份取自独立护照任务');

  // 混合组(百货+免税同组、无独立护照):免税小票也从百货捐赠者借身份(1客户组=1人,复审 MEDIUM 锁定)。
  const mixedDuty = {
    id: 't4', docTypeFinal: 'receipt', sourceGroupKey: 'CL-003',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '03261635009990', groupNoFinal: '70999999', purchaseDateFinal: '2026-07-04',
  };
  const mixedDeptCarrier = {
    id: 't5', docTypeFinal: 'receipt', sourceGroupKey: 'CL-003', receiptStoreFinal: 'LOTTE_DEPT',
    receiptNoFinal: '11112222', passportNoFinal: 'EQ9753359', extractedNameFinal: 'JIANG XINHAN', purchaseDateFinal: '2026-07-04',
  };
  const mixedRow = service._taskToLedgerRow({ ...base, task: mixedDuty, groupTasks: [mixedDuty, mixedDeptCarrier] });
  assert.equal(mixedRow.passportNo, 'EQ9753359', '混合组免税小票从同组百货合影借护照身份');
  assert.equal(mixedRow.name, 'JIANG XINHAN');
});
