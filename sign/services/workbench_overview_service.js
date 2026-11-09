'use strict';

/**
 * 工作台首页聚合 — 一次请求返回首页三段,前端首页不用再并行拉 3~4 个接口。
 *
 *   今日待办  : 待预处理 / 待审核 / 待补救   (各带跳转目标)
 *   今日进度  : 上传 / 已审核 / 补救 / 完成率 / 导出文件夹
 *   本月进度  : 客户 / 已收 / 未收 / 已核对 / 人工待核 / 核对率
 *
 * 口径一致化(改口径时同步改 docs/UI字段说明-2026-06.md):
 *   ⓪ 首页分离追加(2026-07-18/19):reviewedToday=按 task.reviewedAt 落今日的动作口径;
 *     exportedToday=今日盖导出章批次的**当前** approved(实时值非导出瞬间快照,任一导出类型都算);
 *     alerts.unexported=审完(零未收尾,含 error/rephoto)且从未盖章的批次。
 *   ① 今日待办 = **当前待处理积压(实时)**,不按天过滤,随时刷新即最新:
 *     · 待预处理 = 全部批次 queued + processing(已上传、还没跑完识别)
 *     · 待审核   = 全部批次 classification + fields + signature + finalReview(识别完、待人工)
 *     · 待补救   = 所选月份台账里 tour_match_status ∈ REMEDY 的行数(异常补救页同口径)
 *   ② 今日进度 = **今日(业务时区 KST)新建批次的处理进度**,每天 0 点自然清零:
 *     · 上传 = 今日批次 total 之和;已审核 = 今日批次 approved 之和;完成率 = 已审核/上传
 *     · 导出文件夹 = 所选月份客户库里**今日新建档**的客户数
 *   ③ 本月进度 = **所选月份**的累计状态(请求传 workspaceKey,否则取最新正式月):
 *     · 客户 = 客户库建档数;已收 = daily_receipt;未收 = missing_receipt
 *     · 已核对 = daily_receipt.bill_match_status='matched'(台账小票口径)
 *     · 人工待核 = pending_review 未结;核对率 = 已核对/已收
 *
 * 时区:用 SIGN_BUSINESS_TZ(默认 Asia/Seoul,免税业务在韩国)判定“今日”,
 *       与服务器系统时区解耦,避免 UTC 0 点(=KST 9 点)误切天。
 */

// 业务时区与"今日"折算上提到 lib/business_time(2026-07-18 首页分离):
// summarizeBatch 的 reviewStats.reviewedByDate 用同一实现,两处口径不漂移。
const { BUSINESS_TZ, businessDate } = require('../lib/business_time');

// 「超时未处理」阈值:有待办且距最后动作超过 N 小时(拍板#4,默认 24h,ENV 可调)。
const DEFAULT_STALE_HOURS = 24;

// 与 DailyRemedyView 的 REMEDY_TOUR_STATUSES 保持一致(异常补救页的“待补救”定义)。
const REMEDY_TOUR_STATUSES = [
  'tour_not_found',
  'tour_ambiguous',
  'tour_store_mismatch',
  'agent_mismatch',
  'date_out_of_window',
  'mode_unresolved',
  'date_missing',
];

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function sumStatusRows(rows, statusKey, wantedStatus) {
  if (!Array.isArray(rows)) return 0;
  return rows
    .filter((row) => String(row?.[statusKey]) === wantedStatus)
    .reduce((sum, row) => sum + toInt(row?.n ?? row?.count), 0);
}

function countMatchedLedgerRows(dailyReceiptRepo, workspaceKey) {
  if (!workspaceKey) return 0;
  if (typeof dailyReceiptRepo?.countFiltered === 'function') {
    return toInt(dailyReceiptRepo.countFiltered({ workspaceKey, billMatchStatus: 'matched' }));
  }
  if (typeof dailyReceiptRepo?.countByMatchStatus === 'function') {
    return sumStatusRows(dailyReceiptRepo.countByMatchStatus(workspaceKey), 'status', 'matched');
  }
  return 0;
}

function pickLatestProduction(workspaces) {
  const keys = (Array.isArray(workspaces) ? workspaces : [])
    .map((w) => String(w?.workspaceKey || w?.key || w || '').trim())
    .filter((k) => k && !k.startsWith('demo-'))
    .sort()
    .reverse();
  return keys[0] || '';
}

// 批次的未收尾任务总数(判「超时未处理」用):人工待审 + 机器没跑完 + 故障未清。
// error/rephoto 必须算——纯故障批次(全卡 OCR 失败)不算的话永远不会被判超时,
// 恰恰是最该催的(2026-07-18 评审 M1;与前端 homeDisplay.batchBacklogCount 同口径)。
function batchBacklog(counts = {}) {
  return toInt(counts.queued) + toInt(counts.processing)
    + toInt(counts.classification) + toInt(counts.fields)
    + toInt(counts.signature) + toInt(counts.finalReview)
    + toInt(counts.error) + toInt(counts.rephoto);
}

// 今日审核张数:按 task.reviewedAt 落在今日(KST)统计——与「今日进度.已审核」
// (只看今日新建批次的 approved 存量)口径不同:昨天建的批次今天审掉的也算。
function reviewedOnDate(batch, dateStr) {
  return toInt(batch?.reviewStats?.reviewedByDate?.[dateStr]);
}

// 批次的 owner 归键:用户名 → #userId → 未分配。
// ⚠️ 与前端 frontend/src/lib/homeDisplay.js#ownerKeyOfBatch 是同一契约
// (看板行 key=这里,展开明细过滤=前端),两边判空必须字面一致(含 '' 排除),
// 漂移则该桶展开永远为空;workbench_home_ui_contract.test.js 锁双端一致性。
function ownerKeyOfBatch(batch) {
  const username = String(batch?.ownerUsername || batch?.createdBy || '').trim();
  if (username) return username;
  const userId = batch?.ownerUserId ?? batch?.createdByUserId ?? null;
  return (userId !== null && userId !== undefined && userId !== '') ? `#${userId}` : '未分配';
}

function createWorkbenchOverviewService({
  listBatches,
  monthlyWorkspaceService,
  dailyReceiptRepo,
  missingReceiptRepo,
  pendingReviewRepo,
  customerLibraryRepository,
  // 阈值取 ENV;显式设 0 = 关闭超时告警(0 不能被 || 吞掉,评审 L2)
  staleHours = Number.isFinite(Number(process.env.SIGN_STALE_BATCH_HOURS))
    ? Number(process.env.SIGN_STALE_BATCH_HOURS)
    : DEFAULT_STALE_HOURS,
}) {
  if (typeof listBatches !== 'function') throw new Error('listBatches is required');

  // 安全调用:任一数据源缺失/抛错都不拖垮整页,记进 warnings。
  function safe(label, fn, fallback, warnings) {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch (error) {
      warnings.push(`${label}: ${error?.message || 'failed'}`);
      return fallback;
    }
  }

  // ① 待办 = 全部批次的实时积压(不按天过滤)。
  function buildTodoFromBatches(batches) {
    let preprocess = 0;
    let review = 0;
    for (const batch of Array.isArray(batches) ? batches : []) {
      const c = batch?.counts || {};
      preprocess += toInt(c.queued) + toInt(c.processing);
      review += toInt(c.classification) + toInt(c.fields) + toInt(c.signature) + toInt(c.finalReview);
    }
    return { preprocess, review };
  }

  // 收票员看板(仅 admin/finance 可见):按 owner 把全部批次聚合成每人的
  // 收图 / 已审 / 待审 / 完成率,按待审降序(积压最多的排前面,最该催)。
  // 管 30 个收票员时,管理员一眼看出谁做完了、谁落后,而不是只有一个合并总数。
  // 2026-07-18 首页分离追加:今日上传/今日审核(reviewedAt 口径)/异常与超时计数/
  // 所在月份工作区(拍板#1:"工作区"列显示批次 monthlyWorkspaceKey,不造分区概念)。
  function buildCollectorBreakdown(batches, todayStr, nowMs) {
    const staleBefore = nowMs - staleHours * 3600 * 1000;
    const byOwner = new Map();
    for (const batch of Array.isArray(batches) ? batches : []) {
      const key = ownerKeyOfBatch(batch);
      const c = batch?.counts || {};
      const entry = byOwner.get(key) || {
        owner: key,
        batches: 0, collected: 0, reviewed: 0, pending: 0,
        uploadedToday: 0, reviewedToday: 0,
        errorCount: 0, rephotoCount: 0, staleCount: 0,
        workspaces: [],
      };
      entry.batches += 1;
      entry.collected += toInt(c.total);
      entry.reviewed += toInt(c.approved);
      entry.pending += toInt(c.classification) + toInt(c.fields) + toInt(c.signature) + toInt(c.finalReview);
      if (businessDate(batch?.createdAt) === todayStr) entry.uploadedToday += toInt(c.total);
      entry.reviewedToday += reviewedOnDate(batch, todayStr);
      entry.errorCount += toInt(c.error);
      entry.rephotoCount += toInt(c.rephoto);
      const updatedMs = new Date(batch?.updatedAt || batch?.createdAt || 0).getTime();
      if (staleHours > 0 && batchBacklog(c) > 0
        && Number.isFinite(updatedMs) && updatedMs > 0 && updatedMs < staleBefore) {
        entry.staleCount += 1;
      }
      const wk = String(batch?.monthlyWorkspaceKey || '').trim();
      if (wk && !entry.workspaces.includes(wk)) entry.workspaces.push(wk);
      byOwner.set(key, entry);
    }
    return [...byOwner.values()]
      .map((e) => ({
        ...e,
        workspaces: [...e.workspaces].sort().reverse(),
        completionRate: e.collected > 0 ? Number((e.reviewed / e.collected).toFixed(4)) : 0,
      }))
      .sort((a, b) => b.pending - a.pending || b.collected - a.collected);
  }

  // 异常提醒(拍板#2:批次侧只算 OCR失败 + 待补图;台账补救 remedy 另有入口不混)。
  // 带 batchIds 让前端点击直接展开对应批次列表,与计数同源不二次推导。
  // P1 追加 unexported:审完(零未收尾)但还没盖过导出章的批次(拍板#3)。
  function buildAlerts(batches, nowMs) {
    const staleBefore = nowMs - staleHours * 3600 * 1000;
    const ocrFailed = { count: 0, batchIds: [] };
    const rephoto = { count: 0, batchIds: [] };
    const stale = { count: 0, batchIds: [], thresholdHours: staleHours };
    const unexported = { count: 0, batchIds: [] };
    // 待管理事项(2026-07-26 用户需求②)新增两桶:
    //   staleGroups = 超 N 小时仍未结算完成的**客户组**(比"超时批次"更贴业务:一批里
    //     多数组结完、剩两组卡住时,批次口径会整批算超时,组口径只报真卡住的那几组);
    //   exportFailed = 导出真失败(status>=500)盖了失败戳、之后没再导出成功的批次。
    // countByBatch:每个批次贡献了几个超时组。⭐2026-08-01 补——这里本来就算出了 unsettled,
    // 却只把它加进总数、扔掉了明细,于是前端展开时只能拿批次自己的**张数**去填那一列:
    // 胶囊数「组」、行是「批次」、列是「张」,三个量纲串在一条链上,并排的数字互相之间
    // 没有任何可比性(2026-07-19 审计 M3 标注了 unit,但明细列这一层没跟上)。
    const staleGroups = { count: 0, batchIds: [], countByBatch: {}, thresholdHours: staleHours };
    const exportFailed = { count: 0, batchIds: [] };
    for (const batch of Array.isArray(batches) ? batches : []) {
      const id = String(batch?.id || batch?.batchId || '').trim();
      const c = batch?.counts || {};
      if (toInt(c.error) > 0) {
        ocrFailed.count += toInt(c.error);
        if (id) ocrFailed.batchIds.push(id);
      }
      if (toInt(c.rephoto) > 0) {
        rephoto.count += toInt(c.rephoto);
        if (id) rephoto.batchIds.push(id);
      }
      const updatedMs = new Date(batch?.updatedAt || batch?.createdAt || 0).getTime();
      if (staleHours > 0 && batchBacklog(c) > 0
        && Number.isFinite(updatedMs) && updatedMs > 0 && updatedMs < staleBefore) {
        stale.count += 1;
        if (id) stale.batchIds.push(id);
      }
      if (toInt(c.total) > 0 && batchBacklog(c) === 0 && !String(batch?.exportedAt || '').trim()) {
        unexported.count += 1;
        if (id) unexported.batchIds.push(id);
      }
      // 超时未完成客户组:组未结算(无 settledAt/settlementStatus!=settled)且建批超过阈值。
      // 用 createdAt(组的起算点)而非 updatedAt——批次里别的组有动静不该让这组"看起来不超时"。
      const createdMs = new Date(batch?.createdAt || 0).getTime();
      // ⭐ backlog 闸(2026-07-27 部署前审计):与兄弟桶 stale 同口径。没有 backlog 的批次
      // 说明活儿已经干完了,它的组不该再算"超时未完成"——否则 settledAt/settlementStatus
      // 进白名单(2026-07-08)之前建的历史批次会永久计入,这张牌恒定虚高、点进去还没法处理。
      if (staleHours > 0 && batchBacklog(c) > 0
        && Number.isFinite(createdMs) && createdMs > 0 && createdMs < staleBefore) {
        const groups = Array.isArray(batch?.sourceGroups) ? batch.sourceGroups : [];
        const unsettled = groups.filter((g) => (
          toInt(g?.taskCount) > 0
          && !String(g?.settledAt || '').trim()
          // no_receipts(纯护照/0小票组)是**终态**:结算完成但故意不盖 settledAt
          // (见 source_group_utils.markSettled——盖了会把删除/订正通道锁死)。
          // 不排掉它就是永久假阳性,而且人工无法消除:它已经结算完了,没有"去处理一下"这个动作。
          && !['settled', 'no_receipts'].includes(String(g?.settlementStatus || ''))
        )).length;
        if (unsettled > 0) {
          staleGroups.count += unsettled;
          if (id) {
            staleGroups.batchIds.push(id);
            staleGroups.countByBatch[id] = unsettled; // 明细列与胶囊同量纲(组),别再拿张数顶
          }
        }
      }
      if (String(batch?.exportFailedAt || '').trim()) {
        exportFailed.count += 1;
        if (id) exportFailed.batchIds.push(id);
      }
    }
    return { ocrFailed, rephoto, stale, unexported, staleGroups, exportFailed };
  }

  // 把多个批次同一天的审核跨度合并成 日期→{first,last}(同人跨批次干活是常态)。
  function mergeReviewSpans(batches, datePrefix = '') {
    const merged = new Map();
    for (const batch of Array.isArray(batches) ? batches : []) {
      const spans = batch?.reviewStats?.reviewSpans || {};
      for (const [day, span] of Object.entries(spans)) {
        if (datePrefix && !day.startsWith(datePrefix)) continue;
        if (!span?.first || !span?.last) continue;
        const entry = merged.get(day) || { first: span.first, last: span.last };
        if (span.first < entry.first) entry.first = span.first;
        if (span.last > entry.last) entry.last = span.last;
        merged.set(day, entry);
      }
    }
    return merged;
  }

  // 工时近似(P2 拍板#6 口径):每个活跃日按首末审核跨度算,不足 1 小时按 1 小时——
  // 单张/短跑不至于除出天文数字,hint 里注明近似。
  function activeHoursOf(spanEntries) {
    let hours = 0;
    for (const { first, last } of spanEntries) {
      const spanMs = new Date(last).getTime() - new Date(first).getTime();
      hours += Math.max(Number.isFinite(spanMs) ? spanMs / 3600000 : 0, 1);
    }
    return hours;
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  // 「我的」段(审核员首页 KPI + 我的数据本月):今日审掉张数/效率/排名/本月四项。
  // 排名按全体 owner 的今日审核数降序,只回本人名次(拍板#6:不下发他人明细,不破坏隔离);
  // 本月/效率只用本人可见批次(ownBatches=已按操作员过滤)。
  // isGlobal(admin/finance)给中性空值:全局角色的 ownBatches=全部批次,不拦会把
  // "全公司聚合"塞进名叫"我的"的字段(评审M1,契约卫生;管理员首页也不消费此段)。
  function buildMe(allBatches, ownBatches, operatorUser, todayStr, isGlobal = false) {
    const username = String(operatorUser?.username || '').trim();
    // 排名分桶用与看板同一套归键(ownerKeyOfBatch:用户名→#userId→未分配;2026-07-19 审计:
    // 旧写法只认 ownerUsername||createdBy,仅有 ownerUserId 的批次会漏出排行榜);
    // 「未分配」桶不入榜——没有人认领的活不该占名次。
    const byOwner = new Map();
    for (const batch of Array.isArray(allBatches) ? allBatches : []) {
      const key = ownerKeyOfBatch(batch);
      if (key === '未分配') continue;
      byOwner.set(key, (byOwner.get(key) || 0) + reviewedOnDate(batch, todayStr));
    }
    const ranking = [...byOwner.entries()].sort((a, b) => b[1] - a[1]);
    if (isGlobal) {
      return { reviewedToday: 0, todayEfficiency: null, rank: null, rankTotal: ranking.length, month: null };
    }
    // 本人可能以用户名或 #userId 两种键入桶,任一命中即取名次。
    const selfKeys = new Set([username, operatorUser?.userId != null ? `#${operatorUser.userId}` : ''].filter(Boolean));
    const index = selfKeys.size ? ranking.findIndex(([owner]) => selfKeys.has(owner)) : -1;

    // 今日审核数(对外字段+效率分子,必须同源;2026-07-19 审计:旧代码榜内取 ranking 值,
    // 混合归属批次场景会与 todayEfficiency 的分子各讲各话):恒用本人可见批次求和。
    const reviewedToday = (Array.isArray(ownBatches) ? ownBatches : [])
      .reduce((sum, batch) => sum + reviewedOnDate(batch, todayStr), 0);
    const todaySpans = mergeReviewSpans(ownBatches, todayStr);
    const todayEfficiency = reviewedToday > 0
      ? round1(reviewedToday / activeHoursOf(todaySpans.values()))
      : null;

    // 我的数据(本月):完成=动作口径;速度=完成/Σ活跃日工时;完成率/返工率=现存批次存量口径
    // (返工率用重拍近似,拍板#5;批次被清理后月度数字会缩,文档已注明)。
    const monthPrefix = String(todayStr || '').slice(0, 7);
    let monthReviewed = 0;
    let total = 0;
    let approved = 0;
    let rephoto = 0;
    for (const batch of Array.isArray(ownBatches) ? ownBatches : []) {
      const byDate = batch?.reviewStats?.reviewedByDate || {};
      for (const [day, n] of Object.entries(byDate)) {
        if (monthPrefix && day.startsWith(monthPrefix)) monthReviewed += toInt(n);
      }
      const c = batch?.counts || {};
      total += toInt(c.total);
      approved += toInt(c.approved);
      rephoto += toInt(c.rephoto);
    }
    const monthSpans = mergeReviewSpans(ownBatches, monthPrefix);
    const month = {
      reviewed: monthReviewed,
      avgPerHour: monthReviewed > 0 ? round1(monthReviewed / activeHoursOf(monthSpans.values())) : null,
      completionRate: total > 0 ? Number((approved / total).toFixed(4)) : 0,
      reworkRate: total > 0 ? Number((rephoto / total).toFixed(4)) : 0,
    };

    return {
      // 恒用本人口径(不取 ranking 值):与 todayEfficiency 分子同源,见上注释。
      reviewedToday,
      todayEfficiency,
      rank: index >= 0 ? index + 1 : null,
      rankTotal: ranking.length,
      month,
    };
  }

  // ② 进度 = 仅“今日(KST)新建批次”的吞吐,每天自然清零。
  function buildProgressFromBatches(batches, todayStr) {
    let uploaded = 0;
    let reviewed = 0;
    for (const batch of Array.isArray(batches) ? batches : []) {
      if (businessDate(batch?.createdAt) !== todayStr) continue;
      const c = batch?.counts || {};
      uploaded += toInt(c.total);
      reviewed += toInt(c.approved);
    }
    return { uploaded, reviewed };
  }

  function resolveActiveMonth(requestedKey, warnings) {
    const requested = String(requestedKey || '').trim();
    if (requested) return requested;
    const workspaces = safe(
      'workspaces.list',
      () => monthlyWorkspaceService.listProduction(),
      [],
      warnings,
    );
    return pickLatestProduction(workspaces);
  }

  function countRemedy(workspaceKey, warnings) {
    if (!workspaceKey || typeof dailyReceiptRepo?.countFiltered !== 'function') return 0;
    return REMEDY_TOUR_STATUSES.reduce((sum, status) => sum + safe(
      `remedy.${status}`,
      () => toInt(dailyReceiptRepo.countFiltered({ workspaceKey, tourMatchStatus: status })),
      0,
      warnings,
    ), 0);
  }

  // createdOn 传 YYYY-MM-DD 时只数当天新建档(今日导出文件夹);不传则数全部(本月客户)。
  function countCustomers(workspaceKey, warnings, { createdOn = '' } = {}) {
    if (!workspaceKey || typeof customerLibraryRepository?.listCustomers !== 'function') return 0;
    return safe(
      createdOn ? 'customers.today' : 'customers.count',
      () => {
        const list = customerLibraryRepository.listCustomers(workspaceKey) || [];
        if (!createdOn) return list.length;
        return list.filter((c) => businessDate(c?.createdAt) === createdOn).length;
      },
      0,
      warnings,
    );
  }

  function buildMonth(workspaceKey, warnings) {
    if (!workspaceKey) {
      return {
        workspaceKey: '',
        exists: false,
        customers: 0,
        received: 0,
        unreceived: 0,
        matched: 0,
        pendingReview: 0,
        matchRate: 0,
      };
    }
    const received = safe('received', () => toInt(dailyReceiptRepo?.countByWorkspace(workspaceKey)), 0, warnings);
    const unreceived = safe('unreceived', () => toInt(missingReceiptRepo?.countByWorkspace(workspaceKey)), 0, warnings);
    const matched = safe(
      'matched',
      () => countMatchedLedgerRows(dailyReceiptRepo, workspaceKey),
      0,
      warnings,
    );
    const pendingReview = safe('pendingReview', () => toInt(pendingReviewRepo?.countOpen(workspaceKey)), 0, warnings);
    const customers = countCustomers(workspaceKey, warnings);
    return {
      workspaceKey,
      exists: true,
      customers,
      received,
      unreceived,
      matched,
      pendingReview,
      matchRate: received > 0 ? Number((matched / received).toFixed(4)) : 0,
    };
  }

  async function getOverview({ workspaceKey = '', operatorUser = null } = {}) {
    const { filterBatchesByOperator, canAccessAllOperatorData } = require('../lib/operator_scope');
    const warnings = [];
    const allBatches = await Promise.resolve(
      safe('batches.list', () => listBatches(), [], warnings),
    ).catch((error) => {
      warnings.push(`batches.list: ${error?.message || 'failed'}`);
      return [];
    });
    // 按操作员可见范围过滤(admin/finance 看全部,reviewer 只看自己上传的),与
    // getWorkbenchState/getMyTodos 口径一致;否则非全局角色会看到全局「待审核」计数(别人的活)。
    const batches = filterBatchesByOperator(allBatches, operatorUser);
    const now = new Date();
    const todayStr = businessDate(now);
    // 收票员看板:仅全局角色(admin/finance)能看到分人明细,用未过滤的全部批次聚合;
    // reviewer 只管自己的活,这个看板对他们无意义(且按隔离不该看到别人),给空数组。
    const collectors = canAccessAllOperatorData(operatorUser)
      ? buildCollectorBreakdown(allBatches, todayStr, now.getTime())
      : [];
    const todo = buildTodoFromBatches(batches);
    const progress = buildProgressFromBatches(batches, todayStr);
    // 今日审核(动作口径):可见范围内全部批次里 reviewedAt 落在今日的张数。
    const reviewedToday = batches.reduce((sum, batch) => sum + reviewedOnDate(batch, todayStr), 0);
    // 今日导出(P1):今日盖过导出章的批次的完成张数之和(重复导出同批同日只算一次,
    // exportedAt 是"最后一次",昨天导今天重导会挪到今天——以最新动作为准)。
    const exportedToday = batches.reduce((sum, batch) => {
      if (businessDate(batch?.exportedAt) !== todayStr) return sum;
      return sum + toInt(batch?.counts?.approved);
    }, 0);
    const activeMonth = resolveActiveMonth(workspaceKey, warnings);
    const remedy = countRemedy(activeMonth, warnings);
    const exportedFolders = countCustomers(activeMonth, warnings, { createdOn: todayStr });
    const month = buildMonth(activeMonth, warnings);

    return {
      generatedAt: now.toISOString(),
      date: todayStr,
      timezone: BUSINESS_TZ,
      activeMonth,
      today: {
        todo: {
          preprocess: todo.preprocess,
          review: todo.review,
          remedy,
        },
        progress: {
          uploaded: progress.uploaded,
          reviewed: progress.reviewed,
          reviewedToday,
          exportedToday,
          remedy,
          completionRate: progress.uploaded > 0
            ? Number((progress.reviewed / progress.uploaded).toFixed(4))
            : 0,
          exportedFolders,
        },
      },
      collectors,
      // 异常提醒按操作员可见范围算:admin=全局,reviewer=只有自己的批次。
      alerts: buildAlerts(batches, now.getTime()),
      me: buildMe(allBatches, batches, operatorUser, todayStr, canAccessAllOperatorData(operatorUser)),
      month,
      warnings,
    };
  }

  return { getOverview };
}

module.exports = {
  createWorkbenchOverviewService,
  // 导出供契约测试与前端 homeDisplay.ownerKeyOfBatch 比对(双端归键必须一致)
  ownerKeyOfBatch,
  REMEDY_TOUR_STATUSES,
};
