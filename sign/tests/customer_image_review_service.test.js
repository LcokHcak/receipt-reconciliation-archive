const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createCustomerImageReviewService } = require('../services/customer_image_review_service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-image-review-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function createRepository(tempRoot) {
  return createCustomerLibraryRepository({
    defaultRoot: path.join(tempRoot, 'library'),
    settingsPath: path.join(tempRoot, 'settings.json'),
    nowProvider: () => new Date('2026-04-27T10:00:00+09:00'),
  });
}

function createCustomerWithImages(repository, workspaceKey = '0427-test') {
  const customer = repository.createCustomerFolder({
    workspaceKey,
    customerId: 'CL20260427-001',
    agentName: 'Agent Kim',
    images: [],
  });
  const customerDir = repository.customerDir(workspaceKey, customer.customerId);
  const imagesDir = path.join(customerDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, '01-original.jpg'), 'original');
  fs.writeFileSync(path.join(imagesDir, '02-receipt.jpg'), 'receipt');

  return repository.saveCustomer({
    ...customer,
    preprocess: {
      status: 'processed',
      inputImages: 1,
      outputImages: 2,
      splitImages: 1,
      failedImages: 0,
      processedAt: '2026-04-27T01:00:00.000Z',
    },
    images: [
      {
        imageId: 'img_001',
        originalFileName: 'mixed.jpg',
        relativePath: 'images/01-original.jpg',
        source: 'uploaded_original',
        autoSplitRole: 'original',
        sortOrder: 1,
      },
      {
        imageId: 'img_002',
        originalFileName: 'mixed.jpg',
        relativePath: 'images/02-receipt.jpg',
        source: 'uploaded_split',
        autoSplitRole: 'region',
        docTypeHint: 'receipt',
        docTypeConfidence: 0.92,
        sortOrder: 2,
      },
    ],
  });
}

test('removeCustomerImage deletes an auto-split region but keeps the original image', async () => {
  const tempRoot = makeTempDir();

  try {
    const repository = createRepository(tempRoot);
    const customer = createCustomerWithImages(repository);
    const service = createCustomerImageReviewService({ customerLibraryRepository: repository });

    const result = await service.removeCustomerImage({
      workspaceKey: customer.workspaceKey,
      customerId: customer.customerId,
      imageId: 'img_002',
    });

    assert.equal(result.customer.images.length, 1);
    assert.equal(result.customer.images[0].imageId, 'img_001');
    assert.equal(result.customer.preprocess.outputImages, 1);
    assert.equal(result.customer.preprocess.splitImages, 0);
    assert.equal(fs.existsSync(path.join(repository.customerDir(customer.workspaceKey, customer.customerId), 'images/02-receipt.jpg')), false);
    assert.equal(fs.existsSync(path.join(repository.customerDir(customer.workspaceKey, customer.customerId), 'images/01-original.jpg')), true);
  } finally {
    cleanup(tempRoot);
  }
});

test('removeCustomerImage rejects deleting preserved original images', async () => {
  const tempRoot = makeTempDir();

  try {
    const repository = createRepository(tempRoot);
    const customer = createCustomerWithImages(repository);
    const service = createCustomerImageReviewService({ customerLibraryRepository: repository });

    await assert.rejects(
      service.removeCustomerImage({
        workspaceKey: customer.workspaceKey,
        customerId: customer.customerId,
        imageId: 'img_001',
      }),
      /Only auto-split region images can be removed/
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('confirmCustomerImage marks a reviewable image as accepted without touching the original', async () => {
  const tempRoot = makeTempDir();

  try {
    const repository = createRepository(tempRoot);
    const customer = createCustomerWithImages(repository);
    const service = createCustomerImageReviewService({ customerLibraryRepository: repository });

    const result = await service.confirmCustomerImage({
      workspaceKey: customer.workspaceKey,
      customerId: customer.customerId,
      imageId: 'img_002',
      status: 'accepted',
    });

    assert.equal(result.customer.images.length, 2);
    assert.equal(result.image.reviewStatus, 'accepted');
    assert.equal(result.image.reviewSource, 'manual_file_review');
    assert.match(result.image.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.customer.images[0].reviewStatus, undefined);
    assert.equal(fs.existsSync(path.join(repository.customerDir(customer.workspaceKey, customer.customerId), 'images/01-original.jpg')), true);
  } finally {
    cleanup(tempRoot);
  }
});
