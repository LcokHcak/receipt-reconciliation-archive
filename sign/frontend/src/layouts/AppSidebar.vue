<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertTriangle,
  Bug,
  ClipboardCheck,
  DatabaseBackup,
  Download,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  GitBranch,
  Image,
  Inbox,
  LayoutDashboard,
  Receipt,
  Sparkles,  ScrollText,
  SearchCheck,
  Settings,
  Shield,  UserCog,
  Users,
} from 'lucide-vue-next'

import Sidebar from '@/components/ui/sidebar.vue'
import SidebarContent from '@/components/ui/sidebar-content.vue'
import SidebarFooter from '@/components/ui/sidebar-footer.vue'
import SidebarGroup from '@/components/ui/sidebar-group.vue'
import SidebarGroupLabel from '@/components/ui/sidebar-group-label.vue'
import SidebarHeader from '@/components/ui/sidebar-header.vue'
import SidebarMenu from '@/components/ui/sidebar-menu.vue'
import SidebarMenuButton from '@/components/ui/sidebar-menu-button.vue'
import SidebarMenuItem from '@/components/ui/sidebar-menu-item.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  workspaceKey: { type: String, default: '' },
})

const route = useRoute()
const auth = useAuthStore()
const isDemo = computed(() => props.workspaceKey?.startsWith('demo-'))
const isAdmin = computed(() => auth.user?.role === 'admin')

function v2(page) {
  const wk = props.workspaceKey || 'demo-2026-05'
  return page ? `/monthly/v2/${wk}/${page}` : `/monthly/v2/${wk}`
}

// 2026-06 导航重分组 + 改名(对操作员更口语)。**所有路由 to 不变**,只动分组与文案。
// 改名映射见 docs/UI字段说明(ledger→数据库-台账、groups→数据库-团号、
// brand-activity→特殊活动、delivery-check→最终核对、delivery→最终交付、
// intake→建档与收票、library→资料库)。
// 业务里的 mode 值(限时活动类)不受影响,这里只是侧栏显示名。
//
// 0729 对齐主侧栏:0728 波3「**全站**重命名+导航归组」只改了 App.vue 那套侧栏,
// 漏了这一套(/monthly/v2 与 /audit/v2 自带 AppLayout shell,用的是本组件)。
// 结果是同一个系统里两套导航:分组名、条目、用词全不一样,而且**结算中心里点不到审核台**
// ——审核员在结算中心发现要复核的票,得先回首页再进审核中心。
// 这里把顶层结构对齐成主侧栏的样子(总览/审核中心/客户中心/结算中心/…),
// 同时**一个入口都不删**:模型训练、Badcase、数据导入、数据库-团号、操作/审计日志
// 这 6 个页面全站只有本侧栏能到,删了就成了只能手打 URL 的孤儿页
// (/library-cleanup 已经是这个下场,见 0729 回执 C2)。
const navGroups = computed(() => {
  const groups = [
    {
      label: '总览',
      items: [
        { label: '首页', icon: LayoutDashboard, to: '/' },
        { label: '收票建档', icon: Image, to: '/intake' },
      ],
    },
    {
      // 与主侧栏同名同序:审核台在前(主作业面),异常补救在后(承接件)
      label: '审核中心',
      items: [
        { label: '审核台', icon: SearchCheck, to: '/review/latest' },
        { label: '异常补救', icon: AlertTriangle, to: '/daily/remedy' },
      ],
    },
    {
      label: '客户中心',
      items: [
        { label: '已收客户组', icon: Users, to: '/agents' },
        { label: '未收客户组', icon: Inbox, to: '/agents?view=unreceived' },
        { label: '日交付', icon: FileSpreadsheet, to: '/library' },
      ],
    },
    {
      label: '结算中心',
      items: [
        { label: '月度首页',   icon: LayoutDashboard, to: v2('') },
        { label: '账单匹配',   icon: Receipt,         to: v2('bill-match') },
        { label: '特殊活动',   icon: Sparkles,        to: v2('brand-activity') },
        { label: '账单核对',   icon: SearchCheck,     to: v2('bill-review') },
        { label: '未收清单',   icon: Inbox,           to: v2('unreceived') },
        { label: '最终核对',   icon: ClipboardCheck,  to: v2('delivery-check') },
        { label: '最终交付',   icon: Download,        to: v2('delivery') },
        // 收票台账入口删除(0728#7-1):查看由 客户中心→已收客户组 筛选覆盖;路由 v2('ledger') 保留只撤导航位
        { label: '数据库-团号', icon: GitBranch,       to: v2('groups') },
        { label: '数据导入(灾备)', icon: DatabaseBackup, to: v2('imports') },
        // 字段冲突已并入「账单核对」(/bill-review 的字段冲突 Tab),路由保留兼容旧链接。
        // 错表(/errors)、对账总览(/audit)操作员不用,从导航隐藏(路由保留)。
      ],
    },
    {
      label: '溯源 & 日志',
      items: [
        { label: '操作日志', icon: ScrollText,  to: v2('logs') },
        { label: '审计日志', icon: Shield,      to: '/audit/v2/logs' },
        { label: 'Badcase',  icon: Bug,         to: v2('badcases') },
      ],
    },
  ]

  if (isAdmin.value) {
    groups.push({
      label: '配置与设置',
      items: [
        { label: '配置台', icon: Settings, to: '/admin/config' },
        // 模型训练数据回流(导出/上传飞桨数据集),admin 专属;全站唯一入口在此
        { label: '模型训练', icon: FlaskConical, to: '/training' },
      ],
    })
    groups.push({
      label: '系统管理',
      items: [
        { label: '管理总览', icon: UserCog,       to: '/admin/dashboard' },
        { label: '系统日志', icon: FileText,      to: '/admin/logs' },
        { label: '用户管理', icon: Users,         to: '/admin/users' },
        { label: '反馈管理', icon: AlertTriangle, to: '/admin/feedback' },
      ],
    })
  }

  return groups
})

// 「未收客户组」和「已收客户组」是同一条路径靠 query 区分(?view=unreceived),
// 只比 path 会让两项同时高亮 —— 等于告诉操作员"你在两个地方",所以 query 也要比。
function isActive(item) {
  const [path, query = ''] = String(item.to).split('?')
  if (route.path !== path) return false
  if (!query) return !route.query.view
  const [key, value] = query.split('=')
  return String(route.query[key] || '') === value
}
</script>

<template>
  <Sidebar>
    <SidebarHeader>
      <div class="flex items-center gap-3 px-1 py-0.5">
        <!-- 0729 对齐主侧栏品牌(0728#4 正名:标记「票」/ 主名「本司」/ 副名「收票对账系统」)。
             原来这里是「票 / 收票对账系统 / 月度工作台」,与首页的「票 / 本司 / 收票对账系统」
             各说各话——同一个系统换个页面换个名字,操作员会以为进错了地方。 -->
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-medium text-sidebar-primary-foreground">
          票
        </div>
        <div class="min-w-0">
          <p class="truncate text-sm font-medium leading-none text-sidebar-foreground">收票对账系统</p>
          <p class="mt-0.5 truncate text-xs text-sidebar-foreground/50">Receipt Reconciliation</p>
        </div>
      </div>

      <div class="flex items-center gap-2 px-1">
        <span class="flex-1 truncate font-mono text-xs text-sidebar-foreground/60">{{ workspaceKey || '未选择' }}</span>
        <StatusBadge v-if="isDemo" variant="test" size="sm" dot>测试</StatusBadge>
      </div>

      <div
        v-if="isDemo"
        class="rounded-md border border-status-test/30 bg-status-test/10 px-3 py-2 text-xs leading-snug text-status-test"
      >
        测试模式 — 数据不计入正式月度统计
      </div>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup v-for="group in navGroups" :key="group.label">
        <SidebarGroupLabel>{{ group.label }}</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem v-for="item in group.items" :key="item.label">
            <SidebarMenuButton :to="item.to" :is-active="isActive(item)">
              <component :is="item.icon" class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ item.label }}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton to="/settings">
            <Settings class="h-4 w-4 shrink-0" />
            <span>系统设置</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
</template>
