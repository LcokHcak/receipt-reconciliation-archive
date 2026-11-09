'use strict';

/**
 * Shared utilities for the monthly_routes/* family.
 *
 * Kept tiny on purpose — these are the bits every sub-router needs:
 *   - `workspaceKeyFromReq` — pull and trim the param
 *   - `clampInt` — numeric query param coercion
 *   - `handleStageError` — uniform 409/500 shape for stage failures
 *   - `buildProtect` — derive role guards from optional auth dep
 *   - `resolveExportDir` — namespace exports under workspace key
 *   - `handleImport` — multer file → importService dispatcher
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isModeFolder } = require('../../lib/monthly/mode_folder_constants');
// 单一来源:multipart 文件名解码统一用 workbench_utils 的实现(月度导入 + OCR 上传共用)
const { decodeMultipartFilename } = require('../../lib/workbench_utils');

const ALL_ROLES = [
  'admin',
  'reviewer',
  'finance',
];

function workspaceKeyFromReq(req) {
  return String(req.params.workspaceKey || '').trim();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function handleStageError(res, error, defaultMsg) {
  if (error?.code === 'WORKSPACE_LOCKED') {
    return res.status(423).json({
      error: error.message,
      code: 'WORKSPACE_LOCKED',
    });
  }
  if (error?.code === 'PIPELINE_LOCKED') {
    return res.status(423).json({
      error: 'pipeline_locked',
      code: 'PIPELINE_LOCKED',
      runningStage: error.runningStage || null,
      runningSince: error.runningSince || null,
      runningJobId: error.runningJobId ?? null,
      message: `工作区流水线被 ${error.runningStage || '其他任务'} 占用,请稍后重试`,
    });
  }
  if (error?.code === 'MERGE_BLOCKED') {
    return res.status(400).json({
      error: 'merge_blocked',
      code: 'merge_blocked',
      reason: error.reason || null,
      details: error.details || {},
      message: error.message || defaultMsg,
    });
  }
  if (error?.code === 'FINAL_DELIVERY_BLOCKED') {
    return res.status(400).json({
      error: 'final_delivery_blocked',
      code: 'FINAL_DELIVERY_BLOCKED',
      readiness: error.readiness || null,
      message: error.message || defaultMsg,
    });
  }
  if (error?.code === 'STAGE_ALREADY_RUNNING') {
    return res.status(409).json({
      error: error.message,
      code: 'STAGE_ALREADY_RUNNING',
      running: error.running || null,
    });
  }
  if (error?.code === 'STAGE_PRECONDITION_FAILED') {
    return res.status(409).json({
      error: error.message,
      code: 'STAGE_PRECONDITION_FAILED',
    });
  }
  return res.status(500).json({
    error: error?.message || defaultMsg,
    job: error?.job || null,
  });
}

/**
 * Build the role-guard helpers we hand each sub-router. When `auth` is
 * unwired (tests / dev), guards collapse to no-ops so routes still work.
 */
function buildProtect(auth) {
  const protect = auth?.authenticateToken && auth?.requireRole
    ? (...roles) => [auth.authenticateToken, auth.requireRole(...roles)]
    : () => [];
  return {
    admin: protect('admin'),
    read: protect(...ALL_ROLES),
    intake: protect('admin', 'reviewer'),
    fieldReview: protect('admin', 'reviewer'),
    finalReview: protect('admin', 'finance'),
  };
}

function isWorkspaceLocked(workspace) {
  return workspace?.status === 'locked'
    || Boolean(workspace?.lockedAt || workspace?.locked_at);
}

function createWorkspaceLockedError() {
  const error = new Error('月份已锁定，不能继续写入');
  error.code = 'WORKSPACE_LOCKED';
  error.statusCode = 423;
  return error;
}

function createStagePreconditionError(message) {
  const error = new Error(message || '上一步还没有完成');
  error.code = 'STAGE_PRECONDITION_FAILED';
  error.statusCode = 409;
  return error;
}

function ensureWorkspaceWritable({ workspaceService, workspaceKey }) {
  const workspace = workspaceService.getOrThrow(workspaceKey);
  if (isWorkspaceLocked(workspace)) {
    throw createWorkspaceLockedError();
  }
  return workspace;
}

/**
 * F2: 当某个端点依赖的 service / repo 未注入到 deps 包时,统一返回
 * 503 Service Unavailable(而非让路由不存在导致 404)。客户端可凭
 * `code` 区分是哪个依赖没装好。
 */
function serviceUnavailable(res, serviceName, code = 'service_unavailable', extra = {}) {
  return res.status(503).json({
    error: `${serviceName} not available`,
    code,
    service: serviceName,
    ...extra,
  });
}

function sendRouteError(res, error, fallbackMessage, fallbackStatus = 500) {
  if (error?.code === 'WORKSPACE_LOCKED') {
    return res.status(423).json({
      error: error.message,
      code: 'WORKSPACE_LOCKED',
    });
  }
  return res.status(error?.statusCode || error?.status || fallbackStatus).json({
    error: error?.message || fallbackMessage,
    code: error?.code || undefined,
  });
}

function resolveExportDir({ exportRoot, workspaceKey }) {
  const root = exportRoot || path.join(os.tmpdir(), 'monthly-exports');
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, String(workspaceKey || ''));
  // 防目录穿越:workspaceKey 含 ../ 或路径分隔符逃出导出根 → 返回根下一个不存在的
  // 哨兵目录(existsSync=false → 列表空/下载 404),绝不让其指向导出根之外。
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${path.sep}`)) {
    return path.join(resolvedRoot, '__invalid_workspace__');
  }
  return full;
}

// G8b(A1=γ): 5 种 import 中 store_bill / daily_receipt / received_receipt
// 都开了 splitByPurchaseDate (auto-create target workspace),所以"原始 URL
// workspaceKey 不存在"不再致命 — 自动 open。只对 group_code/missing 仍要先存在。
const AUTO_OPEN_JOB_TYPES = new Set(['store_bill', 'daily_receipt', 'received_receipt']);

function handleImport({ importService, workspaceService, jobType, onImported = null }) {
  return async (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const file = Array.isArray(req.files) ? req.files[0] : req.file;
    if (!file) return res.status(400).json({ error: '请选择一个 xlsx 文件' });

    const tmpPath = file.path || path.join(os.tmpdir(), `${Date.now()}-${file.originalname}`);
    const sourceFileName = normalizeUploadSourceName(file.originalname || tmpPath);
    if (!file.path && file.buffer) {
      fs.writeFileSync(tmpPath, file.buffer);
    }

    try {
      // G8b(A1=γ): split-by-purchase-date 类型,workspace 不存在就 auto-open;
      //           其他类型仍要预先存在 (验证锁状态)。
      if (AUTO_OPEN_JOB_TYPES.has(jobType)) {
        try { ensureWorkspaceWritable({ workspaceService, workspaceKey }); }
        catch (e) {
          if (e?.code === 'WORKSPACE_LOCKED') throw e;
          // 不存在 → 自动 open
          workspaceService.open({ workspaceKey, operator: req.user?.username || null });
        }
      } else {
        ensureWorkspaceWritable({ workspaceService, workspaceKey });
      }

      // 异步导入:job 一建好就 res.json(jobId) 返回,导入在后台跑(不 await,不占 HTTP 连接,
      // 避免大文件 408/aborted)。前端拿 jobId 轮询 /imports/jobs/:id 看进度。
      let responded = false;
      // 导入完成后删临时文件:既包括我们用 file.buffer 落盘的临时文件,
      // 也包括 multer 磁盘 dest 留在 tmp_uploads 的上传临时文件(否则永不清理 → 堆积)。
      // .finally 在 runImport(含流式读 filePath)结束后才触发,删除安全。
      const cleanup = () => {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      };
      invokeImport({
        importService, jobType, workspaceKey,
        filePath: tmpPath,
        sourceFileName,
        bucketFolder: normalizeImportBucketFolder(req.body?.bucketFolder ?? req.body?.bucket_folder, jobType),
        operator: req.user?.username,
        onJobCreated: (jobId) => {
          if (!responded) { responded = true; res.json({ job: { id: jobId, status: 'running' } }); }
        },
      })
        .then((result) => {
          // 导入成功完成后(数据已落库)再标脏,避免在 dispatch 时机就标(会和异步导入抢)
          try { onImported?.({ workspaceKey, jobType, result }); } catch { /* 标记失败不影响导入 */ }
          return result;
        })
        .catch((error) => {
          // job 建好前就失败(如解析/锁)→ 还没响应,回错;已响应则错误已落在 job 记录里。
          if (!responded) { responded = true; sendRouteError(res, error, 'import failed', 400); }
        })
        .finally(cleanup);
    } catch (error) {
      // 前置校验失败(锁/桶非法)→ 导入未启动,删掉刚上传的临时文件
      sendRouteError(res, error, 'import failed', 400);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  };
}

async function invokeImport({ importService, jobType, workspaceKey, filePath, sourceFileName, bucketFolder, operator, onJobCreated = null }) {
  const opts = { workspaceKey, filePath, sourceFileName, bucketFolder, operator, onJobCreated };
  if (jobType === 'group_code') return importService.importGroupCode(opts);
  if (jobType === 'store_bill') return importService.importStoreBill(opts);
  if (jobType === 'missing') return importService.importMissingReceipt(opts);
  if (jobType === 'received_receipt') {
    if (!importService.importReceivedReceipt) throw new Error('received_receipt import not wired');
    return importService.importReceivedReceipt(opts);
  }
  if (jobType === 'daily_receipt') {
    if (!importService.importDailyReceipt) throw new Error('daily_receipt import not wired');
    return importService.importDailyReceipt(opts);
  }
  if (jobType === 'smg_ledger') {
    if (!importService.importSmgLedger) throw new Error('smg_ledger import not wired');
    return importService.importSmgLedger(opts);
  }
  throw new Error(`Unknown jobType: ${jobType}`);
}

function normalizeUploadSourceName(value) {
  return path.basename(decodeMultipartFilename(value).replace(/\\/g, '/'));
}

function normalizeImportBucketFolder(value, jobType) {
  if (jobType !== 'store_bill') return null;
  const folder = String(value || '').trim();
  if (!folder) return null;
  if (isModeFolder(folder)) return folder;
  const error = new Error(`invalid bucketFolder: ${folder}`);
  error.code = 'INVALID_BUCKET_FOLDER';
  error.statusCode = 400;
  throw error;
}

module.exports = {
  ALL_ROLES,
  workspaceKeyFromReq,
  clampInt,
  handleStageError,
  buildProtect,
  createWorkspaceLockedError,
  createStagePreconditionError,
  ensureWorkspaceWritable,
  resolveExportDir,
  handleImport,
  invokeImport,
  decodeMultipartFilename,
  isWorkspaceLocked,
  sendRouteError,
  serviceUnavailable,
};
