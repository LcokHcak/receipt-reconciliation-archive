<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  activateConfigModeVersion,
  activateExportPlanVersion,
  deactivateConfigMode,
  deactivateExportPlan,
  deactivateReviewBase,
  deactivateStoreFields,
  executeExportPlan,
  fetchConfigModes,
  fetchConfigModeVersions,
  fetchExportPlans,
  fetchExportPlanVersions,
  fetchFieldRegistry,
  fetchModeConflicts,
  fetchReviewBases,
  fetchStoreProfiles,
  impactReviewBase,
  previewExportPlan,
  saveConfigMode,
  saveExportPlan,
  saveReviewBase,
  saveStoreFields,
  saveStoreBranchOptions,
} from '../api/configConsole'
import { planStoreSaveSnapshots } from '../lib/configConsoleSaveAll'
import { readConfigDeepLink } from '../lib/configConsoleDeepLink'
import { unmappedBranchCodes, branchSaveMessage } from '../lib/branchCodeMapping'
import { humanErrorMessage } from '../lib/errorMessage'
import LibraryCleanupView from './LibraryCleanupView.vue'
import { fetchWorkbenchState } from '../api/workbench'

// ── 单一导航:一列,按业务要干的事分 ──
const NAV = [
  { key: 'modes', label: '渠道模式', hint: '每个模式:台账记哪些列 + 审核审哪些字段' },
  { key: 'stores', label: '百货店', hint: '乐天/新世界/现代:审核审哪些字段' },
  { key: 'exports', label: '交付导出', hint: '给上家的文件夹/表格怎么整理' },
  { key: 'fields', label: '字段字典', hint: '系统认识哪些字段(只读)' },
  { key: 'cleanup', label: '库清理', hint: '清孤儿客户图片(批次已删库还留)' },
  { key: 'help', label: '帮助', hint: '规则说明' },
]
const nav = ref('modes')
const route = useRoute()

// 台账 8 列(与后端 mode_record_matrix columns 键一一对应,顺序=Excel 列序)
const COLUMN_DEFS = [
  { key: 'recordDate', label: '收票日期' },
  { key: 'agent', label: '代理' },
  { key: 'purchaseDate', label: '购买日期' },
  { key: 'receiptNo', label: '小票号' },
  { key: 'groupNo', label: '团号' },
  { key: 'name', label: '姓名' },
  { key: 'passportNo', label: '护照号' },
  { key: 'departureDate', label: '出境日期' },
]
const RECEIPT_NO_FORMS = [
  { value: '', label: '无特殊形态' },
  { value: 'digits13', label: '纯数字 13 位' },
  { value: 'digits14', label: '纯数字 14 位' },
  { value: 'dashed19', label: '带杠 19 位' },
  { value: 'letters14', label: '含字母 14 位' },
]
const ACTION_OPTIONS = ['及时发上家', '按团号单独整理', 'S活动红标签', '发12号']

const loading = ref(false)
const error = ref('')
const message = ref('')
const modes = ref([])
const unconfigured = ref([])
const selectedName = ref('')
const draft = ref(null)
const draftNote = ref('')
// G2(0724反馈):「审核审哪些字段」的说明默认收起,点【说明】才展开(大段文字不铺满全屏)
const showFieldsDoc = ref(false)
const saveWarnings = ref([])
const versions = ref([])
const versionsLoading = ref(false)
const saving = ref(false)
const newModeName = ref('')

const selectedMode = computed(() => modes.value.find((mode) => mode.name === selectedName.value) || null)
const effectivePayload = computed(() => selectedMode.value
  ? (selectedMode.value.config?.payload || selectedMode.value.factory)
  : null)
// 百货模式(2026-07-17 用户反馈"渠道模式里看百货没参考意义"):百货审核走店档案,
// 模式微调对它不生效(百货不走模式微调)——审核字段区换成跳转提示;台账列区照旧(结算真用)。
const DEPT_MODE_TO_FAMILY = Object.freeze({ 乐天百货: 'LOTTE_DEPT', 新世界百货: 'SHINSEGAE_DEPT', 现代百货: 'HYUNDAI_DEPT' })
const selectedDeptFamily = computed(() => DEPT_MODE_TO_FAMILY[selectedMode.value?.name] || '')
function goDeptStoreConfig() {
  const family = selectedDeptFamily.value
  if (!family) return
  selectedStoreFamily.value = family
  goNav('stores')
}

function setMessage(text) {
  message.value = text
  if (text) setTimeout(() => { if (message.value === text) message.value = '' }, 4000)
}

async function load(keepSelection = true) {
  loading.value = true
  error.value = ''
  try {
    const payload = await fetchConfigModes()
    modes.value = payload.modes || []
    unconfigured.value = payload.unconfigured || []
    if (!keepSelection || !modes.value.some((mode) => mode.name === selectedName.value)) {
      selectedName.value = modes.value[0]?.name || ''
    }
    rebuildDraft()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function rebuildDraft() {
  const base = effectivePayload.value
  if (!base) { draft.value = null; return }
  draft.value = {
    modeLabel: base.modeLabel || selectedMode.value?.label || selectedName.value,
    columns: { ...base.columns },
    receiptNoForm: base.receiptNoForm || '',
    actions: [...(base.actions || [])],
    note: base.note || '',
    groupNoLiteral: base.groupNoLiteral || '',
  }
  draftNote.value = ''
  saveWarnings.value = selectedMode.value?.warnings || []
  rebuildModeReviewDraft()
}

async function selectMode(name) {
  selectedName.value = name
  rebuildDraft()
  await loadVersions()
  await loadConflicts()
}

async function loadVersions() {
  if (!selectedName.value) { versions.value = []; return }
  versionsLoading.value = true
  try {
    const payload = await fetchConfigModeVersions(selectedName.value)
    versions.value = payload.versions || []
  } catch {
    versions.value = []
  } finally {
    versionsLoading.value = false
  }
}

function toggleAction(action) {
  if (!draft.value) return
  const idx = draft.value.actions.indexOf(action)
  if (idx >= 0) draft.value.actions.splice(idx, 1)
  else draft.value.actions.push(action)
}

async function save() {
  if (!draft.value || !selectedName.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const prevReview = selectedMode.value?.config?.payload?.review || {}
    const review = { ...prevReview }
    const relaxList = [...modeReviewDraft.value.relax]
    if (relaxList.length) review.relax = relaxList
    else delete review.relax
    if (modeReviewDraft.value.slim) review.slim = true
    else delete review.slim
    const result = await saveConfigMode(selectedName.value, {
      payload: {
        modeLabel: draft.value.modeLabel,
        columns: { ...draft.value.columns },
        receiptNoForm: draft.value.receiptNoForm,
        actions: [...draft.value.actions],
        note: draft.value.note,
        groupNoLiteral: draft.value.groupNoLiteral,
        ...(Object.keys(review).length ? { review } : {}),
      },
      expectBaseVersion: selectedMode.value?.config?.version || 0,
      note: draftNote.value,
    })
    saveWarnings.value = result.warnings || []
    setMessage(`已保存并生效:${selectedName.value} v${result.version}${result.warnings?.length ? '(有提醒,见下方)' : ''}`)
    await load()
    await loadVersions()
    await loadConflicts()
    return true
  } catch (err) {
    if (err?.response?.status === 409) {
      error.value = `${err.response.data?.error || '配置已被他人修改'} —— 已为你刷新,请核对后重新保存`
      await load()
      await loadVersions()
    } else {
      error.value = err?.response?.data?.error || err?.message || '保存失败'
    }
    return false
  } finally {
    saving.value = false
  }
}

async function rollbackTo(version) {
  if (!selectedName.value) return
  if (!window.confirm(`回滚 ${selectedName.value} 到 v${version}?回滚立即生效。`)) return
  try {
    await activateConfigModeVersion(selectedName.value, version)
    setMessage(`已回滚到 v${version}`)
    await load()
    await loadVersions()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '回滚失败'
  }
}

async function fallbackToFactory() {
  if (!selectedName.value) return
  if (!window.confirm(`停用「${selectedName.value}」的自定义配置,回到系统默认规则?\n历史版本保留,随时可从下方历史回滚回来。`)) return
  try {
    await deactivateConfigMode(selectedName.value)
    setMessage('已回到系统默认规则')
    await load()
    await loadVersions()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '操作失败'
  }
}

async function createMode(name) {
  const trimmed = String(name || newModeName.value || '').trim()
  if (!trimmed) return
  // 重名闸(审计 MEDIUM):已存在同名模式 → 不新建,直接切到它编辑。否则:后端乐观锁基版闸会 409
  //(41b0b1f),或历史上会静默把生效配置覆盖成「全记默认」。大小写/全角括号/尾巴/别名等归一后
  // 同名(前端无归一副本、不猜)由后端 409 兜底 → 下方 catch 给出走编辑的友好提示。
  const existing = modes.value.find((mode) => mode.name === trimmed)
  if (existing) {
    selectedName.value = existing.name
    rebuildDraft()
    newModeName.value = ''
    setMessage(`模式「${trimmed}」已存在,已切到它的编辑;如需改配置请在下方调整后保存`)
    return
  }
  try {
    const saved = await saveConfigMode(trimmed, {
      payload: {
        modeLabel: trimmed,
        columns: Object.fromEntries(COLUMN_DEFS.map((col) => [col.key, true])),
      },
      note: '配置台新建',
    })
    newModeName.value = ''
    setMessage(`已新建模式:${trimmed}(默认全记,可继续调整)`)
    await load()
    if (saved?.name && modes.value.some((mode) => mode.name === saved.name)) {
      selectedName.value = saved.name
      rebuildDraft()
    }
    await loadVersions()
  } catch (err) {
    if (err?.response?.status === 409) {
      // 归一后与现有模式撞名(大小写/括号/别名/尾巴):没新建也没覆盖,提示去编辑
      error.value = `模式「${trimmed}」归一后与已有模式同名,未新建也未改动;请在左侧列表找到它直接编辑`
    } else {
      error.value = err?.response?.data?.error || err?.message || '新建失败'
    }
  }
}

const recordSummary = computed(() => {
  if (!draft.value) return ''
  const on = COLUMN_DEFS.filter((col) => draft.value.columns[col.key]).map((col) => col.label)
  return on.length === COLUMN_DEFS.length ? '全记(8列)' : (on.length ? `只记:${on.join('、')}` : '一列不记')
})

// ── 导出计划 ──
const plans = ref([])
const selectedPlanName = ref('')
const planDraft = ref(null)
const planVersions = ref([])
const planNote = ref('')
const planSaving = ref(false)
const newPlanName = ref('')
const previewBatchId = ref('')
const previewBatches = ref([])
const previewResult = ref(null)
const previewLoading = ref(false)

const selectedPlan = computed(() => plans.value.find((p) => p.name === selectedPlanName.value) || null)
const planIsBuiltin = computed(() => selectedPlan.value?.kindType === 'builtin')

function rebuildPlanDraft() {
  const base = selectedPlan.value?.config?.payload || selectedPlan.value?.factory || null
  planNote.value = ''
  previewResult.value = null
  lastSaveDraftInfo.value = null
  planBaseVersion.value = selectedPlan.value?.config?.version || 0
  if (!base || base.builtin) { planDraft.value = null; return }
  planDraft.value = {
    planLabel: base.planLabel || selectedPlanName.value,
    scopeModes: (base.scope?.modes || []).join('、'),
    levels: [0, 1, 2].map((i) => base.levels?.[i]?.template || ''),
    naming: base.naming?.template || '{docLabel}{i}',
    includes: { receipt: base.includes?.includes('receipt') ?? true, passport: base.includes?.includes('passport') ?? false, other: base.includes?.includes('other') ?? false },
    emptyPolicy: base.emptyPolicy || 'block_prefix',
  }
  planExcelCols.value = new Set(base.excel?.columns || [])
  syncSkinsFromDraft()
}

async function loadPlans(keep = true) {
  try {
    const payload = await fetchExportPlans()
    plans.value = payload.plans || []
    if (payload.vocab) planVocab.value = payload.vocab
    if (!keep || !plans.value.some((p) => p.name === selectedPlanName.value)) {
      selectedPlanName.value = plans.value[0]?.name || ''
    }
    rebuildPlanDraft()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '导出计划加载失败'
  }
}

async function loadPlanVersions() {
  if (!selectedPlanName.value) { planVersions.value = []; return }
  try {
    const payload = await fetchExportPlanVersions(selectedPlanName.value)
    planVersions.value = payload.versions || []
    planBaseVersion.value = planVersions.value.reduce((m, v) => Math.max(m, v.version || 0), planBaseVersion.value)
  } catch { planVersions.value = [] }
}

async function selectPlan(name) {
  selectedPlanName.value = name
  rebuildPlanDraft()
  await loadPlanVersions()
}

// 内置计划目录:点左侧规则条 → 选中该计划 + 右侧滚到对应规则卡
async function selectPlanRule(name, i) {
  if (selectedPlanName.value !== name) await selectPlan(name)
  await nextTick()
  const el = document.getElementById(`spec-rule-${i}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function planPayloadFromDraft(label) {
  const levels = planDraft.value.levels.map((t) => String(t || '').trim()).filter(Boolean).map((template) => ({ template }))
  const includes = Object.entries(planDraft.value.includes).filter(([, on]) => on).map(([k]) => k)
  const scopeModes = String(planDraft.value.scopeModes || '').split(/[、,\s]+/).map((x) => x.trim()).filter(Boolean)
  return {
    planLabel: label || planDraft.value.planLabel || selectedPlanName.value,
    scope: { modes: scopeModes },
    levels,
    naming: { template: String(planDraft.value.naming || '').trim() },
    includes,
    emptyPolicy: planDraft.value.emptyPolicy,
  }
}

async function savePlan() {
  if (!planDraft.value || !selectedPlanName.value || planSaving.value) return
  planSaving.value = true
  error.value = ''
  try {
    if (!selectedPlanIsExcel.value) {
      planDraft.value.levels = [0, 1, 2].map((i) => levelTemplateOf(i))
      if (!String(planDraft.value.levels[0] || '').trim()) {
        error.value = '一级文件夹不能为空(单一字段=选一个;多字段拼接=至少勾一个)'
        return false
      }
    } else if (!planVocab.value.excelColumns.length) {
      error.value = '列词汇未加载,刷新页面后再保存(避免把列勾选清空)'
      return false
    }
    const payload = selectedPlanIsExcel.value
      ? {
          planLabel: planDraft.value.planLabel || selectedPlanName.value,
          scope: { modes: String(planDraft.value.scopeModes || '').split(/[、,\s]+/).map((x) => x.trim()).filter(Boolean) },
          excel: { columns: planVocab.value.excelColumns.map((c) => c.key).filter((k) => planExcelCols.value.has(k)) },
        }
      : planPayloadFromDraft()
    const result = await saveExportPlan(selectedPlanName.value, {
      payload,
      expectBaseVersion: planBaseVersion.value,
      note: planNote.value,
    })
    planBaseVersion.value = result.version
    if (result.savedAsDraft) {
      lastSaveDraftInfo.value = { version: result.version, conflicts: result.conflicts || [] }
      setMessage(`v${result.version} 存为草稿(未生效):有硬冲突,按下方清单处理后到「历史」启用`)
      await loadPlanVersions()
    } else {
      lastSaveDraftInfo.value = null
      setMessage(`已保存导出计划 v${result.version}(预览一下再用)`)
      await loadPlans()
      await loadPlanVersions()
    }
    return true
  } catch (err) {
    if (err?.response?.status === 409) {
      error.value = `${err.response.data?.error || '计划已被他人修改'} —— 已刷新,请核对后重存`
      await loadPlans(); await loadPlanVersions()
    } else {
      error.value = err?.response?.data?.error || err?.message || '保存失败'
    }
    return false
  } finally { planSaving.value = false }
}

async function createPlan(name) {
  const trimmed = String(name || newPlanName.value || '').trim()
  if (!trimmed) return
  try {
    const scopeModes = prefillScopeMode.value ? [prefillScopeMode.value] : []
    const payload = newPlanType.value === 'excel'
      ? {
          planLabel: trimmed,
          scope: { modes: scopeModes },
          excel: { columns: ['stmt_date', 'agent', 'mode_raw', 'shop', 'purchase_date', 'receipt_no', 'name', 'passport_no'] },
        }
      : {
          planLabel: trimmed,
          scope: { modes: scopeModes },
          levels: [{ template: '{groupNo}' }],
          naming: { template: '{name}{passportNo:0,4}_{docLabel}{i}' },
          includes: ['receipt', 'passport'],
          emptyPolicy: 'block_prefix',
        }
    await saveExportPlan(trimmed, { payload, note: prefillScopeMode.value ? `配置台新建(模式:${prefillScopeMode.value})` : '配置台新建' })
    newPlanName.value = ''
    prefillScopeMode.value = ''
    setMessage(`已新建导出计划:${trimmed}`)
    await loadPlans()
    selectedPlanName.value = trimmed
    rebuildPlanDraft()
    await loadPlanVersions()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '新建失败'
  }
}

async function rollbackPlanTo(version) {
  if (!selectedPlanName.value) return
  if (!window.confirm(`回滚 ${selectedPlanName.value} 到 v${version}?`)) return
  try {
    await activateExportPlanVersion(selectedPlanName.value, version)
    setMessage(`已回滚到 v${version}`)
    await loadPlans(); await loadPlanVersions()
  } catch (err) { error.value = err?.response?.data?.error || err?.message || '回滚失败' }
}

async function deactivatePlan() {
  if (!selectedPlanName.value) return
  if (!window.confirm(`停用「${selectedPlanName.value}」?系统内置计划回到默认;自建计划从列表消失(历史保留)。`)) return
  try {
    await deactivateExportPlan(selectedPlanName.value)
    setMessage('已停用')
    await loadPlans(false); await loadPlanVersions()
  } catch (err) { error.value = err?.response?.data?.error || err?.message || '操作失败' }
}

async function runPreview() {
  if (!selectedPlanName.value || previewLoading.value) return
  const body = selectedPlanIsExcel.value
    ? { workspaceKey: previewWorkspaceKey.value.trim() }
    : { batchId: previewBatchId.value }
  if (selectedPlanIsExcel.value ? !body.workspaceKey : !body.batchId) return
  previewLoading.value = true
  previewResult.value = null
  try {
    previewResult.value = await previewExportPlan(selectedPlanName.value, body)
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '预览失败'
  } finally { previewLoading.value = false }
}

async function loadPreviewBatches() {
  try {
    const state = await fetchWorkbenchState()
    previewBatches.value = (state.batches || []).slice(0, 20).map((b) => ({ id: b.id, name: b.name || b.id }))
    if (!previewBatchId.value && previewBatches.value.length) previewBatchId.value = previewBatches.value[0].id
  } catch { previewBatches.value = [] }
}

// ── 审核字段 / 百货店档案 / 基线 / 冲突 ──
// branch 文案(2026-07-17 用户反馈"没有门店"):它就是门店字段——票面4位编号,系统自动对应
// 门店名(明洞/蚕室/釜山/仁川),审核台显示店名、台账/交付记「明洞(0001)」。改名让人看得出来。
const DEPT_FIELD_LABELS = Object.freeze({ passportNo: '护照号码', extractedName: '护照姓名', receiptNo: '小票号/交易编号', receiptAmount: '交易金额', branch: '门店(明洞/蚕室/釜山/仁川)', brand: '品牌', upstream: '上家', purchaseDate: '购买日期' })
const BASE_FIELD_LABELS = Object.freeze({ extractedNameFinal: '护照姓名', passportNoFinal: '护照号', receiptStoreFinal: '免税店', receiptNoFinal: '小票号', groupNoFinal: '团号', purchaseDateFinal: '购买日期', departureDateFinal: '出境日期' })
// 锚字段:基线不可摘除(审计H5,与后端 review_config_resolver REQUIRED_BASE_ANCHORS 同口径)——
// 小票=免税店(路由锚)、护照=护照号+姓名(身份锚);摘除会让空值票终审通过致错桶/残包。
const BASE_ANCHOR_FIELDS = Object.freeze({ receipt: ['receiptStoreFinal'], passport: ['passportNoFinal', 'extractedNameFinal'] })
function isBaseAnchor(docType, key) { return (BASE_ANCHOR_FIELDS[docType] || []).includes(key) }

const reviewBases = ref([])
const storeProfiles = ref([])
const storeLoaded = ref(false)  // 区分"档案还在加载"与"真失败"(复核:初始竞态误报加载失败)
const storeDraft = ref({})
const storeSaving = ref(false)
const selectedStoreFamily = ref('')      // 百货店入口独立选中(不再依赖选中模式)
const modeReviewDraft = ref({ relax: new Set(), slim: false })
const conflictRows = ref([])
const conflictHard = ref(0)
// 冲突检查**没跑成**时的原因。空数组不能替它说话:
// 「查了没事」和「根本没查成」在界面上必须分得开(见 loadConflicts 的注释)。
const conflictError = ref('')
const baselineOpen = ref(false)
const baselineDraft = ref({ passport: new Set(), receipt: new Set() })
const baselineSaving = ref(false)
const planVocab = ref({ excelColumns: [], dslTokens: [] })
const newPlanType = ref('folder')
const prefillScopeMode = ref('')
const planExcelCols = ref(new Set())
const previewWorkspaceKey = ref('')
const lastSaveDraftInfo = ref(null)
const executing = ref(false)
const levelSkins = ref(['single', 'single', 'single'])
const levelSingle = ref(['', '', ''])
const levelMulti = ref([[], [], []])

const selectedStore = computed(() => storeProfiles.value.find((s) => s.family === selectedStoreFamily.value) || null)

// ── 门店码点选清单(0727反馈#6):审核台「门店」字段的可点码,这里增减 ──
// 生效边界如实(断点①同款):清单喂审核台点选与店名提示;台账/交付的码→店名映射
// 走出厂表,新增码在那边显示码原样(要进映射需改代码)。
const branchDraft = ref([]) // [{code,name}]
const branchSaving = ref(false)
watch([selectedStoreFamily, storeProfiles], () => {
  const opts = selectedStore.value?.branchOptions
  branchDraft.value = Array.isArray(opts) ? opts.map((o) => ({ code: o.code, name: o.name })) : []
}, { immediate: true })
function addBranchRow() { branchDraft.value = [...branchDraft.value, { code: '', name: '' }] }
function removeBranchRow(i) { branchDraft.value = branchDraft.value.filter((_, idx) => idx !== i) }
async function saveBranchOptions() {
  const family = selectedStoreFamily.value
  if (!family || branchSaving.value) return
  const cleaned = branchDraft.value
    .map((o) => ({ code: String(o.code || '').trim(), name: String(o.name || '').trim() }))
    .filter((o) => o.code || o.name)
  if (!cleaned.length) { error.value = '至少留一个门店码(要回出厂请点「回到默认」)'; return }
  const bad = cleaned.find((o) => !/^\d{4}$/.test(o.code))
  if (bad) { error.value = `门店码「${bad.code || '(空)'}」必须是 4 位数字`; return }
  branchSaving.value = true
  try {
    await saveStoreBranchOptions(family, {
      branchOptions: cleaned,
      expectBaseVersion: selectedStore.value?.config?.version ?? 0,
      note: '配置台门店码清单',
    })
    // ⭐存的那一刻就点名(2026-08-01):页面上那段"生效边界"是静态说明,谁都不会逐字读。
    // 真正有用的是:你**这次**加的码里哪几个出厂表没有 —— 那几个在台账/交付包里
    // 只会显示码本身。不说的话,要等月底出包才发现夹名是「0999」。
    // 逻辑在 lib/branchCodeMapping(纯函数,可直测):写在组件里的话,测试只能扫源码文本,
    // 把计算改坏了也照样绿 —— 今天已经栽过一次。
    setMessage(branchSaveMessage(
      unmappedBranchCodes(cleaned, selectedStore.value?.factoryRules?.branchNames || {}),
    ))
    await loadReviewConfigData()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '保存失败'
    if (err?.response?.status === 409) await loadReviewConfigData()
  } finally { branchSaving.value = false }
}
const selectedStoreFields = computed(() => storeDraft.value[selectedStoreFamily.value] || new Set())
// 断点②明示(2026-07-20 行为三合一):身份两键的真实作用按 passportFree 分流,不再"绿灯谎言"
const storeIdentityTip = computed(() => {
  if (!selectedStore.value) return ''
  return selectedStore.value.readonly?.passportFree
    ? '护照号/护照姓名:此店免护照(票面无护照)——勾选只在审核面板加"选填"格,不进必填集;旧配置带勾也不会卡审。'
    : '护照号/护照姓名:同框票身份,勾选=审核必填(已与审核台接线);取消勾选会隐藏身份格,组级护照闸将无法满足,请保持勾选。'
})
const receiptBase = computed(() => reviewBases.value.find((b) => b.docType === 'receipt') || null)
const passportBase = computed(() => reviewBases.value.find((b) => b.docType === 'passport') || null)
const modePlans = computed(() => plans.value.filter((plan) => {
  const payload = plan.config?.payload || plan.factory || {}
  if (payload.builtin) return false
  const scoped = payload.scope?.modes || []
  return !scoped.length || scoped.includes(selectedName.value)
}))

async function loadReviewConfigData() {
  try { reviewBases.value = (await fetchReviewBases()).bases || [] } catch { reviewBases.value = [] }
  try {
    storeProfiles.value = (await fetchStoreProfiles()).stores || []
    const d = {}
    for (const store of storeProfiles.value) d[store.family] = new Set(store.fields)
    storeDraft.value = d
    if (!selectedStoreFamily.value && storeProfiles.value.length) selectedStoreFamily.value = storeProfiles.value[0].family
  } catch { storeProfiles.value = [] } finally { storeLoaded.value = true }
}

function rebuildModeReviewDraft() {
  const review = selectedMode.value?.config?.payload?.review || {}
  modeReviewDraft.value = { relax: new Set(review.relax || []), slim: review.slim === true }
}

async function loadConflicts() {
  if (!selectedName.value) { conflictRows.value = []; conflictHard.value = 0; conflictError.value = ''; return }
  try {
    const payload = await fetchModeConflicts(selectedName.value)
    conflictRows.value = payload.conflicts || []
    conflictHard.value = payload.hard || 0
    conflictError.value = ''
  } catch (error) {
    // 2026-08-01:原来是 `catch { rows = [] }` —— 接口 500 / 断网 / 权限不足
    // 全都被吞成"空数组",而空数组在下面渲染成**「无冲突」**。
    // 也就是说"根本没查成"和"查了没事"长得一模一样,而这里是管理员
    // 判断配置能不能发的地方 —— 把没查说成没问题,是最危险的一类假话。
    conflictRows.value = []
    conflictHard.value = 0
    conflictError.value = humanErrorMessage(error, '冲突检查没跑成')
  }
}

// T3(2026-07-21):「记哪些列」单一真相源——不记的列命中后自动免审(后端 resolver 派生),
// 此处只做展示同步:派生免审的勾选框置灰,防止"上面不记、下面还打着必审勾"的认知打架。
const COLUMN_TO_REVIEW_KEY = { receiptNo: 'receiptNoFinal', purchaseDate: 'purchaseDateFinal', departureDate: 'departureDateFinal' }
function isColumnDerivedRelax(fieldKey) {
  const cols = draft.value?.columns
  if (!cols) return false
  for (const [col, key] of Object.entries(COLUMN_TO_REVIEW_KEY)) {
    if (key === fieldKey && cols[col] === false) return true
  }
  return false
}

function toggleRelax(key) {
  if (key === 'receiptStoreFinal') return // 免税店=路由锚字段,不可免审
  const next = new Set(modeReviewDraft.value.relax)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  modeReviewDraft.value = { ...modeReviewDraft.value, relax: next }
}

function toggleStoreField(family, field) {
  const set = new Set(storeDraft.value[family] || [])
  if (set.has(field)) set.delete(field)
  else set.add(field)
  storeDraft.value = { ...storeDraft.value, [family]: set }
}

async function saveStoreFamily(family) {
  const store = storeProfiles.value.find((item) => item.family === family)
  await saveStoreFields(family, {
    fields: [...(storeDraft.value[family] || [])],
    expectBaseVersion: store?.config?.version ?? 0,
    note: '配置台百货字段勾选',
  })
  await loadReviewConfigData(); await loadConflicts()
}

async function saveStoreDraft() {
  const family = selectedStoreFamily.value
  if (!family || storeSaving.value) return
  storeSaving.value = true
  try {
    const label = selectedStore.value?.label || family
    await saveStoreFamily(family)
    setMessage(`已保存${label}(审核台即刻生效)`)
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '保存失败'
    if (err?.response?.status === 409) await loadReviewConfigData()
  } finally { storeSaving.value = false }
}

async function resetStoreDraft() {
  const family = selectedStoreFamily.value
  if (!family) return
  if (!window.confirm(`「${selectedStore.value?.label || family}」回到系统默认?审核台该店必审字段立即恢复。`)) return
  try {
    await deactivateStoreFields(family)
    setMessage('已回到系统默认')
    await loadReviewConfigData(); await loadConflicts()
  } catch (err) { error.value = err?.response?.data?.error || err?.message || '操作失败' }
}

function openBaseline() {
  baselineDraft.value = {
    passport: new Set(passportBase.value?.fields || []),
    receipt: new Set(receiptBase.value?.fields || []),
  }
  baselineOpen.value = true
}

function toggleBaselineField(docType, key) {
  if (isBaseAnchor(docType, key)) return // 锚字段不可摘除(审计H5,与 toggleRelax 对称)
  const next = new Set(baselineDraft.value[docType])
  if (next.has(key)) next.delete(key)
  else next.add(key)
  baselineDraft.value = { ...baselineDraft.value, [docType]: next }
}

async function saveBaseline(docType) {
  if (baselineSaving.value) return
  const base = docType === 'passport' ? passportBase.value : receiptBase.value
  const fields = (base?.vocabulary || []).filter((k) => baselineDraft.value[docType].has(k))
  if (!fields.length) { error.value = '至少留一个必审字段(想全免审请用模式微调)'; return }
  baselineSaving.value = true
  try {
    const impact = await impactReviewBase(docType, { fields })
    const addText = impact.added.length ? `新增必填:${impact.added.map((k) => BASE_FIELD_LABELS[k] || k).join('、')}(最近${impact.batchesChecked}个批次将有 ${impact.affectedTasks} 张在审票变必改)` : ''
    const removeText = impact.removed.length ? `放宽:${impact.removed.map((k) => BASE_FIELD_LABELS[k] || k).join('、')}` : ''
    const summary = [addText, removeText].filter(Boolean).join('\n') || '无字段变化'
    if (!window.confirm(`确认修改${docType === 'passport' ? '护照' : '小票'}默认必审字段?对所有在审票立即生效。\n${summary}`)) return
    await saveReviewBase(docType, { payload: { fields }, expectBaseVersion: base?.config?.version ?? 0, note: '配置台默认必审修改' })
    setMessage('已保存并生效(可随时回到默认)')
    await loadReviewConfigData(); await loadConflicts()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || '保存失败'
  } finally { baselineSaving.value = false }
}

async function resetBaseline(docType) {
  if (!window.confirm('回到系统默认必审字段?')) return
  try { await deactivateReviewBase(docType); setMessage('已回到默认'); await loadReviewConfigData(); openBaseline() } catch (err) { error.value = err?.message || '操作失败' }
}

function goCreatePlanForMode() {
  prefillScopeMode.value = selectedName.value
  nav.value = 'exports'
}

// ── 三选皮肤:模板 ↔ 皮肤态互转 ──
const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9_]*)(?::\d+,\d+)?\}/g
function parseSkin(template) {
  const text = String(template || '')
  if (!text) return { skin: 'single', single: '', multi: [] }
  const tokens = [...text.matchAll(TOKEN_RE)].map((m) => m[1])
  const literal = text.replace(TOKEN_RE, '')
  if (literal.trim() || tokens.some((t) => text.includes(`{${t}:`))) return { skin: 'free', single: '', multi: [] }
  if (tokens.length === 1) return { skin: 'single', single: tokens[0], multi: [] }
  return { skin: 'multi', single: '', multi: tokens }
}
function levelTemplateOf(i) {
  const skin = levelSkins.value[i]
  if (skin === 'single') return levelSingle.value[i] ? `{${levelSingle.value[i]}}` : ''
  if (skin === 'multi') return levelMulti.value[i].map((t) => `{${t}}`).join('')
  return String(planDraft.value?.levels?.[i] || '').trim()
}
function syncSkinsFromDraft() {
  for (let i = 0; i < 3; i += 1) {
    const parsed = parseSkin(planDraft.value?.levels?.[i] || '')
    levelSkins.value[i] = parsed.skin
    levelSingle.value[i] = parsed.single
    levelMulti.value[i] = [...parsed.multi]
  }
}
function toggleLevelMulti(i, token) {
  const list = levelMulti.value[i]
  const idx = list.indexOf(token)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(token)
}
const selectedPlanIsExcel = computed(() => Boolean((selectedPlan.value?.config?.payload || selectedPlan.value?.factory || {}).excel))
const planBaseVersion = ref(0)
function toggleExcelCol(key) {
  const next = new Set(planExcelCols.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  planExcelCols.value = next
}

async function executePlan() {
  if (!selectedPlanName.value || executing.value) return
  executing.value = true
  error.value = ''
  try {
    const body = selectedPlanIsExcel.value
      ? { workspaceKey: previewWorkspaceKey.value.trim() }
      : { batchId: previewBatchId.value }
    const blob = await executeExportPlan(selectedPlanName.value, body)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedPlanName.value}-${selectedPlanIsExcel.value ? '明细.xlsx' : '交付.zip'}`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    setMessage('导出已开始下载')
  } catch (err) {
    const data = err?.response?.data
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text())
        const extra = [...(parsed.blocked || []), ...(parsed.collisions || []).map((c) => c.destBase || c), ...(parsed.copyFailed || [])].slice(0, 5)
        error.value = `${parsed.error || '导出被拦'}${extra.length ? `:${extra.join(';')}` : ''}`
      } catch { error.value = '导出失败' }
    } else {
      error.value = data?.error || err?.message || '导出失败'
    }
  } finally { executing.value = false }
}

// ── 字段字典 ──
const registryRows = ref([])
const registryLoaded = ref(false)
const registryError = ref(false)
const SOURCE_LABELS = Object.freeze({ manual: '审核员填', ocr: '识别产出', derived: '系统算出' })

async function goNav(key) {
  nav.value = key
  if (key === 'fields' && !registryLoaded.value) {
    registryError.value = false
    try {
      registryRows.value = (await fetchFieldRegistry()).fields || []
      registryLoaded.value = true
    } catch { registryRows.value = []; registryError.value = true }
  }
}

// ── 未保存检测 + 一键保存 ──
const modeDirty = computed(() => {
  if (!draft.value || !selectedMode.value) return false
  const base = effectivePayload.value || {}
  const baseReview = selectedMode.value?.config?.payload?.review || {}
  const relaxNow = [...modeReviewDraft.value.relax].sort().join(',')
  const relaxBase = [...(baseReview.relax || [])].sort().join(',')
  return draft.value.modeLabel !== (base.modeLabel || selectedMode.value.label || selectedName.value)
    || JSON.stringify(draft.value.columns) !== JSON.stringify({ ...base.columns })
    || (draft.value.receiptNoForm || '') !== (base.receiptNoForm || '')
    || [...draft.value.actions].sort().join(',') !== [...(base.actions || [])].sort().join(',')
    || (draft.value.note || '') !== (base.note || '')
    || (draft.value.groupNoLiteral || '') !== (base.groupNoLiteral || '')
    || relaxNow !== relaxBase
    || Boolean(modeReviewDraft.value.slim) !== (baseReview.slim === true)
})
const storeDirtyFamilies = computed(() => storeProfiles.value
  .filter((store) => {
    const draftSet = storeDraft.value[store.family]
    if (!draftSet) return false
    return [...draftSet].sort().join(',') !== [...store.fields].sort().join(',')
  })
  .map((store) => store.family))
// 交付导出页的计划脏改动也要纳入「有未保存」——否则全局徽章给出「已全保存」假象(复核 MEDIUM)
const planDirty = computed(() => {
  if (!planDraft.value || !selectedPlan.value || planIsBuiltin.value) return false
  const base = selectedPlan.value.config?.payload || selectedPlan.value.factory || {}
  const scopeNow = String(planDraft.value.scopeModes || '')
  const scopeBase = (base.scope?.modes || []).join('、')
  if (selectedPlanIsExcel.value) {
    const colsNow = [...planExcelCols.value].sort().join(',')
    const colsBase = (base.excel?.columns || []).slice().sort().join(',')
    return scopeNow !== scopeBase || colsNow !== colsBase
  }
  const levelsNow = [0, 1, 2].map((i) => levelTemplateOf(i)).join('¦')
  const levelsBase = [0, 1, 2].map((i) => base.levels?.[i]?.template || '').join('¦')
  const incNow = Object.entries(planDraft.value.includes).filter(([, on]) => on).map(([k]) => k).sort().join(',')
  const incBase = (base.includes || []).slice().sort().join(',')
  return scopeNow !== scopeBase
    || levelsNow !== levelsBase
    || (planDraft.value.naming || '') !== (base.naming?.template || '{docLabel}{i}')
    || incNow !== incBase
    || (planDraft.value.emptyPolicy || 'block_prefix') !== (base.emptyPolicy || 'block_prefix')
})
const hasUnsaved = computed(() => modeDirty.value || storeDirtyFamilies.value.length > 0 || planDirty.value)

async function saveAll() {
  if (savingAll.value || !hasUnsaved.value) return
  savingAll.value = true
  const results = []
  let failed = 0
  const snapshots = planStoreSaveSnapshots(storeDirtyFamilies.value, storeDraft.value, storeProfiles.value)
  try {
    for (const snap of snapshots) {
      try {
        await saveStoreFields(snap.family, { fields: snap.fields, expectBaseVersion: snap.expectBaseVersion, note: '配置台百货字段(一键保存)' })
        results.push(`✓ ${snap.label}`)
      } catch (err) {
        failed += 1
        results.push(`✗ ${snap.label}:${err?.response?.data?.error || err?.message || '保存失败'}`)
      }
    }
    if (snapshots.length) { await loadReviewConfigData(); await loadConflicts() }
    if (modeDirty.value) {
      const ok = await save()
      if (!ok) failed += 1
      results.push(ok ? `✓ 模式 ${selectedName.value}` : `✗ 模式 ${selectedName.value}`)
    }
    if (planDirty.value) {
      const ok = await savePlan()
      if (!ok) failed += 1
      results.push(ok ? `✓ 计划 ${selectedPlanName.value}` : `✗ 计划 ${selectedPlanName.value}`)
    }
    if (!results.length) return
    if (failed) error.value = `一键保存有 ${failed} 项失败:${results.join(';')}`
    else setMessage(`一键保存:${results.join(';')}`)
  } finally { savingAll.value = false }
}
const savingAll = ref(false)

// ── 深链:代理视图「状态·任务」列头齿轮 → ?nav=modes&focus=tasks(2026-07-29)──
// 只跳 /admin/config 会落在页面顶部,任务设置在长页面下方,人还是得找;所以带参数过来,
// 由这里滚到位 + 闪一下高亮。判定是纯函数(lib/configConsoleDeepLink,有单测),
// 这里只留 DOM 副作用。
const taskFocusFlash = ref(false)
let taskFocusPending = false
let taskFocusTimer = null

async function tryFocusTaskSettings() {
  if (!taskFocusPending) return
  await nextTick()
  const el = document.getElementById('mode-task-settings')
  // 模式列表还没加载出来 → 元素不存在,不消耗 pending,等 selectedMode 到位再试一次
  if (!el) return
  taskFocusPending = false
  el.scrollIntoView({ block: 'center', behavior: 'auto' })
  taskFocusFlash.value = true
  if (taskFocusTimer) clearTimeout(taskFocusTimer)
  taskFocusTimer = setTimeout(() => { taskFocusFlash.value = false }, 2200)
}
watch(selectedMode, tryFocusTaskSettings)
onBeforeUnmount(() => { if (taskFocusTimer) clearTimeout(taskFocusTimer) })

onMounted(async () => {
  const deepLink = readConfigDeepLink(route.query, NAV.map((item) => item.key))
  if (deepLink.nav) await goNav(deepLink.nav)
  taskFocusPending = deepLink.focusTasks
  await load(false)
  await loadVersions()
  await loadPlans(false)
  await loadPlanVersions()
  await loadPreviewBatches()
  await loadReviewConfigData()
  rebuildModeReviewDraft()
  await loadConflicts()
  await tryFocusTaskSettings()
})
</script>

<template>
  <section class="cc">
    <header class="cc-head">
      <div>
        <h1>配置台</h1>
        <p class="sub">改渠道模式记什么、审什么,配交付导出。保存即生效,改坏了随时回到系统默认。</p>
      </div>
      <div class="head-actions">
        <span v-if="hasUnsaved" class="badge warn-badge" title="当前模式或百货店有勾选未保存">● 有未保存</span>
        <button v-if="hasUnsaved" type="button" class="primary" :disabled="savingAll" @click="saveAll">{{ savingAll ? '保存中…' : '一键保存' }}</button>
        <button type="button" class="ghost" :disabled="loading" @click="load()">⟳ 刷新</button>
      </div>
    </header>

    <div v-if="error" class="banner error">{{ error }}</div>
    <div v-if="message" class="banner ok">{{ message }}</div>

    <div class="cc-body">
      <!-- 单一左侧导航 -->
      <nav class="rail" aria-label="配置台导航">
        <button
          v-for="item in NAV"
          :key="item.key"
          type="button"
          :class="{ active: nav === item.key }"
          @click="goNav(item.key)"
        >
          <span class="rail-label">{{ item.label }}</span>
          <span class="rail-hint">{{ item.hint }}</span>
        </button>
      </nav>

      <div class="rail-content">
        <!-- ═══ 渠道模式 ═══ -->
        <template v-if="nav === 'modes'">
          <div v-if="unconfigured.length" class="banner warn">
            团号表里有 {{ unconfigured.length }} 个模式还没配(先按默认全记处理):
            <button v-for="item in unconfigured" :key="item.name" type="button" class="chip-btn" @click="createMode(item.name)">+ {{ item.name }}</button>
          </div>

          <div class="two-col">
            <!-- 左:模式列表 -->
            <aside class="list-pane">
              <div class="list-head">渠道模式</div>
              <button
                v-for="mode in modes"
                :key="mode.name"
                type="button"
                class="list-item"
                :class="{ active: mode.name === selectedName }"
                @click="selectMode(mode.name)"
              >
                <span class="li-name">{{ mode.label }}</span>
                <span class="li-right">
                  <span v-if="mode.warnings?.length" class="badge warn-badge li-warn" :title="mode.warnings.join('\n')">⚠ {{ mode.warnings.length }}</span>
                  <span class="li-badge" :class="mode.source === 'db' ? 'db' : 'factory'">{{ mode.source === 'db' ? `改过 v${mode.config?.version}` : '默认' }}</span>
                </span>
              </button>
              <div class="list-new">
                <input v-model="newModeName" placeholder="新模式名(对齐团号表)" @keyup.enter="createMode()">
                <button type="button" @click="createMode()">+ 新增</button>
              </div>
            </aside>

            <!-- 右:选中模式的配置 -->
            <div v-if="draft && selectedMode" class="edit-pane">
              <fieldset class="edit-body" :disabled="saving">
                <div class="pane-title">
                  <h2>{{ selectedMode.label }}</h2>
                  <span class="badge" :class="selectedMode.source === 'db' ? 'db' : 'factory'">{{ selectedMode.source === 'db' ? `改过 v${selectedMode.config?.version}` : '系统默认' }}</span>
                </div>

                <!-- 主区块①:台账记哪些列 -->
                <div class="block">
                  <h3>台账记哪些列 <span class="summary">{{ recordSummary }}</span></h3>
                  <div class="chk-grid">
                    <label v-for="col in COLUMN_DEFS" :key="col.key" class="chk">
                      <input v-model="draft.columns[col.key]" type="checkbox"><span>{{ col.label }}</span>
                    </label>
                  </div>
                  <p class="tip">作用范围:只影响<b>审核台的批次小票导出</b>(去勾的列导出留空);客户数据Excel、台账落库、交付包始终全量,不吃这里的勾选。</p>
                </div>

                <!-- 主区块②:审核审哪些字段(免税店小票)。百货模式不走模式微调 → 跳转提示 -->
                <div v-if="selectedDeptFamily" class="block">
                  <h3>审核审哪些字段</h3>
                  <div class="banner info">
                    百货票的审核字段<b>不在这里配</b>(百货无团号、不走模式微调)——请到「百货店」板块按店配置,保存即刻生效。
                    <button type="button" class="ghost small" @click="goDeptStoreConfig">去「百货店」板块配置 →</button>
                  </div>
                </div>
                <div v-else class="block">
                  <!-- G2(0724反馈):大段说明不再铺满全屏——收进【说明】,点开才展开。
                       内容一字未删(免审生效条件/列联动是防误解的关键),只是不再常驻占屏。 -->
                  <h3>
                    审核审哪些字段 <span class="summary">这个模式的小票,命中团号后按此微调</span>
                    <button type="button" class="doc-toggle" :aria-expanded="showFieldsDoc" @click="showFieldsDoc = !showFieldsDoc">说明</button>
                  </h3>
                  <template v-if="showFieldsDoc">
                    <p class="tip">默认必审见下面勾选;去勾=<b>这个模式</b>免审该字段(只在票命中团号后生效,没匹配上仍按默认审)。</p>
                    <p class="tip">⚡「台账记哪些列」里不记的 小票号/购买日期/出境日期,命中后<b>自动免审</b>(下方对应项已随之置灰)——想恢复人工核对,把那一列改回"记"即可,单一开关不打架。</p>
                  </template>
                  <div class="chk-grid">
                    <label
                      v-for="fieldKey in (receiptBase?.fields || [])"
                      :key="fieldKey"
                      class="chk"
                      :class="{ relaxed: modeReviewDraft.relax.has(fieldKey) || isColumnDerivedRelax(fieldKey), locked: fieldKey === 'receiptStoreFinal' }"
                      :title="fieldKey === 'receiptStoreFinal' ? '免税店是分流关键,不能免审'
                        : (isColumnDerivedRelax(fieldKey) ? '「台账记哪些列」没记这一列 → 命中后自动免审;想恢复核对请把该列改回「记」' : '')"
                    >
                      <input
                        type="checkbox"
                        :checked="!modeReviewDraft.relax.has(fieldKey) && !isColumnDerivedRelax(fieldKey)"
                        :disabled="fieldKey === 'receiptStoreFinal' || isColumnDerivedRelax(fieldKey)"
                        @change="toggleRelax(fieldKey)"
                      >
                      <span>{{ BASE_FIELD_LABELS[fieldKey] || fieldKey }}</span>
                    </label>
                  </div>
                  <label class="chk slim-toggle">
                    <input v-model="modeReviewDraft.slim" type="checkbox">
                    <span>快车道:这个模式命中团号后直接免审通过</span>
                  </label>
                  <button type="button" class="link-btn" @click="openBaseline">改所有模式的默认必审字段…</button>
                </div>

                <!-- 主区块③:票号形态 + 备注 -->
                <div class="block row-two">
                  <label class="field">
                    <span class="field-label">小票号导出形态</span>
                    <select v-model="draft.receiptNoForm">
                      <option v-for="form in RECEIPT_NO_FORMS" :key="form.value" :value="form.value">{{ form.label }}</option>
                    </select>
                    <span v-if="selectedDeptFamily" class="field-note">百货:交易编号入台账/交付包<b>原样</b>(店档案定形);此形态只重排「审核台批次导出」和「客户数据Excel」的票号列。</span>
                  </label>
                  <!-- G3(0724反馈):「团号字面量」输入框已删——它自己都标着"暂未接线,改了不生效"。
                       已核实:运行时没有任何代码读这个配置值(机场票「无」由票面填写/表态直接落值;
                       矩阵内建的 groupNoLiteral 是代码常量,与此输入无关)。draft/payload 里的字段
                       保留透传,存量配置不丢;将来真要接线,把输入框加回来即可。 -->
                </div>

                <!-- 主区块④:任务设置(2026-07-29 用户拍板,从下面的「高级」折叠里提上来)。
                     原来它是高级折叠区里**默认收起**的一项,从代理视图跳过来根本看不见——
                     光改名解决不了"找不到",折叠本身才是根因。提上来还顺带修了两处:
                     ①进 fieldset 后保存期间跟着 disabled(原来在 fieldset 外,保存中还能改);
                     ②"记得点上面保存"→"下面",因为保存行现在在它下面。 -->
                <div
                  id="mode-task-settings"
                  class="block"
                  :class="{ 'focus-flash': taskFocusFlash }"
                >
                  <h3>
                    任务设置
                    <span class="summary">审核台字段区的提醒签 + 批次导出的备注列</span>
                  </h3>
                  <div class="chk-grid">
                    <label v-for="action in ACTION_OPTIONS" :key="action" class="chk">
                      <input type="checkbox" :checked="draft.actions.includes(action)" @change="toggleAction(action)"><span>{{ action }}</span>
                    </label>
                  </div>
                  <label class="field">
                    <span class="field-label">规则备注(显示给审核员)</span>
                    <input v-model="draft.note" placeholder="如:S活动按小票红色标签判定…">
                  </label>
                  <p class="tip">注:「S活动红标签」只是给审核员的提醒,交付包的 S活动双份判定与这里无关。改完点下面「保存并生效」。</p>
                </div>

                <!-- 冲突提醒(有才显示) -->
                <div v-if="conflictHard" class="banner warn">
                  ⚠ 有 {{ conflictHard }} 处硬冲突:导出要用的字段,审核没勾。展开下面「导出与冲突」看处理建议。
                </div>
                <div v-if="saveWarnings.length" class="banner warn">
                  <div v-for="warning in saveWarnings" :key="warning">⚠ {{ warning }}</div>
                </div>

                <!-- 保存 -->
                <div class="save-row">
                  <input v-model="draftNote" class="note-input" placeholder="本次修改备注(可留空)">
                  <button type="button" class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并生效' }}</button>
                  <button v-if="selectedMode.source === 'db'" type="button" class="danger-ghost" @click="fallbackToFactory">回到默认</button>
                </div>
              </fieldset>

              <!-- 折叠:高级(导出与冲突 / 历史)。
                   任务设置已于 2026-07-29 提到上面主区块④——它是代理视图「状态·任务」列
                   天天在看的东西,不该算"高级"。 -->
              <details class="adv">
                <summary>这个模式的导出需求 · 冲突检查</summary>
                <table class="mini-table">
                  <thead><tr><th>#</th><th>名称</th><th>类型</th><th /></tr></thead>
                  <tbody>
                    <tr><td>0</td><td>台账登记(列见上面)</td><td>内置表</td><td /></tr>
                    <tr v-for="(plan, idx) in modePlans" :key="plan.name">
                      <td>{{ idx + 1 }}</td>
                      <td>{{ plan.label }}</td>
                      <td>{{ (plan.config?.payload || plan.factory || {}).excel ? '明细表' : '文件夹' }}</td>
                      <td><button type="button" class="ghost small" @click="goNav('exports'); selectPlan(plan.name)">改</button></td>
                    </tr>
                  </tbody>
                </table>
                <div class="conflict-head">
                  <button type="button" class="ghost small" @click="goCreatePlanForMode">+ 为本模式新增导出</button>
                  <button type="button" class="ghost small" @click="loadConflicts">重查冲突</button>
                </div>
                <div v-if="conflictRows.length" class="conflict-list">
                  <div v-for="(c, i) in conflictRows" :key="i" class="conflict-row" :class="c.severity">
                    <span class="badge" :class="c.severity === 'hard' ? 'hard-badge' : 'warn-badge'">{{ c.severity === 'hard' ? '硬' : '软' }}</span>
                    <span>{{ c.message }}</span>
                    <span class="cf-fix">→ {{ c.suggestion || '—' }}</span>
                  </div>
                </div>
                <!-- 三态,不是两态:查出问题 / 查了没事 / **没查成**。
                     原来只有前两态,于是接口炸了也显示"无冲突"(见 loadConflicts)。 -->
                <p v-else-if="conflictError" class="tip warn">
                  ⚠️ 冲突检查没跑成:{{ conflictError }} —— 这<strong>不等于</strong>没有冲突,请重试或找管理员。
                </p>
                <p v-else class="tip">审核勾选都能供上导出要的字段,无冲突。</p>
              </details>

              <details class="adv">
                <summary>改动历史</summary>
                <p v-if="versionsLoading" class="tip">加载中…</p>
                <p v-else-if="!versions.length" class="tip">还没有自定义版本(当前=系统默认)。</p>
                <table v-else class="mini-table">
                  <thead><tr><th>版本</th><th>时间</th><th>人</th><th>备注</th><th /></tr></thead>
                  <tbody>
                    <tr v-for="version in versions" :key="version.version" :class="{ current: version.active }">
                      <td>v{{ version.version }}<span v-if="version.active" class="badge db">生效</span></td>
                      <td class="time">{{ String(version.createdAt || '').slice(0, 16).replace('T', ' ') }}</td>
                      <td>{{ version.createdBy || '—' }}</td>
                      <td class="note-cell" :title="version.note">{{ version.note || '—' }}</td>
                      <td><button v-if="!version.active" type="button" class="ghost small" @click="rollbackTo(version.version)">回滚</button></td>
                    </tr>
                  </tbody>
                </table>
              </details>
            </div>
          </div>
        </template>

        <!-- ═══ 百货店 ═══ -->
        <template v-else-if="nav === 'stores'">
          <div class="two-col">
            <aside class="list-pane">
              <div class="list-head">百货店</div>
              <button
                v-for="store in storeProfiles"
                :key="store.family"
                type="button"
                class="list-item"
                :class="{ active: store.family === selectedStoreFamily }"
                @click="selectedStoreFamily = store.family"
              >
                <span class="li-name">{{ store.label }}</span>
                <span class="li-badge" :class="store.source === 'db' ? 'db' : 'factory'">{{ store.source === 'db' ? `改过 v${store.config?.version}` : '默认' }}</span>
              </button>
            </aside>

            <div v-if="selectedStore" class="edit-pane">
              <fieldset class="edit-body" :disabled="storeSaving">
                <div class="pane-title">
                  <h2>{{ selectedStore.label }}</h2>
                  <span class="badge" :class="selectedStore.source === 'db' ? 'db' : 'factory'">{{ selectedStore.source === 'db' ? `改过 v${selectedStore.config?.version}` : '系统默认' }}</span>
                </div>
                <div class="block">
                  <h3>审核审哪些字段</h3>
                  <p class="tip">勾=这家店的票在审核台必审。跟店走,对该店所有票,保存后<b>即刻生效</b>(OCR 自动抽取仍按出厂档案,勾选只影响人工必审集)。护照豁免:{{ selectedStore.readonly?.passportFree ? '是(可无护照放行)' : '否' }}——系统判定,不可改。</p>
                  <p v-if="selectedStoreFamily === 'LOTTE_DEPT'" class="tip">
                    「门店」审的是票面4位编号,系统自动对应门店名:0001/0394→明洞、0002/0348→蚕室、0005→釜山、0344→仁川;台账/交付记「明洞(0001)」,新门店码照收(店名暂空)。
                  </p>
                  <div class="chk-grid">
                    <label v-for="fieldKey in (selectedStore.vocabulary || [])" :key="fieldKey" class="chk">
                      <input type="checkbox" :checked="selectedStoreFields.has(fieldKey)" @change="toggleStoreField(selectedStoreFamily, fieldKey)">
                      <span>{{ DEPT_FIELD_LABELS[fieldKey] || fieldKey }}</span>
                    </label>
                  </div>
                  <p v-if="storeIdentityTip" class="tip">{{ storeIdentityTip }}</p>
                  <div class="save-row">
                    <button type="button" class="primary" :disabled="storeSaving" @click="saveStoreDraft">{{ storeSaving ? '保存中…' : '保存并生效' }}</button>
                    <button v-if="selectedStore.source === 'db'" type="button" class="danger-ghost" @click="resetStoreDraft">回到默认</button>
                  </div>
                </div>

                <!-- 门店码点选清单(0727反馈#6):审核台「门店」字段的可点码在这里增减 -->
                <div v-if="selectedStore.branchConfigurable" class="block">
                  <h3>门店码点选清单</h3>
                  <p class="tip">
                    审核台「门店(票面4位编号)」显示这些可点的码,省得逐张手敲;新码票面出现时审核员仍可手输(照收不锁死)。
                    <b>生效边界:</b>清单只喂审核台点选与店名提示;台账/交付包的码→店名映射走出厂表(上方出厂规则),新增码在那边按码原样显示。
                  </p>
                  <div class="branch-rows">
                    <div v-for="(row, i) in branchDraft" :key="i" class="branch-row">
                      <input v-model="row.code" type="text" maxlength="4" placeholder="4位码" class="branch-code-input">
                      <input v-model="row.name" type="text" maxlength="12" placeholder="店名(可空)" class="branch-name-input">
                      <button type="button" class="ghost small" @click="removeBranchRow(i)">删</button>
                    </div>
                  </div>
                  <div class="save-row">
                    <button type="button" class="ghost small" @click="addBranchRow">+ 加一个码</button>
                    <button type="button" class="primary" :disabled="branchSaving" @click="saveBranchOptions">{{ branchSaving ? '保存中…' : '保存清单' }}</button>
                  </div>
                </div>
                <!-- 断点①明示:这些规则运行时读代码里的出厂档案,配置台改不了(别再"绿灯谎言") -->
                <details v-if="selectedStore.factoryRules" class="adv">
                  <summary>此店出厂规则(只读——要改需要改代码)</summary>
                  <ul class="tip readonly-rules">
                    <li v-if="selectedStore.factoryRules.receiptNo">
                      交易编号规则:{{ selectedStore.factoryRules.receiptNo.digits ? `${selectedStore.factoryRules.receiptNo.digits} 位数字` : '位数不限' }}、{{ selectedStore.factoryRules.receiptNo.dash === false ? '不打杠' : '可带杠' }}
                    </li>
                    <li v-if="selectedStore.factoryRules.branchNames">
                      门店码→店名:{{ Object.entries(selectedStore.factoryRules.branchNames).map(([c, n]) => `${c}→${n}`).join('、') }}
                    </li>
                    <li v-if="selectedStore.factoryRules.brand?.length">品牌白名单:{{ selectedStore.factoryRules.brand.join('、') }}</li>
                    <li v-if="selectedStore.factoryRules.upstream?.length">
                      上家枚举:{{ selectedStore.factoryRules.upstream.join('、') }}{{ selectedStore.factoryRules.upstreamDefault ? `(默认 ${selectedStore.factoryRules.upstreamDefault})` : '' }}
                    </li>
                    <li v-if="selectedStore.factoryRules.delivery">专属交付链:{{ selectedStore.factoryRules.delivery }}</li>
                  </ul>
                </details>
              </fieldset>
            </div>
            <p v-else-if="!storeLoaded" class="tip pad">百货店档案加载中…</p>
            <p v-else class="tip pad">百货店档案加载失败,点右上角刷新重试。</p>
          </div>
        </template>

        <!-- ═══ 交付导出 ═══ -->
        <template v-else-if="nav === 'exports'">
          <div class="banner info">
            没有专门导出计划的<b>普通模式</b>,交付时都走「内置·多模式四规则」的<b>规则③</b>(按模式名建文件夹)。点内置卡片可看四规则全文。
          </div>
          <div v-if="prefillScopeMode" class="banner ok">
            正在为模式「{{ prefillScopeMode }}」新增导出:选类型、输名字、点新增,适用范围自动圈定。
            <button type="button" class="ghost small" @click="prefillScopeMode = ''">取消</button>
          </div>

          <div class="two-col">
            <aside class="list-pane">
              <div class="list-head">导出计划</div>
              <div v-for="plan in plans" :key="plan.name" class="plan-entry">
                <button
                  type="button"
                  class="list-item"
                  :class="{ active: plan.name === selectedPlanName }"
                  @click="selectPlan(plan.name)"
                >
                  <span class="li-name" :title="plan.label">{{ plan.label }}</span>
                  <span class="li-badge" :class="plan.kindType === 'builtin' ? 'factory' : 'db'">{{ plan.kindType === 'builtin' ? '内置' : `自定义 v${plan.config?.version}` }}</span>
                </button>
                <!-- 内置计划:4 条内部规则做目录(点击滚到右侧对应卡)。仍是一个计划、一次预览/导出。 -->
                <div v-if="plan.rulesSpec?.rules?.length" class="plan-rules-sub">
                  <button
                    v-for="(rule, i) in plan.rulesSpec.rules"
                    :key="i"
                    type="button"
                    class="rule-sub"
                    @click="selectPlanRule(plan.name, i)"
                  >
                    {{ rule.title }}
                  </button>
                </div>
              </div>
              <div class="list-new-block">
                <div class="list-new-head">＋ 新建导出计划</div>
                <div class="plan-type-row">
                  <label><input v-model="newPlanType" type="radio" value="folder">文件夹</label>
                  <label><input v-model="newPlanType" type="radio" value="excel">Excel 表</label>
                </div>
                <div class="plan-new-row">
                  <input v-model="newPlanName" placeholder="新计划名" @keyup.enter="createPlan()">
                  <button type="button" class="ghost small" @click="createPlan()">新增</button>
                </div>
              </div>
            </aside>

            <div v-if="selectedPlan" class="edit-pane">
              <div class="pane-title">
                <h2>{{ selectedPlan.label }}</h2>
                <span class="badge" :class="planIsBuiltin ? 'factory' : 'db'">{{ planIsBuiltin ? '系统内置' : `自定义 v${selectedPlan.config?.version || 0}` }}</span>
              </div>

              <!-- 内置:只读规则明细 -->
              <template v-if="planIsBuiltin">
                <p class="tip">系统内置计划不可编辑(避免和在产导出规则出现两套口径)。下面是它的完整规则,也可在底部预览它对某批次会产出什么。</p>
                <div v-if="selectedPlan.rulesSpec" class="builtin-spec">
                  <p class="spec-summary">{{ selectedPlan.rulesSpec.summary }}</p>
                  <div v-for="(rule, i) in selectedPlan.rulesSpec.rules" :id="`spec-rule-${i}`" :key="i" class="spec-rule">
                    <div class="spec-rule-title">{{ rule.title }}</div>
                    <div class="spec-row"><span class="spec-k">命中条件</span><span class="spec-v">{{ rule.when }}</span></div>
                    <div class="spec-row"><span class="spec-k">文件夹</span><span class="spec-v mono">{{ rule.folder }}</span></div>
                    <div class="spec-row"><span class="spec-k">文件命名</span><span class="spec-v mono">{{ rule.files }}</span></div>
                    <div v-if="rule.note" class="spec-row"><span class="spec-k">说明</span><span class="spec-v note">{{ rule.note }}</span></div>
                  </div>
                  <div class="spec-fallback"><b>兜底与护栏:</b>{{ selectedPlan.rulesSpec.fallback }}</div>
                </div>
              </template>

              <!-- 自定义:可编辑 -->
              <fieldset v-else class="edit-body" :disabled="planSaving">
                <label class="field">
                  <span class="field-label">适用哪些模式(留空=全部;多个用、分隔)</span>
                  <input v-model="planDraft.scopeModes" placeholder="如:乐天SG-本司、乐天PKG-新琪">
                </label>

                <template v-if="!selectedPlanIsExcel">
                  <div v-for="(lvlLabel, i) in ['一级文件夹', '二级文件夹(可空)', '三级文件夹(可空)']" :key="lvlLabel" class="level-editor">
                    <div class="level-head">
                      <span class="field-label">{{ lvlLabel }} <span v-if="i === 0" class="req">*</span></span>
                      <label class="skin-pick"><input v-model="levelSkins[i]" type="radio" :name="`skin${i}`" value="single">单一字段</label>
                      <label class="skin-pick"><input v-model="levelSkins[i]" type="radio" :name="`skin${i}`" value="multi">多字段拼接</label>
                      <label class="skin-pick"><input v-model="levelSkins[i]" type="radio" :name="`skin${i}`" value="free">自由模板</label>
                    </div>
                    <select v-if="levelSkins[i] === 'single'" v-model="levelSingle[i]">
                      <option value="">{{ i === 0 ? '(选一个字段)' : '(此级不用)' }}</option>
                      <option v-for="tk in planVocab.dslTokens" :key="tk.token" :value="tk.token">{{ tk.label }}</option>
                    </select>
                    <div v-else-if="levelSkins[i] === 'multi'" class="chk-grid">
                      <label v-for="tk in planVocab.dslTokens" :key="tk.token" class="chk">
                        <input type="checkbox" :checked="levelMulti[i].includes(tk.token)" @change="toggleLevelMulti(i, tk.token)"><span>{{ tk.label }}</span>
                      </label>
                    </div>
                    <input v-else v-model="planDraft.levels[i]" placeholder="如:{groupNo}_{name} 或 {passportNo:0,4}">
                  </div>
                  <label class="field"><span class="field-label">文件命名 *</span><input v-model="planDraft.naming" placeholder="{docLabel}{i}"></label>
                  <div class="block">
                    <h3>拷哪些件</h3>
                    <div class="chk-grid">
                      <label class="chk"><input v-model="planDraft.includes.receipt" type="checkbox"><span>小票</span></label>
                      <label class="chk"><input v-model="planDraft.includes.passport" type="checkbox"><span>护照</span></label>
                      <label class="chk"><input v-model="planDraft.includes.other" type="checkbox"><span>其他</span></label>
                    </div>
                  </div>
                  <div class="block">
                    <h3>字段为空时</h3>
                    <div class="chk-grid">
                      <label class="chk"><input v-model="planDraft.emptyPolicy" type="radio" value="block_prefix"><span>阻断并提示(默认)</span></label>
                      <label class="chk"><input v-model="planDraft.emptyPolicy" type="radio" value="skip_log"><span>跳过并留痕</span></label>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div class="block">
                    <h3>明细表列(勾=导出;列序=台账固定顺序)</h3>
                    <div class="chk-grid">
                      <label v-for="col in planVocab.excelColumns" :key="col.key" class="chk">
                        <input type="checkbox" :checked="planExcelCols.has(col.key)" @change="toggleExcelCol(col.key)"><span>{{ col.header }}</span>
                      </label>
                    </div>
                    <p class="tip">行来源=已结算落库的台账(按预览时选的月工作区)。</p>
                  </div>
                </template>

                <div class="save-row">
                  <input v-model="planNote" class="note-input" placeholder="本次修改备注">
                  <button type="button" class="primary" :disabled="planSaving" @click="savePlan">{{ planSaving ? '保存中…' : '保存计划' }}</button>
                  <button v-if="selectedPlan.source === 'db'" type="button" class="danger-ghost" @click="deactivatePlan">停用</button>
                </div>

                <div v-if="lastSaveDraftInfo" class="banner warn">
                  <b>v{{ lastSaveDraftInfo.version }} 存为草稿(未生效)</b>——有硬冲突,按建议处理后到「历史」启用:
                  <div v-for="(c, i) in lastSaveDraftInfo.conflicts" :key="i" class="conflict-row" :class="c.severity">
                    <span class="badge" :class="c.severity === 'hard' ? 'hard-badge' : 'warn-badge'">{{ c.severity === 'hard' ? '硬' : '软' }}</span>
                    <span>{{ c.message }}</span><span class="cf-fix">→ {{ c.suggestion || '—' }}</span>
                  </div>
                </div>
              </fieldset>

              <!-- 预览 + 导出(内置和自定义都有) -->
              <div class="block preview-block">
                <h3>预览(不落盘)与导出</h3>
                <div class="save-row">
                  <select v-if="!selectedPlanIsExcel" v-model="previewBatchId" class="note-input">
                    <option v-for="b in previewBatches" :key="b.id" :value="b.id">{{ b.name }}</option>
                  </select>
                  <input v-else v-model="previewWorkspaceKey" class="note-input" placeholder="月工作区,如 202607">
                  <button type="button" class="primary" :disabled="previewLoading || (selectedPlanIsExcel ? !previewWorkspaceKey.trim() : !previewBatchId)" @click="runPreview">{{ previewLoading ? '预览中…' : '预览产出' }}</button>
                  <button v-if="!planIsBuiltin" type="button" class="execute-btn" :disabled="executing || (selectedPlanIsExcel ? !previewWorkspaceKey.trim() : !previewBatchId)" @click="executePlan">{{ executing ? '导出中…' : '⬇ 执行导出' }}</button>
                </div>
                <div v-if="previewResult" class="preview-result">
                  <template v-if="previewResult.kindType === 'excel'">
                    <p class="tip">共 {{ previewResult.stats.rows }} 行 · {{ previewResult.stats.columns }} 列<span v-if="previewResult.truncated">(前200行)</span></p>
                    <div class="excel-preview">
                      <table class="mini-table">
                        <thead><tr><th v-for="h in previewResult.headers" :key="h">{{ h }}</th></tr></thead>
                        <tbody><tr v-for="(row, ri) in previewResult.rows.slice(0, 30)" :key="ri"><td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td></tr></tbody>
                      </table>
                    </div>
                  </template>
                  <template v-else>
                    <p class="tip">共 {{ previewResult.stats.entries }} 个文件 · 阻断 {{ previewResult.stats.blocked }} · 跳过 {{ previewResult.stats.skipped }}<span v-if="previewResult.truncated">(前2000)</span></p>
                    <div v-if="previewResult.blocked?.length" class="banner warn">
                      <div v-for="(b, i) in previewResult.blocked" :key="i">⛔ {{ b }}</div>
                    </div>
                    <pre class="preview-tree">{{ (previewResult.paths || []).join('\n') }}</pre>
                  </template>
                </div>
              </div>

              <details v-if="planVersions.length" class="adv">
                <summary>改动历史</summary>
                <table class="mini-table">
                  <thead><tr><th>版本</th><th>时间</th><th>人</th><th>备注</th><th /></tr></thead>
                  <tbody>
                    <tr v-for="version in planVersions" :key="version.version" :class="{ current: version.active }">
                      <td>v{{ version.version }}<span v-if="version.active" class="badge db">生效</span></td>
                      <td class="time">{{ String(version.createdAt || '').slice(0, 16).replace('T', ' ') }}</td>
                      <td>{{ version.createdBy || '—' }}</td>
                      <td class="note-cell" :title="version.note">{{ version.note || '—' }}</td>
                      <td><button v-if="!version.active" type="button" class="ghost small" @click="rollbackPlanTo(version.version)">回滚</button></td>
                    </tr>
                  </tbody>
                </table>
              </details>
            </div>
          </div>
        </template>

        <!-- ═══ 字段字典 ═══ -->
        <template v-else-if="nav === 'fields'">
          <div class="page-block">
            <h2>字段字典(只读)</h2>
            <p class="tip">配置台里所有「勾字段」只能引用这里登记过的字段。真正的新字段(识别不认/系统没有)要走工程登记,不是在这里加。</p>
            <p v-if="registryError" class="banner error">加载失败,点左侧「字段字典」重试。</p>
            <table v-else class="mini-table">
              <thead><tr><th>字段</th><th>中文名</th><th>来源</th><th>可导出</th><th>契约守卫</th><th>适用</th></tr></thead>
              <tbody>
                <tr v-for="field in registryRows" :key="field.key">
                  <td class="mono">{{ field.key }}</td>
                  <td>{{ field.label }}</td>
                  <td>{{ SOURCE_LABELS[field.source] || field.source }}</td>
                  <td>{{ field.exportable ? '✓' : '—' }}</td>
                  <td><span v-if="field.guarded" class="badge db" title="persisted/clearOnSwitch 守卫在测试里锁死">守卫中</span><span v-else class="tip">—</span></td>
                  <td class="tip">{{ (field.docTypes || []).join('、') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- ═══ 库清理(0724#3:从主导航收进配置台;组件自包含直嵌,原路由保留) ═══ -->
        <template v-else-if="nav === 'cleanup'">
          <LibraryCleanupView />
        </template>

        <!-- ═══ 帮助 ═══ -->
        <template v-else>
          <div class="page-block">
            <h2>帮助</h2>
            <div class="help-grid">
              <div class="help-col">
                <h4>三条要记住的</h4>
                <ul class="help-list">
                  <li><b>改了先预览</b>:导出计划保存后先「预览产出」,阻断清零再「执行导出」。有硬冲突会存成草稿不生效。</li>
                  <li><b>先匹配才微调</b>:模式的免审/快车道,只在票命中团号后生效;没匹配上一律按默认审。</li>
                  <li><b>随时能回头</b>:每次保存都是新版本,改坏了去「改动历史」回滚,或「回到默认」。</li>
                </ul>
              </div>
              <div class="help-col">
                <h4>详细规则文档(在 docs/)</h4>
                <ul class="help-list">
                  <li>业务规则总览:29 模式矩阵、百货 vs 小票、重复判定。</li>
                  <li>审核台字段与状态字典:每个数字/字段的含义、来源。</li>
                  <li>配置台效果图:改什么→影响什么。</li>
                </ul>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 默认必审字段抽屉(全局) -->
    <div v-if="baselineOpen" class="drawer" @click.self="baselineOpen = false">
      <div class="drawer-panel">
        <h3>所有模式的默认必审字段</h3>
        <p class="tip">这是票<b>没命中团号/没有模式微调</b>时的兜底必审集,保存后对所有在审票立即生效;保存前会算影响面并二次确认。百货票不吃这里(走百货店档案)。</p>
        <div class="row-two">
          <div v-for="base in [receiptBase, passportBase].filter(Boolean)" :key="base.docType" class="drawer-col">
            <h4>{{ base.docType === 'passport' ? '护照' : '免税店小票' }} <span class="badge" :class="base.source === 'db' ? 'db' : 'factory'">{{ base.source === 'db' ? `改过 v${base.config?.version}` : '默认' }}</span></h4>
            <div class="chk-grid">
              <label v-for="key in base.vocabulary" :key="key" class="chk" :class="{ locked: isBaseAnchor(base.docType, key) }" :title="isBaseAnchor(base.docType, key) ? '锚字段,基线不可摘除(免税店/护照号/姓名是分流与身份关键)' : ''">
                <input type="checkbox" :checked="baselineDraft[base.docType].has(key)" :disabled="isBaseAnchor(base.docType, key)" @change="toggleBaselineField(base.docType, key)"><span>{{ BASE_FIELD_LABELS[key] || key }}</span>
              </label>
            </div>
            <div class="save-row">
              <button type="button" class="primary" :disabled="baselineSaving" @click="saveBaseline(base.docType)">{{ baselineSaving ? '保存中…' : '保存(先算影响面)' }}</button>
              <button v-if="base.source === 'db'" type="button" class="danger-ghost" @click="resetBaseline(base.docType)">回到默认</button>
            </div>
          </div>
        </div>
        <div class="save-row"><button type="button" class="ghost" @click="baselineOpen = false">关闭</button></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cc { display: grid; gap: 12px; padding: 4px 2px 24px; }
.cc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cc-head h1 { margin: 0 0 4px; font-size: 22px; }
.cc-head .sub { margin: 0; color: var(--muted); font-size: 13px; }
.head-actions { display: flex; gap: 8px; align-items: center; }

.banner { border-radius: 8px; padding: 9px 12px; font-size: 13px; line-height: 1.6; }
.banner.error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
.banner.ok { background: #f8fafc; border: 1px solid #e2e8f0; color: #475569; }
.banner.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.banner.info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; }
.chip-btn { margin: 2px 4px 2px 0; border: 1px dashed #d97706; background: #fff; color: #92400e; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.chip-btn:hover { background: #fef3c7; }

/* 单一导航 */
.cc-body { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 14px; align-items: start; }
.rail { display: flex; flex-direction: column; gap: 4px; position: sticky; top: 8px; }
.rail button { display: grid; gap: 2px; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 9px; padding: 9px 11px; cursor: pointer; }
.rail button:hover { background: #f1f5f9; }
.rail button.active { background: var(--accent-weak); border-color: var(--accent); }
.rail-label { font-weight: 500; font-size: 13.5px; color: #1e293b; }
.rail button.active .rail-label { color: var(--accent); }
.rail-hint { font-size: 10.5px; color: var(--muted); line-height: 1.35; }
.rail-content { min-width: 0; display: grid; gap: 12px; }

/* 列表 + 编辑 两栏 */
/* G5(0724反馈):左栏 232→268px,长模式名(济州乐天V团特殊-道辉)不再被省略号截掉 */
.two-col { display: grid; grid-template-columns: 268px minmax(0, 1fr); gap: 14px; align-items: start; }
.list-pane { border: 1px solid var(--line); border-radius: 12px; background: #fff; padding: 8px; display: grid; gap: 4px; align-content: start; position: sticky; top: 8px; max-height: calc(100vh - 40px); overflow: auto; }
.list-head { font-size: 12px; font-weight: 500; color: var(--muted); padding: 4px 6px; }
.list-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; cursor: pointer; text-align: left; background: transparent; }
.list-item:hover { background: #f1f5f9; }
.list-item.active { background: var(--accent-weak); border-color: var(--accent); }
/* G5(0724反馈):左栏模式名取消全部加粗——一列全粗=没有重点;选中项才加重。 */
.li-name { font-weight: 400; font-size: 13px; color: #1e293b; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-item.active .li-name { font-weight: 500; }
/* 内置计划的 4 条规则目录(点击滚到右侧对应卡) */
.plan-entry { display: grid; gap: 2px; }
.plan-rules-sub { display: grid; gap: 1px; padding: 2px 0 6px 14px; border-left: 2px solid var(--accent-weak); margin: 0 0 2px 12px; }
.rule-sub { text-align: left; border: none; background: transparent; color: #475569; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; cursor: pointer; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-sub:hover { background: var(--accent-weak); color: var(--accent); }
/* 新建导出计划区:与列表分区隔开 */
.list-new-block { border-top: 1px solid var(--line); margin-top: 8px; padding: 10px 6px 4px; display: grid; gap: 8px; }
.list-new-head { font-size: 12px; font-weight: 500; color: var(--muted); }
.li-right { display: inline-flex; align-items: center; gap: 5px; }
.li-warn { cursor: help; }
.li-badge { font-size: 10px; padding: 1px 6px; border-radius: 5px; white-space: nowrap; }
.conflict-head { display: flex; gap: 8px; flex-wrap: wrap; }
.li-badge.factory { background: #f1f5f9; color: #64748b; }
/* 硬规则「蓝只给可点击」:「改过 v3」是状态徽章、点不动。
   与 .factory 同族但深一档,区分度靠明度不靠色相。 */
.li-badge.db { background: #e2e8f0; color: #334155; }
.list-new { display: flex; gap: 6px; padding: 6px; border-top: 1px solid var(--line); margin-top: 4px; }
.list-new input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-size: 12px; }
.list-new button { white-space: nowrap; border: 1px solid var(--accent); color: var(--accent); background: #fff; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 500; cursor: pointer; }
.plan-new { flex-direction: column; align-items: stretch; }
.plan-type-row { display: flex; gap: 12px; font-size: 12px; margin-bottom: 6px; }
.plan-type-row label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
.plan-new-row { display: flex; gap: 6px; }
.plan-new-row input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-size: 12px; }

.edit-pane { display: grid; gap: 12px; min-width: 0; }
.edit-body { display: grid; gap: 14px; border: 0; padding: 0; margin: 0; min-width: 0; }
.edit-body:disabled { opacity: 0.6; }
.pane-title { display: flex; align-items: center; gap: 8px; }
.pane-title h2 { margin: 0; font-size: 18px; }

/* 区块 */
.block { border: 1px solid var(--line); border-radius: 12px; background: #fff; padding: 14px 16px; display: grid; gap: 10px; }
.block h3 { margin: 0; font-size: 14px; color: #334155; }
.block h3 .summary { margin-left: 8px; color: var(--muted); font-weight: 400; font-size: 12px; }
/* 从代理视图齿轮跳进来时给「任务设置」闪一下:这页很长,滚到位了人也未必知道该看哪块。
   只闪 2.2 秒然后彻底消失——常驻高亮会变成永久噪音。 */
.focus-flash { animation: focus-flash 2.2s ease-out 1; }
@keyframes focus-flash {
  0%, 55% { box-shadow: 0 0 0 2px #2563eb, 0 0 0 6px rgba(37, 99, 235, 0.18); }
  100% { box-shadow: 0 0 0 2px rgba(37, 99, 235, 0), 0 0 0 6px rgba(37, 99, 235, 0); }
}
/* 关了动效的人也得看得见落点:不做动画,直接给一圈静态描边 */
@media (prefers-reduced-motion: reduce) {
  .focus-flash { animation: none; box-shadow: 0 0 0 2px #2563eb; }
}
/* G2:【说明】小按钮——文字链级别,不与配置控件抢眼 */
.doc-toggle {
  margin-left: 8px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: #fff; color: var(--muted); font-size: 11px; padding: 1px 9px; cursor: pointer;
}
.doc-toggle:hover { color: var(--accent); border-color: var(--accent); }
.doc-toggle[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-weak); }
.tip { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.tip.pad { padding: 20px; }

.chk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 6px; }
.chk { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 13px; cursor: pointer; background: #fafafa; }
.chk:has(input:checked) { border-color: var(--accent); background: var(--accent-weak); }
.chk input { accent-color: var(--accent); }
.chk.relaxed { opacity: 0.5; text-decoration: line-through; }
.chk.locked { cursor: not-allowed; }
.chk.locked input { cursor: not-allowed; }
.slim-toggle { grid-column: 1 / -1; max-width: 100%; }
.link-btn { justify-self: start; border: none; background: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 0; text-decoration: underline; }

.row-two { grid-template-columns: 1fr 1fr; display: grid; gap: 10px; }
.field { display: grid; gap: 4px; }
.field-label { font-size: 12px; color: var(--muted); }
.field-note { font-size: 12px; color: var(--muted); line-height: 1.5; }
.readonly-rules { padding-left: 18px; display: grid; gap: 4px; }
.req { color: #dc2626; }
.field select, .field input, .level-editor select, .level-editor input { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: #fff; }

.save-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* 门店码清单编辑(0727#6) */
.branch-rows { display: grid; gap: 6px; margin: 8px 0; }
.branch-row { display: flex; gap: 6px; align-items: center; }
.branch-code-input { width: 80px; }
.branch-name-input { width: 140px; }
.note-input { flex: 1; min-width: 160px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
button.primary { border: none; background: var(--accent); color: #fff; border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 500; cursor: pointer; }
button.primary:disabled { opacity: 0.6; cursor: wait; }
button.ghost { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer; }
button.ghost.small { padding: 3px 9px; font-size: 11px; }
button.danger-ghost { border: 1px solid #fca5a5; color: #b91c1c; background: #fff; border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; }
button.execute-btn { border: 1px solid #cbd5e1; color: #0f172a; background: #fff; border-radius: 8px; padding: 9px 14px; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
button.execute-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.badge { display: inline-block; border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 500; }
.badge.factory { background: #f1f5f9; color: #475569; }
.badge.db { background: #dbeafe; color: #1d4ed8; }
.badge.warn-badge { background: #fef3c7; color: #b45309; }
.badge.hard-badge { background: #fee2e2; color: #b91c1c; }

/* 折叠高级 */
.adv { border: 1px solid var(--line); border-radius: 10px; background: #fff; padding: 0 14px; }
.adv > summary { cursor: pointer; padding: 12px 2px; font-size: 13px; font-weight: 500; color: #475569; list-style-position: inside; }
.adv[open] > summary { border-bottom: 1px solid var(--line); margin-bottom: 12px; }
.adv > :not(summary) { margin-bottom: 12px; }

.mini-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mini-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px; border-bottom: 1px solid var(--line); }
.mini-table td { padding: 5px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
.mini-table tr.current { background: var(--accent-weak); }
.mini-table .time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.mini-table .note-cell { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }

.conflict-list { display: grid; gap: 6px; }
.conflict-row { display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; align-items: baseline; font-size: 12.5px; padding: 6px 8px; border-radius: 7px; background: #fafafa; }
.conflict-row.hard { background: #fef2f2; }
.conflict-row .cf-fix { grid-column: 2; color: var(--muted); }

.preview-block .preview-result { display: grid; gap: 8px; margin-top: 4px; }
.preview-tree { max-height: 300px; overflow: auto; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.7; }
.excel-preview { max-height: 300px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.excel-preview th, .excel-preview td { white-space: nowrap; padding: 3px 8px; }

.level-editor { display: grid; gap: 6px; }
.level-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.skin-pick { font-size: 12px; color: #334155; display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }

/* 内置规则明细 */
.builtin-spec { display: grid; gap: 10px; }
.spec-summary { margin: 0; font-size: 13px; color: #334155; background: #f8fafc; border-radius: 8px; padding: 8px 10px; }
.spec-rule { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 12px; display: grid; gap: 5px; background: #fff; }
.spec-rule-title { font-weight: 500; font-size: 13px; color: var(--accent); }
.spec-row { display: grid; grid-template-columns: 68px 1fr; gap: 8px; font-size: 12.5px; align-items: baseline; }
.spec-k { color: var(--muted); }
.spec-v.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
.spec-v.note { color: #92400e; }
.spec-fallback { font-size: 12.5px; color: #475569; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 10px; line-height: 1.7; }

/* 页面块(字段字典/帮助) */
.page-block { border: 1px solid var(--line); border-radius: 12px; background: #fff; padding: 16px 18px; display: grid; gap: 10px; }
.page-block h2 { margin: 0; font-size: 18px; }
.help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.help-col h4 { margin: 0 0 8px; font-size: 13px; }
.help-list { margin: 0; padding-left: 18px; display: grid; gap: 8px; font-size: 13px; line-height: 1.7; }

/* 抽屉 */
.drawer { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; z-index: 60; }
.drawer-panel { background: #fff; border-radius: 14px; padding: 18px 20px; max-width: 880px; width: 100%; max-height: 84vh; overflow: auto; display: grid; gap: 12px; }
.drawer-col { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px; align-content: start; }
.drawer-col h4 { margin: 0; font-size: 13px; display: flex; gap: 8px; align-items: center; }

@media (max-width: 1000px) {
  .cc-body { grid-template-columns: 1fr; }
  .rail { flex-direction: row; flex-wrap: wrap; position: static; }
  .rail button { flex: 1; min-width: 100px; }
  .two-col { grid-template-columns: 1fr; }
  .list-pane { position: static; max-height: none; }
  .help-grid { grid-template-columns: 1fr; }
}
</style>
