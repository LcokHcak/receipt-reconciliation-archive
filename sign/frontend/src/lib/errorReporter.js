import api, { getAppBootId } from '../api/client'

// 前端喊疼(#4,2026-07-14):未捕获异常/未处理 Promise 拒绝/Vue 渲染错误 → POST /api/client-errors。
// 原则:fire-and-forget,上报本身永不打扰操作员(吞掉一切失败);
// 节流:同一条消息 60 秒只报一次,全局每分钟最多 5 条(服务端还有每用户 10 分钟 30 条的窗)。

const recent = new Map() // message -> lastSentAt
let windowStart = 0
let windowCount = 0

function shouldSend(message) {
  const now = Date.now()
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0 }
  if (windowCount >= 5) return false
  const last = recent.get(message) || 0
  if (now - last < 60_000) return false
  recent.set(message, now)
  if (recent.size > 100) recent.clear() // 防长开页签无限膨胀
  windowCount += 1
  return true
}

export function reportClientError(message, stack = '', source = '') {
  const msg = String(message || '').trim()
  if (!msg || !shouldSend(msg)) return
  try {
    api.post('/client-errors', {
      message: msg,
      stack: String(stack || '').slice(0, 2000),
      url: `${source ? `[${source}] ` : ''}${window.location?.hash || window.location?.pathname || ''}`,
      appBoot: getAppBootId() || '',
    }).catch(() => {}) // 喊疼通道自己绝不能再喊疼
  } catch { /* 同上 */ }
}

export function installErrorReporter(app) {
  window.addEventListener('error', (event) => {
    reportClientError(event?.message || event?.error?.message, event?.error?.stack, 'window')
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason
    reportClientError(reason?.message || String(reason || ''), reason?.stack, 'promise')
  })
  if (app?.config) {
    const previous = app.config.errorHandler
    app.config.errorHandler = (error, instance, info) => {
      reportClientError(error?.message || String(error || ''), error?.stack, `vue:${info || ''}`)
      if (typeof previous === 'function') previous(error, instance, info)
      else console.error(error) // 保留控制台可见性,别把错误藏起来
    }
  }
}
