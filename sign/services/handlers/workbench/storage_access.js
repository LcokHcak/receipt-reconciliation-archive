const { NotFoundError } = require('../../../lib/errors')
const { decodePathPart, forwardBatchAccessDenied, loadBatchOrThrow } = require('./handler_utils')

function createStorageAccessMiddleware({ loadBatch, assertBatchAccess }) {
  return forwardBatchAccessDenied(function storageAccessMiddleware(req, _res, next) {
    const pathParts = String(req.path || '')
      .split('/')
      .filter(Boolean)
    if (!pathParts.length) {
      return next(new NotFoundError('storage file not found'))
    }

    const batchId = decodePathPart(pathParts[0])
    const batch = loadBatchOrThrow(loadBatch, batchId, 'storage file not found')
    assertBatchAccess(batch, req.user || null)
    return next()
  })
}

module.exports = {
  createStorageAccessMiddleware,
}
