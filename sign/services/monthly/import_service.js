'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { streamRows } = require('../../lib/monthly_pipeline/xlsx_reader');
const { readWorkbookSheetNames } = require('../../lib/monthly_pipeline/xlsx_sheet_names');
const { mapGroupCodeRow } = require('../../lib/monthly_pipeline/group_code_mapper');
const {
  mapStoreBillRow, mapMissingReceiptRow, mapBrandActivityRow, isBrandActivityRow,
  mapSmgLedgerRow, SMG_DETAIL_SHEET,
} = require('../../lib/monthly_pipeline/bill_mapper');
const { mapReceivedReceiptRow, isReceiptWorkerSheet } = require('../../lib/monthly_pipeline/receipt_mapper');
const { mapDailyReceiptRow, isDailyLedgerHeaderRow } = require('../../lib/monthly_pipeline/daily_receipt_mapper');
const { hashFileStream } = require('../../lib/monthly_pipeline/row_hasher');
const { classifyBillFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { isModeFolder } = require('../../lib/monthly/mode_folder_constants');
const { resolveOptionalWorkspaceForPurchaseDate } = require('../../lib/monthly/workspace_resolver');

const BATCH_FLUSH = 1000;

// SMG总账导入进程内互斥(复核 HIGH,2026-07-21):"查 running job → runImport 建 job"
// 之间隔着 hashFileStream(98MB 文件真实耗秒)的 await 窗口,纯 DB 检查是 TOCTOU——
// 双击/两标签页并发会双双通过检查、互删对方行。生产=单进程 event loop(pm2 单实例),
// 模块级 Set 同步占位即全局互斥,无 await 间隙不可穿插;DB 检查仍保留,兜进程
// 重启后遗留的僵尸 running job(内存锁随进程消失兜不了)。
const smgImportLocks = new Set(); // workspaceKey 集合

// SMG 明细 sheet 定位(0727红批注 image15 实锤:上家发来的总账唯一 sheet 叫 Sheet1,
// 精确匹配「卖出明细」直接 422,用户每次得手动改 sheet 名)。宽严三级:
//   ① 精确同名照旧最优先;② 整本只有一个 sheet → 就它(没有别的可能,名字随意);
//   ③ 多 sheet 时按名字含「卖出」或「明细」模糊找,恰好一个才认——命中多个属于
//      歧义(如"卖出明细"+"卖出汇总明细"),猜错会整本导错,宁可报错让人挑。
// 返回 sheet 名(trim 后);定位不了返回 ''(调用方报 422,不动旧数据)。
function resolveSmgDetailSheet(sheetNames) {
  const names = sheetNames.map((n) => String(n).trim()).filter(Boolean);
  const exact = names.find((n) => n === SMG_DETAIL_SHEET);
  if (exact) return exact;
  if (names.length === 1) return names[0];
  const fuzzy = names.filter((n) => n.includes('卖出') || n.includes('明细'));
  return fuzzy.length === 1 ? fuzzy[0] : '';
}

/**
 * @typedef {{
 *   importJobRepo: ReturnType<typeof import('../repositories/import_job_repository').createImportJobRepository>,
 *   groupCodeRepo: ReturnType<typeof import('../repositories/group_code_repository').createGroupCodeRepository>,
 *   storeBillRepo: ReturnType<typeof import('../repositories/store_bill_repository').createStoreBillRepository>,
 *   missingReceiptRepo: ReturnType<typeof import('../repositories/missing_receipt_repository').createMissingReceiptRepository>,
 * }} ImportDeps
 */

function createImportService(/** @type {ImportDeps} */ deps) {
  const {
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
    // 品牌活动桶:导账单时自动分流(返点模式=品牌活动/限时活动)→ 不进 store_bill
    brandActivityRepo = null,
    // G8b(A1=γ): 注入 workspaceService 以便按 purchase_date 自动开月
    workspaceService = null,
  } = deps;
  if (!importJobRepo || !groupCodeRepo || !storeBillRepo || !missingReceiptRepo) {
    throw new Error('All monthly repositories are required');
  }

  // G8b(A1=γ): 5 种 import 里仅"按客行 purchase_date 拆"的 3 种走 splitByPurchaseDate:
  //   store_bill / daily_receipt / received_receipt
  // group_code / missing 按"团号 / 未收清单"维度,与月份关系弱 → 不拆 (导哪个 ws 就在哪个 ws)
  return {
    async importGroupCode(opts) {
      // 格式检测:多-sheet 新格式(2/3 月起)用专门抽取器(显式列,覆盖"团号列不叫团号"的
      // 新罗/爱宝客等 sheet);老单表格式走标准 header-name mapper。
      // 一次 readFile 同时拿到 sheet 名(判格式)+ 抽取行。
      const { extractMultisheetGroupCode, isMultisheetWorkbook } = require('../../lib/monthly_pipeline/group_code_multisheet');
      const ms = await extractMultisheetGroupCode({ filePath: opts.filePath, workspaceKey: opts.workspaceKey });
      if (isMultisheetWorkbook(ms.sheetNames) && ms.rows.length) {
        const ins = groupCodeRepo.insertMany(ms.rows);
        return { workspaceKey: opts.workspaceKey, jobType: 'group_code', multisheet: true, rowsInserted: ins.inserted, rowsSkipped: ins.skipped, rowsTotal: ms.rows.length };
      }
      // 老格式:标准单 sheet mapper
      return runImport({
        ...opts,
        jobType: 'group_code',
        mapRow: (ctx) => mapGroupCodeRow(ctx),
        persistBatch: (rows) => groupCodeRepo.insertMany(rows),
        sheetFilter: () => true,
        importJobRepo,
      });
    },
    importStoreBill(opts) {
      return runImport({
        ...opts,
        jobType: 'store_bill',
        // 品牌活动行(返点模式=品牌活动/限时活动)在导入时自动分流:
        // 打 __brandActivity 标 → persistBatch 写 brand_activity,不进 store_bill 小票匹配池。
        mapRow: (ctx) => {
          if (brandActivityRepo && isBrandActivityRow(ctx.asObject)) {
            const mapped = mapBrandActivityRow(ctx);
            return mapped ? { ...mapped, __brandActivity: true } : null;
          }
          return mapStoreBillRow(ctx);
        },
        persistBatch: (rows) => {
          const brand = [];
          const bills = [];
          for (const r of rows) {
            if (r.__brandActivity) { const { __brandActivity, ...rest } = r; brand.push(rest); }
            else bills.push(r);
          }
          let inserted = 0;
          let skipped = 0;
          if (bills.length) { const x = storeBillRepo.insertMany(bills); inserted += Number(x.inserted || 0); skipped += Number(x.skipped || 0); }
          if (brand.length && brandActivityRepo) { const y = brandActivityRepo.insertMany(brand); inserted += Number(y.inserted || 0); skipped += Number(y.skipped || 0); }
          return { inserted, skipped };
        },
        sheetFilter: () => true,
        onlyDetailForRules: true,
        importJobRepo,
        splitByPurchaseDate: workspaceService ? { workspaceService } : null,
      });
    },
    /**
     * SMG总账导入(2026-07-21 拍板:进系统只做一件事=未收对账,不分桶不卷账单匹配)。
     *
     * 语义要点:
     *  - 只吃一张明细 sheet(定位三级宽严:精确「卖出明细」>单 sheet 直收>多 sheet
     *    按「卖出/明细」唯一模糊命中;zip 目录级预检,定位不到清晰报错、不动旧数据);
     *  - 替换语义:总账是滚动全量(28万行/周涨10万,上家会修订历史行)→ 导入前清
     *    本工作区旧 smg_ledger 行再插。unreceived_state/unreceived_resolution 键是
     *    归一(护照|姓名|票号),不依赖账单行 id → first_seen/无需补 零影响不重置;
     *  - 行落共享 store_bill 表,isDetailSheet=false 隔离(账单匹配/合并/桶汇总只吃
     *    is_detail_sheet=1),未收对账 listUnreceived 不看该标位 → 恰好只进对账;
     *  - 不按购买月拆分(splitByPurchaseDate):总账整本就是本账期的滚动全量,
     *    行归导入的工作区,替换语义才能成立;
     *  - 完整性守卫(照团号表 2026-07-20 HIGH 同源):exceljs 流式会静默丢 sheet,
     *    zip 说有、流式没读到 → job 转 failed 明示,绝不静默 0 行"成功"。
     */
    async importSmgLedger(opts) {
      const jobType = 'smg_ledger';
      // ① 并发守卫两道:进程内互斥(同步占位,防双击/两标签页 TOCTOU)
      //    + DB running 检查(防进程重启前的导入残留;超 2 小时视为僵尸 job 不挡道)
      if (smgImportLocks.has(opts.workspaceKey)) {
        const err = new Error('已有一个总账导入正在进行,请等它完成后再导');
        err.statusCode = 409;
        throw err;
      }
      const running = importJobRepo.listByWorkspace({ workspaceKey: opts.workspaceKey, jobType, limit: 50 })
        .filter((j) => j.status === 'running'
          && Number.isFinite(Date.parse(j.startedAt))
          && (Date.now() - Date.parse(j.startedAt)) < 2 * 60 * 60 * 1000);
      if (running.length) {
        const err = new Error('已有一个总账导入正在进行,请等它完成后再导');
        err.statusCode = 409;
        throw err;
      }
      smgImportLocks.add(opts.workspaceKey);
      try {
        return await runSmgLedgerImport(opts);
      } finally {
        smgImportLocks.delete(opts.workspaceKey);
      }
    },
    importMissingReceipt(opts) {
      return runImport({
        ...opts,
        jobType: 'missing',
        mapRow: (ctx) => mapMissingReceiptRow(ctx),
        persistBatch: (rows) => missingReceiptRepo.insertMany(rows),
        sheetFilter: () => true,
        importJobRepo,
      });
    },
    importReceivedReceipt(opts) {
      if (!receivedReceiptRepo) throw new Error('receivedReceiptRepo is required');
      return runImport({
        ...opts,
        jobType: 'received_receipt',
        mapRow: (ctx) => mapReceivedReceiptRow(ctx),
        persistBatch: (rows) => receivedReceiptRepo.insertMany(rows),
        sheetFilter: (name) => isReceiptWorkerSheet(name),
        importJobRepo,
        splitByPurchaseDate: workspaceService ? { workspaceService } : null,
      });
    },
    importDailyReceipt(opts) {
      if (!dailyReceiptRepo) throw new Error('dailyReceiptRepo is required');
      return runImport({
        ...opts,
        jobType: 'daily_receipt',
        mapRow: (ctx) => mapDailyReceiptRow(ctx),
        persistBatch: (rows) => dailyReceiptRepo.insertMany(rows),
        sheetFilter: () => true,
        // 灾备/迁移直导收票工作簿:表头常在第 2 行,且混有汇总页/备份页。
        // detectHeader 逐行找台账表头,找不到的工作表整张跳过 → 只吃真正的收票台账页。
        // OCR 审核台→台账 是另一条桥接路径,不走本导入,故不受影响。
        detectHeader: isDailyLedgerHeaderRow,
        importJobRepo,
        splitByPurchaseDate: workspaceService ? { workspaceService } : null,
      });
    },
  };

  // importSmgLedger 的主体(锁内执行;拆出来让锁的 try/finally 一眼看全)
  async function runSmgLedgerImport(opts) {
    const jobType = 'smg_ledger';
      // ② sheet 预检(只解 zip 目录+workbook.xml,不读行数据,98MB 文件也秒回):
      //    定位不到明细 sheet(见 resolveSmgDetailSheet 三级宽严)→ 清晰报错并且
      //    不动任何旧数据。预检解不出(极少数结构异常,返回 [])不阻断——退回精确
      //    名交给 ⑤ 的流式完整性守卫兜底。
      const sheetNames = readWorkbookSheetNames(opts.filePath);
      const detailSheet = sheetNames.length ? resolveSmgDetailSheet(sheetNames) : SMG_DETAIL_SHEET;
      if (!detailSheet) {
        const err = new Error(
          `总账里认不出明细 sheet:没有「${SMG_DETAIL_SHEET}」,按「卖出/明细」找也没找到唯一一张;`
          + `文件里的 sheet:${sheetNames.join('、')}。请把明细 sheet 改名为「${SMG_DETAIL_SHEET}」后重试`
        );
        err.statusCode = 422;
        throw err;
      }
      // ②b 同文件秒拒(2026-07-21 拍板配套:专人上传也会重复传):新文件指纹 ==
      //    当前生效版本(最新 status='done' 的总账 job)→ 直接拒,不跑数分钟解析、不动数据。
      //    只比当前生效版:被 replaced 的历史版本同指纹不拦——那是"传更旧文件"场景,
      //    由 ⑤b 出账日期旧版警告负责提示。
      const sha256 = await hashFileStream(opts.filePath);
      const activeJob = importJobRepo
        .listByWorkspace({ workspaceKey: opts.workspaceKey, jobType, limit: 50 })
        .find((j) => j.status === 'done');
      if (activeJob && activeJob.sha256 && activeJob.sha256 === sha256) {
        const err = new Error(
          `这份文件和当前生效的总账完全相同(${activeJob.sourceFile},`
          + `${String(activeJob.finishedAt || activeJob.startedAt || '').slice(0, 16).replace('T', ' ')} 由 ${activeJob.operator || '?'} 导入),无需重复导入`
        );
        err.statusCode = 409;
        throw err;
      }
      // ⑤b 前置:记旧版出账日期上限(替换前最后一刻),导入完成后比对新版防"旧版覆盖新版"
      const prevMaxStatementDate = storeBillRepo.maxStatementDateByJobType
        ? storeBillRepo.maxStatementDateByJobType({ workspaceKey: opts.workspaceKey, jobType })
        : null;
      // ③ 替换语义:清本工作区旧总账行,旧 job 标 replaced(留审计)。
      //    注意此后到 ④ 完成之间若失败,旧数据已清 → job 记 failed,重新导入即恢复。
      const replacedRows = storeBillRepo.deleteByJobType({ workspaceKey: opts.workspaceKey, jobType });
      importJobRepo.markJobTypeReplaced({ workspaceKey: opts.workspaceKey, jobType });
      // ④ 流式导入(28万行不进内存;非目标 sheet 廉价排空)。
      //    ②b 已算过整文件 sha256,透传进去免得 runImport 再全量读一遍 98MB(复核 MEDIUM)
      const job = await runImport({
        ...opts,
        jobType,
        mapRow: (ctx) => mapSmgLedgerRow(ctx),
        persistBatch: (rows) => storeBillRepo.insertMany(rows),
        sheetFilter: (name) => String(name).trim() === detailSheet,
        importJobRepo,
        precomputedSha256: sha256,
      });
      // ⑤ 完整性守卫:流式结果里必须出现预检定位到的明细 sheet(skipped 的不算)
      const seen = (job.details?.sheets || [])
        .some((s) => String(s.name || '').trim() === detailSheet && !s.skipped);
      if (!seen) {
        const msg = `流式解析没读到「${detailSheet}」sheet(疑似 exceljs 静默丢 sheet);`
          + '旧总账行已清除,请立即重新导入一次';
        importJobRepo.finalize({
          id: job.id, status: 'failed',
          rowsTotal: job.rowsTotal, rowsInserted: job.rowsInserted, rowsSkipped: job.rowsSkipped,
          finishedAt: new Date().toISOString(), errorMessage: msg, details: job.details,
        });
        const err = new Error(msg);
        err.statusCode = 422;
        throw err;
      }
      // ⑤b 旧版守卫:新版出账日期上限 < 旧版 → 大概率传了旧文件(数据已替换成旧版,
      //    替换语义下用最新文件重导一次即可恢复)。不拦在删除前是因为拿新文件的日期上限
      //    必须整本流式扫一遍(再花数分钟),不值;显性警告 + 重导自愈是当前取舍。
      let staleWarning = null;
      const newMaxStatementDate = storeBillRepo.maxStatementDateByJobType
        ? storeBillRepo.maxStatementDateByJobType({ workspaceKey: opts.workspaceKey, jobType })
        : null;
      if (prevMaxStatementDate && newMaxStatementDate && newMaxStatementDate < prevMaxStatementDate) {
        staleWarning = `本次导入的出账日期上限 ${newMaxStatementDate} 早于上一版 ${prevMaxStatementDate},`
          + '疑似传了旧版总账,未收清单已回退到旧数据;请立即用最新总账重新导入一次覆盖';
      }
      // 把替换行数/旧版警告写进 job.details,前端完成提示要用(异步路径只拿得到 job 记录)
      const finalJob = importJobRepo.finalize({
        id: job.id, status: 'done',
        rowsTotal: job.rowsTotal, rowsInserted: job.rowsInserted, rowsSkipped: job.rowsSkipped,
        finishedAt: job.finishedAt,
        details: { ...(job.details || {}), replacedRows, ...(staleWarning ? { staleWarning } : {}) },
      });
      return { ...finalJob, replacedRows, staleWarning };
  }
}

async function runImport({
  workspaceKey,
  filePath,
  sourceFileName = null,
  operator,
  importJobRepo,
  jobType,
  mapRow,
  persistBatch,
  sheetFilter,
  detectHeader = null,          // 表头不在首行时的探测器(收票工作簿灾备导入用);null=首行即表头
  splitByPurchaseDate = null,   // G8b(A1=γ): { workspaceService } 启用按月拆 + auto-create
  bucketFolder: requestedBucketFolder = null,
  onJobCreated = null,          // 异步导入:job 建好后立刻回调(路由据此先响应 jobId,再后台处理)
  precomputedSha256 = null,     // 调用方已算过整文件哈希(smg 秒拒守卫)→ 不再重读一遍大文件
}) {
  if (!workspaceKey || !filePath) {
    throw new Error('workspaceKey and filePath required');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  // 流式哈希:不把整个导入文件(大账单可达数百 MB)读进内存;调用方已算过就直接复用
  const sha256 = precomputedSha256 || await hashFileStream(filePath);
  const displaySourceFile = sourceFileName || path.basename(filePath);
  const startedAt = new Date().toISOString();
  const explicitBucketFolder = normalizeStoreBillBucketFolder(requestedBucketFolder);
  const bucketFolder = jobType === 'store_bill'
    ? (explicitBucketFolder || classifyBillFolder({ sourceFile: displaySourceFile }))
    : null;
  const jobId = importJobRepo.create({
    workspaceKey,
    jobType,
    sourceFile: displaySourceFile,
    fileSize: stats.size,
    sha256,
    operator,
    startedAt,
    bucketFolder,
  });
  // 异步导入:job 一建好就回调,路由可立刻把 jobId 返回给前端轮询,不占着 HTTP 连接跑完整导入。
  if (typeof onJobCreated === 'function') {
    try { onJobCreated(jobId); } catch { /* best effort */ }
  }

  let rowsTotal = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;
  // G8b(A1=γ): bucket by target workspaceKey;不拆分模式下只用一个 bucket (=workspaceKey)
  const buckets = new Map();   // { wsKey -> Array<row> }
  const splitSummary = new Map(); // { wsKey -> { inserted, skipped, rows } }
  const ensuredWorkspaces = new Set([workspaceKey]); // 已确认存在的 ws (含传入的)

  function targetWorkspace(row) {
    if (!splitByPurchaseDate) return workspaceKey;
    // 行级 purchase_date → target ws (保留 demo- 前缀);purchase_date 无则回原 ws
    const purchase = row?.purchaseDate || row?.purchase_date || null;
    if (!purchase) return workspaceKey;
    try {
      const resolved = resolveOptionalWorkspaceForPurchaseDate({
        purchaseDate: purchase,
        currentWorkspaceKey: workspaceKey,
      });
      return resolved.hasPurchaseDate ? resolved.workspaceKey : workspaceKey;
    } catch {
      // purchase_date 越 ±6 月 → fallback 原 ws,该行交给 second_pass / 补救
      return workspaceKey;
    }
  }

  function ensureWorkspace(wsKey) {
    if (ensuredWorkspaces.has(wsKey) || !splitByPurchaseDate) return;
    const svc = splitByPurchaseDate.workspaceService;
    try { svc.getOrThrow(wsKey); }
    catch {
      // 不存在 → 自动 open (auto-create);开月失败会抛
      svc.open({ workspaceKey: wsKey, operator: operator || null });
    }
    ensuredWorkspaces.add(wsKey);
  }

  function flushBucket(wsKey) {
    const rows = buckets.get(wsKey);
    if (!rows || !rows.length) return;
    ensureWorkspace(wsKey);
    // 重写 row.workspaceKey 以与 target 一致 (mapper 默认填入原 workspaceKey)
    const stamped = rows.map((r) => ({ ...r, workspaceKey: wsKey }));
    const result = persistBatch(stamped);
    rowsInserted += result.inserted;
    rowsSkipped += result.skipped;
    const sum = splitSummary.get(wsKey) || { inserted: 0, skipped: 0, rows: 0 };
    sum.inserted += result.inserted;
    sum.skipped  += result.skipped;
    sum.rows     += rows.length;
    splitSummary.set(wsKey, sum);
    buckets.set(wsKey, []);
  }

  function flushAll() {
    for (const wsKey of buckets.keys()) flushBucket(wsKey);
  }

  try {
    const importedAt = new Date().toISOString();
    const sheetSummary = await streamRows(
      filePath,
      ({ sheetName, rowNumber, asObject, values, headers }) => {
        rowsTotal += 1;
        const mapped = mapRow({
          asObject,
          rawValues: values,
          headers,
          workspaceKey,
          sheetName,
          sourceFile: displaySourceFile,
          sourceRow: rowNumber,
          importedAt,
          importJobId: jobId,
        });
        if (!mapped) {
          rowsSkipped += 1;
          return;
        }
        const owned = stampImportedRowOwner(mapped, { jobType, operator });
        const wsKey = targetWorkspace(owned);
        if (!buckets.has(wsKey)) buckets.set(wsKey, []);
        buckets.get(wsKey).push(owned);
        // 单 bucket 达到 batch 阈值就刷该 bucket;其他 bucket 待
        if (buckets.get(wsKey).length >= BATCH_FLUSH) flushBucket(wsKey);
      },
      { sheetFilter, detectHeader }
    );
    flushAll();

    const finishedAt = new Date().toISOString();
    const details = { sheets: sheetSummary.sheets };
    // ⭐0729:源文件被 Excel 行数上限截断的告警。生产实测有一次 smg_ledger 读到
    // 1 048 574 行,而 xlsx 单表上限是 1 048 576 —— 这张表是被塞满的,几乎可以肯定
    // 源文件在给到我们之前就已经被 Excel 切掉了尾巴。这种丢失发生在我们系统之外,
    // 我们唯一能做的就是**认出来并说出去**,否则没人会知道账少了一截。
    const truncated = (sheetSummary.sheets || []).filter((s) => s.atExcelRowLimit).map((s) => s.name);
    if (truncated.length) details.truncatedAtExcelLimit = truncated;
    // 流式漏 sheet 被守卫救回的痕迹也一并落库(供日后审计"这次导入是否完整")
    if (sheetSummary.recoveredFromStreamSheetLoss) {
      details.recoveredFromStreamSheetLoss = sheetSummary.recoveredFromStreamSheetLoss;
    }
    if (splitByPurchaseDate && splitSummary.size > 0) {
      // 只要有行被按购买月分流到「非当前工作区」就记录(含全部归到单个别月的情况),
      // 否则 UI 会出现「有导入文件、本工作区却 0 明细」的静默错配。
      const routedAway = [...splitSummary.keys()].some((k) => k !== workspaceKey);
      if (routedAway) {
        details.splitByWorkspace = Object.fromEntries(splitSummary);
        details.rowsInActiveWorkspace = splitSummary.get(workspaceKey)?.inserted || 0;
      }
    }
    return importJobRepo.finalize({
      id: jobId,
      status: 'done',
      rowsTotal,
      rowsInserted,
      rowsSkipped,
      finishedAt,
      details,
    });
  } catch (error) {
    // flushAll 落库失败(磁盘满/约束错)时不能连累 finalize:job 卡 running 会让
    // importSmgLedger 的 2 小时 DB 守卫 409 挡住重导,而此刻旧总账行已被替换语义清掉,
    // 恰恰是最需要立即重导的时刻。失败只记日志,保证 finalize('failed') 必达。
    try {
      flushAll();
    } catch (flushError) {
      console.error(`[import_service] flushAll failed on error path (job ${jobId}):`, flushError?.message || flushError);
    }
    importJobRepo.finalize({
      id: jobId,
      status: 'failed',
      rowsTotal,
      rowsInserted,
      rowsSkipped,
      finishedAt: new Date().toISOString(),
      errorMessage: error?.message || String(error),
    });
    throw error;
  }
}

function stampImportedRowOwner(row, { jobType, operator } = {}) {
  if (!row || jobType !== 'daily_receipt') return row;
  return {
    ...row,
    modifiedBy: row.modifiedBy || operator || null,
  };
}

function normalizeStoreBillBucketFolder(value) {
  const folder = String(value || '').trim();
  if (!folder) return null;
  if (isModeFolder(folder)) return folder;
  throw new Error(`invalid bucketFolder: ${folder}`);
}

module.exports = {
  createImportService,
};
