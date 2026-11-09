import { defineStore } from 'pinia'

import {
  appendCustomerImages as appendCustomerImagesApi,
  appendCustomerToBatch as appendCustomerToBatchApi,
  appendWorkspaceToBatch as appendWorkspaceToBatchApi,
  buildCustomerImageUrl,
  confirmCustomerImage as confirmCustomerImageApi,
  createWorkspace as createWorkspaceApi,
  deleteCustomer as deleteCustomerApi,
  deleteCustomerImage as deleteCustomerImageApi,
  deleteWorkspace as deleteWorkspaceApi,
  fetchCustomerLibraryState,
  fetchWorkspaceCustomers,
  fetchWorkspaces,
  importWorkspaceToBatch as importWorkspaceToBatchApi,
  uploadBatchGroupCode as uploadBatchGroupCodeApi,
  preprocessCustomer as preprocessCustomerApi,
  preprocessWorkspace as preprocessWorkspaceApi,
} from '../api/customer'

export const useCustomerStore = defineStore('customer', {
  state: () => ({
    state: null,
    workspaces: [],
    customers: [],
    activeWorkspace: '',
    selectedCustomerId: '',
    loading: false,
    actionLoading: '',
    error: '',
    message: '',
    uploadProgress: {
      active: false,
      status: 'idle',
      percent: 0,
      loaded: 0,
      total: 0,
      fileCount: 0,
      message: '',
    },
  }),

  getters: {
    selectedCustomer: (state) => state.customers.find((record) => (
      (record.customerId || record.id) === state.selectedCustomerId
    )) || state.customers[0] || null,
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

    setError(error) {
      if (typeof error === 'string') {
        this.error = error
      } else {
        this.error = error?.response?.data?.error || error?.message || String(error || '')
      }
      this.message = ''
    },

    beginUploadProgress(fileCount = 0) {
      this.uploadProgress = {
        active: true,
        status: 'uploading',
        percent: 0,
        loaded: 0,
        total: 0,
        fileCount,
        message: '正在上传图片',
      }
    },

    updateUploadProgress(event = {}) {
      const loaded = Number(event.loaded || 0)
      const total = Number(event.total || this.uploadProgress.total || 0)
      const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : this.uploadProgress.percent
      this.uploadProgress = {
        ...this.uploadProgress,
        active: true,
        status: 'uploading',
        loaded,
        total,
        percent,
      }
    },

    finishUploadProgress(status, message = '') {
      this.uploadProgress = {
        ...this.uploadProgress,
        active: true,
        status,
        percent: status === 'success' ? 100 : this.uploadProgress.percent,
        message,
      }
    },

    async loadState() {
      this.loading = true
      this.error = ''
      try {
        const payload = await fetchCustomerLibraryState()
        this.state = payload
        this.workspaces = payload.workspaces || payload.months || []
        // 用户已选的工作区固定不动(从别的页面切回来不许跳档),只有当前选择
        // 为空或已不在列表里时才回落到后端建议值/最新档。手动切换/新建仍照常。
        const stillExists = this.activeWorkspace && this.workspaces.includes(this.activeWorkspace)
        if (!stillExists) {
          this.activeWorkspace = payload.workspaceKey || this.workspaces.at?.(-1) || ''
        }
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async loadWorkspaces() {
      const payload = await fetchWorkspaces()
      this.workspaces = payload.workspaces || payload.items || []
      this.activeWorkspace = this.activeWorkspace || payload.workspaceKey || this.workspaces.at(-1) || ''
      return this.workspaces
    },

    async loadCustomers(workspaceKey = this.activeWorkspace) {
      if (!workspaceKey) {
        this.customers = []
        return []
      }
      const payload = await fetchWorkspaceCustomers(workspaceKey)
      this.customers = payload.customers || payload.items || []
      if (!this.customers.some((record) => (record.customerId || record.id) === this.selectedCustomerId)) {
        this.selectedCustomerId = this.customers[0]?.customerId || this.customers[0]?.id || ''
      }
      return this.customers
    },

    async refreshWorkspace(workspaceKey = this.activeWorkspace) {
      await this.loadWorkspaces()
      return this.loadCustomers(workspaceKey)
    },

    async createWorkspace(workspaceKey) {
      this.actionLoading = 'workspace-create'
      this.error = ''
      try {
        const payload = await createWorkspaceApi(workspaceKey)
        this.workspaces = payload.workspaces || this.workspaces
        this.activeWorkspace = payload.workspaceKey || workspaceKey
        this.customers = []
        this.selectedCustomerId = ''
        this.setMessage(`已创建工作区 ${this.activeWorkspace}`)
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async deleteActiveWorkspace() {
      if (!this.activeWorkspace) {
        return null
      }
      this.actionLoading = 'workspace-delete'
      this.error = ''
      try {
        const payload = await deleteWorkspaceApi(this.activeWorkspace)
        this.workspaces = payload.workspaces || []
        this.activeWorkspace = payload.workspaceKey || this.workspaces.at(-1) || ''
        this.customers = []
        this.selectedCustomerId = ''
        if (this.activeWorkspace) {
          await this.loadCustomers(this.activeWorkspace)
        }
        this.setMessage('工作区已删除')
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    // 「新建客户上传」已整体迁到 uploadQueue store(T6-B 后台队列,2026-07-21):
    // 原 createCustomerWithFiles 单飞路径删除。上传进度状态机(begin/update/finishUploadProgress)
    // 仍由下方"追加图片"路径使用,不动。

    async appendImagesToCustomer({ customerId, batchId = '', files }) {
      this.actionLoading = `append-images:${customerId}`
      this.error = ''
      this.beginUploadProgress(files.length)
      try {
        const payload = await appendCustomerImagesApi({
          workspaceKey: this.activeWorkspace,
          customerId,
          batchId,
          files,
          onUploadProgress: (event) => this.updateUploadProgress(event),
        })
        await this.loadCustomers(this.activeWorkspace)
        this.selectedCustomerId = customerId
        this.finishUploadProgress('success', `上传成功：追加 ${files.length} 张图片`)
        this.setMessage(batchId
          ? `已补图并进入批次，新增 ${payload.appendedTasks || 0} 个审核任务`
          : '已追加图片')
        return payload
      } catch (error) {
        this.finishUploadProgress('error', `上传失败：${error?.response?.data?.error || error?.message || '出现错误'}`)
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async deleteCustomer(customerId) {
      this.actionLoading = `customer-delete:${customerId}`
      this.error = ''
      try {
        const payload = await deleteCustomerApi(this.activeWorkspace, customerId)
        this.customers = payload.customers || []
        this.selectedCustomerId = this.customers[0]?.customerId || this.customers[0]?.id || ''
        const sync = payload.reviewSync || {}
        if (sync.removed) {
          this.setMessage('客户目录已删除，相关图片已移出审核批次')
        } else if (sync.reason === 'already_reviewed') {
          this.setMessage('客户目录已删除；审核批次已处理，未自动删除，请在审核或日度里继续处理')
        } else {
          this.setMessage('客户目录已删除')
        }
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async preprocessActiveWorkspace() {
      this.actionLoading = 'workspace-preprocess'
      this.error = ''
      try {
        const payload = await preprocessWorkspaceApi(this.activeWorkspace)
        await this.loadCustomers(this.activeWorkspace)
        this.setMessage('工作区预处理已提交')
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async preprocessCustomer(customerId) {
      this.actionLoading = `customer-preprocess:${customerId}`
      this.error = ''
      try {
        const payload = await preprocessCustomerApi(this.activeWorkspace, customerId)
        await this.loadCustomers(this.activeWorkspace)
        this.selectedCustomerId = customerId
        // 0729 静默排查:重识别切出的新图要回灌进原批次,这一步失败时后端会返回
        // batchAppendError(注释原话:「报 batchAppendError 让操作员用『补图/追加』自愈」),
        // 但**前端一处都没消费**,不管成败都弹「客户预处理已提交」。
        // 后果是新切出来的图(可能正是那张漏切的护照)留在客户库里,永远不会变成审核任务:
        // 不进审核台、不被识别、不进交付、不参与结算,而操作员看到的是"成功"。
        // 这正是 2026-07-22「缺护照」那个生产事故的复现路径,只是触发点换成了"回灌本身失败"。
        if (payload?.batchAppendError) {
          this.setMessage(
            // 不写 markdown 的 **:这句直接显示在界面上,星号会一起显示出来(0801 全站清理)
            `⚠ 重识别完成,但新切出的图「没能进回审核批次」:${payload.batchAppendError}。`
            + '这些图还留在客户库里,请用该客户的「补图」重试一次;不处理的话它们不会进审核台。',
          )
        } else if (payload?.batchAppend?.appendedTasks > 0) {
          // 成功也说清楚补进了几张 —— 否则操作员无从判断"重识别到底有没有改变什么"
          this.setMessage(`重识别完成,新增 ${payload.batchAppend.appendedTasks} 张图进审核批次`)
        } else {
          this.setMessage('客户预处理已提交')
        }
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async importActiveWorkspace(batchName, options = {}) {
      this.actionLoading = 'workspace-import'
      this.error = ''
      try {
        const payload = await importWorkspaceToBatchApi({
          workspaceKey: this.activeWorkspace,
          // 留空就传空,让后端自动命名(不触发重名校验);手填的名字原样传(后端校验同工作区不重名)。
          batchName: batchName || '',
          monthlyWorkspaceKey: options.monthlyWorkspaceKey || '',
          groupCodeImportJobId: options.groupCodeImportJobId || '',
          groupCodeSourceFile: options.groupCodeSourceFile || '',
          groupCodeFile: options.groupCodeFile || null,
          allowEmpty: options.allowEmpty || false,
        })
        const monthly = options.groupCodeFile
          ? `；团号表绑定当前审核批次`
          : (options.monthlyWorkspaceKey ? `；团号表绑定 ${options.monthlyWorkspaceKey}` : '')
        this.setMessage(`已导入新批次 ${payload.batchId || ''}${monthly}，识别处理中…（后台运行，可在审核页查看进度）`)
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    // 给已存在批次后台上传团号表(带进度回调)。上传完服务端秒回(解析在后台跑),不卡 UI。
    async uploadBatchGroupCode(batchId, file, onUploadProgress = null) {
      this.error = ''
      try {
        return await uploadBatchGroupCodeApi({ batchId, file, onUploadProgress })
      } catch (error) {
        this.setError(error)
        throw error
      }
    },

    async appendWorkspaceToBatch(batchId) {
      this.actionLoading = 'workspace-append'
      this.error = ''
      try {
        const payload = await appendWorkspaceToBatchApi({
          workspaceKey: this.activeWorkspace,
          batchId,
        })
        this.customers = payload.customers || this.customers
        this.setMessage(`已追加 ${payload.appendedTasks || 0} 个审核任务`)
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async appendCustomerToBatch({ customerId, batchId }) {
      this.actionLoading = `customer-append:${customerId}`
      this.error = ''
      try {
        const payload = await appendCustomerToBatchApi({
          workspaceKey: this.activeWorkspace,
          customerId,
          batchId,
        })
        this.customers = payload.customers || this.customers
        this.selectedCustomerId = customerId
        this.setMessage(`已追加 ${payload.appendedTasks || 0} 个审核任务`)
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async confirmImage({ customerId, imageId, status = 'accepted' }) {
      this.actionLoading = `image-confirm:${imageId}`
      this.error = ''
      try {
        const payload = await confirmCustomerImageApi({
          workspaceKey: this.activeWorkspace,
          customerId,
          imageId,
          status,
        })
        await this.loadCustomers(this.activeWorkspace)
        this.selectedCustomerId = customerId
        this.setMessage(status === 'accepted' ? '图片已通过复核' : '图片状态已更新')
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    async deleteImage({ customerId, imageId }) {
      this.actionLoading = `image-delete:${imageId}`
      this.error = ''
      try {
        const payload = await deleteCustomerImageApi({
          workspaceKey: this.activeWorkspace,
          customerId,
          imageId,
        })
        await this.loadCustomers(this.activeWorkspace)
        this.setMessage('图片已删除')
        return payload
      } catch (error) {
        this.setError(error)
        throw error
      } finally {
        this.actionLoading = ''
      }
    },

    imageUrl(record, image) {
      return buildCustomerImageUrl({
        workspaceKey: this.activeWorkspace,
        customerId: record.customerId || record.id,
        imageId: image.imageId || image.id,
      })
    },
  },
})
