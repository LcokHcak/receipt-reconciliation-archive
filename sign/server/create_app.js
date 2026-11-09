const path = require('path')

const cookieParser = require('cookie-parser')
const express = require('express')
const multer = require('multer')

const { authenticateToken, requireRole } = require('../lib/auth/jwt_middleware')

// 版本水位:进程启动时生成,随每个响应下发(X-App-Boot)。部署=进程重启=水位变化,
// 长开的审核台页面据此提示刷新(否则旧 JS 会一直跑到天荒地老)。
const APP_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const { AppError } = require('../lib/errors')
const { createRequestLogger } = require('../lib/request_logger')
const { createHealthRoutes } = require('../lib/health_routes')
const { resolveUploadMaxFileSizeMb } = require('./dependencies')
const { createStoragePreviewHandler } = require('./storage_preview')

function createNoopUpload() {
  return {
    array() {
      return (_req, _res, next) => next()
    },
    single() {
      return (_req, _res, next) => next()
    },
  }
}

function sendErrorResponse(res, status, { error, code, requestId, details }) {
  return res.status(status).json({
    error,
    code,
    requestId,
    ...(details ? { details } : {}),
  })
}

function createWorkbenchApp({
  projectRoot,
  appDir,
  batchesRoot,
  trainExportsRoot = '',
  upload = createNoopUpload(),
  registerWorkbenchRoutes,
  registerCustomerLibraryRoutes,
  registerAuthRoutes = null,
  registerMonthlyRoutes = null,
  workbenchHandlers = {},
  customerLibraryHandlers = {},
  auth = null,
  jsonLimit = '20mb',
  uploadMaxFileSizeMb = resolveUploadMaxFileSizeMb(),
  auditMiddleware = null,
  storageAccessMiddleware = null,
  healthProbes = {},
  healthMeta = {},
  getBatchWriteQueueMetrics = null,
  batchWriteQueueMaxDepth = undefined,
}) {
  if (!projectRoot) {
    throw new Error('projectRoot is required')
  }

  const app = express()

  // Request logging (JSON + reqId) — install first so every downstream
  // log line + every response carries X-Request-Id.
  app.use(createRequestLogger())

  // Security response headers. Hand-rolled (no new runtime dependency per
  // AGENTS.md). Intentionally NO Content-Security-Policy here — the Vue SPA
  // uses inline styles/runtime scripts and a strict CSP would break it; CSP
  // should be added at the reverse proxy once tuned. HSTS is harmless over
  // plain HTTP (browsers ignore it unless the response came over HTTPS).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // 版本水位(2026-07-07):审核台是长开不刷新的 SPA,部署后旧页面永远跑旧 JS
    // (实锤:回弹bug修复上线后操作员仍复现,因页面自昨早未刷新)。每次进程启动生成新
    // BOOT_ID,前端 api 拦截器发现变化即弹"请刷新"横幅。
    res.setHeader('X-App-Boot', APP_BOOT_ID)
    next()
  })

  // Health / readiness endpoints. Must be reachable WITHOUT auth so
  // upstream watchdogs (PM2 / systemd / Caddy) can probe.
  createHealthRoutes({
    probes: healthProbes,
    meta: healthMeta,
    getBatchWriteQueueMetrics,
    batchWriteQueueMaxDepth,
  }).register(app)

  const routeAuth = auth
    ? {
        authenticateToken: authenticateToken({
          secret: auth.jwtSecret,
          userService: auth.userService,
        }),
        requireRole,
      }
    : null

  app.use(express.json({ limit: jsonLimit }))
  app.use(cookieParser())
  // Redirect legacy /app/ root to the Vue SPA so users never land on the old UI.
  app.get(['/app', '/app/'], (_req, res) => {
    res.redirect('/app/dist/')
  })
  app.use('/app', express.static(appDir))
  app.get(/^\/app\/dist(?:\/.*)?$/, (req, res, next) => {
    res.sendFile(path.join(appDir, 'dist', 'index.html'), (error) => {
      if (error) {
        next()
      }
    })
  })
  // Protect /storage route with authentication when auth is enabled
  if (routeAuth) {
    const storageMiddlewares = [routeAuth.authenticateToken]
    if (typeof storageAccessMiddleware === 'function') {
      storageMiddlewares.push(storageAccessMiddleware)
    }
    storageMiddlewares.push(express.static(batchesRoot))
    app.use('/storage', ...storageMiddlewares)
  } else {
    app.use('/storage', express.static(batchesRoot))
  }
  // /storage-preview:缩放缓存出图(0727反馈#11「图片缓冲不出来」——原图直出 5-12MB
  // 在窄线路上半分钟起步)。鉴权与 /storage 完全同链;审核台默认走这里,「查看原图」仍走 /storage。
  const storagePreviewHandler = createStoragePreviewHandler({ batchesRoot })
  if (routeAuth) {
    const previewMiddlewares = [routeAuth.authenticateToken]
    if (typeof storageAccessMiddleware === 'function') {
      previewMiddlewares.push(storageAccessMiddleware)
    }
    previewMiddlewares.push(storagePreviewHandler)
    app.use('/storage-preview', ...previewMiddlewares)
  } else {
    app.use('/storage-preview', storagePreviewHandler)
  }
  if (trainExportsRoot) {
    if (routeAuth) {
      app.use(
        '/train-exports',
        routeAuth.authenticateToken,
        routeAuth.requireRole('admin'),
        express.static(trainExportsRoot)
      )
    } else {
      app.use('/train-exports', express.static(trainExportsRoot))
    }
  }

  if (typeof auditMiddleware === 'function') {
    app.use(auditMiddleware)
  }

  if (auth && typeof registerAuthRoutes === 'function') {
    registerAuthRoutes({
      app,
      userService: auth.userService,
      jwtSecret: auth.jwtSecret,
      cookieSecure: Boolean(auth.cookieSecure),
    })
  }

  if (typeof registerWorkbenchRoutes === 'function') {
    registerWorkbenchRoutes({
      app,
      upload,
      handlers: workbenchHandlers,
      auth: routeAuth,
    })
  }

  if (typeof registerCustomerLibraryRoutes === 'function') {
    registerCustomerLibraryRoutes({
      app,
      upload,
      handlers: customerLibraryHandlers,
      auth: routeAuth,
    })
  }

  if (typeof registerMonthlyRoutes === 'function') {
    registerMonthlyRoutes(app, routeAuth)
  }

  app.get('/', (_req, res) => {
    res.redirect('/app/dist/')
  })
  app.get('/login', (_req, res) => {
    res.redirect('/app/dist/login')
  })

  app.use((error, req, res, next) => {
    if (!error) {
      return next()
    }
    if (res.headersSent) {
      return next(error)
    }

    const fileCountExceeded =
      (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') ||
      error?.code === 'LIMIT_FILE_COUNT'
    if (fileCountExceeded) {
      return sendErrorResponse(res, 400, {
        error: '单次最多导入 3000 个文件，请分批导入。',
        code: 'upload_file_count_exceeded',
        requestId: req.id,
      })
    }

    const fileSizeExceeded =
      (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') ||
      error?.code === 'LIMIT_FILE_SIZE'
    if (fileSizeExceeded) {
      return sendErrorResponse(res, 400, {
        error: `单个文件不能超过 ${uploadMaxFileSizeMb}MB，请压缩或拆分后再导入。`,
        code: 'upload_file_size_exceeded',
        requestId: req.id,
      })
    }

    if (error?.code === 'OFFICE_TEMP_FILE') {
      return sendErrorResponse(res, 400, {
        error: error.message || '请不要上传 Office 临时文件（~$ 开头）。',
        code: 'office_temp_file',
        requestId: req.id,
      })
    }

    if (error instanceof AppError) {
      const { logger } = require('../lib/request_logger')
      logger.warn('app_error', {
        route: req.path,
        method: req.method,
        code: error.code,
        status: error.status,
        error: error.message,
      })
      return sendErrorResponse(res, error.status, {
        error: error.message,
        code: error.code,
        details: error.details,
        requestId: req.id,
      })
    }

    if (String(req.path || '').startsWith('/api/')) {
      const { logger } = require('../lib/request_logger')
      logger.error('api_handler_error', {
        err: error,
        route: req.path,
        method: req.method,
      })
      // #4 系统喊疼:统一 500 出口计数,小时摘要 ops_digest 有疼才喊
      require('../lib/ops_metrics').opsMetrics.inc('api_500', { route: req.path, message: error?.message })
      return sendErrorResponse(res, 500, {
        error: 'Internal error',
        code: 'internal_error',
        requestId: req.id,
      })
    }

    return next(error)
  })

  return app
}

module.exports = {
  createWorkbenchApp,
}
