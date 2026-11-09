const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const { createCustomerImagePrepService } = require('../services/customer_image_prep_service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-image-prep-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
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

test('prepareCustomerImages crops a single output image from the selected margins', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 100, 80, '#ff0000');

    const service = createCustomerImagePrepService();
    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'passport.png' }],
      editManifest: [{
        mode: 'single',
        crop: { leftPct: 0.1, rightPct: 0.1, topPct: 0.125, bottomPct: 0.125 },
      }],
    });

    assert.equal(images.length, 1);
    assert.equal(images[0].relativePath, 'images/01-passport.png');
    const metadata = await sharp(path.join(customerPath, images[0].relativePath)).metadata();
    assert.equal(metadata.width, 80);
    assert.equal(metadata.height, 60);
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages can split one image into two outputs', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 120, 90, '#00ff00');

    const service = createCustomerImagePrepService();
    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'receipt.png' }],
      editManifest: [{
        mode: 'split',
        splitPct: 0.6,
        crop: { leftPct: 0, rightPct: 0, topPct: 0, bottomPct: 0 },
      }],
    });

    assert.equal(images.length, 2);
    const topMeta = await sharp(path.join(customerPath, images[0].relativePath)).metadata();
    const bottomMeta = await sharp(path.join(customerPath, images[1].relativePath)).metadata();
    assert.equal(topMeta.width, 120);
    assert.equal(topMeta.height, 54);
    assert.equal(bottomMeta.width, 120);
    assert.equal(bottomMeta.height, 36);
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages skips deleted files', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 120, 90, '#0000ff');

    const service = createCustomerImagePrepService();
    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'throwaway.png' }],
      editManifest: [{
        mode: 'delete',
      }],
    });

    assert.deepEqual(images, []);
    assert.equal(fs.existsSync(path.join(customerPath, 'images')), true);
    assert.equal(fs.readdirSync(path.join(customerPath, 'images')).length, 0);
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages stores default uploads without image decoding or automatic splitting', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'upload.tmp');
    const customerPath = path.join(tempRoot, 'customer');
    const rawBytes = Buffer.from('raw-upload-bytes-that-must-not-be-reencoded');
    fs.writeFileSync(inputPath, rawBytes);

    let splitCalls = 0;
    const service = createCustomerImagePrepService({
      documentSplitService: {
        splitImage: async () => {
          splitCalls += 1;
          throw new Error('upload must not split before preprocess');
        },
      },
    });

    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'receipt.jpg' }],
      editManifest: [{ mode: 'keep' }],
    });

    assert.equal(splitCalls, 0);
    assert.equal(images.length, 1);
    assert.equal(images[0].relativePath, 'images/01-receipt.jpg');
    assert.equal(images[0].source, 'uploaded');
    assert.deepEqual(fs.readFileSync(path.join(customerPath, images[0].relativePath)), rawBytes);
    assert.equal(fs.existsSync(inputPath), false);
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages delegates keep uploads only when upload auto split is explicitly enabled', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 120, 90, '#aaaaaa');

    let splitCall;
    const service = createCustomerImagePrepService({
      enableAutoSplitOnUpload: true,
      documentSplitService: {
        splitImage: async (options) => {
          splitCall = options;
          const fileName = options.buildFileName(options.startIndex, options.originalFileName, '_original');
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, fileName));
          return {
            splitApplied: true,
            outputs: [{
              fileName,
              originalFileName: options.originalFileName,
              source: 'uploaded_original',
              autoSplitRole: 'original',
            }],
          };
        },
      },
    });

    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'mix.png' }],
      editManifest: [{ mode: 'keep' }],
    });

    assert.equal(splitCall.originalFileName, 'mix.png');
    assert.equal(splitCall.startIndex, 0);
    assert.equal(images.length, 1);
    assert.equal(images[0].relativePath, 'images/01-mix_original.png');
    assert.equal(images[0].source, 'uploaded_original');
    assert.equal(images[0].autoSplitRole, 'original');
    assert.equal(fs.existsSync(inputPath), false);
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages delegates single uploads only when upload auto split is explicitly enabled', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 120, 90, '#cccccc');

    let splitCall;
    const service = createCustomerImagePrepService({
      enableAutoSplitOnUpload: true,
      documentSplitService: {
        splitImage: async (options) => {
          splitCall = options;
          const fileName = options.buildFileName(options.startIndex, options.originalFileName, '_original');
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, fileName));
          return {
            splitApplied: true,
            outputs: [{
              fileName,
              originalFileName: options.originalFileName,
              source: 'uploaded_original',
              autoSplitRole: 'original',
            }],
          };
        },
      },
    });

    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'front-default.png' }],
      editManifest: [{ mode: 'single' }],
    });

    assert.equal(splitCall.originalFileName, 'front-default.png');
    assert.equal(images.length, 1);
    assert.equal(images[0].relativePath, 'images/01-front-default_original.png');
    assert.equal(images[0].autoSplitRole, 'original');
  } finally {
    cleanup(tempRoot);
  }
});

test('prepareCustomerImages falls back to the original single output when explicitly enabled automatic split fails', async () => {
  const tempRoot = makeTempDir();

  try {
    const inputPath = path.join(tempRoot, 'input.png');
    const customerPath = path.join(tempRoot, 'customer');
    await createImage(inputPath, 64, 48, '#bbbbbb');

    const service = createCustomerImagePrepService({
      enableAutoSplitOnUpload: true,
      documentSplitService: {
        splitImage: async () => {
          throw new Error('paddlex unavailable');
        },
      },
    });

    const images = await service.prepareCustomerImages({
      customerPath,
      files: [{ path: inputPath, originalname: 'single.png' }],
      editManifest: [{ mode: 'keep' }],
    });

    assert.equal(images.length, 1);
    assert.equal(images[0].relativePath, 'images/01-single.png');
    assert.equal(images[0].source, 'uploaded');
    const metadata = await sharp(path.join(customerPath, images[0].relativePath)).metadata();
    assert.equal(metadata.width, 64);
    assert.equal(metadata.height, 48);
  } finally {
    cleanup(tempRoot);
  }
});
