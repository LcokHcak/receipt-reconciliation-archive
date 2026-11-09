<script setup>
// 代理工作台 V2(Task 9 装配 + Task 10 三栏 UI)。
// 布局 20/60/20;1366 仍可用;≤1100px 右栏变抽屉。query↔store 双向同步;60s 轻刷。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download, Search, CalendarDays } from 'lucide-vue-next'

import AgentList from '../components/agent-workspace/AgentList.vue'
import AgentCustomerTable from '../components/agent-workspace/AgentCustomerTable.vue'
import WorkspaceSummary from '../components/agent-workspace/WorkspaceSummary.vue'
import UnreceivedPanel from '../components/agent-workspace/UnreceivedPanel.vue'
import { useAgentWorkspaceStore } from '../stores/agentWorkspace'
import { sameFilters, filtersFromQuery, FILTER_KEYS } from '../lib/agentWorkspaceQuery'
import { STATUS_LABELS, pendingTasksByCustomer } from '../lib/agentWorkspaceDisplay'
import { buildReviewDeepLink } from '../lib/agentWorkspaceLinks'
import { MATRIX } from '../../../lib/mode_record_matrix.js'

const route = useRoute()
const router = useRouter()
const store = useAgentWorkspaceStore()

// P2(2026-07-16):双视角页签——已收客户组(A页,原三栏)/未收客户组(B页,对账催收)。
// 与 URL ?view= 同步,可深链直达未收页。
const activeView = ref(route.query.view === 'unreceived' ? 'unreceived' : 'received')
watch(() => route.query.view, (v) => {
  activeView.value = v === 'unreceived' ? 'unreceived' : 'received'
})
function switchView(view) {
  if (activeView.value === view) return
  activeView.value = view
  router.replace({ query: { ...route.query, view: view === 'unreceived' ? 'unreceived' : undefined } })
}

// 右栏任务列已下线(2026-07-18 用户拍板:紧急/待处理堆着没人用,整块移除)。
// store.tasks 仍在加载:中栏行内任务徽章(pendingTaskMap)靠它;后端 workflow_task 体系不动。
const activeAgentName = computed(() => (
  store.agents.find((a) => a.agentKey === store.agentKey)?.agentName || store.agentKey
))
const statusOptions = computed(() => Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })))
// P1(A2):行内任务徽章数据(customerId → pending 任务)
const pendingTaskMap = computed(() => pendingTasksByCustomer(store.tasks))
// P1(统一②):一键搜索——回车/点按钮提交,清空即恢复
const searchDraft = ref('')
watch(() => store.search, (v) => { searchDraft.value = v || '' }, { immediate: true })
function submitSearch() {
  store.setFilters({ search: searchDraft.value.trim() })
}
// 清除必须同时清「草稿」和「已生效筛选」两处——只清一处就是用户说的"删不掉"。
function clearSearch() {
  searchDraft.value = ''
  if (store.search) store.setFilters({ search: '' })
}

// 模式筛选下拉:选项来自模式矩阵(权威模式清单);当前 store.mode 若是矩阵外的候选串也补进去,不丢选中态。
const modeOptions = computed(() => {
  const names = MATRIX.map((r) => r.mode)
  if (store.mode && !names.includes(store.mode)) names.unshift(store.mode)
  return names
})

// 中栏「当前代理:XX(客户组N组)」标题(替代旧 summary 前缀混排;删两 block 后仍保留此标题)。
const currentScopeTitle = computed(() => {
  const total = store.summary?.selectedAgent?.totalCustomers
  if (store.agentKey) return `当前代理:${activeAgentName.value}(客户组 ${total ?? '…'} 组)`
  return `全部代理(客户组 ${store.summary?.visibleAll?.totalCustomers ?? '…'} 组)`
})

// 去导出交付包 → 资料库(用户拍板:/library)
function goExportDelivery() {
  router.push({ name: 'library' })
}

// 「状态·任务」列头齿轮 → 配置台的**任务设置**那一块(2026-07-29)。
// 光跳 /admin/config 落在页面顶部,任务设置在长页面下方、以前还埋在折叠里,等于没给入口;
// 带 nav/focus 两个参数过去,由配置台自己滚到位并高亮(解析见 lib/configConsoleDeepLink)。
function goTaskConfig() {
  router.push({ path: '/admin/config', query: { nav: 'modes', focus: 'tasks' } })
}

onMounted(async () => {
  await store.init(route.query)
  syncUrl()
  store.startPolling()
})

onBeforeUnmount(() => {
  store.stopPolling()
})

// 状态 → URL(replace 不加历史;分享链接即当前筛选)
// ⭐清空某个筛选时,queryFromFilters 会**省略**该键(空值不进 URL),所以必须先把所有筛选键
// 显式清成 undefined 再铺 next——否则 {...route.query} 里的旧值原地不动,URL 上那个筛选删不掉,
// 刷新/前进后退再被读回来,就是用户反馈的"搜索删除不好使,重复删删不掉"。
// 这里必须从 FILTER_KEYS 派生:原先是手写清单,2026-07 先后加的 search/day 都漏进这个清单里。
function syncUrl() {
  const next = store.routeQuery
  if (sameFilters(filtersFromQuery(route.query), filtersFromQuery(next))) return
  const cleared = Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined]))
  router.replace({ query: { ...route.query, ...cleared, ...next } })
}

watch(() => store.routeQuery, syncUrl)

// URL → 状态(前进/后退/外部深链)
watch(() => route.query, (q) => {
  if (!store.initialized) return
  store.applyRouteQuery(q)
})

function pickAgent(agentKey) {
  store.setFilters({ agentKey: store.agentKey === agentKey ? '' : agentKey })
}

// E4(0724反馈):全代理视角点任意客户 → 左侧亮起它的代理(不改筛选,只提示归属+滚动到位)。
// 业务动机:全量列表里一行客户看不出"该找哪个代理对接",点一下左边直接告诉你。
const highlightAgentKey = ref('')
function onCustomerSelect(customer) {
  store.selectedCustomerPk = customer.customerPk
  highlightAgentKey.value = customer.agentKey || ''
}

function openCustomerReview(customer) {
  const link = buildReviewDeepLink({
    batchId: customer?.batchId,
    view: 'queue',
    group: customer?.groupKey || customer?.customerId,
    returnTo: route.fullPath,
  })
  if (!link) return
  store.selectedCustomerPk = customer.customerPk
  router.push(link)
}

</script>

<template>
  <section class="agent-workspace">
    <header class="aw-header">
      <!-- 0728#3:代理视图正名客户中心;日交付(原资料库)并列第三签(先跳现页面,不物理合并) -->
      <h1 class="aw-title">客户中心</h1>
      <nav class="aw-tabs" aria-label="视角切换">
        <button
          type="button"
          class="aw-tab"
          :class="{ active: activeView === 'received' }"
          @click="switchView('received')"
        >
          已收客户组
        </button>
        <button
          type="button"
          class="aw-tab"
          :class="{ active: activeView === 'unreceived' }"
          @click="switchView('unreceived')"
        >
          未收客户组
        </button>
        <button
          type="button"
          class="aw-tab"
          title="日交付(原资料库):预检+导出交付包/收票汇总"
          @click="router.push('/library')"
        >
          日交付
        </button>
      </nav>
      <template v-if="activeView === 'received'">
        <label class="aw-select">
          月份
          <select :value="store.month" aria-label="选择月份" @change="store.setFilters({ month: $event.target.value })">
            <option v-for="m in store.months" :key="m.month" :value="m.month">{{ m.month }}({{ m.customers }})</option>
          </select>
        </label>
        <label class="aw-select">
          状态
          <select :value="store.reviewStatus" aria-label="按状态筛选" @change="store.setFilters({ reviewStatus: $event.target.value })">
            <option value="">全部</option>
            <option v-for="s in statusOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <span class="aw-search-top" title="搜索范围:姓名/客户号/护照号/小票号/团号——全部客户(含未结算,数据库有的都能搜)">
          <Search :size="17" class="aw-search-top-icon" />
          <!-- type=text 而非 search:原生 search 的 × 只清本地草稿、不撤已生效的筛选,
               点了字没了但列表还是搜索结果——就是用户反馈的「删不掉」。只留自家 × 清两处。 -->
          <input
            v-model="searchDraft"
            class="aw-search-top-input"
            type="text"
            placeholder="搜 姓名 / 护照号 / 小票号 / 团号 / 客户号"
            aria-label="搜索客户"
            @keyup.enter="submitSearch"
            @keyup.esc="clearSearch"
          >
          <button type="button" class="aw-search-top-btn" @click="submitSearch">搜索</button>
          <button v-if="searchDraft || store.search" type="button" class="aw-search-top-clear" title="清除搜索(Esc)" @click="clearSearch">×</button>
        </span>
      </template>
      <span class="aw-header-spacer" />
      <template v-if="activeView === 'received'">
        <button type="button" class="aw-export-btn" title="去日交付页下载导出交付包" @click="goExportDelivery">
          <Download :size="15" /> 去导出交付包
        </button>
      </template>
    </header>

    <UnreceivedPanel v-if="activeView === 'unreceived'" />

    <div v-if="activeView === 'received'" class="aw-columns">
      <aside class="aw-col aw-col-agents" aria-label="代理列表栏">
        <AgentList
          :agents="store.agents"
          :active-agent-key="store.agentKey"
          :highlight-key="highlightAgentKey"
          :loading="store.loading.agents"
          :error="store.errors.agents"
          @pick="pickAgent"
          @retry="store.loadAgents()"
        />
      </aside>

      <main class="aw-col aw-col-customers" aria-label="客户列表栏">
        <WorkspaceSummary
          class="aw-summary"
          :summary="store.summary"
          :projection-lag-ms="store.projectionLagMs"
          :warnings="store.warnings"
          :loading="store.loading.summary"
          :error="store.errors.summary"
          :day="store.day"
          @retry="store.loadSummary()"
        />
        <div class="aw-cust-toolbar">
          <strong class="aw-scope-title">{{ currentScopeTitle }}</strong>
          <label class="aw-day-filter" title="按收票/建档日筛选(韩国日历日)">
            <CalendarDays :size="15" class="aw-day-icon" />
            <input
              type="date"
              class="aw-day-input"
              :value="store.day"
              aria-label="按收票日筛选"
              @change="store.setFilters({ day: $event.target.value })"
            >
            <button v-if="store.day" type="button" class="aw-day-clear" title="清除日期筛选" @click="store.setFilters({ day: '' })">×</button>
          </label>
          <label class="aw-select aw-mode-select">
            模式筛选
            <select :value="store.mode" aria-label="按模式筛选" @change="store.setFilters({ mode: $event.target.value })">
              <option value="">全部</option>
              <option v-for="m in modeOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
        </div>
        <div class="aw-cust-scroll">
          <AgentCustomerTable
            :customers="store.customers"
            :loading="store.loading.customers"
            :error="store.errors.customers"
            :next-cursor="store.nextCursor"
            :selected-pk="store.selectedCustomerPk"
            :pending-task-map="pendingTaskMap"
            @select="onCustomerSelect"
            @open="openCustomerReview"
            @load-more="store.loadMoreCustomers()"
            @retry="store.loadCustomers({ reset: true })"
            @filter-mode="(mode) => store.setFilters({ mode })"
            @config-task="goTaskConfig"
          />
        </div>
      </main>

      <!-- 右栏任务列已下线(2026-07-18 用户拍板);行内任务徽章(中栏)保留 -->
    </div>
  </section>
</template>

<style scoped>
.agent-workspace { display: flex; flex-direction: column; gap: 12px; padding: 16px; height: 100%; min-height: 0; }
.aw-header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.aw-title { font-size: 16px; margin: 0; font-weight: 500; color: #101828; }
/* P2 双视角页签:已收(进度管理)/未收(对账催收) */
.aw-tabs { display: inline-flex; gap: 2px; background: #f1f5f9; border-radius: 8px; padding: 3px; }
.aw-tab {
  padding: 5px 14px; border: none; border-radius: 6px; background: transparent;
  font-size: 13px; font-weight: 500; color: #64748b; cursor: pointer;
}
.aw-tab:hover { color: #334155; }
.aw-tab.active { background: #fff; color: #1d4ed8; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12); }
.aw-header-spacer { flex: 1; }
.aw-select { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #475467; }
.aw-select select { border: 1px solid #e4e7ec; border-radius: 6px; padding: 4px 8px; font-size: 13px; background: #fff; }
.aw-export-btn {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid #1849a9;
  background: #1849a9; color: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer;
  font-size: 13px; font-weight: 500;
}
.aw-export-btn:hover { background: #143c8c; }

/* 20/80(右栏任务列已下线 2026-07-18);每栏自己滚动,页面不整体滚 */
.aw-columns {
  display: grid; grid-template-columns: 20% 1fr; gap: 12px;
  flex: 1; min-height: 0;
}
.aw-col { border: 1px solid #e4e7ec; border-radius: 12px; padding: 10px; background: #fff; min-height: 0; display: flex; flex-direction: column; overflow: hidden; gap: 10px; }
/* 左栏单一子组件铺满;中栏三段:统计卡+工具行固定,表格区吃剩余高度并滚动 */
.aw-col-agents > * { flex: 1; min-height: 0; }
.aw-col-customers { gap: 10px; }
.aw-summary { flex: none; }
.aw-cust-toolbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.aw-scope-title { font-size: 14px; color: #101828; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aw-mode-select { flex: none; }
/* (工具栏上原来的「配置任务」文字链 2026-07-29 撤:齿轮搬进「状态·任务」列头,
   贴着它管的那一列,不再和日期/模式筛选挤同一行。类名不在此复写——
   契约测试用 includes 判断它是否已撤,注释里留一份会让测试永远绿。) */
/* 顶部醒目搜索框(2026-07-24 用户修改①:强调 + 放到上方)——蓝描边+蓝按钮,一眼看到 */
.aw-search-top { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 2px solid #2563eb; border-radius: 8px; padding: 3px 5px 3px 10px; box-shadow: 0 1px 4px rgba(37, 99, 235, 0.14); }
/* 硬规则「蓝只给可点击」:搜索框里的放大镜是装饰,点不动。跟 .al-search 的图标同色。 */
.aw-search-top-icon { color: #98a2b3; flex: none; }
.aw-search-top-input { border: none; outline: none; font-size: 14px; width: 300px; max-width: 34vw; padding: 5px 2px; background: transparent; color: #101828; }
.aw-search-top-btn { border: none; background: #2563eb; color: #fff; border-radius: 6px; padding: 6px 16px; cursor: pointer; font-size: 13px; font-weight: 500; flex: none; }
.aw-search-top-btn:hover { background: #1d4ed8; }
.aw-search-top-clear { border: none; background: none; cursor: pointer; color: #98a2b3; font-size: 16px; padding: 0 4px; flex: none; }
/* 原搜索位改为按日筛选(收票/建档日) */
.aw-day-filter { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e4e7ec; border-radius: 6px; padding: 3px 8px; }
.aw-day-icon { color: #667085; flex: none; }
.aw-day-input { border: none; outline: none; font-size: 13px; padding: 2px; background: transparent; color: #101828; }
.aw-day-clear { border: none; background: none; cursor: pointer; color: #98a2b3; font-size: 14px; padding: 0 2px; }
.aw-cust-scroll { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.aw-cust-scroll > * { flex: 1; min-height: 0; }

/* 1366 收紧左栏 */
@media (max-width: 1440px) {
  .aw-columns { grid-template-columns: 220px 1fr; }
}
@media (max-width: 1100px) {
  .aw-columns { grid-template-columns: 200px 1fr; }
}
</style>
