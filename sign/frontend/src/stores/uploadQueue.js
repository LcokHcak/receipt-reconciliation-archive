// 上传后台队列 store(T6-B):uploadQueueCore(纯逻辑)的 Vue 响应式薄封装。
// 核心不依赖框架 → node:test 可直测;这里只做三件事:
//   ① subscribe→version 桥接响应式(core 直改普通对象,Vue 追不到,靠版本号驱动 computed);
//   ② 注入真实 api(建档上传/单客户识别);
//   ③ 上传成功回填客户看板(仅当仍停在同一工作区,防串台)。
// store 挂在 Pinia 根上,离开建档页/切路由队列照跑不断。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { createCustomerFromFiles, preprocessCustomer } from '../api/customer'
import { createUploadQueueCore } from '../lib/uploadQueueCore'
import { useCustomerStore } from './customer'

export const useUploadQueueStore = defineStore('uploadQueue', () => {
  const customerStore = useCustomerStore()
  const version = ref(0)

  const core = createUploadQueueCore({
    uploadApi: (args) => createCustomerFromFiles(args),
    preprocessApi: (workspaceKey, customerId) => preprocessCustomer(workspaceKey, customerId),
    onCustomersPayload: (payload, item) => {
      // 快照的 workspaceKey 可能已不是当前浏览的工作区 —— 只回填同区看板,跨区静默(数据服务端已落)
      if (Array.isArray(payload?.customers) && item.workspaceKey === customerStore.activeWorkspace) {
        customerStore.customers = payload.customers
      }
    },
    // 识别落定(成/败)→ 重拉客户看板(复核 H1):识别接口是阻塞式,resolve 时服务端状态已终局。
    // 不刷新的话:识别失败/低置信度在看板上不可见,且「可同步自动追进当前批次」的 watch
    // 依赖看板里的 readiness.ready —— 永远等不到,队列建的客户永不入批次(静默回归)。
    onPreprocessSettled: (item) => {
      if (item.workspaceKey !== customerStore.activeWorkspace) return
      customerStore.loadCustomers(item.workspaceKey).catch(() => { /* 轮询兜底会补 */ })
    },
  })
  core.subscribe(() => { version.value += 1 })

  // 队列里还有没传完(queued/在飞)或失败待处理的客户时,拦关页/刷新(浏览器原生确认框)。
  // 失败项也拦:真失败=客户确定没建档,File 还握在手里,关页即彻底丢失。
  // 挂 store 生命周期而非建档页生命周期:操作员切到审核页再关标签,守卫依然生效。
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (event) => {
      const { pending, failed } = core.counts()
      if (pending > 0 || failed > 0) {
        event.preventDefault()
        event.returnValue = ''
      }
    })
  }

  const items = computed(() => {
    void version.value
    return [...core.state.items]
  })
  const summary = computed(() => {
    void version.value
    return core.counts()
  })

  return {
    items,
    summary,
    enqueue: (payload) => core.enqueue(payload),
    retry: (id) => core.retry(id),
    remove: (id) => core.remove(id),
    clearFinished: () => core.clearFinished(),
    filesOf: (id) => core.filesOf(id), // 0727#1:失败/在途项的原图预览(File 仍在手才有)
  }
})
