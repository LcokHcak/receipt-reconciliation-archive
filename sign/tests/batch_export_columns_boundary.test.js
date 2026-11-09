'use strict';

/**
 * 点3:「台账记哪些列」在审核台批次小票导出的真实列集(断点④,docs/模式台账列与导出对照表.md)。
 *
 * 链路(源码勘察实证,本文件全链锁死):
 *   POST /api/batches/:batchId/export [routes/workbench_routes.js:67]
 *     → batch_handlers.exportBatch [services/handlers/workbench/batch_handlers.js:55]
 *     → workbench_export_service.exportBatch→generateWorkbook [services/workbench_export_service.js:226/180]
 *     → buildReceiptExportRows [lib/workbench_receipt_export.js:123]
 *     → resolveTaskModeRule(模式单源:dept>人选>快照>机场)[lib/workbench_receipt_export.js:228]
 *     → applyModeRecordRule(columns 消费点)[lib/workbench_receipt_export.js:301]
 *
 * 真实列集语义(以实现为准锁死):
 *   - Excel/CSV 的**列恒 12 列全出**(RECEIPT_EXPORT_COLUMNS,workbench_export_service.js:190/204);
 *     「不记」的列是**该模式行的值置空**,不是删列——混批里两模式各自留列才可能。
 *   - columns 8 键 → 行键映射:recordDate→收票日期 / agent→代理 / purchaseDate→购买日期 /
 *     receiptNo→小票号 / groupNo→团号 / name→中文姓名+英文姓名(一键两列)/
 *     passportNo→护照号码 / departureDate→离境日期;免税店/模式/备注=系统列恒保留。
 *   - 未知模式 known=false → 全列照记(mode_record_matrix.js:110 DEFAULT_RULE)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  RECEIPT_EXPORT_COLUMNS,
  RECEIPT_EXPORT_HEADERS,
  buildReceiptExportRows,
} = require('../lib/workbench_receipt_export');
const { setModeRuleResolver, lookupModeRecordRule } = require('../lib/mode_record_matrix');
const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createModeConfigResolver } = require('../services/mode_config_resolver');
const { createWorkbenchExportService } = require('../services/workbench_export_service');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

// ── 夹具:护照+小票同组(护照身份借位到小票行,列过滤必须在借位**之后**抹值)──────

// 组→客户号(customer_ref 只认 CL\d{8}-\d{3,4};服务级用例经 parseCustomerRefFromTask 反解)
const CUSTOMER_ID = Object.freeze({ ga: 'CL20260701-001', gb: 'CL20260701-002' });

function passportTask(groupKey, overrides = {}) {
  return {
    id: `pp-${groupKey}`, sourceGroupKey: groupKey, reviewed: true,
    docTypeFinal: 'passport', docTypeAuto: 'passport',
    chineseNameFinal: '金民秀', extractedNameFinal: 'KIM MINSU',
    passportNoFinal: 'M12345678', departureDateFinal: '2026-07-06',
    sourceOriginalPath: `2026-07/${CUSTOMER_ID[groupKey]}/pp.jpg`,
    ...overrides,
  };
}

function receiptTask(groupKey, overrides = {}) {
  return {
    id: `rc-${groupKey}`, sourceGroupKey: groupKey, reviewed: true,
    docTypeFinal: 'receipt', docTypeAuto: 'receipt',
    receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '0325652400439',
    groupNoFinal: '71992', purchaseDateFinal: '2026-07-01',
    groupNoMatchStatus: 'matched',
    sourceOriginalPath: `2026-07/${CUSTOMER_ID[groupKey]}/rc.jpg`,
    ...overrides,
  };
}

const CONTEXT = new Map([
  ['ga', { customerId: 'CL20260701-001', agentName: '新琪', createdAt: '2026-06-30T15:30:00.000Z' }],
  ['gb', { customerId: 'CL20260701-002', agentName: '本司', createdAt: '2026-06-30T15:30:00.000Z' }],
]);

// ── ① 记3列模式(新罗V团-新琪=SLIM:recordDate/agent/groupNo)──────────────────

test('①记3列模式:只留 收票日期/代理/团号,其余5键(6列)值置空;系统列(免税店/模式)保留', () => {
  const rows = buildReceiptExportRows(
    [passportTask('ga'), receiptTask('ga', { modeRawPre: '新罗V团-新琪' })],
    { customerContextByGroup: CONTEXT },
  );
  assert.equal(rows.length, 1, '护照不出行,只有小票行');
  const row = rows[0];

  // 记的 3 列:recordDate→receipt_date / agent→agent / groupNo→group_no
  assert.equal(row.receipt_date, '2026-07-01', '收票日期=客户建档时间(首尔时区)');
  assert.equal(row.agent, '新琪');
  assert.equal(row.group_no, '71992');

  // 不记的 5 键→6 列全置空(name 一键抹中文+英文两列;护照借位值也必须被抹掉)
  assert.equal(row.chinese_name, '', 'name=false 抹中文姓名(护照借位后再抹)');
  assert.equal(row.passport_name, '', 'name=false 抹英文姓名');
  assert.equal(row.passport_no, '', 'passportNo=false 抹护照号(借位值同抹)');
  assert.equal(row.purchase_date, '', 'purchaseDate=false');
  assert.equal(row.receipt_no, '', 'receiptNo=false');
  assert.equal(row.departure_date, '', 'departureDate=false(护照借位值同抹)');

  // 系统列不受"记哪些列"管辖
  assert.equal(row.receipt_store, 'THE SHILLA', '免税店=系统列恒保留');
  assert.equal(row.mode, '新罗V团-新琪');
});

// ── ② 全记8列模式对照(乐天SG-本司=ALL digits14)───────────────────────────────

test('②全记8列模式:8键全留;小票号按 digits14 剥杠;出境日期从护照借位', () => {
  const rows = buildReceiptExportRows(
    [passportTask('gb'), receiptTask('gb', {
      receiptStoreFinal: 'LOTTE', receiptNoFinal: '9020-3260-003091',
      groupNoFinal: '26907555', purchaseDateFinal: '2026-07-02',
      departureDateFinal: '', // 票上没有→借护照的
      modeRawPre: '乐天SG-本司',
    })],
    { customerContextByGroup: CONTEXT },
  );
  const row = rows[0];
  assert.equal(row.chinese_name, '金民秀');
  assert.equal(row.passport_name, 'KIM MINSU');
  assert.equal(row.passport_no, 'M12345678');
  assert.equal(row.receipt_store, 'LOTTE');
  assert.equal(row.receipt_no, '90203260003091', 'digits14 形态:剥杠纯数字');
  assert.equal(row.group_no, '26907555');
  assert.equal(row.purchase_date, '2026-07-02');
  assert.equal(row.departure_date, '2026-07-06', '出境日期借位自同组护照');
  assert.equal(row.agent, '本司');
  assert.equal(row.receipt_date, '2026-07-01');
  assert.equal(row.mode, '乐天SG-本司');
});

test('②-对照 未知/未归类模式(无快照无人选):known=false 全列照记,绝不误抹', () => {
  const rows = buildReceiptExportRows(
    [passportTask('ga'), receiptTask('ga', { modeRawPre: '', groupNoMatchStatus: '' })],
    { customerContextByGroup: CONTEXT },
  );
  const row = rows[0];
  assert.equal(row.mode, '', '未归类=空模式');
  assert.equal(row.receipt_no, '0325652400439', '未知模式不折腾票号');
  assert.equal(row.group_no, '71992');
  assert.equal(row.passport_no, 'M12345678');
  assert.equal(row.purchase_date, '2026-07-01');
  assert.equal(row.agent, '新琪');
});

// ── ③ 混批端到端:两模式各自列集,走真实 exportBatch 服务(CSV=真实产物)────────────

class CaptureWorkbook {
  constructor() {
    this.sheets = [];
    this.xlsx = {
      writeFile: async (target) => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'xlsx-bin', 'utf8');
      },
    };
  }

  addWorksheet(name) {
    const sheet = {
      name, columns: [], rows: [], views: [], autoFilter: null,
      getRow: () => ({}),
      addRow(row) { this.rows.push(row); },
    };
    this.sheets.push(sheet);
    return sheet;
  }
}

test('③混批:同一批次 SLIM 模式行抹5键、ALL 模式行全留——真实 exportBatch 落 CSV 逐列锁死', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-export-cols-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workbooks = [];
  const batchDir = (batchId) => path.join(tempRoot, batchId);
  const batchSubdirs = (batchId) => {
    const root = batchDir(batchId);
    const dirs = { root, exports: path.join(root, 'exports') };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    return dirs;
  };

  const service = createWorkbenchExportService({
    ExcelJS: { Workbook: class extends CaptureWorkbook { constructor() { super(); workbooks.push(this); } } },
    fs, path, batchDir, batchSubdirs,
    toStorageUrl: (batchId, rel) => `/storage/${batchId}/${rel.split(path.sep).join('/')}`,
    applyComputedFields: (_batch, task) => task, // 列过滤不依赖 computed 层,原样透传
    // ⭐不注入 receiptExportColumns/buildReceiptExportRows:默认件=生产件(第二真相源禁令)
    customerLibraryRepository: {
      loadCustomer: (workspaceKey, customerId) => {
        assert.equal(workspaceKey, '2026-07');
        const hit = [...CONTEXT.values()].find((c) => c.customerId === customerId);
        assert.ok(hit, `未知客户 ${customerId}`);
        return { agentName: hit.agentName, createdAt: hit.createdAt };
      },
    },
    customerFinalizeService: { finalizeApprovedGroup: async () => null },
  });

  await service.exportBatch({
    id: 'batch_cols',
    sourceGroups: [
      { key: 'ga', label: '客户A', folderPath: 'fa' },
      { key: 'gb', label: '客户B', folderPath: 'fb' },
    ],
    tasks: [
      passportTask('ga'), receiptTask('ga', { modeRawPre: '新罗V团-新琪' }),
      passportTask('gb'), receiptTask('gb', {
        receiptStoreFinal: 'LOTTE', receiptNoFinal: '9020-3260-003091',
        groupNoFinal: '26907555', purchaseDateFinal: '2026-07-02',
        departureDateFinal: '', modeRawPre: '乐天SG-本司',
      }),
    ],
  });

  // 列恒全集出(不删列):sheet.columns 与 CSV 表头都是全集
  // (0731 拆百货借位后新增「金额」「上家」两列,所以下面按 length 动态算,不写死字母)
  const sheet = workbooks[0].sheets[0];
  assert.equal(sheet.columns.length, RECEIPT_EXPORT_COLUMNS.length);
  assert.deepEqual(sheet.columns.map((c) => c.header), [...RECEIPT_EXPORT_HEADERS]);
  const lastCol = String.fromCharCode('A'.charCodeAt(0) + RECEIPT_EXPORT_COLUMNS.length - 1);
  assert.equal(sheet.autoFilter.to, `${lastCol}1`, '筛选范围要按列数动态算,不能写死字母');

  const csv = fs.readFileSync(path.join(batchDir('batch_cols'), 'exports', 'daily_receipts.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], RECEIPT_EXPORT_HEADERS.join(','), 'CSV 表头=全集');
  assert.equal(lines.length, 3, '2 张小票=2 行(护照不出行)');

  const keys = RECEIPT_EXPORT_COLUMNS.map((c) => c.key);
  const parse = (line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v]));
  const slimRow = parse(lines[1]);
  const allRow = parse(lines[2]);

  // SLIM 行(新罗V团-新琪):3 键留、5 键(6列)空
  assert.deepEqual(slimRow, {
    chinese_name: '', passport_name: '', passport_no: '',
    receipt_store: 'THE SHILLA', receipt_no: '', group_no: '71992',
    receipt_amount: '', upstream: '',
    purchase_date: '', departure_date: '',
    agent: '新琪', receipt_date: '2026-07-01', mode: '新罗V团-新琪', note: '',
  });
  // ALL 行(乐天SG-本司):8 键全留 + digits14 剥杠
  assert.deepEqual(allRow, {
    chinese_name: '金民秀', passport_name: 'KIM MINSU', passport_no: 'M12345678',
    receipt_store: 'LOTTE', receipt_no: '90203260003091', group_no: '26907555',
    receipt_amount: '', upstream: '',
    purchase_date: '2026-07-02', departure_date: '2026-07-06',
    agent: '本司', receipt_date: '2026-07-01', mode: '乐天SG-本司', note: '',
  });
});

// ── ④ 配置台改列集 → 批次导出即时跟随(columns 消费链活性=反"绿灯谎言")────────────

test('④配置台列集接线:DB 配置改「记哪些列」→ 导出行即时跟随;deactivate 回落出厂全记', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-cols-config-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const resolver = createModeConfigResolver({
    modeConfigRepository: repository,
    logger: { warn: () => {}, info: () => {} },
  });
  t.after(() => {
    setModeRuleResolver(null); // 全局挂钩必复位
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setModeRuleResolver(resolver.getModeRecordRule);

  const tasks = [passportTask('ga'), receiptTask('ga', {
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '9020-3260-003091', modeRawPre: '乐天PKG-新琪',
  })];

  // 出厂:乐天PKG-新琪=全记(mode_record_matrix.js:51)
  let row = buildReceiptExportRows(tasks, { customerContextByGroup: CONTEXT })[0];
  assert.equal(row.agent, '新琪');
  assert.equal(row.receipt_no, '90203260003091');

  // 配置台把该模式改成只记 收票日期+小票号(其余 6 键 false)
  repository.saveNewVersion({
    kind: 'mode', name: '乐天PKG-新琪',
    payload: {
      columns: {
        ...ALL_COLUMNS,
        agent: false, purchaseDate: false, groupNo: false,
        name: false, passportNo: false, departureDate: false,
      },
      receiptNoForm: 'digits14',
    },
  });
  row = buildReceiptExportRows(tasks, { customerContextByGroup: CONTEXT })[0];
  assert.equal(row.receipt_date, '2026-07-01', 'recordDate 仍记');
  assert.equal(row.receipt_no, '90203260003091', 'receiptNo 仍记(形态照走)');
  assert.equal(row.agent, '', '配置 false 的列即时抹值——columns 真被消费,非绿灯摆设');
  assert.equal(row.group_no, '');
  assert.equal(row.passport_no, '');
  assert.equal(row.chinese_name, '');
  assert.equal(row.departure_date, '');

  // 停用回落出厂:全记复原(stamp 水位失效,无需手动 invalidate)
  repository.deactivate('mode', '乐天PKG-新琪');
  row = buildReceiptExportRows(tasks, { customerContextByGroup: CONTEXT })[0];
  assert.equal(row.agent, '新琪', '回落出厂=全记');
  assert.equal(row.group_no, '71992');

  // 消费点自证:lookupModeRecordRule 的 columns 正是 applyModeRecordRule 抹值依据
  assert.equal(lookupModeRecordRule('乐天PKG-新琪').columns.agent, true);
});
