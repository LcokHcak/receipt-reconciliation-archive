'use strict';

/**
 * library_delivery_routes — 资料库交付页端点(2026-07-16 P0,设计=docs/资料库交付工作台设计_2026-07-16.md)。
 *
 * 分工:配置台(admin)管计划的增删改/版本;这里是**操作员执行面**——
 *   GET  /api/library/delivery-plans?batchId=   计划列表(注册表 1:1 同源)+该批次内计数/渠道子卡
 *   POST /api/library/delivery-readiness        按需 dry-run 预检(纯只读,不落盘)
 * 导出本身仍走老端点(/api/batches/:id/export-*),本模块零执行、零写盘。
 *
 * ⭐owner 隔离(设计红线6):登录即可访问,但每个请求都 assertBatchAccess——
 * 操作员只能看/预检自己的批次;admin/finance 全局(operator_scope 同一真相源)。
 */

const fs = require('node:fs');

const { authenticateToken: createAuthenticateToken } = require('../lib/auth/jwt_middleware');
const { planRowsForList, activePlanPayload } = require('../lib/export_plan_registry');
const { resolveExportPlan, buildCustomerGroups } = require('../lib/export_plan_engine');
const { assertBatchAccess } = require('../lib/operator_scope');
const { parseCustomerRefFromTask } = require('../lib/customer_ref');
const { resolveCanonicalModeName } = require('../lib/mode_record_matrix');
const { resolveTaskModeRule } = require('../lib/workbench_receipt_export');
const { groupPassportIssue } = require('../lib/validation/group_passport_rule');
const { createSemaphore } = require('../lib/simple_semaphore');

// 预检明细清单的返回上限。截断本身没错(不能把上万条塞进一个响应),
// 但必须连同截断前的真总数一起给(见响应里的 totals),否则前端只能拿截断后的
// 数组长度当总数用——那就是"小的那个数冒充总数"。
const LIST_CAP = 200;

// 复核H1:delivery-plans 对 4 个内置 planner 同步跑批次内存遍历+statSync——与执行端点
// customerDataExportGate(=2) 同级重量,读端点也必须有闸,并发放 2、队列满 429 错峰。
const planScanGate = createSemaphore({
  maxConcurrent: Number(process.env.LIBRARY_PLAN_SCAN_MAX_CONCURRENCY) || 2,
  maxQueue: Number(process.env.LIBRARY_PLAN_SCAN_MAX_QUEUE) || 8,
  busyMessage: '资料库计划刷新排队已满,请稍后再点',
});
// 复核H1配套:同批次 15s 内重复刷新直接吃缓存(徽章允许短暂滞后;精确明细走「预检」不缓存)。
// 缓存命中在 owner 校验**之后**,不构成隔离旁路(同批次数据与请求者无关)。
const PLANS_CACHE_TTL_MS = 15_000;
const plansCache = new Map(); // batchId → { at, payload }

function textOf(value) {
  return String(value || '').trim();
}

// 与 config_console_routes 同款(登录闸;角色不限——owner 隔离在 assertBatchAccess)
function resolveTokenMiddleware(auth = {}) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  return null;
}

// 'S活动:CL123/task_0001' / '现代:CL123/task_0001' / 'CL123/task_0001' → { customerId, taskId }
function parseBlockedLabel(label) {
  const m = String(label || '').match(/^(?:[^:]*:)?([^/]+)\/(.+)$/);
  return m ? { customerId: m[1], taskId: m[2] } : { customerId: String(label || ''), taskId: '' };
}

function createLibraryDeliveryRoutes({ modeConfigRepository, auth, deps = {} }) {
  if (!modeConfigRepository) throw new Error('library_delivery_routes: modeConfigRepository required');
  const {
    loadBatch,
    modeDeliveryExportService,
    lotteDeptDeliveryExportService,
    hyundaiDeliveryExportService,
    batchCustomerDataExportService,
    libraryModeExportService,
    resolveBatchRelativePath,
    dailyReceiptRepo = null, // 五问题#3/#4「有夹无行」预检:查组的台账行存在性(未接线=不报,不误伤)
  } = deps;

  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware ? [tokenMiddleware] : [];

  // 批次加载+owner 校验(通不过=403;批次不存在=404)。返回 null 时已答复。
  function loadAccessibleBatch(req, res) {
    const batchId = textOf(req.query?.batchId ?? req.body?.batchId);
    if (!batchId) {
      res.status(400).json({ error: '缺 batchId(资料库按批次处理,先选批次)' });
      return null;
    }
    const batch = loadBatch ? loadBatch(batchId) : null;
    if (!batch) {
      res.status(404).json({ error: `批次不存在:${batchId}` });
      return null;
    }
    try {
      assertBatchAccess(batch, req.user || null);
    } catch {
      res.status(403).json({ error: '这不是你的批次(操作员只能处理自己的批次)' });
      return null;
    }
    return batch;
  }

  // A4(2026-07-16 同步一致性审计):scope/模式比对一律归一到正名(别名/尾巴串同串同判,
  // 与冲突检查同口径;此前裸串比对会把别名票判出 scope)。
  function canonicalMode(raw) {
    return resolveCanonicalModeName(textOf(raw));
  }

  // 批次任务里实际出现的渠道模式(任务级模式单源 resolveTaskModeRule,与交付分拣回落同源:
  // 人选/机场推断模式也进清单——此前只认 modeRawPre,人选模式在切片选择器里根本列不出来)
  function batchModes(batch) {
    const modes = new Set();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const mode = textOf(resolveTaskModeRule(task).mode);
      if (mode) modes.add(mode);
    }
    return modes;
  }

  function batchCanonicalModes(batch) {
    return new Set([...batchModes(batch)].map((m) => canonicalMode(m)).filter(Boolean));
  }

  // 批次内客户数(按客户库ID去重;scopeModes 非空=只数命中模式的客户)
  function countBatchCustomers(batch, scopeModes = null) {
    const hit = new Set();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ref = parseCustomerRefFromTask(task);
      if (!ref.customerId) continue;
      if (scopeModes && scopeModes.size && !scopeModes.has(canonicalMode(resolveTaskModeRule(task).mode))) continue;
      hit.add(`${ref.workspaceKey}/${ref.customerId}`);
    }
    return hit.size;
  }

  function resolveTaskFile(batch, task) {
    const rel = textOf(task?.sourceImagePath);
    if (!rel || typeof resolveBatchRelativePath !== 'function') return '';
    try {
      const abs = resolveBatchRelativePath(batch.id, rel);
      return abs && fs.statSync(abs).isFile() ? abs : '';
    } catch { return ''; }
  }

  // ── 五问题#3/#4(2026-07-20)「有夹无行」预检 ─────────────────────────────
  // 交付包按批次任务出客户夹,客户数据表按台账行出——组审完但台账 0 行,包里就是"有夹无行"。
  // 两类账前列清(此前预检只列"整组未审核"):
  //   reviewedNotSettled 已审核未结算:整组 reviewed 但按 sourceBatchId+组键查台账无行
  //     (结算没点/桥接幽灵失败),去审核台点「确认」补结算。
  //   passportBlocked 缺护照被结算闸拦死:group_passport_rule 判定不齐(非百货组无护照任务等),
  //     结算永远过不去 → 必然 0 行;归因到缺护照,不重复计入上一类。
  // 组键=桥接写台账的 sourceCustomerId 同源(task.sourceGroupKey||sourceGroupLabel);
  // 重拍组跳过(结算闸另拦,资料库已有「需重拍」清单)。
  function collectLedgerGaps(batch) {
    const reviewedNotSettled = [];
    const passportBlocked = [];
    if (!dailyReceiptRepo?.listWorkspaceKeysForSourceGroup) {
      return { reviewedNotSettled, passportBlocked }; // 未接线/降级 → 不报,不误伤
    }
    const isRephoto = (t) => Boolean(t?.rephotoRequested)
      || String(t?.processResult || '').toLowerCase().includes('rephoto')
      || String(t?.processResult || '').includes('重拍');
    const docTypeOf = (t) => textOf(t?.docTypeFinal || t?.docTypeAuto).toLowerCase();
    const groups = new Map(); // 组键(=桥接 sourceCustomerId) → tasks
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ledgerKey = textOf(task?.sourceGroupKey || task?.sourceGroupLabel);
      if (!ledgerKey) continue; // 无组键的散图查不了台账归属
      if (!groups.has(ledgerKey)) groups.set(ledgerKey, []);
      groups.get(ledgerKey).push(task);
    }
    for (const [ledgerKey, tasks] of groups) {
      if (!tasks.every((t) => t.reviewed)) continue; // 未审完已在 skipped 名单
      if (tasks.some(isRephoto)) continue; // 重拍组另有清单
      const receipts = tasks.filter((t) => docTypeOf(t) === 'receipt');
      if (!receipts.length) continue; // 没小票的组本就不产生台账行
      const withRef = tasks.find((t) => parseCustomerRefFromTask(t).customerId) || tasks[0];
      const ref = parseCustomerRefFromTask(withRef);
      const entry = {
        customerId: ref.customerId || '',
        groupKey: ledgerKey,
        label: textOf(tasks[0]?.sourceGroupLabel) || ref.customerId || ledgerKey,
        receipts: receipts.length,
      };
      // 结算闸口径与 workbench_approve_settle_service.preCheckGroup 对齐(剔重拍后判护照数量)
      const passports = tasks.filter((t) => docTypeOf(t) === 'passport');
      if (groupPassportIssue({ passportTasks: passports, receiptTasks: receipts })) {
        passportBlocked.push({ ...entry, reason: 'invalid_passport_count' });
        continue;
      }
      let hasRows;
      try {
        hasRows = (dailyReceiptRepo.listWorkspaceKeysForSourceGroup({
          sourceBatchId: batch.id, sourceCustomerId: ledgerKey,
        }) || []).length > 0;
      } catch { hasRows = true; } // 台账查询故障不误报
      if (!hasRows) reviewedNotSettled.push(entry);
    }
    return { reviewedNotSettled, passportBlocked };
  }

  // ── 各计划的批次内预检(delivery-plans 计数与 readiness 明细共用一套跑法)──
  function runBuiltinReadiness(builtin, batch) {
    if (builtin === 'mode_delivery') {
      if (!modeDeliveryExportService?.planModeDelivery) return { error: '多模式交付包服务未装配' };
      const plan = modeDeliveryExportService.planModeDelivery(batch);
      const blocked = [
        ...(plan.missingSActivityDetails || []).map((d) => ({
          reason: '缺小票号(S活动按票号命名)', label: d.label,
          zone: modeDeliveryExportService.zoneOfMode ? modeDeliveryExportService.zoneOfMode(d.mode) : d.mode,
          ...parseBlockedLabel(d.label),
        })),
        // 规则5(2026-07-20):新世界/现代百货缺交易编码(夹/图都按它命名),zone=上家区
        ...(plan.missingDeptTransNoDetails || []).map((d) => ({
          reason: '缺交易编码(百货上家链按交易编码命名)', label: d.label, zone: d.zone,
          ...parseBlockedLabel(d.label),
        })),
        ...plan.missingHyundaiReceiptNo.map((label) => ({
          reason: '缺小票号(现代池按票号命名)', label, zone: '现代免税店', ...parseBlockedLabel(label),
        })),
      ];
      const gaps = collectLedgerGaps(batch); // 五问题#3/#4:有夹无行两类清单
      return {
        stats: {
          customers: plan.customers, files: plan.fileCount, blocked: blocked.length, skipped: plan.skippedUnreviewed.length,
          reviewedNotSettled: gaps.reviewedNotSettled.length, passportBlocked: gaps.passportBlocked.length,
        },
        zones: modeDeliveryExportService.summarizeZones ? modeDeliveryExportService.summarizeZones(plan) : [],
        blocked,
        skipped: plan.skippedUnreviewed.map((cid) => ({ customerId: cid, reason: '整组未审核完' })),
        reviewedNotSettled: gaps.reviewedNotSettled,
        passportBlocked: gaps.passportBlocked,
      };
    }
    if (builtin === 'lotte_dept') {
      if (!lotteDeptDeliveryExportService?.planDelivery) return { error: '乐天百货交付包服务未装配' };
      const plan = lotteDeptDeliveryExportService.planDelivery(batch);
      // 2026-07-20 拍板a:无独立护照不再阻断(同框整图兜底充当护照图),降级为 note 信息
      const blocked = [
        ...plan.missingReceiptNo.map((label) => ({ reason: '缺交易编号', label, ...parseBlockedLabel(label) })),
        ...plan.missingBranch.map((label) => ({ reason: '缺门店', label, ...parseBlockedLabel(label) })),
      ];
      const fallbackCount = (plan.passportFallback || []).length;
      return {
        stats: {
          customers: plan.customers, files: plan.fileCount, blocked: blocked.length,
          skipped: plan.skippedUnreviewed.length, passportFallback: fallbackCount,
        },
        note: fallbackCount ? `${fallbackCount} 客户无独立护照,护照图用同框整图兜底(不阻断)` : '',
        blocked,
        skipped: plan.skippedUnreviewed.map((cid) => ({ customerId: cid, reason: '整组未审核完' })),
      };
    }
    if (builtin === 'hyundai_delivery') {
      if (!hyundaiDeliveryExportService?.planDelivery) return { error: '现代交付包服务未装配' };
      const plan = hyundaiDeliveryExportService.planDelivery(batch);
      const blocked = (plan.missingReceiptNo || []).map((label) => ({ reason: '缺小票号(按票号命名)', label, ...parseBlockedLabel(label) }));
      const files = Object.values(plan.pools || {}).reduce((n, list) => n + list.length, 0);
      return {
        stats: { files, blocked: blocked.length, skipped: (plan.skippedUnreviewed || []).length },
        blocked,
        skipped: (plan.skippedUnreviewed || []).map((cid) => ({ customerId: cid, reason: '整组未审核完' })),
      };
    }
    if (builtin === 'customer_folders') {
      if (!batchCustomerDataExportService?.planExport) return { error: '客户文件夹导出服务未装配' };
      const plan = batchCustomerDataExportService.planExport(batch);
      return { stats: { customers: plan.customerCount, files: plan.imageCount, blocked: 0, skipped: 0 }, blocked: [], skipped: [] };
    }
    if (builtin === 'library_excel') {
      if (!libraryModeExportService?.listModeSummary) return { error: '资料库导出服务未装配' };
      const modes = libraryModeExportService.listModeSummary({ batchId: batch.id });
      const customers = modes.reduce((n, m) => n + (m.customers || 0), 0);
      const receipts = modes.reduce((n, m) => n + (m.receipts || 0), 0);
      return {
        stats: { customers, rows: receipts, blocked: 0, skipped: 0 },
        note: customers ? '' : '该批次还没有已结算客户(审核台整组确认结算后才有数据)',
        blocked: [],
        skipped: [],
      };
    }
    return { error: `未知内置计划:${builtin}` };
  }

  function runDslReadiness(plan, batch) {
    if (plan.excel) {
      // Excel 计划按工作区出表;批次语境下给行数提示即可(P0 不执行)
      if (!libraryModeExportService?.listModeSummary) return { error: '资料库导出服务未装配' };
      const scope = new Set((plan.scope?.modes || []).map((m) => canonicalMode(m)).filter(Boolean));
      const modes = libraryModeExportService.listModeSummary({ batchId: batch.id })
        .filter((m) => !scope.size || scope.has(canonicalMode(m.mode)));
      const rows = modes.reduce((n, m) => n + (m.receipts || 0), 0);
      return { stats: { rows, blocked: 0, skipped: 0 }, blocked: [], skipped: [] };
    }
    const resolved = resolveExportPlan(plan, buildCustomerGroups(batch, (task) => resolveTaskFile(batch, task)));
    return {
      stats: { ...resolved.stats, files: resolved.entries.length },
      blocked: [
        ...resolved.blocked.map((b) => ({ reason: b.reason, label: `${b.customerId}/${b.taskId}`, customerId: b.customerId, taskId: b.taskId })),
        ...resolved.collisions.map((c) => ({ reason: `跨客户重名:${c.destBase}`, label: c.customers.join('、'), customerId: '', taskId: '' })),
      ],
      skipped: resolved.skipped.map((s) => ({ customerId: s.customerId, reason: s.reason })),
    };
  }

  function register(app) {
    // 计划列表(注册表 1:1)+ 批次内计数/渠道子卡。列表与配置台同一实现(lib/export_plan_registry)。
    app.get('/api/library/delivery-plans', ...protect, async (req, res) => {
      const batch = loadAccessibleBatch(req, res);
      if (!batch) return undefined;
      // 缓存命中(owner 校验已过):同批次 15s 内重复刷新不重跑 planner
      const cached = plansCache.get(batch.id);
      if (cached && Date.now() - cached.at < PLANS_CACHE_TTL_MS) {
        return res.json(cached.payload);
      }
      try {
        await planScanGate.acquire();
      } catch (busyErr) {
        return res.status(429).json({ error: busyErr.message, code: busyErr.code });
      }
      try {
        const payload = buildPlansPayload(batch);
        plansCache.set(batch.id, { at: Date.now(), payload });
        if (plansCache.size > 200) { // 批次只增不减,防缓存无界膨胀:超阈值清最老一半
          const entries = [...plansCache.entries()].sort((a, b) => a[1].at - b[1].at);
          for (const [key] of entries.slice(0, 100)) plansCache.delete(key);
        }
        return res.json(payload);
      } finally {
        planScanGate.release();
      }
    });

    function buildPlansPayload(batch) {
      const modesInBatch = batchModes(batch);
      const plans = planRowsForList(modeConfigRepository).map((row) => {
        const out = {
          name: row.name,
          label: row.label,
          kindType: row.kindType,
          builtin: row.builtin || null,
          rulesSpec: row.rulesSpec || null,
          scopeModes: row.config?.payload?.scope?.modes || row.factory?.scope?.modes || [],
          planKind: row.config?.payload?.excel ? 'excel' : (row.builtin ? 'builtin' : 'folder'),
        };
        if (row.kindType === 'builtin') {
          // 内置计划:预检数据直接算(一次批次内存遍历,planner 纯函数)
          const readiness = runBuiltinReadiness(row.builtin, batch);
          out.stats = readiness.stats || null;
          out.zones = readiness.zones || null;
          out.blockedCount = readiness.blocked ? readiness.blocked.length : 0;
          out.error = readiness.error || null;
          // F6(2026-07-20):店类型专用包(乐天/现代百货)本批次无对应票据 → 不适用,
          // 否则计划卡标"可导出"、点了才 404(现代三池服务现代免税店,现代百货走一键包上家链桶)。
          // 通用包(一键/客户夹/Excel)对任何有客户的批次恒适用,不受此限。
          const storeSpecific = row.builtin === 'lotte_dept' || row.builtin === 'hyundai_delivery';
          const hasContent = Number(readiness.stats?.customers) > 0
            || Number(readiness.stats?.files) > 0
            || out.blockedCount > 0;
          out.applicable = storeSpecific ? hasContent : true;
        } else {
          const scope = new Set(out.scopeModes.map((m) => canonicalMode(m)).filter(Boolean));
          const canonicalInBatch = batchCanonicalModes(batch);
          const overlap = !scope.size || [...scope].some((m) => canonicalInBatch.has(m));
          out.applicable = overlap;
          out.stats = { customers: countBatchCustomers(batch, scope.size ? scope : null) };
        }
        return out;
      });
      return {
        batchId: batch.id,
        batchName: batch.name || batch.id,
        modesInBatch: [...modesInBatch],
        plans,
      };
    }

    // 按需 dry-run 预检:一个计划 × 一个批次 → 阻断/跳过明细(带审核台定位信息)。
    // 点一次算一次不缓存(修完阻断要立刻看到新结果),但同样过扫描闸(复核H1)。
    app.post('/api/library/delivery-readiness', ...protect, async (req, res, next) => {
      const batch = loadAccessibleBatch(req, res);
      if (!batch) return undefined;
      const planName = textOf(req.body?.planName);
      if (!planName) return res.status(400).json({ error: '缺 planName' });
      const plan = activePlanPayload(modeConfigRepository, planName);
      if (!plan) return res.status(404).json({ error: `计划不存在或还是草稿:${planName}(草稿要在配置台修好并启用)` });
      try {
        await planScanGate.acquire();
      } catch (busyErr) {
        return res.status(429).json({ error: busyErr.message, code: busyErr.code });
      }
      try {
        const readiness = plan.builtin ? runBuiltinReadiness(plan.builtin, batch) : runDslReadiness(plan, batch);
        if (readiness.error) return res.status(501).json({ error: readiness.error });
        return res.json({
          ok: true,
          planName,
          batchId: batch.id,
          kindType: plan.builtin ? 'builtin' : (plan.excel ? 'excel' : 'dsl'),
          stats: readiness.stats,
          zones: readiness.zones || null,
          note: readiness.note || '',
          blocked: (readiness.blocked || []).slice(0, LIST_CAP),
          skipped: (readiness.skipped || []).slice(0, LIST_CAP),
          // 五问题#3/#4:有夹无行两类清单(mode_delivery 才有;其余计划恒空数组)
          reviewedNotSettled: (readiness.reviewedNotSettled || []).slice(0, LIST_CAP),
          passportBlocked: (readiness.passportBlocked || []).slice(0, LIST_CAP),
          // ⭐截断前的真总数(2026-08-01):上面四个清单都截到 200,而前端面板显示的
          // 「阻断 N」取的正是**截断后**的数组长度 —— 计划卡上写着"阻断 350"、点开预检
          // 却说"阻断 200",同一个事实两个数,小的那个还冒充总数。
          // 截断本身是对的(不能把上万条塞进一个响应),错在没人说自己截了。
          totals: {
            blocked: (readiness.blocked || []).length,
            skipped: (readiness.skipped || []).length,
            reviewedNotSettled: (readiness.reviewedNotSettled || []).length,
            passportBlocked: (readiness.passportBlocked || []).length,
          },
          listCap: LIST_CAP,
        });
      } catch (error) {
        return next(error);
      } finally {
        planScanGate.release();
      }
    });
  }

  return { register };
}

module.exports = { createLibraryDeliveryRoutes };
