require('dotenv').config()

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { ensureDir, nowStamp } = require('./lib/workbench_utils')
const { normalizeReceiptNoDigits } = require('./lib/workbench_field_normalizer')
const { EXCEL_EXTENSIONS } = require('./lib/package_constants')
const { DEFAULT_MAX_SIDE: PADDLE_MAX_SIDE } = require('./lib/paddle_batch_ocr')
const { createPaddlexModelRunner } = require('./lib/paddlex_model_runner')
const { createDocumentRegionDetector } = require('./lib/document_region_detector')
const { createDocumentTypeModel } = require('./lib/document_type_model')
const { createWorkbenchBatchResponseBuilder } = require('./lib/workbench_batch_response')
const {
  createWorkbenchSourceGroupResponseBuilder,
} = require('./lib/workbench_source_group_response')
const { assertBatchAccess } = require('./lib/operator_scope')
const { createModelPipelineOrchestrator } = require('./lib/model_pipeline_orchestrator')
const { createPassportFieldModel } = require('./lib/passport_field_model')
const { createReceiptFieldModel } = require('./lib/receipt_field_model')
const {
  MANUAL_SIGNATURE_SOURCE,
  WEBSITE_SIGNATURE_SOURCE,
  ensureSignatureFields,
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
  syncWebsiteSignatureAfterFieldChange,
} = require('./lib/signature_queue')
const { SignatureSiteWorker } = require('./lib/signature_site_worker')
const {
  clearEditableFieldsForDocTypeSwitch,
  normalizeDocType,
} = require('./lib/workbench_task_flow')
const {
  createImportedImageTask,
  createManualReceiptTaskFromSource,
  createManualTask: createManualTaskFromFactory,
} = require('./lib/workbench_task_factory')
const { approveSourceGroupTasks } = require('./lib/workbench_group_review')
const { recoverCompletedStateAfterManualReview } = require('./lib/workbench_task_recovery')
const { buildTaskWorkflowState } = require('./lib/workbench_workflow_state')
const { createWorkbenchBatchRepository } = require('./repositories/workbench_batch_repository')
const { createCustomerLibraryRepository } = require('./repositories/customer_library_repository')
const { createCustomerTemplateRepository } = require('./repositories/customer_template_repository')
const { createWorkbenchSqliteRepository } = require('./repositories/workbench_sqlite_repository')
const { createAgentWorkspaceRepository } = require('./repositories/agent_workspace_repository')
const { createWorkflowTaskRepository } = require('./repositories/workflow_task_repository')
const { createWorkflowTaskService } = require('./services/workflow_task_service')
const { createWorkflowTaskCoordinator } = require('./services/workflow_task_coordinator')
const { createWorkflowTaskReconciler } = require('./services/workflow_task_reconciler')
const { createAgentWorkspaceService } = require('./services/agent_workspace_service')
const { createAgentUnreceivedService } = require('./services/monthly/agent_unreceived_service')
const { normalizeString: normalizeMatchString } = require('./lib/monthly_pipeline/matching/field_diff')
const { createUnreceivedStateRepository } = require('./repositories/unreceived_state_repository')
const { registerAgentWorkspaceRoutes } = require('./routes/agent_workspace_routes')
const { createCustomerProjectionHooks } = require('./lib/agent_workspace/customer_sync')
const { createWorkbenchScheduler } = require('./jobs/workbench_scheduler')
const { logger: stallLogger } = require('./lib/request_logger') // 停摆看门狗结构化日志(batch_stall_revived 可 grep)
const { createCustomerBatchBridgeService } = require('./services/customer_batch_bridge_service')
const { createTaskResplitService } = require('./services/task_resplit_service')
const {
  createCustomerDocumentPreprocessService,
} = require('./services/customer_document_preprocess_service')
const { createCustomerFinalizeService } = require('./services/customer_finalize_service')
const { createCustomerImagePrepService } = require('./services/customer_image_prep_service')
const { createCustomerImageReviewService } = require('./services/customer_image_review_service')
const { createCustomerIntakeService } = require('./services/customer_intake_service')
const { createCustomerBatchHandlers } = require('./services/customer_batch_handlers')
const { createCustomerLibraryHandlers } = require('./services/customer_library_handlers')
const { createCustomerTemplateFillService } = require('./services/customer_template_fill_service')
const { createBillingExportService } = require('./services/billing_export_service')
const { createWorkbenchBatchImportHandlers } = require('./services/workbench_batch_import_handlers')
const { createWorkbenchApproveSettleService } = require('./services/workbench_approve_settle_service')
const { createDocumentSplitService } = require('./services/document_split_service')
const { createQwenOcrBackend } = require('./lib/qwen_ocr/qwen_ocr_adapter')
const { createQwenDocumentSplitService } = require('./lib/qwen_ocr/qwen_split_service')
const { createWorkbenchExportService } = require('./services/workbench_export_service')
const { createBatchCustomerDataExportService } = require('./services/batch_customer_data_export_service')
const { createHyundaiDeliveryExportService } = require('./services/hyundai_delivery_export_service')
const { createLotteDeptDeliveryExportService } = require('./services/lotte_dept_delivery_export_service')
const { createModeDeliveryExportService } = require('./services/mode_delivery_export_service')
const {
  createWorkbenchGroupApprovalService,
} = require('./services/workbench_group_approval_service')
const { createWorkbenchLedgerBridgeService } = require('./services/workbench_ledger_bridge_service')
const {
  createWorkbenchBatchLedgerImportService,
} = require('./services/workbench_batch_ledger_import_service')
const { createWorkbenchStateService } = require('./services/workbench_state_service')
const { createMyTodoService } = require('./services/my_todo_service')
const { createWorkbenchWriteService } = require('./services/workbench_write_service')
const { createWorkbenchSqliteSyncService } = require('./services/workbench_sqlite_sync_service')
const { pickChangedBatchIds, refreshChangedBatches, createProjectionRefreshScheduler } = require('./lib/agent_workspace/projection_refresh')
const { createWorkbenchSignatureHandlers } = require('./services/workbench_signature_handlers')
const { UserService } = require('./services/user_service')
const { registerAuthRoutes } = require('./routes/auth_routes')
const { registerCustomerLibraryRoutes } = require('./routes/customer_library_routes')
const { registerWorkbenchRoutes } = require('./routes/workbench_routes')
const { createMonthlyRoutes } = require('./routes/monthly_routes')
const { openMonthlyDatabase } = require('./lib/storage/monthly_database')
const { createMonthlyWorkspaceRepository } = require('./repositories/monthly_workspace_repository')
const { createModeDeductConfigRepository } = require('./repositories/monthly/mode_deduct_config_repo')
const { createModeFolderMappingRepository } = require('./repositories/monthly/mode_folder_mapping_repo')
const { createGroupCodeRepository } = require('./repositories/group_code_repository')
const { createStoreBillRepository } = require('./repositories/store_bill_repository')
const { createBrandActivityRepository } = require('./repositories/brand_activity_repository')
const { createMissingReceiptRepository } = require('./repositories/missing_receipt_repository')
const {
  createUnreceivedResolutionRepository,
} = require('./repositories/unreceived_resolution_repository')
const {
  createUnreceivedBackfillService,
} = require('./services/monthly/unreceived_backfill_service')
const {
  createUnreceivedExportService,
} = require('./services/monthly/unreceived_export_service')
const { createErrorRecordRepository } = require('./repositories/error_record_repository')
const { createImportJobRepository } = require('./repositories/import_job_repository')
const { createBatchGroupCodeRepository } = require('./repositories/batch_group_code_repository')
const {
  createDepartureSyncAuditRepository,
} = require('./repositories/departure_sync_audit_repository')
const { createReceivedReceiptRepository } = require('./repositories/received_receipt_repository')
const { createDailyReceiptRepository } = require('./repositories/daily_receipt_repository')
const { createDailyFieldHistoryRepository } = require('./repositories/daily_field_history_repository')
const { createBillMatchLogRepository } = require('./repositories/bill_match_log_repository')
const { createPendingReviewRepository } = require('./repositories/pending_review_repository')
const { createMonthlyDataRepository } = require('./repositories/monthly_data_repository')
const { createMonthlyWorkspaceService } = require('./services/monthly/workspace_service')
const { createModeConfigService } = require('./services/monthly/mode_config_service')
const { createModeFolderApplyService } = require('./services/monthly/mode_folder_apply_service')
const { createBillMatchBucketService } = require('./services/monthly/bill_match_bucket_service')
const { createMonthlyWorkspaceResetService } = require('./services/monthly/workspace_reset_service')
const { createMonthlySeedService } = require('./services/monthly/seed_service')
const { createMonthlyHealthCheckService } = require('./services/monthly/health_check_service')
const {
  createImportService: createMonthlyImportService,
} = require('./services/monthly/import_service')
const { createBatchGroupCodeImportService } = require('./services/batch_group_code_import_service')
const { createGroupCodePrematchService } = require('./services/group_code_prematch_service')
const { createErrorDetectionService } = require('./services/monthly/error_detection_service')
const { createCrossCheckService } = require('./services/monthly/cross_check_service')
const { createTourMatchService } = require('./services/monthly/tour_match_service')
const { createBillMatchService } = require('./services/monthly/bill_match_service')
const { createMergeStreamingService } = require('./services/monthly/merge_streaming_service')
const { createDerivationRecomputeService } = require('./services/monthly/derivation_recompute_service')
const { createSecondPassMissingService } = require('./services/monthly/second_pass_missing_service')
const { createStageRetryService } = require('./services/monthly/stage_retry_service')
const { createPipelineLockService } = require('./services/monthly/pipeline_lock_service')
const { createBatchOperationsService } = require('./services/monthly/batch_operations_service')
const { createImportValidationService } = require('./services/monthly/import_validation_service')
const { createMonthlyExportService } = require('./services/monthly/monthly_export_service')
const { createFinalDeliveryExportService } = require('./services/monthly/final_delivery_export_service')
const { createLibraryModeExportService } = require('./services/monthly/library_mode_export_service')
const {
  createReceivedReceiptExportService,
} = require('./services/monthly/received_receipt_export_service')
const { createMonthlyReconciliationService } = require('./services/monthly/reconciliation_service')
const {
  createPendingReviewResolutionService,
} = require('./services/monthly/pending_review_resolution_service')
const { createDailyWorkspaceMigrationService } = require('./services/monthly/daily_workspace_migration_service')
const { createManualEntryService } = require('./services/monthly/manual_entry_service')
const { createOrphanAggregationService } = require('./services/monthly/orphan_aggregation_service')
const { createBillAggregationViewService } = require('./services/monthly/bill_aggregation_view_service')
const { createCustomerReconciliationService } = require('./services/monthly/customer_reconciliation_service')
const { createBillEnrichmentService } = require('./services/monthly/bill_enrichment_service')
const { createStageLogService } = require('./services/monthly/stage_log_service')
const { createStageJobRepository } = require('./repositories/stage_job_repository')
const { createMatchBadcaseRepository } = require('./repositories/match_badcase_repository')
const { createFeedbackReportRepository } = require('./repositories/feedback_report_repository')
const { createAuditLogRepository } = require('./repositories/audit_log_repository')
const { createModeConfigRepository } = require('./repositories/mode_config_repository')
const { createConfigConsoleRoutes } = require('./routes/config_console_routes')
const { createLibraryDeliveryRoutes } = require('./routes/library_delivery_routes')
const { createClientErrorRoutes } = require('./routes/client_error_routes')
const { opsMetrics } = require('./lib/ops_metrics')
const { createApiErrorMiddleware } = require('./lib/api_error_middleware') // 审计H2:尾部 JSON 错误处理器
const { createModeConfigResolver } = require('./services/mode_config_resolver')
const { setModeRuleResolver, resolveCanonicalModeName } = require('./lib/mode_record_matrix') // A4:scope 归一
const { setReviewConfigResolver } = require('./lib/workbench_task_flow')
const { createReviewConfigResolver } = require('./services/review_config_resolver')
const { createExportPlanExecuteService } = require('./services/export_plan_execute_service')
const { createBackup } = require('./scripts/backup_sqlite')
const { createAdminRoutes } = require('./routes/admin_routes')
const { createTrainingRoutes } = require('./routes/training_routes')
const { createAdminUserRoutes } = require('./routes/admin_user_routes')
const { createFeedbackRoutes } = require('./routes/feedback_routes')
const { createStageProgressRoutes } = require('./routes/stage_progress_routes')
const { createAuditRoutes } = require('./routes/audit_routes')
const { createWorkbenchOverviewRoutes } = require('./routes/workbench_overview_routes')
const { createWorkbenchOverviewService } = require('./services/workbench_overview_service')
const { createAuditMiddleware } = require('./lib/audit_middleware')
const { createShutdownCoordinator } = require('./lib/graceful_shutdown')
const { acquireSingleInstanceLock } = require('./lib/single_instance_guard')
const { destroyPythonPool } = require('./lib/python_process_pool')
const { createWorkbenchApp } = require('./server/create_app')
const { createWorkbenchDependencies } = require('./server/dependencies')
const {
  buildBatchSkeleton,
  buildRecognitionProgressSnapshot,
  createWorkbenchArtifactHelpers,
  createWorkbenchNormalizers,
  didEditableWorkflowChange,
  hasAutoConfirmedDocType,
  markClassificationConfirmed,
  normalizeFieldValue,
  removeFileIfExists,
  syncRecognitionProgress,
  toStorageUrl,
  touchTask,
} = require('./lib/workbench_normalizers')
const { createBatchProcessingService } = require('./services/batch_processing_service')
const { createSignatureJobService } = require('./services/signature_job_service')
const { createWorkbenchStateHandlers } = require('./services/handlers/workbench/state_handlers')
const { createWorkbenchBatchHandlers } = require('./services/handlers/workbench/batch_handlers')
const { createWorkbenchTaskHandlers } = require('./services/handlers/workbench/task_handlers')
const { createTourConfirmService } = require('./services/tour_confirm_service')
const { createTourConfirmLogRepository } = require('./repositories/tour_confirm_log_repository')
const { createSendbackQueueRepository } = require('./repositories/sendback_queue_repository')
const {
  createWorkbenchCustomerHandlers,
} = require('./services/handlers/workbench/customer_handlers')
const { createStorageAccessMiddleware } = require('./services/handlers/workbench/storage_access')

// HTTP 请求超时:抽进 lib/http_timeout_config(0729)。原实现用 parseInt 前缀解析,
// SIGN_HTTP_REQUEST_TIMEOUT_MS=30m 会被读成 30 **毫秒**,所有大文件上传当场全断;
// 新实现只收纯数字串 + 设 1 秒下限,配错时大声报出来并回落默认。
const { resolveHttpRequestTimeoutMs } = require('./lib/http_timeout_config')

const PROJECT_ROOT = __dirname
const TRAIN_DATASET_EXPORT_ROOT = path.resolve(PROJECT_ROOT, '..', 'train')
const {
  workbenchRoot: WORKBENCH_ROOT,
  appDir: APP_DIR,
  storageRoot: STORAGE_ROOT,
  batchesRoot: BATCHES_ROOT,
  workbenchDbPath: WORKBENCH_DB_PATH,
  customerLibrarySettingsPath: CUSTOMER_LIBRARY_SETTINGS_PATH,
  defaultCustomerLibraryRoot: DEFAULT_CUSTOMER_LIBRARY_ROOT,
  customerTemplatePath: CUSTOMER_TEMPLATE_PATH,
  defaultPort: DEFAULT_PORT,
  defaultHost: DEFAULT_HOST,
  defaultScenario: DEFAULT_SCENARIO,
  supportedExtensions: SUPPORTED_EXTENSIONS,
  supportedAttachmentExtensions: SUPPORTED_ATTACHMENT_EXTENSIONS,
  ocrOwnedSignatureSources: OCR_OWNED_SIGNATURE_SOURCES,
  paddleOcrOptions: PADDLE_OCR_OPTIONS,
  paddleBatchChunkSize: PADDLE_BATCH_CHUNK_SIZE,
  modelArtifactRegistry: MODEL_ARTIFACT_REGISTRY,
  uploadMaxFileSizeMb: UPLOAD_MAX_FILE_SIZE_MB,
  upload,
} = createWorkbenchDependencies({
  projectRoot: PROJECT_ROOT,
  defaultPort: 3218,
  defaultHost: '127.0.0.1',
  defaultScenario: 'FullProcess',
  excelExtensions: EXCEL_EXTENSIONS,
  paddleMaxSide: PADDLE_MAX_SIDE,
})

ensureDir(TRAIN_DATASET_EXPORT_ROOT)

const activeBatches = new Set()
const AUTH_ENABLED = String(process.env.SIGN_ENABLE_AUTH || 'true').toLowerCase() !== 'false'
let runtimeInstanceLock = null
let signatureSiteWorker = null
let workbenchBatchLedgerImportService = null
let workbenchApproveSettleService = null
const { normalizeBatch, normalizeTask } = createWorkbenchNormalizers({
  defaultScenario: DEFAULT_SCENARIO,
})

async function buildAuthConfig() {
  if (!AUTH_ENABLED) {
    console.warn('[auth] SIGN_ENABLE_AUTH=false; API routes are running without login protection.')
    return null
  }

  if (!process.env.JWT_SECRET) {
    console.error('[auth] FATAL: JWT_SECRET environment variable is not set.')
    console.error('[auth] Set JWT_SECRET in .env file before starting the server.')
    console.error('[auth] Example: JWT_SECRET=your-secret-key-here')
    process.exit(1)
  }

  const JWT_SECRET = process.env.JWT_SECRET
  const userService = new UserService({ dbPath: WORKBENCH_DB_PATH })

  if ((await userService.getUserCount()) === 0) {
    const username = String(process.env.SIGN_BOOTSTRAP_ADMIN_USERNAME || 'admin').trim() || 'admin'
    const passwordFromEnv = Boolean(process.env.SIGN_BOOTSTRAP_ADMIN_PASSWORD)
    const password =
      process.env.SIGN_BOOTSTRAP_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url')
    await userService.ensureBootstrapAdmin({ username, password })
    if (passwordFromEnv) {
      // 密码来自环境变量,运维已知,不要把明文打进日志(避免日志平台持久化凭据)
      console.warn(
        `[auth] bootstrap admin created: username=${username} (password from SIGN_BOOTSTRAP_ADMIN_PASSWORD)`
      )
    } else {
      // 未设置环境变量时是一次性随机密码,必须打印一次,否则无法首次登录
      console.warn(`[auth] bootstrap admin created: username=${username} password=${password}`)
      console.warn(
        '[auth] One-time generated password above. Save it now, then set SIGN_BOOTSTRAP_ADMIN_PASSWORD to control it.'
      )
    }
  }

  return {
    jwtSecret: JWT_SECRET,
    userService,
    cookieSecure: String(process.env.SIGN_AUTH_COOKIE_SECURE || '').toLowerCase() === 'true',
  }
}

const sourceGroupResponseBuilder = createWorkbenchSourceGroupResponseBuilder({
  toStorageUrl,
})
const { buildResponseSourceGroups } = sourceGroupResponseBuilder
const batchResponseBuilder = createWorkbenchBatchResponseBuilder({
  toStorageUrl,
  buildRecognitionProgressSnapshot,
  buildResponseSourceGroups,
})
const { applyComputedFields, summarizeBatch } = batchResponseBuilder
const modelPipelineOrchestrator = createModelPipelineOrchestrator()
const sqliteRepository = createWorkbenchSqliteRepository({
  dbPath: WORKBENCH_DB_PATH,
})
// 代理工作台V2:客户级读模型(可重建)+ 客户档案增量投影钩子(失败不阻断主写,记retry)。
const agentWorkspaceRepository = createAgentWorkspaceRepository({ db: sqliteRepository.db })
// V2 Task6:持久运营任务表(回执/回发/更正的真相,非缓存不可丢)
const workflowTaskRepository = createWorkflowTaskRepository({ db: sqliteRepository.db })
const sqliteSyncService = createWorkbenchSqliteSyncService({
  sqliteRepository,
  // 批次镜像落定后顺带投影客户级审核覆盖层(advisory,失败只记日志不阻断)
  agentWorkspaceRepository,
  projectionLogger: stallLogger,
})
const agentWorkspaceProjectionHooks = createCustomerProjectionHooks({
  agentWorkspaceRepository,
  logger: stallLogger, // 结构化日志(agent_workspace_projection_failed 可 grep)
})

const batchRepository = createWorkbenchBatchRepository({
  batchesRoot: BATCHES_ROOT,
  normalizeBatch,
  summarizeBatch,
  sqliteSyncService,
})
const {
  batchDir,
  batchJsonPath,
  loadBatch,
  removeBatchDirectory,
  batchSubdirs,
  resolveBatchRelativePath,
  saveBatchAsync,
  saveJson,
  withBatchWrite,
  getQueueMetrics: getBatchWriteQueueMetrics,
} = batchRepository
const { clearTaskSignatureArtifacts, removeTaskArtifacts } = createWorkbenchArtifactHelpers({
  resolveBatchRelativePath,
  removeFile: removeFileIfExists,
})
const customerLibraryRepository = createCustomerLibraryRepository({
  defaultRoot: DEFAULT_CUSTOMER_LIBRARY_ROOT,
  settingsPath: CUSTOMER_LIBRARY_SETTINGS_PATH,
  projectionHooks: agentWorkspaceProjectionHooks,
})
const customerTemplateRepository = createCustomerTemplateRepository({
  sourceTemplatePath: CUSTOMER_TEMPLATE_PATH,
})
// OCR 后端开关:qwen → 千问 API(默认 paddle → 本地 PaddleX)
const SIGN_OCR_BACKEND = String(process.env.SIGN_OCR_BACKEND || 'qwen').trim().toLowerCase()
const qwenOcrBackend = SIGN_OCR_BACKEND === 'qwen' ? createQwenOcrBackend() : null
if (qwenOcrBackend) {
  console.log('[workbench] OCR 后端 = 千问 API(qwen);PaddleX 模型不加载')
}
// qwen 模式不加载 PaddleX 模型(省 ~535M + Python 进程池)
const paddlexModelRunner = (!qwenOcrBackend && MODEL_ARTIFACT_REGISTRY.enabled)
  ? createPaddlexModelRunner({ pythonExe: MODEL_ARTIFACT_REGISTRY.pythonExe })
  : null
const documentRegionDetector = paddlexModelRunner
  ? createDocumentRegionDetector({
      modelConfig: MODEL_ARTIFACT_REGISTRY.detection,
      runner: paddlexModelRunner,
    })
  : null
const documentSplitService = qwenOcrBackend
  ? createQwenDocumentSplitService({ qwenBackend: qwenOcrBackend })
  : (documentRegionDetector
    ? createDocumentSplitService({ detector: documentRegionDetector })
    : null)
const documentTypeModel = paddlexModelRunner
  ? createDocumentTypeModel({
      modelConfig: MODEL_ARTIFACT_REGISTRY.classification,
      runner: paddlexModelRunner,
    })
  : null
const passportFieldModel = paddlexModelRunner
  ? createPassportFieldModel({
      modelConfig: MODEL_ARTIFACT_REGISTRY.passportFieldDetection,
      runner: paddlexModelRunner,
    })
  : null
const receiptFieldModel = paddlexModelRunner
  ? createReceiptFieldModel({
      modelConfig: MODEL_ARTIFACT_REGISTRY.receiptFieldDetection,
      runner: paddlexModelRunner,
    })
  : null
const customerImagePrepService = createCustomerImagePrepService()
const customerDocumentPreprocessService = createCustomerDocumentPreprocessService({
  customerLibraryRepository,
  documentSplitService,
  // qwen 模式按客户并发(API 并行)加速大批次;paddle 保持串行(零回归,且不超订 Python 池)
  concurrency: qwenOcrBackend ? (Number(process.env.QWEN_PREPROCESS_CONCURRENCY) || 6) : 1,
  // 单客户内多图并行(2026-07-07 建档提速):9图客户从串行~3分钟降到~1分钟。
  // paddle 保持串行(零回归);全局 splitGate(PREPROCESS_MAX_CONCURRENT,默认6)兜底防打爆账户。
  imageConcurrency: qwenOcrBackend ? (Number(process.env.QWEN_IMAGE_CONCURRENCY) || 3) : 1,
})
const customerImageReviewService = createCustomerImageReviewService({
  customerLibraryRepository,
})
const customerIntakeService = createCustomerIntakeService({
  customerLibraryRepository,
  customerTemplateRepository,
  customerImagePrepService,
})
const customerBatchBridgeService = createCustomerBatchBridgeService({
  customerLibraryRepository,
  batchRepository,
  buildBatchSkeleton,
  createImportedImageTask,
  nowStamp,
})
const customerTemplateFillService = createCustomerTemplateFillService()
const billingExportService = createBillingExportService({
  templateFillService: customerTemplateFillService,
  defaultTemplatePath: CUSTOMER_TEMPLATE_PATH,
})
const customerFinalizeService = createCustomerFinalizeService({
  customerLibraryRepository,
  customerTemplateRepository,
  customerTemplateFillService,
  billingExportService,
})
const workbenchExportService = createWorkbenchExportService({
  batchDir,
  batchSubdirs,
  toStorageUrl,
  applyComputedFields,
  customerLibraryRepository,
  customerFinalizeService,
})
const hyundaiDeliveryExportService = createHyundaiDeliveryExportService({ resolveBatchRelativePath })
const lotteDeptDeliveryExportService = createLotteDeptDeliveryExportService({ resolveBatchRelativePath })
// 多模式交付包(2026-07-07):现代区复用上面的现代三池计划
const modeDeliveryExportService = createModeDeliveryExportService({ resolveBatchRelativePath, hyundaiDeliveryExportService })
const batchCustomerDataExportService = createBatchCustomerDataExportService({
  customerLibraryRepository,
  resolveBatchRelativePath,
})
const workbenchGroupApprovalService = createWorkbenchGroupApprovalService({
  approveSourceGroupTasks,
  saveBatchAsync,
  batchRootDirResolver: batchDir,
  customerFinalizeService,
  markClassificationConfirmed,
  recalcTask,
  touchTask,
})
const workbenchStateService = createWorkbenchStateService({
  workbenchRoot: WORKBENCH_ROOT,
  defaultCustomerLibraryRoot: DEFAULT_CUSTOMER_LIBRARY_ROOT,
  listBatches,
  getSignatureServiceState: () => signatureSiteWorker.getState(),
  customerLibraryRepository,
  customerIntakeService,
})
const myTodoService = createMyTodoService({ listBatches })
function listBatches() {
  return batchRepository.listBatchesAsync()
}

function syncAllBatchesToSqlite() {
  const batchIds = batchRepository.listBatchIds()
  const batches = []

  for (const batchId of batchIds) {
    try {
      batches.push(loadBatch(batchId))
    } catch (error) {
      console.error(`[workbench] Failed to load batch ${batchId} for SQLite sync`, error)
    }
  }

  const result = sqliteSyncService.syncBatches(batches)
  console.log(
    `[workbench] SQLite sync ready: batches=${result.counts.batchCount}, groups=${result.counts.travelerGroupCount}, receipts=${result.counts.receiptRecordCount}, passports=${result.counts.passportRecordCount}`
  )
  return result
}

function resolveTask(batch, taskId) {
  return batch.tasks.find((item) => item.id === taskId) || null
}

function recalcTask(task) {
  Object.assign(task, ensureSignatureFields(task))
  const workflowState = buildTaskWorkflowState(task)
  task.processResult = workflowState.processResult
  task.actionSuggestion = workflowState.actionSuggestion
  task.workflowState = workflowState
}

function createManualTask(label = '') {
  return createManualTaskFromFactory(label)
}

const signatureJobService = createSignatureJobService({
  batchJsonPath,
  batchSubdirs,
  resolveBatchRelativePath,
  removeFileIfExists,
  loadBatch,
  saveBatchAsync,
  withBatchWrite,
  resolveTask,
  recalcTask,
  touchTask,
  isEligibleForWebsiteGeneration,
  ocrOwnedSignatureSources: OCR_OWNED_SIGNATURE_SOURCES,
  getSignatureSiteWorker: () => signatureSiteWorker,
})

signatureSiteWorker = new SignatureSiteWorker({
  storageRoot: STORAGE_ROOT,
  onJobStart: signatureJobService.handleSignatureJobStart,
  onJobSuccess: signatureJobService.handleSignatureJobSuccess,
  onJobFailure: signatureJobService.handleSignatureJobFailure,
})

const batchProcessingService = createBatchProcessingService({
  activeBatches,
  batchDir,
  batchJsonPath,
  batchSubdirs,
  withBatchWrite,
  loadBatch,
  saveBatchAsync,
  saveJson,
  modelPipelineOrchestrator,
  documentTypeModel,
  passportFieldModel,
  receiptFieldModel,
  qwenOcrBackend,
  paddleOcrOptions: PADDLE_OCR_OPTIONS,
  paddleBatchChunkSize: PADDLE_BATCH_CHUNK_SIZE,
  resolveTask,
  recalcTask,
  touchTask,
  syncRecognitionProgress,
  hasAutoConfirmedDocType,
  markClassificationConfirmed,
  clearSignatureRegionAsset: signatureJobService.clearSignatureRegionAsset,
  clearAutoFinalSignatureAsset: signatureJobService.clearAutoFinalSignatureAsset,
  canAutoQueueWebsiteSignature: signatureJobService.canAutoQueueWebsiteSignature,
  queueAutomaticWebsiteSignature: signatureJobService.queueAutomaticWebsiteSignature,
})
const { processBatch } = batchProcessingService

const scheduler = createWorkbenchScheduler({
  processBatch: (batchId) =>
    new Promise((resolve) => {
      setTimeout(() => {
        processBatch(batchId)
          .catch((error) => {
            console.error(`[workbench] batch ${batchId} failed`, error)
          })
          .finally(resolve)
      }, 50)
    }),
  onError: (error) => {
    console.error(error)
  },
})

const { resumeIncompleteBatches, scheduleBatch } = scheduler

const workbenchWriteService = createWorkbenchWriteService({
  defaultScenario: DEFAULT_SCENARIO,
  nowStamp,
  withBatchWrite,
  hasBatch: batchRepository.hasBatch,
  loadBatch,
  saveBatchAsync,
  summarizeBatch,
  buildBatchSkeleton,
  batchSubdirs,
  createManualTaskFromFactory: createManualTask,
  createManualReceiptTaskFromSource,
  normalizeFieldValue,
  resolveTask,
  normalizeTask,
  normalizeDocType,
  clearTaskSignatureArtifacts,
  clearEditableFieldsForDocTypeSwitch,
  markClassificationConfirmed,
  didEditableWorkflowChange,
  syncWebsiteSignatureAfterFieldChange,
  websiteSignatureSource: WEBSITE_SIGNATURE_SOURCE,
  removeFileIfExists,
  resolveBatchRelativePath,
  recoverCompletedStateAfterManualReview,
  recalcTask,
  touchTask,
  workbenchGroupApprovalService,
  removeTaskArtifacts,
  clearActiveBatch: (batchId) => activeBatches.delete(batchId),
  removeBatchProjection: (batchId) => sqliteSyncService.removeBatch(batchId),
  removeBatchDirectory,
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
  createSignatureJob: signatureJobService.createSignatureJob,
  signatureSiteWorker,
  clearWebsiteFinalSignatureAsset: signatureJobService.clearWebsiteFinalSignatureAsset,
  manualSignatureSource: MANUAL_SIGNATURE_SOURCE,
  restoreAutomaticSignatureState: signatureJobService.restoreAutomaticSignatureState,
  batchDir,
  applyComputedFields,
  onProjectionRemoveError: (error, batchId) => {
    console.error(`[workbench] Failed to remove batch ${batchId} from SQLite`, error)
  },
})
const workbenchSignatureHandlers = createWorkbenchSignatureHandlers({
  signatureSiteWorker,
  workbenchWriteService,
  loadBatch,
  assertBatchAccess,
})
const stateHandlers = createWorkbenchStateHandlers({
  workbenchStateService,
  myTodoService,
})
const batchHandlers = createWorkbenchBatchHandlers({
  loadBatch,
  assertBatchAccess,
  summarizeBatch,
  workbenchExportService,
  workbenchWriteService,
  batchCustomerDataExportService,
  hyundaiDeliveryExportService,
  lotteDeptDeliveryExportService,
  modeDeliveryExportService,
})
// P2d 改店重切:仅 qwen 模式启用(paddle 切图管道不认店档案,service 直接 501)
const taskResplitService = createTaskResplitService({
  customerLibraryRepository,
  batchRepository,
  customerBatchBridgeService,
  documentSplitService,
  removeTaskArtifacts,
  enabled: Boolean(qwenOcrBackend),
})
// 团号确认站 holder(2026-07-10):service 依赖 groupCodePrematchService(monthlyDb 晚建),
// 与 setGroupCodePrematchService 同模式晚绑定填充;repos 只依赖 STORAGE_ROOT,可即刻建。
const tourConfirmHolder = { service: null, logRepo: null, sendbackRepo: null }
const taskHandlers = createWorkbenchTaskHandlers({
  activeBatches,
  batchRepository,
  customerIntakeService,
  customerLibraryRepository,
  loadBatch,
  assertBatchAccess,
  removeBatchDirectory,
  removeTaskArtifacts,
  saveBatchAsync,
  sqliteSyncService,
  summarizeBatch,
  syncRecognitionProgress,
  withBatchWrite,
  workbenchWriteService,
  getWorkbenchBatchLedgerImportService: () => workbenchBatchLedgerImportService,
  getWorkbenchApproveSettleService: () => workbenchApproveSettleService,
  scheduleBatch, // 任务重识别(requeue)后触发识别管道
  getTaskResplitService: () => taskResplitService,
  getTourConfirm: () => tourConfirmHolder, // 团号确认站(晚绑定:prematch 依赖 monthlyDb)
})
const customerWorkspaceHandlers = createWorkbenchCustomerHandlers({
  customerDocumentPreprocessService,
  customerImageReviewService,
  customerIntakeService,
  // #5 重识别回灌批次:重识别成功且客户挂在批次上 → 锁内自动追加新切片+清旧任务
  customerBatchBridgeService,
  withBatchWrite,
  scheduleBatch,
  batchExists: batchRepository.hasBatch,
})
const customerLibraryBaseHandlers = createCustomerLibraryHandlers({
  customerIntakeService,
  workbenchStateService,
  removeReviewCustomerGroup: taskHandlers.removeReviewCustomerGroupForCustomer,
  batchExists: batchRepository.hasBatch,
  loadBatchForGuard: batchRepository.loadBatch, // 批次前置:校验批次存在+工作区一致
})
const customerBatchHandlers = createCustomerBatchHandlers({
  customerIntakeService,
  customerBatchBridgeService,
  scheduleBatch,
  loadBatch,
  summarizeBatch,
  withBatchWrite, // 追加图片/换团号表也要走同一把批次写锁,否则与审核 updateTask 并发互吞(丢审核态)
  defaultScenario: DEFAULT_SCENARIO,
})
const workbenchBatchImportHandlers = createWorkbenchBatchImportHandlers({
  buildBatchSkeleton,
  batchSubdirs,
  createImportedImageTask,
  saveBatchAsync,
  scheduleBatch,
  summarizeBatch,
  nowStamp,
  supportedExtensions: SUPPORTED_EXTENSIONS,
  supportedAttachmentExtensions: SUPPORTED_ATTACHMENT_EXTENSIONS,
  defaultScenario: DEFAULT_SCENARIO,
})

const workbenchHandlers = {
  ...stateHandlers,
  ...batchHandlers,
  openSignatureBrowser: workbenchSignatureHandlers.openSignatureBrowser,
  closeSignatureBrowser: workbenchSignatureHandlers.closeSignatureBrowser,
  importBatch: workbenchBatchImportHandlers.importBatch,
  createManualReceiptFromTask: taskHandlers.createManualReceiptFromTask,
  setTaskDocBox: taskHandlers.setTaskDocBox,
  getTaskOriginalImage: taskHandlers.getTaskOriginalImage, // 「查看原图」切边补救
  rereadTaskBox: taskHandlers.rereadTaskBox, // P2-b 按人画的框重读票面字段
  updateTask: taskHandlers.updateTask,
  requeueTasks: taskHandlers.requeueTasks, // 任务重识别(OCR故障后补跑)
  resplitTask: taskHandlers.resplitTask, // P2d 改店重切(⚠️新 handler 必须同步进这张聚合表,漏了=启动即炸)
  approveSourceGroup: taskHandlers.approveSourceGroup,
  importBatchLedger: taskHandlers.importBatchLedger,
  settleSourceGroup: taskHandlers.settleSourceGroup,
  confirmGroupModes: taskHandlers.confirmGroupModes,
  correctGroupLedger: taskHandlers.correctGroupLedger, // 台账侧订正(2026-07-21;8模块审计CRITICAL:漏聚合=启动即炸)

  // 团号确认站(⚠️新 handler 必须同步进这张聚合表,漏了=启动即炸)
  getGroupTourCandidates: taskHandlers.getGroupTourCandidates,
  confirmGroupTour: taskHandlers.confirmGroupTour,
  unconfirmGroupTour: taskHandlers.unconfirmGroupTour,
  markGroupTourResponded: taskHandlers.markGroupTourResponded,
  getTourPrior: taskHandlers.getTourPrior,
  listSendbackQueue: taskHandlers.listSendbackQueue,
  markSendbackDone: taskHandlers.markSendbackDone,
  deleteSourceGroupCustomer: taskHandlers.deleteSourceGroupCustomer,
  deleteTask: taskHandlers.deleteTask,
  queueTaskWebsiteSignature: workbenchSignatureHandlers.queueTaskWebsiteSignature,
  queueBatchWebsiteSignatures: workbenchSignatureHandlers.queueBatchWebsiteSignatures,
  deleteWebsiteSignature: workbenchSignatureHandlers.deleteWebsiteSignature,
  saveManualSignature: workbenchSignatureHandlers.saveManualSignature,
  deleteManualSignature: workbenchSignatureHandlers.deleteManualSignature,
}

const customerLibraryHandlers = {
  ...customerLibraryBaseHandlers,
  ...customerWorkspaceHandlers,
  appendCustomerImagesFromFiles: customerBatchHandlers.appendCustomerImagesFromFiles,
  importCustomerWorkspace: customerBatchHandlers.importCustomerWorkspace,
  appendCustomerWorkspaceToBatch: customerBatchHandlers.appendCustomerWorkspaceToBatch,
  appendCustomerToBatch: customerBatchHandlers.appendCustomerToBatch,
  replaceBatchGroupCode: customerBatchHandlers.replaceBatchGroupCode,
}

const storageAccessMiddleware = createStorageAccessMiddleware({
  loadBatch,
  assertBatchAccess,
})

async function startWorkbenchServer() {
  const port = Number(process.env.PORT || DEFAULT_PORT)
  const host =
    String(process.env.HOST || process.env.WORKBENCH_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  runtimeInstanceLock = acquireSingleInstanceLock({
    lockPath: process.env.SIGN_INSTANCE_LOCK_PATH
      ? path.resolve(process.env.SIGN_INSTANCE_LOCK_PATH)
      : path.join(STORAGE_ROOT, 'runtime', 'sign-workbench.lock'),
    identity: {
      service: 'sign-workbench',
      host,
      port,
    },
    releaseOnExit: true,
  })

  const auth = await buildAuthConfig()
  const monthlyDb = openMonthlyDatabase({
    dbPath: path.join(STORAGE_ROOT, 'monthly.sqlite'),
  })
  // 配置台P0:台账模式规则优先走 DB 配置(没配/坏配置→出厂矩阵,行为零变化);
  // 命中/回落各有日志(config_hit / config_fallback 可 grep),版本戳在 config_hit 里
  const modeConfigRepository = createModeConfigRepository({ db: monthlyDb })
  setModeRuleResolver(createModeConfigResolver({ modeConfigRepository, logger: stallLogger }).getModeRecordRule)
  // P3a:审核必填集接配置(基线/店档案字段/模式微调;没配=出厂,行为零变化)
  const reviewConfigResolver = createReviewConfigResolver({ modeConfigRepository, logger: stallLogger })
  setReviewConfigResolver(reviewConfigResolver)
  const monthlyWorkspaceRepo = createMonthlyWorkspaceRepository({ db: monthlyDb })
  const monthlyGroupCodeRepo = createGroupCodeRepository({ db: monthlyDb })
  const monthlyStoreBillRepo = createStoreBillRepository({ db: monthlyDb })
  const monthlyBrandActivityRepo = createBrandActivityRepository({ db: monthlyDb })
  const monthlyMissingReceiptRepo = createMissingReceiptRepository({ db: monthlyDb })
  const monthlyErrorRecordRepo = createErrorRecordRepository({ db: monthlyDb })
  const monthlyImportJobRepo = createImportJobRepository({ db: monthlyDb })
  const monthlyBatchGroupCodeRepo = createBatchGroupCodeRepository({ db: monthlyDb })
  const monthlyDepartureSyncAuditRepo = createDepartureSyncAuditRepository({ db: monthlyDb })
  const monthlyReceivedReceiptRepo = createReceivedReceiptRepository({ db: monthlyDb })
  const monthlyDailyFieldHistoryRepo = createDailyFieldHistoryRepository({ db: monthlyDb })
  const monthlyDailyReceiptRepo = createDailyReceiptRepository({
    db: monthlyDb,
    fieldHistoryRepo: monthlyDailyFieldHistoryRepo,
  })
  // 交付包分桶"台账优先"(2026-07-20 五问题#2):planner 构造早于 monthlyDb,setter 晚绑定注入
  modeDeliveryExportService.setDailyReceiptRepo?.(monthlyDailyReceiptRepo)
  const monthlyBillMatchLogRepo = createBillMatchLogRepository({ db: monthlyDb })
  const monthlyPendingReviewRepo = createPendingReviewRepository({ db: monthlyDb })
  const monthlyDataRepo = createMonthlyDataRepository({ db: monthlyDb })
  const monthlyModeDeductConfigRepo = createModeDeductConfigRepository({ db: monthlyDb })
  const monthlyModeFolderMappingRepo = createModeFolderMappingRepository({ db: monthlyDb })
  const monthlyWorkspaceService = createMonthlyWorkspaceService({
    workspaceRepo: monthlyWorkspaceRepo,
  })
  const monthlyModeConfigService = createModeConfigService({
    workspaceService: monthlyWorkspaceService,
    workspaceRepo: monthlyWorkspaceRepo,
    modeDeductConfigRepo: monthlyModeDeductConfigRepo,
    modeFolderMappingRepo: monthlyModeFolderMappingRepo,
    modeFolderApplyService: createModeFolderApplyService({
      dailyReceiptRepo: monthlyDailyReceiptRepo,
      modeFolderMappingRepo: monthlyModeFolderMappingRepo,
    }),
  })
  const batchGroupCodeImportService = createBatchGroupCodeImportService({
    batchGroupCodeRepo: monthlyBatchGroupCodeRepo,
  })
  if (typeof customerBatchBridgeService.setBatchGroupCodeImportService === 'function') {
    customerBatchBridgeService.setBatchGroupCodeImportService(batchGroupCodeImportService)
  }

  // 团号预匹配(审核前出模式):识别完/团号表就绪/审核改团号 三个触发点共用一个服务。
  // 晚绑定注入(与上面 setBatchGroupCodeImportService 同模式:monthlyDb 晚于各服务创建)。
  const groupCodePrematchService = createGroupCodePrematchService({
    batchGroupCodeRepo: monthlyBatchGroupCodeRepo,
  })
  batchProcessingService.setGroupCodePrematchService?.(groupCodePrematchService)
  customerBatchBridgeService.setGroupCodePrematchService?.(groupCodePrematchService)
  workbenchWriteService.setGroupCodePrematchService?.(groupCodePrematchService)

  // 团号确认站装配(2026-07-10):确认流水(先验+审计)+ 回发队列 + 核心服务。
  tourConfirmHolder.logRepo = createTourConfirmLogRepository({ storageRoot: STORAGE_ROOT })
  // V2 Task6:回发队列切 adapter 模式,workflow_task 表是唯一真相(旧 API 形状不变)。
  // ⚠️ 部署时须先跑 scripts/migrate_sendback_queue.js --apply 迁移旧 JSON(灰度清单步骤)。
  tourConfirmHolder.sendbackRepo = createSendbackQueueRepository({
    storageRoot: STORAGE_ROOT,
    workflowTaskRepository,
  })
  tourConfirmHolder.service = createTourConfirmService({
    groupCodePrematchHolder: { service: groupCodePrematchService },
    tourConfirmLogRepo: tourConfirmHolder.logRepo,
    sendbackQueueRepo: tourConfirmHolder.sendbackRepo,
    logger: stallLogger, // 入队失败可 grep sendback_enqueue_failed
  })

  // V2 Task7(修订④):票级表态写路径 → 运营任务对账(全表态建 send_upstream/重开取消+更正)。
  const workflowTaskService = createWorkflowTaskService({
    workflowTaskRepository,
    logger: stallLogger,
  })
  workbenchWriteService.setWorkflowTaskCoordinator?.(createWorkflowTaskCoordinator({
    workflowTaskService,
    logger: stallLogger,
  }))
  // 对账补建(架构体检风险#1):workflow_task 不可丢却 advisory 写——协调器失败的漏建
  // 由周期 reconciler 兜底(默认 15 分钟,ENV WORKFLOW_TASK_RECONCILE_INTERVAL_MS=0 关)。
  const workflowTaskReconciler = createWorkflowTaskReconciler({
    db: sqliteRepository.db,
    batchRepository,
    workflowTaskService,
    logger: stallLogger,
  })
  workflowTaskReconciler.start()

  // 归档改名冲突分流用:查该护照已入台账的小票号(真重复建档 vs 合法二次收票)。
  // 两侧都投影成纯数字再比:任务侧票号现在保字母+横线(05-260701-263-00079),
  // 台账侧 ledger_bridge 落库时走 normalizeReceiptNoDigits(纯数字)——原样比对会漏拦真重复。
  customerFinalizeService.setSettledReceiptLookup?.((passportNo, receiptNos = []) => {
    const passport = String(passportNo || '').trim()
    if (!passport) return [] // 空护照(SLIM/无护照百货)不参与同人判重,防把别人的空护照行拉进来
    const targets = new Set((receiptNos || [])
      .map((v) => normalizeReceiptNoDigits(v))
      .filter(Boolean))
    if (!targets.size) return []
    // 按护照拉全量、两侧数字投影再比对(2026-07-14):台账里百货票**保杠**('5801-0110')、
    // 免税店纯数字——旧的 IN(数字投影) 只撞得上纯数字存法,带杠存法漏检真重复。
    // 单护照台账行个位数级,全拉不重。
    return monthlyDb
      .prepare('SELECT DISTINCT receipt_no FROM daily_receipt_export WHERE passport_no = ?')
      .all(passport)
      .map((row) => row.receipt_no)
      .filter((no) => targets.has(normalizeReceiptNoDigits(no)))
  })

  // 阶段 2: 审核台"客户组通过"时自动桥接到月度 receipt_ledger
  // 晚绑定：workbenchGroupApprovalService 在 monthly 之前就已构造，这里回填
  let ledgerBridgeService = null
  try {
    ledgerBridgeService = createWorkbenchLedgerBridgeService({
      dailyReceiptRepo: monthlyDailyReceiptRepo,
      userService: auth?.userService || null,
      workspaceService: monthlyWorkspaceService,
      // derivationRecomputeService 构造晚于此处,下面 setter 注入(见 monthlyDerivationRecomputeService 之后)
    })
    if (typeof workbenchGroupApprovalService.setLedgerBridgeService === 'function') {
      workbenchGroupApprovalService.setLedgerBridgeService(ledgerBridgeService)
      console.log('[workbench] ledger bridge wired: workbench → monthly daily_receipt_export')
    }
  } catch (error) {
    console.error('[workbench] Failed to wire ledger bridge:', error)
  }
  const monthlyImportService = createMonthlyImportService({
    importJobRepo: monthlyImportJobRepo,
    groupCodeRepo: monthlyGroupCodeRepo,
    storeBillRepo: monthlyStoreBillRepo,
    brandActivityRepo: monthlyBrandActivityRepo,
    missingReceiptRepo: monthlyMissingReceiptRepo,
    receivedReceiptRepo: monthlyReceivedReceiptRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    dailyFieldHistoryRepo: monthlyDailyFieldHistoryRepo,
    // G8b(A1=γ): 按 purchase_date 自动拆 + auto-create workspace (store_bill /
    // daily_receipt / received_receipt 三种走 split;group_code / missing 不走)
    workspaceService: monthlyWorkspaceService,
  })
  const auditLogRepo = createAuditLogRepository({ db: monthlyDb })
  const monthlyCrossCheckService = createCrossCheckService({
    storeBillRepo: monthlyStoreBillRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    errorRecordRepo: monthlyErrorRecordRepo,
    departureSyncAuditRepo: monthlyDepartureSyncAuditRepo,
    auditLogRepo,
  })
  const monthlyErrorDetectionService = createErrorDetectionService({
    storeBillRepo: monthlyStoreBillRepo,
    errorRecordRepo: monthlyErrorRecordRepo,
    groupCodeRepo: monthlyGroupCodeRepo,
    crossCheckService: monthlyCrossCheckService,
  })
  const monthlyStageJobRepo = createStageJobRepository({ db: monthlyDb })
  const monthlyPipelineLockService = createPipelineLockService({ db: monthlyDb })
  const monthlyMatchBadcaseRepo = createMatchBadcaseRepository({ db: monthlyDb })
  const feedbackReportRepo = createFeedbackReportRepository({ db: monthlyDb })
  const monthlyTourMatchService = createTourMatchService({
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    groupCodeRepo: monthlyGroupCodeRepo,
    batchGroupCodeRepo: monthlyBatchGroupCodeRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    errorRecordRepo: monthlyErrorRecordRepo,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
    modeFolderMappingRepo: monthlyModeFolderMappingRepo,
  })
  if (ledgerBridgeService) {
    workbenchBatchLedgerImportService = createWorkbenchBatchLedgerImportService({
      ledgerBridgeService,
      tourMatchService: monthlyTourMatchService,
    })
    // 流式逐客户结算(P1):审完一个客户组即写台账+即时团号匹配+回读模式;旧批次级导入并存。
    workbenchApproveSettleService = createWorkbenchApproveSettleService({
      groupApprovalService: workbenchGroupApprovalService,
      ledgerBridgeService,
      tourMatchService: monthlyTourMatchService,
      dailyReceiptRepo: monthlyDailyReceiptRepo,
    })
  }
  const monthlyBillMatchService = createBillMatchService({
    db: monthlyDb,
    storeBillRepo: monthlyStoreBillRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
  })
  const monthlyBillMatchBucketService = createBillMatchBucketService({
    db: monthlyDb,
    storeBillRepo: monthlyStoreBillRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
    monthlyDataRepo,
    modeDeductConfigRepo: monthlyModeDeductConfigRepo,
    modeFolderMappingRepo: monthlyModeFolderMappingRepo,
    importJobRepo: monthlyImportJobRepo,
  })
  const monthlyMergeStreamingService = createMergeStreamingService({
    db: monthlyDb,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    monthlyDataRepo,
    storeBillRepo: monthlyStoreBillRepo,
    brandActivityRepo: monthlyBrandActivityRepo,
    modeDeductConfigRepo: monthlyModeDeductConfigRepo,
    modeFolderMappingRepo: monthlyModeFolderMappingRepo,
    workspaceRepo: monthlyWorkspaceRepo,
  })
  // 派生新鲜度:上游变更标脏 + 进核对页/出包前按需重跑(导出永远跟最新匹配结果走)
  const monthlyDerivationRecomputeService = createDerivationRecomputeService({
    workspaceRepo: monthlyWorkspaceRepo,
    monthlyDataRepo,
    tourMatchService: monthlyTourMatchService,
    billMatchService: monthlyBillMatchService,
    mergeService: monthlyMergeStreamingService,
  })
  // OCR 审核台桥接的台账是生产台账来源 → 桥接成功后标脏,让导出跟最新台账走(setter 注入,
  // 因 bridge 构造早于本服务)。bridge 构造失败时为 null,可选链跳过。
  if (ledgerBridgeService && typeof ledgerBridgeService.setDerivationRecomputeService === 'function') {
    ledgerBridgeService.setDerivationRecomputeService(monthlyDerivationRecomputeService)
  }
  // 台账订正删行后标脏派生(2026-07-21 订正通道;同款晚绑定)
  if (workbenchApproveSettleService && typeof workbenchApproveSettleService.setDerivationRecomputeService === 'function') {
    workbenchApproveSettleService.setDerivationRecomputeService(monthlyDerivationRecomputeService)
  }
  const monthlySecondPassService = createSecondPassMissingService({
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    storeBillRepo: monthlyStoreBillRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
  })
  const monthlyExportService = createMonthlyExportService({
    monthlyDataRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    db: monthlyDb,
    customerLibraryRepository,
    batchRepository,
  })
  // 对账服务(含已核销过滤)提前建,供交付包未收清单复用,口径与 UI/单项导出一致。
  const monthlyUnreceivedResolutionRepo = createUnreceivedResolutionRepository({ db: monthlyDb })
  const monthlyCustomerReconciliationService = createCustomerReconciliationService({
    db: monthlyDb,
    unreceivedResolutionRepo: monthlyUnreceivedResolutionRepo,
  })
  // 未收补录(B2):从账单反向补台账,建完自动重跑 bill_match
  const monthlyUnreceivedBackfillService = createUnreceivedBackfillService({
    db: monthlyDb,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchService: monthlyBillMatchService,
  })
  // 未收清单导出(账单明细样式+按桶 sheet):路由单项导出与交付包共用同一实例,口径一致
  const monthlyUnreceivedExportService = createUnreceivedExportService({
    db: monthlyDb,
    customerReconciliationService: monthlyCustomerReconciliationService,
  })
  const finalDeliveryExportService = createFinalDeliveryExportService({
    db: monthlyDb,
    customerLibraryRepository,
    batchRepository,
    userService: auth?.userService || null,
    customerReconciliationService: monthlyCustomerReconciliationService,
    unreceivedExportService: monthlyUnreceivedExportService,
  })
  // 启动即检字体:客户 PDF 韩文(수수료 수령증)依赖 CJK 字体,缺失只会在导出时
  // 静默降级成方框/ASCII 无人察觉 — 这里启动时显式告警(不阻塞启动)。
  {
    const { resolveCjkFontPath } = require('./services/monthly/final_delivery_export_service')
    const cjkFont = resolveCjkFontPath()
    if (cjkFont) console.log(`[delivery] CJK font: ${cjkFont}`)
    else console.warn('[delivery] ⚠ CJK 字体缺失(客户 PDF 韩文/中文会渲染异常)。放置 NotoSansCJK-Regular.ttf 到 /opt/sign-data/fonts/ 或 assets/fonts/')
  }
  const monthlyReconciliationService = createMonthlyReconciliationService({
    db: monthlyDb,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    storeBillRepo: monthlyStoreBillRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    monthlyDataRepo,
    stageJobRepo: monthlyStageJobRepo,
  })
  const receivedReceiptExportService = createReceivedReceiptExportService({
    db: monthlyDb,
    userService: auth?.userService || null,
  })
  const libraryModeExportService = createLibraryModeExportService({ db: monthlyDb, batchRepository })
  const monthlyPendingReviewResolutionService = createPendingReviewResolutionService({
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    storeBillRepo: monthlyStoreBillRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    monthlyDataRepo,
  })
  const monthlyDailyWorkspaceMigrationService = createDailyWorkspaceMigrationService({
    db: monthlyDb,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    monthlyDataRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
    errorRecordRepo: monthlyErrorRecordRepo, // L614:跨月迁移清源月孤儿 TM error
    workspaceService: monthlyWorkspaceService,
    auditLogRepo,
  })
  const stageRetryService = createStageRetryService({
    stageJobRepo: monthlyStageJobRepo,
    tourMatchService: monthlyTourMatchService,
    billMatchService: monthlyBillMatchService,
    billMatchBucketService: monthlyBillMatchBucketService,
    mergeService: monthlyMergeStreamingService,
    secondPassMissingService: monthlySecondPassService,
    pipelineLockService: monthlyPipelineLockService,
    db: monthlyDb,
  })
  const batchOperationsService = createBatchOperationsService({
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    storeBillRepo: monthlyStoreBillRepo,
    groupCodeRepo: monthlyGroupCodeRepo,
    missingReceiptRepo: monthlyMissingReceiptRepo,
    receivedReceiptRepo: monthlyReceivedReceiptRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
    pendingReviewResolutionService: monthlyPendingReviewResolutionService,
  })
  const importValidationService = createImportValidationService({
    groupCodeRepo: monthlyGroupCodeRepo,
  })
  const monthlyManualEntryService = createManualEntryService({
    db: monthlyDb,
    workspaceService: monthlyWorkspaceService,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
  })
  const monthlyOrphanAggregationService = createOrphanAggregationService({ db: monthlyDb })
  const monthlyBillAggregationViewService = createBillAggregationViewService({
    db: monthlyDb,
    storeBillRepo: monthlyStoreBillRepo,
  })
  const monthlyBillEnrichmentService = createBillEnrichmentService({
    db: monthlyDb,
    storeBillRepo: monthlyStoreBillRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
  })
  const monthlyExportRoot = path.join(STORAGE_ROOT, 'monthly-exports')
  const monthlyStageLogService = createStageLogService({ exportRoot: monthlyExportRoot })
  const monthlyWorkspaceResetService = createMonthlyWorkspaceResetService({
    db: monthlyDb,
    workspaceRepo: monthlyWorkspaceRepo,
    exportRoot: monthlyExportRoot,
    createBackup,
    backupOptions: { sourceRoot: PROJECT_ROOT },
  })
  const monthlySeedService = createMonthlySeedService({
    workspaceService: monthlyWorkspaceService,
    workspaceResetService: monthlyWorkspaceResetService,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    storeBillRepo: monthlyStoreBillRepo,
    groupCodeRepo: monthlyGroupCodeRepo,
    receivedReceiptRepo: monthlyReceivedReceiptRepo,
  })
  const monthlyHealthCheckService = createMonthlyHealthCheckService({
    db: monthlyDb,
    workspaceService: monthlyWorkspaceService,
  })
  // P2 B页(2026-07-16):未收客户组读模型——对账口径完全复用 monthlyCustomerReconciliationService
  // (与未收清单页/交付包 5_未收 同源),这里只加 first_seen 锚+代理分桶+xlsx。
  // 在 monthly 路由前创建:账单导入 onImported 钩子要用它盖 first_seen(拍板③起算点)。
  const agentUnreceivedService = createAgentUnreceivedService({
    customerReconciliationService: monthlyCustomerReconciliationService,
    unreceivedStateRepo: createUnreceivedStateRepository({ db: monthlyDb }),
    unreceivedResolutionRepo: monthlyUnreceivedResolutionRepo, // 「无需补」与老页同一张人工标记表
    workflowTaskRepository, // 未收催收任务(与 A 页任务列同一体系)
    monthlyWorkspaceService,
    importJobRepo: monthlyImportJobRepo, // SMG替换窗口隔离:导入中禁导出、视图打 importing 标、不误同步任务
    logger: stallLogger,
  })
  // P3 在途判定(跨库晚绑定,照 setLedgerSearchLookup 手法):护照/票号在工作台镜像
  // (workbench.sqlite passport_record/receipt_record)里找到 = 图收了还在流程里。
  // 失败=空集,在途判定退化为只认台账,不炸。
  agentUnreceivedService.setInFlightLookup(({ passportNos, receiptNos }) => {
    const passports = new Map()
    const receipts = new Map() // 票号→{batchId,groupKey}(免护照百货靠它认"已建档")
    const norm = normalizeMatchString // 与对账匹配键同一真源,禁副本
    // 镜像表 group_id 是 scoped id(`${batchId}::group::${sourceGroupKey}`,sqlite_sync :74),
    // 审核台深链要裸 sourceGroupKey——不剥前缀深链永远 stale(部署前业务走查 HIGH)
    const bareGroupKey = (v) => {
      const s = String(v || '')
      const i = s.indexOf('::group::')
      return i >= 0 ? s.slice(i + '::group::'.length) : s
    }
    // 复核 HIGH#3:按 lower(trim(col)) IN (…) 分块点查(表达式索引 idx_*_no_norm 精确命中),
    // 不再全表扫进 JS 过滤——镜像表全系统累积,同步 API 全扫会卡事件循环。
    // 口径注:normalizeString 还会折叠内部连续空白;护照号/票号实际无内部空格,lower(trim()) 等价。
    const CHUNK = 400 // SQLite 变量上限 999,留余量
    const chunksOf = (set) => {
      const keys = [...set].map(norm).filter(Boolean)
      const out = []
      for (let i = 0; i < keys.length; i += CHUNK) out.push(keys.slice(i, i + CHUNK))
      return out
    }
    try {
      if (passportNos?.size) {
        for (const chunk of chunksOf(passportNos)) {
          const rows = sqliteRepository.db.prepare(
            `SELECT passport_no, batch_id, group_id FROM passport_record
             WHERE lower(trim(passport_no)) IN (${chunk.map(() => '?').join(',')})
             ORDER BY rowid DESC` // 同护照多批次:取最新镜像行,深链定向确定(复核 MEDIUM#4)
          ).all(...chunk)
          for (const row of rows) {
            const key = norm(row.passport_no)
            if (!passports.has(key)) {
              passports.set(key, { batchId: String(row.batch_id || ''), groupKey: bareGroupKey(row.group_id) })
            }
          }
        }
      }
      if (receiptNos?.size) {
        for (const chunk of chunksOf(receiptNos)) {
          const rows = sqliteRepository.db.prepare(
            `SELECT receipt_no, batch_id, group_id FROM receipt_record
             WHERE lower(trim(receipt_no)) IN (${chunk.map(() => '?').join(',')})
             ORDER BY rowid DESC` // 同票多镜像行取最新,与护照侧同口径
          ).all(...chunk)
          for (const row of rows) {
            const key = norm(row.receipt_no)
            // Map 而非 Set(部署前整体复查 HIGH):免护照百货(新世界/现代)纯组零护照任务,
            // 护照镜像永远查不到 → "已建档"深链要能从票号命中回溯批次/组
            if (!receipts.has(key)) {
              receipts.set(key, { batchId: String(row.batch_id || ''), groupKey: bareGroupKey(row.group_id) })
            }
          }
        }
      }
    } catch { /* 镜像表缺/查询失败 → 空结果退化 */ }
    return { passports, receipts }
  })

  const monthlyRoutes = createMonthlyRoutes({
    workspaceService: monthlyWorkspaceService,
    workspaceResetService: monthlyWorkspaceResetService,
    monthlySeedService,
    monthlyHealthCheckService,
    importService: monthlyImportService,
    errorDetectionService: monthlyErrorDetectionService,
    modeConfigService: monthlyModeConfigService,
    crossCheckService: monthlyCrossCheckService,
    groupCodeRepo: monthlyGroupCodeRepo,
    batchGroupCodeRepo: monthlyBatchGroupCodeRepo,
    storeBillRepo: monthlyStoreBillRepo,
    brandActivityRepo: monthlyBrandActivityRepo,
    missingReceiptRepo: monthlyMissingReceiptRepo,
    errorRecordRepo: monthlyErrorRecordRepo,
    importJobRepo: monthlyImportJobRepo,
    departureSyncAuditRepo: monthlyDepartureSyncAuditRepo,
    receivedReceiptRepo: monthlyReceivedReceiptRepo,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    monthlyDataRepo,
    tourMatchService: monthlyTourMatchService,
    billMatchService: monthlyBillMatchService,
    billMatchBucketService: monthlyBillMatchBucketService,
    mergeService: monthlyMergeStreamingService,
    derivationRecomputeService: monthlyDerivationRecomputeService,
    secondPassMissingService: monthlySecondPassService,
    monthlyExportService,
    finalDeliveryExportService,
    monthlyReconciliationService,
    receivedReceiptExportService,
    libraryModeExportService,
    pendingReviewResolutionService: monthlyPendingReviewResolutionService,
    dailyWorkspaceMigrationService: monthlyDailyWorkspaceMigrationService,
    stageJobRepo: monthlyStageJobRepo,
    pipelineLockService: monthlyPipelineLockService,
    stageLogService: monthlyStageLogService,
    matchBadcaseRepo: monthlyMatchBadcaseRepo,
    batchOperationsService,
    importValidationService,
    manualEntryService: monthlyManualEntryService,
    orphanAggregationService: monthlyOrphanAggregationService,
    billAggregationViewService: monthlyBillAggregationViewService,
    customerReconciliationService: monthlyCustomerReconciliationService,
    unreceivedResolutionRepo: monthlyUnreceivedResolutionRepo,
    unreceivedBackfillService: monthlyUnreceivedBackfillService,
    unreceivedExportService: monthlyUnreceivedExportService,
    billEnrichmentService: monthlyBillEnrichmentService,
    agentUnreceivedService,
    exportRoot: monthlyExportRoot,
    upload,
  })
  const app = createWorkbenchApp({
    projectRoot: PROJECT_ROOT,
    appDir: APP_DIR,
    batchesRoot: BATCHES_ROOT,
    trainExportsRoot: TRAIN_DATASET_EXPORT_ROOT,
    upload,
    uploadMaxFileSizeMb: UPLOAD_MAX_FILE_SIZE_MB,
    auditMiddleware: createAuditMiddleware({ auditLogRepo }),
    storageAccessMiddleware,
    registerAuthRoutes,
    registerWorkbenchRoutes,
    registerCustomerLibraryRoutes,
    registerMonthlyRoutes: monthlyRoutes.register,
    auth,
    workbenchHandlers,
    customerLibraryHandlers,
    healthProbes: {
      monthly_db: () => {
        // 单条 SELECT 1 直接命中 SQLite VFS, 锁住时立刻 throw
        monthlyDb.prepare('SELECT 1 AS ok').get()
        return { ok: true }
      },
      model_pipeline: () => ({
        ok: true,
        enabled: MODEL_ARTIFACT_REGISTRY.enabled,
        splitReady: MODEL_ARTIFACT_REGISTRY.detection.ready,
        classificationReady: MODEL_ARTIFACT_REGISTRY.classification.ready,
        passportFieldReady: MODEL_ARTIFACT_REGISTRY.passportFieldDetection.ready,
        receiptFieldReady: MODEL_ARTIFACT_REGISTRY.receiptFieldDetection.ready,
      }),
    },
    healthMeta: {
      service: 'passport_review_workbench',
      nodeVersion: process.version,
      pid: process.pid,
    },
    getBatchWriteQueueMetrics,
  })

  // V2 Task8:代理工作台 API(读模型 + 运营任务;reviewer 由 service 强制收窄 owner)
  const agentWorkspaceService = createAgentWorkspaceService({
    agentWorkspaceRepository,
    workflowTaskRepository,
    db: sqliteRepository.db,
    logger: stallLogger,
  })
  // P1 一键搜索(2026-07-16):护照/票号/团号在 monthly.sqlite 台账(投影在 workbench.sqlite,跨库)
  // → 反查函数在这注入(monthlyDb 此处已就绪)。失败/表缺=空集,搜索退化为姓名/客户号,不炸。
  // 全量一键搜索(2026-07-24):护照/票号/团号两路反查并集,覆盖【全部客户】不再只限已结算。
  //   ① 台账 daily_receipt_export(已结算)→ source_customer_id(对投影 customer_id)
  //   ② 工作台镜像 passport_record/receipt_record(在途/未结算)→ 裸 group_id(对投影 active_group_key)
  // 任一路失败=该路空集,不炸;手动搜索低频,LIKE 扫描可接受。
  agentWorkspaceService.setLedgerSearchLookup(({ month, term }) => {
    const raw = String(term || '')
    const esc = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const like = `%${esc(raw)}%`
    const likeBare = `%${esc(raw.replace(/[\s-]/g, ''))}%` // 去空白/连字符:小票号带杠时按纯数字命中
    const customerIds = []
    const groupKeys = []
    try {
      const rows = monthlyDb.prepare(`
        SELECT DISTINCT source_customer_id AS cid FROM daily_receipt_export
        WHERE workspace_key = ?
          AND (passport_no LIKE ? ESCAPE '\\' OR receipt_no LIKE ? ESCAPE '\\'
            OR tour_no LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
        LIMIT 500
      `).all(String(month || ''), like, like, like, like)
      for (const r of rows) if (r.cid) customerIds.push(r.cid)
    } catch { /* 台账反查失败=空集 */ }
    try {
      const bareGroupKey = (v) => { const s = String(v || ''); const i = s.indexOf('::group::'); return i >= 0 ? s.slice(i + '::group::'.length) : s }
      const gk = new Set()
      for (const r of sqliteRepository.db.prepare(`
        SELECT DISTINCT group_id FROM passport_record
        WHERE passport_no LIKE ? ESCAPE '\\' OR tour_no LIKE ? ESCAPE '\\'
        LIMIT 500
      `).all(like, like)) gk.add(bareGroupKey(r.group_id))
      for (const r of sqliteRepository.db.prepare(`
        SELECT DISTINCT group_id FROM receipt_record
        WHERE receipt_no LIKE ? ESCAPE '\\'
          OR replace(replace(receipt_no, '-', ''), ' ', '') LIKE ? ESCAPE '\\'
        LIMIT 500
      `).all(like, likeBare)) gk.add(bareGroupKey(r.group_id))
      for (const k of gk) if (k) groupKeys.push(k)
    } catch { /* 镜像反查失败=空集 */ }
    return { customerIds, groupKeys }
  })
  registerAgentWorkspaceRoutes({
    app,
    auth,
    agentWorkspaceService,
    agentUnreceivedService, // B页未收(创建于 monthly 路由装配前,与导入钩子共用实例)
  })

  // Admin 路由 + 用户反馈路由
  const adminRoutes = createAdminRoutes({
    monthlyDb,
    workbenchDb: null,
    pythonPool: null,
    feedbackRepo: feedbackReportRepo,
    modelArtifactRegistry: MODEL_ARTIFACT_REGISTRY,
    auth,
  })
  adminRoutes.register(app)

  // 训练数据回流(模型优化飞轮):导出 6 个飞桨数据集 + 上传 AI Studio
  const trainingRoutes = createTrainingRoutes({ projectRoot: PROJECT_ROOT, auth })
  trainingRoutes.register(app)

  // admin 后台员工管理（添加员工 / 角色 / agent_code / 重置密码）
  if (auth?.userService) {
    const adminUserRoutes = createAdminUserRoutes({ userService: auth.userService, auth })
    adminUserRoutes.register(app)
  }

  const feedbackRoutes = createFeedbackRoutes({
    feedbackRepo: feedbackReportRepo,
    auth,
  })
  feedbackRoutes.register(app)

  const stageProgressRoutes = createStageProgressRoutes({ auth })
  stageProgressRoutes.register(app)

  const auditRoutes = createAuditRoutes({ auditLogRepo, auth })
  auditRoutes.register(app)

  // P3b Excel 明细表:台账 42 列按工作区(+模式)取行;列名单由引擎 EXCEL_COLUMN_DEFS 锁死。
  // 预览与真落盘共用**同一引用**(复核M1:此前两份一字不差的闭包=副本漂移病根,预览≠导出的事故雏形)。
  const queryLedgerRows = ({ workspaceKey, modes = [] }) => {
    // ⭐生产实测(2026-07-15 周报查询):stmt_date 列是账单导入侧的,工作台结算从不写(全表 null);
    // 工作台落账的收票日期在 receipt_date——别名回 stmt_date,引擎/配置/表头零改动。
    const cols = "COALESCE(receipt_date, stmt_date) AS stmt_date, agent, mode_raw, shop, purchase_date, departure_date, receipt_no, tour_no, name, passport_no, brand, gross_krw, branch, upstream"
    const sql = `SELECT ${cols} FROM daily_receipt_export WHERE workspace_key = ? ORDER BY id`
    let rows
    try {
      rows = monthlyDb.prepare(sql).all(String(workspaceKey || '').trim())
    } catch {
      return [] // 表未建(新库首月)=空,不拦配置台
    }
    // A4(2026-07-16 同步一致性审计):scope 过滤按**正名**比对(此前 SQL 裸串 IN——台账里
    // 别名写法/带尾巴的 mode_raw 会被漏掉,冲突检查却按正名判说没问题)。SQL 做不了归一,
    // 拉整月后 JS 过滤(单月行数量级,一次性导出可接受)。
    const modeList = (modes || []).map((m) => resolveCanonicalModeName(String(m).trim())).filter(Boolean)
    if (!modeList.length) return rows
    const scope = new Set(modeList)
    return rows.filter((r) => scope.has(resolveCanonicalModeName(String(r.mode_raw || '').trim())))
  }

  // 配置台 P1(admin):模式记录规则的查看/保存/回滚/停用;保存即生效(resolver 按变更水位失效缓存)
  const configConsoleRoutes = createConfigConsoleRoutes({
    modeConfigRepository,
    auditLogRepo,
    auth,
    // P2 预览:内置计划直调老 planner(零漂移);DSL 计划走引擎;都不落盘
    previewDeps: {
      loadBatch,
      listBatches, // P3a 影响面预检:扫最近批次统计将新增的必改
      resolveBatchRelativePath,
      modeDeliveryExportService,
      lotteDeptDeliveryExportService,
      reviewConfigResolver, // P3b 冲突检查v2:有效审核集
      queryLedgerRows,
      executeService: createExportPlanExecuteService({
        resolveBatchRelativePath,
        queryLedgerRows, // 与预览同一引用(防副本漂移)
      }),
    },
    // 覆盖率:团号表 distinct 模式串(表没建=空列表不拦;0024 已建 mode 索引,
    // 再加 60s 缓存保险带——DatabaseSync 同步查询,别让 admin 刷页反复扫大表)
    listGroupCodeModes: (() => {
      let cached = null
      let cachedAt = 0
      return () => {
        const now = Date.now()
        if (cached && now - cachedAt < 60_000) return cached
        try {
          cached = monthlyDb.prepare(
            "SELECT DISTINCT mode FROM group_code WHERE mode IS NOT NULL AND TRIM(mode) != ''"
          ).all().map((row) => row.mode)
        } catch {
          cached = []
        }
        cachedAt = now
        return cached
      }
    })(),
  })
  configConsoleRoutes.register(app)

  // 资料库交付页(2026-07-16 P0):计划列表(注册表同源)+ 按批次 dry-run 预检;
  // 登录即可,owner 隔离靠 assertBatchAccess(操作员只看/预检自己的批次)
  createLibraryDeliveryRoutes({
    modeConfigRepository,
    auth,
    deps: {
      loadBatch,
      modeDeliveryExportService,
      lotteDeptDeliveryExportService,
      hyundaiDeliveryExportService,
      batchCustomerDataExportService,
      libraryModeExportService,
      resolveBatchRelativePath,
      dailyReceiptRepo: monthlyDailyReceiptRepo, // 五问题#3/#4:有夹无行预检查台账行存在性
    },
  }).register(app)

  // #4 系统喊疼:前端未捕获异常上报 + admin 疼点快照;小时摘要计时器(有异常才打 ops_digest)
  createClientErrorRoutes({ auth, logger: stallLogger }).register(app)
  opsMetrics.startHourlyDigest()


  // 工作台首页聚合接口(今日待办/今日进度/本月进度)
  const workbenchOverviewService = createWorkbenchOverviewService({
    listBatches,
    monthlyWorkspaceService,
    dailyReceiptRepo: monthlyDailyReceiptRepo,
    missingReceiptRepo: monthlyMissingReceiptRepo,
    pendingReviewRepo: monthlyPendingReviewRepo,
    billMatchLogRepo: monthlyBillMatchLogRepo,
    customerLibraryRepository,
  })
  const workbenchOverviewRoutes = createWorkbenchOverviewRoutes({
    overviewService: workbenchOverviewService,
    auth,
  })
  workbenchOverviewRoutes.register(app)

  // 审计H2(2026-07-16):后置注册的路由(admin/config/library-delivery/overview 等)排在
  // create_app 内错误处理器之后,其错误会漏到 Express 默认 finalhandler → 补尾部 JSON 处理器根治(纯追加)。
  app.use(createApiErrorMiddleware({ logger: stallLogger, opsMetrics }))

  const server = app.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? 'localhost' : host
    console.log(`[workbench] http://${displayHost}:${port}/app/`)
    console.log(`[workbench] login => http://${displayHost}:${port}/login`)
    console.log(`[workbench] files => ${WORKBENCH_ROOT}`)
    console.log(`[workbench] bind => ${host}:${port}`)
    console.log(
      `[workbench] model pipeline => enabled=${MODEL_ARTIFACT_REGISTRY.enabled}, splitReady=${MODEL_ARTIFACT_REGISTRY.detection.ready}, classificationReady=${MODEL_ARTIFACT_REGISTRY.classification.ready}, passportFieldReady=${MODEL_ARTIFACT_REGISTRY.passportFieldDetection.ready}, receiptFieldReady=${MODEL_ARTIFACT_REGISTRY.receiptFieldDetection.ready}`
    )
    try {
      syncAllBatchesToSqlite()
    } catch (error) {
      console.error('[workbench] Failed to bootstrap SQLite mirror', error)
    }
    resumeIncompleteBatches({
      listBatchIds: batchRepository.listBatchIds,
      loadBatch,
    })
    // B6(2026-07-21):重启把飞行中的团号表解析/上传杀死后,'parsing'/'awaiting_upload'
    // 无人再改 → 批次永卡、结算按钮永久禁用。开机如实标 failed,操作员换团号表即恢复。
    customerBatchBridgeService.recoverInterruptedGroupCodeImports()
      .then((n) => { if (n > 0) console.warn(`[workbench] 团号表中断恢复:${n} 个批次标 failed 待重传`) })
      .catch((error) => console.error('[workbench] 团号表中断恢复扫描失败', error))
    // B8(2026-07-21):签字内存队列重启即空,粘滞的 queued/generating 永卡且 409 拦重排。
    // 开机复位这些陈旧态,重排通道恢复。
    signatureJobService.recoverInterruptedSignatureJobs({ listBatchIds: batchRepository.listBatchIds })
      .catch((error) => console.error('[workbench] 签字任务中断恢复扫描失败', error))
    // 客户预处理中断恢复(审计MEDIUM):重启杀死飞行中的 preprocess 后,客户永挂 'processing'、
    // 永不自动入批次。开机把残留 'processing' 标 'error' 待重识别。
    try {
      const n = customerDocumentPreprocessService.recoverInterruptedPreprocess()
      if (n > 0) console.warn(`[workbench] 客户预处理中断恢复:${n} 个客户标 error 待重识别`)
    } catch (error) {
      console.error('[workbench] 客户预处理中断恢复扫描失败', error)
    }
  })
  const httpRequestTimeoutMs = resolveHttpRequestTimeoutMs()
  server.requestTimeout = httpRequestTimeoutMs
  console.log(`[workbench] http request timeout => ${httpRequestTimeoutMs}ms`)

  // Graceful shutdown — drain order matters:
  //   1. pending_batch_writes  flush in-progress batch JSON writes
  //   2. python_pool           kill OCR workers (Python child procs)
  //   3. monthly_db            close SQLite handle
  // 之前 python pool 自己注册 SIGTERM 直接 destroy，会在 (1) 还在 flush 时
  // 把 worker 干掉，pending 请求挂死直到 PM2 SIGKILL。现在统一在协调器
  // 顺序调用，避免 race。
  const shutdownCoordinator = createShutdownCoordinator({ server })

  scheduler.registerStageRetry({
    stageRetryService,
    intervalMs: 60_000,
    shutdownCoordinator,
  })

  // 批次停摆看门狗(2026-07-08 四批次静默悬死事故):processBatch 协程在生产并发下
  // 于 chunk 间隙悬死,零报错零超时,双守卫(调度器内部 Set + 服务器级 activeBatches)
  // 被永久占用,追加触发的 scheduleBatch 全被吞,批次永远"等待识别"。
  // 自愈:周期扫描「有积压任务 + 落盘识别进度超阈值没动 + 不在排队队列」的批次,
  // 强制释放双守卫(run-token 防僵尸复活误删)→ 重新调度 → batch_stall_revived 大声记日志。
  // 候选筛选走 listBatches 摘要(mtime 缓存后极便宜),停摆判定 loadBatch 读落盘原值。
  scheduler.registerStallWatchdog({
    intervalMs: Math.max(30_000, Number.parseInt(String(process.env.WORKBENCH_STALL_SWEEP_MS || 120_000), 10) || 120_000),
    shutdownCoordinator,
    listBatchSummaries: () => batchRepository.listBatches(),
    loadBatch: (batchId) => batchRepository.loadBatch(batchId),
    processorForceRelease: (batchId) => {
      const held = activeBatches.has(batchId)
      activeBatches.delete(batchId)
      return held
    },
    stallThresholdMs: Math.max(60_000, Number.parseInt(String(process.env.WORKBENCH_STALL_THRESHOLD_MS || 300_000), 10) || 300_000),
    log: (msg, fields) => stallLogger.warn(msg, fields),
  })

  // 代理视图投影准实时刷新(2026-07-24 止血):投影只在启动/删批/手动 rebuild 时更新,审核动作
  // 本身不刷 → 页面数字冻在上次刷新时刻(实测滞后数小时,期间审核全不算)。应用内定期**增量**刷新:
  // 每 intervalMs 扫批次 batch.json mtime,只重新同步"上次刷新后改动过"的批次(syncBatch 按批次
  // scoped,同步子集不动别的批次)。默认 2 分钟;AGENT_WS_SYNC_INTERVAL_MS<=0 关闭。
  let lastProjectionSyncMs = Date.now() // 启动已全量同步,水位从现在起
  const projectionMtimeOf = (batchId) => {
    try { return fs.statSync(batchRepository.batchJsonPath(batchId)).mtimeMs } catch { return 0 }
  }
  const projectionRefreshScheduler = createProjectionRefreshScheduler({
    intervalMs: Number.parseInt(String(process.env.AGENT_WS_SYNC_INTERVAL_MS || 120_000), 10) || 120_000,
    logger: stallLogger,
    runOnce: () => {
      const scanStartMs = Date.now()
      const changed = pickChangedBatchIds({
        batchIds: batchRepository.listBatchIds(),
        mtimeOf: projectionMtimeOf,
        sinceMs: lastProjectionSyncMs,
      })
      const res = refreshChangedBatches({
        changedBatchIds: changed,
        loadBatch,
        syncBatches: sqliteSyncService.syncBatches,
        logger: stallLogger,
      })
      lastProjectionSyncMs = scanStartMs // 下一轮抓 scanStart 之后改的(至多重扫一次,不漏)
      if (res.synced > 0) stallLogger.info?.('projection_refresh_done', { synced: res.synced, failedLoad: res.failedLoad })
    },
  }).start()
  shutdownCoordinator.registerDrain('projection_refresh', async () => {
    projectionRefreshScheduler.stop()
  })

  shutdownCoordinator.registerDrain('workflow_task_reconciler', async () => {
    workflowTaskReconciler.stop()
  })
  shutdownCoordinator.registerDrain('pending_batch_writes', async () => {
    const pendingWrites = batchRepository.getPendingBatchWrites()
    if (pendingWrites.length > 0) {
      await Promise.allSettled(pendingWrites)
    }
  })

  shutdownCoordinator.registerDrain('python_pool', async () => {
    await destroyPythonPool()
  })

  shutdownCoordinator.registerDrain('monthly_db', async () => {
    try {
      monthlyDb.close?.()
    } catch {
      /* best effort */
    }
  })

  shutdownCoordinator.registerDrain('single_instance_lock', async () => {
    runtimeInstanceLock?.release()
    runtimeInstanceLock = null
  })

  shutdownCoordinator.installSignalHandlers()

  return server
}

function handleStartupFailure(error) {
  runtimeInstanceLock?.release()
  runtimeInstanceLock = null
  console.error('[workbench] Failed to start', error)
  process.exitCode = 1
}

if (require.main === module) {
  startWorkbenchServer().catch(handleStartupFailure)
}

module.exports = {
  handleStartupFailure,
  startWorkbenchServer,
}
