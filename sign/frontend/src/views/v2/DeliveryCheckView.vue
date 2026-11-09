<script setup>
// 最终核对:交付前的全部"看和判断"都在这页 —— 按需自动重算(ensureFresh)、交付前检查
// (blocking/warning/待人工确认)、只读逐行核对。monthly_data 为纯派生视图,修正在源头。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { Download, ShieldCheck } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import api from '@/api/client'
import { fetchFinalDeliveryReadiness } from '@/api/v2/delivery'
import { ensureFresh } from '@/api/v2/stages'
import { fetchMonthlyOverview } from '@/api/v2/monthly'
import { REMEDY_KIND, labelOf } from '@/lib/statusLabels'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const rows = ref([])
const total = ref(0)
const byMode = ref([])
const totals = ref({ buckets: [], totalRebateKrw: 0, totalRows: 0 })
const loading = ref(false)
const errorMsg = ref('')
const successMsg = ref('')
// 0729:合并阶段因归不到交付桶而丢弃的行数(0=没丢,不显示)
const mergeDroppedNotice = ref(0)
const filters = reactive({ folder: '', status: '', search: '' })

// 交付前检查(从月度交付页移来:工作人员在这里处理完所有阻断/警告,交付页只看结果)
const readiness = ref(null)
const overviewCounts = ref({})
const actionLoading = ref('')

const FOLDERS = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团']

function describeError(e, fb) {
  const data = e?.response?.data || {}
  if (data.code === 'PIPELINE_LOCKED') return `流水线被 ${data.runningStage || '其他任务'} 占用`
  if (data.code === 'WORKSPACE_LOCKED') return '月份已锁定'
  if (data.code === 'merge_blocked') return data.message || '前置条件未满足'
  if (data.code === 'STAGE_ALREADY_RUNNING') return data.error || '上一个任务还在运行，请稍后重试'
  if (data.code === 'STAGE_PRECONDITION_FAILED') return data.error || '前置条件未满足'
  return data.error || e?.message || fb
}
function fmt(v) { return v == null || v === '' ? '—' : String(v) }
function statusLabel(r) {
  if (Number(r.customer_rebate_krw) < 0) return '退货'
  return r.is_unmatched ? '未收' : '通过'
}
function statusVariant(r) {
  if (Number(r.customer_rebate_krw) < 0) return 'info'
  return r.is_unmatched ? 'warn' : 'ok'
}

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const params = { limit: 500 }
    if (filters.folder) params.modeFolder = filters.folder
    if (filters.status === 'unreceived') params.isUnmatched = '1'
    if (filters.status === 'passed') params.isUnmatched = '0'
    // ⚠️ 2026-08-01(出交付报告截图时发现):这里原来写的是
    //     `const { data } = await api.get(...)`
    // 而 api/client.js 的响应拦截器是 `return response.data` —— 也就是说
    // api.get() **直接返回数据体**,再解构一层 .data 拿到的是 undefined。
    // 后果:交付总行数与四个「返点合计」**恒为 0**,不管后端返回什么;
    // 而今天刚补的全量聚合(totals)前端也根本读不到。
    // 全仓只有这一处这么写(其余都是 `const payload = await api.get(...)`)。
    // 是给报告截图、发现"数字怎么还是 0"才挖出来的 —— 光看代码看不出,
    // 因为两种写法在语法上都成立。
    const data = await api.get(`/monthly/workspaces/${encodeURIComponent(workspaceKey.value)}/monthly-data`, { params })
    rows.value = Array.isArray(data?.rows) ? data.rows : []
    total.value = Number(data?.total || 0)
    byMode.value = Array.isArray(data?.byMode) ? data.byMode : []
    totals.value = data?.totals && Array.isArray(data.totals.buckets)
      ? data.totals
      : { buckets: [], totalRebateKrw: 0, totalRows: 0 }
  } catch (e) {
    errorMsg.value = describeError(e, '加载交付数据失败')
    rows.value = []
  } finally {
    loading.value = false
  }
}

const filteredRows = computed(() => {
  const q = filters.search.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter((r) =>
    [r.receipt_no, r.name, r.passport_no, r.tour_no].some((v) => String(v || '').toLowerCase().includes(q)),
  )
})

// ── 交付前检查 + 生成交付数据(merge) ───────────────────────────────
async function loadReadiness() {
  if (!workspaceKey.value) return
  try {
    readiness.value = await fetchFinalDeliveryReadiness(workspaceKey.value)
  } catch (e) {
    errorMsg.value = describeError(e, '交付检查失败')
    readiness.value = null
  }
}

async function loadOverviewCounts() {
  if (!workspaceKey.value) return
  try {
    const payload = await fetchMonthlyOverview(workspaceKey.value)
    overviewCounts.value = payload?.counts || {}
  } catch {
    overviewCounts.value = {}
  }
}

// 按需重算:打开核对页时调 ensureFresh。若派生数据过期(改了账单/团号/模式/扣点)
// 或从未生成过 → 从最浅脏阶段重跑到 merge,核对数据自动反映最新匹配结果;新鲜则 no-op。
// 导出数据 = 已核对台账 + 最新账单 + 最新配置的纯派生,不再需要手点「生成交付数据」。
async function ensureFreshData() {
  if (!workspaceKey.value || actionLoading.value) return
  actionLoading.value = 'merge'
  errorMsg.value = ''
  try {
    const res = await ensureFresh(workspaceKey.value)
    // 0729 静默排查:合并阶段会把"归不到四个交付桶"的行丢出 monthly_data,
    // 此前这三个计数一路被丢(服务返回值没人接 → 响应里没有 → 界面上零痕迹)。
    // 大多数时候它是对的(那些渠道本就不走四桶交付),但正因为"本该如此"和
    // "归类坏了"长得一模一样,不显示就永远分不出来 —— 而这里是**最终核对**页,
    // 恰好是发现"数据少了"的最后一道关口,信息该落在这儿。
    // 0729 生产量化后修正:归不了类的 2883 行里 2823 行是**百货**(新世界明洞 2466、
    // 现代江南 327…),而四个桶全是免税店桶——百货走自己的上家专链和乐天百货独立包,
    // 本来就不该进四桶合并。把这 98% 的正常越界也算进提醒里,横幅会天天显示
    // "2823 行被丢弃",操作员三天就学会无视它,提醒等于没做。
    // 所以只报**真正归不出来、需要有人去配模式映射**的那部分(skipped*NoFolder);
    // 越界的记在 skipped*OutOfScope,只进操作日志备查,不打扰人。
    const ms = res?.mergeStats || {}
    mergeDroppedNotice.value = (Number(ms.skippedNoFolder) || 0)
      + (Number(ms.skippedBillNoFolder) || 0)
      + (Number(ms.skippedBrandNoFolder) || 0)
    if (Array.isArray(res?.ran) && res.ran.length) {
      successMsg.value = `已按最新数据重新生成(重跑:${res.ran.join(' → ')})`
      setTimeout(() => { successMsg.value = '' }, 5000)
    }
    await Promise.all([load(), loadReadiness(), loadOverviewCounts()])
  } catch (e) {
    errorMsg.value = describeError(e, '生成交付数据失败')
  } finally {
    actionLoading.value = ''
  }
}

const readinessBlocking = computed(() => readiness.value?.blocking || [])
const readinessWarnings = computed(() => readiness.value?.warnings || [])
const pendingReasonItems = computed(() => (overviewCounts.value.pendingByReason || []).map((row) => {
  const reason = row.reason || row.reason_type || 'unknown'
  return { reason, count: Number(row.n || row.count || 0), label: pendingReasonLabel(reason), target: pendingReasonTarget(reason) }
}))
const blockingDetails = computed(() => readinessBlocking.value.map((code) => ({
  code, label: blockingLabel(code), target: blockingTarget(code),
})))
const warningDetails = computed(() => readinessWarnings.value.map((code) => ({
  code, label: warningLabel(code), description: warningDescription(code), count: warningCount(code), target: warningTarget(code),
})))

function pendingReasonLabel(reason) {
  return labelOf(REMEDY_KIND, reason)
}
function pendingReasonTarget(reason) {
  if (['field_conflict', 'ambiguous_match', 'fuzzy_match'].includes(reason)) {
    return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/bill-review`
  }
  return `/daily/remedy/${encodeURIComponent(workspaceKey.value)}`
}
function blockingLabel(code) {
  const map = {
    open_pending_reviews: '还有待人工确认/待补救记录',
    missing_rebate: '有记录缺少返点金额',
    no_eligible_rows: '还没有可交付的月度数据',
  }
  return map[code] || code
}
function blockingTarget(code) {
  if (code === 'open_pending_reviews') {
    const first = pendingReasonItems.value[0]
    return first?.target || `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/bill-review`
  }
  // 缺返点的根因在账单净额/扣点配置(monthly_data 已只读,不能在本页改)→ 指到账单匹配页
  if (code === 'missing_rebate') return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/bill-match`
  if (code === 'no_eligible_rows') return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}`
  return ''
}
function warningLabel(code) {
  const map = {
    unreceived_rows_excluded: '未收记录未进入最终交付',
    daily_without_bill_excluded: '小票有但无账单未进入最终交付',
    bill_only_rows_excluded: '账单调整行未进入客户交付',
  }
  return map[code] || code
}
function warningDescription(code) {
  if (code === 'unreceived_rows_excluded') {
    // 单位说明:这里的「条」是商品明细行;按张数(distinct 小票)= 未收清单页口径,两者对齐。
    const receipts = Number(readiness.value?.excluded?.unreceivedReceipts || 0)
    const tail = receipts > 0 ? `（即上方条数=商品明细行，对应约 ${receipts} 张未收小票，与「未收清单」页按张口径一致）` : ''
    return `账单有、台账无，属于客户需要补小票；不影响当前已匹配记录出最终交付包。${tail}`
  }
  const map = {
    daily_without_bill_excluded: '台账有、账单无，无法计算账单金额；先保留在核对范围外。',
    bill_only_rows_excluded: '只有账单、没有台账客户链路的退货或调整行，只用于财务冲减核对，不生成客户 PDF 或客户资料包。',
  }
  return map[code] || ''
}
function warningCount(code) {
  if (code === 'unreceived_rows_excluded') return Number(readiness.value?.excluded?.unreceivedRows || 0)
  if (code === 'daily_without_bill_excluded') return Number(readiness.value?.excluded?.dailyWithoutBill || 0)
  if (code === 'bill_only_rows_excluded') return Number(readiness.value?.excluded?.billOnlyRows || 0)
  return 0
}
function warningTarget(code) {
  if (code === 'unreceived_rows_excluded') return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/unreceived`
  if (code === 'daily_without_bill_excluded') return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/delivery-check?status=unreceived`
  if (code === 'bill_only_rows_excluded') return `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/bill-review`
  return ''
}

// 各桶返点合计:**用服务端的全量聚合**,不是把当前这一页加起来。
//
// 2026-08-01 修:原来是 `for (const r of rows.value)` 累加 —— 而前端固定 limit:500、
// 后端 clampInt 又把 limit 硬顶在 500,真实月份 monthly_data 是万行级。
// 于是这几个「返点合计」只反映前 500 行(可能只有真值的百分之几),
// 而紧挨着的「交付总行数」用的是服务端全量 total。两个数字并排,人默认同一口径,
// 拿它跟上家对账会直接对错。
// 源码里当时留了句「从当前已加载行算…仅作参考」,但界面上一个字都没有 ——
// 注释不是回执,看表的人看不到它。
const summary = computed(() => {
  const perBucket = {}
  for (const b of totals.value.buckets || []) perBucket[b.folder] = b.rebateKrw
  return { perBucket, totalReb: Number(totals.value.totalRebateKrw || 0) }
})
// 列表是截断的(只取前 listCap 行);合计不是。这件事必须写在界面上,
// 否则"表里 500 行、合计却是三万行的和"看起来更像 bug。
const listTruncated = computed(() => total.value > rows.value.length)

async function loadAll() {
  // 进核对页:先按需重算(过期/首次→重跑链),再展示。monthly_data 为纯派生只读视图,
  // 一切修正在源头(台账/账单/扣点/模式),不在这里手改。
  await ensureFreshData()
}
onMounted(loadAll)
watch(workspaceKey, loadAll)
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="space-y-5">
      <header class="flex flex-wrap items-start gap-3">
        <Download class="mt-1 h-6 w-6 text-primary" />
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-medium text-foreground">最终核对</h1>
          <p class="text-sm text-muted-foreground">
            <template v-if="actionLoading === 'merge'">正在自动生成交付数据…</template>
            <template v-else>交付数据已自动生成，处理完检查项、逐行核对没问题后，去「最终交付」一键出包。</template>
          </p>
        </div>
        <RouterLink :to="`/monthly/v2/${workspaceKey}/delivery`">
          <Button size="sm" :disabled="actionLoading === 'merge'">去最终交付出包</Button>
        </RouterLink>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <!-- 0729 静默排查:归不到交付桶而被丢出合并的行。多数情况是对的(那些渠道本就不走
           四桶交付),所以用「提示」而不是「阻断」——但必须说出来,否则"本该如此"和
           "归类坏了"在界面上长得一模一样。这里是发现"数据少了"的最后一道关口。 -->
      <div
        v-if="mergeDroppedNotice > 0"
        class="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-2 text-sm text-status-warn"
      >
        本次生成时有 <TabularNumber :value="mergeDroppedNotice" /> 行因「归不到交付桶」没有进入最终数据。
        属于不走四桶交付的渠道时这是正常的;若数目明显偏多,去配置台看看模式归类是不是漏配了。
      </div>

      <!-- 交付前检查(从月度交付页移来:阻断/警告/待人工确认都在这里处理) -->
      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-wrap items-center gap-2">
          <ShieldCheck class="h-5 w-5 text-primary" />
          <h2 class="text-base font-medium">交付前检查</h2>
          <StatusBadge :variant="readiness?.ok ? 'ok' : 'error'" size="sm" dot>
            {{ readiness?.ok ? '可以交付' : '需要处理' }}
          </StatusBadge>
          <span class="text-sm text-muted-foreground">可交付行 <TabularNumber :value="readiness?.eligibleRows || 0" /></span>
        </div>
        <div v-if="blockingDetails.length || warningDetails.length || pendingReasonItems.length" class="mt-3 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div v-if="blockingDetails.length" class="space-y-2">
            <p class="font-medium text-foreground">当前不能交付的原因</p>
            <div v-for="item in blockingDetails" :key="item.code" class="flex flex-wrap items-center justify-between gap-2">
              <span>{{ item.label }}</span>
              <RouterLink v-if="item.target" :to="item.target" class="text-primary hover:underline">去处理</RouterLink>
            </div>
          </div>
          <div v-if="warningDetails.length" class="space-y-2">
            <p class="font-medium text-foreground">警告项说明</p>
            <div v-for="item in warningDetails" :key="item.code" class="flex flex-wrap items-start justify-between gap-3">
              <span class="min-w-0">
                <span class="block">{{ item.label }} <TabularNumber :value="item.count" /> 条</span>
                <span class="mt-1 block text-xs text-muted-foreground">{{ item.description }}</span>
              </span>
              <RouterLink v-if="item.target" :to="item.target" class="shrink-0 text-primary hover:underline">查看</RouterLink>
            </div>
          </div>
          <div v-if="pendingReasonItems.length" class="space-y-2">
            <p class="font-medium text-foreground">待人工确认来源</p>
            <div v-for="item in pendingReasonItems" :key="item.reason" class="flex flex-wrap items-center justify-between gap-2">
              <span>{{ item.label }} <TabularNumber :value="item.count" /> 条</span>
              <RouterLink :to="item.target" class="text-primary hover:underline">查看明细</RouterLink>
            </div>
          </div>
        </div>
        <p class="mt-3 text-xs text-muted-foreground">
          最终交付只包含：账单已匹配、无待处理冲突、非未收、且返点金额已计算的记录。
        </p>
      </section>

      <!-- 汇总 -->
      <section class="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">交付总行数</p>
          <TabularNumber :value="total" class="mt-1 text-2xl font-medium" />
        </div>
        <div v-for="f in FOLDERS" :key="f" class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="truncate text-xs text-muted-foreground">{{ f }} 返点合计</p>
          <TabularNumber :value="Math.round(summary.perBucket[f] || 0)" class="mt-1 text-lg font-medium" />
        </div>
      </section>
      <!-- 口径必须写在明面上:合计走服务端全量,下面的列表只显示前若干行。
           不写的话,"表里 500 行、合计却是三万行的和"看起来更像 bug,
           而反过来(合计只算 500 行)才是真出事——那正是 0801 之前的行为。 -->
      <!-- ⚠️ 这里不能写 markdown 的 ** —— Vue 模板不渲染它,会原样显示成
           「为**本月全量**(640 行)」。出交付报告截图时才看见。用 <strong> 标签。 -->
      <p v-if="listTruncated" class="-mt-1 text-xs text-muted-foreground">
        以上返点合计为<strong>本月全量</strong>({{ total }} 行)按当前筛选统计;
        下方列表只列出前 {{ rows.length }} 行,用筛选缩小范围可看到其余记录。
      </p>

      <!-- 筛选 -->
      <section class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
        <select v-model="filters.folder" class="h-9 rounded-md border border-border bg-background px-2 text-sm" @change="load">
          <option value="">全部桶</option>
          <option v-for="f in FOLDERS" :key="f" :value="f">{{ f }}</option>
        </select>
        <select v-model="filters.status" class="h-9 rounded-md border border-border bg-background px-2 text-sm" @change="load">
          <option value="">全部状态</option>
          <option value="passed">通过</option>
          <option value="unreceived">未收</option>
        </select>
        <input v-model="filters.search" placeholder="搜小票号 / 姓名 / 护照 / 团号" class="h-9 flex-1 min-w-[200px] rounded-md border border-border bg-background px-3 text-sm">
        <Button size="sm" variant="ghost" :disabled="loading" @click="load">刷新</Button>
      </section>

      <!-- 表格 -->
      <section class="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
        <table class="w-full text-xs">
          <thead class="border-b border-border bg-muted/40 text-muted-foreground">
            <tr>
              <th class="px-2 py-2 text-left">桶</th>
              <th class="px-2 py-2 text-left">小票号</th>
              <th class="px-2 py-2 text-left">姓名</th>
              <th class="px-2 py-2 text-left">护照号</th>
              <th class="px-2 py-2 text-left">团号</th>
              <th class="px-2 py-2 text-left">购买日</th>
              <th class="px-2 py-2 text-left">出境</th>
              <th class="px-2 py-2 text-right">净额KRW</th>
              <th class="px-2 py-2 text-right">客人点数</th>
              <th class="px-2 py-2 text-right">客人返点金额</th>
              <th class="px-2 py-2 text-left">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="11" class="px-3 py-6 text-center text-muted-foreground">加载中…</td></tr>
            <tr v-else-if="!filteredRows.length"><td colspan="11" class="px-3 py-6 text-center text-muted-foreground">没有数据（打开本页会按最新数据自动生成）</td></tr>
            <template v-for="r in filteredRows" v-else :key="r.id">
              <!-- 只读行:monthly_data 为纯派生视图,修正在源头(台账/账单/扣点/模式) -->
              <tr class="border-b border-border/60 hover:bg-muted/30">
                <td class="px-2 py-1.5">{{ fmt(r.mode_folder) }}</td>
                <td class="px-2 py-1.5 font-mono">{{ fmt(r.receipt_no) }}</td>
                <td class="px-2 py-1.5">{{ fmt(r.name) }}</td>
                <td class="px-2 py-1.5 font-mono">{{ fmt(r.passport_no) }}</td>
                <td class="px-2 py-1.5">{{ fmt(r.tour_no) }}</td>
                <td class="px-2 py-1.5">{{ fmt(r.purchase_date) }}</td>
                <td class="px-2 py-1.5">{{ fmt(r.departure_date) }}</td>
                <td class="px-2 py-1.5 text-right"><TabularNumber :value="Number(r.net_krw) || 0" /></td>
                <td class="px-2 py-1.5 text-right">{{ fmt(r.customer_points) }}</td>
                <td class="px-2 py-1.5 text-right font-medium"><TabularNumber :value="Math.round(Number(r.customer_rebate_krw) || 0)" /></td>
                <td class="px-2 py-1.5"><StatusBadge :variant="statusVariant(r)" size="sm">{{ statusLabel(r) }}</StatusBadge></td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>
      <p class="text-xs text-muted-foreground">注：此页为只读核对视图。交付数据随台账/账单/扣点/模式的最新状态自动重算——要改数请到对应源头（台账核对、账单导入、扣点/模式配置），回到本页会自动反映。</p>
    </div>
  </AppLayout>
</template>
