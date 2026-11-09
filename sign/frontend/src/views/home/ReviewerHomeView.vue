<script setup>
// 审核员首页(2026-07-18 首页分离):打开即干活。
// 只看自己的任务:任务概览 KPI → 我的批次(核心,点进入直达审核,三列极简) → 最近完成。
// 不展示管理员统计(看板/月度对账都不在这);「我的数据(本月)」P2 上线。
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { fetchWorkbenchOverview } from '../../api/workbench'
import BatchListTable from '../../components/home/BatchListTable.vue'
import KpiCard from '../../components/home/KpiCard.vue'
import { completedBatches, fmtPct } from '../../lib/homeDisplay'
import { useAuthStore } from '../../stores/auth'
import { useMyTodosStore } from '../../stores/myTodos'
import { useWorkbenchStore } from '../../stores/workbench'

const auth = useAuthStore()
const myTodos = useMyTodosStore()
const workbench = useWorkbenchStore()
const router = useRouter()

const overview = ref(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [ov] = await Promise.all([
      fetchWorkbenchOverview(),
      myTodos.fetch().catch(() => null),
      workbench.fetchBatches().catch(() => null),
    ])
    overview.value = ov
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '首页数据加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const progress = computed(() => overview.value?.today?.progress || null)
const me = computed(() => overview.value?.me || null)
const myMonth = computed(() => me.value?.month || null)
// 自己的已完成批次(reviewer 的 /api/state 服务端已按 owner 过滤)
const myCompleted = computed(() => completedBatches(workbench.batches || []))

// 今日效率(P2):张/小时,没审过显示 —(工时=首末跨度,不足1h按1h,hint 注明近似)
const efficiencyText = computed(() => (
  me.value?.todayEfficiency !== null && me.value?.todayEfficiency !== undefined
    ? `${me.value.todayEfficiency}`
    : '—'
))
// 当前排名(P2 拍板#6:只给本人看自己名次):没进榜(今日没审过)不显示
const rankText = computed(() => (
  me.value?.rank ? `${me.value.rank} / ${me.value.rankTotal}` : ''
))

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '凌晨好'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

// 进入批次:直达审核页(单队列视图,无需额外参数)。
function goToTodo(todo) {
  if (!todo?.batchId) return
  router.push({ name: 'review', params: { batchId: todo.batchId } })
}
</script>

<template>
  <!-- 顶部横幅:身份 + 日期 + 快捷入口 -->
  <section class="rh-banner">
    <div class="rh-banner__who">
      <span class="rh-avatar" aria-hidden="true">{{ (auth.user?.username || '审')[0] }}</span>
      <div>
        <h1>{{ greeting }}，{{ auth.user?.username || '审核员' }}</h1>
        <p class="rh-banner__meta">
          <template v-if="overview?.activeMonth">月份工作区 {{ overview.activeMonth }} · </template>{{ overview?.date || '' }}
        </p>
      </div>
    </div>
    <div class="rh-banner__actions">
      <RouterLink :to="{ name: 'intake' }" class="rh-cta">+ 新建批次</RouterLink>
      <button class="rh-refresh" type="button" :disabled="loading" @click="load">
        {{ loading ? '加载中' : '刷新' }}
      </button>
    </div>
  </section>

  <section v-if="error" class="empty error-text" style="margin-top: 14px;">{{ error }}</section>

  <!-- 任务概览(「待审核」是全部存量待办,其余为今日口径,故不冠「今日」) -->
  <section class="rh-kpis" aria-label="任务概览">
    <KpiCard
      label="待审核"
      :value="myTodos.totalPending"
      :tone="myTodos.totalPending > 0 ? 'warn' : 'success'"
      hint="我名下所有批次待办"
    />
    <KpiCard label="今日完成" :value="progress?.reviewedToday ?? '—'" tone="success" hint="今天审核通过的张数" />
    <KpiCard label="今日上传" :value="progress?.uploaded ?? '—'" hint="今日新建批次收图张数" />
    <KpiCard label="今日效率" :value="efficiencyText" hint="张/小时 · 按首末审核跨度近似,不足1小时按1小时" />
    <KpiCard v-if="rankText" label="当前排名" :value="rankText" hint="按今日完成张数,只显示您自己的名次" />
  </section>

  <!-- 我的批次(核心) -->
  <section class="panel" style="margin-top: 14px;">
    <div class="panel-header">
      <strong>我的批次</strong>
      <span class="count" :class="{ warning: myTodos.totalPending > 0 }">
        待办 {{ myTodos.totalPending }}
      </span>
    </div>
    <table v-if="myTodos.hasTodos" class="table rh-todo-table">
      <thead>
        <tr>
          <th>批次</th>
          <th class="num">我的待办</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in myTodos.todos" :key="todo.batchId" class="rh-todo-row" @click="goToTodo(todo)">
          <td><strong>{{ todo.batchName }}</strong></td>
          <td class="num"><span class="status warning">{{ todo.pendingCount }}</span></td>
          <td class="rh-enter-cell">
            <button type="button" class="primary-button rh-enter" @click.stop="goToTodo(todo)">进入 ▶</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else-if="myTodos.loading" class="empty">加载中…</div>
    <div v-else-if="myTodos.error" class="empty error-text">{{ myTodos.error }}</div>
    <div v-else class="empty">
      当前没有需要您处理的批次 —
      <RouterLink :to="{ name: 'intake' }" class="link-like">去建档收票</RouterLink>
    </div>
  </section>

  <!-- 最近完成 -->
  <section class="panel" style="margin-top: 14px;">
    <div class="panel-header">
      <strong>最近完成</strong>
      <span class="count">{{ myCompleted.length }}</span>
    </div>
    <BatchListTable :batches="myCompleted" :preview-count="5" empty-text="还没有已完成的批次" />
  </section>

  <!-- 我的数据(本月,P2):完成=动作口径;速度=张/小时近似;完成率/返工率=现存批次存量 -->
  <section class="panel" style="margin-top: 14px;">
    <div class="panel-header">
      <strong>我的数据(本月)</strong>
      <span class="muted rh-month-hint">按现存批次统计,返工率为重拍近似</span>
    </div>
    <div class="rh-month-grid">
      <KpiCard label="本月完成" :value="myMonth?.reviewed ?? '—'" hint="本月审核通过的张数" />
      <KpiCard
        label="平均速度"
        :value="myMonth?.avgPerHour !== null && myMonth?.avgPerHour !== undefined ? myMonth.avgPerHour : '—'"
        hint="张/小时 · 按活跃日工时近似"
      />
      <KpiCard
        label="完成率"
        :value="fmtPct(myMonth?.completionRate)"
        tone="success"
        :progress="myMonth?.completionRate ?? 0"
        hint="已审 / 收图 · 全部现存批次(不限本月)"
      />
      <KpiCard
        label="返工率"
        :value="fmtPct(myMonth?.reworkRate)"
        :tone="(myMonth?.reworkRate || 0) > 0.05 ? 'warn' : 'default'"
        hint="重拍 / 收图 · 全部现存批次,近似口径"
      />
    </div>
  </section>
</template>

<style scoped>
/* 审核员横幅:蓝底白字(参考效果图),与管理员的白底 hero 形成身份区分 */
.rh-banner {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 18px 20px;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--accent, #2563eb), #1d4ed8);
  color: #fff;
}
.rh-banner__who { display: flex; align-items: center; gap: 14px; }
.rh-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  font-size: 1.1rem;
  font-weight: 500;
}
.rh-banner h1 { margin: 0; font-size: 1.25rem; color: #fff; }
.rh-banner__meta { margin: 2px 0 0; font-size: 0.8rem; color: rgba(255, 255, 255, 0.85); }
.rh-banner__actions { display: flex; align-items: center; gap: 10px; }
.rh-cta {
  background: #fff;
  color: var(--accent, #2563eb);
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 0.85rem;
  font-weight: 500;
  text-decoration: none;
  transition: transform 150ms ease, box-shadow 150ms ease;
}
.rh-cta:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
.rh-refresh {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: #fff;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 0.82rem;
  cursor: pointer;
}
.rh-refresh:hover { border-color: #fff; }
.rh-refresh:disabled { opacity: 0.6; cursor: default; }

.rh-kpis {
  margin-top: 14px;
  display: grid;
  /* 4~5 卡自适应:有排名卡时 5 张摊平,没有时 4 张 */
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}
@media (max-width: 900px) { .rh-kpis { grid-template-columns: repeat(2, 1fr); } }

.rh-month-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 4px 0 6px;
}
@media (max-width: 900px) { .rh-month-grid { grid-template-columns: repeat(2, 1fr); } }
.rh-month-hint { font-size: 0.75rem; }

.rh-todo-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.rh-todo-row { cursor: pointer; }
.rh-enter-cell { text-align: right; }
.rh-enter { font-size: 0.8rem; padding: 4px 14px; }
</style>
