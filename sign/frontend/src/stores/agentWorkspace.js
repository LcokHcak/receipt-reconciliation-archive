import { defineStore } from 'pinia'

import {
  completeWorkspaceTask,
  fetchWorkspaceAgents,
  fetchWorkspaceCustomers,
  fetchWorkspaceMonths,
  fetchWorkspaceSummary,
  fetchWorkspaceTasks,
} from '../api/agentWorkspace'
import {
  canSoftRefreshCustomers,
  createRaceGate,
  filtersFromQuery,
  mergeCustomersPage,
  pickDefaultMonth,
  queryFromFilters,
  sameFilters,
} from '../lib/agentWorkspaceQuery'

// 代理工作台 V2(Task 9)。三栏各自独立 loading/error/retry;竞态门保证后发请求
// 覆盖先发(旧响应整包丢弃);切代理清游标取消旧分页;60s 轻刷不清选择/滚动。
const PAGE_SIZE = 50
const POLL_MS = 60_000

// 竞态门按 store 实例隔离(复审 MEDIUM:模块级单例会让测试里 createPinia 出来的
// 多个实例共享计数器,跨用例 token 串号)。WeakMap 键=store 实例(this),不进响应式 state
// (门是函数句柄,进 state 只会添 devtools 序列化噪声)。
const GATES = new WeakMap()

function gatesOf(store) {
  let gates = GATES.get(store)
  if (!gates) {
    gates = {
      agents: createRaceGate(),
      customers: createRaceGate(),
      tasks: createRaceGate(),
      summary: createRaceGate(),
    }
    GATES.set(store, gates)
  }
  return gates
}

function errText(error) {
  return error?.response?.data?.error || error?.message || '加载失败'
}

export const useAgentWorkspaceStore = defineStore('agentWorkspace', {
  state: () => ({
    months: [],
    // 筛选六元组(与 route.query 双向同步;month 必填,默认=最近有数据月份;search=P1一键搜索)
    month: '',
    agentKey: '',
    mode: '',
    reviewStatus: '',
    ownerUserId: '',
    search: '',
    day: '', // 按日筛选(YYYY-MM-DD,收票/建档日 KST);空=不按日筛

    summary: null,
    projectionLagMs: null,
    warnings: null,

    agents: [],
    customers: [],
    nextCursor: '',
    hasPaginated: false,
    tasks: [],

    selectedCustomerPk: '',

    loading: { agents: false, customers: false, tasks: false, summary: false },
    errors: { agents: '', customers: '', tasks: '', summary: '' },
    initialized: false,
    pollTimer: null,
  }),

  getters: {
    filters(state) {
      return {
        month: state.month,
        agentKey: state.agentKey,
        mode: state.mode,
        reviewStatus: state.reviewStatus,
        ownerUserId: state.ownerUserId,
        search: state.search,
        day: state.day,
      }
    },
    routeQuery(state) {
      return queryFromFilters({
        month: state.month,
        agentKey: state.agentKey,
        mode: state.mode,
        reviewStatus: state.reviewStatus,
        ownerUserId: state.ownerUserId,
        search: state.search,
        day: state.day,
      })
    },
  },

  actions: {
    // 进入页面:先拿 months 定默认月(禁止从 workspaceKey 推导),再套 URL 上的筛选。
    async init(routeQueryObj = {}) {
      const fromUrl = filtersFromQuery(routeQueryObj)
      try {
        const data = await fetchWorkspaceMonths()
        this.months = data?.months || []
      } catch {
        this.months = []
      }
      const month = fromUrl.month || pickDefaultMonth(this.months)
      this.month = month
      this.agentKey = fromUrl.agentKey
      this.mode = fromUrl.mode
      this.reviewStatus = fromUrl.reviewStatus
      this.ownerUserId = fromUrl.ownerUserId
      this.search = fromUrl.search
      this.initialized = true
      if (this.month) await this.reloadAll()
    },

    // URL 变化(浏览器前进/后退/分享链接)→ 套用;与当前一致则跳过防循环。
    async applyRouteQuery(routeQueryObj = {}) {
      const next = filtersFromQuery(routeQueryObj)
      if (!next.month) next.month = this.month || pickDefaultMonth(this.months)
      if (sameFilters(next, this.filters)) return
      const agentChanged = next.agentKey !== this.agentKey || next.month !== this.month
      this.month = next.month
      this.agentKey = next.agentKey
      this.mode = next.mode
      this.reviewStatus = next.reviewStatus
      this.ownerUserId = next.ownerUserId
      this.search = next.search
      if (agentChanged) this.selectedCustomerPk = ''
      await this.reloadAll()
    },

    async setFilters(patch = {}) {
      const next = { ...this.filters, ...patch }
      if (sameFilters(next, this.filters)) return
      const agentOrMonthChanged = next.agentKey !== this.agentKey || next.month !== this.month
      this.month = next.month
      this.agentKey = next.agentKey
      this.mode = next.mode
      this.reviewStatus = next.reviewStatus
      this.ownerUserId = next.ownerUserId
      this.search = next.search
      this.day = next.day
      if (agentOrMonthChanged) this.selectedCustomerPk = ''
      await this.reloadAll()
    },

    async reloadAll() {
      // 三栏并行、各自失败各自 retry;客户列表重置游标
      // ⚠️ 任务必须**排在客户之后**取(0731 核账 #16)。
      // 原来四个并行,取任务时 this.customers 还是空的 → 只能不带范围地要全月前 50 条,
      // 而客户按 received_at DESC、任务按 due_at ASC 排,两个顺序相反 →
      // 第一页(最新收的)客户的任务全落在 50 之外,那一格空白,
      // 而空白的界面语义是「没有任务,不用管」——含义正好反了。
      await Promise.all([
        this.loadSummary(),
        this.loadAgents(),
        this.loadCustomers({ reset: true }).then(() => this.loadTasks()),
      ])
    },

    async loadSummary() {
      if (!this.month) return
      const gates = gatesOf(this)
      const token = gates.summary.next()
      this.loading.summary = true
      this.errors.summary = ''
      try {
        const data = await fetchWorkspaceSummary({
          month: this.month,
          agentKey: this.agentKey,
          ownerUserId: this.ownerUserId,
          day: this.day, // 需求E②:卡片计数跟随选中日,否则与下方列表对不上
        })
        if (!gates.summary.isCurrent(token)) return
        this.summary = data
        this.projectionLagMs = data?.projectionLagMs ?? null
        this.warnings = data?.warnings || null
      } catch (error) {
        if (!gates.summary.isCurrent(token)) return
        this.errors.summary = errText(error)
      } finally {
        if (gates.summary.isCurrent(token)) this.loading.summary = false
      }
    },

    async loadAgents() {
      if (!this.month) return
      const gates = gatesOf(this)
      const token = gates.agents.next()
      this.loading.agents = true
      this.errors.agents = ''
      try {
        const data = await fetchWorkspaceAgents({
          month: this.month,
          ownerUserId: this.ownerUserId,
        })
        if (!gates.agents.isCurrent(token)) return
        this.agents = data?.agents || []
      } catch (error) {
        if (!gates.agents.isCurrent(token)) return
        this.errors.agents = errText(error)
      } finally {
        if (gates.agents.isCurrent(token)) this.loading.agents = false
      }
    },

    // reset=true:切筛选/切代理 → 清游标重拉第一页(旧分页请求作废)。
    async loadCustomers({ reset = false } = {}) {
      if (!this.month) return
      const gates = gatesOf(this)
      const token = gates.customers.next()
      this.loading.customers = true
      this.errors.customers = ''
      if (reset) {
        this.nextCursor = ''
        this.hasPaginated = false
      }
      const cursor = reset ? '' : this.nextCursor
      try {
        const data = await fetchWorkspaceCustomers({
          month: this.month,
          agentKey: this.agentKey,
          mode: this.mode,
          reviewStatus: this.reviewStatus,
          ownerUserId: this.ownerUserId,
          search: this.search,
          day: this.day,
          limit: PAGE_SIZE,
          cursor,
        })
        if (!gates.customers.isCurrent(token)) return // 旧响应整包丢弃
        this.customers = mergeCustomersPage(this.customers, data?.customers || [], { reset })
        this.nextCursor = data?.nextCursor || ''
      } catch (error) {
        if (!gates.customers.isCurrent(token)) return
        this.errors.customers = errText(error)
      } finally {
        if (gates.customers.isCurrent(token)) this.loading.customers = false
      }
    },

    async loadMoreCustomers() {
      if (!this.nextCursor || this.loading.customers) return
      this.hasPaginated = true
      await this.loadCustomers({ reset: false })
      // 翻进来的这批客户也要取任务,否则下一页整片空白格(而空白=「不用管」)
      await this.loadTasks()
    },

    async loadTasks() {
      if (!this.month) return
      const gates = gatesOf(this)
      const token = gates.tasks.next()
      this.loading.tasks = true
      this.errors.tasks = ''
      try {
        const data = await fetchWorkspaceTasks({
          month: this.month,
          agentKey: this.agentKey,
          ownerUserId: this.ownerUserId,
          // 只要屏幕上这批客户的任务。不带范围的话会被后端的 50 条硬顶截断,
          // 而截掉的恰好是最新收的那批(两边排序相反)。
          // 空数组后端按"没指定"处理,所以客户还没到位时行为不变、不会刷成假空白。
          customerIds: this.customers.map((c) => c.customerId).filter(Boolean),
        })
        if (!gates.tasks.isCurrent(token)) return
        this.tasks = data?.tasks || []
      } catch (error) {
        if (!gates.tasks.isCurrent(token)) return
        this.errors.tasks = errText(error)
      } finally {
        if (gates.tasks.isCurrent(token)) this.loading.tasks = false
      }
    },

    async completeTask(taskId, { note = '', expectedVersion } = {}) {
      const data = await completeWorkspaceTask(taskId, { note, expectedVersion })
      // 就地更新该行,不整列重拉(保滚动)
      const idx = this.tasks.findIndex((t) => t.id === taskId)
      if (idx >= 0 && data?.task) this.tasks.splice(idx, 1, { ...this.tasks[idx], ...data.task })
      await this.loadSummary()
      return data
    },

    // 60s 轻刷:计数(summary/agents/tasks)始终刷;客户列表只在没翻过页时整页替换,
    // 翻过页就不动(保滚动与选中——plan Task9 步骤5)。
    async softRefresh() {
      const jobs = [this.loadSummary(), this.loadAgents(), this.loadTasks()]
      if (canSoftRefreshCustomers({
        loadedCount: this.customers.length,
        pageSize: PAGE_SIZE,
        hasPaginated: this.hasPaginated,
      })) {
        jobs.push(this.loadCustomers({ reset: true }))
      }
      await Promise.all(jobs)
    },

    startPolling() {
      this.stopPolling()
      this.pollTimer = setInterval(() => {
        this.softRefresh().catch(() => {})
      }, POLL_MS)
    },

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    },
  },
})
