import { humanErrorMessage } from '../lib/errorMessage'
import { defineStore } from 'pinia'

import { appendCustomerImages as appendCustomerImagesApi } from '../api/customer'
import {
  approveSourceGroup,
  deleteBatch,
  deleteManualSignature,
  deleteTask,
  deleteWebsiteSignature,
  exportBatch,
  fetchBatch,
  fetchWorkbenchState,
  importBatchLedger,
  replaceBatchGroupCode,
  queueBatchWebsiteSignatures,
  queueTaskWebsiteSignature,
  updateTask,
} from '../api/workbench'
import { rephotoReasonLabel } from '../lib/reviewDisplay'

export const useWorkbenchStore = defineStore('workbench', {
  state: () => ({
    batches: [],
    currentBatch: null,
    tasks: [],
    loading: false,
    actionLoading: '',
    error: '',
    errorDetail: null,
    message: '',
  }),

  getters: {
    latestBatchId: (state) => state.batches[0]?.id || state.batches[0]?.batchId || '',
    metrics: (state) => ({
      batches: state.batches.length,
      files: state.batches.reduce((sum, batch) => sum + Number(batch.fileCount || batch.taskCount || batch.counts?.total || 0), 0),
      pending: state.batches.reduce((sum, batch) => (
        sum + Number(batch.pendingCount || batch.waitingReviewCount || batch.counts?.fields || 0)
          + Number(batch.counts?.classification || 0)
          + Number(batch.counts?.signature || 0)
          + Number(batch.counts?.finalReview || 0)
      ), 0),
      approved: state.batches.reduce((sum, batch) => sum + Number(batch.approvedCount || batch.counts?.approved || 0), 0),
    }),
  },

  actions: {
    setMessage(message = '') {
      this.message = message
      if (this._messageTimer) {
        clearTimeout(this._messageTimer)
        this._messageTimer = null
      }
      if (message) {
        this._messageTimer = setTimeout(() => {
          if (this.message === message) {
            this.message = ''
          }
          this._messageTimer = null
        }, 4000)
      }
    },

    setError(error, detail = null) {
      this.error = typeof error === 'string'
        ? error
        : (error?.response?.data?.error || error?.message || String(error || ''))
      // 结构化定位信息(如台账导入失败的 taskId),跟随 error 生命周期;不传则清空,避免残留旧链接。
      // 传的是 axios 错误对象且没显式给 detail → 自动从响应体挖 details(标准形状),
      // 兼容顶层 taskId 旧端点形状——所有裸 setError(error) 调用点免费获得「定位到这张图」。
      if (detail === null && error && typeof error === 'object') {
        const data = error.response?.data
        detail = data?.details
          || (data?.taskId ? { taskId: data.taskId, issue: data.issue || '' } : null)
      }
      this.errorDetail = detail
    },

    resolveBatchId(batchId) {
      return batchId === 'latest' ? this.latestBatchId : batchId
    },

    async fetchBatches() {
      this.loading = true
      this.error = ''
      try {
        const payload = await fetchWorkbenchState()
        this.batches = payload.batches || []
        return this.batches
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async fetchBatch(batchId) {
      const resolvedBatchId = this.resolveBatchId(batchId)
      if (!resolvedBatchId) {
        this.currentBatch = null
        this.tasks = []
        return null
      }

      this.loading = true
      this.error = ''
      try {
        const payload = await fetchBatch(resolvedBatchId)
        this.currentBatch = payload.batch || payload
        this.tasks = this.currentBatch.tasks || []
        return this.currentBatch
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async updateTask(taskId, updates) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      const payload = await updateTask(this.currentBatch.id, taskId, updates)
      // 保存成功=世界变了:旧红条(缺护照/日期超范围…)按下一轮动作重新判定,
      // 不清的话"处理完还挂着旧错"(2026-07-14 报障#2);再失败会立刻重挂新错。
      this.setError('')
      // 增量合并(2026-07-08 审核卡顿根治):PATCH 响应本就带算好的完整任务
      // (后端 applyComputedFields),原地替换即可——此前每次确认/重拍/恢复都整批
      // refetch,大批次(500+任务)每一下点击拉几 MB JSON + loading 闪烁 + 整表重渲染,
      // 就是"确认/跳图一顿一顿"的根源。徽章/分组计数全是客户端从 tasks filter 的,
      // 合并后自动正确;tasks 与 currentBatch.tasks 同引用,splice 双侧生效。
      const updated = payload?.task
      if (updated?.id) {
        const index = this.tasks.findIndex((task) => task.id === updated.id)
        if (index >= 0) {
          this.tasks.splice(index, 1, updated)
          // 捎带的批次元信息:团号表后台解析状态(parsing→ready)不随任务变,
          // 不合并的话结算按钮会按旧状态多锁(reviewer MEDIUM)
          const meta = payload?.batchMeta
          if (meta && meta.groupCodeStatus !== undefined) {
            this.currentBatch.groupCodeStatus = meta.groupCodeStatus
          }
          return this.currentBatch
        }
      }
      // 兜底:响应没带任务(异常/未来变更)→ 退回旧行为整批刷新,宁慢勿错
      return this.fetchBatch(this.currentBatch.id)
    },

    async approveGroup(groupKey) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      const batchId = this.currentBatch.id
      this.actionLoading = `approve:${groupKey}`
      this.error = ''
      try {
        const payload = await approveSourceGroup(batchId, groupKey)
        await this.fetchBatch(batchId)
        this.setMessage(summarizeGroupApproval(payload))
        return payload
      } catch (error) {
        // 走 setError 带 details(台账超范围/缺护照等携带 taskId 定位信息;
        // 旧裸赋值只写文本,errorDetail 残留旧值 → 定位链接可能指向历史任务)
        this.setError(error, error.response?.data?.details || null)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async importLedgerAndMatch() {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      const batchId = this.currentBatch.id
      this.actionLoading = 'import-ledger'
      this.setError('')
      try {
        const payload = await importBatchLedger(batchId)
        await this.fetchBatch(batchId)
        this.setMessage(summarizeLedgerImport(payload))
        return payload
      } catch (error) {
        this.setError(error, error.response?.data?.details || null)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    // 替换本批次团号表(审核台「当前批次」卡入口)。只换团号表,不动客户图/审核进度。
    async replaceBatchGroupCodeFile(file) {
      if (!this.currentBatch?.id) throw new Error('No active batch')
      const batchId = this.currentBatch.id
      this.actionLoading = 'replace-group-code'
      this.setError('')
      try {
        const payload = await replaceBatchGroupCode(batchId, file)
        await this.fetchBatch(batchId)
        // 团号表解析已挪后台:上传完先标 parsing,这里不再宣称条数(避免误报 0 条)。
        this.setMessage('已上传新团号表,后台解析中…解析好后导入日度台账 / 结算会用新表匹配')
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async appendImagesToSourceGroup({ workspaceKey, customerId, files }) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      if (!workspaceKey || !customerId) {
        throw new Error('Missing customer reference')
      }
      const batchId = this.currentBatch.id
      this.actionLoading = `append-images:${customerId}`
      this.error = ''
      try {
        const payload = await appendCustomerImagesApi({
          workspaceKey,
          customerId,
          batchId: this.currentBatch.id,
          files,
        })
        await this.fetchBatch(batchId)
        this.setMessage(`已追加图片并重新识别，新增 ${payload.appendedTasks || 0} 个审核任务`)
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async markTaskRephoto(taskId, reason = '') {
      this.actionLoading = `rephoto:${taskId}`
      this.error = ''
      try {
        // reason(0727反馈#10 分键):blurry/missing/other;空=旧入口裸标,后端原因留空兼容。
        await this.updateTask(taskId, { reviewed: false, rephotoRequested: true, rephotoReason: reason })
        this.setMessage(reason ? `已标记为需重拍(${rephotoReasonLabel(reason)})` : '已标记为需重拍')
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async restoreTask(taskId) {
      this.actionLoading = `restore:${taskId}`
      this.error = ''
      try {
        await this.updateTask(taskId, { reviewed: false, rephotoRequested: false })
        this.setMessage('已恢复审核')
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async confirmTaskClassification(taskId, docTypeFinal) {
      this.actionLoading = `confirm:${taskId}`
      this.error = ''
      try {
        await this.updateTask(taskId, { docTypeFinal, reviewed: false, rephotoRequested: false })
        this.setMessage('分类已确认')
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async deleteTask(taskId) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      const batchId = this.currentBatch.id
      this.actionLoading = `delete:${taskId}`
      this.error = ''
      try {
        const payload = await deleteTask(batchId, taskId)
        this.setMessage('文件已删除')
        if (payload.batchDeleted) {
          await this.fetchBatches()
          this.currentBatch = null
          this.tasks = []
          return payload
        }
        // DELETE 响应本就带删除后的整批摘要——直接用,省掉第二次全量往返
        if (payload.batch?.id) {
          this.currentBatch = payload.batch
          this.tasks = payload.batch.tasks || []
        } else {
          await this.fetchBatch(batchId)
        }
        return payload
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async queueWebsiteSignature(taskId) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      this.actionLoading = `signature:${taskId}`
      this.error = ''
      try {
        await queueTaskWebsiteSignature(this.currentBatch.id, taskId)
        this.setMessage('签字任务已加入队列')
        return this.fetchBatch(this.currentBatch.id)
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async queueBatchSignatures() {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      this.actionLoading = 'signature:batch'
      this.error = ''
      try {
        const payload = await queueBatchWebsiteSignatures(this.currentBatch.id)
        this.setMessage(`已加入 ${payload.queuedCount || 0} 个签字任务`)
        return this.fetchBatch(this.currentBatch.id)
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async deleteSignature(task) {
      if (!this.currentBatch?.id || !task?.id) {
        throw new Error('No active task')
      }
      this.actionLoading = `signature-delete:${task.id}`
      this.error = ''
      try {
        if (task.finalSignatureSource === 'manual_drawn') {
          await deleteManualSignature(this.currentBatch.id, task.id)
        } else {
          await deleteWebsiteSignature(this.currentBatch.id, task.id)
        }
        this.setMessage('签字已删除')
        return this.fetchBatch(this.currentBatch.id)
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async exportCurrentBatch(options = {}) {
      if (!this.currentBatch?.id) {
        throw new Error('No active batch')
      }
      return exportBatch(this.currentBatch.id, options)
    },

    async deleteBatch(batchId) {
      if (!batchId) throw new Error('batchId required')
      this.actionLoading = `batch-delete:${batchId}`
      this.error = ''
      try {
        await deleteBatch(batchId)
        this.setMessage('批次已删除')
        if (this.currentBatch?.id === batchId) {
          this.currentBatch = null
          this.tasks = []
        }
        await this.fetchBatches()
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },
  },
})

function summarizeGroupApproval(payload = {}) {
  const sync = payload.ledgerSync
  if (!sync) return '客户组已通过'
  if (sync.error) return `客户组已通过；写入台账失败：${sync.error}`
  if (sync.skippedReason === 'no_tasks') return '客户组已通过；没有可写入台账的任务'
  if (sync.skippedReason === 'no_receipt_tasks') return '客户组已通过；本组没有小票，不写入台账'

  const inserted = Number(sync.inserted || 0)
  const skipped = Number(sync.skipped || 0)
  const workspace = sync.workspaceKey ? `（${sync.workspaceKey}）` : ''
  if (inserted > 0) return `客户组已通过；已写入台账 ${inserted} 条${workspace}，跳过 ${skipped} 条`
  if (skipped > 0) return `客户组已通过；台账已有记录${workspace}，跳过 ${skipped} 条`
  return `客户组已通过；未产生台账记录${workspace}`
}

function summarizeLedgerImport(payload = {}) {
  const tour = payload.tourMatch || {}
  const matched = Number(tour.matched || 0)
  const tourNotFound = Number(tour.tourNotFound || 0)
  const dateOut = Number(tour.dateOutOfWindow || 0)
  const scanned = Number(tour.scanned || 0)
  const skippedRephoto = (payload.skippedGroups || []).filter((group) => group.reason === 'rephoto_requested').length
  const skippedNoReceipts = (payload.skippedGroups || []).filter((group) => group.reason === 'no_receipts').length
  const skippedNotApproved = (payload.skippedGroups || []).filter((group) => group.reason === 'not_approved').length
  const skippedInvalidPassport = (payload.skippedGroups || []).filter((group) => group.reason === 'invalid_passport_count').length
  const skippedDuplicateBatch = (payload.skippedGroups || []).filter((group) => group.reason === 'duplicate_receipts_in_batch').length
  // 0729 静默排查:撞键被压掉的票**排在最前面**。它不是例行统计,是待人核实的数据错误
  // —— 同店同日同票号只可能是一笔交易(库里 row_hash 也是这个口径,不含客户),
  // 两个客户组都有,只能是票号读错或建档串了客户。被压掉的那张不进台账 = 少一笔返点。
  const suppressed = Array.isArray(payload.suppressedReceipts) ? payload.suppressedReceipts : []
  const alert = suppressed.length
    ? `⚠ ${suppressed.length} 张小票因与本批其它客户撞「店+票号+购买日」被挡下，没进台账，请核实票号是否读错：`
      + suppressed.slice(0, 5).map((s) => `${s.groupLabel || s.groupKey} 的 ${s.receiptKey}`
        + (s.conflictWithGroupLabel || s.conflictWithGroupKey ? `(与 ${s.conflictWithGroupLabel || s.conflictWithGroupKey} 撞)` : '')).join('、')
      + (suppressed.length > 5 ? ` 等 ${suppressed.length} 张` : '')
      + '。'
    : ''
  return `${alert}导入台账完成：可入台账客户组 ${payload.importedGroups || 0}/${payload.eligibleGroups || 0}，本次新增 ${payload.insertedRows || 0}，已存在/重复未写入 ${payload.skippedRows || 0}；团号匹配扫描 ${scanned}，命中 ${matched}，未命中 ${tourNotFound + dateOut}；跳过重拍 ${skippedRephoto} 组、无小票 ${skippedNoReceipts} 组、护照异常 ${skippedInvalidPassport} 组、批内重复 ${skippedDuplicateBatch} 组、未完成 ${skippedNotApproved} 组`
}
