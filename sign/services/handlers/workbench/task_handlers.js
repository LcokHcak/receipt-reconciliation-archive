const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { AppError } = require('../../../lib/errors')
const { logger: structuredLogger } = require('../../../lib/request_logger')
const { validateTaskPatch } = require('../../../lib/validation/task_patch')
const { stampGroupSettlement, clearGroupSettlement } = require('../../../lib/source_group_utils')
const { resolveTaskOriginalImagePath } = require('../../../lib/task_original_image')
// 切片名判据单一真相源:和 canAcceptManualBox / delivery_render 用同一个正则,
// 两份各自维护的话,拷不拷原图和能不能画框会给出互相矛盾的答案。
const { SPLIT_FILE_RE } = require('../../../lib/delivery_render')
const {
  createStatusError,
  forwardAsync,
  forwardBatchAccessDenied,
  loadBatchOrThrow,
  reviewGroupRemovalError,
  trySync,
} = require('./handler_utils')

function createWorkbenchTaskHandlers({
  activeBatches,
  batchRepository,
  customerIntakeService,
  customerLibraryRepository,
  loadBatch,
  assertBatchAccess,
  removeBatchDirectory,
  removeTaskArtifacts,
  saveBatchAsync,
  sqliteSyncService,
  summarizeBatch,
  syncRecognitionProgress,
  withBatchWrite,
  workbenchWriteService,
  getWorkbenchBatchLedgerImportService,
  getWorkbenchApproveSettleService = () => null,
  scheduleBatch = () => {}, // 任务重识别(requeue)后触发识别管道
  getTaskResplitService = () => { throw new AppError('重切服务未装配', { status: 501, code: 'resplit_unsupported' }) },
  // 团号确认站(2026-07-10):holder 晚绑定 { service, logRepo, sendbackRepo }(prematch 依赖 monthlyDb 晚建)。
  getTourConfirm = () => null,
  // P2-b 区域重读的注入点。第一版写成函数体内 inline require —— 那样 handler
  // 就只能连着真 qwen 才测得了,而这条路的三条取舍(只写 *Auto / 空值不覆盖 /
  // OCR 在锁外)全都是**没验证就等于没有**的那种断言。跟仓库其余部分一样走注入。
  rereadRegionFields = require('../../../lib/qwen_ocr/region_reread').rereadRegionFields,
}) {
  function tourConfirmDeps() {
    const holder = getTourConfirm()
    if (!holder?.service) {
      throw new AppError('团号确认服务尚未就绪', { status: 503, code: 'service_unavailable' })
    }
    return holder
  }


  // P2-a(0731):源任务是切片时,把**整张原图**拷进批次,新任务指到那张图上。
  //
  // 现状本来就是坏的:在切片任务上点「补小票」,建出来的任务照抄切片路径,
  // 于是 ①canAcceptManualBox 拒绝画框(框是原图坐标系,在切片上对不上)
  //     ②交付时撞 duplicate_crop_file(两条任务共用同一个切片文件)
  // 两头堵死 —— 这也正是 0731 查出来「去原图那条任务上补小票」那条建议
  // 在真批次上 7/7 走不通的第二个原因。
  //
  // 拷贝而不是引用:批次是自包含的(sourceImagePath 相对批次根解析),
  // 指到客户库外面去会让批次归档/清理时凭空少一张图。
  // 拷不动就**照老样子建**,不拦着 —— 补票本身是审核员当下要做的事,
  // 不能因为一次拷贝失败就让他连票都补不了。
  function copyOriginalIntoBatch(batchId, sourceTask) {
    const resolved = resolveTaskOriginalImagePath(
      sourceTask,
      (ws, cid) => customerLibraryRepository.customerDir(ws, cid),
    )
    // isOriginal=false 表示回溯不到整张原图(只剩切片本身),那就没什么可拷的
    if (!resolved.path || !resolved.isOriginal) return null
    const dirs = batchRepository.batchSubdirs(batchId)
    const base = path.basename(resolved.path)
    // 防撞:同一张原图可能被补票多次。带上任务 id 片段,且**绝不能**让文件名
    // 落进 _receipt_1.jpg 那种切片形态 —— 否则新任务又会被判成切片,原地转圈。
    // 用随机后缀而不是 Date.now():同一张原图连补两次很可能落在同一毫秒里,
    // 那就会互相覆盖。与 workbench_task_factory 里生成 manual 任务 id 同款做法。
    const stamp = String(sourceTask?.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'manual'
    const fileName = `manual_orig_${stamp}_${crypto.randomUUID().slice(0, 8)}__${base}`
    const target = path.join(dirs.source, fileName)
    try {
      fs.mkdirSync(dirs.source, { recursive: true })
      fs.copyFileSync(resolved.path, target)
    } catch {
      return null
    }
    return {
      sourceImagePath: path.join('source', fileName),
      sourceOriginalPath: sourceTask?.sourceOriginalPath || '',
    }
  }

  const createManualReceiptFromTaskHandler = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    let taskOverrides = {}
    if (batchRepository.hasBatch(batchId)) {
      const batch = loadBatch(batchId)
      assertBatchAccess(batch, req.user || null)
      const taskId = String(req.params?.taskId || '').trim()
      const sourceTask = (batch.tasks || []).find((item) => item.id === taskId)
      const rel = String(sourceTask?.sourceImagePath || '').trim()
      const fileName = rel.split('\\').join('/').split('/').pop() || ''
      if (sourceTask && SPLIT_FILE_RE.test(fileName)) {
        taskOverrides = copyOriginalIntoBatch(batchId, sourceTask) || {}
      }
    }
    const payload = await workbenchWriteService.createManualReceiptFromTask({
      batchId,
      taskId: String(req.params?.taskId || '').trim(),
      recordLabel: String(req.body?.recordLabel || '').trim(),
      taskOverrides,
    })
    return res.status(payload.status).json(payload.body)
  })

  // 手画文档框(0730 第2期):在原图上框出这条任务对应的那张单据,交付时按它裁。
  // 校验(框太小/框住整张图/切片坐标对不上)全在 lib/manual_doc_box + 写服务里,
  // 这里只做权限闸 + 透传 —— 拒绝理由是写给操作员看的人话,原样回给前端。
  const setTaskDocBoxHandler = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    if (batchRepository.hasBatch(batchId)) {
      assertBatchAccess(loadBatch(batchId), req.user || null)
    }
    const payload = await workbenchWriteService.setTaskDocBox({
      batchId,
      taskId: String(req.params?.taskId || '').trim(),
      box: req.body?.box,
    })
    return res.status(payload.status).json(payload.body)
  })

  // 「查看原图」(2026-07-06 切边补救):切片可能裁掉票面边缘(实锤:右缘团号被切没,
  // 操作员没法核对——数据没丢,字段从整图抽取,只是"看"不到)。切分前完整原图留在客户库
  // (<NN>-<base>_original.*,被刻意排除在批次外),按切片名回溯供图;没切过的图本身即原图。
  const getTaskOriginalImageHandler = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    const batch = loadBatchOrThrow(loadBatch, batchId)
    assertBatchAccess(batch, req.user || null)
    const taskId = String(req.params?.taskId || '').trim()
    const task = (batch.tasks || []).find((item) => item.id === taskId)
    if (!task) throw createStatusError(404, 'Task not found')

    // 解析(含路径逃逸防护、切片→_original 回溯)统一在 lib/task_original_image,
    // 因为 P2 引导式补票要在**写路径**上问同一个问题。两份解析漂了是静默的:
    // 供图这边好好的、补票那边指到别处,谁也不报错。
    const resolved = resolveTaskOriginalImagePath(
      task,
      (ws, cid) => customerLibraryRepository.customerDir(ws, cid),
    )
    if (!resolved.path) throw createStatusError(404, 'Original image not found')
    return res.sendFile(resolved.path)
  })

  // P2-b:按**人画的框**重读票面字段(0731)。
  //
  // 闭环的最后一段:0730 之后人能画框了,框也确实用在了交付裁剪和审核台显示上,
  // 但「我画了框,然后呢」—— 字段还是自动切分时读出来的那一份,而人会去画框
  // 的前提恰恰是那次切分错了。所以框存下来之后必须能拿它重读一次。
  //
  // 三个刻意的取舍:
  //  1. 只写 *Auto,**绝不碰 *Final**。重读是"给一个新的建议",拍板还是人。
  //     写 Final 等于替审核员做决定,而这条路本身就是模型已经错过一次的场景。
  //  2. 只写**读出来有值**的字段。空字符串不覆盖 —— 否则重读一次失败,
  //     就把上一轮好不容易读对的几个字段清空了。
  //  3. OCR 放在 withBatchWrite **外面**。qwen 一次 ~18s,而批次写锁默认 30s;
  //     跟 resplit 那种把 OCR 圈在锁里靠调大超时的做法不一样 —— 那条路要重建切片、
  //     必须在锁内保证一致;这条只往一个任务上写几个 Auto 字段,没必要占着锁等网络。
  const rereadTaskBoxHandler = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    const taskId = String(req.params?.taskId || '').trim()
    const batch = loadBatchOrThrow(loadBatch, batchId)
    assertBatchAccess(batch, req.user || null)
    const task = (batch.tasks || []).find((item) => item.id === taskId)
    if (!task) throw createStatusError(404, 'Task not found')

    const box = Array.isArray(task.manualBox) ? task.manualBox : null
    if (!box) throw createStatusError(400, '这条任务上没有人工框,先在图上画一个框再重读')

    const resolved = resolveTaskOriginalImagePath(
      task,
      (ws, cid) => customerLibraryRepository.customerDir(ws, cid),
    )
    if (!resolved.path) throw createStatusError(404, resolved.error || '找不到整张原图,无法按框重读')

    // ── 锁外:慢的那一段 ──
    const { fields, source } = await rereadRegionFields(resolved.path, { bbox: box })
    const picked = Object.entries({
      receiptStoreAuto: fields.store,
      receiptNoAuto: fields.receiptNo,
      purchaseDateAuto: fields.purchaseDate,
      receiptAmountAuto: fields.amount,
    }).filter(([, v]) => String(v || '').trim())

    if (!picked.length) {
      // 读不出不是错误(框太小/没配 key/网络抖)。如实说"没读出来",
      // 不要伪装成成功 —— 否则审核员会以为字段已经更新过了。
      return res.json({ ok: true, updated: false, source, fields: {}, reason: '框内没读出可用字段' })
    }

    // ── 锁内:只写这几个 Auto 字段 ──
    await withBatchWrite(batchId, async () => {
      const fresh = loadBatchOrThrow(loadBatch, batchId)
      const target = (fresh.tasks || []).find((item) => item.id === taskId)
      if (!target) throw createStatusError(404, 'Task not found')
      for (const [key, value] of picked) target[key] = value
      target.regionRereadAt = new Date().toISOString()
      target.regionRereadSource = source
      await saveBatchAsync(fresh)
    }, { label: 'rereadTaskBox' })

    return res.json({ ok: true, updated: true, source, fields: Object.fromEntries(picked) })
  })

  function getReviewCustomerReference(batch, groupKey) {
    const normalizedGroupKey = String(groupKey || '').trim()
    const groupTasks = (batch.tasks || []).filter(
      (task) => String(task?.sourceGroupKey || '').trim() === normalizedGroupKey
    )
    const referenced = customerLibraryRepository.findCustomerByReviewReference(
      batch.id,
      normalizedGroupKey
    )
    if (referenced?.workspaceKey && referenced?.customerId) {
      return {
        workspaceKey: referenced.workspaceKey,
        customerId: referenced.customerId,
        groupTasks,
      }
    }

    const taskReference = groupTasks
      .map((task) =>
        String(task?.sourceOriginalPath || '')
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
      )
      .find((parts) => parts.length >= 2)
    if (taskReference) {
      return {
        workspaceKey: taskReference[0],
        customerId: taskReference[1],
        groupTasks,
      }
    }

    const sourceGroup = (batch.sourceGroups || []).find(
      (group) => String(group?.key || '').trim() === normalizedGroupKey
    )
    return {
      workspaceKey: '',
      customerId: String(sourceGroup?.folderPath || sourceGroup?.label || '').trim(),
      groupTasks,
    }
  }

  function isReviewGroupAlreadyHandled(groupTasks = []) {
    return groupTasks.some((task) => {
      const processResult = String(task?.processResult || '').trim()
      const reviewStatus = String(task?.reviewStatus || '').trim()
      return (
        Boolean(task?.reviewed) ||
        Boolean(task?.rephotoRequested) ||
        processResult === 'approved' ||
        processResult.includes('通过') ||
        processResult.includes('拒绝') ||
        reviewStatus.includes('拒绝')
      )
    })
  }

  async function removeReviewCustomerGroupFromBatch({
    batchId,
    groupKey,
    operatorUser = null,
    deleteCustomerDirectory = false,
    forceRemove = false,
  }) {
    const normalizedBatchId = String(batchId || '').trim()
    const normalizedGroupKey = String(groupKey || '').trim()
    if (!normalizedBatchId || !normalizedGroupKey) {
      return { removed: false, reason: 'not_linked' }
    }

    return withBatchWrite(normalizedBatchId, async () => { // label: deleteReviewCustomerGroup
      if (!batchRepository.hasBatch(normalizedBatchId)) {
        return {
          removed: false,
          reason: 'batch_missing',
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
        }
      }

      const batch = loadBatch(normalizedBatchId)
      assertBatchAccess(batch, operatorUser || null)
      const reference = getReviewCustomerReference(batch, normalizedGroupKey)
      if (!reference.groupTasks.length) {
        return {
          removed: false,
          reason: 'group_missing',
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
        }
      }
      if (!reference.workspaceKey || !reference.customerId) {
        return {
          removed: false,
          reason: 'customer_reference_missing',
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
        }
      }
      // B5(2026-07-16):已结算组任何入口都不可硬删(forceRemove 只许绕"仅已审"的重复建档场景)
      const groupMeta = (Array.isArray(batch.sourceGroups) ? batch.sourceGroups : []).find(
        (g) => String(g?.key || g?.groupKey || '').trim() === normalizedGroupKey
      )
      if (groupMeta && (groupMeta.settledAt || String(groupMeta.settlementStatus || '') === 'settled')) {
        return {
          removed: false,
          reason: 'already_settled',
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
          workspaceKey: reference.workspaceKey,
          customerId: reference.customerId,
        }
      }
      if (!forceRemove && isReviewGroupAlreadyHandled(reference.groupTasks)) {
        return {
          removed: false,
          reason: 'already_reviewed',
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
          workspaceKey: reference.workspaceKey,
          customerId: reference.customerId,
        }
      }

      const remainingTasks = batch.tasks.filter(
        (task) => String(task?.sourceGroupKey || '').trim() !== normalizedGroupKey
      )
      reference.groupTasks.forEach((task) => removeTaskArtifacts(batch.id, task, remainingTasks))
      batch.tasks = remainingTasks
      batch.sourceGroups = (batch.sourceGroups || []).filter(
        (group) => String(group?.key || '').trim() !== normalizedGroupKey
      )

      const deleted = deleteCustomerDirectory
        ? await customerIntakeService.deleteCustomer({
            workspaceKey: reference.workspaceKey,
            customerId: reference.customerId,
            force: true,
            operatorUser: operatorUser || null,
          })
        : null

      if (!batch.tasks.length) {
        activeBatches.delete(batch.id)
        sqliteSyncService.removeBatch(batch.id)
        removeBatchDirectory(batch.id)
        return {
          removed: true,
          batchDeleted: true,
          batchId: normalizedBatchId,
          groupKey: normalizedGroupKey,
          workspaceKey: reference.workspaceKey,
          customerId: reference.customerId,
          deleted,
        }
      }

      syncRecognitionProgress(batch)
      await saveBatchAsync(batch)
      return {
        removed: true,
        batchDeleted: false,
        batch: summarizeBatch(loadBatch(batch.id), { includeTasks: true }),
        batchId: normalizedBatchId,
        groupKey: normalizedGroupKey,
        workspaceKey: reference.workspaceKey,
        customerId: reference.customerId,
        deleted,
      }
    }, { label: 'deleteReviewCustomerGroup' })
  }

  async function removeReviewCustomerGroupForCustomer({
    workspaceKey,
    customerId,
    operatorUser = null,
  } = {}) {
    const normalizedWorkspaceKey = String(workspaceKey || '').trim()
    const normalizedCustomerId = String(customerId || '').trim()
    if (!normalizedWorkspaceKey || !normalizedCustomerId) {
      return { removed: false, reason: 'not_linked' }
    }

    const loadedCustomer = trySync(() =>
      customerLibraryRepository.loadCustomer(normalizedWorkspaceKey, normalizedCustomerId)
    )
    if (!loadedCustomer.ok) {
      return {
        removed: false,
        reason: 'customer_missing',
        workspaceKey: normalizedWorkspaceKey,
        customerId: normalizedCustomerId,
      }
    }
    const customer = loadedCustomer.value

    const batchId = String(customer?.review?.lastBatchId || '').trim()
    const groupKey = String(
      customer?.review?.lastSourceGroupId || normalizedCustomerId || ''
    ).trim()
    if (!batchId || !groupKey) {
      return {
        removed: false,
        reason: 'not_linked',
        workspaceKey: normalizedWorkspaceKey,
        customerId: normalizedCustomerId,
      }
    }

    const result = await removeReviewCustomerGroupFromBatch({
      batchId,
      groupKey,
      operatorUser,
      deleteCustomerDirectory: false,
      forceRemove: false,
    })
    const { batch: _batch, ...syncResult } = result // 剔除 batch 的 omit 解构,_ 前缀=有意丢弃
    return syncResult
  }

  const deleteSourceGroupCustomer = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    const groupKey = String(req.params?.groupKey || '').trim()

    const result = await removeReviewCustomerGroupFromBatch({
      batchId,
      groupKey,
      operatorUser: req.user || null,
      deleteCustomerDirectory: true,
      forceRemove: true,
    })
    if (!result.removed) {
      throw reviewGroupRemovalError(result)
    }
    return res.status(200).json({ ok: true, ...result })
  })

  const updateTask = forwardBatchAccessDenied(async (req, res) => {
    const validation = validateTaskPatch(req.body)
    if (!validation.ok) {
      throw createStatusError(validation.status, validation.error)
    }
    if (batchRepository.hasBatch(req.params.batchId)) {
      assertBatchAccess(loadBatch(req.params.batchId), req.user || null)
    }
    const payload = await workbenchWriteService.updateTask({
      batchId: req.params.batchId,
      taskId: req.params.taskId,
      body: req.body,
    })
    return res.status(payload.status).json(payload.body)
  })

  const approveSourceGroup = forwardAsync(async (req, res) => {
    // 硬闸(P2,ENV WORKBENCH_REQUIRE_TOUR_CONFIRM=true 才生效):未确认团号的组不许通过。
    // 只拦通过/结算,不拦浏览/编辑/补图;豁免组放行。闸以钩子形式在 write-service 的
    // withBatchWrite 锁内用最新快照执行(消 TOCTOU:锁外先查后写会被并发撤销钻空)。
    const tourHolder = getTourConfirm()
    const groupKey = String(req.params.groupKey || '').trim()
    const payload = await workbenchWriteService.approveSourceGroup({
      batchId: req.params.batchId,
      groupKey,
      operator: req.user?.username || null,
      preApproveCheck: tourHolder?.service?.requireConfirmEnabled?.()
        ? (freshBatch) => tourHolder.service.assertTourConfirmed(freshBatch, groupKey)
        : null,
    })
    return res.status(payload.status).json(payload.body)
  })

  const importBatchLedger = forwardBatchAccessDenied(async (req, res) => {
    const workbenchBatchLedgerImportService = getWorkbenchBatchLedgerImportService()
    if (!workbenchBatchLedgerImportService) {
      throw new AppError('台账导入服务尚未就绪', {
        status: 503,
        code: 'service_unavailable',
      })
    }
    const batch = loadBatchOrThrow(loadBatch, req.params.batchId)
    assertBatchAccess(batch, req.user || null)
    const result = await workbenchBatchLedgerImportService.importBatchToLedger({
      batch,
      operator: req.user?.username || null,
    })
    // B5 收口(审计 HIGH:「导入台账」写了台账却从不盖章→删除守卫只认盖章、对这条路失明,
    // 可物理删已入账证据)。成功导入台账的组补盖组级结算章;进批次写锁+锁内重载 fresh,
    // 与审核/结算并发写串行(照 settleSourceGroup 盖章先例)。盖章失败不翻已成功的导入。
    const importedKeys = Array.isArray(result.importedGroupKeys) ? result.importedGroupKeys : []
    if (importedKeys.length) {
      try {
        await withBatchWrite(batch.id, async () => {
          const fresh = loadBatchOrThrow(loadBatch, batch.id)
          let changed = false
          for (const gk of importedKeys) {
            if (stampGroupSettlement(fresh, gk, { settlementStatus: 'settled' })) changed = true
          }
          if (changed) await saveBatchAsync(fresh)
        }, { label: 'importBatchLedger:stamp' })
      } catch (stampErr) {
        console.error('[import-ledger] 组级结算盖章失败(台账已写入,不影响导入结果)', stampErr)
      }
    }
    return res.json({
      ok: true,
      batchId: batch.id,
      ...result,
    })
  })

  // 流式逐客户「通过并结算」(P1):审完一个客户组 → 写台账 + 即时团号匹配 → 返回按小票的渠道模式。
  const settleSourceGroup = forwardBatchAccessDenied(async (req, res) => {
    const settleService = getWorkbenchApproveSettleService()
    if (!settleService) {
      throw new AppError('结算服务尚未就绪', { status: 503, code: 'service_unavailable' })
    }
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    let result
    try {
      // 结算会改 batch.json(approveGroup 内部 saveBatchAsync),必须与 updateTask/
      // approveSourceGroup 走同一把 withBatchWrite 锁串行——否则并发同批次写会丢更新
      // (2026-07-08「确认合并结算」后,每次确认最后一张都触发结算,罕见竞态变常态)。
      // 锁内重载最新快照,避免在别人的写入之上覆盖;结算服务内部无 withBatchWrite,不会嵌套死锁。
      result = await withBatchWrite(batchId, async () => {
        const fresh = loadBatchOrThrow(loadBatch, batchId)
        // 硬闸(P2,ENV 默认关):未确认团号的组不许结算(豁免组放行)。
        const tourHolder = getTourConfirm()
        if (tourHolder?.service?.requireConfirmEnabled?.()) {
          tourHolder.service.assertTourConfirmed(fresh, String(req.params.groupKey || '').trim())
        }
        const settled = await settleService.approveAndSettleGroup({
          batch: fresh,
          groupKey: String(req.params.groupKey || '').trim(),
          operator: req.user?.username || null,
        })
        // 组级结算状态落盘(P2):成功才盖章,供实时队列/代理视图显示"已结算/待确认/待补救"。
        // approveGroup 内部已 save 过 batch,这里再盖 sourceGroups 状态并二次保存(同一把锁内,串行安全)。
        // ⚠️盖章只是 UI 状态,不是结算真相源(台账已写、tour_match 已跑);盖章/保存失败绝不能
        // 把已成功的结算翻成错误让操作员重试——包 try/catch 记日志后照常返回成功结果。
        if (settled?.ok === true) {
          try {
            if (stampGroupSettlement(fresh, String(req.params.groupKey || '').trim(), {
              settlementStatus: settled.settlementStatus || '',
            })) {
              await saveBatchAsync(fresh)
            }
          } catch (stampErr) {
            console.error('[settle] 组级状态盖章失败(结算本身已成功,不影响台账)', stampErr)
          }
        }
        return settled
      // 300s:结算闭包含跨批次共享的 tourMatch 工作区锁排队 + 台账全表自愈扫描,默认 30s 可能
      // 不够;withBatchWrite 超时=放行下一个写但本闭包仍在跑,最后 saveBatchAsync(fresh) 会用
      // 旧快照盖掉别人刚写的(2026-07-14 审计#2,与 resplit 90s/append 300s 同一防线)。
      }, { label: 'settleSourceGroup', timeoutMs: 300_000 })
    } catch (error) {
      // 组审业务校验错误(缺护照/字段格式不对等)是给操作员看的,转 409 带原文;
      // 之前直接漏进兜底 500,前端只显示 "Internal error",操作员不知道该改什么。
      if (error && (error.code === 'GROUP_APPROVAL_INVALID' || error.code === 'GROUP_NOT_FOUND')) {
        throw new AppError(error.message, {
          status: 409,
          code: error.code,
          details: { taskId: error.taskId || null, markedRephoto: Boolean(error.markedRephoto) },
        })
      }
      if (error && error.code === 'CUSTOMER_FOLDER_EXISTS') {
        // 冲突分流后仍拦下 = 真重复建档(票号撞台账);二次收票已自动 _2 后缀放行不会到这。
        // 用户反馈:审完组跳"已通过"后,提示不带组名根本找不到是哪组 → 带上组名+可定位 taskId
        // (前端 errorDetail.taskId 已有「定位到这张图」链接,直接吃到)。
        const dupes = Array.isArray(error.duplicateReceiptNos) ? error.duplicateReceiptNos : []
        const dupGroupKey = String(req.params.groupKey || '').trim()
        let dupGroupLabel = ''
        let dupTaskId = ''
        try {
          const b = loadBatch(batchId)
          const g = (b.sourceGroups || []).find((x) => String(x?.key || '').trim() === dupGroupKey)
          dupGroupLabel = String(g?.label || g?.folderPath || '').trim()
          dupTaskId = (b.tasks || []).find((t) => String(t?.sourceGroupKey || '').trim() === dupGroupKey)?.id || ''
        } catch { /* 找不到组名不影响报错本体 */ }
        const groupTag = dupGroupLabel ? `【${dupGroupLabel}】` : ''
        const err = new AppError(
          dupes.length
            ? `重复建档${groupTag}:小票 ${dupes.join('、')} 已入过台账(同护照)。请删除这组重复的客户,不要重复通过(队列切「已通过」或点右侧定位)。`
            : `客户归档文件夹已存在${groupTag}:${error.folderName || ''} —— 疑似重复建档(或同名归档过多)。请检查该工作区同名客户组。`,
          { status: 409, code: error.code },
        )
        err.details = { duplicateReceiptNos: dupes, groupKey: dupGroupKey, groupLabel: dupGroupLabel, taskId: dupTaskId }
        throw err
      }
      throw error
    }
    return res.status(result.ok === false ? 422 : 200).json({ batchId, ...result })
  })

  // 台账侧订正(2026-07-21 交付修改#10「删不掉」,admin-only 路由门禁在 routes 层):
  // 撤销已结算组的台账(删行级联+完整快照留痕)+ 清组级结算盖章 → 组回到已审未结算态,
  // 可改字段/删除/重新结算。原因必填;快照落组 meta.ledgerCorrections + audit_log(路由已挂审计)。
  const correctGroupLedger = forwardBatchAccessDenied(async (req, res) => {
    const settleService = getWorkbenchApproveSettleService()
    if (!settleService || typeof settleService.correctGroupLedger !== 'function') {
      throw new AppError('结算服务尚未就绪', { status: 503, code: 'service_unavailable' })
    }
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    const reason = String(req.body?.reason || '').trim()
    let result
    try {
      // 与结算/确认同一把批次写锁:订正改台账+改 batch.json,并发结算/编辑不得交错
      result = await withBatchWrite(batchId, async () => {
        const fresh = loadBatchOrThrow(loadBatch, batchId)
        const corrected = settleService.correctGroupLedger({ batch: fresh, groupKey, reason })
        clearGroupSettlement(fresh, groupKey, {
          by: req.user?.username || null,
          reason,
          removedRows: corrected.removedRows,
          workspaces: corrected.workspaces,
          snapshot: corrected.snapshot,
        })
        await saveBatchAsync(fresh)
        return corrected
      }, { label: 'correctGroupLedger', timeoutMs: 120_000 })
    } catch (error) {
      if (error && (error.code === 'LEDGER_CORRECTION_REASON_REQUIRED' || error.code === 'LEDGER_CORRECTION_NO_ROWS')) {
        throw new AppError(error.message, { status: 409, code: error.code })
      }
      throw error
    }
    return res.json({ ok: true, batchId, groupKey, removedRows: result.removedRows, workspaces: result.workspaces })
  })

  // 确认本客户组已命中小票的渠道模式(人工背书);未命中需先内联补救(走现有补救端点)。
  const confirmGroupModes = forwardBatchAccessDenied(async (req, res) => {
    const settleService = getWorkbenchApproveSettleService()
    if (!settleService) {
      throw new AppError('结算服务尚未就绪', { status: 503, code: 'service_unavailable' })
    }
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    // 与结算同锁:确认模式改台账状态,并把组级 settlementStatus 盖到 sourceGroups(通常→settled)。
    const result = await withBatchWrite(batchId, async () => {
      const fresh = loadBatchOrThrow(loadBatch, batchId)
      const confirmed = await settleService.confirmGroupModes({
        batch: fresh,
        groupKey,
        operator: req.user?.username || null,
      })
      if (stampGroupSettlement(fresh, groupKey, { settlementStatus: confirmed.settlementStatus || '' })) {
        await saveBatchAsync(fresh)
      }
      return confirmed
    // 300s(L601):与 settle 共用同一把 per-batch 写锁队列,闭包内 readGroupAcrossWorkspaces×2 +
    // 逐 workspace confirmModesByGroup 随台账增长变慢;默认 30s 在大账+事件循环繁忙时不够→超时后
    // saveBatchAsync(fresh) 用旧快照盖别人刚写的 batch.json(与 settle 同防线,缓解非消除)。
    }, { label: 'confirmGroupModes', timeoutMs: 300_000 })
    return res.json({ ok: true, batchId, ...result })
  })

  // ── 团号确认站(2026-07-10)────────────────────────────────────────────────
  // 候选聚合(确认卡数据源);?probe=<团号> 顺带即时查表(手填输入框边打边查)。只读。
  const getGroupTourCandidates = forwardBatchAccessDenied(async (req, res) => {
    const { service } = tourConfirmDeps()
    const batchId = String(req.params.batchId || '').trim()
    const batch = loadBatchOrThrow(loadBatch, batchId)
    assertBatchAccess(batch, req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    const payload = service.buildCandidates(batch, groupKey)
    const probe = String(req.query?.probe || '').trim()
    if (probe) payload.probe = { tourNo: probe, ...service.probeTour(batch, probe) }
    return res.json({ ok: true, batchId, ...payload })
  })

  // 人工确认团号:盖章+回填空票+逐票重跑预匹配(照 confirmGroupModes 模板,与结算同锁)。
  const confirmGroupTour = forwardBatchAccessDenied(async (req, res) => {
    const { service } = tourConfirmDeps()
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    const result = await withBatchWrite(batchId, async () => {
      const fresh = loadBatchOrThrow(loadBatch, batchId)
      const confirmed = service.confirmTour(fresh, groupKey, {
        tourNo: String(req.body?.tourNo || '').trim(),
        mode: String(req.body?.mode || '').trim(),
        source: String(req.body?.source || 'manual').trim(),
        basis: req.body?.basis && typeof req.body.basis === 'object' ? req.body.basis : null,
        allowPendingTable: req.body?.allowPendingTable === true,
        operator: req.user?.username || null,
      })
      await saveBatchAsync(fresh)
      return confirmed
    // 300s(L601 同族):本闭包比 confirmGroupModes 更重(盖章+回填空票+逐票重跑预匹配),更易超 30s。
    }, { label: 'confirmGroupTour', timeoutMs: 300_000 })
    return res.json({ ok: true, batchId, groupKey, ...result })
  })

  // 撤销团号确认(未结算):revisions 留痕;曾走 slim 车道 → 组内小票强制清 reviewed(安全绳)。
  const unconfirmGroupTour = forwardBatchAccessDenied(async (req, res) => {
    const { service, sendbackRepo } = tourConfirmDeps()
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    const result = await withBatchWrite(batchId, async () => {
      const fresh = loadBatchOrThrow(loadBatch, batchId)
      const undone = service.unconfirmTour(fresh, groupKey, {
        operator: req.user?.username || null,
        reason: String(req.body?.reason || '').trim(),
      })
      await saveBatchAsync(fresh)
      return undone
    }, { label: 'unconfirmGroupTour', timeoutMs: 300_000 }) // 300s(L601 同族,与 settle/confirm 对齐)
    // 撤销后把该组挂着的回发任务作废(advisory,失败不阻断撤销)。
    if (sendbackRepo?.cancelByGroup) {
      await sendbackRepo.cancelByGroup(batchId, groupKey, { note: '团号确认被撤销' }).catch((error) => {
        // 静默失败审计 2026-07-12:取消失败=过期回发任务照旧挂着按已知错误的团号执行,
        // 原先零日志。仍不阻断撤销主流程,但必须可 grep。
        structuredLogger.warn('sendback_cancel_after_unconfirm_failed', {
          batchId, groupKey, error: String(error?.message || error),
        })
        return null
      })
    }
    return res.json({ ok: true, batchId, groupKey, ...result })
  })

  // 回执已发:收票员把回执粘回群后点「已回执」→ 在现有 tourConfirm 上盖 respondedAt(不动确认本体)。
  const markGroupTourResponded = forwardBatchAccessDenied(async (req, res) => {
    tourConfirmDeps()
    const batchId = String(req.params.batchId || '').trim()
    assertBatchAccess(loadBatchOrThrow(loadBatch, batchId), req.user || null)
    const groupKey = String(req.params.groupKey || '').trim()
    const result = await withBatchWrite(batchId, async () => {
      const fresh = loadBatchOrThrow(loadBatch, batchId)
      const group = (fresh.sourceGroups || []).find((g) => String(g?.key || '').trim() === groupKey)
      if (!group?.tourConfirm?.status) {
        throw new AppError('该组还没有团号确认,无法标记回执', { status: 409, code: 'TOUR_NOT_CONFIRMED' })
      }
      group.tourConfirm.respondedAt = new Date().toISOString()
      await saveBatchAsync(fresh)
      return { respondedAt: group.tourConfirm.respondedAt }
    }, { label: 'markGroupTourResponded', timeoutMs: 300_000 }) // 300s(L601 同族;闭包虽轻,统一防线不留 30s 短板)
    return res.json({ ok: true, batchId, groupKey, ...result })
  })

  // 先验:该收票员当日(含前一天)已人工确认的团号,按引用组数排序(确认卡候选排序用,不自动填)。
  const getTourPrior = forwardAsync(async (req, res) => {
    const { logRepo } = tourConfirmDeps()
    if (!logRepo?.listPrior) return res.json({ ok: true, prior: [] })
    const prior = await logRepo.listPrior({
      workspaceKey: String(req.query?.workspaceKey || '').trim(),
      date: String(req.query?.date || '').trim() || undefined,
    })
    return res.json({ ok: true, prior })
  })

  // 回发队列(发12/17/18号、S活动):看板列表 + 已发盖章。
  const listSendbackQueue = forwardAsync(async (req, res) => {
    const { sendbackRepo } = tourConfirmDeps()
    if (!sendbackRepo?.list) return res.json({ ok: true, items: [] })
    const items = await sendbackRepo.list({
      workspaceKey: String(req.query?.workspaceKey || '').trim(),
      status: String(req.query?.status || '').trim(),
    })
    return res.json({ ok: true, items })
  })

  const markSendbackDone = forwardAsync(async (req, res) => {
    const { sendbackRepo } = tourConfirmDeps()
    const id = String(req.params.id || '').trim()
    const item = await sendbackRepo.markDone(id, {
      operator: req.user?.username || null,
      note: String(req.body?.note || '').trim(),
    })
    if (!item) throw new AppError('回发任务不存在', { status: 404, code: 'SENDBACK_NOT_FOUND' })
    return res.json({ ok: true, item })
  })

  // 任务重新识别(requeue):把指定的未审核任务置回 queued → 识别管道重跑分类+字段。
  // 用途:OCR 服务故障(如 DashScope 账户受限)期间"空跑"的任务(docType=other/字段全空),
  // 服务恢复后批量补识别,不用操作员逐张手动改类型手填字段。
  // 必须显式传 taskIds(防误触发整批重跑烧 API 费);已审核/已标重拍的任务跳过。
  const requeueTasks = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params.batchId || '').trim()
    const requestedIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.map(String).filter(Boolean) : []
    if (!requestedIds.length) {
      return res.status(400).json({ ok: false, error: '请传 taskIds(要重识别的任务列表);为防误操作不支持整批隐式重跑' })
    }
    const result = await withBatchWrite(batchId, async () => {
      const batch = loadBatch(batchId)
      assertBatchAccess(batch, req.user || null)
      const wanted = new Set(requestedIds)
      let requeued = 0
      let skipped = 0
      for (const task of (batch.tasks || [])) {
        if (!wanted.has(String(task.id))) continue
        if (task.reviewed || task.rephotoRequested) { skipped += 1; continue }
        task.machineState = 'queued'
        task.error = ''
        task.ocrError = ''
        // 关键:清分类确认。否则 processBatch 前置的 recoverCompletedStateAfterManualReview
        // 会把 queued 翻回 completed(other 类型无必填字段,恢复条件天然满足)→ 管道空转跳过。
        // 语义上也正确:requeue 就是要重新分类+重抽字段。
        task.classificationConfirmed = false
        requeued += 1
      }
      if (requeued > 0) {
        batch.machineState = 'queued'
        syncRecognitionProgress(batch)
        await saveBatchAsync(batch)
      }
      return { requeued, skipped }
    }, { label: 'requeueTasks' })
    // 审核台"重识别"是操作员在等的动作 → 插队;后台批量修复脚本走同端点也插队,
    // 但按 SOP 修复放非工作时段跑,冲突面可控。
    if (result.requeued > 0) scheduleBatch(batchId, { priority: true })
    return res.json({ ok: true, batchId, ...result })
  })

  const deleteTask = forwardBatchAccessDenied(async (req, res) => {
    if (batchRepository.hasBatch(req.params.batchId)) {
      assertBatchAccess(loadBatch(req.params.batchId), req.user || null)
    }
    const payload = await workbenchWriteService.deleteTask({
      batchId: req.params.batchId,
      taskId: req.params.taskId,
    })
    return res.status(payload.status).json(payload.body)
  })

  // P2d 改店重切:按(新)店档案用客户库原图强制重调 qwen 重切,旧派生任务删除,
  // 新切片归回同批次同客户。storeFamily 缺省=任务当前店(Final 优先,审核员刚改的店)。
  // 业务错误(已审保护/歧义/找不到原图)由 service 抛 AppError 带 status,绝不落兜底 500。
  const resplitTaskHandler = forwardBatchAccessDenied(async (req, res) => {
    const batchId = String(req.params?.batchId || '').trim()
    const taskId = String(req.params?.taskId || '').trim()
    const result = await withBatchWrite(batchId, async () => {
      const batch = loadBatchOrThrow(loadBatch, batchId)
      assertBatchAccess(batch, req.user || null)
      const task = (batch.tasks || []).find((item) => item.id === taskId)
      if (!task) throw createStatusError(404, 'Task not found')
      const storeFamily = String(
        req.body?.storeFamily ?? (task.receiptStoreFinal || task.receiptStoreAuto) ?? ''
      ).trim()
      return getTaskResplitService().resplitTask({
        batchId,
        taskId,
        storeFamily,
        operatorUser: req.user || null,
      })
      // 90s:重切要活调 qwen(~18s,嫌疑重试再+一次),默认 30s 会在调用中途放弃等待
      // (注意 withBatchWrite 超时只是不再等,底层动作仍会跑完——报错后别立刻重点)
    }, { label: 'resplitTask', timeoutMs: 90_000 })
    // 新切片要走一遍识别管道(读现成 sidecar,秒级)才有字段;审核员在等 → 插队
    if (result.appendedTasks > 0) scheduleBatch(batchId, { priority: true })
    return res.json({
      ok: true,
      batchId,
      removedTaskIds: result.removedTaskIds,
      appendedTasks: result.appendedTasks,
      batch: summarizeBatch(result.batch),
    })
  })

  return {
    approveSourceGroup,
    createManualReceiptFromTask: createManualReceiptFromTaskHandler,
    setTaskDocBox: setTaskDocBoxHandler,
    getTaskOriginalImage: getTaskOriginalImageHandler,
    rereadTaskBox: rereadTaskBoxHandler, // P2-b:按人画的框重读票面字段
    deleteSourceGroupCustomer,
    deleteTask,
    importBatchLedger,
    settleSourceGroup,
    confirmGroupModes,
    correctGroupLedger,
    getGroupTourCandidates,
    confirmGroupTour,
    unconfirmGroupTour,
    markGroupTourResponded,
    getTourPrior,
    listSendbackQueue,
    markSendbackDone,
    removeReviewCustomerGroupForCustomer,
    requeueTasks,
    resplitTask: resplitTaskHandler,
    updateTask,
  }
}

module.exports = {
  createWorkbenchTaskHandlers,
}
