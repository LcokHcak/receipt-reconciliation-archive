const { BadRequestError, NotFoundError } = require('../../../lib/errors')
const { errorMessage, forwardAsync, mapRejected, requireNonEmpty } = require('./handler_utils')

function createWorkbenchCustomerHandlers({
  customerDocumentPreprocessService,
  customerImageReviewService,
  customerIntakeService,
  // #5 重识别回灌批次(2026-07-14 审计):以下四件缺省 no-op/false,老测试与旧装配不传也不炸。
  customerBatchBridgeService = null,
  withBatchWrite = (batchId, action) => action(),
  scheduleBatch = () => {},
  batchExists = () => false,
}) {
  const getCustomerImageFile = forwardAsync(async (req, res) => {
    const workspaceKey = requireNonEmpty(req.params?.workspaceKey, 'workspaceKey is required')
    const customerId = requireNonEmpty(req.params?.customerId, 'customerId is required')
    const imageId = requireNonEmpty(req.params?.imageId, 'imageId is required')

    const { imagePath } = await mapRejected(
      () =>
        customerImageReviewService.resolveCustomerImagePath({
          workspaceKey,
          customerId,
          imageId,
          operatorUser: req.user || null,
        }),
      (error) => new NotFoundError(errorMessage(error), { cause: error })
    )
    return res.sendFile(imagePath)
  })

  const deleteWorkspaceCustomerImage = forwardAsync(async (req, res) => {
    const workspaceKey = requireNonEmpty(req.params?.workspaceKey, 'workspaceKey is required')
    const customerId = requireNonEmpty(req.params?.customerId, 'customerId is required')
    const imageId = requireNonEmpty(req.params?.imageId, 'imageId is required')

    const result = await mapRejected(
      () =>
        customerImageReviewService.removeCustomerImage({
          workspaceKey,
          customerId,
          imageId,
          operatorUser: req.user || null,
        }),
      (error) => new BadRequestError(errorMessage(error), { cause: error })
    )
    return res.json({
      ok: true,
      workspaceKey,
      ...result,
      customers: customerIntakeService.listCustomers(workspaceKey, req.user),
    })
  })

  const confirmWorkspaceCustomerImage = forwardAsync(async (req, res) => {
    const workspaceKey = requireNonEmpty(req.params?.workspaceKey, 'workspaceKey is required')
    const customerId = requireNonEmpty(req.params?.customerId, 'customerId is required')
    const imageId = requireNonEmpty(req.params?.imageId, 'imageId is required')
    const status = String(req.body?.status || 'accepted').trim() || 'accepted'

    const result = await mapRejected(
      () =>
        customerImageReviewService.confirmCustomerImage({
          workspaceKey,
          customerId,
          imageId,
          status,
          operatorUser: req.user || null,
        }),
      (error) => new BadRequestError(errorMessage(error), { cause: error })
    )
    return res.json({
      ok: true,
      workspaceKey,
      ...result,
      customers: customerIntakeService.listCustomers(workspaceKey, req.user),
    })
  })

  const preprocessWorkspaceCustomer = forwardAsync(async (req, res) => {
    const workspaceKey = requireNonEmpty(
      req.params?.workspaceKey || req.body?.workspaceKey,
      'workspaceKey is required'
    )
    const customerId = requireNonEmpty(
      req.params?.customerId || req.body?.customerId,
      'customerId is required'
    )

    const result = await mapRejected(
      () =>
        customerDocumentPreprocessService.preprocessCustomer({
          workspaceKey,
          customerId,
          operatorUser: req.user || null,
        }),
      (error) => new BadRequestError(errorMessage(error), { cause: error })
    )

    // #5 重识别回灌批次(2026-07-14 审计):重识别只更新客户库,已进批次的旧切图任务
    // 不会自动被替换——审核台一直审旧图还全绿假信号。这里在重识别成功后,若客户已挂在
    // 某批次(review.lastBatchId),自动把新切片追加回该批次(append 路径自带
    // cleanupStaleCustomerTasks 清旧任务;按 sourceOriginalPath 去重,没变化=追加 0,无副作用)。
    // 回灌失败不推翻重识别本身(客户库已更新),报 batchAppendError 让操作员用「补图/追加」自愈。
    let batchAppend = null;
    let batchAppendError = null;
    const lastBatchId = String(result?.customer?.review?.lastBatchId || '').trim();
    if (lastBatchId && customerBatchBridgeService && batchExists(lastBatchId)) {
      try {
        batchAppend = await withBatchWrite(lastBatchId, () => customerBatchBridgeService.appendCustomerToBatch({
          workspaceKey,
          customerId,
          batchId: lastBatchId,
          operatorUser: req.user || null,
        }), { label: 'reprocessAppendToBatch', timeoutMs: 180_000 });
        if (batchAppend?.appendedTasks > 0) {
          scheduleBatch(lastBatchId, { priority: true }) // 操作员在等,插队补识别
        }
      } catch (appendErr) {
        batchAppendError = String(appendErr?.message || appendErr)
      }
    }

    return res.json({
      ok: true,
      workspaceKey,
      ...result,
      batchAppend: batchAppend
        ? { batchId: lastBatchId, appendedTasks: batchAppend.appendedTasks || 0, staleRemoved: batchAppend.staleRemoved || 0 }
        : null,
      batchAppendError,
      customers: customerIntakeService.listCustomers(workspaceKey, req.user),
    })
  })

  const preprocessWorkspaceCustomers = forwardAsync(async (req, res) => {
    const workspaceKey = requireNonEmpty(
      req.params?.workspaceKey || req.body?.workspaceKey,
      'workspaceKey is required'
    )

    const result = await mapRejected(
      () =>
        customerDocumentPreprocessService.preprocessWorkspace({
          workspaceKey,
          operatorUser: req.user || null,
        }),
      (error) => new BadRequestError(errorMessage(error), { cause: error })
    )

    // 批量预处理同样回灌批次(生产实证 bug,2026-07-22 用户报"缺护照"):单客户预处理 handler
    // 早有此安全网(上面 #5),但批量 workspace 预处理路径此前遗漏——切图和批次自动追加撞时序,
    // 追加只抓到未切的第一张,切出的护照区/小票区漏在客户库里进不了批次,审核台见"缺护照"。
    // 对每个切了图(splitImages>0)且已挂批次(lastBatchId)的客户补追加;append 幂等按
    // sourceOriginalPath 去重+自带 cleanupStaleCustomerTasks 清切图前的废图任务,没变化=追加 0。
    const reappended = []
    for (const item of (Array.isArray(result?.results) ? result.results : [])) {
      const cust = item?.customer
      const lastBatchId = String(cust?.review?.lastBatchId || '').trim()
      const cid = String(cust?.customerId || '').trim()
      if (!lastBatchId || !cid || Number(item?.summary?.splitImages || 0) <= 0) continue
      if (!customerBatchBridgeService || !batchExists(lastBatchId)) continue
      try {
        const out = await withBatchWrite(lastBatchId, () => customerBatchBridgeService.appendCustomerToBatch({
          workspaceKey,
          customerId: cid,
          batchId: lastBatchId,
          operatorUser: req.user || null,
        }), { label: 'bulkPreprocessAppendToBatch', timeoutMs: 180_000 })
        if (out?.appendedTasks > 0) {
          reappended.push({ customerId: cid, batchId: lastBatchId, appendedTasks: out.appendedTasks })
          scheduleBatch(lastBatchId, { priority: true }) // 有新切片入批,插队补识别
        }
      } catch { /* 回灌失败不推翻已成功的预处理,操作员可用「追加图片」自愈 */ }
    }

    return res.json({
      ok: true,
      workspaceKey,
      ...result,
      reappended,
    })
  })

  return {
    confirmWorkspaceCustomerImage,
    deleteWorkspaceCustomerImage,
    getCustomerImageFile,
    preprocessWorkspaceCustomer,
    preprocessWorkspaceCustomers,
  }
}

module.exports = {
  createWorkbenchCustomerHandlers,
}
