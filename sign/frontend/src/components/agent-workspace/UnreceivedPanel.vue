<script setup>
// 未收客户组 B 页(P2+P3,2026-07-16/17)——自带取数,不碰已收侧 store(红线:在产读模型不动)。
// 数据=后端未收对账读模型(与未收清单页/交付包 5_未收 同口径);左栏代理桶(未归属殿后),
// 中栏客户组表:状态五档色(待收黄/部分已收黄+进度/已收灰/无需补灰留痕/超7天红),
// 搜索,xlsx 导出;P3:在途标记/已建档深链(未建档明示徽标)/「无需补」豁免与恢复。
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Download, RefreshCw, Upload } from 'lucide-vue-next'

import {
  fetchUnreceived, fetchUnreceivedWorkspaces, unreceivedExportUrl,
  waiveUnreceived, unwaiveUnreceived,
} from '../../api/agentWorkspace'
import { uploadImport } from '../../api/v2/imports'
import { buildReviewDeepLink } from '../../lib/agentWorkspaceLinks'
import { useAuthStore } from '../../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const canAct = computed(() => auth.user?.role !== 'finance') // finance 只读
// 导入总账收敛到管理员账户、专人上传(2026-07-21 拍板;后端 admin 守卫同口径)
const canImport = computed(() => auth.user?.role === 'admin')

const workspaces = ref([])
const workspaceKey = ref('')
const loading = ref(false)
const error = ref('')
const actionError = ref('')
const view = ref(null)
const agentKey = ref('')
const searchDraft = ref('')
const search = ref('')
const expandedGroups = ref(new Set())
const waivingGroupKey = ref('')
// 请求令牌防乱序(照 agentWorkspace store 的 gate 手法):快速切代理/搜索时,
// 晚到的旧响应整包丢弃,避免"高亮 B、表格显示 A"。
let loadToken = 0

const STATUS_META = {
  overdue: { label: '超7天未收', cls: 'ur-st-overdue' },
  pending: { label: '待收', cls: 'ur-st-pending' },
  partial: { label: '部分已收', cls: 'ur-st-partial' },
  waived: { label: '无需补', cls: 'ur-st-waived' },
  received: { label: '已收', cls: 'ur-st-received' },
}

const agents = computed(() => view.value?.agents || [])
const groups = computed(() => view.value?.groups || [])
const stats = computed(() => view.value?.stats || null)

// ── 模式筛选+本司视角(0727反馈#16-2,2026-07-28 新版文档)────────────────────
// 可输入文字(如「本司」)按子串匹配模式;下拉候选直显各模式未收数量;
// 「本司未收」计数卡常驻且可点=一键筛选(公司模式二轮收票的重点视角)。
// 全部前端派生:视图数据已在手,不加接口不加状态副本。
const modeFilter = ref('')
const COMPANY_MARK = '本司'
function isUnreceivedRow(r) { return !r.received && !r.waived }
// 各模式的未收票数(只数真未收;已收/无需补不进候选数字)
const modeStats = computed(() => {
  const map = new Map()
  for (const g of groups.value) {
    for (const r of g.rows || []) {
      if (!isUnreceivedRow(r)) continue
      const mode = String(r.mode || '').trim() || '(无模式)'
      map.set(mode, (map.get(mode) || 0) + 1)
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
})
const companyUnreceived = computed(() => modeStats.value
  .filter(([m]) => m.includes(COMPANY_MARK))
  .reduce((n, [, c]) => n + c, 0))
// 组过滤:组内任一未收行的模式含筛选词即保留(组是催收单位,不拆行)
const shownGroups = computed(() => {
  const q = modeFilter.value.trim()
  if (!q) return groups.value
  return groups.value.filter((g) => (g.rows || []).some(
    (r) => isUnreceivedRow(r) && String(r.mode || '').includes(q),
  ))
})
function filterCompany() {
  modeFilter.value = modeFilter.value.trim() === COMPANY_MARK ? '' : COMPANY_MARK
}
const activeAgentName = computed(() => (
  agents.value.find((a) => a.agentKey === agentKey.value)?.agentName || ''
))
const exportUrl = computed(() => (workspaceKey.value ? unreceivedExportUrl(workspaceKey.value) : ''))

async function load() {
  if (!workspaceKey.value) return
  const token = ++loadToken
  loading.value = true
  error.value = ''
  try {
    const payload = await fetchUnreceived({
      workspaceKey: workspaceKey.value,
      agentKey: agentKey.value,
      search: search.value,
    })
    if (token !== loadToken) return // 过期响应丢弃
    view.value = payload
  } catch (e) {
    if (token !== loadToken) return
    error.value = e?.response?.data?.error || e?.message || '未收数据加载失败'
  } finally {
    if (token === loadToken) loading.value = false
  }
}

async function init() {
  loading.value = true
  error.value = ''
  try {
    const payload = await fetchUnreceivedWorkspaces()
    workspaces.value = payload.workspaces || []
    // 默认取最新工作区(列表按键名排序后最大的,即最近月份)
    if (!workspaceKey.value && workspaces.value.length) {
      workspaceKey.value = [...workspaces.value].sort().at(-1)
    }
    if (workspaceKey.value) await load()
    else loading.value = false
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '工作区列表加载失败'
    loading.value = false
  }
}

function pickAgent(key) {
  agentKey.value = agentKey.value === key ? '' : key
  load()
}
function submitSearch() {
  search.value = searchDraft.value.trim()
  load()
}
function clearSearch() {
  searchDraft.value = ''
  if (search.value) { search.value = ''; load() }
}
function switchWorkspace(key) {
  workspaceKey.value = key
  agentKey.value = ''
  load()
}
function toggleGroup(groupKey) {
  const next = new Set(expandedGroups.value)
  if (next.has(groupKey)) next.delete(groupKey)
  else next.add(groupKey)
  expandedGroups.value = next
}
function fmtFirstSeen(iso) {
  return iso ? String(iso).slice(0, 10) : '—'
}
function rowStatusLabel(r) {
  if (r.received) return '已收'
  if (r.waived) return `无需补(${r.waivedBy || '?'})`
  if (r.inFlight) return '在途审核中'
  if (r.overdue) return '超7天'
  return '未收'
}

// ── 导入总账找未收(2026-07-21):上家《SMG总账》→ smg-ledger 导入(只做未收对账,
// 替换语义后端管)→ 完成自动重新对账刷新本页。uploadImport 自带 job 轮询到 done/failed。
const ledgerFileInput = ref(null)
const importing = ref(false)
const importPhase = ref('')
const importNotice = ref('')     // 完成/失败提示(完成绿、失败红,由 importNoticeIsError 区分)
const importNoticeIsError = ref(false)

function pickLedgerFile() {
  if (importing.value || !workspaceKey.value) return
  importNotice.value = ''
  ledgerFileInput.value?.click()
}

async function onLedgerFileChosen(event) {
  const file = event?.target?.files?.[0]
  if (event?.target) event.target.value = '' // 允许连续选同一个文件重试
  if (!file || importing.value || !workspaceKey.value) return
  const ws = workspaceKey.value
  importing.value = true
  importNotice.value = ''
  importNoticeIsError.value = false
  importPhase.value = '上传中…'
  try {
    const res = await uploadImport(ws, 'smg-ledger', file, {
      onUploadProgress: (e) => {
        if (e?.total) importPhase.value = `上传中 ${Math.round((e.loaded / e.total) * 100)}%…`
      },
      onProcessing: () => { importPhase.value = '后台解析入库中…(28万行级需数分钟,请留在本页)' },
    })
    const job = res?.job || {}
    const replaced = Number(job.details?.replacedRows || 0)
    const staleWarning = job.details?.staleWarning || ''
    // 提示带账期:导入期间可能切了工作区,不带标识会误以为是当前页的账期
    if (staleWarning) {
      // 旧版守卫命中:导入成功但疑似传了旧文件,红条大声说,指引立即重导最新版
      importNoticeIsError.value = true
      importNotice.value = `【${ws}】⚠️ ${staleWarning}`
    } else {
      importNotice.value = `【${ws}】导入完成:入库 ${job.rowsInserted ?? '?'} 行`
        + (replaced ? `(替换旧总账 ${replaced} 行)` : '')
        + ',已重新对账'
    }
    // 完成即刷新(后端 onImported 已盖 first_seen;本次 load 拿到最新未收清单)
    if (workspaceKey.value === ws) await load()
  } catch (e) {
    importNoticeIsError.value = true
    importNotice.value = `【${ws}】${e?.response?.data?.error || e?.message || '总账导入失败'}`
  } finally {
    importing.value = false
    importPhase.value = ''
  }
}

// P3:已建档 → 深链去审核台定位(returnTo 回未收页);未建档 → 灰徽标无按钮(拍板⑤)
function openReview(group) {
  const link = buildReviewDeepLink({
    batchId: group.reviewBatchId,
    view: 'queue',
    group: group.reviewGroupKey,
    returnTo: '/agents?view=unreceived',
  })
  if (link) router.push(link)
}

// P3:「无需补」= 组内"真正没收到"的行一起标(留痕);恢复催收 = 撤销组内 waive 行。
// 复核 HIGH#1:在途行(图已收还在审)必须排除——它的照片已在系统里排队,标"无需补"是假留痕。
async function waiveGroup(group) {
  if (!canAct.value || waivingGroupKey.value) return
  const items = group.rows
    .filter((r) => !r.received && !r.waived && !r.inFlight)
    .map((r) => ({ itemKey: r.itemKey, passportNo: r.passportNo, name: r.name, receiptNo: r.receiptNo }))
  if (!items.length) return
  const inFlightCount = group.rows.filter((r) => r.inFlight).length
  if (!window.confirm(
    `标记「${group.name || group.passportNo}」的 ${items.length} 张真正未收的票为无需补?\n`
    + (inFlightCount ? `(另有 ${inFlightCount} 张图已收还在审,不会被标记)\n` : '')
    + '标记人与时间自动留痕;之后可点「恢复催收」撤销。',
  )) return
  waivingGroupKey.value = group.groupKey
  actionError.value = ''
  try {
    await waiveUnreceived({ workspaceKey: workspaceKey.value, items, note: '' })
    await load()
  } catch (e) {
    actionError.value = e?.response?.data?.error || e?.message || '标记失败,请重试'
  } finally {
    waivingGroupKey.value = ''
  }
}

async function unwaiveGroup(group) {
  if (!canAct.value || waivingGroupKey.value) return
  const keys = group.rows.filter((r) => r.waived).map((r) => r.itemKey)
  if (!keys.length) return
  waivingGroupKey.value = group.groupKey
  actionError.value = ''
  try {
    await unwaiveUnreceived({ workspaceKey: workspaceKey.value, itemKeys: keys })
    await load()
  } catch (e) {
    actionError.value = e?.response?.data?.error || e?.message || '恢复失败,请重试'
  } finally {
    waivingGroupKey.value = ''
  }
}

onMounted(init)
</script>

<template>
  <div class="ur-panel">
    <div class="ur-toolbar">
      <label class="ur-select">
        账期
        <select :value="workspaceKey" aria-label="选择账期工作区" @change="switchWorkspace($event.target.value)">
          <option v-for="w in workspaces" :key="w" :value="w">{{ w }}</option>
        </select>
      </label>
      <span class="ur-search">
        <input
          v-model="searchDraft"
          class="ur-search-input"
          type="search"
          placeholder="搜 姓名/护照号/小票号/团号"
          aria-label="搜索未收客户"
          @keyup.enter="submitSearch"
        >
        <button type="button" class="ur-btn" @click="submitSearch">搜索</button>
        <button v-if="search" type="button" class="ur-btn ur-btn-ghost" title="清除搜索" @click="clearSearch">×</button>
      </span>
      <!-- 模式筛选(0727#16-2):可输入文字按子串筛(「本司」一词筛出全部公司模式);
           下拉候选直显各模式未收数量,选中即筛 -->
      <label class="ur-select">
        模式
        <input
          v-model="modeFilter"
          class="ur-mode-input"
          type="text"
          list="ur-mode-options"
          placeholder="输入筛选,如 本司"
          aria-label="按模式筛选未收客户组"
        >
        <datalist id="ur-mode-options">
          <option v-for="[m, c] in modeStats" :key="m" :value="m">未收 {{ c }} 票</option>
        </datalist>
        <button v-if="modeFilter" type="button" class="ur-btn ur-btn-ghost" title="清除模式筛选" @click="modeFilter = ''">×</button>
      </label>
      <span class="ur-spacer" />
      <button type="button" class="ur-btn ur-btn-ghost" title="重新对账刷新" :disabled="loading" @click="load">
        <RefreshCw :size="14" /> 刷新
      </button>
      <button
        v-if="canImport"
        type="button"
        class="ur-btn ur-import"
        :disabled="importing || !workspaceKey"
        title="上传上家《SMG总账.xlsx》(卖出明细 sheet),替换本账期旧总账后自动对账出未收清单;不影响账单匹配四桶"
        @click="pickLedgerFile"
      >
        <Upload :size="14" /> {{ importing ? (importPhase || '导入中…') : '导入总账找未收' }}
      </button>
      <input
        ref="ledgerFileInput"
        type="file"
        accept=".xlsx"
        class="ur-file-hidden"
        aria-label="选择SMG总账文件"
        @change="onLedgerFileChosen"
      >
      <a v-if="exportUrl" class="ur-btn ur-export" :href="exportUrl" title="sheet1 总表 + 每代理一 sheet,未归属殿后;已收/在途/无需补不进催收清单">
        <Download :size="14" /> 导出未收清单.xlsx
      </a>
    </div>

    <p v-if="importNotice" class="ur-import-notice" :class="{ 'is-error': importNoticeIsError }" role="status">
      {{ importNotice }}
      <button type="button" class="ur-btn ur-btn-ghost" @click="importNotice = ''">×</button>
    </p>

    <div v-if="stats" class="ur-stats" role="status">
      <span class="ur-stat"><em>{{ stats.groups }}</em> 未收客户组</span>
      <span class="ur-stat"><em>{{ stats.unreceivedRows }}</em> 未收票</span>
      <span class="ur-stat ur-stat-overdue"><em>{{ stats.overdueGroups }}</em> 超7天</span>
      <span class="ur-stat ur-stat-received"><em>{{ stats.receivedGroups }}</em> 已补齐</span>
      <span v-if="stats.waivedGroups" class="ur-stat"><em>{{ stats.waivedGroups }}</em> 无需补</span>
      <!-- 本司计数卡(0727#16-2 方案2):公司模式未收常驻可见,点击=一键筛选/再点取消。
           未收是待办 → 琥珀;0 时灰阶不喊。 -->
      <button
        type="button"
        class="ur-stat ur-stat-company"
        :class="{ active: modeFilter.trim() === '本司' }"
        :title="companyUnreceived ? '含「本司」字样模式的未收票数;点击只看这些(二轮收票重点)' : '公司模式(本司)无未收'"
        @click="filterCompany"
      >
        <em :class="{ amber: companyUnreceived > 0 }">{{ companyUnreceived }}</em> 本司未收
      </button>
      <span v-if="modeFilter.trim()" class="ur-stat ur-filter-note">筛选:{{ modeFilter.trim() }} · {{ shownGroups.length }} 组</span>
    </div>

    <p v-if="error" class="ur-error">{{ error }} <button type="button" class="ur-btn" @click="init">重试</button></p>
    <p v-if="actionError" class="ur-error">
      {{ actionError }}
      <button type="button" class="ur-btn ur-btn-ghost" @click="actionError = ''">×</button>
    </p>

    <div class="ur-columns">
      <aside class="ur-agents" aria-label="代理未收分桶">
        <button
          type="button"
          class="ur-agent-row"
          :class="{ active: !agentKey }"
          @click="pickAgent('')"
        >
          <span class="ur-agent-name">全部代理</span>
        </button>
        <button
          v-for="a in agents"
          :key="a.agentKey"
          type="button"
          class="ur-agent-row"
          :class="{ active: agentKey === a.agentKey, unassigned: a.agentName === '未归属' }"
          @click="pickAgent(a.agentKey)"
        >
          <span class="ur-agent-name">{{ a.agentName }}</span>
          <span class="ur-agent-counts">
            {{ a.groupCount }}组/{{ a.unreceivedCount }}票
            <em v-if="a.overdueCount" class="ur-agent-overdue">{{ a.overdueCount }}红</em>
          </span>
        </button>
      </aside>

      <main class="ur-main" aria-label="未收客户组列表">
        <p v-if="loading" class="ur-hint">对账中…</p>
        <p v-else-if="!shownGroups.length" class="ur-hint">
          {{ modeFilter.trim() ? `模式「${modeFilter.trim()}」下没有未收客户组` : (agentKey ? `${activeAgentName} 没有未收客户组` : '本账期没有未收客户组(账单票已全部收齐)') }}
        </p>
        <table v-else class="ur-table">
          <thead>
            <tr>
              <th>#</th>
              <th>状态</th>
              <th>姓名</th>
              <th>护照号</th>
              <th>团号</th>
              <th>代理</th>
              <th title="已收+在途/应收">图片数</th>
              <th>首次发现</th>
              <th>建档</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <template v-for="(g, i) in shownGroups" :key="g.groupKey">
              <tr class="ur-group-row" :class="STATUS_META[g.status]?.cls">
                <td>{{ i + 1 }}</td>
                <td><span class="ur-status-chip" :class="STATUS_META[g.status]?.cls">{{ STATUS_META[g.status]?.label || g.status }}</span></td>
                <td class="ur-cell-name">{{ g.name || '—' }}</td>
                <td class="ur-cell-mono">{{ g.passportNo || '—' }}</td>
                <td class="ur-cell-mono">{{ g.tourNo || '—' }}</td>
                <td :class="{ 'ur-unassigned-txt': g.agentName === '未归属' }">{{ g.agentName }}</td>
                <td class="ur-cell-mono" :title="`台账已收 ${g.receivedCount},含在途 ${g.collectedCount}/${g.totalCount}`">
                  {{ g.collectedCount }}/{{ g.totalCount }}
                </td>
                <td class="ur-cell-mono">{{ fmtFirstSeen(g.firstSeenAt) }}</td>
                <td>
                  <!-- 拍板⑤:已建档给真跳转;未建档明示徽标,不留死按钮 -->
                  <button
                    v-if="g.registered && g.reviewBatchId"
                    type="button"
                    class="ur-btn ur-btn-link"
                    title="图已在系统里,去审核台定位这组"
                    @click="openReview(g)"
                  >
                    去审核
                  </button>
                  <span v-else class="ur-badge-unregistered" title="系统里还没有这位客户的图,等收图建档">未建档</span>
                </td>
                <td class="ur-cell-actions">
                  <button type="button" class="ur-btn ur-btn-ghost" @click="toggleGroup(g.groupKey)">
                    {{ expandedGroups.has(g.groupKey) ? '收起' : `明细(${g.rows.length})` }}
                  </button>
                  <button
                    v-if="canAct && g.status !== 'received' && g.status !== 'waived'"
                    type="button"
                    class="ur-btn ur-btn-ghost"
                    :disabled="waivingGroupKey === g.groupKey"
                    title="标记真正未收的票为无需补(变灰留痕;催收任务自动收口:组内无任何进展则取消,已有已收/在途则记完成)"
                    @click="waiveGroup(g)"
                  >
                    无需补
                  </button>
                  <button
                    v-if="canAct && g.status === 'waived'"
                    type="button"
                    class="ur-btn ur-btn-ghost"
                    :disabled="waivingGroupKey === g.groupKey"
                    title="撤销无需补,恢复催收"
                    @click="unwaiveGroup(g)"
                  >
                    恢复催收
                  </button>
                </td>
              </tr>
              <tr v-if="expandedGroups.has(g.groupKey)" class="ur-detail-row">
                <td colspan="10">
                  <table class="ur-detail-table">
                    <thead>
                      <tr><th>小票号</th><th>免税店</th><th>分店</th><th>模式</th><th>购买日期</th><th>出账日期</th><th>品牌</th><th>状态</th></tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="r in g.rows"
                        :key="r.itemKey"
                        :class="{ 'ur-row-received': r.received || r.waived, 'ur-row-overdue': r.overdue }"
                      >
                        <td class="ur-cell-mono">{{ r.receiptNo }}</td>
                        <td>{{ r.storeFamily || '—' }}</td>
                        <td>{{ r.storeBranch || '—' }}</td>
                        <td>{{ r.mode || '—' }}</td>
                        <td class="ur-cell-mono">{{ r.purchaseDate || '—' }}</td>
                        <td class="ur-cell-mono">{{ r.statementDate || '—' }}</td>
                        <td>{{ r.brand || '—' }}</td>
                        <td :title="r.waived ? `${r.waivedBy || ''} ${String(r.waivedAt || '').slice(0, 10)} ${r.waivedNote || ''}`.trim() : ''">
                          {{ rowStatusLabel(r) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </main>
    </div>
  </div>
</template>

<style scoped>
.ur-panel { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.ur-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ur-select { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #475569; }
.ur-select select { padding: 4px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
.ur-search { display: inline-flex; align-items: center; gap: 6px; }
.ur-search-input { width: 220px; padding: 5px 9px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
.ur-spacer { flex: 1; }
.ur-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px;
  border: 1px solid #cbd5e1; border-radius: 6px; background: #fff;
  font-size: 12.5px; color: #334155; cursor: pointer; text-decoration: none;
}
.ur-btn:hover { background: #f1f5f9; }
.ur-btn:disabled { opacity: 0.5; cursor: default; }
.ur-btn-ghost { border-color: transparent; }
.ur-btn-link { border-color: transparent; color: #2563eb; font-weight: 500; padding: 3px 6px; }
.ur-export { border-color: #2563eb; color: #2563eb; font-weight: 500; }
.ur-export:hover { background: #eff6ff; }
.ur-import { border-color: #cbd5e1; color: #0f172a; font-weight: 500; }
.ur-import:hover { background: #f8fafc; }
.ur-file-hidden { display: none; }
.ur-import-notice {
  display: flex; align-items: center; gap: 8px;
  margin: 0; padding: 6px 10px; border-radius: 6px;
  background: #f1f5f9; color: #475569; font-size: 13px;
}
.ur-import-notice.is-error { background: #fef2f2; color: #b91c1c; }
.ur-stats { display: flex; gap: 14px; font-size: 13px; color: #475569; }
.ur-stat em { font-style: normal; font-weight: 500; color: #0f172a; margin-right: 3px; }
.ur-stat-overdue em { color: #dc2626; }
.ur-stat-received em { color: #475569; }
.ur-mode-input { width: 150px; padding: 4px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
.ur-stat-company { border: 1px solid #e2e8f0; border-radius: 999px; padding: 2px 10px; background: #fff; cursor: pointer; font-size: 13px; color: #475569; }
.ur-stat-company:hover { border-color: #94a3b8; }
.ur-stat-company.active { border-color: #b45309; background: #fffbeb; }
.ur-stat-company em.amber { color: #b45309; }
.ur-filter-note { color: #94a3b8; }
.ur-error { color: #b91c1c; font-size: 13px; }
.ur-hint { color: #64748b; font-size: 13px; padding: 18px 6px; }

.ur-columns { display: grid; grid-template-columns: 220px 1fr; gap: 12px; min-height: 0; flex: 1; }
.ur-agents { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.ur-agent-row {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 7px 10px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff;
  font-size: 13px; cursor: pointer; text-align: left;
}
.ur-agent-row:hover { border-color: #94a3b8; }
.ur-agent-row.active { border-color: #2563eb; background: #eff6ff; }
.ur-agent-row.unassigned .ur-agent-name { color: #9333ea; }
.ur-agent-counts { font-size: 12px; color: #64748b; white-space: nowrap; }
.ur-agent-overdue { font-style: normal; color: #dc2626; font-weight: 500; margin-left: 4px; }

.ur-main { overflow: auto; min-height: 0; }
.ur-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ur-table th, .ur-table td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
.ur-table thead th { position: sticky; top: 0; background: #f8fafc; z-index: 1; font-weight: 500; color: #475569; }
.ur-cell-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.ur-cell-name { font-weight: 500; }
.ur-cell-actions { white-space: nowrap; }
/* 状态五档:超7天红 / 待收黄 / 部分已收黄 / 无需补灰留痕 / 已收灰(拍板④+mockup人工态) */
.ur-group-row.ur-st-overdue { background: #fef2f2; }
.ur-group-row.ur-st-received, .ur-group-row.ur-st-waived { background: #f8fafc; color: #94a3b8; }
.ur-status-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; }
.ur-status-chip.ur-st-overdue { background: #dc2626; color: #fff; }
.ur-status-chip.ur-st-pending { background: #fef3c7; color: #92400e; }
.ur-status-chip.ur-st-partial { background: #fde68a; color: #78350f; }
.ur-status-chip.ur-st-waived { background: #e2e8f0; color: #475569; }
.ur-status-chip.ur-st-received { background: #e2e8f0; color: #64748b; }
.ur-badge-unregistered {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  background: #f1f5f9; color: #94a3b8; font-size: 12px;
}
.ur-detail-row > td { background: #fbfdff; padding: 6px 12px 12px; }
.ur-detail-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ur-detail-table th, .ur-detail-table td { padding: 5px 8px; border-bottom: 1px dashed #e2e8f0; text-align: left; }
.ur-row-received { color: #94a3b8; }
.ur-row-overdue td:last-child { color: #dc2626; font-weight: 500; }

@media (max-width: 1100px) {
  .ur-columns { grid-template-columns: 1fr; }
  .ur-agents { flex-direction: row; flex-wrap: wrap; }
}
</style>
