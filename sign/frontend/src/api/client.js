import axios from 'axios'

import router from '../router'
import { handleApiError, handleApiResponse } from './interceptor'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30000,
})

const DRAFT_STORAGE_KEY = 'sign:lastFormDraft'

function snapshotDraftIfMutation(error) {
  try {
    const config = error.config || {}
    const method = String(config.method || '').toUpperCase()
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return
    const data = config.data
    if (!data) return
    let parsed = data
    if (typeof data === 'string') {
      try { parsed = JSON.parse(data) } catch { parsed = data }
    } else if (data instanceof FormData) {
      return
    }
    const snapshot = {
      ts: Date.now(),
      pathname: window.location.pathname + window.location.search,
      method,
      url: config.url || '',
      payload: parsed,
    }
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Draft preservation is best effort and must not mask the API error.
  }
}

export function readPendingDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearPendingDraft() {
  try { sessionStorage.removeItem(DRAFT_STORAGE_KEY) } catch { /* ignore */ }
}

// 上传请求(FormData)自动放宽超时:全局 30s 会把大图上传半路掐断——
// 操作员传 4 张手机原图(15-25MB)在普通办公网要 1 分钟以上,30s 一到 axios 强制中止,
// 浏览器只报 "Network Error",重试永远失败(2026-07-06 生产事故,服务端全程零日志)。
// blob 响应(客户文件夹/现代/乐天/多模式交付包/台账 6 个导出端点全用 responseType:'blob')
// 同样放宽:大批次打包 zip 读几百张图+压缩轻松超 30s,默认超时会把导出半路掐断——
// 前端只报 "timeout of 30000ms exceeded / 文件夹都没导出来"(2026-07-08 生产事故)。
// 普通 JSON 接口维持 30s 不变。
api.interceptors.request.use((config) => {
  const isUpload = typeof FormData !== 'undefined' && config.data instanceof FormData
  const isDownload = config.responseType === 'blob'
  if (isUpload || isDownload) {
    config.timeout = 5 * 60 * 1000
  }
  return config
})

// 版本水位(2026-07-07):后端每次启动下发新 X-App-Boot。审核台是长开不刷新的 SPA,
// 部署后旧页面永远跑旧 JS(实锤:回弹bug修复上线后操作员仍复现,页面自昨早未刷新)。
// 水位变化 → 广播 app-updated,App.vue 弹"请刷新"横幅。
let appBootId = ''
export function getAppBootId() { return appBootId } // 错误上报带版本水位,定位旧页签
function noteBootId(boot) {
  const b = String(boot || '')
  if (!b) return
  if (!appBootId) {
    appBootId = b
  } else if (appBootId !== b) {
    appBootId = b // 只提示一次,横幅常驻到刷新
    try { window.dispatchEvent(new CustomEvent('app-updated')) } catch { /* SSR/测试环境无 window */ }
  }
}
api.interceptors.response.use((response) => {
  noteBootId(response?.headers?.['x-app-boot'])
  return response
})

// 主动版本探测(2026-07-13):被动水位只在有 API 响应时才比对——纯前端交互(如长时间只放大
// 看图、不发任何请求)会一直跑旧 JS,导致"已修复的 bug"在旧页签上被反复当新 bug 报(如 400%
// 图片拖不动那次)。页签重新可见时主动 fetch /readyz(带 X-App-Boot、免鉴权、秒回)补这个盲区。
function probeAppVersion() {
  if (typeof fetch !== 'function') return
  fetch('/readyz', { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => noteBootId(r.headers.get('x-app-boot')))
    .catch(() => { /* 探测失败无所谓,下次 API 调用照样能发现 */ })
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') probeAppVersion()
  })
}

api.interceptors.response.use(
  (response) => handleApiResponse(response),
  (error) => handleApiError(error, {
    router,
    snapshotDraft: snapshotDraftIfMutation,
    getAuthStore: async () => {
      const { useAuthStore } = await import('../stores/auth')
      return useAuthStore()
    },
  }),
)

export default api
