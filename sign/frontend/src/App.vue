<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from './stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 版本水位横幅(2026-07-07):后端已更新而本页面还是旧 JS(长开不刷新)→ 常驻提示刷新。
// 实锤病例:回弹bug修复上线后操作员仍复现,因审核台页面自昨早未刷新。
const appUpdateAvailable = ref(false)
function onAppUpdated() { appUpdateAvailable.value = true }
onMounted(() => window.addEventListener('app-updated', onAppUpdated))
onBeforeUnmount(() => window.removeEventListener('app-updated', onAppUpdated))
function reloadApp() { window.location.reload() }

const isLogin = computed(() => route.name === 'login')
// F10-hotfix: v2 月度 / v2 审计 页面自带 AppLayout shell(SidebarProvider +
// AppSidebar),这里必须让位,否则会出现 v1 + v2 两个 sidebar 叠加。
const isV2Layout = computed(() => {
  const p = route.path || ''
  return p.startsWith('/monthly/v2') || p.startsWith('/audit/v2')
})
const monthlyWorkspaceKey = computed(() => String(route.params?.workspaceKey || 'latest'))

// roles 数组语义：空数组=所有登录用户可见；否则列出"允许看到"的角色
const R_REVIEWER = ['admin', 'reviewer']

// 0728 工作流#3-#6(新版反馈文档):按业务流重命名+归组,**路由 URL 全部不动**
// (书签/深链/测试全兼容,只动显示层)。分组=父项可点(去主页面)+缩进子项;
// 审核中心挂异常补救=文档方案2的导航级落地(页面级合并=波2 另议);
// 客户中心挂 已收/未收/日交付(原资料库)——先归组不物理合并页面(与用户讨论一致);
// 库清理从主导航移入配置台(0724#3);图标用文档 6 给的那套。
const navItems = computed(() => [
  { label: '首页', to: { name: 'workbench' }, roles: [], icon: '🏠' },
  { label: '收票建档', to: { name: 'intake' }, roles: R_REVIEWER, icon: '📥' },
  {
    label: '审核中心', to: { name: 'review', params: { batchId: 'latest' } }, roles: R_REVIEWER, icon: '✔',
    children: [
      { label: '审核台', to: { name: 'review', params: { batchId: 'latest' } }, roles: R_REVIEWER },
      { label: '异常补救', to: { name: 'daily-remedy' }, roles: R_REVIEWER },
    ],
  },
  {
    label: '客户中心', to: { name: 'agent-workspace' }, roles: [], icon: '👥',
    children: [
      { label: '已收客户组', to: { name: 'agent-workspace' }, roles: [] },
      { label: '未收客户组', to: { name: 'agent-workspace', query: { view: 'unreceived' } }, roles: [] },
      { label: '日交付', to: { name: 'library' }, roles: [] },
    ],
  },
  { label: '结算中心', to: { name: 'v2-monthly-shell', params: { workspaceKey: monthlyWorkspaceKey.value } }, roles: [], icon: '📑' },
  { divider: true },
  { label: '配置台', to: { name: 'admin-config' }, roles: ['admin'], icon: '⚙' },
  {
    label: '系统设置', to: { name: 'settings' }, roles: [], icon: '🛠',
    children: [
      { label: '设置', to: { name: 'settings' }, roles: [] },
      { label: '系统管理', to: { name: 'admin-dashboard' }, roles: ['admin'] },
    ],
  },
])

function canSee(item) {
  if (item.divider) return true
  if (!item.roles?.length || auth.user?.role === 'admin') {
    return true
  }
  return item.roles.includes(auth.user?.role)
}
// 分组父项:自己可见 && 至少一个子项可见才渲染子列表;分隔线原样放行
function visibleChildren(item) {
  return (item.children || []).filter(canSee)
}

async function logout() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div v-if="appUpdateAvailable" class="app-update-banner" role="alert">
    <span>⟳ 系统已更新——本页面还在运行旧版本,请刷新以获取修复与新功能</span>
    <button type="button" @click="reloadApp">立即刷新</button>
  </div>

  <RouterView v-if="isLogin" />

  <!-- v2 月度 / v2 审计 自带 AppLayout(SidebarProvider) shell,直接放行 -->
  <template v-else-if="isV2Layout">
    <RouterView />
  </template>

  <div v-else class="shell">
    <aside class="sidebar">
      <!-- 0728#4:Sign→本司 / 审核工作台→收票对账系统(品牌正名) -->
      <div class="brand">
        <span class="brand-mark">票</span>
        <div>
          <strong>收票对账系统</strong>
          <small>Receipt Reconciliation</small>
        </div>
      </div>

      <nav class="nav-list">
        <template v-for="(item, i) in navItems.filter(canSee)" :key="item.label || `div-${i}`">
          <div v-if="item.divider" class="nav-divider" aria-hidden="true" />
          <template v-else>
            <RouterLink :to="item.to" class="nav-link">
              <span class="nav-icon">{{ item.icon }}</span>
              {{ item.label }}
            </RouterLink>
            <RouterLink
              v-for="c in visibleChildren(item)"
              :key="c.label"
              :to="c.to"
              class="nav-link nav-child"
            >
              {{ c.label }}
            </RouterLink>
          </template>
        </template>
      </nav>

      <div class="sidebar-footer">
        <div class="user-badge">
          <span class="user-role">{{ auth.user?.role || '-' }}</span>
          <strong>{{ auth.user?.username || '未登录' }}</strong>
        </div>
        <button class="ghost-button" type="button" @click="logout">退出</button>
      </div>
    </aside>

    <main class="workspace">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
/* 版本水位横幅:固定顶部、显眼但不遮导航,常驻到用户刷新 */
.app-update-banner {
  position: fixed;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-radius: 0 0 10px 10px;
  background: #1d4ed8;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 4px 14px rgba(29, 78, 216, 0.35);
}

.app-update-banner button {
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  padding: 3px 12px;
  background: #fff;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.app-update-banner button:hover {
  background: #eff6ff;
}
</style>
