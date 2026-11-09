'use strict';

/**
 * Export surface — trigger xlsx generation + list + download.
 *
 * Export itself is treated as a stage (lock-protected when stageJobRepo
 * is wired). The secondary endpoints are pure filesystem reads against
 * `exportRoot/<workspaceKey>/` with a `path.basename`-then-prefix-check
 * guard against directory traversal.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

const { runStageWithLock } = require('../../lib/monthly_pipeline/stage_lock');
const { createSemaphore } = require('../../lib/simple_semaphore');

// 资料库 xlsx 导出闸(2026-07-08):buildWorkbook 是**进程内** exceljs 构建(主线程 CPU,
// 非子进程——与客户文件夹 zip 用系统 zip/python3 子进程压缩不同),大工作区可上千行。
// 不限并发的话 20-30 人同点会一起在主线程压 xlsx → 拖慢全站(与今天主线程瓶颈同类风险)。
// 单个 xlsx 比重型 zip 轻,故并发放宽到 4(zip 闸=2),队列满 429 让操作员错峰重试。
const xlsxExportGate = createSemaphore({
  // 4→2(2026-07-27):客户数据 Excel 加了「汇总」首页后单次内存翻倍(实测 3 万行 730MB heap /
  // 1278MB RSS)。生产堆上限 3072MB(2c4g 配置只有 1536),4 并发月度导出 ≈2.9GB 会顶穿。
  // 闸有排队,降并发只是把它们串起来跑,不会丢请求。
  maxConcurrent: Number(process.env.XLSX_EXPORT_MAX_CONCURRENCY) || 2,
  maxQueue: Number(process.env.XLSX_EXPORT_MAX_QUEUE) || 20,
  busyMessage: '资料库 Excel 导出排队已满,请稍后再点',
});
const {
  workspaceKeyFromReq, handleStageError, resolveExportDir, createStagePreconditionError,
} = require('./route_utils');

function registerExportRoutes({ app, guards, deps }) {
  const { read, fieldReview, finalReview } = guards;
  const {
    monthlyExportService,
    finalDeliveryExportService,
    receivedReceiptExportService,
    libraryModeExportService,
    workspaceService,
    stageJobRepo,
    pipelineLockService,
    stageLogService,
    monthlyDataRepo,
    exportRoot,
  } = deps;

  if (!monthlyExportService) return;

  if (finalDeliveryExportService) {
    app.get(
      '/api/monthly/workspaces/:workspaceKey/exports/final-delivery/readiness',
      ...read,
      (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          res.json(finalDeliveryExportService.checkReadiness({ workspaceKey }));
        } catch (error) {
          handleStageError(res, error, 'final delivery readiness failed');
        }
      }
    );

    app.post(
      '/api/monthly/workspaces/:workspaceKey/exports/final-delivery',
      ...finalReview,
      async (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const outputDir = resolveExportDir({ exportRoot, workspaceKey });
          const operator = req.user?.username || 'final_delivery_export_api';
          const runExport = () => finalDeliveryExportService.run({ workspaceKey, outputDir, operator });
          const result = stageJobRepo
            ? (await runStageWithLock({
                stageJobRepo,
                pipelineLockService,
                workspaceKey,
                stage: 'final_delivery_export',
                operator,
                idempotencyKey: extractIdempotencyKey(req),
                run: runExport,
                afterSuccess: ({ job, result }) => attachGenericExportLog({
                  stageLogService,
                  workspaceKey,
                  stage: 'final_delivery_export',
                  operator,
                  job,
                  result,
                }),
              })).result
            : await runExport();
          const packageTypes = normalizeFinalDeliveryPackageTypes(req.body?.packageTypes);
          const archive = await createFinalDeliveryArchive({
            workspaceKey,
            exportDir: outputDir,
            result,
            packageTypes,
          });
          res.json({
            workspaceKey,
            outputDir: result.outputDir,
            producedAt: result.producedAt,
            readiness: result.readiness,
            // 结果计数(前端交付页只展示计数,不列 3000 个文件)。
            // 注意:四桶里 0 行的桶不生成文件,所以 finalDataFileCount 是动态值(0~4),不要写死 4。
            counts: {
              finalDataFileCount: result.files.filter((f) => f.kind === 'final_data').length,
              customerFolderCount: result.dataPackages.length,
              // 每个客户文件夹内含一份收据单(按客户计,口径=客户数)
              receiptCount: result.dataPackages.length,
              customerPdfCount: result.customerPdfs.length,
            },
            // 0729 静默排查 A1:这七类情况(缺图/缺字体/账单空壳/整份表没生成…)原本只写进
            // 包内 JSON,响应里一个字都没有 → 操作员看到的是一个干净的成功页,交付出去才发现缺东西。
            // 按类型聚合回传(不回明细,避免把几千个客户名塞进响应);完整名单在包里的
            // 交付说明.txt 与 交付清单.json。前端据此决定要不要提醒"这次导出有情况"。
            warnings: Object.entries(
              (result.warnings || []).reduce((acc, w) => {
                const key = String(w?.type || 'unknown');
                acc[key] = (acc[key] || 0) + 1;
                return acc;
              }, {}),
            ).map(([type, count]) => ({ type, count })),
            archive: {
              packageTypes,
              filename: archive.filename,
              size: archive.size,
              downloadPath: `/api/monthly/workspaces/${encodeURIComponent(workspaceKey)}/exports/files/${encodeURIComponent(archive.filename)}`,
            },
            files: result.files.map((f) => ({
              kind: f.kind,
              folder: f.folder || null,
              rows: f.rows || 0,
              filename: path.basename(f.path),
              downloadPath: `/api/monthly/workspaces/${encodeURIComponent(workspaceKey)}/exports/files/${encodeURIComponent(path.basename(f.path))}`,
            })),
            customerPdfs: result.customerPdfs.map((f) => ({
              kind: f.kind,
              folder: f.folder || null,
              rows: f.rows || 0,
              filename: path.basename(f.path),
            })),
          });
        } catch (error) {
          handleStageError(res, error, 'final delivery export failed');
        }
      }
    );
  }

  // 生成"收票汇总.xlsx"（按员工分 sheet）
  if (receivedReceiptExportService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/exports/received-receipt',
      ...fieldReview,
      async (req, res) => {
        try {
          const workspaceKey = workspaceKeyFromReq(req);
          workspaceService.getOrThrow(workspaceKey);
          const outputDir = resolveExportDir({ exportRoot, workspaceKey });
          const operator = req.user?.username || 'received_receipt_export_api';
          const runExport = () => receivedReceiptExportService.run({ workspaceKey, outputDir, operator });
          const result = stageJobRepo
            ? (await runStageWithLock({
                stageJobRepo,
                pipelineLockService,
                workspaceKey,
                stage: 'received_receipt_export',
                operator,
                idempotencyKey: extractIdempotencyKey(req),
                run: runExport,
                afterSuccess: ({ job, result }) => attachGenericExportLog({
                  stageLogService,
                  workspaceKey,
                  stage: 'received_receipt_export',
                  operator,
                  job,
                  result,
                }),
              })).result
            : await runExport();
          const filename = path.basename(result.outputPath);
          res.json({
            ...result,
            filename,
            downloadPath: `/api/monthly/workspaces/${encodeURIComponent(workspaceKey)}/exports/files/${encodeURIComponent(filename)}`,
          });
        } catch (error) {
          handleStageError(res, error, 'received-receipt export failed');
        }
      }
    );
  }

  // 资料库「按团号匹配模式分类 + 导出客户数据 + 需重拍回收」——只读。
  // 已结算客户源 daily_receipt_export(可按 workspaceKey / batchId 筛);重拍客户源审核批次。
  if (libraryModeExportService) {
    // owner 隔离:每个查询都带上当前用户,service 据此只放行"自己拥有批次"的数据(admin/finance 看全部)。
    // batchIds(2026-07-28 跨批多选导出):逗号分隔,≤50 防滥用;有它时优先于单 batchId。
    const filterFromReq = (req) => ({
      workspaceKey: String(req.query?.workspaceKey || '').trim(),
      batchId: String(req.query?.batchId || '').trim(),
      batchIds: String(req.query?.batchIds || '')
        .split(',').map((b) => b.trim()).filter(Boolean).slice(0, 50),
      operatorUser: req.user || null,
    });
    app.get('/api/monthly/library-export/workspaces', ...read, (req, res) => {
      try {
        res.json({ workspaces: libraryModeExportService.listWorkspaces(req.user || null) });
      } catch (error) {
        handleStageError(res, error, 'library-export workspaces failed');
      }
    });
    app.get('/api/monthly/library-export/batches', ...read, (req, res) => {
      try {
        res.json({ batches: libraryModeExportService.listBatches(req.user || null) });
      } catch (error) {
        handleStageError(res, error, 'library-export batches failed');
      }
    });
    app.get('/api/monthly/library-export/customers', ...read, (req, res) => {
      try {
        res.json({ ...filterFromReq(req), customers: libraryModeExportService.listCustomers(filterFromReq(req)) });
      } catch (error) {
        handleStageError(res, error, 'library-export customers failed');
      }
    });
    // 导出前真实预检(0727反馈#15):台账行按交付合同核票号形态/购买日期,疑似审核失误
    // 带批次+客户定位返回;只读不拦导出(预检是眼睛不是闸)。
    app.get('/api/monthly/library-export/precheck', ...read, (req, res) => {
      try {
        res.json({ ...filterFromReq(req), ...libraryModeExportService.listFormatIssues(filterFromReq(req)) });
      } catch (error) {
        handleStageError(res, error, 'library-export precheck failed');
      }
    });
    // 首屏聚合(2026-07-16 P0):workspaces+batches(带已结算徽章)+summary+customers 一次拿全,
    // 重拍扫描单遍复用(修 summary/customers 各扫一遍全部批次 JSON 的双跑)。老端点保留兼容。
    app.get('/api/monthly/library-export/overview', ...read, (req, res) => {
      try {
        const filter = filterFromReq(req);
        // lite=1(复核H2):首屏引导只拿 workspaces+批次徽章,跳过重拍全扫(admin 无筛选时=全系统)
        const lite = String(req.query?.lite || '') === '1';
        res.json({ ...filter, ...libraryModeExportService.listOverview({ ...filter, lite }) });
      } catch (error) {
        handleStageError(res, error, 'library-export overview failed');
      }
    });
    app.get('/api/monthly/library-export/summary', ...read, (req, res) => {
      try {
        const filter = filterFromReq(req);
        res.json({
          ...filter,
          modes: libraryModeExportService.listModeSummary(filter),
          rephotoCount: libraryModeExportService.listRephotoGroups(filter).length,
        });
      } catch (error) {
        handleStageError(res, error, 'library-export summary failed');
      }
    });
    app.get('/api/monthly/library-export/download', ...read, async (req, res) => {
      const filter = filterFromReq(req);
      // 必须带范围(2026-07-27 部署前审计):不带 workspaceKey/batchId = 跨全部月份全表导出,
      // listRows 无 LIMIT、buildWorkbook 全量进内存。加了「汇总」首页后单次内存翻倍
      // (实测 3 万行 heap 377MB→730MB / RSS 549MB→1278MB),全表导出能直接顶穿堆。
      // 前端两个入口本来就都带范围(批次 or 工作区),全表导出也没有业务含义。
      // ⚠️ 校验必须在占坑之前 —— 放进 try 里提前 return 会和 finally 的 release 撞成双释放。
      if (!filter.workspaceKey && !filter.batchId) {
        return res.status(400).json({ error: '请指定导出范围(工作区或批次)', code: 'scope_required' });
      }
      // 占坑失败(并发+队列都满)直接 429,避免多个 exceljs 构建一起压主线程。
      try {
        await xlsxExportGate.acquire();
      } catch (busyErr) {
        return res.status(429).json({ error: busyErr.message, code: busyErr.code });
      }
      try {
        const workbook = libraryModeExportService.buildWorkbook(filter);
        const scope = filter.batchId ? `批次${filter.batchId.slice(-8)}` : (filter.workspaceKey || '全部');
        const fname = encodeURIComponent(`客户数据_按模式_${scope}.xlsx`);
        res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('content-disposition', `attachment; filename*=UTF-8''${fname}`);
        await workbook.xlsx.write(res); // 占坑到写完再放行(主线程 CPU/内存压力都在这期间)
        res.end();
      } catch (error) {
        handleStageError(res, error, 'library-export download failed');
      } finally {
        xlsxExportGate.release();
      }
    });
  }

  app.post(
    '/api/monthly/workspaces/:workspaceKey/exports/monthly-data',
    ...finalReview,
    async (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        workspaceService.getOrThrow(workspaceKey);
        if (Number(monthlyDataRepo?.countByWorkspace?.(workspaceKey) || 0) <= 0) {
          throw createStagePreconditionError('先完成合并月度数据，再导出交付包');
        }
        const outputDir = resolveExportDir({ exportRoot, workspaceKey });
        const operator = req.user?.username || 'export_api';
        const runExport = () => monthlyExportService.run({ workspaceKey, outputDir, operator });
        const result = stageJobRepo
          ? (await runStageWithLock({
              stageJobRepo,
              pipelineLockService,
              workspaceKey,
              stage: 'export',
              operator,
              idempotencyKey: extractIdempotencyKey(req),
              run: runExport,
              afterSuccess: ({ job, result }) => attachGenericExportLog({
                stageLogService,
                workspaceKey,
                stage: 'export',
                operator,
                job,
                result,
              }),
            })).result
          : await runExport();
        const files = result.files.map((f) => ({
          kind: f.kind,
          folder: f.folder || null,
          rows: f.rows,
          filename: path.basename(f.path),
          downloadPath: exportRoot
            ? `/api/monthly/workspaces/${encodeURIComponent(workspaceKey)}/exports/files/${encodeURIComponent(path.basename(f.path))}`
            : null,
        }));
        res.json({
          workspaceKey,
          outputDir,
          producedAt: result.producedAt,
          files,
          customerEvidence: result.customerEvidence || null,
        });
      } catch (error) {
        handleStageError(res, error, 'export failed');
      }
    }
  );

  app.get(
    '/api/monthly/workspaces/:workspaceKey/exports/files',
    ...read,
    (req, res) => {
      const { limit, offset } = parsePagination(req.query);
      if (!exportRoot) return res.json({ files: [], total: 0, limit, offset, hasMore: false });
      const workspaceKey = workspaceKeyFromReq(req);
      const dir = resolveExportDir({ exportRoot, workspaceKey });
      if (!fs.existsSync(dir)) return res.json({ files: [], total: 0, limit, offset, hasMore: false });
      const allFiles = listExportFilesRecursive(dir)
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          // batch = 顶层目录段(最终交付包子目录 / 「(单项导出)」根目录),供 UI 按批次分组,
          // 避免历史单项导出(如旧的收票汇总)和本次交付包混在一起分不清。
          const segs = f.split(path.sep);
          const batch = segs.length > 1 ? segs[0] : '(单项导出)';
          return {
            filename: f,
            displayName: path.basename(f),
            batch,
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
            modifiedMs: st.mtimeMs,
            downloadPath: `/api/monthly/workspaces/${encodeURIComponent(workspaceKey)}/exports/files/${encodeURIComponent(f)}`,
          };
        })
        // 最新的在前,运营一眼看到本次导出
        .sort((a, b) => b.modifiedMs - a.modifiedMs);
      // 最近一次导出时间 + 该时间附近(±5 分钟)的文件视为「本次批次」,UI 可高亮
      const latestMs = allFiles.length ? allFiles[0].modifiedMs : 0;
      const WINDOW_MS = 5 * 60 * 1000;
      for (const f of allFiles) {
        f.isLatestBatch = latestMs > 0 && latestMs - f.modifiedMs <= WINDOW_MS;
        delete f.modifiedMs;
      }
      const total = allFiles.length;
      const files = allFiles.slice(offset, offset + limit);
      res.json({
        files,
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
        latestExportAt: latestMs ? new Date(latestMs).toISOString() : null,
      });
    }
  );

  app.get(
    '/api/monthly/workspaces/:workspaceKey/exports/files/:filename',
    ...read,
    (req, res) => {
      if (!exportRoot) return res.status(404).json({ error: 'export root not configured' });
      const workspaceKey = workspaceKeyFromReq(req);
      const filename = normalizeRelativeExportPath(req.params.filename || '');
      if (!filename || !isDownloadableExportFile(filename)) {
        return res.status(400).json({ error: 'invalid filename' });
      }
      const dir = resolveExportDir({ exportRoot, workspaceKey });
      const resolvedDir = path.resolve(dir);
      const fp = path.resolve(resolvedDir, filename);
      // 路径边界用 resolve 后比较(字符串 startsWith 会被同前缀的兄弟目录绕过)
      if ((fp !== resolvedDir && !fp.startsWith(`${resolvedDir}${path.sep}`)) || !fs.existsSync(fp)) {
        return res.status(404).json({ error: 'file not found' });
      }
      res.download(fp, filename);
    }
  );
}

function isDownloadableExportFile(filename) {
  return /\.(xlsx|pdf|json|zip)$/i.test(String(filename || ''));
}

function parsePagination(query = {}) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
  return { limit, offset };
}

function listExportFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      for (const child of listExportFilesRecursive(full)) {
        out.push(path.join(name, child));
      }
    } else if (entry.isFile() && isDownloadableExportFile(name)) {
      out.push(name);
    }
  }
  return out.sort();
}

function normalizeRelativeExportPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || raw.includes('..')) return '';
  return raw.split('/').filter(Boolean).join(path.sep);
}

function extractIdempotencyKey(req) {
  // Export buttons can pass idempotencyKey so a repeated click returns
  // the existing stage_job instead of starting another export.
  const value = req.body?.idempotencyKey ?? req.query?.idempotencyKey;
  const text = String(value || '').trim();
  return text || null;
}

function attachGenericExportLog({ stageLogService, workspaceKey, stage, operator, job, result }) {
  if (!stageLogService || result?.logFile) return result;
  const meta = stageLogService.writeStageSummary({
    workspaceKey,
    stage,
    stageJobId: job?.id || null,
    startedAt: job?.startedAt || null,
    operator,
    result,
  });
  return { ...result, logFile: meta.logFile };
}

function normalizeFinalDeliveryPackageTypes(value) {
  const raw = Array.isArray(value) ? value : [];
  const allowed = new Set(['customer', 'data']);
  const out = raw.map((item) => String(item || '').trim()).filter((item) => allowed.has(item));
  return out.length ? [...new Set(out)] : ['customer', 'data'];
}

async function createFinalDeliveryArchive({ workspaceKey, exportDir, result, packageTypes }) {
  const packageDir = path.resolve(result.outputDir);
  const sourceRoot = path.resolve(exportDir);
  const selected = collectFinalDeliveryArchiveEntries({ result, packageDir, packageTypes });
  if (!selected.length) {
    const error = new Error('no files available for selected delivery package');
    error.code = 'FINAL_DELIVERY_ARCHIVE_EMPTY';
    throw error;
  }

  fs.mkdirSync(sourceRoot, { recursive: true });
  const filename = buildFinalDeliveryArchiveFilename({ workspaceKey, packageTypes, producedAt: result.producedAt });
  const archivePath = path.join(sourceRoot, filename);
  if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true });

  const entries = selected
    .map((entry) => normalizeArchiveEntry({ sourceRoot, entry }))
    .filter(Boolean);
  await writeZipArchive({ sourceRoot, archivePath, entries });
  return {
    path: archivePath,
    filename,
    size: fs.statSync(archivePath).size,
  };
}

function collectFinalDeliveryArchiveEntries({ result, packageDir, packageTypes }) {
  const out = new Map();
  const add = (targetPath) => {
    if (!targetPath) return;
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) return;
    out.set(resolved, resolved);
  };
  const addTopLevel = (targetPath) => {
    const top = topLevelDeliveryPath({ packageDir, targetPath });
    add(top || targetPath);
  };

  if (packageTypes.includes('data')) {
    for (const file of result.files || []) addTopLevel(file.path);
  }
  if (packageTypes.includes('customer')) {
    for (const file of result.customerPdfs || []) addTopLevel(file.path);
    for (const item of result.dataPackages || []) addTopLevel(item.path);
  }
  // 0729 静默排查 A1:交付说明必须进**每一种**勾选组合。
  // 交付清单.json 属于 files(=data 组),只勾「客户数据包」时整份都不在 zip 里 →
  // 交付出去的客户资料包缺了图/账单是空壳,包内零痕迹,只能等客户回来找。
  // 说明本身很小,任何组合都带上,不存在"塞噪音"的问题(没内容时服务端根本不生成它)。
  if (result.notesPath) add(result.notesPath);
  return [...out.values()];
}

function topLevelDeliveryPath({ packageDir, targetPath }) {
  if (!targetPath) return '';
  const resolved = path.resolve(targetPath);
  const rel = path.relative(packageDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const first = rel.split(path.sep).filter(Boolean)[0];
  return first ? path.join(packageDir, first) : resolved;
}

function normalizeArchiveEntry({ sourceRoot, entry }) {
  const resolved = path.resolve(entry);
  const rel = path.relative(sourceRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.replace(/\\/g, '/');
}

function buildFinalDeliveryArchiveFilename({ workspaceKey, packageTypes, producedAt }) {
  const typeLabel = packageTypes.includes('customer') && packageTypes.includes('data')
    ? '完整交付包'
    : packageTypes.includes('customer')
      ? '客户数据包'
      : '最终交付数据包';
  const stamp = String(producedAt || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[^\dTZ]/g, '')
    .slice(0, 15);
  return `${workspaceKey}_${typeLabel}_${stamp || Date.now()}.zip`;
}

async function writeZipArchive({ sourceRoot, archivePath, entries }) {
  const system = await trySystemZip({ sourceRoot, archivePath, entries });
  if (system.ok) return;
  await writeJsZip({ sourceRoot, archivePath, entries });
}

// 异步跑子进程,exit 0 视为成功(spawn 出错/非 0 都算失败)。不阻塞事件循环。
// 2026-08-01 挪进 lib/run_process:原地这份 stdout **和** stderr 都不读,
// 子进程写满管道就永久阻塞 —— 比另一份拷贝还糟(那份至少读 stderr)。
const { runOk } = require('../../lib/run_process');

async function trySystemZip({ sourceRoot, archivePath, entries }) {
  if (await runOk('zip', ['-r', '-q', archivePath, ...entries], { cwd: sourceRoot })) {
    return { ok: true };
  }
  const commands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const command of commands) {
    if (await runOk(command, ['-m', 'zipfile', '-c', archivePath, ...entries], { cwd: sourceRoot })) {
      return { ok: true };
    }
  }
  return { ok: false };
}

async function writeJsZip({ sourceRoot, archivePath, entries }) {
  const zip = new JSZip();
  for (const entry of entries) {
    await addEntryToJsZip(zip, sourceRoot, entry);
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fsp.writeFile(archivePath, bytes);
}

async function addEntryToJsZip(zip, sourceRoot, relEntry) {
  const full = path.join(sourceRoot, relEntry);
  let st;
  try { st = await fsp.stat(full); } catch { return; }
  if (st.isDirectory()) {
    for (const child of await fsp.readdir(full)) {
      await addEntryToJsZip(zip, sourceRoot, path.join(relEntry, child).replace(/\\/g, '/'));
    }
    return;
  }
  if (!st.isFile()) return;
  zip.file(relEntry.replace(/\\/g, '/'), await fsp.readFile(full));
}

module.exports = { registerExportRoutes };
