import { createRouter, createWebHistory } from 'vue-router'

import LoginView from '../views/LoginView.vue'
import HomeView from '../views/HomeView.vue'
import { useAuthStore } from '../stores/auth'

const routes = [
  { path: '/login', name: 'login', component: LoginView },
  {
    // 首页分离(2026-07-18):HomeView 按角色分发 管理员版/审核员版,路由名不变
    path: '/',
    name: 'workbench',
    component: HomeView,
    meta: { requiresAuth: true },
  },
  {
    path: '/intake',
    name: 'intake',
    component: () => import('../views/CustomerLibraryView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'] },
  },
  {
    path: '/review/:batchId',
    name: 'review',
    component: () => import('../views/ReviewView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'] },
  },
  {
    path: '/library-cleanup',
    name: 'library-cleanup',
    component: () => import('../views/LibraryCleanupView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '库清理' },
  },
  {
    path: '/daily/remedy',
    name: 'daily-remedy',
    component: () => import('../views/DailyRemedyView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '日度待补救' },
  },
  {
    path: '/daily/remedy/:workspaceKey',
    name: 'daily-remedy-workspace',
    component: () => import('../views/DailyRemedyView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '日度待补救' },
  },
  {
    path: '/export/:batchId',
    name: 'export',
    component: () => import('../views/ExportView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    path: '/library',
    name: 'library',
    component: () => import('../views/LibraryView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/training',
    name: 'training',
    component: () => import('../views/TrainingView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    // 代理工作台 V2:跨批次客户级读模型(月份+代理+模式+状态筛选;finance 只读)
    path: '/agents',
    name: 'agent-workspace',
    component: () => import('../views/AgentWorkspaceView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'finance', 'reviewer'], title: '代理工作台' },
  },
  // F10: v1 月度 12 页全删,/monthly 入口统一打到 v2 shell。
  // 老 URL 进来 → 自动跳 v2 对应页 (workspaceKey='latest' 时 v2 shell 会 resolveLatest)。
  { path: '/monthly', redirect: '/monthly/v2/latest' },
  { path: '/monthly/overview', redirect: '/monthly/v2/latest' },
  { path: '/monthly/:workspaceKey/overview',       redirect: (to) => `/monthly/v2/${to.params.workspaceKey}` },
  { path: '/monthly/:workspaceKey/audit',          redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/audit` },
  { path: '/monthly/:workspaceKey/delivery',       redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/delivery` },
  { path: '/monthly/:workspaceKey/logs',           redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/logs` },
  { path: '/monthly/:workspaceKey/ledger',         redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/ledger` },
  { path: '/monthly/:workspaceKey/remedy',         redirect: (to) => `/daily/remedy/${to.params.workspaceKey}` },
  { path: '/monthly/:workspaceKey/groups',         redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/groups` },
  { path: '/monthly/:workspaceKey/bills',          redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/bills` },
  { path: '/monthly/:workspaceKey/missing',        redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/unreceived` },
  { path: '/monthly/:workspaceKey/errors',         redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/errors` },
  { path: '/monthly/:workspaceKey/pending-reviews', redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/bill-review` },
  { path: '/monthly/:workspaceKey/badcases',       redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/badcases` },
  // Admin routes — admin only
  {
    path: '/admin',
    redirect: { name: 'admin-dashboard' },
  },
  {
    path: '/admin/dashboard',
    name: 'admin-dashboard',
    component: () => import('../views/AdminDashboardView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    path: '/admin/logs',
    name: 'admin-logs',
    component: () => import('../views/AdminLogsView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    path: '/admin/feedback',
    name: 'admin-feedback',
    component: () => import('../views/AdminFeedbackView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('../views/AdminUsersView.vue'),
    meta: { requiresAuth: true, roles: ['admin'] },
  },
  {
    path: '/admin/config',
    name: 'admin-config',
    component: () => import('../views/ConfigConsoleView.vue'),
    meta: { requiresAuth: true, roles: ['admin'], title: '配置台' },
  },
  // ── v2 试验路由 — Sprint C 设计系统沙盒 ──────────────────────────
  // 独立于现有 /monthly/* 路由，不影响任何现有页面
  {
    path: '/monthly/v2',
    redirect: { name: 'v2-monthly-shell', params: { workspaceKey: 'latest' } },
  },
  {
    path: '/monthly/v2/:workspaceKey',
    name: 'v2-monthly-shell',
    component: () => import('../views/v2/MonthlyV2View.vue'),
    meta: { requiresAuth: true, title: '结算中心' },
  },
  {
    // G2: Sprint G — v2 结算配置 (扣点 + 模式归类 + 测试种子 + 健康)
    path: '/monthly/v2/:workspaceKey/setup',
    redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/bill-match`,
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '月份配置 v2' },
  },
  {
    // 月度数据导入(灾备/迁移):团号汇总 + 日度台账直导。正常台账走 OCR 审核台。
    path: '/monthly/v2/:workspaceKey/imports',
    name: 'v2-monthly-imports',
    component: () => import('../views/v2/ImportsView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '月度数据导入(灾备)' },
  },
  {
    path: '/monthly/v2/:workspaceKey/conflicts',
    name: 'v2-monthly-conflicts',
    component: () => import('../views/v2/ConflictsView.vue'),
    meta: { requiresAuth: true, title: '字段冲突' },
  },
  {
    path: '/monthly/v2/:workspaceKey/unreceived',
    name: 'v2-monthly-unreceived',
    component: () => import('../views/v2/UnreceivedView.vue'),
    meta: { requiresAuth: true, title: '未收清单' },
  },
  // 手动录入页已下线(2026-06-12):未收补录改在「未收清单」页一键从账单反向补台账,
  // 字段全部来自账单真实数据,不再人工手填(旧页的 mock 汇率/假客户问题随之消除)。
  {
    // F4: Sprint F — v2 收票台账
    path: '/monthly/v2/:workspaceKey/ledger',
    name: 'v2-monthly-ledger',
    component: () => import('../views/v2/LedgerView.vue'),
    meta: { requiresAuth: true, title: '收票台账 v2' },
  },
  {
    // F5: Sprint F — v2 账单明细
    path: '/monthly/v2/:workspaceKey/bill-match',
    name: 'v2-monthly-bill-match',
    component: () => import('../views/v2/BillMatchView.vue'),
    meta: { requiresAuth: true, title: '账单匹配 v2' },
  },
  {
    // G15 v2: bill review merges field conflicts, ambiguous matches, and fuzzy matches.
    path: '/monthly/v2/:workspaceKey/bill-review',
    name: 'v2-monthly-bill-review',
    component: () => import('../views/v2/BillReviewView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '账单核对 v2' },
  },
  {
    // F5: Sprint F - v2 bills detail
    path: '/monthly/v2/:workspaceKey/bills',
    name: 'v2-monthly-bills',
    component: () => import('../views/v2/BillsView.vue'),
    meta: { requiresAuth: true, title: '账单明细 v2' },
  },
  {
    // 品牌活动(活动数据)第5个桶
    path: '/monthly/v2/:workspaceKey/brand-activity',
    name: 'v2-monthly-brand-activity',
    component: () => import('../views/v2/BrandActivityView.vue'),
    meta: { requiresAuth: true, title: '品牌活动' },
  },
  {
    // F5: Sprint F — v2 团号表
    path: '/monthly/v2/:workspaceKey/groups',
    name: 'v2-monthly-groups',
    component: () => import('../views/v2/GroupCodesView.vue'),
    meta: { requiresAuth: true, title: '团号表 v2' },
  },
  {
    // F6: Sprint F — v2 月度交付
    path: '/monthly/v2/:workspaceKey/delivery',
    name: 'v2-monthly-delivery',
    component: () => import('../views/v2/DeliveryView.vue'),
    meta: { requiresAuth: true, title: '月度交付 v2' },
  },
  {
    // 交付前核对：导出前过一遍 merge 结果，可逐行人工改
    path: '/monthly/v2/:workspaceKey/delivery-check',
    name: 'v2-monthly-delivery-check',
    component: () => import('../views/v2/DeliveryCheckView.vue'),
    meta: { requiresAuth: true, title: '交付前核对' },
  },
  {
    // F7: Sprint F — v2 错表 (cross-check + 标记解决 + departure-sync 审计)
    path: '/monthly/v2/:workspaceKey/errors',
    name: 'v2-monthly-errors',
    component: () => import('../views/v2/ErrorsView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: '错表 v2' },
  },
  { path: '/monthly/v2/:workspaceKey/pending-reviews', redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/bill-review` },
  // F9a: 3 个只读 dashboard / 列表页 (audit 不同于 D4b /audit/v2/logs:这里看数,那边看 audit_log)
  { path: '/monthly/v2/:workspaceKey/missing', redirect: (to) => `/monthly/v2/${to.params.workspaceKey}/unreceived` },
  { path: '/monthly/v2/:workspaceKey/logs', name: 'v2-monthly-logs',
    component: () => import('../views/v2/LogsView.vue'),
    meta: { requiresAuth: true, title: '操作日志 v2' } },
  { path: '/monthly/v2/:workspaceKey/audit', name: 'v2-monthly-audit',
    component: () => import('../views/v2/AuditDashboardView.vue'),
    meta: { requiresAuth: true, title: '对账总览 v2' } },
  // F9b update: 待补救属于日度审核主流程,月度 URL 仅保留兼容跳转.
  { path: '/monthly/v2/:workspaceKey/remedy', redirect: (to) => `/daily/remedy/${to.params.workspaceKey}` },
  { path: '/monthly/v2/:workspaceKey/badcases', name: 'v2-monthly-badcases',
    component: () => import('../views/v2/BadcaseView.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'reviewer'], title: 'Badcase v2' } },
  // D4b: workspace-independent audit log viewer
  {
    path: '/audit/v2/logs',
    name: 'v2-audit-logs',
    component: () => import('../views/v2/AuditLogsView.vue'),
    meta: { requiresAuth: true, title: '审计日志' },
  },

  // Legacy redirects
  { path: '/customer-library', redirect: '/intake' },
  { path: '/image-review/:batchId', redirect: (to) => `/review/${to.params.batchId}` },
  { path: '/field-review/:batchId', redirect: (to) => `/review/${to.params.batchId}` },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// G5: 'latest' workspaceKey 自动 resolve — 所有 v2 月度页(子页)的 URL 若包含
// workspaceKey === 'latest', 拉月份列表选最新一个 replace 过去。
// MonthlyV2View 自己也有 resolveLatest,这里在更早的 router 层覆盖,
// 保证 ledger/bills/setup/imports/... 任何 v2 子页直链 latest 也能落地。
async function resolveLatestForV2(to) {
  const wk = String(to.params?.workspaceKey || '')
  if (wk !== 'latest') return null
  if (!to.path.startsWith('/monthly/v2')) return null
  try {
    const { fetchMonthlyWorkspaces } = await import('../api/monthly')
    const payload = await fetchMonthlyWorkspaces()
    // G5 live-probe: 后端响应是 { workspaces: [...] } — 不是 data/items
    const items = Array.isArray(payload?.workspaces) ? payload.workspaces
                : Array.isArray(payload?.data) ? payload.data
                : Array.isArray(payload?.items) ? payload.items
                : Array.isArray(payload) ? payload
                : []
    const formal = items.map((w) => String(w.workspaceKey || w.key || w))
      .filter((k) => k && !k.startsWith('demo-')).sort().reverse()
    const demos = items.map((w) => String(w.workspaceKey || w.key || w))
      .filter(Boolean).sort().reverse()
    const target = formal[0] || demos[0] || 'demo-2026-05'
    return { name: to.name, params: { ...to.params, workspaceKey: target }, query: to.query, replace: true }
  } catch {
    return { name: to.name, params: { ...to.params, workspaceKey: 'demo-2026-05' }, query: to.query, replace: true }
  }
}

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.checked) {
    try {
      await auth.restoreSession()
    } catch {
      // Network failure or invalid cookie — treat as anonymous and let the
      // auth check below redirect to /login.
    }
  }

  if (!to.meta.requiresAuth) {
    return true
  }
  if (!auth.user) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (auth.user.role === 'admin') {
    // admin 也要走 resolveLatest 拦截
    const r = await resolveLatestForV2(to)
    if (r) return r
    return true
  }
  const roles = to.meta.roles || []
  if (roles.length && !roles.includes(auth.user.role)) {
    return { name: 'workbench' }
  }
  // 非 admin 也要走 resolveLatest
  const r = await resolveLatestForV2(to)
  if (r) return r
  return true
})

export default router
