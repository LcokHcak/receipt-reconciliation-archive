const fs = require('fs')
const path = require('path')

const {
  MANUAL_SIGNATURE_SOURCE,
  WEBSITE_SIGNATURE_SOURCE,
  ensureSignatureFields,
  normalizeSignatureStyle,
} = require('../lib/signature_queue')
const { PROCESS_RESULTS } = require('../lib/workbench_task_flow')

function createSkippedSignatureJobError(message) {
  const error = new Error(message)
  error.code = 'SIGNATURE_JOB_SKIPPED'
  return error
}

function createSignatureJobService({
  batchJsonPath,
  batchSubdirs,
  resolveBatchRelativePath,
  removeFileIfExists,
  loadBatch,
  saveBatchAsync,
  withBatchWrite,
  resolveTask,
  recalcTask,
  touchTask,
  isEligibleForWebsiteGeneration,
  ocrOwnedSignatureSources,
  getSignatureSiteWorker,
}) {
  function clearSignatureRegionAsset(batchId, task) {
    if (task.signatureRegionPath) {
      removeFileIfExists(resolveBatchRelativePath(batchId, task.signatureRegionPath))
    }
    task.signatureRegionPath = ''
  }

  function clearAutoFinalSignatureAsset(batchId, task) {
    if (
      ocrOwnedSignatureSources.has(task.finalSignatureSource) &&
      task.finalSignaturePath &&
      task.finalSignaturePath !== task.signatureRegionPath
    ) {
      removeFileIfExists(resolveBatchRelativePath(batchId, task.finalSignaturePath))
    }

    if (ocrOwnedSignatureSources.has(task.finalSignatureSource)) {
      task.finalSignaturePath = ''
      task.finalSignatureSource = ''
    }
  }

  function clearWebsiteFinalSignatureAsset(batchId, task) {
    if (task.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE && task.finalSignaturePath) {
      removeFileIfExists(resolveBatchRelativePath(batchId, task.finalSignaturePath))
    }

    if (task.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE) {
      task.finalSignaturePath = ''
      task.finalSignatureSource = ''
    }

    task.signatureGeneratedAt = ''
    task.signatureJobError = ''
    task.signatureJobStatus = task.chineseNameFinal ? 'idle' : 'pending_name'
  }

  function replaceWithWebsiteFinalSignature(batchId, task, cachePath) {
    const dirs = batchSubdirs(batchId)
    const fileName = `${task.id}__website_signature.png`
    const relative = path.join('final_signatures', fileName)
    const targetPath = path.join(dirs.finalSignatures, fileName)

    if (
      task.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE &&
      task.finalSignaturePath &&
      task.finalSignaturePath !== relative
    ) {
      removeFileIfExists(resolveBatchRelativePath(batchId, task.finalSignaturePath))
    }

    fs.copyFileSync(cachePath, targetPath)
    task.finalSignaturePath = relative
    task.finalSignatureSource = WEBSITE_SIGNATURE_SOURCE
    task.signatureGeneratedAt = new Date().toISOString()
    task.signatureJobStatus = 'done'
    task.signatureJobError = ''
  }

  function restoreAutomaticSignatureState(batchId, task) {
    clearSignatureRegionAsset(batchId, task)
    if (task.finalSignatureSource !== MANUAL_SIGNATURE_SOURCE) {
      clearAutoFinalSignatureAsset(batchId, task)
    }
    Object.assign(task, ensureSignatureFields(task))
  }

  function createSignatureJob(batch, task) {
    return {
      taskKey: `${batch.id}:${task.id}`,
      batchId: batch.id,
      taskId: task.id,
      label: task.originalFileName || task.id,
      chineseName: String(task.chineseNameFinal || '').trim(),
      signatureStyle: normalizeSignatureStyle(task.signatureStyle),
    }
  }

  function canAutoQueueWebsiteSignature(task) {
    const signatureJobStatus = String(task?.signatureJobStatus || '').trim()
    return (
      ['', 'idle'].includes(signatureJobStatus) &&
      task?.processResult === PROCESS_RESULTS.SIGNATURE &&
      !String(task?.finalSignaturePath || '').trim() &&
      task?.finalSignatureSource !== MANUAL_SIGNATURE_SOURCE &&
      isEligibleForWebsiteGeneration(task)
    )
  }

  async function queueAutomaticWebsiteSignature(batch, task) {
    if (!canAutoQueueWebsiteSignature(task)) {
      return { queued: false, reason: 'not_eligible' }
    }

    const signatureSiteWorker = getSignatureSiteWorker()
    if (!signatureSiteWorker) {
      return { queued: false, reason: 'signature_worker_unavailable' }
    }

    const queued = await signatureSiteWorker.queueJob(createSignatureJob(batch, task))
    if (queued.queued) {
      task.signatureJobStatus = 'queued'
      task.signatureJobError = ''
      recalcTask(task)
      touchTask(task)
    }
    return queued
  }

  function loadBatchAndTaskForSignatureJob(job) {
    if (!job?.batchId || !fs.existsSync(batchJsonPath(job.batchId))) {
      throw createSkippedSignatureJobError('Batch no longer exists')
    }

    const batch = loadBatch(job.batchId)
    const task = resolveTask(batch, job.taskId)
    if (!task) {
      throw createSkippedSignatureJobError('Task no longer exists')
    }

    return { batch, task }
  }

  function withSignatureJobTaskWrite(job, action) {
    if (!job?.batchId) {
      throw createSkippedSignatureJobError('Batch no longer exists')
    }

    return withBatchWrite(job.batchId, async () => { // label: signatureJob
      const { batch, task } = loadBatchAndTaskForSignatureJob(job)
      return action(batch, task)
    }, { label: 'signatureJob' })
  }

  function taskMatchesSignatureJob(task, job) {
    return (
      String(task.chineseNameFinal || '').trim() === String(job.chineseName || '').trim() &&
      normalizeSignatureStyle(task.signatureStyle) === normalizeSignatureStyle(job.signatureStyle)
    )
  }

  async function handleSignatureJobStart(job) {
    await withSignatureJobTaskWrite(job, async (batch, task) => {
      if (!isEligibleForWebsiteGeneration(task) || !taskMatchesSignatureJob(task, job)) {
        recalcTask(task)
        touchTask(task)
        await saveBatchAsync(batch)
        throw createSkippedSignatureJobError(
          'Task signature inputs changed before generation started'
        )
      }

      task.signatureJobStatus = 'generating'
      task.signatureJobError = ''
      recalcTask(task)
      touchTask(task)
      await saveBatchAsync(batch)
    })
  }

  async function handleSignatureJobSuccess(job, result) {
    await withSignatureJobTaskWrite(job, async (batch, task) => {
      if (!isEligibleForWebsiteGeneration(task) || !taskMatchesSignatureJob(task, job)) {
        recalcTask(task)
        touchTask(task)
        await saveBatchAsync(batch)
        return
      }

      replaceWithWebsiteFinalSignature(batch.id, task, result.cachePath)
      task.rephotoRequested = false
      recalcTask(task)
      touchTask(task)
      await saveBatchAsync(batch)
    })
  }

  async function handleSignatureJobFailure(job, error) {
    try {
      await withSignatureJobTaskWrite(job, async (batch, task) => {
        if (
          error?.code === 'SIGNATURE_JOB_SKIPPED' ||
          task.finalSignatureSource === MANUAL_SIGNATURE_SOURCE ||
          !taskMatchesSignatureJob(task, job)
        ) {
          recalcTask(task)
          touchTask(task)
          await saveBatchAsync(batch)
          return
        }

        task.signatureJobStatus = 'failed'
        task.signatureJobError = String(error?.message || error)
        recalcTask(task)
        touchTask(task)
        await saveBatchAsync(batch)
      })
    } catch (_loadError) {
      // 静默失败审计 2026-07-12:失败处理器自身失败=任务可能永卡 generating 且无痕,必须留证
      console.error('[signature] handleSignatureJobFailure 二次失败,任务可能卡在 generating', {
        taskKey: job?.taskKey || job?.taskId || null,
        originalError: String(error?.message || error),
        writeError: String(_loadError?.message || _loadError),
      })
      return
    }
  }

  // 启动恢复扫描(2026-07-21 全链路排查 B8):签字队列纯内存(signature_site_worker.queue),
  // 重启后在飞任务蒸发;但 deriveSignatureJobStatus 对 queued/generating 粘滞保留,自动重排
  // 只认 ''/idle、手动重排/删除对这两态直接 409「still running」→ 任务永卡 SIGNATURE 阶段,
  // 唯一逃生口=改手写签字。开机时 worker 队列必空,凡 queued/generating 皆为陈旧态,
  // 清回 ''(交给 deriveSignatureJobStatus 重新派生,自动/手动重排通道全部恢复)。
  async function recoverInterruptedSignatureJobs({ listBatchIds }) {
    const ids = (() => { try { return listBatchIds() || [] } catch { return [] } })()
    let recovered = 0
    for (const batchId of ids) {
      let staleIds = []
      try {
        const peek = loadBatch(batchId)
        staleIds = (peek?.tasks || [])
          .filter((t) => ['queued', 'generating'].includes(String(t.signatureJobStatus || '')))
          .map((t) => t.id)
      } catch { continue } // 批次损坏/被删,跳过
      if (!staleIds.length) continue
      try {
        await withBatchWrite(batchId, async () => {
          const fresh = loadBatch(batchId)
          let touched = 0
          for (const taskId of staleIds) {
            const task = resolveTask(fresh, taskId)
            if (!task) continue
            if (!['queued', 'generating'].includes(String(task.signatureJobStatus || ''))) continue
            task.signatureJobStatus = ''
            task.signatureJobError = '服务重启中断了网站签字任务,已自动复位,可重新排队'
            touchTask(task)
            recalcTask(task)
            touched += 1
          }
          if (touched > 0) await saveBatchAsync(fresh)
          recovered += touched
        }, { label: 'recoverInterruptedSignatureJobs' })
      } catch (error) {
         
        console.error(`[signature] 启动恢复失败 ${batchId}: ${error?.message || error}`)
      }
    }
    if (recovered > 0) {
       
      console.warn(`[signature] 启动恢复:${recovered} 个签字任务从 queued/generating 复位(重启中断)`)
    }
    return recovered
  }

  return {
    canAutoQueueWebsiteSignature,
    clearAutoFinalSignatureAsset,
    clearSignatureRegionAsset,
    clearWebsiteFinalSignatureAsset,
    createSignatureJob,
    handleSignatureJobFailure,
    handleSignatureJobStart,
    handleSignatureJobSuccess,
    queueAutomaticWebsiteSignature,
    recoverInterruptedSignatureJobs,
    restoreAutomaticSignatureState,
  }
}

module.exports = {
  createSignatureJobService,
}
