<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import {
  REVIEW_TIER1_TYPES,
  REVIEW_FIELD_KEYS,
  RECEIPT_STORE_OPTIONS,
  DEPT_STORE_PICK_CONFIG,
  RECEIPT_NO_LENGTH_BY_STORE,
  TOUR_NO_LENGTH_BY_STORE,
  LOTTE_DEPT_BRANCH_NAMES,
  uiTypeOf,
  deptBranchName,
  normalizeReviewDocType,
} from '../lib/reviewFieldConfig'
import {
  getReviewFieldConfigRuntime,
  buildReviewFieldPayloadRuntime,
  normalizeReviewFieldsForTaskRuntime,
  runtimeModeRelax,
  runtimeBranchOptions,
} from '../lib/runtimeReviewConfig'
import { reviewReasonFieldKey } from '../lib/reviewReasons'
import { isTaskStanceLocked, isDeptStoreValue } from '../lib/reviewDisplay'
import { fieldSignal, SIGNAL_META } from '../lib/fieldSignal'
// 直接复用后端的模式记录矩阵(纯 CJS 零依赖,单一真相源,不做前端镜像副本):
// 发小票17/18群、S活动红标签、按团号单独整理等时效性动作,审核时就要看到,
// 不能等月底导台账才在备注列发现(那时早过时效)。
// ⚠️ 已知边界(2026-07-12 Playwright 验收逼出):vite **dev 服务器**对仓库外 CJS 不做
// ESM 互操作,这行会让 ReviewView 懒加载在 `npm run dev` 下崩掉;生产构建(rollup
// commonjs 互操作)完全正常。本仓一切验证/部署走构建产物(E2E 也改跑 vite preview),
// 谁要用 dev 模式开审核页,先把这个矩阵挪成共享 ESM 再说。
import { lookupModeRecordRule, resolveCanonicalModeName } from '../../../lib/mode_record_matrix.js'
import { hasNoTourStance } from '../../../lib/no_tour.js'

const props = defineProps({
  task: {
    type: Object,
    default: null,
  },
  showSubmit: {
    type: Boolean,
    default: true,
  },
  activeFieldKey: {
    type: String,
    default: '',
  },
  // 2026-08-01:上层正在用这几个键时,本组件必须让开。
  // 病灶:本组件用 **window 捕获阶段**监听,对 1-9 一律 preventDefault+stopPropagation。
  // 捕获阶段在 window 上阻断,事件根本回不到 window 的冒泡监听 ——
  // 于是 ReviewView 里那段「重拍选择器开着时 1/2/3 直选原因」(0727反馈#10)
  // **从来没有执行过**,是死代码。
  // 实际后果:审核员照界面上的角标「模糊 1」按下 1,触发的是 selectTier1('passport'),
  // 也就是把这张小票**改成护照**。若该票已读出票号/团号,会弹出
  // 「改类型会把这些字段清空且无法恢复」——一个刚按了「1」的人很可能当成重拍确认点掉。
  hotkeysSuspended: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['on-save', 'on-field-focus', 'on-doctype-change', 'on-declare-dept', 'on-undo-no-tour', 'on-ui-type-change'])

// T2 逃生门(2026-07-21):误点「无团号·直接确认」后,「改」按钮藏在表态块里滚出视野=断头路。
// 团号字段值区常驻一键撤销(金标:全库237张表态无团号,0张OCR读到过团号——票上有号还点无=纯误触,
// 低频但必须能回头)。已通过的票由父级先恢复审核再撤销,一键两步。
const showUndoNoTour = computed(() => String(props.task?.tourStance || '') === 'none')
const fieldRefs = ref({})
const submitAttempted = ref(false)

const draft = reactive({
  docTypeFinal: 'other',
  extractedNameFinal: '',
  passportNoFinal: '',
  receiptStoreFinal: '',
  receiptNoFinal: '',
  groupNoFinal: '',
  purchaseDateFinal: '',
  departureDateFinal: '',
  // 百货真字段(P2)
  receiptAmountFinal: '',
  branchFinal: '',
  brandFinal: '',
  upstreamFinal: '',
})

const docType = computed(() => normalizeReviewDocType(draft.docTypeFinal))

// 门店码点选(0727反馈#6):清单=配置台有效清单(出厂∪增减)经 /review-config 下发;
// 拉不到回落前端出厂镜像。点码即填;文本框保留手输(新码照收,不锁死——校验只查4位数字)。
const branchChipOptions = computed(() => {
  const family = String(draft.receiptStoreFinal || '').trim()
  if (!family) return []
  const remote = runtimeBranchOptions(family)
  if (remote) return remote
  if (family === 'LOTTE_DEPT') {
    return Object.entries(LOTTE_DEPT_BRANCH_NAMES).map(([code, name]) => ({ code, name }))
  }
  return []
})
function pickBranchChip(fieldKey, code) {
  draft[fieldKey] = code
  emitFieldFocus(fieldKey)
}

// ── 一等档三档(护照/小票/百货)本地态(2026-07-13)──────────────────
// 百货底层仍是 receipt+*_DEPT 店,但 UI 抬成一等档。uiTypeOverride 记住 operator 刚点的档,
// 只在切换到"另一个任务"(task.id 变)时才清空——否则 on-doctype-change 引发的同任务重载
// 会把"我要选百货但还没选是哪家"的意图冲掉。选定百货店后 uiTypeOf 自然=dept,override 变冗余。
const uiTypeOverride = ref('')
// T1(2026-07-21 截图实锤):店家解析必须与徽章同源(Final||Auto)。此前这里只看 draft.Final——
// OCR 把乐天同框票认成百货(receiptStoreAuto=백화점系)而 Final 未选时,顶部徽章(ReviewView:256
// Final||Auto)喊「百货·免团号」,面板却按空店渲染免税店+团号必改,状态撕裂且"改不回"。
// 补 Auto 兜底后:该状态渲染「选择百货店家」三钮与徽章一致;要改小票=一等档「小票」→选免税店家落盘。
const uiType = computed(() => uiTypeOverride.value || uiTypeOf(docType.value, draft.receiptStoreFinal || props.task?.receiptStoreAuto || ''))
// 一等档意图上报(0727反馈#5):父层据它豁免票级表态锁。用显式事件而非让父层读 expose——
// 跨组件读 computed 的响应性在任务更新/重挂时不可靠(实测表态区没跟着隐),事件流没有悬念。
watch(uiType, (v) => emit('on-ui-type-change', v), { immediate: true })

// 字段面板:一等档=百货但还没选是哪家 → 只显示 3 个百货店按钮(绝不混免税店);
// 选定百货店 → 该店百货真字段(无团号/出境日期);免税小票/护照/其他照旧按 docType+店切换。
const fieldConfig = computed(() => {
  if (uiType.value === 'dept' && !isDeptStoreValue(draft.receiptStoreFinal)) {
    return DEPT_STORE_PICK_CONFIG
  }
  // P3c:渲染走运行时过滤版(店配置过才过滤;拉不到=内置常量,零变化)
  return getReviewFieldConfigRuntime(docType.value, draft.receiptStoreFinal)
})

// 一等档切换:点档即定型。护照/其他=真 docType 变(即时落盘,沿用 c554642 口径);
// 小票/百货底层同为 receipt,只清不属于本档的店家残值,docType 没变则不惊动后端(免清字段)。
let typeIntentBackup = null // 改类型确认被取消/失败时回滚用:只记 selectTier1 动过的三样

function selectTier1(nextType) {
  typeIntentBackup = {
    uiTypeOverride: uiTypeOverride.value,
    docTypeFinal: draft.docTypeFinal,
    receiptStoreFinal: draft.receiptStoreFinal,
  }
  uiTypeOverride.value = nextType
  const persistedDocType = normalizeReviewDocType(props.task?.docTypeFinal || props.task?.docTypeAuto)
  if (nextType === 'passport') {
    draft.docTypeFinal = 'passport'
  } else if (nextType === 'other') {
    draft.docTypeFinal = 'other'
  } else if (nextType === 'receipt') {
    draft.docTypeFinal = 'receipt'
    if (isDeptStoreValue(draft.receiptStoreFinal)) draft.receiptStoreFinal = '' // 从百货切回免税:清百货店
  } else if (nextType === 'dept') {
    draft.docTypeFinal = 'receipt'
    if (!isDeptStoreValue(draft.receiptStoreFinal)) draft.receiptStoreFinal = '' // 进百货:清免税店残值,逼选百货店
  }
  // 只有真 docType 变(护照/其他/首次进 receipt)才即时落盘;小票↔百货同为 receipt 不惊动后端。
  // 第二个参数是**用户在界面上选的那一档**(可能是 'dept'),而第一个是落库的 docType('receipt')。
  // 两者必须分开传(2026-08-01):否则上层只知道"变成 receipt 了",提示会说成"已改为小票",
  // 还叫人去「第一步·本票团号」匹配团号 —— 而百货根本没有团号,那是一句做不到的指引。
  if (draft.docTypeFinal !== persistedDocType) {
    emit('on-doctype-change', draft.docTypeFinal, nextType)
  }
}
const allConfigFields = computed(() => fieldConfig.value.fields)
// T4 免审可见化(2026-07-21):「记哪些列」不记的字段命中团号后服务端已免审(T3 派生),
// 前端同源折叠——visibleFields 只剩需审字段,信号/全绿/validateForSubmit 全部自动跟随
// (否则服务端放宽了、客户端本地必填仍拦确认)。值照常带过、照常保存(payload 白名单独立)。
// 折叠仅限免税店小票且命中(百货/护照/未命中不折,时序墙与后端一致);拉不到映射=不折(安全)。
const relaxFoldSet = computed(() => {
  if (uiType.value === 'dept') return new Set()
  if (docType.value !== 'receipt') return new Set()
  if (String(props.task?.groupNoMatchStatus || '') !== 'matched') return new Set()
  return new Set(runtimeModeRelax(resolveCanonicalModeName(props.task?.modeRawPre || '')))
})
const showFolded = ref(false)
const visibleFields = computed(() => allConfigFields.value.filter((field) => !relaxFoldSet.value.has(field.key)))
const foldedFields = computed(() => allConfigFields.value.filter((field) => relaxFoldSet.value.has(field.key)))
const renderFields = computed(() => (showFolded.value ? allConfigFields.value : visibleFields.value))
// 由 reviewReasons 推出"要核对的字段",在表单里高亮(操作员重点看这些)
const flaggedFieldKeys = computed(() => {
  const reasons = Array.isArray(props.task?.reviewReasons) ? props.task.reviewReasons : []
  return new Set(reasons.map(reviewReasonFieldKey).filter(Boolean))
})

// 小票号解禁(2026-07):前端不再卡票号长度/纯数字(各店差异大、金标样本不足)。
// 与后端 field_rules.RECEIPT_NO_STRICT 对应;金标够了两边一起设回 true 恢复。团号不受影响。
const RECEIPT_NO_STRICT = false

const fieldErrors = computed(() => {
  const receiptStore = draft.receiptStoreFinal.trim().toUpperCase().replace(/\s+/g, ' ')
  const receiptNo = draft.receiptNoFinal.replace(/\D/g, '')
  // 逐店逐字段查表(与后端 field_rules 两张表镜像,见 reviewFieldConfig 里的说明)。
  // 原来是「LOTTE ? 14 : 13」+ 一张合并的店名清单:既漏了后端新加的新世界团号规则,
  // 也表达不了"现代有票号长度、没有团号长度"这种逐字段差异。
  const receiptNoLength = RECEIPT_NO_LENGTH_BY_STORE[receiptStore]
  const groupNoLength = TOUR_NO_LENGTH_BY_STORE[receiptStore]
  const validStores = RECEIPT_STORE_OPTIONS.map((o) => o.value)
  // 表里没有该店 → 这个字段前端不卡长度(新店长度未定,卡了全是假警报)
  const hasReceiptLenRule = Number.isFinite(receiptNoLength)
  const hasTourLenRule = Number.isFinite(groupNoLength)

  return {
    extractedNameFinal: draft.extractedNameFinal && !/^[A-Z ]{2,50}$/i.test(draft.extractedNameFinal)
      ? '英文名只保留英文字母和空格'
      : '',
    // 国际通用:5-12 位字母或数字(兼容外国护照,如阿根廷 AAJ554634 = 3 字母+6 数字);
    // 不再写死中国护照「1-2 字母+7-8 数字」,否则外籍客人护照会被误判格式异常。
    passportNoFinal: draft.passportNoFinal && !/^[A-Za-z0-9]{6,12}$/.test(draft.passportNoFinal.replace(/\s+/g, ''))
      ? '护照号应为 6-12 位字母或数字'
      : '',
    receiptStoreFinal: draft.receiptStoreFinal && !validStores.includes(receiptStore)
      ? `免税店应为下拉里的选项(${validStores.join('、')})`
      : '',
    receiptNoFinal: (() => {
      const v = String(draft.receiptNoFinal || '').trim()
      if (!v) return ''
      // 百货票号(P3,与后端 dept_receipt_no 同口径,规则见 lib/store_profiles.js):
      if (receiptStore === 'LOTTE_DEPT') {
        // 0731 修:这里原来写死 /^\d{8}$/,报错「8位纯数字,不打-」——那是**已作废**的旧口径。
        // 权威档案 lib/store_profiles.js:54 是 { digits:8, dash:true, transNo44:true },
        // 注释直接引 0727 反馈 #13-4:「交易编号按票面 4-4 带杠存(旧「8位不打-」作废——
        // 去杠后前4位像门店编号,交付包文件名被用户当成"以门店编号命名了")」。
        // 后端 lib/workbench_task_flow.js:169 也是读档案判的(dash===false 才拒杠),
        // 只有前端这行是硬写的。
        //
        // 后果不是"提示不准":confirmAndNext → validateForSubmit 把格式错算进 invalidFields
        // 并**早退**,所以 OCR 按新口径写进来的 1001-0138 会让「确认」点了没反应,
        // 弹「请先补全字段」——乐天百货整店卡审。
        // 同一个输入框的 placeholder(reviewFieldConfig.js:132)写的还是「票面 4位-4位,带杠照抄」,
        // 提示叫他带杠、校验又骂他带杠。
        const core = v.replace(/-/g, '')
        return /^\d{8}$/.test(core) ? '' : '交易编号:8位数字,票面带杠就照抄(如 1001-0138)'
      }
      if (receiptStore === 'HYUNDAI_DEPT') {
        // 现代百货交易编号=8位数字 4-4 带杠(如 1622-0011);与 store_profiles HYUNDAI_DEPT
        // rules.receiptNo {digits:8,dash:true} 同口径。旧写死 16位是从现代免税店 BILL NO 借错的口径。
        const core = v.replace(/-/g, '')
        return /^\d{8}$/.test(core) ? '' : '现代百货交易编号:8位数字4-4带杠,如 1622-0011'
      }
      if (receiptStore === 'SHINSEGAE_DEPT') {
        return /^[\d-]*\d[\d-]*$/.test(v) ? '' : '交易编号只能是数字和-'
      }
      return RECEIPT_NO_STRICT && hasReceiptLenRule && (receiptNo !== v || receiptNo.length !== receiptNoLength)
        ? `小票号应为纯数字，${receiptStore || '所选免税店'} 需要 ${receiptNoLength} 位`
        : ''
    })(),
    // 团号:命中团号表(预匹配绿)=免格式检查;放宽允许字母(乐天R团等);长度只卡"纯数字"的
    groupNoFinal: (() => {
      const v = draft.groupNoFinal
      if (!v) return ''
      if (String(props.task?.groupNoMatchStatus || '') === 'matched') return ''
      if (v === '无' || v === '无团号') return '' // 机场票合法值(保存时归一成"无")
      if (!/^[A-Za-z0-9]+$/.test(v)) return '团号只能是字母或数字'
      if (hasTourLenRule && /^\d+$/.test(v) && v.length !== groupNoLength) {
        return `${receiptStore || '所选免税店'} 纯数字团号需要 ${groupNoLength} 位`
      }
      return ''
    })(),
    // 百货金额(P2):只填数字(保存时也会剥非数字,这里提前提示)
    receiptAmountFinal: draft.receiptAmountFinal && !/^\d+$/.test(draft.receiptAmountFinal.trim())
      ? '金额只填数字(不带逗号/货币符号)'
      : '',
  }
})

const requiredFieldErrors = computed(() => {
  if (!submitAttempted.value) {
    return {}
  }
  return Object.fromEntries(
    visibleFields.value
      .filter((field) => !field.optional && !String(draft[field.key] || '').trim())
      .map((field) => [field.key, `${field.label}不能为空`]),
  )
})

// 团号预匹配徽章:读任务上的预匹配结果(识别完/改团号保存后由后端写入)。
// 绿=命中团号表(带出模式名) 黄=未命中(团号可能认错,改完保存即重查) 灰=团号表还在解析。
const prematchBadge = computed(() => {
  if (docType.value !== 'receipt') return null
  const status = String(props.task?.groupNoMatchStatus || '')
  if (status === 'matched') {
    const mode = String(props.task?.modeRawPre || '').trim()
    return { cls: 'ok', text: `✓ 渠道模式:${mode || '已命中,表内未标注模式'}` }
  }
  if (status === 'not_found') return { cls: 'warn', text: '⚠ 团号未命中团号表 — 核对团号,改完保存即重查' }
  // 同团号多店消歧(70299病例):团号在表里,但候选模式全属别家店 → 核对店家或团号
  if (status === 'store_mismatch') {
    const modes = String(props.task?.modeStoreMismatch || '').trim()
    return { cls: 'warn', text: `⚠ 团号对得上,但表里登记的是别家店${modes ? `(${modes})` : ''} — 核对免税店或团号,改完保存自动重查` }
  }
  // 同店多代理撞号(2026-07-12 拍板):一号多模式系统绝不默取,票卡「第一步」下人选
  if (status === 'mode_ambiguous') {
    return { cls: 'warn', text: '⚠ 该团号对应多个渠道 — 在「第一步·本票团号」下方点选一个' }
  }
  if (status === 'pending_table') return { cls: 'pending', text: '… 团号表解析中,稍后自动匹配' }
  if (status === 'no_group') return { cls: 'pending', text: '机场票·无团号(照常审核结算)' }
  if (status === 'fuzzy_candidate' && props.task?.groupNoSuggestion) {
    return { cls: 'warn', text: `⚠ 表内没有此团号,但有个只差1位的:`, suggestion: String(props.task.groupNoSuggestion) }
  }
  return null
})

// 特殊模式动作提醒:命中带时效动作的模式(发小票17/18群/S活动红标签/单独整理/不用记)时,
// 在团号徽章旁亮橙色动作签。数据源=lookupModeRecordRule(矩阵内建 actions + 团号表模式串手写尾巴)。
const modeActionHints = computed(() => {
  if (docType.value !== 'receipt') return null
  // 与 prematchBadge 同口径:只信 matched 的模式(后端不匹配时本就清 mode,这里加一道本地防线)
  if (String(props.task?.groupNoMatchStatus || '') !== 'matched') return null
  const modeRaw = String(props.task?.modeRawPre || '').trim()
  if (!modeRaw) return null
  const rule = lookupModeRecordRule(modeRaw)
  const chips = [...rule.actions]
  if (rule.noRecord) chips.unshift('代理标注:不用记')
  if (!chips.length) return null
  return { chips, note: rule.note || '' }
})

// 三色信号灯:每个字段算 red/yellow/green,加快快扫。绿=可跳过,黄=瞄一眼,红=必改。
// 信号对全字段计算(复核 T4④):只算 visibleFields 时,展开折叠字段会走 signalMeta 的
// 绿色兜底=「✓通过」假绿,与其真实格式错误红文互相矛盾。全量算信号只影响展示;
// allGreen/firstNonGreenKey/validateForSubmit 三处判定仍严格基于 visibleFields,免审语义不变。
const fieldSignals = computed(() => {
  const out = {}
  for (const field of allConfigFields.value) {
    out[field.key] = fieldSignal(field.key, draft[field.key], {
      hasFormatError: Boolean(fieldErrors.value[field.key]),
      isOptional: Boolean(field.optional),
      isMachineFlagged: flaggedFieldKeys.value.has(field.key),
    })
  }
  return out
})
const allGreen = computed(() => visibleFields.value.length > 0
  && visibleFields.value.every((field) => fieldSignals.value[field.key] === 'green'))
const firstNonGreenKey = computed(
  () => (visibleFields.value.find((field) => fieldSignals.value[field.key] !== 'green') || {}).key || '',
)
// 快检没过时"是哪几个字段"(2026-07-27 设计整改:快检结果要和确认按钮闭环,
// 不能只说"没过"却不说哪没过)。最多列 3 个,多的用「等N项」收口。
const nonGreenLabels = computed(() => visibleFields.value
  .filter((field) => fieldSignals.value[field.key] !== 'green')
  .map((field) => field.label))
function signalMeta(key) { return SIGNAL_META[fieldSignals.value[key]] || SIGNAL_META.green }

const lastSyncedTaskId = ref(null)
watch(
  () => props.task,
  (task) => {
    // 只在切到"另一个任务"时清一等档意图;同任务重载(on-doctype-change 引发)保留 override。
    const nextId = task?.id ?? null
    if (nextId !== lastSyncedTaskId.value) {
      uiTypeOverride.value = ''
      lastSyncedTaskId.value = nextId
      typeIntentBackup = null // 换票即弃旧快照
    }
    // Runtime 版(断点⑥):配置补充字段的已存值也进草稿(纯出厂版会把它们清成空,面板显示丢值)
    const normalizedFields = normalizeReviewFieldsForTaskRuntime(task || {})
    draft.docTypeFinal = normalizeReviewDocType(normalizedFields.docTypeFinal)
    REVIEW_FIELD_KEYS.forEach((key) => {
      draft[key] = normalizedFields[key] || ''
    })
    // B5(2026-07-14 用户拍板):新世界百货上家固定=梁总,自动填,省一次点击
    if (draft.receiptStoreFinal === 'SHINSEGAE_DEPT' && !draft.upstreamFinal) draft.upstreamFinal = '梁总'
    submitAttempted.value = false
    // 自动跳到第一个非绿字段(红/黄):一开任务光标直奔要处理的,绿的不用扫。
    // 表态锁着时绝不抢焦点(2026-07-13 "团号打不进字"报障):字段区整个锁死,
    // 抢来的焦点只会把操作员正在敲的团号输入框光标拽走——第一步的焦点归表态块管。
    nextTick(() => {
      if (isTaskStanceLocked(props.task || {})) return
      // scroll:false——换票时面板必须纹丝不动(滚动位置由 ReviewView 统一归顶),光标静默就位
      if (firstNonGreenKey.value) focusField(firstNonGreenKey.value, { scroll: false })
    })
  },
  { immediate: true },
)

function getPayload() {
  // Runtime 版(断点⑥根修):白名单=出厂富定义∪配置补充键。此前恒出厂——配置新增字段
  // 填了值保存即被置空,后端必填又打回,死循环卡审。
  return buildReviewFieldPayloadRuntime(docType.value, draft)
}

// 改类型确认弹窗被取消/落盘失败时,父组件调它回滚本地一等档意图。
// ⚠️只回滚 selectTier1 动过的三样(意图/docType/店家)——绝不整体重建 draft:
// 整体回填会连坐抹掉操作员手改但未保存的小票号等字段(部署前复核 HIGH,静默丢编辑)。
function resetTypeIntent() {
  if (typeIntentBackup) {
    uiTypeOverride.value = typeIntentBackup.uiTypeOverride
    draft.docTypeFinal = typeIntentBackup.docTypeFinal
    draft.receiptStoreFinal = typeIntentBackup.receiptStoreFinal
    typeIntentBackup = null
    return
  }
  // 无快照兜底(理论不可达):只回 docType 意图,字段一律不动
  uiTypeOverride.value = ''
  draft.docTypeFinal = normalizeReviewDocType(props.task?.docTypeFinal || props.task?.docTypeAuto)
}

function setFieldRef(key, element) {
  if (element) {
    fieldRefs.value[key] = element
  } else {
    delete fieldRefs.value[key]
  }
}

function emitFieldFocus(key) {
  emit('on-field-focus', key)
}

// R1(2026-07-14 UI审计):团号已表态后,字段面板的团号格设只读——同一个值两处可编辑
// 会改出不一致;唯一编辑面=第一步表态块(点「改」回锁重走)。豁免票(百货/机场)无表态,照常可编。
function isFieldReadonly(key) {
  return key === 'groupNoFinal'
    && docType.value === 'receipt'
    && Boolean(String(props.task?.tourStance || '').trim())
}

function selectChoice(key, value) {
  const prev = draft[key]
  draft[key] = value
  emitFieldFocus(key)
  // 百货定型(2026-07-13):在"选百货店中"首次选定一家百货店 → 交父层原子定型 + 误切碎片恢复原图。
  // 只在"从非百货进入百货"那一下触发(改选另一家百货不重复触发,避免重复重切)。
  if (key === 'receiptStoreFinal' && isDeptStoreValue(value) && !isDeptStoreValue(prev)) {
    emit('on-declare-dept', value)
  }
  // B5:切到新世界百货即自动带出固定上家
  if (key === 'receiptStoreFinal' && value === 'SHINSEGAE_DEPT' && !draft.upstreamFinal) draft.upstreamFinal = '梁总'
}

// ── 键盘优先(2026-07-27 用户建议:热路径的瓶颈是鼠标行程,不是配色)────────────
// 文件类型 = 数字键 1..4;免税店等单选字段 = Q W E R T Y(按选项顺序,最多 6 个)。
// 只给"当前可见的第一个 choice 字段"绑字母键——同屏两个 choice 字段时不抢键,语义唯一。
// ⚠️跳过 R:R 是 ReviewView 的「重拍」全局快捷键(熟手肌肉记忆),本地捕获阶段会抢先
// 处理,若把 R 分给某个店家,按 R 就变成选店而不是标重拍 —— 实测踩到过,别再排进来。
const CHOICE_HOTKEYS = ['Q', 'W', 'E', 'T', 'Y', 'U']
const firstChoiceFieldKey = computed(
  () => (renderFields.value.find((f) => f.inputType === 'choice') || {}).key || '',
)
function choiceHotkey(fieldKey, optionIndex) {
  if (fieldKey !== firstChoiceFieldKey.value) return ''
  return CHOICE_HOTKEYS[optionIndex] || ''
}
// R 与 ReviewView 的「重拍」全局键冲突:那边只在焦点不在可编辑控件时才响应,
// 且这里 handleHotkey 会 preventDefault + stopPropagation,面板可见时以本地语义优先。
function handleHotkey(event) {
  // 上层弹出了自己的键位面板(如重拍原因选择器)时整体让开。
  // 这条必须在最前面:本组件是**捕获阶段**监听,一旦 stopPropagation,
  // 上层挂在 window 冒泡阶段的处理就永远收不到事件(0727#10 的 1/2/3 就是这么废掉的)。
  // 注意不能只跳过数字键——让开就要让干净,否则下次上层加个字母键又是同一出。
  if (props.hotkeysSuspended) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const el = event.target
  const tag = String(el?.tagName || '').toLowerCase()
  // 焦点在输入框/文本域/可编辑区里 → 让用户正常打字,不劫持
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
  const key = String(event.key || '')
  // 数字键 → 文件类型(1..3 三档 + 4 其他)
  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1
    const types = [...REVIEW_TIER1_TYPES.map((t) => t.value), 'other']
    if (idx < types.length) {
      event.preventDefault()
      event.stopPropagation()
      selectTier1(types[idx])
    }
    return
  }
  // 字母键 → 当前第一个单选字段(通常=免税店)
  const upper = key.toUpperCase()
  const slot = CHOICE_HOTKEYS.indexOf(upper)
  if (slot < 0 || !firstChoiceFieldKey.value) return
  const field = renderFields.value.find((f) => f.key === firstChoiceFieldKey.value)
  const option = (field?.options || [])[slot]
  if (!option) return
  event.preventDefault()
  event.stopPropagation()
  selectChoice(field.key, option.value)
}
onMounted(() => window.addEventListener('keydown', handleHotkey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', handleHotkey, true))

function focusField(key, { scroll = true } = {}) {
  const target = fieldRefs.value[key]
  // preventScroll + 无动画(2026-07-13):动画期间点击=打移动靶。
  // 2026-07-14 报障复发根治:**换票自动聚焦一律不滚动**(scroll:false)——
  // 三个滚动源(滚回顶部/自动聚焦scrollIntoView/浏览器补滚)竞速,每张票面板都要闪一跳,
  // 操作员瞄着「匹配」点下去落在移位后的「护照」上。滚动只留给点「确认」报错的主动定位。
  target?.focus?.({ preventScroll: true })
  if (scroll) target?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
}

function validateForSubmit() {
  submitAttempted.value = true
  // 无团号表态豁免(2026-07-20,与服务端 getTaskRequiredFieldChecks 同口径,判定单源 lib/no_tour):
  // tourStance='none'=人工背书票上没团号,团号字段免填,不再卡「必填没填」
  const noTourStance = hasNoTourStance(props.task)
  const missingFields = visibleFields.value.filter((field) => {
    if (noTourStance && field.key === 'groupNoFinal') return false
    return !field.optional && !String(draft[field.key] || '').trim()
  })
  // 只查当前可见字段:百货面板隐藏团号/出境日期,免税店面板隐藏金额——
  // 隐藏字段的残值(保存时 payload 会置空)不能卡提交
  const visibleKeys = new Set(visibleFields.value.map((field) => field.key))
  const invalidFields = Object.entries(fieldErrors.value)
    .filter(([key, message]) => Boolean(message) && visibleKeys.has(key))
    .map(([key, message]) => ({ key, message }))
  return {
    valid: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
    message: missingFields.length
      ? `还有 ${missingFields.length} 个必填字段没填`
      : (invalidFields[0]?.message || ''),
  }
}

function focusFirstInvalid() {
  const missing = visibleFields.value.find((field) => !field.optional && !String(draft[field.key] || '').trim())
  const invalid = visibleFields.value
    .map((field) => field.key)
    .find((key) => fieldErrors.value[key])
  const target = fieldRefs.value[missing?.key || invalid]
  target?.focus?.()
}

function save() {
  emit('on-save', getPayload())
}

defineExpose({
  resetTypeIntent,
  focusFirstInvalid,
  focusField,
  getPayload,
  save,
  validateForSubmit,
  allGreen,
  firstNonGreenKey,
  // 一等档意图(0727反馈#5):父层据它豁免票级表态锁——用户点了「百货」档,百货免团号,
  // 不该再被拽进「本票团号」流程(改前:护照→百货→被当小票→还得点无团号,四步冤枉路)。
  uiType,
  nonGreenLabels, // 供 ReviewView 让「确认」按钮与快检结果联动
})
</script>

<template>
  <form class="form-grid" @submit.prevent="save">
    <div class="field doc-type-field">
      <label>文件类型</label>
      <!-- 一等档三档(2026-07-13):护照/小票/百货并列,百货不再埋在"免税店按钮"里。
           其他(登机牌/包装)不占一等档、走小票的"改成其他"逃生口,避免误建。
           改类型即时落盘(沿用 c554642 口径):护照/其他 真 docType 变即时 emit,
           让新类型要求(小票→团号两步锁)当场生效;小票↔百货同为 receipt 不惊动后端。 -->
      <div class="tier1-types" role="group" aria-label="文件类型">
        <button
          v-for="(t, ti) in REVIEW_TIER1_TYPES"
          :key="t.value"
          type="button"
          class="tier1-btn"
          :class="{ active: uiType === t.value }"
          :aria-pressed="uiType === t.value"
          :title="`${t.label} — 快捷键 ${ti + 1}`"
          @click="selectTier1(t.value)"
        >
          {{ t.label }}<span class="kbd-corner" aria-hidden="true">{{ ti + 1 }}</span>
        </button>
        <button
          type="button"
          class="tier1-btn tier1-other"
          :class="{ active: uiType === 'other' }"
          :aria-pressed="uiType === 'other'"
          :title="`其他 — 快捷键 ${REVIEW_TIER1_TYPES.length + 1}`"
          @click="selectTier1('other')"
        >
          其他<span class="kbd-corner" aria-hidden="true">{{ REVIEW_TIER1_TYPES.length + 1 }}</span>
        </button>
      </div>
    </div>

    <div v-if="fieldConfig.pendingDeptStore" class="dept-pending-hint">
      选择百货店家(乐天 / 新世界 / 现代)—— 百货无团号,选定后填交易编号等真字段
    </div>

    <!-- 快检结果(2026-07-27 设计整改):从整块绿底卡片降为一行小字 —— 背景色是很重的
         强调手段,只该用在需要打断你的时候。没过时变红并**点名哪几个字段**,与底部「确认」
         按钮联动(ReviewView 据 allGreen 把确认降级为描边),信息形成闭环。 -->
    <div v-if="visibleFields.length" class="quickcheck-line" :class="allGreen ? 'ok' : 'bad'">
      <template v-if="allGreen">✓ 字段快检通过,可直接确认</template>
      <template v-else>
        ! 待核:{{ nonGreenLabels.slice(0, 3).join('、') }}<span v-if="nonGreenLabels.length > 3"> 等 {{ nonGreenLabels.length }} 项</span>
      </template>
    </div>

    <template v-if="visibleFields.length">
      <div v-for="field in renderFields" :key="field.key" class="field" :class="[signalMeta(field.key).cls, { active: activeFieldKey === field.key }, { 'field-folded-preview': relaxFoldSet.has(field.key) }]">
        <label>
          {{ field.label }}
          <span class="sig" :class="signalMeta(field.key).cls">{{ signalMeta(field.key).icon }} {{ signalMeta(field.key).label }}</span>
        </label>
        <div
          v-if="field.inputType === 'choice'"
          class="choice-field"
          role="group"
          :aria-label="field.label"
        >
          <button
            v-for="(option, optionIndex) in field.options || []"
            :key="option.value"
            :ref="(element) => optionIndex === 0 && setFieldRef(field.key, element)"
            type="button"
            class="choice-option"
            :class="{ active: draft[field.key] === option.value }"
            :aria-pressed="draft[field.key] === option.value"
            :title="choiceHotkey(field.key, optionIndex) ? `${option.label} — 快捷键 ${choiceHotkey(field.key, optionIndex)}` : option.label"
            @focus="emitFieldFocus(field.key)"
            @click="selectChoice(field.key, option.value)"
          >
            {{ option.label }}
            <span v-if="choiceHotkey(field.key, optionIndex)" class="kbd-corner" aria-hidden="true">{{ choiceHotkey(field.key, optionIndex) }}</span>
          </button>
        </div>
        <input
          v-else
          :ref="(element) => setFieldRef(field.key, element)"
          v-model="draft[field.key]"
          :type="field.inputType"
          :placeholder="field.placeholder"
          :readonly="isFieldReadonly(field.key)"
          :title="isFieldReadonly(field.key) ? '团号在「第一步·本票团号」修改(点「改」)' : ''"
          :class="{ 'input-readonly': isFieldReadonly(field.key) }"
          @focus="emitFieldFocus(field.key)"
        >
        <button
          v-if="field.key === 'groupNoFinal' && showUndoNoTour"
          type="button"
          class="ghost-button undo-no-tour-btn"
          title="撤销「无团号」表态,回到第一步输入真团号(已通过的票会先自动恢复审核)"
          @click="emit('on-undo-no-tour')"
        >
          点错了?改回真团号
        </button>
        <!-- 门店码点选(0727反馈#6):清单来自配置台(可增减),点码即填;手输入口保留(新码照收) -->
        <div v-if="field.deriveBranchName && branchChipOptions.length" class="branch-chip-row" role="group" aria-label="门店码点选">
          <button
            v-for="opt in branchChipOptions"
            :key="opt.code"
            type="button"
            class="branch-chip"
            :class="{ active: String(draft[field.key] || '').trim() === opt.code }"
            :title="opt.name ? `${opt.code} ${opt.name}(配置台可增减)` : `${opt.code}(配置台可增减)`"
            @click="pickBranchChip(field.key, opt.code)"
          >
            {{ opt.code }}<em v-if="opt.name">{{ opt.name }}</em>
          </button>
        </div>
        <!-- 门店码→免税店名(2026-07-13):填 0001 即显「明洞」;未识别码提示新码照收 -->
        <span
          v-if="field.deriveBranchName && String(draft[field.key] || '').trim()"
          class="branch-name-hint"
          :class="{ unknown: !deptBranchName(draft[field.key]) }"
        >
          {{ deptBranchName(draft[field.key]) ? `门店:${deptBranchName(draft[field.key])}` : '未识别门店(新码?已照收)' }}
        </span>
        <span v-if="requiredFieldErrors[field.key] || fieldErrors[field.key]" class="error-text">
          {{ requiredFieldErrors[field.key] || fieldErrors[field.key] }}
        </span>
        <!-- 团号预匹配徽章:识别完/改团号保存后即时反映"团号模式"(绿=命中 黄=未命中 灰=表解析中) -->
        <span v-if="field.key === 'groupNoFinal' && prematchBadge" class="prematch-badge" :class="prematchBadge.cls">
          {{ prematchBadge.text }}
          <!-- 近似纠错(金标:团号错误主形态=差1字符):表内唯一候选一键采用,填入后正常保存即重查 -->
          <button
            v-if="prematchBadge.suggestion"
            type="button"
            class="suggestion-button"
            :title="`点击把团号改为 ${prematchBadge.suggestion}(表内存在),保存后自动重新匹配`"
            @click="draft.groupNoFinal = prematchBadge.suggestion"
          >
            采用 {{ prematchBadge.suggestion }}
          </button>
        </span>
        <!-- 特殊模式动作签:该模式有时效性人工动作(发群/红标签/单独整理/不用记),审核当下就要知道 -->
        <span
          v-if="field.key === 'groupNoFinal' && modeActionHints"
          class="mode-action-chips"
          :title="modeActionHints.note"
        >
          <span v-for="chip in modeActionHints.chips" :key="chip" class="mode-action-chip">
            🔔 {{ chip }}
          </span>
        </span>
      </div>
      <!-- T4 免审折叠行:本模式不记的字段命中后自动带过,默认不占眼睛,可展开查看/修改 -->
      <div v-if="foldedFields.length" class="fold-relax-line">
        <span class="fold-relax-text">
          ⚡ 本模式不记:{{ foldedFields.map((field) => field.label).join(' / ') }}(自动带过,无需核对)
        </span>
        <button type="button" class="link-btn" @click="showFolded = !showFolded">
          {{ showFolded ? '收起' : '展开查看' }}
        </button>
      </div>
    </template>

    <div v-else class="empty other-note">
      <p class="muted">{{ fieldConfig.emptyText }}</p>
    </div>

    <div v-if="showSubmit">
      <button class="primary-button" type="submit">保存字段</button>
    </div>
  </form>
</template>

<style scoped>
.doc-type-field {
  grid-column: 1 / -1;
}

/* 一等档三档(护照/小票/百货)+ 其他:分段按钮,百货与护照/小票平级,不再埋在店家里 */
/* 单选统一样式(2026-07-27 设计整改):文件类型与免税店共用同一套观感 ——
   未选 = 细边框 + 次级灰字;已选 = 加重边框 + 浅底 + 主文本色。
   ⭐刻意不用蓝色:整个面板把蓝色**只**留给「确认」,眼睛永远知道去哪按。 */
.tier1-types {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  align-items: stretch;
}
.tier1-btn {
  position: relative;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--muted, #64748b);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color .12s, background .12s, color .12s;
}
.tier1-btn:hover { border-color: var(--line-strong, #cbd5e1); background: #f8fafc; }
.tier1-btn.active {
  border-color: #94a3b8;
  box-shadow: inset 0 0 0 1px #94a3b8; /* 用内阴影加重边框,不改盒子尺寸(免选中时跳动) */
  background: #f8fafc;
  color: var(--text);
  font-weight: 500;
}
/* 「其他」回同一网格,只是文字更淡(不再 margin-left:auto 甩最右、不再虚线) */
.tier1-other { color: #94a3b8; }
.tier1-other.active { color: var(--text); }
/* 键位角标(需求:键盘优先——热路径瓶颈是鼠标行程,不是配色) */
.kbd-corner {
  position: absolute;
  top: 1px;
  right: 3px;
  font-size: 9px;
  line-height: 1;
  color: #cbd5e1;
  font-weight: 500;
  pointer-events: none;
}
.tier1-btn.active .kbd-corner, .choice-option.active .kbd-corner { color: #94a3b8; }
.dept-pending-hint {
  grid-column: 1 / -1;
  padding: 8px 12px;
  border-radius: 8px;
  background: #eff6ff;
  border: 1px dashed #93c5fd;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 500;
}
/* 门店码→免税店名(明洞…):填了码即时显示是哪家免税店 */
.branch-name-hint {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  background: #f5f3ff;
  color: #6d28d9;
  font-size: 12px;
  font-weight: 500;
}
.branch-name-hint.unknown { background: #fef3c7; color: #b45309; }

/* 门店码点选(0727#6):码+店名小片,选中描边加重;与 choice-option 同族但更紧凑 */
.branch-chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.branch-chip {
  display: inline-flex; align-items: baseline; gap: 4px;
  padding: 2px 8px; font-size: 12px; font-weight: 500;
  border: 1px solid var(--line, #d1d5db); border-radius: 6px; background: #fff; cursor: pointer;
}
.branch-chip em { font-style: normal; font-weight: 400; font-size: 11px; color: var(--muted, #64748b); }
.branch-chip:hover { background: #f3f4f6; }
.branch-chip.active { border-color: #64748b; box-shadow: inset 0 0 0 1px #64748b; }

.other-note {
  grid-column: 1 / -1;
  padding: 16px 0;
}

.field.active label {
  color: var(--accent);
}

.field.active input,
.field.active select,
/* 当前聚焦字段里的选中项:用中性强调环,不用蓝(蓝色整块面板只留给「确认」) */
.field.active .choice-option.active {
  border-color: #64748b;
  box-shadow: inset 0 0 0 1px #64748b, 0 0 0 3px rgba(100, 116, 139, 0.16);
}

/* 团号预匹配徽章:绿=命中出模式 黄=未命中 灰=表解析中 */
.prematch-badge {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}
.prematch-badge.ok { background: #f1f5f9; color: #475569; }

.suggestion-button {
  margin-left: 6px;
  padding: 2px 10px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: #fffbeb;
  color: #b45309;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.suggestion-button:hover {
  background: #fef3c7;
}
.prematch-badge.warn { background: #fef3c7; color: #b45309; }
.prematch-badge.pending { background: #f1f5f9; color: #64748b; }

/* 特殊模式动作签:橙底描边,比普通徽章更抢眼——发群/红标签是时效动作,漏看=过时效 */
.mode-action-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; margin-left: 6px; }
.mode-action-chip {
  display: inline-block;
  padding: 2px 8px;
  border: 1.5px solid #ea580c;
  border-radius: 999px;
  background: #fff7ed;
  color: #c2410c;
  font-size: 12px;
  font-weight: 500;
}

/* 三色信号灯:绿=可跳过 黄=核对 红=必改;同时给图标(✓/!/✗)不依赖纯颜色(色盲友好) */
.sig {
  font-size: 11px;
  font-weight: 500;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  vertical-align: middle;
}
.sig.sig-green { color: #475569; background: #f1f5f9; }
.sig.sig-yellow { color: #92580a; background: #fef3c7; }
.sig.sig-red { color: #b91c1c; background: #fee2e2; }

.field.sig-yellow input,
.field.sig-yellow select {
  border-color: #f59e0b;
  background: #fffbeb;
}
.field.sig-red input,
.field.sig-red select {
  border-color: #ef4444;
  background: #fef2f2;
}
.field.sig-green input,
.field.sig-green select {
  border-color: #cbd5e1;
}

/* 快检结果:一行小字,不再是整块绿底卡片(背景色是重手段,留给真正需要打断的时候) */
.quickcheck-line {
  grid-column: 1 / -1;
  padding: 2px 0;
  font-size: 12px;
  font-weight: 500;
}
.quickcheck-line.ok { color: #475569; }
.quickcheck-line.bad { color: #b42318; }

/* 免税店改两列固定网格(2026-07-27):三列每格塞不下 "SHILLA IPARK";
   两列一行放得下、总高可控,面板内不再需要嵌套滚动条。 */
.choice-field {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

/* 与 .tier1-btn 同一套单选观感(未选=细框灰字 / 已选=加重框+浅底+主文本色),同样不用蓝 */
.choice-option {
  position: relative;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
  color: var(--muted, #64748b);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  cursor: pointer;
}

.choice-option:hover { border-color: var(--line-strong, #cbd5e1); background: #f8fafc; }

.choice-option.active {
  border-color: #94a3b8;
  box-shadow: inset 0 0 0 1px #94a3b8;
  background: #f8fafc;
  color: var(--text);
  font-weight: 500;
}

/* R1:已表态团号只读态——看得见但不可改,改去第一步表态块 */
.fold-relax-line {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #f8fafc;
  color: #64748b;
  font-size: 12px;
}
.fold-relax-line .link-btn {
  border: none;
  background: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.field-folded-preview {
  opacity: 0.55;
}

.undo-no-tour-btn {
  margin-top: 6px;
  font-size: 12px;
  padding: 4px 10px;
}

input.input-readonly {
  background: #f8fafc;
  color: #475569;
  cursor: not-allowed;
}
</style>
