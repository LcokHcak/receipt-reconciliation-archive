const { forwardAsync, forwardBatchAccessDenied, loadBatchOrThrow } = require('./handler_utils')
const { createSemaphore } = require('../../../lib/simple_semaphore')

// 客户文件夹导出=复制大量图+打包zip(单批次可达数百MB),30人同时点会顶爆内存/磁盘。
// 全局限并发(默认2),队列满(默认+4)直接拒绝,让操作员错峰重试。
const customerDataExportGate = createSemaphore({
  maxConcurrent: Number(process.env.EXPORT_MAX_CONCURRENCY) || 2,
  maxQueue: Number(process.env.EXPORT_MAX_QUEUE) || 4,
  busyMessage: '导出排队已满,请稍后再点(客户文件夹导出较重,已限制同时进行数)',
})

function createWorkbenchBatchHandlers({
  loadBatch,
  assertBatchAccess,
  summarizeBatch,
  workbenchExportService,
  workbenchWriteService,
  batchCustomerDataExportService = null,
  hyundaiDeliveryExportService = null,
  lotteDeptDeliveryExportService = null,
  modeDeliveryExportService = null,
}) {
  const getBatch = forwardBatchAccessDenied((req, res) => {
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    assertBatchAccess(batch, req.user || null)
    return res.json(summarizeBatch(batch, { includeTasks: true }))
  })

  // 导出留痕(P1):导出产物成功生成后盖章(拍板#3:任一导出动作都算,最后一次为准)。
  // 盖章失败不阻断导出——导出物已经在手,宁可少记一笔留痕也不能让操作员白等;
  // 但必须留日志(评审HIGH):持续失败会让首页导出状态整块静默失真,零痕迹没法排查。
  async function stampExport(req, kind) {
    const batchId = req.params.batchId
    try {
      const result = await workbenchWriteService.markBatchExported({
        batchId,
        kind,
        operator: req.user || null,
      })
      if (result?.status !== 200) {
        console.error('[export] 导出留痕盖章未落盘(导出本身已成功)', { batchId, kind, status: result?.status })
      }
    } catch (stampErr) {
      console.error('[export] 导出留痕盖章失败(导出本身已成功)', { batchId, kind, error: String(stampErr?.message || stampErr) })
    }
  }

  // 导出失败留痕(2026-07-26 待管理事项):只给**真失败**盖戳(打包炸了/盘错/zip 不可用,
  // status>=500)。"本批没有该类内容"(404)与"缺票号/缺门店待补全"(409)是预期业务态,
  // 不算导出失败,不盖戳免得待办里塞满噪声。盖戳本身全捕获,绝不影响给用户的错误响应。
  async function stampExportFailed(req, kind, err) {
    const batchId = req.params.batchId
    try {
      await workbenchWriteService.markBatchExportFailed({
        batchId,
        kind,
        reason: String(err?.message || err || ''),
        operator: req.user || null,
      })
    } catch (stampErr) {
      console.error('[export] 导出失败留痕盖章失败', { batchId, kind, error: String(stampErr?.message || stampErr) })
    }
  }

  const deleteBatch = forwardAsync(async (req, res) => {
    const payload = await workbenchWriteService.deleteBatch({
      batchId: req.params.batchId,
    })
    return res.status(payload.status).json(payload.body)
  })

  const exportBatch = forwardAsync(async (req, res) => {
    const exported = await workbenchExportService.exportBatch(
      loadBatchOrThrow(loadBatch, req.params.batchId),
      // 隐藏不用记行(2026-07-21 拍板):默认保留+标注,勾选才整行剔除
      { excludeNoRecord: req.body?.excludeNoRecord === true }
    )
    await stampExport(req, 'workbook')
    return res.json({
      ok: true,
      ...exported,
    })
  })

  const exportCustomerData = forwardBatchAccessDenied(async (req, res) => {
    if (!batchCustomerDataExportService) {
      return res.status(501).json({ ok: false, error: '客户数据导出未启用' })
    }
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    // owner 隔离(2026-07-16 审计H1):此前独缺 owner 闸,reviewer 可越权下载他人批次
    // 全部客户护照/小票 zip(兄弟导出 exportHyundai/Lotte/Mode 都有,唯此漏)。
    assertBatchAccess(batch, req.user || null)
    // 并发闸:占坑失败(队列也满)直接 429,避免堆积顶爆资源。
    try {
      await customerDataExportGate.acquire()
    } catch (busyErr) {
      return res.status(429).json({ ok: false, error: busyErr.message, code: busyErr.code })
    }
    let result
    try {
      result = await batchCustomerDataExportService.exportZip(batch)
    } catch (err) {
      customerDataExportGate.release()
      const code = err && err.code
      const status = code === 'NO_CUSTOMER_IMAGES' ? 404 : 500
      if (status >= 500) void stampExportFailed(req, 'customer_data', err)
      return res.status(status).json({ ok: false, error: err.message || '导出失败', code })
    }
    // 盖章不阻塞下载(2026-07-19 审计M2):此处还占着全局仅2个的导出并发闸,
    // 等批次写锁会白占坑挤兑别人;stampExport 全捕获永不 reject,后台自走。
    void stampExport(req, 'customer_data')
    // 一直占坑到下载完成 + 临时文件清理,才放行下一个(临时盘/内存压力都在这期间)。
    return res.download(result.zipPath, result.downloadName, (downloadErr) => {
      try { result.cleanup() } catch { /* 清理失败不致命 */ }
      customerDataExportGate.release()
      if (downloadErr && !res.headersSent) {
        res.status(500).json({ ok: false, error: '下载失败' })
      }
    })
  })

  // 现代交付包:按类型三池(护照/机票/小票),小票按票号命名。与客户文件夹导出共用并发闸。
  const exportHyundaiDelivery = forwardBatchAccessDenied(async (req, res) => {
    if (!hyundaiDeliveryExportService) {
      return res.status(501).json({ ok: false, error: '现代交付包导出未启用' })
    }
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    assertBatchAccess(batch, req.user || null)
    try {
      await customerDataExportGate.acquire()
    } catch (busyErr) {
      return res.status(429).json({ ok: false, error: busyErr.message, code: busyErr.code })
    }
    let result
    try {
      result = await hyundaiDeliveryExportService.exportZip(batch)
    } catch (err) {
      customerDataExportGate.release()
      const code = err && err.code
      const status = code === 'NO_HYUNDAI_RECEIPTS' ? 404
        : code === 'HYUNDAI_RECEIPT_NO_MISSING' ? 409 : 500
      if (status >= 500) void stampExportFailed(req, 'hyundai', err)
      return res.status(status).json({
        ok: false, error: err.message || '导出失败', code,
        missing: err.missing, skippedUnreviewed: err.skippedUnreviewed,
      })
    }
    // 盖章不阻塞下载(2026-07-19 审计M2):此处还占着全局仅2个的导出并发闸,
    // 等批次写锁会白占坑挤兑别人;stampExport 全捕获永不 reject,后台自走。
    void stampExport(req, 'hyundai')
    return res.download(result.zipPath, result.downloadName, (downloadErr) => {
      try { result.cleanup() } catch { /* 清理失败不致命 */ }
      customerDataExportGate.release()
      if (downloadErr && !res.headersSent) {
        res.status(500).json({ ok: false, error: '下载失败' })
      }
    })
  })

  // 乐天百货交付包(P4):门店分夹→客户夹(购买日期+英文名)→双图(交易编号图+护照图)。
  // 缺交易编号/门店 → 409 阻断名单(2026-07-20 拍板a:无独立护照不阻断,同框整图兜底);与其他导出共用并发闸。
  const exportLotteDeptDelivery = forwardBatchAccessDenied(async (req, res) => {
    if (!lotteDeptDeliveryExportService) {
      return res.status(501).json({ ok: false, error: '乐天百货交付包导出未启用' })
    }
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    assertBatchAccess(batch, req.user || null)
    try {
      await customerDataExportGate.acquire()
    } catch (busyErr) {
      return res.status(429).json({ ok: false, error: busyErr.message, code: busyErr.code })
    }
    let result
    try {
      result = await lotteDeptDeliveryExportService.exportZip(batch)
    } catch (err) {
      customerDataExportGate.release()
      const code = err && err.code
      const status = code === 'NO_LOTTE_DEPT_RECEIPTS' ? 404
        : code === 'LOTTE_DEPT_DELIVERY_BLOCKED' ? 409 : 500
      if (status >= 500) void stampExportFailed(req, 'lotte_dept', err)
      return res.status(status).json({
        ok: false, error: err.message || '导出失败', code,
        blocked: err.blocked, skippedUnreviewed: err.skippedUnreviewed,
      })
    }
    // 盖章不阻塞下载(2026-07-19 审计M2):此处还占着全局仅2个的导出并发闸,
    // 等批次写锁会白占坑挤兑别人;stampExport 全捕获永不 reject,后台自走。
    void stampExport(req, 'lotte_dept')
    return res.download(result.zipPath, result.downloadName, (downloadErr) => {
      try { result.cleanup() } catch { /* 清理失败不致命 */ }
      customerDataExportGate.release()
      if (downloadErr && !res.headersSent) {
        res.status(500).json({ ok: false, error: '下载失败' })
      }
    })
  })

  // 多模式交付包(2026-07-07 四规则):济州道辉按团号建客户夹/现代三池/其他模式各一文件夹/
  // S活动小票双份。与客户文件夹导出共用并发闸(同样是大量拷图+zip)。
  const exportModeDelivery = forwardBatchAccessDenied(async (req, res) => {
    if (!modeDeliveryExportService) {
      return res.status(501).json({ ok: false, error: '多模式交付包导出未启用' })
    }
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    assertBatchAccess(batch, req.user || null)
    try {
      await customerDataExportGate.acquire()
    } catch (busyErr) {
      return res.status(429).json({ ok: false, error: busyErr.message, code: busyErr.code })
    }
    // zone(2026-07-16 单渠道切片)/zones(2026-07-28 多选导出):只打包选中渠道区;不传=整包(旧行为)
    const zone = String(req.body?.zone || '').trim()
    const zones = Array.isArray(req.body?.zones)
      ? req.body.zones.map((z) => String(z || '').trim()).filter(Boolean).slice(0, 50)
      : []
    let result
    try {
      result = await modeDeliveryExportService.exportZip(
        batch,
        zones.length ? { zones } : (zone ? { zone } : {}),
      )
    } catch (err) {
      customerDataExportGate.release()
      const code = err && err.code
      const status = code === 'MODE_DELIVERY_EMPTY' ? 404
        : code === 'MODE_DELIVERY_RECEIPT_NO_MISSING' ? 409 : 500
      if (status >= 500) void stampExportFailed(req, 'mode_delivery', err)
      return res.status(status).json({
        ok: false, error: err.message || '导出失败', code,
        missing: err.missing, skippedUnreviewed: err.skippedUnreviewed,
      })
    }
    // 盖章不阻塞下载(2026-07-19 审计M2):此处还占着全局仅2个的导出并发闸,
    // 等批次写锁会白占坑挤兑别人;stampExport 全捕获永不 reject,后台自走。
    void stampExport(req, 'mode')
    return res.download(result.zipPath, result.downloadName, (downloadErr) => {
      try { result.cleanup() } catch { /* 清理失败不致命 */ }
      customerDataExportGate.release()
      if (downloadErr && !res.headersSent) {
        res.status(500).json({ ok: false, error: '下载失败' })
      }
    })
  })


  return {
    deleteBatch,
    exportBatch,
    exportCustomerData,
    exportHyundaiDelivery,
    exportLotteDeptDelivery,
    exportModeDelivery,
    getBatch,
  }
}

module.exports = {
  createWorkbenchBatchHandlers,
}
