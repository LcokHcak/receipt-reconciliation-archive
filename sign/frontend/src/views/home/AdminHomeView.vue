<script setup>
// 管理员首页(2026-07-18 首页分离):管人 —— 看全局、盯进度、发现异常。
// 结构:①运营概览 KPI ②收票员工作看板(核心,人→批次→工作量) ③已完成批次 ④异常提醒。
// 月度对账不在这里铺开(避免 BI 化),入口在侧栏「月度工作」。
import { computed, onMounted, ref } from 'vue'

import { fetchWorkbenchOverview } from '../../api/workbench'
import BatchListTable from '../../components/home/BatchListTable.vue'
import CollapsiblePanel from '../../components/home/CollapsiblePanel.vue'
import CollectorBoard from '../../components/home/CollectorBoard.vue'
import KpiCard from '../../components/home/KpiCard.vue'
import { batchApprovedCount, completedBatches, fmtPct } from '../../lib/homeDisplay'
import { useAuthStore } from '../../stores/auth'
import { useWorkbenchStore } from '../../stores/workbench'

const auth = useAuthStore()
const workbench = useWorkbenchStore()

const overview = ref(null)
const loading = ref(false)
const error = ref('')
// 批次列表单独的错误位:它失败不该拖垮整个概览,但也绝不能装作"没有数据"
const batchesError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 批次列表单独收错:原来是 .catch(() => null) 静默吞掉,接口挂了首页会安静地显示
    // 「暂无已完成批次」,看不出是出错还是真没有。现在把失败明示出来(概览仍照常渲染)。
    const [ov, batchErr] = await Promise.all([
      fetchWorkbenchOverview(),
      workbench.fetchBatches().then(() => '').catch((e) => e?.response?.data?.error || e?.message || '批次列表加载失败'),
    ])
    overview.value = ov
    batchesError.value = batchErr
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '首页数据加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const progress = computed(() => overview.value?.today?.progress || null)
const alerts = computed(() => overview.value?.alerts || null)
const collectors = computed(() => (Array.isArray(overview.value?.collectors) ? overview.value.collectors : []))
const batches = computed(() => workbench.batches || [])
const completed = computed(() => completedBatches(batches.value))

// 未清异常口径(拍板#2):OCR失败 + 待补图(批次侧)的**当前存量**,无日期过滤——
// 历史积压全算,修复/补图后才回落;台账补救另有「异常补救」入口不混。
// 2026-07-20 改名口径诚实化:其余四个 KPI 是今日事件数,唯它是存量,不许顶「今日」前缀。
const abnormalBacklog = computed(() => (
  (alerts.value?.ocrFailed?.count || 0) + (alerts.value?.rephoto?.count || 0)
))

// 待管理事项(2026-07-26 用户需求②,原「异常提醒」):只留**管理员真要处理**的四件事,
// 原来的 OCR识别失败/待补图 是审核员在审核台里干的活(且已进「未清异常」KPI),不占管理位。
// 点开哪类,下方展开对应批次列表(与计数同源的 batchIds);未收是月度口径无批次,不展开,给入口。
// unit:四个量纲不同(组/条/批),必须标注,否则并排数字会被当同一量纲比较(2026-07-19 审计 M3)。
const openAlert = ref('')
const staleThreshold = computed(() => alerts.value?.staleGroups?.thresholdHours ?? 24)
// 未收清单数量 = 当前月份工作区的未收台账条数(overview.month.unreceived,与未收对账页同源)。
const unreceivedCount = computed(() => overview.value?.month?.unreceived || 0)
const ALERT_DEFS = computed(() => [
  {
    key: 'staleGroups',
    label: `超${staleThreshold.value}小时未完成客户组`,
    tone: 'warning',
    unit: '组',
    // ⭐明细列必须与胶囊同量纲(2026-08-01):原来这一列取 batchBacklogCount(b),那是**张数**——
    // 胶囊「23 组」、行是批次、列是张,三个量纲串在一条链上,数字之间毫无可比性。
    // 后端现在按批次给出各自贡献的超时组数(countByBatch),直接用它。
    detailLabel: '超时组',
    detailOf: (b) => (alerts.value?.staleGroups?.countByBatch?.[String(b.id || b.batchId)] ?? 0),
  },
  // 未收:月度台账口径,不按批次展开(没有 batchIds),点击跳未收对账
  { key: 'unreceived', label: '未收清单数量', tone: 'warning', unit: '条', standalone: true },
  // 审完(零未收尾)但没盖过导出章的批次
  { key: 'unexported', label: '待导出', tone: 'info', unit: '批', detailLabel: '完成张数', detailOf: (b) => batchApprovedCount(b) },
  // 导出真失败(500)盖了失败戳、之后没再导出成功的批次
  { key: 'exportFailed', label: '导出失败', tone: 'danger', unit: '批', detailLabel: '完成张数', detailOf: (b) => batchApprovedCount(b) },
])
function alertCount(key) {
  if (key === 'unreceived') return unreceivedCount.value
  return alerts.value?.[key]?.count || 0
}
// 收起后仍要能看见"有没有事":面板一旦被收起(状态记在 localStorage,跨天保持),
// 新冒出来的导出失败/超时组就彻底没信号了 —— 待办被折叠藏起来是最不该出的问题。
// 故在标题栏常驻一个非零项计数,与「已完成批次」的角标同一套做法。
const alertPendingCount = computed(() => ALERT_DEFS.value.filter((d) => alertCount(d.key) > 0).length)
const openAlertDef = computed(() => ALERT_DEFS.value.find((d) => d.key === openAlert.value) || null)
const alertBatches = computed(() => {
  if (!openAlert.value) return []
  const ids = alerts.value?.[openAlert.value]?.batchIds || []
  const byId = new Map(batches.value.map((b) => [String(b.id || b.batchId), b]))
  // ⭐对不上的 id 不许静默丢(2026-08-01):overview 的 batchIds 与本页 batches 不同源
  // (筛选/分页/权限都可能让某个批次不在列表里),原来 .filter(Boolean) 直接吞掉,
  // 结果就是「胶囊说 12,点开只有 8 行」而页面一个字都不解释。
  // 现在给它一行占位:至少让人知道少了几条、少的是谁,能拿 id 去查。
  return ids.map((id) => byId.get(String(id)) || { id: String(id), missing: true })
})
// 展开列表里"查不到详情"的条数(模板用它出一句说明,不是把问题藏起来)
const alertMissingCount = computed(() => alertBatches.value.filter((b) => b.missing).length)
function toggleAlert(def) {
  if (def.standalone) return // 未收:月度口径无批次可展开,由模板给跳转入口
  openAlert.value = openAlert.value === def.key ? '' : def.key
}
</script>

<template>
  <section class="workbench-hero">
    <div>
      <p class="eyebrow">管理员工作台</p>
      <h1>{{ auth.user?.username || '管理员' }}，看全局 · 盯进度 · 调资源</h1>
      <p class="muted">{{ overview?.date || '' }}<template v-if="overview?.activeMonth"> · 当前月份工作区 {{ overview.activeMonth }}</template></p>
    </div>
    <div class="hero-actions">
      <button class="ghost-button" type="button" :disabled="loading" @click="load">
        {{ loading ? '加载中' : '刷新' }}
      </button>
    </div>
  </section>

  <section v-if="error" class="empty error-text" style="margin-top: 14px;">{{ error }}</section>

  <!-- ① 运营概览(四个今日事件数 + 未清异常存量) -->
  <CollapsiblePanel title="运营概览" storage-key="admin-kpis" style="margin-top: 14px;">
    <div class="ah-kpis" aria-label="运营概览">
      <KpiCard label="今日上传" :value="progress?.uploaded ?? '—'" hint="今日新建批次收图张数" />
      <KpiCard label="今日审核" :value="progress?.reviewedToday ?? '—'" hint="今天审核通过的张数" />
      <KpiCard label="今日导出" :value="progress?.exportedToday ?? '—'" hint="今日盖章批次的当前完成张数,任一类型导出都算" />
      <KpiCard
        label="未清异常"
        :value="abnormalBacklog"
        :tone="abnormalBacklog > 0 ? 'warn' : 'default'"
        hint="OCR失败 + 待补图 · 存量,含历史积压"
      />
      <KpiCard
        label="今日完成率"
        :value="fmtPct(progress?.completionRate)"
        tone="success"
        :progress="progress?.completionRate ?? 0"
        hint="仅今日新建批次:已审/上传,与「今日审核」口径不同"
      />
    </div>
  </CollapsiblePanel>

  <!-- ② 收票员工作看板(核心) -->
  <CollapsiblePanel title="收票员工作看板" storage-key="admin-board" style="margin-top: 14px;">
    <CollectorBoard :collectors="collectors" :batches="batches" bare />
  </CollapsiblePanel>

  <!-- ③ 已完成批次 -->
  <CollapsiblePanel title="已完成批次(最近完成)" storage-key="admin-completed" style="margin-top: 14px;">
    <template #header-extra><span class="count">{{ completed.length }}</span></template>
    <p v-if="batchesError" class="ah-batches-error">批次列表没加载出来:{{ batchesError }} —— 下面的空白不代表真的没有批次,请刷新重试。</p>
    <BatchListTable :batches="completed" show-owner show-export show-action :preview-count="5" />
  </CollapsiblePanel>

  <!-- ④ 待管理事项(原「异常提醒」,2026-07-26 改为管理员真要处理的四件事) -->
  <CollapsiblePanel title="待管理事项" storage-key="admin-todo" style="margin-top: 14px;">
    <template #header-extra>
      <span v-if="alertPendingCount > 0" class="ah-alert-badge" :title="`${alertPendingCount} 类事项待处理(收起时也能看见)`">{{ alertPendingCount }}</span>
      <span class="muted ah-alert-hint">点击类别展开对应批次</span>
    </template>
    <div class="ah-alerts">
      <template v-for="def in ALERT_DEFS" :key="def.key">
        <RouterLink
          v-if="def.standalone"
          class="ah-alert"
          :class="[`ah-alert--${def.tone}`, { 'is-zero': alertCount(def.key) === 0 }]"
          :to="overview?.activeMonth
            ? { name: 'v2-monthly-unreceived', params: { workspaceKey: overview.activeMonth } }
            : { name: 'agent-workspace' }"
          title="去未收对账页处理"
        >
          {{ def.label }} <strong>{{ alertCount(def.key) }}</strong> {{ def.unit }}
        </RouterLink>
        <button
          v-else
          type="button"
          class="ah-alert"
          :class="[`ah-alert--${def.tone}`, { active: openAlert === def.key, 'is-zero': alertCount(def.key) === 0 }]"
          @click="toggleAlert(def)"
        >
          {{ def.label }} <strong>{{ alertCount(def.key) }}</strong> {{ def.unit }}
        </button>
      </template>
    </div>
    <div v-if="openAlert && openAlertDef" class="ah-alert-detail">
      <table v-if="alertBatches.length" class="table">
        <thead>
          <tr>
            <th>批次</th><th>收票员</th>
            <!-- 列名带单位:这一列与胶囊同量纲,不再是"张数冒充组数"(2026-08-01) -->
            <th class="ah-num">{{ openAlertDef.detailLabel }}{{ openAlertDef.unit ? `(${openAlertDef.unit})` : '' }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in alertBatches" :key="b.id || b.batchId">
            <td>
              <strong>{{ b.name || b.id || b.batchId }}</strong>
              <!-- 查不到详情的批次照样列出来(带 id),不静默丢:丢了就是"胶囊 12、点开 8 行" -->
              <span v-if="b.missing" class="muted"> · 详情没取到,可用这个编号查</span>
            </td>
            <td>{{ b.missing ? '—' : (b.ownerUsername || b.createdBy || '—') }}</td>
            <td class="ah-num">
              <span v-if="b.missing" class="muted">—</span>
              <span v-else class="status warning">{{ openAlertDef.detailOf(b) }}</span>
            </td>
            <td style="text-align: right;">
              <RouterLink
                class="link-like"
                :to="{ name: 'review', params: { batchId: b.id || b.batchId } }"
              >
                进入 →
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="alertMissingCount > 0" class="ah-alert-missing">
        其中 {{ alertMissingCount }} 个批次在本页列表里找不到(可能被筛选/权限挡住了)。
        计数没错,是这张表拿不到它们的详情——需要的话按上面的编号去查。
      </p>
      <div v-else-if="!alertBatches.length" class="empty">该类别当前没有待处理批次</div>
    </div>
  </CollapsiblePanel>
</template>

<style scoped>
.ah-kpis {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}
@media (max-width: 1100px) { .ah-kpis { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 700px) { .ah-kpis { grid-template-columns: repeat(2, 1fr); } }

.ah-alerts { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px 0 6px; }
.ah-alert {
  border: 1px solid var(--line, #e5e7eb);
  background: var(--surface, #fff);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--text, #111);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.ah-alert { text-decoration: none; display: inline-block; } /* 未收胶囊是 RouterLink,去掉下划线与 button 对齐 */
.ah-alert strong { font-variant-numeric: tabular-nums; margin-left: 4px; }
.ah-alert:hover { border-color: var(--accent, #2563eb); }
.ah-alert.active { border-color: var(--accent, #2563eb); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15); }
.ah-alert--danger strong { color: #dc2626; }
.ah-alert--warning strong { color: var(--warning, #d97706); }
.ah-alert--info strong { color: var(--accent, #2563eb); }
.ah-alert.is-zero strong { color: var(--muted, #9ca3af); }
.ah-alert-hint { font-size: 0.75rem; }
.ah-batches-error { margin: 0 0 8px; font-size: 0.8rem; color: #b42318; }
/* 收起后仍在场的待办角标:琥珀色,克制但不至于被忽略 */
/* 硬规则「胶囊只作状态」:这里装的是「几类事项」——数量,不是状态。
   琥珀留着(待处理确实是「要处理」),去掉胶囊底和圆角。
   它在折叠标题上,收起时也要看得见,所以留 margin 保住间距。 */
.ah-alert-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; margin-right: 6px;
  color: #b54708;
  font-size: 0.7rem; font-weight: 500; line-height: 1;
}
.ah-alert-detail { margin-top: 6px; }
.ah-alert-missing { margin: 8px 0 0; font-size: 12px; color: #92400e; }
.ah-num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
