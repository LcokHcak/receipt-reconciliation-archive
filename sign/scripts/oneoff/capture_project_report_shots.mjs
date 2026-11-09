/**
 * 一次性:为《项目报告》采集主业务链路各功能页的界面截图。
 *
 * 与 capture_report_shots.mjs(0801 交付报告,只截 4 个修复点)不同,这份覆盖
 * **主要功能的输入与输出**:收票建档 → 识别审核 → 结算台账 → 团号/账单对账 →
 * 未收催收 → 交付导出,外加配置与管理面。
 *
 * 三条硬规矩(前一版踩出来的):
 *   ① 数据全部是编的。报告要给外部看,真实客户的护照号/姓名/票号绝不能进去。
 *      演示单据图由 make_demo_docs.mjs 合成并盖 DEMO 水印。
 *   ② 每张截图前必须等到"该出现的内容"真的渲染出来,等不到就抛错,
 *      绝不留一张空壳图冒充功能界面。
 *   ③ 每页用新开的 page:上一页注册的 route 会污染下一页的请求匹配。
 *
 * 前置:vite preview 跑在 5177 上
 *   cd frontend && npm run preview -- --host 127.0.0.1 --port 5177
 * 用法:node scripts/oneoff/capture_project_report_shots.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'tmp_report_shots');
const DOCS = path.join(OUT, 'docs');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.SHOT_BASE_URL || 'http://127.0.0.1:5177/app/dist';
const WS = '2026-07';
const VIEW = { width: 1560, height: 950 };

const DOC_FILES = ['receipt_lotte.png', 'receipt_shilla.png', 'passport_huang.png', 'passport_li.png', 'passport_wang.png'];
{
  const missing = DOC_FILES.filter((f) => !fs.existsSync(path.join(DOCS, f)));
  if (missing.length) {
    console.error(`缺演示单据图:${missing.join(', ')}\n先跑:node scripts/oneoff/make_demo_docs.mjs`);
    process.exit(1);
  }
}
// 按图片 URL 里的关键字取对应单据 —— 审核台右侧字段是哪个人的哪张票,
// 中间就必须显示那张票的图。一律回同一张图会截出"新罗字段配乐天票面"的穿帮图。
const DOC_PNGS = Object.fromEntries(DOC_FILES.map((f) => [f.replace('.png', ''), fs.readFileSync(path.join(DOCS, f))]));
function docPngFor(url) {
  const key = DOC_FILES.map((f) => f.replace('.png', '')).find((k) => url.includes(k));
  return DOC_PNGS[key || 'receipt_lotte'];
}

const shots = [];
const json = (body) => ({ contentType: 'application/json', body: JSON.stringify(body) });

async function shoot(page, name, note, mustContain) {
  // ⚠️ 先确认真的停在应用页面上。踩过一次:mock 路径写成 '**/api/**/ledger**',把 SPA 的
  // 页面路由 /monthly/v2/2026-07/ledger 也一起拦了,浏览器直接显示接口 JSON 原文;
  // 而 mustContain 的字符串在那段 JSON 里也有,自检照样放行 —— 截出一屏源码当功能图。
  // 所以判据不能只看"文字在不在",还要看"在不在应用的壳里"。
  const inApp = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const text = document.body.innerText.trim();
    // Vue 真挂载了(#app 有子节点)+ 页面不是一坨 JSON 原文
    return Boolean(app && app.children.length > 0) && !text.startsWith('{') && !text.startsWith('[');
  });
  if (!inApp) {
    const head = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`${name}:当前不在应用页面(疑似 mock 路径拦了页面路由),拒绝截图。\n  页面开头:${head}`);
  }
  if (mustContain) {
    await page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      mustContain,
      { timeout: 15000 },
    ).catch(async () => {
      const head = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 220);
      throw new Error(`${name}:页面没等到「${mustContain}」,拒绝截假图。\n  当前页面:${head}`);
    });
    await page.waitForTimeout(400);
  }
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, file, note });
  console.log(`  ✓ ${name}.png  ${note}`);
}

/** 每页统一的地基:兜底空对象 + 已登录管理员 + 月份列表 */
async function newPage(browser, { role = 'admin' } = {}) {
  const page = await browser.newPage({ viewport: VIEW });
  // 只匹配"端口后紧跟 /api/"的后端请求,别误伤前端模块路径
  await page.route(/:\d+\/api\//, (r) => r.fulfill(json({})));
  await page.route('**/api/auth/me', (r) => r.fulfill(json({ user: { username: 'admin', role } })));
  await page.route('**/api/monthly/workspaces**', (r) => r.fulfill(json({
    workspaces: [{ workspaceKey: WS, status: 'open', isTestMode: false }],
  })));
  // 单据图:审核台把 /storage/ 改写成 /storage-preview/ 再请求
  await page.route('**/storage-preview/**', (r) => r.fulfill({
    contentType: 'image/png',
    body: docPngFor(r.request().url()),
  }));
  return page;
}

// ─────────────────────── 演示数据(全部编造) ───────────────────────
const T0 = '2026-07-28T09:00:00.000Z';

const BATCHES = [
  {
    id: 'B20260728-01', name: '2026-07-28 首尔线 01', ownerUsername: '小票07', createdBy: '小票07',
    monthlyWorkspaceKey: WS, machineState: 'completed', createdAt: '2026-07-28T01:10:00.000Z',
    updatedAt: T0, exportedAt: T0, exportedBy: 'admin', exportKind: 'mode_delivery',
    counts: { total: 128, queued: 0, processing: 0, completed: 128, error: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 128, rephoto: 0 },
    reviewStats: { lastReviewedAt: '2026-07-28T08:12:00.000Z' },
    sourceGroups: [],
  },
  {
    id: 'B20260728-02', name: '2026-07-28 釜山线 02', ownerUsername: '小票12', createdBy: '小票12',
    monthlyWorkspaceKey: WS, machineState: 'completed', createdAt: '2026-07-28T02:40:00.000Z',
    updatedAt: T0, exportedAt: '', exportedBy: null, exportKind: '',
    counts: { total: 96, queued: 0, processing: 0, completed: 96, error: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 94, rephoto: 2 },
    reviewStats: { lastReviewedAt: '2026-07-28T08:40:00.000Z' },
    sourceGroups: [],
  },
  {
    id: 'B20260728-03', name: '2026-07-28 济州线 03', ownerUsername: '小票03', createdBy: '小票03',
    monthlyWorkspaceKey: WS, machineState: 'completed', createdAt: '2026-07-28T03:20:00.000Z',
    updatedAt: T0, exportedAt: '2026-07-28T08:55:00.000Z', exportedBy: 'admin', exportKind: 'customer_data',
    counts: { total: 74, queued: 0, processing: 0, completed: 74, error: 0, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 74, rephoto: 0 },
    reviewStats: { lastReviewedAt: '2026-07-28T07:30:00.000Z' },
    sourceGroups: [],
  },
];

const OVERVIEW = {
  generatedAt: T0, date: '2026-07-28', timezone: 'Asia/Seoul', activeMonth: WS,
  today: {
    todo: { preprocess: 18, review: 42, remedy: 6 },
    progress: {
      uploaded: 486, reviewed: 402, reviewedToday: 402, exportedToday: 3,
      remedy: 6, completionRate: 0.827, exportedFolders: 3,
    },
  },
  collectors: [
    { owner: '小票07', collected: 128, reviewed: 128, pending: 0, batches: 1, completionRate: 1, workspaces: [WS] },
    { owner: '小票12', collected: 96, reviewed: 94, pending: 2, batches: 1, completionRate: 0.979, workspaces: [WS] },
    { owner: '小票03', collected: 74, reviewed: 74, pending: 0, batches: 1, completionRate: 1, workspaces: [WS] },
    { owner: '小票19', collected: 188, reviewed: 106, pending: 82, batches: 2, completionRate: 0.564, workspaces: [WS] },
  ],
  alerts: {
    staleGroups: { count: 3, thresholdHours: 24, batchIds: ['B20260728-02'], countByBatch: { 'B20260728-02': 3 } },
    unexported: { count: 1, batchIds: ['B20260728-02'] },
    exportFailed: { count: 0, batchIds: [] },
    ocrFailed: { count: 0, batchIds: [] },
    rephoto: { count: 2, batchIds: ['B20260728-02'] },
  },
  me: { username: 'admin', batches: 3 },
  month: { unreceived: 37 },
  warnings: [],
};

const CUSTOMERS = [
  { customerId: 'CL20260728-001', agentName: '韩伴游', status: 'ready_for_review', images: [{}, {}, {}, {}], preprocess: { status: 'processed', totalImages: 4, outputImages: 5, splitImages: 2, failedImages: 0 }, createdAt: '2026-07-28T01:12:00Z' },
  { customerId: 'CL20260728-002', agentName: '海途旅行', status: 'processed', images: [{}, {}, {}], preprocess: { status: 'processing', totalImages: 3, currentImage: 2, failedImages: 0 }, createdAt: '2026-07-28T01:20:00Z' },
  { customerId: 'CL20260728-003', agentName: '星途国际', status: 'in_review', images: [{}, {}, {}, {}, {}], preprocess: { status: 'needs_review', totalImages: 5, outputImages: 5, splitImages: 1, failedImages: 1 }, createdAt: '2026-07-28T01:33:00Z' },
  { customerId: 'CL20260728-004', agentName: '韩伴游', status: 'ready_for_review', images: [{}, {}], preprocess: { status: 'processed', totalImages: 2, outputImages: 3, splitImages: 1, failedImages: 0 }, createdAt: '2026-07-28T01:48:00Z' },
];

/** 审核台批次:一个客户组 = 1 本护照 + 2 张小票(与真实收票形态一致) */
function reviewTask(over = {}) {
  return {
    id: 'task_0001', originalFileName: 'IMG_0001.jpg', sourceType: 'uploaded',
    machineState: 'completed', docTypeAuto: 'receipt', docTypeFinal: 'receipt', docType: 'receipt',
    docTypeConfidence: 0.98, needsReview: false, reviewReasons: [],
    sourceGroupKey: 'CL20260728-001', sourceGroupLabel: 'HUANG YING',
    customerAgentName: '韩伴游',
    extractedNameAuto: '', extractedNameFinal: '', passportNoAuto: '', passportNoFinal: '',
    receiptStoreAuto: 'LOTTE', receiptStoreFinal: 'LOTTE',
    receiptNoAuto: '90800626004856', receiptNoFinal: '90800626004856',
    groupNoAuto: '26802035', groupNoFinal: '26802035',
    groupNoMatchStatus: 'matched', modeRawPre: '乐天首尔',
    tourStance: 'matched', tourStancedAt: T0, tourStancedBy: 'admin',
    purchaseDateAuto: '2026-07-10', purchaseDateFinal: '2026-07-10',
    departureDateAuto: '2026-07-13', departureDateFinal: '2026-07-13',
    averageOcrScore: 0.96, lineCount: 24, reviewed: false, reviewedAt: '',
    rephotoRequested: false, sourceImageUrl: '/storage/B20260728-01/receipt_lotte.jpg',
    imageUrl: '/storage/B20260728-01/receipt_lotte.jpg',
    processResult: '识别完成', actionSuggestion: '',
    workflowState: { processResult: '识别完成', actionSuggestion: '' },
    reviewLane: 'full', fieldRegions: [], docRegions: [],
    createdAt: T0, updatedAt: T0, version: 1,
    ...over,
  };
}

const REVIEW_BATCH = {
  id: 'B20260728-01', name: '2026-07-28 首尔线 01', scenario: 'default',
  createdAt: '2026-07-28T01:10:00.000Z', updatedAt: T0,
  ownerUsername: '小票07', createdBy: '小票07', monthlyWorkspaceKey: WS,
  machineState: 'completed', groupCodeStatus: 'ready',
  exportedAt: '', exportedBy: null, exportKind: '',
  counts: { total: 6, queued: 0, processing: 0, completed: 6, error: 0, classification: 0, fields: 2, signature: 0, finalReview: 0, approved: 4, rephoto: 0 },
  reviewStats: { lastReviewedAt: T0, reviewedByDate: {} },
  recognitionProgress: { total: 6, done: 6 },
  sourceGroups: [
    { key: 'CL20260728-001', label: 'HUANG YING', taskCount: 3, completedCount: 3, agentName: '韩伴游', attachmentFiles: [] },
    { key: 'CL20260728-002', label: 'LI MENG', taskCount: 2, completedCount: 2, agentName: '海途旅行', attachmentFiles: [] },
    { key: 'CL20260728-003', label: 'WANG XIAO MING', taskCount: 1, completedCount: 1, agentName: '星途国际', attachmentFiles: [] },
  ],
  tasks: [
    reviewTask({}),
    reviewTask({
      id: 'task_0002', originalFileName: 'IMG_0002.jpg',
      receiptNoAuto: '90800626004913', receiptNoFinal: '90800626004913',
      purchaseDateAuto: '2026-07-11', purchaseDateFinal: '2026-07-11', averageOcrScore: 0.94,
    }),
    reviewTask({
      id: 'task_0003', originalFileName: 'IMG_0003.jpg',
      docTypeAuto: 'passport', docTypeFinal: 'passport', docType: 'passport',
      extractedNameAuto: 'HUANG YING', extractedNameFinal: 'HUANG YING',
      passportNoAuto: 'ER4848769', passportNoFinal: 'ER4848769',
      receiptStoreAuto: '', receiptStoreFinal: '', receiptNoAuto: '', receiptNoFinal: '',
      groupNoAuto: '', groupNoFinal: '', tourStance: '', modeRawPre: '',
      purchaseDateAuto: '', purchaseDateFinal: '', departureDateAuto: '', departureDateFinal: '',
      averageOcrScore: 0.97,
      sourceImageUrl: '/storage/B20260728-01/passport_huang.jpg',
      imageUrl: '/storage/B20260728-01/passport_huang.jpg',
    }),
    reviewTask({
      id: 'task_0004', originalFileName: 'IMG_0011.jpg', sourceGroupKey: 'CL20260728-002',
      sourceGroupLabel: 'LI MENG', customerAgentName: '海途旅行',
      receiptStoreAuto: 'THE SHILLA', receiptStoreFinal: 'THE SHILLA',
      receiptNoAuto: '3120451160872', receiptNoFinal: '3120451160872',
      groupNoAuto: '58021', groupNoFinal: '58021', modeRawPre: '新罗首尔',
      purchaseDateAuto: '2026-07-11', purchaseDateFinal: '2026-07-11',
      departureDateAuto: '2026-07-14', departureDateFinal: '2026-07-14', averageOcrScore: 0.95,
      reviewed: false,
      sourceImageUrl: '/storage/B20260728-01/receipt_shilla.jpg',
      imageUrl: '/storage/B20260728-01/receipt_shilla.jpg',
    }),
    reviewTask({
      id: 'task_0005', originalFileName: 'IMG_0012.jpg', sourceGroupKey: 'CL20260728-002',
      sourceGroupLabel: 'LI MENG', customerAgentName: '海途旅行',
      docTypeAuto: 'passport', docTypeFinal: 'passport', docType: 'passport',
      extractedNameAuto: 'LI MENG', extractedNameFinal: 'LI MENG',
      passportNoAuto: 'EH7712043', passportNoFinal: 'EH7712043',
      receiptStoreAuto: '', receiptStoreFinal: '', receiptNoAuto: '', receiptNoFinal: '',
      groupNoAuto: '', groupNoFinal: '', tourStance: '',
      purchaseDateAuto: '', purchaseDateFinal: '', departureDateAuto: '', departureDateFinal: '',
      averageOcrScore: 0.97, reviewed: false,
      sourceImageUrl: '/storage/B20260728-01/passport_li.jpg',
      imageUrl: '/storage/B20260728-01/passport_li.jpg',
    }),
    reviewTask({
      id: 'task_0006', originalFileName: 'IMG_0021.jpg', sourceGroupKey: 'CL20260728-003',
      sourceGroupLabel: 'WANG XIAO MING', customerAgentName: '星途国际',
      docTypeAuto: 'passport', docTypeFinal: 'passport', docType: 'passport',
      extractedNameAuto: 'WANG XIAO MING', extractedNameFinal: 'WANG XIAO MING',
      passportNoAuto: 'EG2451188', passportNoFinal: 'EG2451188',
      receiptStoreAuto: '', receiptStoreFinal: '', receiptNoAuto: '', receiptNoFinal: '',
      groupNoAuto: '', groupNoFinal: '', tourStance: '',
      purchaseDateAuto: '', purchaseDateFinal: '', departureDateAuto: '', departureDateFinal: '',
      averageOcrScore: 0.93, reviewed: false,
      sourceImageUrl: '/storage/B20260728-01/passport_wang.jpg',
      imageUrl: '/storage/B20260728-01/passport_wang.jpg',
    }),
  ],
};

// 台账表还会读 passportNo/netKrw/modeFolder/sourceType —— 不给就整列显示「—」,
// 一份财务系统的报告里出现一排空破折号,说服力直接打折。
function ledgerRow(id, agent, name, passportNo, tourNo, purchaseDate, modeRaw, netKrw, tourMatchStatus, billMatchStatus, sourceBatchId) {
  return {
    id, agent, name, passportNo, tourNo, purchaseDate, modeRaw, netKrw,
    modeFolder: modeRaw, modeNormalized: modeRaw, sourceType: 'daily',
    tourMatchStatus, billMatchStatus, sourceBatchId,
  };
}
const LEDGER_ROWS = [
  ledgerRow(1, '韩伴游', 'HUANG YING', 'ER4848769', '26802035', '2026-07-10', '乐天首尔', 442680, 'matched', 'matched', 'B20260728-01'),
  ledgerRow(2, '韩伴游', 'HUANG YING', 'ER4848769', '26802035', '2026-07-11', '乐天首尔', 128400, 'matched', 'matched', 'B20260728-01'),
  ledgerRow(3, '海途旅行', 'LI MENG', 'EH7712043', '58021', '2026-07-11', '新罗首尔', 180320, 'matched', 'unmatched', 'B20260728-01'),
  ledgerRow(4, '星途国际', 'WANG XIAO MING', 'EG2451188', '58022', '2026-07-12', '新罗爱宝客', 96150, 'matched', 'matched', 'B20260728-02'),
  ledgerRow(5, '星途国际', 'ZHAO LEI', 'EK5510338', '26802041', '2026-07-12', '乐天釜山', 251900, 'pending', 'unmatched', 'B20260728-02'),
  ledgerRow(6, '海途旅行', 'CHEN JIA', 'EJ2298471', '26802041', '2026-07-13', '乐天釜山', 318740, 'matched', 'matched', 'B20260728-03'),
  ledgerRow(7, '韩伴游', 'SUN QI', 'EM9034117', '58033', '2026-07-13', '济州新罗V团', 174500, 'matched', 'matched', 'B20260728-03'),
  ledgerRow(8, '韩伴游', 'ZHOU MIN', 'EN4471209', '无', '2026-07-14', '机场店', 58900, 'matched', 'unmatched', 'B20260728-03'),
];

const UNRECEIVED_ROWS = [
  { receiptNo: '90800626005120', passportNo: 'EK5510338', name: 'XU YAN', tourNo: '26802039', purchaseDate: '2026-07-09', modeFolder: '乐天首尔', modeRaw: '乐天首尔', netUsd: 412.5, agent: '韩伴游' },
  { receiptNo: '90800626005141', passportNo: 'EK5510338', name: 'XU YAN', tourNo: '26802039', purchaseDate: '2026-07-09', modeFolder: '乐天首尔', modeRaw: '乐天首尔', netUsd: 128.0, agent: '韩伴游' },
  { receiptNo: '3120451161045', passportNo: 'EJ2298471', name: 'GAO PENG', tourNo: '58027', purchaseDate: '2026-07-10', modeFolder: '新罗首尔', modeRaw: '新罗首尔', netUsd: 265.3, agent: '海途旅行' },
  { receiptNo: '3120451161233', passportNo: 'EM9034117', name: 'HE XIN', tourNo: '58031', purchaseDate: '2026-07-11', modeFolder: '新罗爱宝客', modeRaw: '新罗爱宝客', netUsd: 88.9, agent: '星途国际' },
  { receiptNo: '90800626005390', passportNo: 'EN4471209', name: 'DENG HUI', tourNo: '26802044', purchaseDate: '2026-07-12', modeFolder: '乐天釜山', modeRaw: '乐天釜山', netUsd: 634.0, agent: '星途国际' },
];

const IMPORT_JOBS = [
  { id: 21, jobType: 'group_code', sourceFile: '7月团号汇总.xlsx', operator: 'admin', status: 'done', startedAt: '2026-07-28T00:40:00Z', finishedAt: '2026-07-28T00:41:12Z', rowsTotal: 78421, rowsInserted: 78421, rowsSkipped: 0 },
  { id: 22, jobType: 'store_bill', sourceFile: '乐天7月账单.xlsx', operator: 'admin', status: 'done', startedAt: '2026-07-28T00:52:00Z', finishedAt: '2026-07-28T00:55:38Z', rowsTotal: 39114, rowsInserted: 39114, rowsSkipped: 0 },
  { id: 23, jobType: 'smg_ledger', sourceFile: 'SMG总账 7.28.xlsx', operator: 'admin', status: 'done', startedAt: '2026-07-28T01:05:00Z', finishedAt: '2026-07-28T01:12:44Z', rowsTotal: 287306, rowsInserted: 287306, rowsSkipped: 0 },
  { id: 24, jobType: 'store_bill', sourceFile: '新罗7月账单.xlsx', operator: 'admin', status: 'done', startedAt: '2026-07-28T01:20:00Z', finishedAt: '2026-07-28T01:22:03Z', rowsTotal: 17960, rowsInserted: 17958, rowsSkipped: 2 },
];

/** 桶级统计:billCount/dailyCount/matchStats/deductValue —— 缺了这些整页数字全是 0,
 *  截出来像"功能没配好",而不是"对账跑完了"。 */
function bucket(folder, file, modeRaws, { bills, daily, matched, unmatched, pending, deduct }) {
  return {
    folder,
    billFiles: [{ importJobId: `${folder}-1`, sourceFile: file, rows: bills }],
    modeRaws,
    routedWorkspaces: [WS],
    filesButNoDetail: false,
    isEmpty: false,
    billCount: bills,
    dailyCount: daily,
    deductValue: deduct,
    matchStats: { matched, matchedBillRows: matched, unmatched, pendingReview: pending },
  };
}
// 一套自洽的数:台账 1,284 张 · 账单 1,286 行 · 匹配上 1,249 · 未收 37(=账单有票没收到)
//   · 台账未匹配 35。四个桶逐项相加必须等于总数 —— 报告里的数字经不起加法检验就全废了。
const BUCKETS4 = [
  bucket('乐天首尔', '乐天7月账单.xlsx', ['乐天首尔', '乐天首尔R团'], { bills: 402, daily: 402, matched: 391, unmatched: 11, pending: 4, deduct: 0.085 }),
  bucket('乐天釜山', '乐天7月账单.xlsx', ['乐天釜山'], { bills: 318, daily: 318, matched: 310, unmatched: 8, pending: 2, deduct: 0.085 }),
  bucket('新罗首尔', '新罗7月账单.xlsx', ['新罗首尔', '新罗爱宝客'], { bills: 356, daily: 356, matched: 344, unmatched: 12, pending: 5, deduct: 0.0925 }),
  bucket('济州新罗V团', '济州7月账单.xlsx', ['济州新罗V团'], { bills: 210, daily: 208, matched: 204, unmatched: 6, pending: 1, deduct: 0.0925 }),
];
const BILL_GLOBAL = {
  totalBills: 1286, totalDaily: 1284, matched: 1249, matchedBillRows: 1249,
  matchRate: 1249 / 1284, billDetailCoverageRate: 1249 / 1286, pendingReview: 12,
};

// 配置台右侧详情由 mode.config.payload(没有则 mode.factory)驱动:
//   columns 是 8 个台账列的开关字典、receiptNoForm 是票号形态、actions 是特殊动作。
// 只给 config.columns 数组是不够的 —— 右边整块会空着,截出来像"点了没反应"。
function modeCfg(name, { cols, form = '', actions = [], note = '', source = 'factory', version = 0 }) {
  const ON = new Set(cols);
  const columns = Object.fromEntries(
    ['recordDate', 'agent', 'purchaseDate', 'receiptNo', 'groupNo', 'name', 'passportNo', 'departureDate']
      .map((k) => [k, ON.has(k)]),
  );
  const payload = { modeLabel: name, columns, receiptNoForm: form, actions, note, groupNoLiteral: '' };
  return {
    name, label: name, source, warnings: [],
    factory: payload,
    config: source === 'factory' ? null : { version, payload: { ...payload, review: { relax: [], require: [] } } },
  };
}
const ALL_COLS = ['recordDate', 'agent', 'purchaseDate', 'receiptNo', 'groupNo', 'name', 'passportNo', 'departureDate'];
const MODES = [
  modeCfg('乐天首尔', { cols: ALL_COLS, form: 'digits14' }),
  modeCfg('乐天釜山', { cols: ALL_COLS, form: 'digits14' }),
  modeCfg('新罗首尔', { cols: ALL_COLS.filter((c) => c !== 'departureDate'), form: 'digits13', source: 'override', version: 3, note: '本渠道不要求出境日期' }),
  modeCfg('新罗爱宝客', { cols: ALL_COLS.filter((c) => c !== 'departureDate'), form: 'digits13' }),
  modeCfg('济州新罗V团', { cols: ['recordDate', 'agent', 'purchaseDate', 'receiptNo', 'groupNo', 'name', 'passportNo'], form: 'digits13', source: 'override', version: 2 }),
  modeCfg('乐天百货', { cols: ['recordDate', 'agent', 'purchaseDate', 'receiptNo', 'name', 'passportNo'], form: '', actions: [] }),
];

const LOGS = [
  { time: '2026-07-28T08:55:12Z', levelLabel: 'INFO', event: 'export_mode_delivery', route: 'POST /api/batches/:id/export-mode-delivery', stage: 'export', workspaceKey: WS, durationMs: 8421, msg: '批次 B20260728-03 交付包导出成功(3 个渠道包)' },
  { time: '2026-07-28T08:40:03Z', levelLabel: 'INFO', event: 'settle_group', route: 'POST /api/batches/:id/source-groups/:key/settle', stage: 'settle', workspaceKey: WS, durationMs: 612, msg: '客户组 LI MENG 通过并结算,写入台账 2 行' },
  { time: '2026-07-28T08:12:44Z', levelLabel: 'INFO', event: 'approve_group', route: 'POST /api/batches/:id/source-groups/:key/approve', stage: 'review', workspaceKey: WS, durationMs: 233, msg: '客户组 HUANG YING 终审通过' },
  { time: '2026-07-28T01:12:44Z', levelLabel: 'INFO', event: 'import_smg_ledger', route: 'POST /api/monthly/workspaces/:ws/imports/smg-ledger', stage: 'import', workspaceKey: WS, durationMs: 464133, msg: 'SMG 总账导入完成:287,306 行' },
  { time: '2026-07-28T00:41:12Z', levelLabel: 'INFO', event: 'import_group_code', route: 'POST /api/monthly/workspaces/:ws/imports/group-code', stage: 'import', workspaceKey: WS, durationMs: 72004, msg: '团号汇总导入完成:78,421 行' },
  { time: '2026-07-27T22:03:51Z', levelLabel: 'WARN', event: 'delete_blocked_settled', route: 'DELETE /api/batches/:id', stage: 'guard', workspaceKey: WS, durationMs: 45, msg: '批次含已结算客户组,删除被拒(delete_blocked_settled)' },
];

// ⚠️ 用户表走 snake_case(is_active/display_name/agent_code/last_login_at)——
// 写成驼峰不会报错,只会让每一行都显示成"已停用 · 姓名 -",看上去像功能坏了。
const USERS = [
  { id: 1, username: 'admin', display_name: '系统管理员', role: 'admin', agent_code: '', is_active: 1, last_login_at: '2026-07-28T08:58:00Z' },
  { id: 2, username: '后勤07', display_name: '侯丹妮', role: 'admin', agent_code: 'H07', is_active: 1, last_login_at: '2026-07-28T08:31:00Z' },
  { id: 3, username: '财务01', display_name: '钱静', role: 'finance', agent_code: 'F01', is_active: 1, last_login_at: '2026-07-28T07:12:00Z' },
  { id: 4, username: '小票07', display_name: '李文', role: 'reviewer', agent_code: '07', is_active: 1, last_login_at: '2026-07-28T08:44:00Z' },
  { id: 5, username: '小票12', display_name: '张宁', role: 'reviewer', agent_code: '12', is_active: 1, last_login_at: '2026-07-28T08:40:00Z' },
  { id: 6, username: '小票19', display_name: '王倩', role: 'reviewer', agent_code: '19', is_active: 1, last_login_at: '2026-07-28T08:12:00Z' },
  { id: 7, username: '小票22', display_name: '(离职)周敏', role: 'reviewer', agent_code: '22', is_active: 0, last_login_at: '2026-07-20T05:10:00Z' },
];

// ─────────────────────────── 采集 ───────────────────────────
(async () => {
  const browser = await chromium.launch(process.env.SHOT_CHANNEL ? { channel: process.env.SHOT_CHANNEL } : {});
  console.log('采集中…');

  // ① 登录页 —— 系统入口 / 角色鉴权
  {
    // 登录页只有一张居中的小卡片。用 1560×950 截会得到一大片空灰底,
    // 缩进报告只有 600px 宽时表单小到看不清 —— 这里用紧凑视口,让卡片占住画面。
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    await page.route(/:\d+\/api\//, (r) => r.fulfill(json({})));
    await page.route('**/api/auth/me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await shoot(page, '01_登录_系统入口', '账号密码登录,四种角色分权(管理员/审核员/财务/收票员)', '登录');
    await page.close();
  }

  // ② 首页 —— 运营概览 / 收票员看板 / 待管理事项
  {
    const page = await newPage(browser);
    await page.route('**/api/state**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.route('**/api/batches**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.route('**/api/workbench/overview**', (r) => r.fulfill(json(OVERVIEW)));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await shoot(page, '02_首页_运营概览', '今日上传/审核/导出 + 完成率,收票员看板,待管理事项', '运营概览');
    await page.close();
  }

  // ③ 收票建档 —— 输入:护照与小票照片
  {
    const page = await newPage(browser);
    await page.route('**/api/customer-library/state**', (r) => r.fulfill(json({ workspaces: [WS], workspaceKey: WS })));
    await page.route('**/api/customer-library/workspaces', (r) => r.fulfill(json({ workspaces: [WS], workspaceKey: WS })));
    await page.route('**/api/customer-library/workspaces/*/customers**', (r) => r.fulfill(json({ customers: CUSTOMERS })));
    await page.route('**/api/state**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.route('**/api/batches**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.goto(`${BASE}/intake`, { waitUntil: 'networkidle' });
    // 按真实操作选一个"当前审核批次"。不选批次时页面会挂两条护栏警告(设计如此),
    // 但报告要展示的是正常工作状态。直接写 localStorage 不管用 —— 页面会拿已加载的
    // 批次列表复核,时序上先被判无效清掉;走 <select> 就是用户真实路径,稳。
    await page.waitForTimeout(600);
    await page.selectOption('.cl-ctx-select', 'B20260728-01').catch(() => {});
    await page.waitForTimeout(700);
    await shoot(page, '03_收票建档_上传入口', '输入端:整包照片上传即建档,自动进入识别队列', '建档');
    await page.close();
  }

  // ④ 审核台 —— 识别结果 + 人工确认(核心界面)
  {
    const page = await newPage(browser);
    await page.route('**/api/state**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.route('**/api/batches/B20260728-01**', (r) => r.fulfill(json(REVIEW_BATCH)));
    await page.goto(`${BASE}/review/B20260728-01`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    // 进页面默认不选中任何一张,右侧字段面板是空的 —— 必须点开客户组再选一张,
    // 否则截到的是"有队列没内容"的半张脸。
    await page.locator('.group-header').first().click();
    await page.waitForTimeout(700);
    // 优先选小票那张:它的字段最全(免税店/票号/团号/购买日/出境日),最能说明"识别出什么、人核什么"。
    const receiptRow = page.locator('.task-row', { hasText: '小票' }).first();
    const anyRow = page.locator('.task-row').first();
    const target = (await receiptRow.count()) ? receiptRow : anyRow;
    if (await target.count()) { await target.click(); await page.waitForTimeout(900); }
    // 自检判据用队列里的代理名(队列按代理分组):票号/姓名都在 <input> 的 value 里,
    // 不进 innerText,拿它们当判据会永远等不到。
    await shoot(page, '04_审核台_识别与确认', '左:客户组队列 中:单据原图 右:识别字段与人工确认', '韩伴游');
    await page.close();
  }

  // ⑤ 收票台账 —— 结算产出
  {
    const page = await newPage(browser);
    await page.route('**/api/**/ledger**', (r) => r.fulfill(json({ rows: LEDGER_ROWS, total: 1284 })));
    await page.goto(`${BASE}/monthly/v2/${WS}/ledger`, { waitUntil: 'networkidle' });
    await shoot(page, '05_收票台账_结算产出', '审核通过即写入台账,带团号匹配/账单匹配双状态', '26802035');
    await page.close();
  }

  // ⑥ 月度导入 —— 输入:团号表 / 店家账单 / SMG 总账
  {
    const page = await newPage(browser);
    await page.route('**/api/**/import-jobs**', (r) => r.fulfill(json({ jobs: IMPORT_JOBS })));
    await page.goto(`${BASE}/monthly/v2/${WS}/imports`, { waitUntil: 'networkidle' });
    await shoot(page, '06_月度导入_外部数据', '输入端:团号汇总 / 店家账单 / SMG 总账导入与留痕', '团号');
    await page.close();
  }

  // ⑦ 账单匹配 —— 四桶对账控制台
  {
    const page = await newPage(browser);
    await page.route('**/api/**/bill-match/buckets**', (r) => r.fulfill(json({ buckets: BUCKETS4, global: BILL_GLOBAL })));
    await page.route('**/api/**/deduct-config**', (r) => r.fulfill(json({
      confirmed: true, rules: BUCKETS4.map((b) => ({ modeFolder: b.folder, deductValue: b.deductValue })),
    })));
    await page.route('**/api/**/mode-mapping**', (r) => r.fulfill(json({
      confirmed: true, unmapped: [],
      mappings: BUCKETS4.flatMap((b) => b.modeRaws.map((m) => ({ modeRaw: m, modeFolder: b.folder }))),
    })));
    await page.goto(`${BASE}/monthly/v2/${WS}/bill-match`, { waitUntil: 'networkidle' });
    await shoot(page, '07_账单匹配_四桶控制台', '按渠道分桶导入店家账单,逐桶跑匹配与重对账', '乐天首尔');
    await page.close();
  }

  // ⑧ 未收清单 —— 催收产出
  {
    const page = await newPage(browser);
    await page.route('**/api/**/bill-match/unreceived**', (r) => r.fulfill(json({ rows: UNRECEIVED_ROWS, total: 37 })));
    await page.goto(`${BASE}/monthly/v2/${WS}/unreceived`, { waitUntil: 'networkidle' });
    await shoot(page, '08_未收清单_催收产出', '账单有、票没收到的差集,按渠道/代理导出催收清单', '90800626005120');
    await page.close();
  }

  // ⑨ 交付核对 —— 返点合计走全量
  {
    const page = await newPage(browser);
    await page.route('**/api/**/monthly-data**', (r) => r.fulfill(json({
      rows: LEDGER_ROWS.map((r2, i) => ({ ...r2, mode_folder: r2.modeRaw, receipt_no: `908006260048${50 + i}`, passport_no: 'ER4848769', customer_rebate_krw: 12000 + i * 811, is_unmatched: 0 })),
      total: 1284,
      byMode: BUCKETS4.map((b) => ({ folder: b.folder, unmatched: 0, n: 321 })),
      totals: {
        buckets: [
          { folder: '乐天首尔', n: 402, rebateKrw: 5712400 },
          { folder: '乐天釜山', n: 318, rebateKrw: 4488150 },
          { folder: '新罗首尔', n: 356, rebateKrw: 5024900 },
          { folder: '济州新罗V团', n: 208, rebateKrw: 2914600 },
        ],
        totalRebateKrw: 18140050,
        totalRows: 1284,
      },
      listCap: 500,
    })));
    await page.route('**/api/**/final-delivery/readiness**', (r) => r.fulfill(json({ ok: true, blocking: [], warnings: ['unreceived_rows_excluded'] })));
    await page.route('**/api/monthly/workspaces/*/overview**', (r) => r.fulfill(json({ workspace: { workspaceKey: WS, status: 'open' }, counts: {} })));
    await page.route('**/api/**/stages/ensure-fresh**', (r) => r.fulfill(json({ ran: [], mergeStats: {} })));
    await page.goto(`${BASE}/monthly/v2/${WS}/delivery-check`, { waitUntil: 'networkidle' });
    await shoot(page, '09_交付核对_返点合计', '交付前核对:四桶返点合计取全量真值,列表只显示前 N 行', '5,712,400');
    await page.close();
  }

  // ⑩ 配置台 —— 渠道模式:台账记哪些列 + 审核审哪些字段
  {
    const page = await newPage(browser);
    await page.route('**/api/admin/config/modes**', (r) => r.fulfill(json({ modes: MODES })));
    await page.route('**/api/admin/config/stores**', (r) => r.fulfill(json({ stores: [] })));
    await page.route('**/api/admin/config/review-base**', (r) => r.fulfill(json({ base: { receipt: [], passport: [] } })));
    await page.route('**/api/admin/config/export-plans**', (r) => r.fulfill(json({ plans: [] })));
    await page.route('**/api/state**', (r) => r.fulfill(json({ batches: BATCHES })));
    await page.goto(`${BASE}/admin/config`, { waitUntil: 'networkidle' });
    await shoot(page, '10_配置台_渠道模式', '每个渠道模式配置:台账记哪些列 + 审核必审哪些字段', '渠道模式');
    await page.close();
  }

  // ⑪ 审计日志 —— 关键动作留痕
  {
    const page = await newPage(browser);
    await page.route('**/api/admin/logs**', (r) => r.fulfill(json({ logs: LOGS, total: LOGS.length })));
    await page.goto(`${BASE}/admin/logs`, { waitUntil: 'networkidle' });
    await shoot(page, '11_审计日志_操作留痕', '导入/审核/结算/导出/删除守卫全程留痕可追溯', 'settle_group');
    await page.close();
  }

  // ⑫ 用户与权限
  {
    const page = await newPage(browser);
    await page.route('**/api/admin/users**', (r) => r.fulfill(json({ users: USERS })));
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
    await shoot(page, '12_用户与权限', '三类角色:管理员/审核员/财务;审核员只看自己上传的批次', '启用中的员工');
    await page.close();
  }

  fs.writeFileSync(path.join(OUT, 'project_index.json'), JSON.stringify(shots, null, 2));
  console.log(`\n共 ${shots.length} 张 → ${OUT}`);
  await browser.close();
})();
