const {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require('../../../lib/errors')

function isBatchAccessDenied(error) {
  return /batch access denied/.test(String(error?.message || error || ''))
}

function errorMessage(error) {
  return String(error?.message || error || 'Request failed')
}

function forwardAsync(handler) {
  return function forwardedWorkbenchHandler(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next)
  }
}

function forwardBatchAccessDenied(handler) {
  return async function forwardedBatchAccessHandler(req, res, next) {
    try {
      return await handler(req, res, next)
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return next(new ForbiddenError('batch access denied', { cause: error }))
      }
      return next(error)
    }
  }
}

function loadBatchOrThrow(loadBatch, batchId, message = 'Batch not found') {
  try {
    return loadBatch(batchId)
  } catch (error) {
    throw new NotFoundError(message, { cause: error })
  }
}

function decodePathPart(value, message = 'invalid storage path') {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    throw new BadRequestError(message, { cause: error })
  }
}

function requireNonEmpty(value, message) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw new BadRequestError(message)
  }
  return normalized
}

function trySync(action) {
  try {
    return { ok: true, value: action() }
  } catch (error) {
    return { ok: false, error }
  }
}

async function mapRejected(actionOrPromise, createError) {
  try {
    const promise =
      typeof actionOrPromise === 'function'
        ? Promise.resolve().then(actionOrPromise)
        : actionOrPromise
    return await promise
  } catch (error) {
    throw createError(error)
  }
}

function createStatusError(status, message, options = {}) {
  if (status === 400) return new BadRequestError(message, options)
  if (status === 403) return new ForbiddenError(message, options)
  if (status === 404) return new NotFoundError(message, options)
  if (status === 409) return new ConflictError(message, options)
  return new AppError(message, { status, code: options.code || 'http_error', cause: options.cause })
}

function reviewGroupRemovalError(result = {}) {
  const reason = String(result.reason || '').trim()
  if (reason === 'batch_missing') return new NotFoundError('Batch not found')
  if (reason === 'group_missing') return new NotFoundError('Review group not found')
  if (reason === 'customer_reference_missing') {
    return new BadRequestError('Customer directory reference not found for this review group')
  }
  if (reason === 'already_reviewed') {
    return new ConflictError(
      'Review group already reviewed; delete the ledger/review result explicitly instead'
    )
  }
  if (reason === 'already_settled') {
    // B5(2026-07-16):已结算组任何入口不可硬删(台账证据保护)
    return new ConflictError('本组已产生结算台账,票据是台账证据不可删除(需处理请走台账侧订正)')
  }
  return new BadRequestError('Review group is not linked to a customer directory')
}

module.exports = {
  createStatusError,
  decodePathPart,
  errorMessage,
  forwardAsync,
  forwardBatchAccessDenied,
  isBatchAccessDenied,
  loadBatchOrThrow,
  mapRejected,
  requireNonEmpty,
  reviewGroupRemovalError,
  trySync,
}
