<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useCustomerStore } from '../stores/customer'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { useWorkbenchStore } from '../stores/workbench'
import { appendUniqueFiles } from '../lib/dropBuffer'
import { groupBatchesByDay, batchOptionLabel } from '../lib/batchGrouping'
import { deleteBatch as deleteBatchApi } from '../api/workbench'
import MoreMenu from '../components/MoreMenu.vue'

const LAST_AGENT_NAME_KEY = 'sign:intake:lastAgentName'

const router = useRouter()
const customer = useCustomerStore()
const uploadQueue = useUploadQueueStore()
const workbench = useWorkbenchStore()
const customerFiles = ref(null)
const forms = reactive({
  workspaceKey: '',
  agentName: '',
  importBatchName: '',
  workspaceAppendBatchId: '',
})

const createDragActive = ref(false)
const createFilesBuffer = ref([])

const selectedCustomer = computed(() => customer.selectedCustomer)
const selectedCustomerId = computed(() => selectedCustomer.value?.customerId || selectedCustomer.value?.id || '')
const hasWorkspace = computed(() => Boolean(customer.activeWorkspace))
const hasCustomers = computed(() => customer.customers.length > 0)
let preprocessPollTimer = null

function customerIdOf(record) {
  return record?.customerId || record?.id || ''
}

function customerDisplayName(record) {
  return record?.agentName || record?.folderNameInitial || customerIdOf(record)
}

function customerStatusLabel(status) {
  const key = String(status || '').trim()
  return {
    // 2026-07-27 用户拍板:界面不出现「同步」——那是内部管道(且全自动),操作员既不用管也点不动。
    // 状态一律用业务说法:识别完成 = 已完成。
    ready_for_review: '已完成',
    in_review: '审核中',
    template_generated: '已建档',
    processed: '已预处理',
  }[key] || key || '-'
}

function recordImageCount(record) {
  return Number(record?.images?.length || record?.imageCount || record?.files?.length || 0)
}

function preprocessTotalForRecord(record) {
  const preprocess = record?.preprocess || {}
  return Number(preprocess.totalImages || preprocess.inputImages || recordImageCount(record) || 0)
}

function customerPreprocessWarningCount(record) {
  const preprocess = record?.preprocess || {}
  const summaryWarning = Number(preprocess.warningImages || 0)
  if (summaryWarning > 0) return summaryWarning
  const images = record?.images || record?.files || []
  return images.filter((image) => (
    image?.preprocessWarning
    || String(image?.preprocessMessage || '').startsWith('split_failed_keep_original')
  )).length
}

const preprocessProgress = computed(() => {
  const rows = customer.customers || []
  let total = 0
  let current = 0
  let running = customer.actionLoading === 'workspace-preprocess'
    || customer.actionLoading.startsWith('customer-preprocess')
  let currentCustomer = ''
  let failed = 0
  let warning = 0
  let split = 0
  let output = 0

  for (const record of rows) {
    const preprocess = record.preprocess || {}
    const rowTotal = preprocessTotalForRecord(record)
    const status = String(preprocess.status || '').trim()
    const rowWarning = customerPreprocessWarningCount(record)
    total += rowTotal
    failed += Number(preprocess.failedImages || 0)
    warning += rowWarning
    split += Number(preprocess.splitImages || 0)
    output += Number(preprocess.outputImages || 0)

    if (status === 'processing') {
      running = true
      current += Math.min(rowTotal, Math.max(0, Number(preprocess.currentImage || 0)))
      currentCustomer = currentCustomer || customerDisplayName(record)
      continue
    }
    if (['processed', 'needs_review', 'deleted_during_preprocess'].includes(status)) {
      current += rowTotal
    }
  }

  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  return {
    current,
    total,
    running,
    percent,
    currentCustomer,
    failed,
    warning,
    split,
    output,
  }
})

const preprocessProgressState = computed(() => {
  if (preprocessProgress.value.running) return 'running'
  if (preprocessProgress.value.failed > 0) return 'failed'
  if (preprocessProgress.value.total > 0 && preprocessProgress.value.current >= preprocessProgress.value.total) return 'done'
  return 'idle'
})

const preprocessProgressTitle = computed(() => ({
  running: '识别中',
  failed: '预处理结束：有失败图片',
  done: '预处理完成',
  idle: '预处理进度',
}[preprocessProgressState.value]))

const preprocessProgressStatusClass = computed(() => ({
  running: 'count warning',
  failed: 'count warning',
  done: 'count',
  idle: 'count',
}[preprocessProgressState.value]))

function hasReviewBatch(record) {
  return Boolean(record?.review?.lastBatchId || record?.review?.lastSourceGroupId)
}

function preprocessStatusInfo(record) {
  const preprocess = record?.preprocess || {}
  const status = String(preprocess.status || '').trim()
  const total = preprocessTotalForRecord(record)
  const current = Math.min(total, Math.max(0, Number(preprocess.currentImage || 0)))
  const failed = Number(preprocess.failedImages || 0)
  const warning = customerPreprocessWarningCount(record)
  const output = Number(preprocess.outputImages || 0)
  const split = Number(preprocess.splitImages || 0)

  if (status === 'processing') {
    return {
      label: `识别中 ${current}/${total || recordImageCount(record)}`,
      className: 'warning',
      output,
      split,
      failed,
      warning,
    }
  }
  if (status === 'error') {
    // 服务重启中断识别(启动恢复标记):不是识别失败,是被打断,提示重跑
    return { label: '识别中断·请重识别', className: 'danger', output, split, failed, warning }
  }
  if (failed > 0) {
    return { label: `失败 ${failed}`, className: 'danger', output, split, failed, warning }
  }
  if (status === 'needs_review' || warning > 0) {
    return { label: `低置信度 ${warning}`, className: 'warning', output, split, failed, warning }
  }
  if (['processed', 'deleted_during_preprocess'].includes(status)) {
    return { label: '预处理完成', className: 'success', output, split, failed, warning }
  }
  if (hasReviewBatch(record)) {
    return { label: '已进审核', className: 'success', output: output || recordImageCount(record), split, failed, warning }
  }
  if (recordImageCount(record) > 0) {
    return { label: '待预处理', className: 'warning', output, split, failed, warning }
  }
  return { label: '无图片', className: 'warning', output, split, failed, warning }
}

function uploadStatusInfo(record) {
  if (recordImageCount(record) > 0) {
    return { label: '上传成功', className: 'success', hint: `${recordImageCount(record)} 张原图` }
  }
  return { label: '待上传', className: 'warning', hint: '还没有客户图片' }
}

function customerReadinessInfo(record) {
  const preprocess = record?.preprocess || {}
  const status = String(preprocess.status || '').trim()
  const imageCount = recordImageCount(record)
  const failed = Number(preprocess.failedImages || 0)

  if (!imageCount) {
    return { label: '缺图片', className: 'warning', hint: '先上传客户图片', ready: false }
  }
  if (status === 'processing') {
    return { label: '处理中', className: 'warning', hint: '等进度完成', ready: false }
  }
  if (status === 'error') {
    // 服务重启中断识别 → 不自动入批次(切图可能不全),提示重跑
    return { label: '识别中断', className: 'danger', hint: '服务重启打断了识别,请点重新识别', ready: false }
  }
  if (failed > 0) {
    return { label: '需处理失败', className: 'danger', hint: '删除或重传失败图片', ready: false }
  }
  if (record?.status === 'in_review' || hasReviewBatch(record)) {
    return { label: '已进审核', className: 'success', hint: '可继续补图', ready: true }
  }
  if (['ready_for_review', 'processed', 'needs_review', 'deleted_during_preprocess'].includes(status) || record?.status === 'ready_for_review') {
    return { label: '已完成', className: 'success', hint: '识别完成,会自动进审核批次', ready: true }
  }
  return { label: '建议预处理', className: 'warning', hint: '先跑预处理', ready: false }
}

// 阶段推导(收图→识别→就绪→审核),给看板画进度条;tone 取就绪判定的颜色口径
function customerStageInfo(record, readiness) {
  const status = String(record?.preprocess?.status || '').trim()
  const inReview = record?.status === 'in_review' || hasReviewBatch(record)
  const recognized = ['processed', 'needs_review', 'deleted_during_preprocess'].includes(status)
  let index = 0 // 0 收图 · 1 识别 · 2 就绪 · 3 审核
  if (recognized || status === 'processing') index = 1
  if (readiness.ready) index = 2
  if (inReview) index = 3
  return { index, tone: readiness.className }
}

const preprocessCustomerRows = computed(() => (
  customer.customers.map((record) => {
    const preprocess = preprocessStatusInfo(record)
    const readiness = customerReadinessInfo(record)
    const stage = customerStageInfo(record, readiness)
    const filterKey = stage.tone === 'danger'
      ? 'blocked'
      : (readiness.ready ? 'ready' : 'processing')
    return {
      id: customerIdOf(record),
      name: customerDisplayName(record),
      // 已导入审核批次的客户:拿到批次id → 一键去审"这一个客户"(客户组key=customerId)
      reviewBatchId: record?.review?.lastBatchId || '',
      // 是否已进审核(复核 LOW-MEDIUM):必须与行内状态徽章同源 hasReviewBatch(认 lastBatchId
      // **或** lastSourceGroupId)。只认 lastBatchId 的话,批次追加部分拷贝失败那种"只打了
      // lastSourceGroupId"的客户会:行显示「已进审核」、汇总却算进「待同步」,自相矛盾。
      inReview: hasReviewBatch(record),
      upload: uploadStatusInfo(record),
      statusLabel: customerStatusLabel(record.status),
      imageCount: recordImageCount(record),
      splitCount: Number(preprocess.split || 0),
      preprocess,
      readiness,
      stage,
      filterKey,
      createdAt: record.createdAt || '-',
      updatedAt: record.updatedAt || '-',
    }
  })
))

// 一键去审"这一个客户":跳审核台并用 ?group=customerId 预选该客户组(闭环导航第一段)。
function goReviewCustomer(row) {
  if (!row?.reviewBatchId) return
  router.push({ name: 'review', params: { batchId: row.reviewBatchId }, query: { group: row.id } })
}

// ── 当前审核批次(新流程:先建批次绑团号表 → 建档自动进它,取消手动导入/追加)──
const STORAGE_ACTIVE_BATCH = 'sign:intake:activeBatchId'
const activeBatchId = ref(localStorage.getItem(STORAGE_ACTIVE_BATCH) || '')
const newBatchName = ref('')
const newBatchGroupCodeInput = ref(null)
const newBatchGroupCodeName = ref('')
const creatingBatch = ref(false)
const autoAppending = ref(false)
// 新建批次表单默认收起(2026-07-26 信息架构:主区只留「选当前批次」,新建是辅助操作)
const showNewBatch = ref(false)
// 「取消新建」必须把表单真的重置(复核 MEDIUM):否则选了团号表A→取消→过会儿再点新建,
// 按钮上仍挂着「✓ A.xlsx」,没留意就点确认 → 新批次绑到上次那张表(误绑,且事后极难发现)。
// 展开时不清(纯展开无残留);只在收起(=取消)时清名字+文件名+原生 file input 的 .files。
function toggleNewBatch() {
  showNewBatch.value = !showNewBatch.value
  if (!showNewBatch.value) {
    newBatchName.value = ''
    newBatchGroupCodeName.value = ''
    if (newBatchGroupCodeInput.value) newBatchGroupCodeInput.value.value = ''
  }
}

// 「+ 新建 ▾」菜单(2026-07-29 方案B):全页唯一的新建入口,两项互斥展开。
// 批次侧一律走 toggleNewBatch —— 它带表单重置护栏,绕过去就会重演"团号表误绑"。
const showNewWorkspace = ref(false)
function openNewPanel(kind) {
  if (kind === 'workspace') {
    if (showNewBatch.value) toggleNewBatch()
    showNewWorkspace.value = true
  } else {
    showNewWorkspace.value = false
    if (!showNewBatch.value) toggleNewBatch()
  }
}

function persistActiveBatch(id) {
  activeBatchId.value = id || ''
  if (id) localStorage.setItem(STORAGE_ACTIVE_BATCH, id)
  else localStorage.removeItem(STORAGE_ACTIVE_BATCH)
}
function onActiveBatchChange() { persistActiveBatch(activeBatchId.value) }
function pickNewBatchGroupCode() { newBatchGroupCodeInput.value?.click() }
// 团号表重传专用入口(2026-07-27 复核 HIGH):建批次成功后 showNewBatch 会置 false,
// 新建表单连同 newBatchGroupCodeInput 一起卸载;而失败横幅在表单之外,还活着。
// 之前重传按钮复用 pickNewBatchGroupCode → ref 已是 null → ?. 静默什么都不发生;
// 就算能弹出选择框,onNewBatchGroupCodeChange 也只记个文件名、不会真的重传。
// 所以这里给一套独立的、永远挂载的 input + 真正打上传的 handler。
const gcRetryInput = ref(null)
function pickGcRetry() { gcRetryInput.value?.click() }
function onGcRetryChange(e) {
  const file = e.target.files?.[0]
  const batchId = gcUpload.batchId
  e.target.value = '' // 清空,允许连续重选同一个文件(否则第二次不触发 change)
  if (!file) return
  if (!batchId) { setCustomerError('找不到要重传的批次,请刷新后在审核台用「换团号表」'); return }
  uploadGroupCodeInBackground(batchId, file)
}
function onNewBatchGroupCodeChange(e) { newBatchGroupCodeName.value = e.target.files?.[0]?.name || '' }
function selectedNewBatchGroupCode() { return Array.from(newBatchGroupCodeInput.value?.files || [])[0] || null }

// 新建空批次:只绑团号表(后台解析),不要求已有客户;之后建档自动 append 进来。
// 团号表后台上传进度。phase: ''(无) | uploading | parsing | ready | failed
const gcUpload = reactive({ batchId: '', name: '', pct: 0, phase: '' })

async function createEmptyBatch() {
  const groupCodeFile = selectedNewBatchGroupCode()
  if (!groupCodeFile) { setCustomerError('请先选择团号表'); newBatchGroupCodeInput.value?.click(); return }
  if (!hasWorkspace.value) { setCustomerError('请先选择 / 新建工作区'); return }
  creatingBatch.value = true
  try {
    // ① 秒建空批次:请求里不带 8.8MB 团号表,立刻返回,马上能建档。
    // 声明团号表文件名 → 服务端强绑定(不声明会被 400 拒建),批次出生即盖 awaiting_upload。
    const payload = await customer.importActiveWorkspace(newBatchName.value.trim(), {
      allowEmpty: true,
      groupCodeSourceFile: groupCodeFile.name || '',
    })
    if (payload?.batchId) {
      persistActiveBatch(payload.batchId)
      newBatchName.value = ''
      showNewBatch.value = false // 建好即收起表单,视觉焦点回到「当前审核批次」
      await workbench.fetchBatches().catch(() => null)
      // ② 团号表丢后台上传(带进度),不阻塞按钮 / 建档。
      uploadGroupCodeInBackground(payload.batchId, groupCodeFile)
    }
  } catch (err) {
    // 批次名重复等后端校验错误,原样提示,操作员改名重试(团号表仍保留,不用重选)。
    setCustomerError(err?.response?.data?.error || err?.message || '建批次失败')
  } finally {
    creatingBatch.value = false
  }
}

// 后台上传团号表:进度 → 上传完触发后台解析 → 轮询批次状态到 ready。全程不卡 UI,可同时建档。
async function uploadGroupCodeInBackground(batchId, file) {
  gcUpload.batchId = batchId
  gcUpload.name = file?.name || '团号表'
  gcUpload.pct = 0
  gcUpload.phase = 'uploading'
  newBatchGroupCodeName.value = ''
  if (newBatchGroupCodeInput.value) newBatchGroupCodeInput.value.value = ''
  try {
    await customer.uploadBatchGroupCode(batchId, file, (e) => {
      if (e?.total) gcUpload.pct = Math.min(100, Math.round((e.loaded / e.total) * 100))
    })
    gcUpload.phase = 'parsing'
    pollGroupCodeStatus(batchId, 0)
  } catch (err) {
    gcUpload.phase = 'failed'
    setCustomerError('团号表上传失败:' + (err?.message || err))
  }
}

// 上传完团号表在后台解析,轮询批次 groupCodeStatus 到 ready/failed。
async function pollGroupCodeStatus(batchId, tries) {
  if (gcUpload.batchId !== batchId) return // 已被新一轮上传覆盖
  if (tries > 40) return // ~2 分钟后停止轮询,留在「解析中」(刷新可见最终态)
  await workbench.fetchBatches().catch(() => null)
  const b = (workbench.batches || []).find((x) => (x.id || x.batchId) === batchId)
  const st = b?.groupCodeStatus
  if (st === 'ready') {
    gcUpload.phase = 'ready'
    setTimeout(() => { if (gcUpload.batchId === batchId) gcUpload.phase = '' }, 4000)
    return
  }
  if (st === 'failed') { gcUpload.phase = 'failed'; return }
  setTimeout(() => pollGroupCodeStatus(batchId, tries + 1), 3000)
}

// 建档+预处理完成(可同步)的客户,自动追加到当前批次。幂等,只在设了当前批次时生效。
const readyNotInActiveBatch = computed(() => {
  if (!activeBatchId.value) return []
  // 只自动追加「从没进过任何批次」的新客户。之前用 lastBatchId !== activeBatchId,
  // 会把「已属于别的批次」的客户也判为可追加 → 并发/切工作区时把别人的客户吸进本批次(串台 bug)。
  return customer.customers.filter((rec) => (
    customerReadinessInfo(rec).ready && !rec?.review?.lastBatchId
  ))
})
// 只看「当前工作区」的批次:批次创建时绑死工作区,选到别的工作区的批次上传必被 400 拦
// (生产事故:批次名按日期自动起,操作员建批次时工作区选择器还停在前一天 → 名字像今天的、
// 绑定是昨天的,选中它上传永远失败,刷新重登都没用)。没绑工作区的旧批次不过滤,兼容显示。
const workspaceBatches = computed(() => (workbench.batches || []).filter((b) => {
  const ws = String(b.monthlyWorkspaceKey || '').trim()
  return !ws || ws === customer.activeWorkspace
}))
function activeBatchExists() {
  return workspaceBatches.value.some((b) => (b.id || b.batchId) === activeBatchId.value)
}
// 批次下拉按创建日分组(今天/昨天/MM-DD),选项带收票员+时刻;每天几十个新批次也找得到。
const groupedBatches = computed(() => groupBatchesByDay(workspaceBatches.value))
const activeBatchValid = computed(() => Boolean(activeBatchId.value) && activeBatchExists())
// 当前批次被删 / 换了人后,localStorage 残留的 activeBatchId 会指向不存在的批次 →
// 显示空名当前批次、卡住建档,刷新也没用。批次列表取回后发现当前批次不在里头就清掉(当未选)。
function pruneStaleActiveBatch() {
  if (activeBatchId.value && !activeBatchExists()) {
    persistActiveBatch('')
  }
}
// 切工作区时当前批次大概率不属于新工作区 → 立即清掉,别让人带着错批次上传。
watch(() => customer.activeWorkspace, () => pruneStaleActiveBatch())
watch(readyNotInActiveBatch, async (list) => {
  if (!activeBatchId.value || !list.length || autoAppending.value) return
  // 当前批次必须是已加载的真实批次(防 localStorage 里残留的别工作区/已删批次乱 append)。
  if (!activeBatchExists()) return
  autoAppending.value = true
  try {
    await customer.appendWorkspaceToBatch(activeBatchId.value)
  } catch { /* store 已 setError 提示 */ } finally {
    autoAppending.value = false
  }
})

const workspaceReadinessSummary = computed(() => {
  const rows = preprocessCustomerRows.value
  const ready = rows.filter((row) => row.readiness.ready).length
  const waiting = rows.filter((row) => row.readiness.className === 'warning' && !row.readiness.ready).length
  const blocked = rows.filter((row) => row.readiness.className === 'danger').length
  // 口径纠正(2026-07-26):readiness.ready 对「已进审核」和「还没进批次」都为 true,
  // 旧「N 可同步」把已经同步完的也算进去(266客户/266可同步,而实际全都已进审核)= 误导。
  // 拆成两个真数字:已进审核(已完成同步)/ 待同步(真还没进批次,=自动同步的待办,健康态应为 0)。
  const inReview = rows.filter((row) => row.inReview).length
  const pendingSync = rows.filter((row) => row.readiness.ready && !row.inReview).length
  return { ready, waiting, blocked, total: rows.length, inReview, pendingSync }
})

// 建档后自动识别(开关默认开)
const autoPreprocess = ref(true)
// goImport/pickGroupCode/onGroupCodeChange/importPanelRef 已删:旧导入面板交互遗骸
// (75287ea 信息架构重排后无引用;importPanelRef 只剩绑定、无任何 scrollIntoView 用它)

// 各区块一键收起(页面长时折叠不看的部分,默认展开)
const collapsed = reactive({ board: false, importPanel: true })
// 看板:筛选(全部/异常/处理中/已完成,三桶互斥且穷尽)+ 搜索,支撑 200+ 客户(行很轻,直接渲染;极大档再接虚拟滚动)
const boardFilter = ref('all')
const boardSearch = ref('')
const boardCounts = computed(() => {
  const rows = preprocessCustomerRows.value
  return {
    all: rows.length,
    blocked: rows.filter((r) => r.filterKey === 'blocked').length,
    processing: rows.filter((r) => r.filterKey === 'processing').length,
    ready: rows.filter((r) => r.filterKey === 'ready').length,
  }
})
const boardRows = computed(() => {
  const keyword = boardSearch.value.trim().toLowerCase()
  return preprocessCustomerRows.value.filter((row) => {
    if (boardFilter.value !== 'all' && row.filterKey !== boardFilter.value) return false
    if (keyword && !`${row.name} ${row.id}`.toLowerCase().includes(keyword)) return false
    return true
  })
})

// 看板按日期折叠(用户反馈:几百客户一屏太长)。日期取客户号前缀 CLyyyymmdd,取不到归"其他"。
// 最新一天默认展开,更早默认收起;点头切换记住;搜索时全展开(不然搜到的行被折叠藏住)。
function boardDateOf(row) {
  const m = String(row.id || '').match(/^CL(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '其他'
}
const boardRowsByDate = computed(() => {
  const map = new Map()
  for (const row of boardRows.value) {
    const date = boardDateOf(row)
    if (!map.has(date)) map.set(date, [])
    map.get(date).push(row)
  }
  return [...map.entries()]
    .map(([date, rows]) => ({ date, rows }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
})
const dateBucketToggle = ref(new Map())
function isDateOpen(date, index) {
  if (boardSearch.value.trim()) return true
  if (dateBucketToggle.value.has(date)) return dateBucketToggle.value.get(date)
  return index === 0
}
function toggleDateBucket(date, index) {
  dateBucketToggle.value.set(date, !isDateOpen(date, index))
  dateBucketToggle.value = new Map(dateBucketToggle.value)
}

// 单客户操作(store 早有 action,旧 UI 没暴露入口)
async function reprocessOne(customerId) {
  if (customerId) await customer.preprocessCustomer(customerId)
}
const appendTargetId = ref('')
const appendFilesInput = ref(null)
function appendImagesTo(customerId) {
  appendTargetId.value = customerId
  appendFilesInput.value?.click()
}
async function handleAppendFiles(event) {
  const files = Array.from(event.target?.files || [])
  const customerId = appendTargetId.value
  appendTargetId.value = ''
  if (event.target) event.target.value = ''
  if (!files.length || !customerId) return
  await customer.appendImagesToCustomer({ customerId, files })
}

function fileList(inputRef) {
  return Array.from(inputRef.value?.files || [])
}

function clearFileInput(inputRef) {
  if (inputRef.value) {
    inputRef.value.value = ''
  }
}

function readLastAgentName() {
  try {
    return window.localStorage.getItem(LAST_AGENT_NAME_KEY) || ''
  } catch {
    return ''
  }
}

function rememberAgentName(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return
  try {
    window.localStorage.setItem(LAST_AGENT_NAME_KEY, trimmed)
  } catch {
    // Ignore private-mode storage failures; the current form value still works.
  }
}

// selectedGroupCodeFile 已随 importWorkspace 一并删除(级联孤儿,lint 清理确认)

function setCustomerError(message) {
  customer.setError(message)
}

const uploadProgressStatusLabel = computed(() => ({
  uploading: '上传中',
  success: '上传成功',
  error: '上传失败',
  idle: '等待上传',
}[customer.uploadProgress?.status || 'idle']))

const uploadProgressStatusClass = computed(() => ({
  uploading: 'status warning',
  success: 'status success',
  error: 'status danger',
  idle: 'status',
}[customer.uploadProgress?.status || 'idle']))

function collectDroppedImageFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  return files.filter((f) => f.type === '' || f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp)$/i.test(f.name))
}

function handleCreateDrop(event) {
  event.preventDefault()
  createDragActive.value = false
  const files = collectDroppedImageFiles(event.dataTransfer)
  if (files.length) {
    createFilesBuffer.value = appendUniqueFiles(createFilesBuffer.value, files)
  }
}

function removeCreateFile(idx) {
  createFilesBuffer.value = createFilesBuffer.value.filter((_, i) => i !== idx)
}

async function bootstrap() {
  await customer.loadState()
  await customer.loadWorkspaces()
  await customer.loadCustomers()
  await workbench.fetchBatches()
  pruneStaleActiveBatch() // 清掉指向已删批次的残留 activeBatchId(刷新即自愈)
  forms.workspaceKey = customer.activeWorkspace
  if (!forms.agentName) {
    forms.agentName = readLastAgentName()
  }
  forms.workspaceAppendBatchId = forms.workspaceAppendBatchId || workbench.latestBatchId
  ensurePreprocessPolling()
}

async function createWorkspace() {
  const workspaceKey = forms.workspaceKey.trim()
  if (!workspaceKey) {
    setCustomerError('请输入工作区名称')
    return
  }
  await customer.createWorkspace(workspaceKey)
  // 建好即收起面板并清输入(与批次侧同款:表单不留残值,免下次点开看见上次的名字)
  if (!customer.error) {
    forms.workspaceKey = ''
    showNewWorkspace.value = false
  }
}

async function changeWorkspace() {
  // 换工作区 = 换收图容器,清掉当前批次,避免把新工作区的客户自动 append 进别工作区的旧批次。
  persistActiveBatch('')
  await customer.loadCustomers(customer.activeWorkspace)
  ensurePreprocessPolling()
}

// T6-B 上传后台队列:点「建档」只做校验+快照入队,立刻清空表单可录下一个客户。
// 真正的上传/识别由 uploadQueue 串行后台跑(保序红线),进度/失败在下方队列面板可见。
function createCustomer() {
  const filesFromBuffer = createFilesBuffer.value
  const filesFromInput = fileList(customerFiles)
  const files = filesFromBuffer.length ? filesFromBuffer : filesFromInput
  const agentName = forms.agentName.trim()
  // 批次前置(硬性):没有有效的当前审核批次不允许收图(后端同样强制,双保险)。
  if (!activeBatchValid.value) {
    setCustomerError('请先建立/选择「当前审核批次」再导入图片(批次绑团号表,识别完自动出团号模式)')
    return
  }
  if (!agentName) {
    setCustomerError('请输入代理/客户标识')
    return
  }
  if (!files.length) {
    setCustomerError('请选择或拖入客户图片')
    return
  }
  rememberAgentName(agentName)
  // 快照当下的工作区/批次/自动识别开关:入队后操作员切区、换批次都不影响已入队项
  uploadQueue.enqueue({
    agentName,
    files,
    workspaceKey: customer.activeWorkspace,
    batchId: activeBatchId.value,
    autoPreprocess: autoPreprocess.value,
  })
  clearFileInput(customerFiles)
  createFilesBuffer.value = []
  customer.setMessage(`已入队:「${agentName}」${files.length} 张图后台上传中——可继续录下一个客户,进度见下方「上传队列」`)
}

function queueStatusLabel(item) {
  return {
    queued: '排队中',
    uploading: `上传中 ${item.progress || 0}%`,
    recognizing: '识别中',
    done: '完成',
    failed: '失败',
  }[item.status] || item.status
}

// 查看原图(0727反馈#1):失败/排队/在传项 File 还在手 → objectURL 弹层预览,
// 上传失败当场看到"丢的是哪几张",不用回相册翻;关弹层即 revoke,不漏内存。
// done 项 File 已释放(内存红线)→ 点「在看板找」用客户号定位到下方看板(原图在客户卡里)。
const uqPreview = ref(null) // { agentName, urls: [{ url, name }] }
function openQueuePreview(item) {
  const files = uploadQueue.filesOf(item.id)
  if (!files.length) return
  uqPreview.value = {
    agentName: item.agentName,
    urls: files.map((f) => ({ url: URL.createObjectURL(f), name: f.name || '' })),
  }
}
function closeQueuePreview() {
  for (const u of uqPreview.value?.urls || []) URL.revokeObjectURL(u.url)
  uqPreview.value = null
}
onUnmounted(closeQueuePreview)
function locateQueueCustomer(item) {
  if (!item.customerId) return
  boardSearch.value = item.customerId
  boardFilter.value = 'all' // 状态筛选可能把它藏住,定位必须全量
  document.querySelector('.cl-board')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 歧义失败(超时,服务端可能已建档)重试加硬闸:重复建档不可逆,只靠红字文案拦不住高峰期的手
function retryQueueItem(item) {
  if (item.ambiguous && !window.confirm(
    `「${item.agentName}」上次是超时失败——服务端可能已经建档成功。\n\n请先在下方客户看板刷新核对:若已有这个客户,请点「移除」别重试(重传会建重复客户)。\n\n已核对确认看板里没有,继续重试?`,
  )) return
  uploadQueue.retry(item.id)
}

function ensurePreprocessPolling() {
  if (preprocessPollTimer) return
  preprocessPollTimer = window.setInterval(async () => {
    // uploadQueue.summary.active:队列走裸 api 不设 actionLoading,识别中的看板刷新
    // 靠这一条入闸(识别落定另有 onPreprocessSettled 即刷,这里是轮询兜底,复核 H1)
    const shouldPoll = preprocessProgress.value.running
      || customer.actionLoading === 'workspace-preprocess'
      || customer.actionLoading.startsWith('customer-preprocess')
      || uploadQueue.summary.active > 0
    if (!shouldPoll || !customer.activeWorkspace || customer.loading) return
    try {
      await customer.loadCustomers(customer.activeWorkspace)
    } catch {
      // Keep the progress panel best-effort; normal API errors are shown by the store.
    }
  }, 1500)
}

async function deleteCustomerById(customerId, label = '') {
  if (!customerId) {
    return
  }
  const name = label || customerId
  if (!window.confirm(`确认删除客户目录「${name}」？`)) {
    return
  }
  await customer.deleteCustomer(customerId)
}

async function deleteActiveWorkspace() {
  if (!customer.activeWorkspace) {
    return
  }
  if (!window.confirm(`确认删除工作区 ${customer.activeWorkspace}？`)) {
    return
  }
  await customer.deleteActiveWorkspace()
  forms.workspaceKey = customer.activeWorkspace
}

// importWorkspace 已删:旧「整工作区导入」入口遗骸(新建批次流程 75287ea 接管后模板无引用),lint 清理确认

async function appendWorkspace() {
  if (!forms.workspaceAppendBatchId) {
    setCustomerError('请选择目标批次')
    return
  }
  await customer.appendWorkspaceToBatch(forms.workspaceAppendBatchId)
  await workbench.fetchBatches()
}

const deletingBatch = ref(false)
// 删除审核批次。注意:删除只清 OCR 工作台侧(批次目录+SQLite投影),
// **已桥接进月度台账的数据不会被删**(台账行只带 source_batch_id 标记来源);
// 但删除后该批台账行溯源断链(原图找不回),交付时客户图片包会缺这批图。
async function deleteSelectedBatch() {
  const batchId = forms.workspaceAppendBatchId
  if (!batchId || deletingBatch.value) return
  const batch = workbench.batches.find((b) => (b.id || b.batchId) === batchId)
  const label = batch?.name || batchId
  if (!window.confirm(
    `删除批次「${label}」？\n\n`
    + '· 批次内未审核完的图片与任务会被删除,不可恢复\n'
    + '· 已批准并桥接进月度台账的数据【保留】,对账不受影响\n'
    + '· 但该批台账行将无法溯源回原图,交付时客户图片包会缺这批图\n'
  )) return
  deletingBatch.value = true
  try {
    await deleteBatchApi(batchId)
    forms.workspaceAppendBatchId = ''
    await workbench.fetchBatches()
    customer.setMessage(`已删除批次 ${label}`)
  } catch (error) {
    setCustomerError(error?.response?.data?.error || error?.message || '删除批次失败')
  } finally {
    deletingBatch.value = false
  }
}

watch(() => forms.agentName, (value) => rememberAgentName(value))

onMounted(bootstrap)
onUnmounted(() => {
  if (preprocessPollTimer) {
    window.clearInterval(preprocessPollTimer)
    preprocessPollTimer = null
  }
})
</script>

<template>
  <section class="page-title">
    <div>
      <h1>客户建档</h1>
      <p>按代理建目录，上传客户图片；识别完成后自动进入审核批次。</p>
    </div>
    <div class="page-actions">
      <button class="ghost-button" type="button" :disabled="customer.loading" @click="bootstrap">
        {{ customer.loading ? '刷新中' : '刷新' }}
      </button>
      <!-- 去审核(0728工作流#1):建档收完图的下一步就是审核——右上角给明确的工作流出口。
           有当前批次直达该批次;没有则进审核台自选。描边蓝=可点导航,不与页内主动作抢实心位。 -->
      <button
        class="outline-primary"
        type="button"
        :title="activeBatchId ? '打开当前审核批次的审核台' : '打开审核台(未选当前批次,进去后自选)'"
        @click="router.push(activeBatchId ? `/review/${activeBatchId}` : '/review/latest')"
      >
        去审核 →
      </button>
    </div>
  </section>

  <section v-if="customer.error || customer.message" class="notice-panel">
    <span v-if="customer.error" class="error-text">{{ customer.error }}</span>
    <span v-else class="success-text">{{ customer.message }}</span>
  </section>

  <!-- 当前工作上下文(2026-07-29 用户拍板方案B:工作区行与批次行融合成一张卡)。
       工作区与批次本是同一件事的两级——「在哪收图 → 收的图进哪个批次」,分成两条独立
       横条时这层先后关系全靠猜,且两条形态还不一致(工作区裸下拉+常驻新建输入框、
       批次是标签+收起式新建)。融合后:
         · 视觉重点唯一 = 这张卡就是"我现在在哪儿干活",两级用缩进+↓画出从属;
         · **新建入口全页只剩一个**「+ 新建 ▾」(工作区/批次两项),与"当前"彻底分离,
           新员工不会再把"新建"当成"切换";破坏性的删除收进「⋯」。 -->
  <section class="cl-context">
    <div class="cl-ctx-head">
      <strong class="cl-ctx-title">当前工作上下文</strong>
      <div class="cl-ctx-actions">
        <MoreMenu label="+ 新建">
          <button type="button" @click="openNewPanel('workspace')">新建工作区</button>
          <button type="button" @click="openNewPanel('batch')">新建批次</button>
        </MoreMenu>
        <MoreMenu label="⋯">
          <button
            type="button"
            class="danger"
            :disabled="customer.actionLoading === 'workspace-delete' || !hasWorkspace"
            @click="deleteActiveWorkspace"
          >
            删除当前工作区
          </button>
        </MoreMenu>
      </div>
    </div>

    <!-- 第一级:工作区(在哪收图) -->
    <div class="cl-ctx-row">
      <span class="cl-ctx-label">工作区</span>
      <select v-model="customer.activeWorkspace" class="cl-ctx-select" aria-label="当前工作区" @change="changeWorkspace">
        <option value="" disabled>选择工作区</option>
        <option v-for="workspace in customer.workspaces" :key="workspace" :value="workspace">{{ workspace }}</option>
      </select>
      <span v-if="hasCustomers" class="cl-ctx-meta">
        <span class="cl-chip">{{ workspaceReadinessSummary.total }} 客户</span>
        <span class="cl-chip ok" title="已经进入审核批次的客户">{{ workspaceReadinessSummary.inReview }} 已进审核</span>
        <span v-if="boardCounts.processing" class="cl-chip warn">{{ boardCounts.processing }} 处理中</span>
        <span v-if="workspaceReadinessSummary.blocked" class="cl-chip bad">{{ workspaceReadinessSummary.blocked }} 异常</span>
      </span>
    </div>

    <!-- 第二级:批次(收的图进哪儿)——缩进 + ↓ 表达从属 -->
    <div class="cl-ctx-row cl-ctx-row--child">
      <span class="cl-ctx-arrow" aria-hidden="true">↓</span>
      <span class="cl-ctx-label">批次</span>
      <select v-model="activeBatchId" class="cl-ctx-select" aria-label="选择审核批次" @change="onActiveBatchChange">
        <option value="">未选择</option>
        <optgroup v-for="g in groupedBatches" :key="g.key" :label="g.label">
          <option v-for="b in g.items" :key="b.id || b.batchId" :value="b.id || b.batchId">{{ batchOptionLabel(b) }}</option>
        </optgroup>
      </select>
      <span class="cl-ctx-meta">
        <span v-if="activeBatchValid" class="cl-chip ok">建档自动进此批次,不用再点导入</span>
        <span v-else-if="activeBatchId" class="cl-chip bad">当前批次已不存在(被删?)—— 请重选或新建</span>
        <span v-else class="muted">未选 —— 选一个已有批次,或右上「+ 新建」</span>
      </span>
    </div>

    <!-- 新建工作区:从「+ 新建」菜单点开才出现(原来是常驻输入框,与"当前"混在一起) -->
    <div v-if="showNewWorkspace" class="cl-ctx-new">
      <span class="cl-ctx-new-label">新建工作区</span>
      <input v-model="forms.workspaceKey" class="cl-ws-new" placeholder="新工作区名称">
      <button class="primary-button small" type="button" :disabled="customer.actionLoading === 'workspace-create'" @click="createWorkspace">确认新建</button>
      <button class="ghost-button small" type="button" @click="showNewWorkspace = false">取消</button>
    </div>

    <!-- 新建批次:同上,点开才出现 -->
    <div v-if="showNewBatch" class="cl-ctx-new">
      <span class="cl-ctx-new-label">新建批次</span>
      <input v-model="newBatchName" class="cl-bb-name" placeholder="新批次名(留空自动)">
      <input ref="newBatchGroupCodeInput" type="file" accept=".xlsx,.xls" class="cl-file-hidden" @change="onNewBatchGroupCodeChange">
      <button class="ghost-button small" type="button" @click="pickNewBatchGroupCode">{{ newBatchGroupCodeName ? '✓ ' + newBatchGroupCodeName : '选团号表 .xlsx' }}</button>
      <button class="primary-button small" type="button" :disabled="creatingBatch" @click="createEmptyBatch">{{ creatingBatch ? '新建中…' : '确认新建' }}</button>
      <!-- 取消必须走 toggleNewBatch:它带表单重置(防"选了团号表A→取消→再新建仍挂着A"的误绑) -->
      <button class="ghost-button small" type="button" @click="toggleNewBatch">取消</button>
      <span class="muted">新建后自动成为当前批次</span>
    </div>

    <!-- 卡住才出现的提示(2026-07-27 用户拍板:界面不出现「同步」这个词)。
         识别完成的客户本该自动进审核批次,前提是选了当前批次。没选就会一直堆在这儿进不去
         —— 这是真出过事的失败模式,所以不能不报,但它是**异常提示**不是常驻页签:
         正常时 pendingSync 恒为 0,这条根本不渲染。文案直接给处置动作,不讲管道术语。 -->
    <p v-if="hasCustomers && workspaceReadinessSummary.pendingSync" class="cl-stuck-hint">
      有 {{ workspaceReadinessSummary.pendingSync }} 个客户已识别完成、但还没进审核批次
      —— <strong>还没选「批次」</strong>,在上面选一个就会自动进去。
    </p>
    <!-- 团号表重传 input:必须挂在 showNewBatch 之外(建好批次表单就收起了),
         否则失败横幅里的「重新选团号表」按下去 ref 是 null,静默无反应。 -->
    <input ref="gcRetryInput" type="file" accept=".xlsx,.xls" class="cl-file-hidden" @change="onGcRetryChange">
    <!-- 团号表后台上传进度:批次已秒建,团号表在后台传/解析,期间可正常建档 -->
    <div v-if="gcUpload.phase" class="cl-bb-line cl-gc-progress">
      <template v-if="gcUpload.phase === 'uploading'">
        <span class="cl-chip">团号表「{{ gcUpload.name }}」上传中 {{ gcUpload.pct }}%</span>
        <span class="cl-gc-bar"><i :style="{ width: gcUpload.pct + '%' }" /></span>
        <span class="muted">可同时建档,不用等</span>
      </template>
      <template v-else-if="gcUpload.phase === 'parsing'">
        <span class="cl-chip">团号表上传完成,后台解析中…</span>
        <span class="muted">解析好后此批次才能结算出团号模式</span>
      </template>
      <template v-else-if="gcUpload.phase === 'ready'">
        <span class="cl-chip ok">团号表就绪 ✓</span>
      </template>
      <template v-else-if="gcUpload.phase === 'failed'">
        <span class="cl-chip bad">团号表上传/解析失败,请重传</span>
        <button class="ghost-button small" type="button" @click="pickGcRetry">重新选团号表</button>
      </template>
    </div>
  </section>

  <!-- 收图建档(一行) -->
  <section class="cl-intake">
    <div
      class="dropzone cl-dropzone"
      :class="{ active: createDragActive, filled: createFilesBuffer.length > 0 }"
      @dragenter.prevent="createDragActive = true"
      @dragover.prevent="createDragActive = true"
      @dragleave.prevent="createDragActive = false"
      @drop="handleCreateDrop"
    >
      <template v-if="createFilesBuffer.length === 0">
        <p><strong>拖入客户图</strong> 或 <input ref="customerFiles" type="file" multiple accept="image/*,.heic,.heif"></p>
        <p class="muted">jpg / png / webp / heic，可多选</p>
        <p v-if="!activeBatchValid" class="muted" style="color:#b45309;">⚠ 未选当前审核批次 —— 需先建/选批次(绑团号表)才能建档</p>
      </template>
      <template v-else>
        <p class="muted">已选 {{ createFilesBuffer.length }} 张</p>
        <ul class="file-chips">
          <li v-for="(f, idx) in createFilesBuffer" :key="idx"><span>{{ f.name }}</span><button type="button" class="chip-x" @click="removeCreateFile(idx)">×</button></li>
        </ul>
        <button type="button" class="ghost-button small" @click="createFilesBuffer = []">清空</button>
      </template>
    </div>
    <div class="cl-intake-form">
      <input v-model="forms.agentName" type="text" placeholder="代理 / 客户标识">
      <label class="cl-auto"><input v-model="autoPreprocess" type="checkbox"> 上传后自动识别</label>
      <button
        class="primary-button" type="button"
        :disabled="!hasWorkspace || !activeBatchValid"
        :title="!activeBatchValid ? '请先建立/选择当前审核批次' : ''"
        @click="createCustomer"
      >
        建档<template v-if="uploadQueue.summary.pending > 0">(队列 {{ uploadQueue.summary.pending }})</template>
      </button>
    </div>
    <p v-if="!hasWorkspace" class="muted cl-hint">请先选择或新建工作区</p>
    <p v-else-if="!activeBatchValid" class="muted cl-hint" style="color:#b45309;">先在上方「当前审核批次」选择或新建批次,才能收图建档</p>
  </section>

  <!-- 上传队列(T6-B):点建档即入队,后台按序上传;失败/进度全部可见,不清人不丢 -->
  <section v-if="uploadQueue.items.length" class="panel uq-panel">
    <div class="uq-head">
      <strong>上传队列</strong>
      <span class="muted">
        待传 {{ uploadQueue.summary.pending }}
        <template v-if="uploadQueue.summary.failed > 0"> · <span class="danger-text">失败 {{ uploadQueue.summary.failed }}</span></template>
      </span>
      <span v-if="uploadQueue.summary.pending > 0" class="muted uq-tip">后台按序上传中,可继续录下一个客户;传完前别关页面</span>
      <button type="button" class="ghost-button small" @click="uploadQueue.clearFinished()">清除已完成</button>
    </div>
    <ul class="uq-list">
      <li v-for="item in uploadQueue.items" :key="item.id" class="uq-item" :class="`uq-${item.status}`">
        <span class="uq-name">{{ item.agentName }}</span>
        <span class="muted">{{ item.fileCount }} 张</span>
        <span
          class="uq-status" :class="{
            'status warning': item.status === 'uploading' || item.status === 'recognizing',
            'status success': item.status === 'done',
            'status danger': item.status === 'failed',
          }"
        >{{ queueStatusLabel(item) }}</span>
        <span v-if="item.status === 'uploading'" class="uq-track" aria-hidden="true"><span class="uq-fill" :style="{ width: `${item.progress || 0}%` }" /></span>
        <span v-if="item.status === 'done' && item.note" class="uq-note status warning">{{ item.note }}</span>
        <span v-if="item.status === 'failed'" class="uq-error danger-text">{{ item.error }}</span>
        <!-- 0727#1 找回:File 在手(排队/在传/失败)→ 直接预览原图;已建档 → 用客户号定位看板 -->
        <button
          v-if="['queued', 'uploading', 'failed'].includes(item.status) && item.fileCount > 0"
          type="button" class="ghost-button small"
          :title="item.status === 'failed' ? '看看失败的是哪几张图' : '预览这批待传的原图'"
          @click="openQueuePreview(item)"
        >
          查看原图
        </button>
        <button
          v-else-if="item.customerId"
          type="button" class="ghost-button small"
          title="用客户号定位到下方客户看板(原图在客户卡里)"
          @click="locateQueueCustomer(item)"
        >
          在看板找
        </button>
        <button v-if="item.status === 'failed'" type="button" class="ghost-button small" @click="retryQueueItem(item)">{{ item.ambiguous ? '核对后重试' : '重试' }}</button>
        <button v-if="item.status === 'failed' || item.status === 'queued'" type="button" class="ghost-button small" @click="uploadQueue.remove(item.id)">移除</button>
      </li>
    </ul>
    <!-- 原图预览弹层(0727#1):objectURL 网格,关即 revoke -->
    <div v-if="uqPreview" class="uq-preview-mask" @click.self="closeQueuePreview">
      <div class="uq-preview" role="dialog" :aria-label="`${uqPreview.agentName} 的原图`">
        <div class="uq-preview-head">
          <strong>{{ uqPreview.agentName }}</strong>
          <span class="muted">{{ uqPreview.urls.length }} 张(本机原件,未经上传)</span>
          <button type="button" class="ghost-button small" @click="closeQueuePreview">关闭</button>
        </div>
        <div class="uq-preview-grid">
          <figure v-for="u in uqPreview.urls" :key="u.url">
            <a :href="u.url" target="_blank" rel="noopener" :title="`新窗口看大图:${u.name}`">
              <img :src="u.url" :alt="u.name" loading="lazy">
            </a>
            <figcaption class="muted">{{ u.name }}</figcaption>
          </figure>
        </div>
      </div>
    </div>
  </section>

  <!-- 上传 / 识别进度(仅进行时显示) -->
  <section v-if="customer.uploadProgress.active || preprocessProgress.running || preprocessProgress.total > 0" class="cl-progress">
    <div v-if="customer.uploadProgress.active" class="preprocess-progress-card">
      <div class="preprocess-progress-head">
        <div>
          <strong>{{ customer.uploadProgress.message || '上传图片' }}</strong>
          <span class="muted">{{ customer.uploadProgress.fileCount || createFilesBuffer.length || fileList(customerFiles).length }} 张</span>
        </div>
        <span :class="uploadProgressStatusClass">{{ uploadProgressStatusLabel }}</span>
      </div>
      <div class="preprocess-progress-track" aria-hidden="true">
        <div class="preprocess-progress-fill" :style="{ width: `${customer.uploadProgress.percent || 0}%` }" />
      </div>
    </div>
    <div v-if="preprocessProgress.running || preprocessProgress.total > 0" class="preprocess-progress-card">
      <div class="preprocess-progress-head">
        <div>
          <strong>{{ preprocessProgressTitle }}</strong>
          <span v-if="preprocessProgress.currentCustomer" class="muted">当前：{{ preprocessProgress.currentCustomer }}</span>
        </div>
        <span :class="preprocessProgressStatusClass">{{ preprocessProgress.current }}/{{ preprocessProgress.total }}</span>
      </div>
      <div class="preprocess-progress-track" aria-hidden="true">
        <div class="preprocess-progress-fill" :style="{ width: `${preprocessProgress.percent}%` }" />
      </div>
      <div class="preprocess-progress-meta">
        <span>完成 {{ preprocessProgress.percent }}%</span>
        <span>生成 {{ preprocessProgress.output }} 张</span>
        <span>切出 {{ preprocessProgress.split }} 张</span>
        <span v-if="preprocessProgress.warning > 0" class="status warning">低置信度 {{ preprocessProgress.warning }} 张</span>
        <span v-if="preprocessProgress.failed > 0" class="danger-text">失败 {{ preprocessProgress.failed }} 张</span>
      </div>
    </div>
  </section>

  <!-- 客户看板:筛选 + 搜索 + 紧凑行(支撑 200+) -->
  <section class="panel cl-board">
    <div class="cl-section-toggle" @click="collapsed.board = !collapsed.board">
      <span class="cl-caret" :class="{ open: !collapsed.board }">▸</span>
      <strong>客户看板</strong>
      <span class="muted">{{ boardCounts.all }} 客户</span>
    </div>
    <div v-show="!collapsed.board">
      <div class="cl-board-head">
        <div class="cl-filters" role="tablist" aria-label="客户筛选">
          <button type="button" :class="{ on: boardFilter === 'all' }" @click="boardFilter = 'all'">全部 <em>{{ boardCounts.all }}</em></button>
          <button type="button" class="bad" :class="{ on: boardFilter === 'blocked' }" @click="boardFilter = 'blocked'">异常 <em>{{ boardCounts.blocked }}</em></button>
          <button type="button" class="warn" :class="{ on: boardFilter === 'processing' }" @click="boardFilter = 'processing'">处理中 <em>{{ boardCounts.processing }}</em></button>
          <!-- 2026-07-27 用户拍板:三桶穷尽且只讲业务——异常 / 处理中(没完成的都在这) / 已完成。
             不再出现「可同步/就绪」这类管道说法:同步是全自动的,操作员看了也没法动手。 -->
          <button type="button" class="ok" :class="{ on: boardFilter === 'ready' }" title="图片已识别完成的客户" @click="boardFilter = 'ready'">已完成 <em>{{ boardCounts.ready }}</em></button>
        </div>
        <input v-model="boardSearch" type="text" class="cl-search" placeholder="搜代理 / 客户号">
      </div>
      <div v-if="!preprocessCustomerRows.length" class="empty">暂无客户目录</div>
      <div v-else-if="!boardRows.length" class="empty">当前筛选下没有客户</div>
      <template v-else>
        <section v-for="(bucket, bi) in boardRowsByDate" :key="bucket.date" class="cl-date-bucket">
          <div class="cl-date-head" @click="toggleDateBucket(bucket.date, bi)">
            <span class="cl-caret" :class="{ open: isDateOpen(bucket.date, bi) }">▸</span>
            <strong>{{ bucket.date }}</strong>
            <span class="muted">{{ bucket.rows.length }} 客户</span>
          </div>
          <ul v-if="isDateOpen(bucket.date, bi)" class="cl-rows">
            <li
              v-for="row in bucket.rows"
              :key="row.id"
              class="cl-row"
              :class="{ active: selectedCustomerId === row.id }"
              @click="customer.selectedCustomerId = row.id"
            >
              <span class="cl-dot" :class="row.stage.tone" aria-hidden="true" />
              <div class="cl-row-main">
                <div class="cl-row-name"><strong>{{ row.name }}</strong> <span class="muted">{{ row.id }}</span></div>
                <div class="cl-row-sub muted">{{ row.readiness.label }} · {{ row.readiness.hint }}</div>
              </div>
              <div class="cl-stage" aria-hidden="true">
                <template v-for="(label, i) in ['收图', '识别', '就绪', '审核']" :key="label">
                  <span
                    class="cl-stage-dot"
                    :class="{ done: i < row.stage.index, [row.stage.tone]: i === row.stage.index, cur: i === row.stage.index }"
                  >{{ label }}</span>
                  <span v-if="i < 3" class="cl-stage-ln" :class="{ done: i < row.stage.index }" />
                </template>
              </div>
              <span class="cl-imgs muted">{{ row.imageCount }} 图<template v-if="row.splitCount"> · 切{{ row.splitCount }}</template></span>
              <span class="cl-ops" @click.stop>
                <button
                  v-if="row.reviewBatchId"
                  class="cl-op cl-op-review"
                  type="button"
                  title="去审核台审这一个客户"
                  @click="goReviewCustomer(row)"
                >审核</button>
                <button class="cl-op" type="button" title="重新识别(完成后新切片自动回灌到原批次)" :disabled="customer.actionLoading === `customer-preprocess:${row.id}`" @click="reprocessOne(row.id)">{{ customer.actionLoading === `customer-preprocess:${row.id}` ? '识别中…' : '重识别' }}</button>
                <button class="cl-op" type="button" title="补图" @click="appendImagesTo(row.id)">补图</button>
                <button class="cl-op danger" type="button" title="删除" :disabled="customer.actionLoading === `customer-delete:${row.id}`" @click="deleteCustomerById(row.id, row.name)">删</button>
              </span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </section>

  <!-- 批次管理(低频):选一个批次做 兜底补进 / 删除。全站唯一的批次删除入口在这里。 -->
  <section class="panel cl-import">
    <div class="panel-header cl-section-toggle" @click="collapsed.importPanel = !collapsed.importPanel">
      <strong><span class="cl-caret" :class="{ open: !collapsed.importPanel }">▸</span> 批次管理(低频)</strong>
      <span class="count">{{ workbench.batches.length }} 个批次</span>
    </div>
    <div v-show="!collapsed.importPanel" class="panel-body">
      <!-- 2026-07-26 口径澄清:新建已挪到顶部;这里只剩两件低频事——
           ①兜底补进:正常情况选了当前批次就会自动进去,这个按钮只是没自动进成时的**兜底重试**;
           ②删除批次:全站唯一的批次删除入口,必须留。 -->
      <div class="field">
        <label>选择批次</label>
        <select v-model="forms.workspaceAppendBatchId">
          <option value="" disabled>选择批次</option>
          <optgroup v-for="g in groupedBatches" :key="g.key" :label="g.label">
            <option v-for="batch in g.items" :key="batch.id || batch.batchId" :value="batch.id || batch.batchId">
              {{ batchOptionLabel(batch) }}
            </option>
          </optgroup>
        </select>
        <p class="muted">选中批次后,可对它做下面两件事(平时都用不到)。</p>
      </div>
      <div class="action-row">
        <button
          class="ghost-button"
          type="button"
          :title="'兜底重试:正常建档完会自动进当前批次,只有没自动进去时才需要手点'"
          :disabled="customer.actionLoading === 'workspace-append' || !forms.workspaceAppendBatchId"
          @click="appendWorkspace"
        >
          补进当前批次(兜底)
        </button>
        <button
          class="ghost-button danger"
          type="button"
          data-testid="delete-batch"
          :disabled="deletingBatch || !forms.workspaceAppendBatchId"
          @click="deleteSelectedBatch"
        >
          {{ deletingBatch ? '删除中…' : '删除选中批次' }}
        </button>
      </div>
      <p class="muted">按来源去重,不会重复导入;已在别的批次的客户不会被吸过来。</p>
      <p class="muted">删除批次只清审核台；已桥接进月度台账的数据保留，但该批台账行将无法溯源回原图。</p>
    </div>
  </section>

  <input ref="appendFilesInput" type="file" multiple accept="image/*,.heic,.heif" style="display: none" @change="handleAppendFiles">
</template>

<style scoped>
/* 当前工作上下文卡(2026-07-29 方案B):工作区/批次两级同卡,右上唯一新建入口
   (旧 .cl-topbar / .cl-batchbar 两条横条样式随融合一并删除) */
.cl-context {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 14px 12px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cl-ctx-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cl-ctx-title { font-size: 13px; color: var(--muted); font-weight: 500; }
.cl-ctx-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.cl-ctx-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
/* 第二级缩进 + ↓:把「工作区 → 批次」的从属关系画出来,不靠人猜 */
.cl-ctx-row--child { padding-left: 18px; }
.cl-ctx-arrow { color: #cbd5e1; font-size: 13px; margin-left: -14px; }
.cl-ctx-label { font-size: 13px; color: var(--muted); flex: none; min-width: 42px; }
.cl-ctx-select { min-width: 260px; max-width: 420px; flex: 1; font-size: 14px; }
.cl-ctx-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.cl-ctx-meta .muted { font-size: 12px; }
/* 新建面板:虚线分隔+浅底,与「当前」彻底分家(点开才出现) */
.cl-ctx-new {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border-top: 1px dashed var(--line); padding-top: 10px; margin-top: 2px;
}
.cl-ctx-new-label { font-size: 12px; color: var(--muted); flex: none; }
.cl-ws-new { width: 160px; }
.cl-bb-name { width: 200px; }
.cl-bb-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 卡住提示:琥珀色单行,只在真卡住时出现 */
.cl-stuck-hint { margin: 6px 0 0; font-size: 12px; color: #b54708; line-height: 1.6; }
.cl-chip { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--surface-soft); color: var(--muted); }
.cl-chip.ok { background: #f1f5f9; color: var(--success); }
.cl-chip.warn { background: #fff4dd; color: var(--warning); }
.cl-chip.bad { background: #fce4e4; color: var(--danger); }
.cl-gc-progress { border-top: 1px dashed var(--line); padding-top: 8px; }
.cl-gc-bar { flex: 1; min-width: 120px; max-width: 260px; height: 6px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.cl-gc-bar i { display: block; height: 100%; background: var(--accent, #2f6df6); transition: width 0.2s ease; }
.cl-intake {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  margin-bottom: 12px;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
}
.cl-dropzone { flex: 1; min-width: 240px; margin: 0; padding: 10px 14px; }
.cl-intake-form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cl-intake-form input[type="text"] { width: 160px; }
.cl-auto { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); white-space: nowrap; }
.cl-hint { width: 100%; margin: 0; }
.cl-progress { display: grid; gap: 10px; margin-bottom: 12px; }
.uq-panel { margin-bottom: 12px; padding: 10px 14px; }
.uq-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.uq-head .ghost-button { margin-left: auto; }
.uq-tip { font-size: 12px; }
.uq-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.uq-item { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
.uq-item.uq-failed { border-color: #fca5a5; background: #fef2f2; }
.uq-item.uq-done { opacity: 0.75; }
.uq-name { font-weight: 500; }
.uq-status { white-space: nowrap; }
.uq-track { flex: 1; min-width: 80px; max-width: 220px; height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
.uq-fill { display: block; height: 100%; border-radius: 999px; background: #f59e0b; transition: width 200ms ease; }
.uq-error, .uq-note { flex-basis: 100%; font-size: 12px; }
/* 原图预览弹层(0727#1) */
.uq-preview-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; }
.uq-preview { background: #fff; border-radius: 12px; max-width: 860px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; padding: 14px 16px; box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25); }
.uq-preview-head { display: flex; align-items: center; gap: 10px; }
.uq-preview-head .ghost-button { margin-left: auto; }
.uq-preview-grid { margin-top: 10px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.uq-preview-grid figure { margin: 0; }
.uq-preview-grid img { width: 100%; height: 130px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); display: block; }
.uq-preview-grid figcaption { font-size: 11px; word-break: break-all; margin-top: 2px; }
.cl-board { margin-bottom: 12px; }
.cl-board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.cl-filters { display: flex; gap: 16px; }
.cl-filters button { border: none; background: none; padding: 6px 2px; font-size: 13px; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; }
.cl-filters button.on { color: var(--text); border-bottom-color: var(--text); }
.cl-filters button.ok.on { color: var(--success); border-bottom-color: var(--success); }
.cl-filters button.warn.on { color: var(--warning); border-bottom-color: var(--warning); }
.cl-filters button.bad.on { color: var(--danger); border-bottom-color: var(--danger); }
.cl-filters em { font-style: normal; opacity: 0.6; margin-left: 3px; }
.cl-search { width: 180px; }
.cl-rows { list-style: none; margin: 0; padding: 0; }
.cl-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.cl-row:last-child { border-bottom: none; }
.cl-row:hover { background: var(--surface-soft); }
.cl-row.active { background: var(--accent-weak); box-shadow: inset 3px 0 0 var(--accent); }
.cl-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
.cl-dot.success { background: var(--success); }
.cl-dot.warning { background: var(--warning); }
.cl-dot.danger { background: var(--danger); }
.cl-row-main { flex: 1; min-width: 0; }
.cl-row-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-row-sub { font-size: 11px; }
.cl-stage { display: flex; align-items: center; gap: 4px; }
.cl-stage-dot { font-size: 10px; color: var(--muted); padding: 2px 7px; border-radius: 999px; background: var(--surface-soft); white-space: nowrap; }
.cl-stage-dot.done { color: var(--success); background: #f1f5f9; }
.cl-stage-dot.cur.success { color: var(--success); background: #f1f5f9; }
.cl-stage-dot.cur.warning { color: var(--warning); background: #fff4dd; }
.cl-stage-dot.cur.danger { color: var(--danger); background: #fce4e4; }
.cl-stage-ln { width: 10px; height: 2px; background: var(--line-strong); }
.cl-stage-ln.done { background: var(--success); }
.cl-imgs { font-size: 12px; white-space: nowrap; }
.cl-ops { display: flex; gap: 6px; }
.cl-op { border: 1px solid var(--line-strong); background: #fff; border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 500; color: var(--text); cursor: pointer; }
.cl-op:hover { background: var(--surface-soft); }
.cl-op.danger { color: var(--danger); }
.cl-op-review { background: var(--accent, #2563eb); color: #fff; border-color: var(--accent, #2563eb); }
.cl-op-review:hover { filter: brightness(0.94); background: var(--accent, #2563eb); }
.cl-op:disabled { opacity: 0.5; cursor: not-allowed; }
.cl-file-hidden { display: none; }
.cl-section-toggle { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; user-select: none; }
.cl-section-toggle:hover { background: var(--surface-soft); }
.cl-section-toggle .status { margin-left: auto; }
.cl-caret { display: inline-block; font-size: 11px; color: var(--muted); transition: transform 0.15s; }
.cl-caret.open { transform: rotate(90deg); }
.cl-file-pick { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.cl-file-name { font-size: 13px; color: var(--success); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-import-more { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 6px; }
.cl-import-more summary { cursor: pointer; font-size: 13px; font-weight: 500; color: var(--muted); padding: 6px 0; }
.cl-import-more summary:hover { color: var(--text); }
@media (max-width: 720px) {
  .cl-stage { display: none; }
}

/* 看板按日期折叠 */
.cl-date-head { display: flex; align-items: center; gap: 8px; padding: 7px 8px; cursor: pointer; border-bottom: 1px solid var(--line); background: var(--surface-soft); font-size: 13px; position: sticky; top: 0; z-index: 1; }
.cl-date-head:hover { background: #eef3fa; }
.cl-date-bucket + .cl-date-bucket { margin-top: 2px; }
</style>
