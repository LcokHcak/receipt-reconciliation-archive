// G5: 共享 composable — 当 route.params.workspaceKey === 'latest' 时
// 自动 fetch 月份列表 → 选最新的非 demo 月 → router.replace 到具体 key。
// 没有正式月份则 fallback 到 'demo-2026-05'。所有 v2 子页 onMounted 调一次即可。
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchMonthlyWorkspaces } from '@/api/monthly'

const FALLBACK_DEMO = 'demo-2026-05'

function pickLatest(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  // 优先选最大的非 demo- 月份;否则选最大的 demo- 月份
  const formal = list.map((w) => String(w.workspaceKey || w.key || w))
    .filter((k) => k && !k.startsWith('demo-'))
    .sort().reverse()
  if (formal[0]) return formal[0]
  const demos = list.map((w) => String(w.workspaceKey || w.key || w))
    .filter(Boolean).sort().reverse()
  return demos[0] || ''
}

/**
 * 用法 (在 v2 子页 setup() 顶部):
 *   const { workspaceKey, isResolving } = useResolveWorkspaceKey()
 *   // workspaceKey 是 computed,等 resolve 完成后会变成具体 key
 * 返回 isResolving 期间 view 应该跳过 fetch (load() 里 if (isResolving.value) return)
 */
export function useResolveWorkspaceKey() {
  const route = useRoute()
  const router = useRouter()
  const isResolving = computed(() => String(route.params?.workspaceKey || '') === 'latest')
  const workspaceKey = computed(() => String(route.params?.workspaceKey || ''))

  async function tryResolve() {
    if (!isResolving.value) return
    try {
      const payload = await fetchMonthlyWorkspaces()
      // G5 live-probe: 后端响应是 { workspaces: [...] }
      const items = Array.isArray(payload?.workspaces) ? payload.workspaces
                  : Array.isArray(payload?.data) ? payload.data
                  : Array.isArray(payload?.items) ? payload.items
                  : Array.isArray(payload) ? payload
                  : []
      const target = pickLatest(items) || FALLBACK_DEMO
      // 保留当前路由 name + 其他 params,只换 workspaceKey
      router.replace({
        name: route.name,
        params: { ...route.params, workspaceKey: target },
        query: route.query,
      })
    } catch {
      // 网络挂了的兜底 — 直接跳 demo 让 v2 至少能渲染
      router.replace({
        name: route.name,
        params: { ...route.params, workspaceKey: FALLBACK_DEMO },
        query: route.query,
      })
    }
  }

  // route 一变就检查;mounted 后第一次会执行
  watch(() => route.params?.workspaceKey, () => { tryResolve() }, { immediate: true })

  return { workspaceKey, isResolving, tryResolve }
}
