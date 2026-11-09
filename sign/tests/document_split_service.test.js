const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const { createDocumentSplitService } = require('../services/document_split_service');
const { DOC_TYPES } = require('../lib/package_constants');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'document-split-'));
}

async function createImage(filePath, width, height, color) {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  }).png().toFile(filePath);
}

function buildFileName(index, originalName, suffix = '') {
  return `${String(index + 1).padStart(2, '0')}-${path.parse(originalName).name}${suffix}.png`;
}

test('document split service keeps the original image and writes detected region crops', async () => {
  const tempRoot = makeTempDir();

  try {
    const sourcePath = path.join(tempRoot, 'mix.png');
    const imagesDir = path.join(tempRoot, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    await createImage(sourcePath, 100, 50, '#ffffff');

    const service = createDocumentSplitService({
      detector: {
        detectRegions: async () => ({
          splitRecommended: true,
          regions: [
            {
              docType: DOC_TYPES.PASSPORT,
              confidence: 0.91,
              label: 'passport_region',
              box: { left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50 },
            },
            {
              docType: DOC_TYPES.RECEIPT,
              confidence: 0.88,
              label: 'receipt_region',
              box: { left: 50, top: 0, right: 100, bottom: 50, width: 50, height: 50 },
            },
          ],
        }),
      },
      paddingPct: 0,
    });

    const result = await service.splitImage({
      sourcePath,
      imagesDir,
      originalFileName: 'mix.png',
      startIndex: 0,
      buildFileName,
    });

    assert.equal(result.splitApplied, true);
    assert.deepEqual(
      result.outputs.map((output) => output.autoSplitRole),
      ['original', 'region', 'region']
    );
    assert.deepEqual(
      result.outputs.map((output) => output.docTypeHint),
      ['', DOC_TYPES.PASSPORT, DOC_TYPES.RECEIPT]
    );

    const passportMeta = await sharp(path.join(imagesDir, result.outputs[1].fileName)).metadata();
    const receiptMeta = await sharp(path.join(imagesDir, result.outputs[2].fileName)).metadata();
    assert.equal(passportMeta.width, 50);
    assert.equal(passportMeta.height, 50);
    assert.equal(receiptMeta.width, 50);
    assert.equal(receiptMeta.height, 50);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('document split service does not write files when the detector finds a single document', async () => {
  const tempRoot = makeTempDir();

  try {
    const sourcePath = path.join(tempRoot, 'single.png');
    const imagesDir = path.join(tempRoot, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    await createImage(sourcePath, 80, 80, '#eeeeee');

    const service = createDocumentSplitService({
      detector: {
        detectRegions: async () => ({
          splitRecommended: false,
          regions: [
            {
              docType: DOC_TYPES.PASSPORT,
              confidence: 0.9,
              box: { left: 0, top: 0, right: 80, bottom: 80, width: 80, height: 80 },
            },
          ],
        }),
      },
    });

    const result = await service.splitImage({
      sourcePath,
      imagesDir,
      originalFileName: 'single.png',
      startIndex: 0,
      buildFileName,
    });

    assert.equal(result.splitApplied, false);
    assert.deepEqual(result.outputs, []);
    assert.equal(fs.readdirSync(imagesDir).length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
