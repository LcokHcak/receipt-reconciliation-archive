const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  deriveSourceGroupFolderPath,
  detectImportRootFolder,
  normalizeUploadManifestEntries,
  resolveUploadedRelativePath,
  splitUploadRelativePath,
  upsertSourceGroup,
} = require('../lib/source_group_utils');
const { sanitizeAsciiFileComponent } = require('../lib/workbench_utils');
const { buildOwnerMetadata } = require('../lib/operator_scope');
const { normalizeUploadImages } = require('../lib/heic_normalize');

function defaultRandomId(length = 8) {
  return crypto.randomUUID().slice(0, length);
}

function removeUploadedFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function addAttachmentToSourceGroup(sourceGroup, attachment) {
  if (!sourceGroup) {
    return;
  }
  sourceGroup.attachmentFiles = Array.isArray(sourceGroup.attachmentFiles)
    ? sourceGroup.attachmentFiles
    : [];
  sourceGroup.attachmentFiles.push(attachment);
}

function createWorkbenchBatchImportHandlers({
  buildBatchSkeleton,
  batchSubdirs,
  createImportedImageTask,
  saveBatchAsync,
  scheduleBatch,
  summarizeBatch,
  nowStamp,
  randomId = defaultRandomId,
  supportedExtensions,
  supportedAttachmentExtensions,
  defaultScenario = 'FullProcess',
}) {
  async function importBatch(req, res) {
    const rawFiles = Array.isArray(req.files) ? req.files : [];
    const uploadManifest = normalizeUploadManifestEntries(req.body?.uploadManifest);
    // manifest 按「原始下标」匹配。先把每个文件的相对路径解析出来挂到 file 上,再做 heic 转码——
    // 转码可能丢弃解不了的坏 heic 导致数组变短、下标错位,提前锁定路径就不受影响。
    rawFiles.forEach((file, index) => {
      file.uploadRelPath = resolveUploadedRelativePath(file, uploadManifest, index);
    });
    // HEIC/HEIF(iPhone)转 jpg,再走 isImage 判定与落盘(浏览器/审核台不能显示 heic)。
    const files = await normalizeUploadImages(rawFiles);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const stamp = nowStamp();
    const batchId = `batch_${stamp}_${randomId(8)}`;
    const batchName = req.body?.batchName || `Batch ${stamp}`;
    const scenario = req.body?.scenario || defaultScenario;
    const batch = buildBatchSkeleton(batchId, batchName, scenario);
    const ownerMetadata = buildOwnerMetadata(req.user || null);
    Object.assign(batch, ownerMetadata);
    const dirs = batchSubdirs(batchId);
    const normalizedUploadPaths = files
      .map((file) => file.uploadRelPath)
      .filter(Boolean);
    const importRootFolder = detectImportRootFolder(normalizedUploadPaths);

    let taskIndex = 0;
    files.forEach((file) => {
      const uploadPath = splitUploadRelativePath(file.uploadRelPath || file.originalname || '');
      // 格式判定/落盘扩展名以「转码后的实际文件」为准(heic 已转成 file.originalname=*.jpg),
      // 而 manifest 里仍是 .heic;目录结构仍用 uploadPath。
      const ext = path.extname(file.originalname || uploadPath.fileName || '').toLowerCase();
      const isImage = supportedExtensions.has(ext);
      const isAttachment = supportedAttachmentExtensions.has(ext);
      if (!isImage && !isAttachment) {
        removeUploadedFile(file.path);
        return;
      }

      const sourceGroupFolderPath = deriveSourceGroupFolderPath(uploadPath.normalizedPath, importRootFolder);
      const sourceGroup = upsertSourceGroup(batch, sourceGroupFolderPath);

      if (isImage) {
        taskIndex += 1;
        const taskId = `task_${String(taskIndex).padStart(4, '0')}_${randomId(6)}`;
        // baseName 用 manifest 文件名去掉它自己的扩展名(可能是 .heic),再拼上实际扩展名(.jpg)。
        const manifestName = uploadPath.fileName || file.originalname || '';
        const baseName = sanitizeAsciiFileComponent(
          path.basename(manifestName, path.extname(manifestName)),
          taskId
        ) || taskId;
        const sourceFileName = `${taskId}__${baseName}${ext}`;
        fs.renameSync(file.path, path.join(dirs.source, sourceFileName));
        batch.tasks.push(createImportedImageTask({
          taskId,
          originalFileName: file.originalname,
          sourceImagePath: path.join('source', sourceFileName),
          sourceOriginalPath: uploadPath.normalizedPath || file.originalname || sourceFileName,
          sourceFileName: uploadPath.fileName || path.basename(file.originalname || sourceFileName),
          sourceFolderName: sourceGroup.label,
          sourceFolderPath: sourceGroup.folderPath,
          sourceGroupKey: sourceGroup.key,
          sourceGroupLabel: sourceGroup.label,
          customerOwnerUserId: ownerMetadata.ownerUserId,
          customerOwnerUsername: ownerMetadata.ownerUsername,
        }));
        return;
      }

      const attachmentId = `attachment_${randomId(8)}`;
      const attachmentBaseName = sanitizeAsciiFileComponent(
        path.basename(uploadPath.fileName || file.originalname || '', ext),
        attachmentId
      ) || attachmentId;
      const storedAttachmentName = `${attachmentId}__${attachmentBaseName}${ext}`;
      const storedRelativePath = path.join('attachments', storedAttachmentName);
      fs.renameSync(file.path, path.join(dirs.attachments, storedAttachmentName));
      addAttachmentToSourceGroup(sourceGroup, {
        id: attachmentId,
        originalFileName: uploadPath.fileName || file.originalname || storedAttachmentName,
        storedRelativePath,
        extension: ext,
      });
    });

    if (batch.tasks.length === 0) {
      fs.rmSync(dirs.root, { recursive: true, force: true });
      return res.status(400).json({ error: 'No supported image files found' });
    }

    await saveBatchAsync(batch);
    scheduleBatch(batchId, { priority: true }); // 操作员在等,插队到补识别前面

    return res.json({
      ok: true,
      batchId,
      batch: summarizeBatch(batch, { includeTasks: true }),
    });
  }

  return {
    importBatch,
  };
}

module.exports = {
  createWorkbenchBatchImportHandlers,
};
