'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createLibraryDeliveryRoutes } = require('../routes/library_delivery_routes');
const { createModeDeliveryExportService } = require('../services/mode_delivery_export_service');
const { createHyundaiDeliveryExportService } = require('../services/hyundai_delivery_export_service');
const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');
const { createBatchCustomerDataExportService } = require('../services/batch_customer_data_export_service');
const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');

// 资料库交付页端点(2026-07-16 P0):注册表 1:1 / 批次内预检 / owner 隔离。
function makeFixtureBatch(root) {
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
  return {
    id: 'batch_lib',
    name: '260716-测试',
    ownerUsername: 'op1',
    tasks: [
      // 组A(g_a):护照齐 + 已结算(台账有行)→ 不进任何"有夹无行"清单
      task({
        docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EQ123456',
        sourceGroupKey: 'g_a', sourceGroupLabel: 'CL20260716-001',
        sourceOriginalPath: 'ws1/CL20260716-001/a-pp.jpg', sourceImagePath: mkImg('source/a_pp.jpg'),
      }),
      task({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', groupNoFinal: '26141846',
        receiptNoFinal: '12345678901234',
        sourceGroupKey: 'g_a', sourceGroupLabel: 'CL20260716-001',
        sourceOriginalPath: 'ws1/CL20260716-001/a-r1.jpg', sourceImagePath: mkImg('source/a_r1.jpg'),
      }),
      // 组B(g_b):S活动票故意缺票号 → mode_delivery 预检应有阻断,且带定位信息;
      // 且纯免税小票无护照 → 结算闸拦死清单(五问题#4)
      task({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-S活动', groupNoFinal: '70012',
        receiptNoFinal: '',
        sourceGroupKey: 'g_b', sourceGroupLabel: 'CL20260716-002',
        sourceOriginalPath: 'ws1/CL20260716-002/b-r1.jpg', sourceImagePath: mkImg('source/b_r1.jpg'),
      }),
      // 组C(g_c):护照齐、整组已审,但台账 0 行 → 已审核未结算清单(五问题#3)
      task({
        docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK9876543',
        sourceGroupKey: 'g_c', sourceGroupLabel: 'CL20260716-003',
        sourceOriginalPath: 'ws1/CL20260716-003/c-pp.jpg', sourceImagePath: mkImg('source/c_pp.jpg'),
      }),
      task({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', groupNoFinal: '26141847',
        receiptNoFinal: '12345678901235',
        sourceGroupKey: 'g_c', sourceGroupLabel: 'CL20260716-003',
        sourceOriginalPath: 'ws1/CL20260716-003/c-r1.jpg', sourceImagePath: mkImg('source/c_r1.jpg'),
      }),
    ],
  };
}

async function makeServer(t, { user } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-deliv-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_batch_id TEXT, source_customer_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, branch TEXT, brand TEXT, qty TEXT, gross_krw TEXT, net_krw TEXT,
    customer_rebate TEXT, departure_date TEXT, imported_at TEXT
  )`);
  const repository = createModeConfigRepository({ db });
  // 缓存测试用独名批次(plansCache 是模块级 Map,跨 makeServer 实例共享,同名批次会串缓存)
  const batch = makeFixtureBatch(dir);
  // 测试里追加任务时用它建**各自**的图片文件:两条小票共用一个图 = 同一张照片按两个
  // 票号报两笔账,一票一图护栏(lib/delivery_render)会拦。生产实测自然产生的共用是 0 条。
  const mkImg = (rel) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'img');
    return rel;
  };
  batch.id = `batch_lib_${path.basename(dir)}`;
  // 台账行:source_customer_id=桥接写入的组键(task.sourceGroupKey),组A 已结算
  db.prepare(`INSERT INTO daily_receipt_export (workspace_key, source_batch_id, source_customer_id, mode_raw, name, passport_no, tour_no, agent, purchase_date, receipt_no)
    VALUES ('2026-07', ?, 'g_a', '乐天SG-本司', 'ZHANG SAN', 'EQ123456', '26141846', '本司', '2026-07-15', '12345678901234')`).run(batch.id);
  const resolveBatchRelativePath = (_batchId, rel) => path.join(dir, rel);
  const hyundai = createHyundaiDeliveryExportService({ resolveBatchRelativePath });
  const state = { user: user || { username: 'op1', role: 'reviewer' } };
  // planner 调用计数(H1 缓存回归用)
  const planCalls = { count: 0 };
  const modeDeliverySvc = createModeDeliveryExportService({ resolveBatchRelativePath, hyundaiDeliveryExportService: hyundai });
  const countingModeDelivery = {
    ...modeDeliverySvc,
    planModeDelivery: (b) => { planCalls.count += 1; return modeDeliverySvc.planModeDelivery(b); },
  };

  const app = express();
  app.use(express.json());
  createLibraryDeliveryRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = state.user; next(); } },
    deps: {
      loadBatch: (id) => (id === batch.id ? batch : null),
      modeDeliveryExportService: countingModeDelivery,
      lotteDeptDeliveryExportService: createLotteDeptDeliveryExportService({ resolveBatchRelativePath }),
      hyundaiDeliveryExportService: hyundai,
      batchCustomerDataExportService: createBatchCustomerDataExportService({
        customerLibraryRepository: { resolveCustomerDir: () => '' }, // 空客户库:planExport 走批次任务图路径
        resolveBatchRelativePath,
      }),
      libraryModeExportService: createLibraryModeExportService({ db }),
      resolveBatchRelativePath,
      // 五问题#3/#4:有夹无行预检的台账行存在性查询(与真仓库同名同形)
      dailyReceiptRepo: {
        listWorkspaceKeysForSourceGroup: ({ sourceBatchId, sourceCustomerId }) => db.prepare(
          'SELECT DISTINCT workspace_key AS w FROM daily_receipt_export WHERE source_batch_id = ? AND source_customer_id = ?'
        ).all(String(sourceBatchId || ''), String(sourceCustomerId || '')).map((r) => r.w).filter(Boolean),
      },
    },
  }).register(app);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  }
  return { call, state, repository, batchId: batch.id, planCalls, batch, mkImg };
}

test('delivery-plans:注册表1:1(内置5条)+一键卡带渠道子卡+批次内计数', async (t) => {
  const { call, batchId } = await makeServer(t);
  assert.equal((await call('GET', '/api/library/delivery-plans')).status, 400); // 缺 batchId
  assert.equal((await call('GET', '/api/library/delivery-plans?batchId=nope')).status, 404);

  const { status, body } = await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  assert.equal(status, 200);
  assert.equal(body.batchId, batchId);
  assert.deepEqual([...body.modesInBatch].sort(), ['乐天SG-S活动', '乐天SG-本司']);
  assert.equal(body.plans.filter((p) => p.kindType === 'builtin').length, 5);
  assert.ok(body.plans.every((p) => p.rulesSpec || p.kindType !== 'builtin'), '内置计划都带人话规则');

  const oneKey = body.plans.find((p) => p.builtin === 'mode_delivery');
  assert.ok(oneKey.zones && oneKey.zones.length, '一键卡要带渠道子卡');
  assert.ok(oneKey.zones.some((z) => z.zone === '乐天SG-本司'));
  assert.equal(oneKey.blockedCount, 1, 'S活动缺票号计入阻断徽章');

  const excel = body.plans.find((p) => p.builtin === 'library_excel');
  assert.equal(excel.stats.customers, 1, '已结算口径来自台账');
});

test('readiness:mode_delivery 阻断带定位信息;DSL 计划走引擎;草稿/不存在 404', async (t) => {
  const { call, repository, batchId } = await makeServer(t);

  const md = await call('POST', '/api/library/delivery-readiness', { batchId, planName: '内置·多模式四规则' });
  assert.equal(md.status, 200);
  assert.equal(md.body.kindType, 'builtin');
  assert.equal(md.body.stats.blocked, 1);
  const blocked = md.body.blocked[0];
  assert.equal(blocked.customerId, 'CL20260716-002', '阻断项必须带客户号供审核台定位');
  assert.ok(blocked.taskId, '阻断项必须带任务号');
  assert.equal(blocked.zone, '乐天SG-S活动');
  assert.ok(md.body.zones.some((z) => z.zone === '乐天SG-本司'));

  // DSL 计划(启用)→ 引擎预检;CL20260716-002 缺票号 → blocked 带 customerId
  repository.saveNewVersion({
    kind: 'export_plan', name: '按票号整理', createdBy: 't',
    payload: {
      planLabel: '按票号整理', scope: { modes: [] },
      levels: [{ template: '{receiptNo}' }], naming: { template: '{name}_{docLabel}{i}' },
      includes: ['receipt'], emptyPolicy: 'block_prefix',
    },
  });
  const dsl = await call('POST', '/api/library/delivery-readiness', { batchId, planName: '按票号整理' });
  assert.equal(dsl.status, 200);
  assert.equal(dsl.body.kindType, 'dsl');
  assert.ok(dsl.body.blocked.some((b) => b.customerId === 'CL20260716-002'), 'DSL 空值阻断带客户定位');

  assert.equal((await call('POST', '/api/library/delivery-readiness', { batchId, planName: '不存在' })).status, 404);
});

// 2026-07-20 百货交付重构:规则5 缺交易编码阻断带上家区;乐天无独立护照降级为 note 不阻断
test('readiness 百货重构:百货缺交易编码 zone=上家;乐天无护照=note+passportFallback 不阻断', async (t) => {
  const { call, batchId, batch, mkImg } = await makeServer(t);
  // 追加:新世界百货组(无护照、缺交易编码)+ 乐天百货组(无独立护照,票全字段齐)
  // ⚠️ 每条小票用**各自**的图:两条小票共用一个图片文件 = 同一张照片按两个票号报两笔账,
  // 一票一图护栏(lib/delivery_render)会拦。生产 51371 条小票里自然产生的共用是 0 条。
  batch.tasks.push(
    {
      id: 'task_dept1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'SHINSEGAE_DEPT',
      receiptNoFinal: '', customerAgentName: '张代理',
      sourceGroupKey: 'g_d', sourceGroupLabel: 'CL20260720-031',
      sourceOriginalPath: 'ws1/CL20260720-031/d-r1.jpg', sourceImagePath: mkImg('source/d_r1.jpg'),
    },
    {
      id: 'task_lot1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
      receiptNoFinal: '12345678', branchFinal: '0394', purchaseDateFinal: '2026-07-01',
      extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678',
      sourceGroupKey: 'g_e', sourceGroupLabel: 'CL20260720-032',
      sourceOriginalPath: 'ws1/CL20260720-032/e-r1.jpg', sourceImagePath: mkImg('source/e_r1.jpg'),
    },
  );

  const md = await call('POST', '/api/library/delivery-readiness', { batchId, planName: '内置·多模式四规则' });
  assert.equal(md.status, 200);
  const deptBlocked = md.body.blocked.find((b) => b.reason.includes('交易编码'));
  assert.ok(deptBlocked, '百货缺交易编码要进阻断清单');
  assert.equal(deptBlocked.zone, '梁总', '阻断按上家区归因(新世界默认梁总)');
  assert.equal(deptBlocked.customerId, 'CL20260720-031');
  assert.ok(deptBlocked.taskId, '阻断项带任务号供定位');

  const lt = await call('POST', '/api/library/delivery-readiness', { batchId, planName: '内置·乐天百货门店双图' });
  assert.equal(lt.status, 200);
  assert.equal(lt.body.blocked.length, 0, '乐天无独立护照不再阻断');
  assert.equal(lt.body.stats.passportFallback, 1);
  assert.ok(lt.body.note.includes('同框整图'), 'note 提示同框兜底');
});

// 2026-07-20 五问题#3/#4「有夹无行」预检:交付包有客户夹但客户数据表(台账)无行的两类账前列清
test('readiness 有夹无行:已审核未结算(台账0行)+ 缺护照拦结算 两类清单,互不重复', async (t) => {
  const { call, batchId } = await makeServer(t);
  const md = await call('POST', '/api/library/delivery-readiness', { batchId, planName: '内置·多模式四规则' });
  assert.equal(md.status, 200);

  // 组C:护照齐、整组已审,但台账 0 行 → 已审核未结算(带定位信息)
  const ns = md.body.reviewedNotSettled;
  assert.ok(Array.isArray(ns), 'payload 必须带 reviewedNotSettled 数组');
  assert.ok(ns.some((g) => g.customerId === 'CL20260716-003'), '组C 该进已审核未结算清单');
  assert.equal(ns.find((g) => g.customerId === 'CL20260716-003').receipts, 1);

  // 组B:纯免税小票无护照 → 结算闸拦死清单;不重复计入"已审核未结算"
  const pb = md.body.passportBlocked;
  assert.ok(Array.isArray(pb), 'payload 必须带 passportBlocked 数组');
  assert.ok(pb.some((g) => g.customerId === 'CL20260716-002'), '组B 该进缺护照拦结算清单');
  assert.ok(!ns.some((g) => g.customerId === 'CL20260716-002'), '拦死组归因缺护照,不重复计入台账0行');

  // 组A:已结算(台账有行)→ 两类清单都不在
  assert.ok(!ns.some((g) => g.customerId === 'CL20260716-001'));
  assert.ok(!pb.some((g) => g.customerId === 'CL20260716-001'));

  // stats 带计数(delivery-plans 计划卡同源)
  assert.equal(md.body.stats.reviewedNotSettled, 1);
  assert.equal(md.body.stats.passportBlocked, 1);

  const plans = await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  const oneKey = plans.body.plans.find((p) => p.builtin === 'mode_delivery');
  assert.equal(oneKey.stats.reviewedNotSettled, 1, 'plans 计划卡 stats 同源带计数');
  assert.equal(oneKey.stats.passportBlocked, 1);
});

// 复核H1回归:同批次 15s 内重复刷新吃缓存,planner 不重跑(闸+缓存防读端点压垮主线程)
test('delivery-plans 短TTL缓存:重复请求不重跑 planner', async (t) => {
  const { call, planCalls, batchId } = await makeServer(t);
  await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  const after1 = planCalls.count;
  assert.ok(after1 >= 1, '首次请求应跑 planner');
  const second = await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  assert.equal(second.status, 200);
  assert.equal(planCalls.count, after1, '15s 内第二次请求必须吃缓存,planner 不得重跑');
});

test('owner 隔离:别人的批次 403;admin 全放行', async (t) => {
  const { call, state, batchId } = await makeServer(t, { user: { username: 'op2', role: 'reviewer' } });
  assert.equal((await call('GET', `/api/library/delivery-plans?batchId=${batchId}`)).status, 403);
  assert.equal((await call('POST', '/api/library/delivery-readiness', { batchId, planName: '内置·多模式四规则' })).status, 403);
  state.user = { username: 'boss', role: 'admin' };
  assert.equal((await call('GET', `/api/library/delivery-plans?batchId=${batchId}`)).status, 200);
});

// F6(2026-07-20):内置计划原恒 applicable=true,现代三池对没有现代免税店小票的批次也标"可导出",
// 点了才 404。修:店类型专用包(乐天/现代百货)按 readiness 有无内容判 applicable,通用包不变。
test('F6 delivery-plans:店专用包(乐天/现代百货)无对应票据 → applicable=false;通用包恒 true', async (t) => {
  const { call, batchId } = await makeServer(t);
  const { body } = await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  const byBuiltin = new Map(body.plans.map((p) => [p.builtin, p]));
  // 测试批次全是乐天SG免税店票,无乐天百货/现代免税店票
  assert.equal(byBuiltin.get('lotte_dept').applicable, false, '乐天百货门店双图:无乐天百货票 → 不适用');
  assert.equal(byBuiltin.get('hyundai_delivery').applicable, false, '现代三池交付包:无现代免税店票 → 不适用');
  assert.equal(byBuiltin.get('mode_delivery').applicable, true, '一键多模式包:通用 → 适用');
  assert.equal(byBuiltin.get('customer_folders').applicable, true, '客户文件夹:通用 → 适用');
  assert.equal(byBuiltin.get('library_excel').applicable, true, '客户数据Excel:通用 → 适用');
});

// ── 0801:预检明细清单截断了却不说(计数与清单两个数,小的那个冒充总数)──────────
test('⭐预检响应带截断前的真总数;前端读 totals 而不是截断后的数组长度', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const routeSrc = fs2.readFileSync(path2.join(__dirname, '../routes/library_delivery_routes.js'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const code = strip(routeSrc);

  // 四个清单都截,截了就必须同时给真总数
  assert.match(code, /blocked: \(readiness\.blocked \|\| \[\]\)\.slice\(0, LIST_CAP\)/);
  assert.match(code, /totals: \{/, '要带截断前的真总数');
  // 用字面量包含,不拼正则:模板串里的 \[\] 会塌成 []，那是**永不匹配**的空字符类,
  // 断言就此变成"永远失败";方向反一下(doesNotMatch)则是"永远通过"——比没写还糟。
  for (const key of ['blocked', 'skipped', 'reviewedNotSettled', 'passportBlocked']) {
    assert.ok(code.includes(`${key}: (readiness.${key} || []).length`),
      `totals.${key} 必须取截断**前**的长度`);
  }
  assert.match(code, /listCap: LIST_CAP/, '把上限也告诉前端,好说"只列了前 N 条"');

  const viewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  const fn = /function readinessTotal\(key\)[\s\S]*?\n\}/.exec(viewSrc);
  assert.ok(fn, '没定位到 readinessTotal');
  assert.match(fn[0], /totals\?\.\[key\]/, '优先读真总数');
  assert.match(fn[0], /\?\.\[key\]\?\.length \|\| 0/, '老后端没有 totals 时才回落数组长度');
  // 面板上那几处计数不许再直接读数组长度
  assert.doesNotMatch(strip(viewSrc), /readiness\.blocked\.length/, '面板计数要走 readinessTotal');
  assert.match(viewSrc, /readinessTruncated/, '截断了要出一句说明');
  assert.match(viewSrc, /计数是全量的,清单不是/, '说清楚差别在哪');
});
