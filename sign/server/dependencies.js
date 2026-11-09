const path = require('path');
const fs = require('fs');

const multer = require('multer');

const { createModelArtifactRegistry } = require('../lib/model_artifact_registry');
const { ensureDir } = require('../lib/workbench_utils');

function resolveUploadMaxFileSizeMb(value = process.env.SIGN_UPLOAD_MAX_MB) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

function isOfficeTempUpload(file = {}) {
  return path.basename(String(file.originalname || '')).startsWith('~$');
}

// jpg/png/webp 全链路直接支持;heic/heif(iPhone 默认)由 intake 的 normalizeHeicUploads
// 在落盘前转成 jpg,所以这里放行(浏览器/审核台不能直接显示 heic,靠那步转码兜住)。
const DEFAULT_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
// 无扩展名/扩展名被剥的文件(如手机导出的 4c5318… 哈希名),按浏览器给的 MIME 兜底放行。
// heic/heif 一并放行(intake 会转 jpg);其余非图片/脚本仍拒。
const SAFE_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

function createUploadFileFilter({ allowedExtensions } = {}) {
  const allow =
    allowedExtensions instanceof Set ? allowedExtensions : new Set(DEFAULT_IMAGE_EXTENSIONS);
  return (_req, file, cb) => {
    if (isOfficeTempUpload(file)) {
      const error = new Error('请不要上传 Office 临时文件（~$ 开头），请关闭 Excel 后选择正式文件。');
      error.code = 'OFFICE_TEMP_FILE';
      return cb(error);
    }
    // 只允许图片和 Excel 落盘。非白名单类型(.php/.exe/.html/.svg 等)静默丢弃,
    // 不中断整批上传——保持与历史行为一致(夹带的 thumbs.db/.txt 本就被忽略),
    // 但杜绝可执行/脚本文件写入磁盘。伪装成 .jpg 的非图片由下游 sharp 处理时拒绝。
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (allow.has(ext)) {
      return cb(null, true);
    }
    // 无扩展名/扩展名被剥,但 MIME 是全链路支持的图片 → 放行(覆盖手机哈希名图片)。
    const mime = String(file.mimetype || '').toLowerCase();
    if (!ext && SAFE_IMAGE_MIME.has(mime)) {
      return cb(null, true);
    }
    return cb(null, false);
  };
}

function createWorkbenchDependencies({
  projectRoot,
  defaultPort = 3218,
  defaultHost = '127.0.0.1',
  defaultScenario = 'FullProcess',
  excelExtensions = [],
  paddleMaxSide = 0,
} = {}) {
  if (!projectRoot) {
    throw new Error('projectRoot is required');
  }

  const workbenchRoot = path.join(projectRoot, 'passport_review_workbench');
  const appDir = path.join(workbenchRoot, 'app');
  const storageRoot = path.join(workbenchRoot, 'storage');
  const batchesRoot = path.join(storageRoot, 'batches');
  const workbenchDbPath = path.join(storageRoot, 'workbench.sqlite');
  const tmpUploadRoot = path.join(storageRoot, 'tmp_uploads');
  const customerLibrarySettingsPath = path.join(storageRoot, 'customer_library.settings.json');
  const defaultCustomerLibraryRoot = path.join(storageRoot, 'customer_library');
  const preferredTemplatePath = process.env.CUSTOMER_RECEIPT_TEMPLATE_PATH
    || path.join(process.env.USERPROFILE || '', 'Desktop', '账单模板.xlsx');
  const customerTemplatePath = fs.existsSync(preferredTemplatePath)
    ? preferredTemplatePath
    : path.join(workbenchRoot, 'templates', 'customer-receipt-template.xlsx');

  [
    workbenchRoot,
    appDir,
    storageRoot,
    batchesRoot,
    tmpUploadRoot,
  ].forEach(ensureDir);

  const uploadMaxFileSizeMb = resolveUploadMaxFileSizeMb();

  // 上传白名单 = 图片 + 调用方传入的 Excel 扩展名(全部小写)
  const uploadAllowedExtensions = new Set([
    ...DEFAULT_IMAGE_EXTENSIONS,
    ...(Array.isArray(excelExtensions) ? excelExtensions : []).map((e) => String(e).toLowerCase()),
  ]);

  return {
    projectRoot,
    workbenchRoot,
    appDir,
    storageRoot,
    batchesRoot,
    workbenchDbPath,
    tmpUploadRoot,
    customerLibrarySettingsPath,
    defaultCustomerLibraryRoot,
    customerTemplatePath,
    defaultPort,
    defaultHost,
    defaultScenario,
    supportedExtensions: new Set(['.jpg', '.jpeg', '.png']),
    supportedAttachmentExtensions: new Set(excelExtensions),
    ocrOwnedSignatureSources: new Set(['region_capture', 'local_fallback']),
    paddleOcrOptions: Object.freeze({
      lang: 'ch',
      maxSide: paddleMaxSide,
      useAngleCls: false,
    }),
    modelArtifactRegistry: createModelArtifactRegistry({ projectRoot }),
    paddleBatchChunkSize: Math.max(
      1,
      Number.parseInt(String(process.env.PADDLE_BATCH_CHUNK_SIZE || 5), 10) || 5
    ),
    uploadMaxFileSizeMb,
    upload: multer({
      dest: tmpUploadRoot,
      fileFilter: createUploadFileFilter({ allowedExtensions: uploadAllowedExtensions }),
      limits: {
        files: 3000,
        fileSize: uploadMaxFileSizeMb * 1024 * 1024,
      },
    }),
  };
}

module.exports = {
  createUploadFileFilter,
  createWorkbenchDependencies,
  isOfficeTempUpload,
  resolveUploadMaxFileSizeMb,
};
