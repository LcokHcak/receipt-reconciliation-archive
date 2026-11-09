const fsPromises = require('node:fs/promises');
const path = require('node:path');

const { ensureInsideRoot } = require('../lib/customer_library_paths');
const { assertRecordAccess } = require('../lib/operator_scope');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');

function normalizeImageOrder(images = []) {
  return images.map((image, index) => ({
    ...image,
    imageId: `img_${String(index + 1).padStart(3, '0')}`,
    sortOrder: index + 1,
  }));
}

function recomputePreprocessSummary(customer = {}, images = []) {
  if (!customer.preprocess) {
    return customer.preprocess;
  }
  return {
    ...customer.preprocess,
    outputImages: images.length,
    splitImages: images.filter((image) => image.autoSplitRole === 'region').length,
    failedImages: images.filter((image) => image.preprocessStatus === 'failed').length,
  };
}

function normalizeReviewStatus(status) {
  const nextStatus = String(status || 'accepted').trim() || 'accepted';
  if (nextStatus !== 'accepted') {
    throw new Error(`Unsupported customer image review status: ${nextStatus}`);
  }
  return nextStatus;
}

function createCustomerImageReviewService({ customerLibraryRepository } = {}) {
  if (!customerLibraryRepository) {
    throw new Error('customerLibraryRepository is required');
  }

  function resolveCustomerImagePath({ workspaceKey, customerId, imageId, operatorUser = null } = {}) {
    const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
    assertRecordAccess(customer, operatorUser, 'customer');
    const image = (Array.isArray(customer.images) ? customer.images : [])
      .find((item) => String(item.imageId || '') === String(imageId || ''));
    if (!image) {
      throw new Error(`Customer image not found: ${imageId}`);
    }
    const customerDir = customerLibraryRepository.customerDir(workspaceKey, customerId);
    const imagePath = ensureInsideRoot(
      customerDir,
      path.join(customerDir, String(image.relativePath || '').replaceAll('/', path.sep))
    );
    return { customer, image, imagePath };
  }

  async function removeCustomerImage({ workspaceKey, customerId, imageId, operatorUser = null } = {}) {
    return withCustomerWriteLock(customerLockKey(workspaceKey, customerId), async () => {
    const { customer, image, imagePath } = resolveCustomerImagePath({
      workspaceKey,
      customerId,
      imageId,
      operatorUser,
    });
    if (image.autoSplitRole !== 'region') {
      throw new Error('Only auto-split region images can be removed');
    }

    const remainingImages = normalizeImageOrder(
      (Array.isArray(customer.images) ? customer.images : [])
        .filter((item) => String(item.imageId || '') !== String(imageId || ''))
    );
    await fsPromises.rm(imagePath, { force: true });

    const savedCustomer = customerLibraryRepository.saveCustomer({
      ...customer,
      images: remainingImages,
      preprocess: recomputePreprocessSummary(customer, remainingImages),
    });
    return {
      customer: savedCustomer,
      removedImage: image,
    };
    });
  }

  async function confirmCustomerImage({
    workspaceKey,
    customerId,
    imageId,
    status = 'accepted',
    operatorUser = null,
  } = {}) {
    const reviewStatus = normalizeReviewStatus(status);
    return withCustomerWriteLock(customerLockKey(workspaceKey, customerId), async () => {
    const { customer } = resolveCustomerImagePath({
      workspaceKey,
      customerId,
      imageId,
      operatorUser,
    });
    const reviewedAt = new Date().toISOString();
    const nextImages = (Array.isArray(customer.images) ? customer.images : []).map((item) => {
      if (String(item.imageId || '') !== String(imageId || '')) {
        return item;
      }
      return {
        ...item,
        reviewStatus,
        reviewSource: 'manual_file_review',
        reviewedAt,
      };
    });
    const savedCustomer = customerLibraryRepository.saveCustomer({
      ...customer,
      images: nextImages,
    });
    const image = (Array.isArray(savedCustomer.images) ? savedCustomer.images : [])
      .find((item) => String(item.imageId || '') === String(imageId || ''));

    return {
      customer: savedCustomer,
      image,
    };
    });
  }

  return {
    confirmCustomerImage,
    removeCustomerImage,
    resolveCustomerImagePath,
  };
}

module.exports = {
  createCustomerImageReviewService,
};
