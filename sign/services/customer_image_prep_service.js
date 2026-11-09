const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');

const { ensureDir, sanitizeAsciiFileComponent, decodeMultipartFilename } = require('../lib/workbench_utils');

function clampPercent(value, min = 0, max = 0.9) {
  const numeric = Number.parseFloat(String(value ?? 0));
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(max, Math.max(min, numeric));
}

function createCustomerImagePrepService({
  documentSplitService = null,
  enableAutoSplitOnUpload = false,
} = {}) {
  function normalizeCrop(crop = {}) {
    return {
      leftPct: clampPercent(crop.leftPct, 0, 0.9),
      rightPct: clampPercent(crop.rightPct, 0, 0.9),
      topPct: clampPercent(crop.topPct, 0, 0.9),
      bottomPct: clampPercent(crop.bottomPct, 0, 0.9),
    };
  }

  function buildFileName(index, originalname, suffix = '') {
    const parsed = path.parse(String(originalname || 'image.png'));
    const baseName = sanitizeAsciiFileComponent(parsed.name || '', `image_${index + 1}`) || `image_${index + 1}`;
    const ext = parsed.ext || '.png';
    return `${String(index + 1).padStart(2, '0')}-${baseName}${suffix}${ext}`;
  }

  function hasManualCrop(crop = {}) {
    return ['leftPct', 'rightPct', 'topPct', 'bottomPct']
      .some((key) => Number(crop[key] || 0) > 0);
  }

  function appendOutput(outputs, outputIndex, splitOutput = {}) {
    const fileName = String(splitOutput.fileName || '').trim();
    const record = {
      imageId: `img_${String(outputIndex).padStart(3, '0')}`,
      originalFileName: String(splitOutput.originalFileName || '').trim(),
      relativePath: path.posix.join('images', fileName),
      kind: 'document',
      source: String(splitOutput.source || 'uploaded').trim() || 'uploaded',
      sortOrder: outputIndex,
    };

    [
      'autoSplit',
      'autoSplitRole',
      'docTypeHint',
      'docTypeConfidence',
      'detectionBox',
      'modelMeta',
    ].forEach((key) => {
      if (splitOutput[key] !== undefined) {
        record[key] = splitOutput[key];
      }
    });

    outputs.push(record);
  }

  async function writeSingleOutput(sourcePath, targetPath, rect) {
    await sharp(sourcePath)
      .extract(rect)
      .toFile(targetPath);
  }

  async function moveUploadFile(sourcePath, targetPath) {
    try {
      await fs.promises.rename(sourcePath, targetPath);
    } catch (error) {
      if (error?.code !== 'EXDEV') {
        throw error;
      }
      await fs.promises.copyFile(sourcePath, targetPath);
      await fs.promises.rm(sourcePath, { force: true });
    }
  }

  async function prepareCustomerImages({ customerPath, files = [], editManifest = [], startIndex = 0 }) {
    const imagesDir = path.join(customerPath, 'images');
    ensureDir(imagesDir);

    const outputs = [];
    let outputIndex = Math.max(0, Number.parseInt(String(startIndex || 0), 10) || 0);

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      // 还原 multipart 中文/韩文文件名(busboy latin1 误码),否则「原始文件」显示成乱码
      if (file && file.originalname) file.originalname = decodeMultipartFilename(file.originalname);
      const manifest = editManifest[fileIndex] || {};
      const mode = String(manifest.mode || 'keep').trim() || 'keep';

      if (mode === 'delete') {
        if (file?.path && fs.existsSync(file.path)) {
          fs.rmSync(file.path, { force: true });
        }
        continue;
      }

      const sourcePath = String(file?.path || '').trim();
      const crop = normalizeCrop(manifest.crop);
      const shouldStoreOriginal =
        (mode === 'keep' || mode === 'single')
        && !hasManualCrop(crop);

      if (shouldStoreOriginal) {
        if (
          enableAutoSplitOnUpload
          && documentSplitService
        ) {
          try {
            const splitResult = await documentSplitService.splitImage({
              sourcePath,
              imagesDir,
              originalFileName: String(file?.originalname || '').trim(),
              startIndex: outputIndex,
              buildFileName,
            });
            if (splitResult?.splitApplied && Array.isArray(splitResult.outputs) && splitResult.outputs.length) {
              splitResult.outputs.forEach((splitOutput) => {
                outputIndex += 1;
                appendOutput(outputs, outputIndex, {
                  ...splitOutput,
                  originalFileName: splitOutput.originalFileName || String(file?.originalname || '').trim(),
                });
              });
              if (file?.path && fs.existsSync(file.path)) {
                fs.rmSync(file.path, { force: true });
              }
              continue;
            }
          } catch {
            // Model-assisted splitting is optional. Keep the upload path reliable.
          }
        }

        outputIndex += 1;
        const fileName = buildFileName(outputIndex - 1, file?.originalname);
        await moveUploadFile(sourcePath, path.join(imagesDir, fileName));
        outputs.push({
          imageId: `img_${String(outputIndex).padStart(3, '0')}`,
          originalFileName: String(file?.originalname || '').trim(),
          relativePath: path.posix.join('images', fileName),
          kind: 'document',
          source: 'uploaded',
          sortOrder: outputIndex,
        });
        continue;
      }

      const metadata = await sharp(sourcePath).metadata();
      const left = Math.round((metadata.width || 0) * crop.leftPct);
      const right = Math.round((metadata.width || 0) * crop.rightPct);
      const top = Math.round((metadata.height || 0) * crop.topPct);
      const bottom = Math.round((metadata.height || 0) * crop.bottomPct);
      const width = Math.max(1, (metadata.width || 1) - left - right);
      const height = Math.max(1, (metadata.height || 1) - top - bottom);
      const rect = { left, top, width, height };

      if (mode === 'split') {
        const splitPct = clampPercent(manifest.splitPct, 0.1, 0.9);
        const topHeight = Math.max(1, Math.round(height * splitPct));
        const bottomHeight = Math.max(1, height - topHeight);

        outputIndex += 1;
        const topFileName = buildFileName(outputIndex - 1, file?.originalname, '_top');
        await writeSingleOutput(sourcePath, path.join(imagesDir, topFileName), {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: topHeight,
        });
        outputs.push({
          imageId: `img_${String(outputIndex).padStart(3, '0')}`,
          originalFileName: String(file?.originalname || '').trim(),
          relativePath: path.posix.join('images', topFileName),
          kind: 'document',
          source: 'uploaded',
          sortOrder: outputIndex,
        });

        outputIndex += 1;
        const bottomFileName = buildFileName(outputIndex - 1, file?.originalname, '_bottom');
        await writeSingleOutput(sourcePath, path.join(imagesDir, bottomFileName), {
          left: rect.left,
          top: rect.top + topHeight,
          width: rect.width,
          height: bottomHeight,
        });
        outputs.push({
          imageId: `img_${String(outputIndex).padStart(3, '0')}`,
          originalFileName: String(file?.originalname || '').trim(),
          relativePath: path.posix.join('images', bottomFileName),
          kind: 'document',
          source: 'uploaded',
          sortOrder: outputIndex,
        });
      } else {
        outputIndex += 1;
        const fileName = buildFileName(outputIndex - 1, file?.originalname);
        await writeSingleOutput(sourcePath, path.join(imagesDir, fileName), rect);
        outputs.push({
          imageId: `img_${String(outputIndex).padStart(3, '0')}`,
          originalFileName: String(file?.originalname || '').trim(),
          relativePath: path.posix.join('images', fileName),
          kind: 'document',
          source: 'uploaded',
          sortOrder: outputIndex,
        });
      }

      if (file?.path && fs.existsSync(file.path)) {
        fs.rmSync(file.path, { force: true });
      }
    }

    return outputs;
  }

  return {
    prepareCustomerImages,
  };
}

module.exports = {
  createCustomerImagePrepService,
};
