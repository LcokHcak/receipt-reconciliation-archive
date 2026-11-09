const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');

const { buildCropRect } = require('../lib/document_crop_geometry');

function createDocumentSplitService({
  detector,
  paddingPct = 0.02,
} = {}) {
  async function splitImage({
    sourcePath,
    imagesDir,
    originalFileName,
    startIndex = 0,
    buildFileName,
  } = {}) {
    if (!detector || typeof detector.detectRegions !== 'function') {
      return { splitApplied: false, outputs: [] };
    }

    const detection = await detector.detectRegions({ imagePath: sourcePath });
    if (!detection.splitRecommended || !Array.isArray(detection.regions) || detection.regions.length < 2) {
      return { splitApplied: false, outputs: [] };
    }

    fs.mkdirSync(imagesDir, { recursive: true });
    const metadata = await sharp(sourcePath).metadata();
    const outputs = [];
    let outputIndex = Number.parseInt(String(startIndex || 0), 10) || 0;

    const originalName = buildFileName(outputIndex, originalFileName, '_original');
    fs.copyFileSync(sourcePath, path.join(imagesDir, originalName));
    outputs.push({
      fileName: originalName,
      originalFileName,
      source: 'uploaded_original',
      autoSplit: true,
      autoSplitRole: 'original',
      docTypeHint: '',
      docTypeConfidence: 0,
      modelMeta: detection.modelMeta || null,
    });
    outputIndex += 1;

    for (let index = 0; index < detection.regions.length; index += 1) {
      const region = detection.regions[index];
      const suffix = `_${region.docType || 'region'}_${index + 1}`;
      const fileName = buildFileName(outputIndex, originalFileName, suffix);
      const cropRect = buildCropRect(region.box || {}, metadata, paddingPct);
      await sharp(sourcePath)
        .extract(cropRect)
        .toFile(path.join(imagesDir, fileName));
      outputs.push({
        fileName,
        originalFileName,
        source: 'uploaded_split',
        autoSplit: true,
        autoSplitRole: 'region',
        docTypeHint: region.docType || '',
        docTypeConfidence: Number(region.confidence || 0),
        detectionBox: region.box || null,
        modelMeta: detection.modelMeta || null,
      });
      outputIndex += 1;
    }

    return {
      splitApplied: true,
      outputs,
    };
  }

  return {
    splitImage,
  };
}

module.exports = {
  buildCropRect,
  createDocumentSplitService,
};
