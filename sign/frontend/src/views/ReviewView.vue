<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BatchSelector from '../components/BatchSelector.vue'
import FieldEditor from '../components/FieldEditor.vue'
import GroupedTaskList from '../components/GroupedTaskList.vue'
import ReceiptStanceBlock from '../components/ReceiptStanceBlock.vue'
import ImageViewer from '../components/ImageViewer.vue'
import MoreMenu from '../components/MoreMenu.vue'
import SignatureEditor from '../components/SignatureEditor.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { fetchWorkspaceCustomers } from '../api/customer'
import { createManualReceiptFromTask, setTaskDocBox, rereadTaskBox, exportBatchCustomerData, settleSourceGroup, confirmGroupModes, correctGroupLedger, resplitTask, deleteSourceGroupCustomer } from '../api/workbench'
import {
  customerIdOfTask,
  friendlyTaskName,
  isOriginalLikeTask,
  normalizeDocType,
  parseSourceReference,
  rawTaskName,
  isTaskStanceLocked,
  isTourExemptTask,
  isDeptStoreValue,
  groupHasPassport,
  sortTasksForReview,
  REPHOTO_REASONS,
} from '../lib/reviewDisplay'
import {
  taskNeedsSignaturePanel,
} from '../lib/reviewFieldConfig'
// Runtime 版 payload/草稿(断点⑥):白名单=出厂∪配置补充键,批量通过不丢配置字段值
import {
  buildReviewFieldPayloadRuntime,
  normalizeReviewFieldsForTaskRuntime,
} from '../lib/runtimeReviewConfig'
import { reviewTier } from '../lib/reviewTier'
import {
  STALE_GROUP_MESSAGE,
  sanitizeReturnTo,
  returnToLabel,
} from '../lib/agentWorkspaceLinks'
import { TOUR_MATCH_STATUS, TOUR_REMEDY_HINT } from '../lib/statusLabels'
import { toPreviewUrl, toOriginalViewUrl } from '../lib/imageUrls'
import { humanErrorMessage } from '../lib/errorMessage'
// P1 内联补救(2026-07-18):候选与补救 API 全部复用补救台同一套,禁第二副本
import { fetchModeMapping } from '../api/v2/setup'
import { fetchBatchGroupCodes } from '../api/v2/bills'
import { updateLedgerFields } from '../api/v2/ledger'
import { useWorkbenchStore } from '../stores/workbench'
import { useAuthStore } from '../stores/auth'
import ReviewCenterTabs from '../components/ReviewCenterTabs.vue'

const route = useRoute()
const router = useRouter()
const workbench = useWorkbenchStore()
const authStore = useAuthStore()
const isAdmin = computed(() => String(authStore.user?.role || '') === 'admin')
const selectedTaskId = ref('')
const selectedBatchId = ref('')
// 批次上下文内联(2026-07-26 顶部瘦身,原 BatchContextCard 的两个信息):
// 建档日期只留 MM-DD(年份在批次选择器里已有)、批次ID降级进 title 供排查。
const batchCreatedLabel = computed(() => {
  const raw = String(workbench.currentBatch?.createdAt || '')
  return raw ? raw.slice(5, 10) : ''
})
const batchIdHint = computed(() => {
  const b = workbench.currentBatch || {}
  const id = b.id || b.batchId
  return id ? `批次ID:${id}` : ''
})
// 深链回跳(代理工作台带 returnTo 进来;白名单校验,劫持路径直接丢弃)
const returnToPath = computed(() => sanitizeReturnTo(route.query.returnTo))
// 返回按钮说清楚回哪儿(0801):写死「代理工作台」的话,从资料库预检跳过来会说错地方
const returnToName = computed(() => returnToLabel(returnToPath.value))
const deepLinkStaleMessage = ref('')
// 深链定位参数由 revealDeepLink 直读 route.query(见下),此处不再留 computed 副本
// 左栏=实时队列单视图。确认站/回发已下线(2026-07-14);「本批次按代理」已下线
// (2026-07-17 用户拍板:跨批次月度代理视角由独立的代理视图 /agents 全面接管)。
// 旧深链 ?view=agent 无需特判:队列本就是唯一视图,group/task 定位参数照常生效。
const activeFieldKey = ref('')
const fieldEditorRef = ref(null)
// 百货意图豁免(0727反馈#5):表态锁 isTaskStanceLocked 只认**已落盘**的百货店值,
// 而一等档点「百货」时店家被清空待选 → 锁不认意图,把人拽进「本票团号」流程
// (护照→点百货→被当小票→还得点无团号→才见百货字段,四步冤枉路)。
// 检查器一等档=百货(FieldEditor 的 on-ui-type-change 事件上报;不读 expose——跨组件读
// computed 在任务更新/重挂时响应性不可靠,实测表态区没跟着隐)即豁免:
// 表态区隐藏、字段区解锁、确认放行——确认时百货店必填校验兜底,落盘后 isTourExemptTask
// 自然成立,链路自洽。切回「小票」档豁免即撤,锁照常;换任务时 FieldEditor 重算 uiType
// 会立即再上报(immediate watch),不残留上一张的意图。
const editorUiType = ref('')
const deptIntentActive = computed(() => editorUiType.value === 'dept')
const groupedListRef = ref(null) // 队列组件句柄:定位跳转前清搜索/筛选(revealForLocate)
const appendImageInputRef = ref(null)
const fieldScrollRef = ref(null) // 检查器字段滚动容器:换票时归零,消除表态块聚焦引起的"往上跳"
// P2-c:补完票要把人直接放进画框态,需要拿到 ImageViewer 实例
const imageViewerRef = ref(null)
const reviewActionLoading = ref('')
// 「这其实是百货」重入闸(复审 MEDIUM)+ 阶段('' | saving | restore),供忙碌横幅显示进行到哪步
const deptDeclaring = ref('')

// 全局忙碌横幅(2026-07-14 用户报障:点了改百货/重切没有任何"正在处理"反馈,以为没反应):
// 耗时操作统一在顶部亮横幅,写清正在干什么+预期时长,消失=做完了。
const BUSY_TEXT = {
  'dept:saving': '正在改成百货…',
  'dept:restore': '正在恢复整张原图并重新识别(约 10-30 秒,完成后自动定位到新票)…',
  resplit: '正在用原图重新识别切图(约 10-30 秒,完成后自动定位到新票)…',
  'manual-receipt': '正在同图补建小票记录…',
  'append-images': '正在上传追加图片并识别…',
  'confirm-high': '正在批量通过高置信任务…',
  'confirm-next': '正在确认…',
  'rephoto-next': '正在标记重拍…',
}
const busyText = computed(() => {
  if (deptDeclaring.value) return BUSY_TEXT[`dept:${deptDeclaring.value}`] || '正在处理…'
  if (reviewActionLoading.value) return BUSY_TEXT[reviewActionLoading.value] || '正在处理…'
  return ''
})
const customerNameById = ref({})
const customerNameWorkspaceKey = ref('')

const selectedTask = computed(() =>
  workbench.tasks.find((task) => task.id === selectedTaskId.value) || workbench.tasks[0] || null
)
// 后端错误带 errorDetail.taskId;若该图在当前批次则给"定位"链接,点了选中它(所在客户组会自动展开)。
// 只有组键没有 taskId 的组级错误(归档撞名等)→ 落到该组第一张,同样可跳。
const locatableErrorTask = computed(() => {
  const d = workbench.errorDetail
  if (!d) return null
  const byId = d.taskId ? workbench.tasks.find((task) => task.id === d.taskId) : null
  if (byId) return byId
  const groupKey = String(d.groupKey || '').trim()
  if (!groupKey) return null
  return workbench.tasks.find(
    (task) => (task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel || '') === groupKey
  ) || null
})
// 重复建档兜底:后端 CUSTOMER_FOLDER_EXISTS 错误带 details.groupKey+duplicateReceiptNos,
// 说明这组是"已入台账小票的第二份重复档"。给红条一个「删除这组重复客户」直删按钮。
const duplicateGroup = computed(() => {
  const d = workbench.errorDetail
  if (!d?.groupKey || !Array.isArray(d.duplicateReceiptNos) || !d.duplicateReceiptNos.length) return null
  return { groupKey: d.groupKey, groupLabel: d.groupLabel || '', receiptNos: d.duplicateReceiptNos }
})
const deletingDupGroup = ref(false)
async function deleteDuplicateGroup() {
  const dup = duplicateGroup.value
  const batchId = selectedBatchId.value
  if (!dup || !batchId || deletingDupGroup.value) return
  const label = dup.groupLabel ? `「${dup.groupLabel}」` : ''
  if (!window.confirm(
    `确认删除这组重复客户${label}?\n`
    + `小票 ${dup.receiptNos.join('、')} 的第一份已在台账,这是多出来的第二份。\n`
    + '将删除该客户文件夹及组内全部文件,不可恢复;已入台账的第一份不受影响。',
  )) return
  deletingDupGroup.value = true
  try {
    await deleteSourceGroupCustomer(batchId, dup.groupKey)
    await workbench.fetchBatch(batchId)
    workbench.setError('') // 清红条+errorDetail
    workbench.setMessage('已删除这组重复客户')
    selectedTaskId.value = workbench.tasks[0]?.id || ''
  } catch (error) {
    workbench.setError(error?.response?.data?.error || error?.message || '删除失败,请刷新重试', error?.response?.data?.details || null)
  } finally {
    deletingDupGroup.value = false
  }
}

// 「跳到某条任务」的唯一实现。2026-08-01:之前另有两处直接写 selectTask(target),
// 而这个函数全项目根本不存在 —— eslint no-undef 抓到,点下去是 ReferenceError。
// 抽出来的另一半原因:跳转不只是改 selectedTaskId,还得清筛选+兜底滚动,
// 各写各的必然漏(0fc6e4a 就是漏了清筛选)。
function focusTaskInQueue(task) {
  if (!task) return
  // 清障(体检 HIGH#2):搜索词/状态筛选可能把目标组整个滤掉 → 先清搜索+切「全部」,
  // 否则定位只切了右侧详情,左侧队列静默无事发生(0fc6e4a 症状换根因复现)。
  groupedListRef.value?.revealForLocate?.()
  selectedTaskId.value = task.id
  // 兜底滚动:重复点击时 selectedTaskId 没变化,队列组件的 watch 不会再触发滚动
  nextTick(() => {
    document.querySelector('.grouped-list .task-row.active')?.scrollIntoView?.({ block: 'nearest' })
  })
}

function locateErrorTask() {
  focusTaskInQueue(locatableErrorTask.value)
}

// 替换本批次团号表(BatchContextCard「换团号表」按钮)
const groupCodeReplaceInput = ref(null)
function triggerReplaceGroupCode() {
  groupCodeReplaceInput.value?.click()
}
async function onGroupCodeFileChange(e) {
  const file = e.target.files?.[0]
  if (e.target) e.target.value = '' // 允许重选同名文件
  if (!file) return
  if (!window.confirm('替换本批次团号表?\n\n· 结算本批次时会用新表匹配\n· 若该批次已结算过,已匹配的行需到「异常补救」重新匹配')) return
  try { await workbench.replaceBatchGroupCodeFile(file) } catch { /* store 已 setError 提示 */ }
}
// 快检结果 → 确认按钮强弱(2026-07-27 设计整改:两者要形成闭环)。
// SLIM 车道不挂 FieldEditor(免逐字段)→ 视为通过;拿不到 ref(首帧/未挂载)也不误降级。
const fieldsQuickCheckPassed = computed(() => {
  if (isSlimReceipt.value) return true
  const editor = fieldEditorRef.value
  if (!editor || editor.allGreen === undefined) return true
  return Boolean(editor.allGreen)
})
const selectedTaskFieldRegions = computed(() => (
  Array.isArray(selectedTask.value?.fieldRegions) ? selectedTask.value.fieldRegions : []
))
// 文档框(切图改框选·第1期):同一张原图上兄弟单据的框,看原图时画出来。
const selectedTaskDocRegions = computed(() => (
  Array.isArray(selectedTask.value?.docRegions) ? selectedTask.value.docRegions : []
))
// 交付护栏判定(0730):这条图会怎么进包。以前只在导出后的「导出说明.txt」里才知道,
// 顺序是反的 —— 审完、结算、导出、读那张纸、再回来找。现在审核时就摆出来。
const selectedDeliveryPlan = computed(() => selectedTask.value?.deliveryImagePlan || null)
// 全批有多少条图进不了包 —— 别让人一条条点着才发现
const blockedImageCount = computed(() => (
  (workbench.tasks || []).filter((t) => t?.deliveryImagePlan?.action === 'block').length
))
// 「去处理」= 跳到第一条被拦的任务
function gotoFirstBlockedImage() {
  const target = (workbench.tasks || []).find((t) => t?.deliveryImagePlan?.action === 'block')
  focusTaskInQueue(target)
}

// 手画文档框(0730 第2期):在原图上拖完框松手 → 落到这条任务上,交付时按它裁。
// 为什么值得单独做:一票一图护栏会拦下「同图补小票」的任务,而导出说明告诉操作员
// 「点查看原图框出各自的范围后重新导出」—— 在这之前那句话是做不到的。
async function handleDocBoxDraw(box) {
  const task = selectedTask.value
  // ⚠️ 这里原来写的是 workbench.batchId —— store 里**没有**这个键
  //(state 是 batches/currentBatch/tasks…,getter 只有 latestBatchId/metrics),
  // 恒为 undefined → 下一行当场 return → **保存请求从来没发出去过**,而且零报错。
  // 用户「我画了框,然后呢?还是显示这个」有一半是这条造成的。
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  // box=null 表示清除(画错了要能撤销);数组则是新框
  if (!task || !batchId || (box !== null && !Array.isArray(box))) return
  reviewActionLoading.value = 'doc-box'
  try {
    await setTaskDocBox(batchId, task.id, box)
    // 闭环的最后一段:框存下来之后**立刻按框重读一次**。
    // 「我画了框,然后呢」—— 之前的答案是"然后没有然后",字段还是那次切错时读的。
    // 画框的前提就是切分错了,那份字段本来就不可信。
    // 清框(box===null)不重读:那是撤销,不该反而去发一次 OCR。
    // 重读失败不算保存失败 —— 框已经存住了,那才是这次操作的主诉求。
    if (box !== null) {
      reviewActionLoading.value = 'doc-box-reread'
      try {
        const r = await rereadTaskBox(batchId, task.id)
        workbench.setMessage(r?.updated
          ? `已按框重读:${Object.keys(r.fields || {}).length} 个字段更新了建议值,请核对后确认`
          : `框已保存,但${r?.reason || '框内没读出可用字段'} —— 字段维持原样,需要手填`)
      } catch (err) {
        workbench.setMessage(`框已保存;按框重读没成功(${err?.response?.data?.error || err?.message || '未知原因'}),字段维持原样`)
      }
    }
    await workbench.fetchBatch(batchId)
  } catch (err) {
    // 后端的拒绝理由是写给操作员看的人话(框太小/框住整张图/切片坐标对不上),直接透出
    workbench.setError(err?.response?.data?.error || '保存框选失败,请重试', err?.response?.data?.details || null)
  } finally {
    reviewActionLoading.value = ''
  }
}

// 点原图上的兄弟框 → 跳到那条任务(「回找」:这块是哪张票、审到哪了)。
// 只跳当前队列里有的任务;不在队列里(已通过/已删)时不动,避免选到空。
function handleDocRegionSelect(taskId) {
  if (!taskId) return
  const target = (workbench.tasks || []).find((t) => t.id === taskId)
  focusTaskInQueue(target)
}
// 当前任务是裁出的子图时,供 ImageViewer「查看原图」切换。
// 数据源两层:①同组"原图"兄弟任务(旧 paddle 流程会带);②qwen 流程原图 reference 不进批次 →
// 走后端 original-image 端点回溯客户库切分前完整原图(2026-07-06 切边补救:右缘团号被裁掉时
// 数据其实没丢——字段从整图抽取——只是切片上看不到,点「查看原图」即可核对)。
// ⚠️ 这里原来自己回溯,用的是 taskGroupKey ——**客户级**键
// (sourceGroupKey/sourceFolderPath)。同一个客户底下可能有多张照片,
// 于是会回溯到**别的照片**:人在照片 X 上画框、坐标存到照片 Y 的任务上,
// 交付按错框裁 Y,全程零报错。
// 正确口径是每张照片级的 originalGroupKeyOf,现在由后端算好下发(lib/task_original_image),
// 前端只消费,不再有第二份回溯逻辑。
const selectedOriginalImageUrl = computed(() => selectedTask.value?.originalImageUrl || '')
// 这条任务本身就是整张照片 —— 它恰恰是后端唯一允许画框的那一类,
// 而它的 originalImageUrl 是空的。只认 URL 就会「能画的地方没按钮」。
const selectedIsOriginalImage = computed(() => Boolean(selectedTask.value?.isOriginalImage))
const selectedGroupKey = computed(() => (
  selectedTask.value?.sourceGroupKey
  || selectedTask.value?.sourceFolderPath
  || selectedTask.value?.sourceGroupLabel
  || ''
))

function taskGroupKey(task = {}) {
  return task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel || ''
}
// 当前客户组里"高置信、未审、非原图参考"的待办任务(可一键批量通过)
const highTierPendingTasks = computed(() => {
  const key = selectedGroupKey.value
  if (!key) return []
  return (workbench.tasks || []).filter((task) => (
    taskGroupKey(task) === key
    && !task.reviewed
    && !task.rephotoRequested
    && !isOriginalLikeTask(task)
    && reviewTier(task) === 'high'
    // 票级两步流(B1):未表态小票不许被批量通过绕闸——先匹配/无团号表态才有资格。
    && !isTaskStanceLocked(task)
  ))
})

// 一键通过本组所有高置信文档:用 auto 值落 final + reviewed;留中/低档给操作员逐张看。
async function confirmHighTierInGroup() {
  const tasks = highTierPendingTasks.value
  if (!tasks.length || reviewActionLoading.value) return
  if (!window.confirm(`确认通过本组 ${tasks.length} 张高置信文档?(中/低档仍保留给你逐张审。)`)) return
  reviewActionLoading.value = 'confirm-high'
  try {
    for (const task of tasks) {
      const draft = normalizeReviewFieldsForTaskRuntime(task)
      const payload = buildReviewFieldPayloadRuntime(draft.docTypeFinal, draft)
      await workbench.updateTask(task.id, { ...payload, reviewed: true })
    }
    // 对齐 confirmAndNext(审计MEDIUM):此前只 autoApproveGroupIfReady(纯通过)→ 开着「确认即结算」
    // 时组通过却停在未结算、无模式面板、零提示。改为复用 confirmAndNext 同一条链(同函数,不改
    // confirmAndNext 本身,零回归):整组审完 + 合并结算开 → 内联结算出模式;团号表未就绪则退回
    // 仅通过并提示;合并关/组未审完则仅通过。
    const groupKey = selectedGroupKey.value
    const groupReady = canAutoApproveGroup(groupKey)
    if (groupReady && mergeSettleOnConfirm.value) {
      if (settledGroupKeys.value.has(groupKey)) {
        workbench.setMessage('本组已结算')
        return
      }
      if (['parsing', 'awaiting_upload'].includes(workbench.currentBatch?.groupCodeStatus)) {
        const r = await autoApproveGroupIfReady(groupKey)
        if (r.error) workbench.setError(errorMessageOf(r.error), r.error?.response?.data?.details || null)
        else workbench.setMessage('已确认并通过。团号表还没就绪,就绪后在「更多」菜单点「手动结算本组」出模式')
        return
      }
      const settle = await settleGroupInline(groupKey)
      if (!settle.settled) workbench.setError(settle.reason, settle.details || null)
      return
    }
    const groupResult = await autoApproveGroupIfReady(groupKey)
    if (groupResult.error) workbench.setError(errorMessageOf(groupResult.error), groupResult.error?.response?.data?.details || null)
  } finally {
    reviewActionLoading.value = ''
  }
}

const sourceWorkspaceKey = computed(() => {
  for (const task of workbench.tasks || []) {
    const reference = parseSourceReference(task)
    if (reference.workspaceKey) {
      return reference.workspaceKey
    }
  }
  return ''
})

// 检查器标题常显模式(用户拍板:无论识别结果/是否需审,都在此显示这张票的处理路数)。
const inspectorModeText = computed(() => {
  const t = selectedTask.value
  if (!t || normalizeDocType(t) !== 'receipt') return ''
  if (isDeptStoreValue(t.receiptStoreFinal || t.receiptStoreAuto)) return '百货 · 免团号'
  const v = String(t.groupNoFinal || t.groupNoAuto || '').trim()
  // 表态优先于字面量:none 表态会自动回填「无」(写入层汇流),先判表态才能保住「人工确认」标签
  if (t.tourStance === 'none') return '无团号(人工确认)'
  if (v === '无') return '机场票 · 无团号'
  const mode = String(t.modeRawPre || '').trim()
  const stanced = String(t.tourStance || '').trim()
  if (mode) return stanced ? mode : `${mode} · 待匹配确认`
  if (stanced && String(t.groupNoMatchStatus || '') === 'not_found') return '表内暂无·换表自动复核'
  return '待匹配团号'
})

const showSignaturePanel = computed(() => taskNeedsSignaturePanel(selectedTask.value))
const selectedTaskIndex = computed(() => workbench.tasks.findIndex((task) => task.id === selectedTask.value?.id))
const selectedTaskFriendlyName = computed(() => {
  if (!selectedTask.value) return '未选择文件'
  return friendlyTaskName(selectedTask.value, sequenceWithinGroup(selectedTask.value))
})
// 本批进度唯一真相源:done/total/pending 三个数一处算,头部数字与进度条同源
// (2026-07-13 轻量化:删掉曾并存的 current=数组位置——与待处理数撞数造成 714/716 误读)。
const reviewFlowStats = computed(() => {
  const total = workbench.tasks.length
  const done = workbench.tasks.filter((task) => isTaskDone(task)).length
  return {
    total,
    done,
    pending: Math.max(0, total - done),
  }
})
const isBatchReviewComplete = computed(() => (
  workbench.tasks.length > 0 && reviewFlowStats.value.pending === 0
))

const selectedGroupReference = computed(() => {
  if (!selectedTask.value) {
    return { workspaceKey: '', customerId: '' }
  }
  const reference = parseSourceReference(selectedTask.value)
  return {
    workspaceKey: reference.workspaceKey || sourceWorkspaceKey.value,
    customerId: reference.customerId || customerIdOfTask(selectedTask.value),
  }
})

async function loadBatch() {
  if (!workbench.batches.length) {
    await workbench.fetchBatches()
  }
  const batchId = workbench.resolveBatchId(route.params.batchId)
  selectedBatchId.value = batchId
  // 任务流:换批次清预加载缓存与会话历史(规格九.4/十六.6——旧批次的痕迹不许带进新批次)
  prefetchedUrls.clear()
  visitHistory.value = []
  await workbench.fetchBatch(batchId)
  // 深链 ?view= 参数已无页签可切(单视图,2026-07-17「本批次按代理」下线):忽略即可,
  // 旧链接照常落队列,group/task 定位参数在下方继续生效。
  // 重进批次默认定位到第一张「待处理」图,而不是 tasks[0](可能是已通过的第一张,
  // 落在已通过图上继续编辑会覆盖已通过记录)。isTaskDone 认 reviewed/approved。
  // 从建档「审核」按钮带 ?group=customerId 进来时,直接定位到这个客户组(闭环导航)。
  const groupParam = String(route.query.group || '').trim()
  let groupPreselectId = ''
  // 无条件先清(复审 HIGH:切到不带 ?group 的新批次时横幅不许残留),命中判断再置
  deepLinkStaleMessage.value = ''
  if (groupParam) {
    const groupTasks = workbench.tasks.filter((task) => taskGroupKey(task) === groupParam)
    groupPreselectId = (groupTasks.find((task) => !isTaskDone(task)) || groupTasks[0])?.id || ''
    // stale 深链:组不存在(被结算/移动)→ 显式提示,不静默跳到别的客户(V2 红线)
    if (!groupTasks.length) deepLinkStaleMessage.value = STALE_GROUP_MESSAGE
  }
  const firstPendingId = orderedTasks.value.find((task) => !isTaskDone(task))?.id
  selectedTaskId.value = groupPreselectId
    || (workbench.tasks.some((task) => task.id === selectedTaskId.value)
      ? selectedTaskId.value
      : (firstPendingId || workbench.tasks[0]?.id || ''))
  await loadReviewCustomerNames()
}

async function loadReviewCustomerNames() {
  const workspaceKey = sourceWorkspaceKey.value
  if (!workspaceKey || workspaceKey === customerNameWorkspaceKey.value) {
    return
  }
  try {
    const payload = await fetchWorkspaceCustomers(workspaceKey)
    const next = {}
    for (const record of payload.customers || payload.items || []) {
      const customerId = String(record.customerId || record.id || '').trim()
      const displayName = String(
        record.displayName
        || record.finalName
        || record.agentName
        || record.name
        || record.folderNameFinal
        || record.folderNameInitial
        || ''
      ).trim()
      if (customerId && displayName) {
        next[customerId] = displayName
      }
    }
    customerNameById.value = next
    customerNameWorkspaceKey.value = workspaceKey
  } catch {
    customerNameById.value = {}
    customerNameWorkspaceKey.value = workspaceKey
  }
}

function changeBatch(batchId) {
  if (!batchId || batchId === route.params.batchId) {
    return
  }
  remedyNotice.value = 0 // 承接提示属于产生它的批次,切批即清
  router.push({ name: 'review', params: { batchId } })
}

async function saveFields(payload) {
  if (!selectedTask.value) {
    return
  }
  await workbench.updateTask(selectedTask.value.id, payload)
  workbench.setMessage('字段已保存')
}

// 改文件类型立即落盘(2026-07-13「其他→小票」补救):只发 docTypeFinal,后端清残留+重派状态,
// 就地刷新任务 → 小票会重新出现「第一步·团号」两步锁(误分类修回来后不再跳过团号匹配)。
// uiPick = 用户在界面上点的那一档('receipt' | 'dept' | 'passport' | 'other'),
// nextType = 落库的 docType(百货也是 receipt)。提示要按 uiPick 说,别按落库值说。
async function changeDocType(nextType, uiPick = '') {
  const task = selectedTask.value
  const next = normalizeDocType(nextType)
  if (!task || !next || next === normalizeDocType(task)) return // 没真变,别空写
  // 误点兜底(2026-07-13):改类型会清空该票所有 OCR 字段且不可逆——已识别出关键字段的票先确认一道。
  // 与 ReceiptStanceBlock.retype 同口径,堵住 FieldEditor 一等档/下拉这个同类改类型入口。
  const hasData = ['receiptNoFinal', 'receiptNoAuto', 'groupNoFinal', 'groupNoAuto', 'receiptStoreFinal', 'receiptStoreAuto']
    .some((k) => String(task?.[k] || '').trim())
  if (hasData && !window.confirm('这张票已识别出小票号/团号等字段,改类型会把这些字段清空且无法恢复。确定要改吗?')) {
    // 取消=回滚面板本地已切的一等档意图,否则字段区停在目标档看着"全没了"(2026-07-14 视频报障)
    fieldEditorRef.value?.resetTypeIntent?.()
    return
  }
  try {
    await workbench.updateTask(task.id, { docTypeFinal: nextType })
    // ⭐按**用户点的那一档**说话(2026-08-01)。百货落库也是 receipt,原来只看 next
    // → 选百货会被告知"已改为小票,请先匹配团号",而百货无团号,那一步根本没有,
    // 人照着找会找不到(核账报告点名的"界面在说假话"之一)。
    const pick = uiPick === 'dept' ? 'dept' : next
    const label = { receipt: '小票', dept: '百货票', passport: '护照', other: '其他' }[pick] || '新类型'
    workbench.setMessage(pick === 'receipt'
      ? `已改为${label},请先在「第一步·本票团号」匹配团号(或点「无团号」)`
      : (pick === 'dept'
        ? `已改为${label},请先选百货店家(百货无团号,不需要匹配团号)`
        : `已改为${label}`))
  } catch (error) {
    fieldEditorRef.value?.resetTypeIntent?.() // 落盘失败同样回滚,面板回真实档
    workbench.setError(error?.response?.data?.error || error?.message || '改类型失败,请重试', error?.response?.data?.details || null)
  }
}

function setActiveReviewField(key) {
  activeFieldKey.value = key || ''
}

async function focusReviewField(key) {
  activeFieldKey.value = key || ''
  await nextTick()
  fieldEditorRef.value?.focusField?.(key)
}

function isTaskDone(task = {}) {
  const processResult = String(task.processResult || '').trim()
  const reviewStatus = String(task.reviewStatus || '').trim()
  return Boolean(task.reviewed)
    || Boolean(task.rephotoRequested)
    || processResult === 'approved'
    || processResult.includes('通过')
    || processResult.includes('拒绝')
    || reviewStatus.includes('拒绝')
}

function groupKeyOfTask(task = {}) {
  return task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel || ''
}

function tasksForGroup(groupKey) {
  const normalizedGroupKey = String(groupKey || '').trim()
  if (!normalizedGroupKey) return []
  return (workbench.tasks || []).filter((task) => groupKeyOfTask(task) === normalizedGroupKey)
}

function isTaskApprovedForGroup(task = {}) {
  if (task.rephotoRequested) return false
  const processResult = String(task.processResult || '').trim()
  return Boolean(task.reviewed)
    || processResult === 'approved'
    || processResult.includes('通过')
}

function canAutoApproveGroup(groupKey) {
  const groupTasks = tasksForGroup(groupKey)
  return groupTasks.length > 0 && groupTasks.every((task) => isTaskApprovedForGroup(task))
}

async function autoApproveGroupIfReady(groupKey) {
  if (!canAutoApproveGroup(groupKey)) {
    return { ready: false, approved: false, error: null }
  }
  try {
    await workbench.approveGroup(groupKey)
    return { ready: true, approved: true, error: null }
  } catch (error) {
    // 不要静默吞错:自动成组失败(权限不足 403 / 后端错误)必须让用户知道,
    // 否则用户以为已通过、实际组没成,数据停在未审批且零提示。
    return { ready: true, approved: false, error }
  }
}

// Enter流/上下张的遍历序:组的出现顺序不变,组内按 护照→小票→其它(原图殿后)。
// 只影响导航与显示,不动存储顺序(切图命名依赖原始顺序,前科)。
const orderedTasks = computed(() => {
  const groups = new Map()
  for (const task of workbench.tasks || []) {
    const key = taskGroupKey(task) || task.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(task)
  }
  const out = []
  for (const list of groups.values()) out.push(...sortTasksForReview(list))
  return out
})

function findAdjacentTaskId(fromTaskId, direction = 1, { pendingOnly = false } = {}) {
  const tasks = orderedTasks.value || []
  if (!tasks.length) return ''
  const startIndex = Math.max(0, tasks.findIndex((task) => task.id === fromTaskId))
  for (
    let index = startIndex + direction;
    index >= 0 && index < tasks.length;
    index += direction
  ) {
    if (!pendingOnly || !isTaskDone(tasks[index])) {
      return tasks[index].id
    }
  }
  return ''
}

function sequenceWithinGroup(task) {
  if (!task || isOriginalLikeTask(task)) return 1
  const type = normalizeDocType(task)
  let count = 0
  const groupKey = task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel || ''
  for (const item of workbench.tasks || []) {
    const itemGroupKey = item.sourceGroupKey || item.sourceFolderPath || item.sourceGroupLabel || ''
    if (groupKey && itemGroupKey !== groupKey) continue
    if (isOriginalLikeTask(item)) continue
    if (normalizeDocType(item) === type) {
      count += 1
    }
    if (item.id === task.id) {
      return Math.max(1, count)
    }
  }
  return 1
}

// ── 任务流(2026-07-27):队列顺序 / 会话历史 / 自动推进开关 / 预加载 ──────────
// 队列组件上报的顺序(当前筛选+排序下展平的任务id)。确认后的"下一张"沿着**它**走,
// 不再走存储顺序 —— 改造前你按「异常优先」排了队,确认后却跳去存储序的下一张,队列白排。
const queueOrder = ref({ taskIds: [], groupKeys: [] })
function onQueueChange(payload) {
  queueOrder.value = payload && Array.isArray(payload.taskIds) ? payload : { taskIds: [], groupKeys: [] }
}

// ‹ i/N › 计数(2026-07-28 参考图对齐:导航挪到面板头,数据在这层自算——
// groupKeys 是队列组件按当前筛选+排序上报的,selectedGroupKey 是本层的,谁都不用多传)。
const queueNavText = computed(() => {
  const keys = queueOrder.value.groupKeys || []
  const idx = keys.indexOf(selectedGroupKey.value)
  // ✓ = 当前组已完成、被"默认只看待办"隐藏,不在队列里(「—」读着像坏了,0728 用户截图)
  return `${idx >= 0 ? idx + 1 : '✓'}/${keys.length}`
})

// 自动推进开关(规格八):默认开;关掉后确认只保存不切换(记 localStorage)。
const autoAdvance = ref((() => {
  try { return localStorage.getItem('reviewAutoAdvance') !== '0' } catch { return true }
})())
watch(autoAdvance, (v) => {
  try { localStorage.setItem('reviewAutoAdvance', v ? '1' : '0') } catch { /* 忽略 */ }
})

// 队列序推进:优先沿 queueOrder 找下一张待处理;当前任务不在队列里(被筛掉/搜索态确认了
// 队列外的任务)→ 回落存储序,绝不因为筛选把人堵死。
function findNextInQueue(fromTaskId, direction = 1, { pendingOnly = true } = {}) {
  const ids = queueOrder.value.taskIds
  if (!ids.length) return ''
  const byId = new Map((workbench.tasks || []).map((t) => [t.id, t]))
  const start = ids.indexOf(fromTaskId)
  if (start < 0) return ''
  for (let i = start + direction; i >= 0 && i < ids.length; i += direction) {
    const task = byId.get(ids[i])
    if (!task) continue
    if (!pendingOnly || !isTaskDone(task)) return task.id
  }
  return ''
}

// 返回值原来是布尔,而 false 有**两个完全不同的原因**:①队列真的空了 ②你把「自动下一组」关了。
// 调用方拿到 false 一律说"队列已完成"——于是关掉开关之后,每审完一组都被告知队列完成了
// (2026-08-01 修,核账报告点名的"界面在说假话"之一)。改成返回原因,让文案能说对话。
// 'moved' 跳了 | 'stopped' 开关关着,停在原地 | 'exhausted' 真没有下一组了
function moveAfterFlowAction(taskId, { pendingOnly = true } = {}) {
  if (!autoAdvance.value) return 'stopped' // 开关关:确认后停在原地(规格八.8)
  const nextId = findNextInQueue(taskId, 1, { pendingOnly }) || findAdjacentTaskId(taskId, 1, { pendingOnly })
  if (nextId) {
    selectedTaskId.value = nextId
    return 'moved'
  }
  // 2026-08-01:往后扫不到**不等于**队列空了 —— 前面可能还有一堆待办。
  // 原来直接喊「当前队列已完成」,而右上角同时写着「待处理 37」。
  // 真实场景:审核员为了先处理某个催得急的客户,点到队列靠后的一组审完,
  // 界面就告诉他"本批次已处理完",还把他往「切换筛选/批次」引 —— 越走越远,
  // 前面那些没审的整批漏掉。标重拍那条路的提示还不会被后续消息覆盖,
  // 留在屏幕上的就是这句假话。
  // 回头再扫一遍:找得到就跳回去,并在文案里说清"回到前面去了",
  // 免得人以为界面自己乱跳。
  const backId = findNextInQueue(taskId, -1, { pendingOnly })
    || findAdjacentTaskId(taskId, -1, { pendingOnly })
  if (backId) {
    selectedTaskId.value = backId
    return 'wrapped'
  }
  workbench.setMessage('当前队列已完成 —— 可切换筛选/批次,或打开「显示已完成」回看。')
  return 'exhausted'
}
// 给上面四种结果配一句尾巴,调用方拼在自己的主语后面
function afterFlowTail(outcome) {
  if (outcome === 'moved') return '已跳到下一组'
  if (outcome === 'stopped') return '「自动下一组」是关着的,停在本组'
  // 'wrapped':后面没有了,但前面还有 —— 必须说清是往回跳的,否则看起来像乱跳
  if (outcome === 'wrapped') return '后面没有待处理的了,已跳回前面还没审的那组'
  return '队列已完成'
}

// 上一组(规格十五):回**本次会话最近处理过的组**,不是数组索引减一。已完成的组也能回看
// (回看不把它塞回待办队列 —— 队列显隐由筛选决定,选中不改变状态)。
const visitHistory = ref([])
watch(selectedTaskId, (id, prev) => {
  if (!prev) return
  const last = visitHistory.value[visitHistory.value.length - 1]
  if (last === prev) return
  visitHistory.value.push(prev)
  if (visitHistory.value.length > 80) visitHistory.value.shift()
})

function goPrevGroup() {
  // 弹历史直到找到仍存在的任务(可能被删)
  while (visitHistory.value.length) {
    const id = visitHistory.value.pop()
    if ((workbench.tasks || []).some((t) => t.id === id)) {
      selectedTaskId.value = id
      return
    }
  }
  workbench.setMessage('没有更早的浏览记录了')
}

function goNextGroup() {
  // 手动下一组:跳到**下一组**的第一张待处理(跳过本组剩余任务;想逐张走用 Enter 确认流)
  const currentKey = selectedGroupKey.value
  const ids = queueOrder.value.taskIds
  const byId = new Map((workbench.tasks || []).map((t) => [t.id, t]))
  const start = Math.max(0, ids.indexOf(selectedTaskId.value))
  for (let i = start + 1; i < ids.length; i += 1) {
    const task = byId.get(ids[i])
    if (!task || taskGroupKey(task) === currentKey) continue
    selectedTaskId.value = task.id
    return
  }
  workbench.setMessage('已经是队列里最后一组了')
}

// 下一组预加载(规格九):选中变化后把队列里**后面 2 个组**的图片 URL 交给浏览器缓存。
// 只做 Image 预热(任务字段本来就全在前端);去重 Set 防重复请求;换批次清空。
const prefetchedUrls = new Set()
function prefetchNextGroups() {
  const ids = queueOrder.value.taskIds
  const byId = new Map((workbench.tasks || []).map((t) => [t.id, t]))
  const start = ids.indexOf(selectedTaskId.value)
  if (start < 0) return
  const currentKey = selectedGroupKey.value
  const groupsSeen = new Set()
  for (let i = start + 1; i < ids.length && groupsSeen.size <= 2; i += 1) {
    const task = byId.get(ids[i])
    if (!task) continue
    const key = taskGroupKey(task)
    if (key === currentKey) continue
    groupsSeen.add(key)
    if (groupsSeen.size > 2) break
    // ⭐热的必须是**查看器真正会加载的那个 URL**(0731 修):P1 主态翻转把默认视图换成了
    // 整张原图(task.originalImageUrl),而这里原来只热切片的 imageUrl/sourceImageUrl ——
    // 预热的图没人看,要看的图没预热,窄带宽白烧一遍,正是 0727#11 要治的那个病。
    // URL 规则统一从 lib/imageUrls 取,两边同一个函数,不再靠注释约定"URL 一致"。
    const warm = [
      task.originalImageUrl ? toOriginalViewUrl(task.originalImageUrl) : '',
      ...[task.imageUrl, task.sourceImageUrl].map((u) => (u ? toPreviewUrl(u) : '')),
    ]
    for (const url of warm) {
      if (!url) continue
      if (prefetchedUrls.has(url)) continue
      prefetchedUrls.add(url)
      const img = new Image()
      img.decoding = 'async'
      img.src = url // 失败无所谓:预热失败不影响当前任务,正式加载时会重试
    }
  }
}
watch(selectedTaskId, () => { requestAnimationFrame(() => prefetchNextGroups()) })

async function confirmAndNext() {
  if (!selectedTask.value) return
  // 票级两步流:未表态小票禁确认(先匹配团号或点「无团号」;豁免票不受此限)。
  // deptIntentActive(0727反馈#5):用户已把一等档切到「百货」= 免团号意图明确,不再拦。
  if (isTaskStanceLocked(selectedTask.value) && !deptIntentActive.value) {
    workbench.setError('先表态本票团号:匹配一个号,或确认「无团号」')
    return
  }
  // SLIM 车道:FieldEditor 未挂载(免逐字段),按"归属确认"直接通过;服务端必填集同口径为空。
  if (!isSlimReceipt.value && !fieldEditorRef.value) return
  if (!isSlimReceipt.value) {
    const validation = fieldEditorRef.value.validateForSubmit()
    if (!validation.valid) {
      workbench.setError(validation.message || '请先补全字段')
      await nextTick()
      fieldEditorRef.value.focusFirstInvalid()
      return
    }
  }
  const taskId = selectedTask.value.id
  const groupKey = selectedGroupKey.value
  reviewActionLoading.value = 'confirm-next'
  try {
    await workbench.updateTask(taskId, {
      ...(isSlimReceipt.value ? {} : fieldEditorRef.value.getPayload()),
      reviewed: true,
    })

    // 组内最后一张确认后是否整组审完(updateTask 已就地更新 workbench.tasks)。
    const groupReady = canAutoApproveGroup(groupKey)

    // ── 确认合并结算:整组审完 + 合并开 → 自动 通过+单组团号匹配,即时出模式 ──
    if (groupReady && mergeSettleOnConfirm.value) {
      // 护栏:本组已结算过(面板背景关掉后重复点确认)→ 不再重复结算,提示+跳下一组。
      if (settledGroupKeys.value.has(groupKey)) {
        workbench.setMessage('本组已结算,继续下一组')
        moveAfterFlowAction(taskId, { pendingOnly: true })
        return
      }
      // 降级②(结算闸):团号表还没就绪(解析中/声明了还没传上来)→ 结算会被拦,退回"仅通过",绝不卡确认。
      if (['parsing', 'awaiting_upload'].includes(workbench.currentBatch?.groupCodeStatus)) {
        const r = await autoApproveGroupIfReady(groupKey)
        if (r.error) workbench.setError(errorMessageOf(r.error), r.error?.response?.data?.details || null)
        else workbench.setMessage('已确认并通过。团号表还没就绪,就绪后在「更多」菜单点「手动结算本组」出模式')
        moveAfterFlowAction(taskId, { pendingOnly: true })
        return
      }
      // 正常:内联结算 → 弹模式面板(操作员在面板确认渠道模式/去补救,不自动跳)。
      // 百货纯组例外(0727反馈#2):面板无可核内容 → 不弹,自动确认渠道模式+跳下一组。
      const deptDirect = isDeptOnlyGroup(groupKey)
      const settle = await settleGroupInline(groupKey, { panel: !deptDirect })
      if (!settle.settled) {
        // 降级①(precheck 失败:重拍/护照数):任务已确认,给可读原因,继续审下一组。
        // details 必须跟着传:setError 默认 detail=null,这里裸传 reason 会把
        // settleGroupInline 刚存的定位信息覆盖清空(2026-07-12 报障根因之一)。
        workbench.setError(settle.reason, settle.details || null)
        moveAfterFlowAction(taskId, { pendingOnly: true })
        return
      }
      if (deptDirect) {
        const res = settle.res || {}
        // 护栏:S活动要人工背书、needs_remedy/入账被去重跳过要人看见 → 这些都回退面板路径。
        const hasSActivity = (res.settledReceipts || []).some((r) => String(r.modeRaw || '').includes('S活动'))
        const canDirect = !hasSActivity && ['needs_confirm', 'settled'].includes(String(res.settlementStatus || ''))
        if (!canDirect) {
          settleResult.value = res // 意外形态,弹面板让操作员亲眼看
          return
        }
        try {
          if (res.settlementStatus === 'needs_confirm') {
            const confirmed = await confirmGroupModes(selectedBatchId.value, groupKey)
            stampLocalGroupSettlement(groupKey, confirmed?.settlementStatus || 'settled')
          }
          const outcome = moveAfterFlowAction(taskId, { pendingOnly: true })
          workbench.setMessage(
            `百货组已结算入台账(入月 ${res.insertedRows ?? 0} 张),${afterFlowTail(outcome)}`,
          )
        } catch (error) {
          // 自动确认失败 → 退回面板人工路径,绝不静默(组已结算,只是模式确认没落)。
          settleResult.value = res
          workbench.setError(
            error?.response?.data?.error || error?.message || '自动确认渠道模式失败,请在面板手动确认',
            error?.response?.data?.details || null,
          )
        }
      }
      return
    }

    // ── 灰度关 / 组未审完:确认(+ 合并关时整组审完仅通过)+ 跳下一张 ──
    const groupResult = mergeSettleOnConfirm.value
      ? { ready: false, approved: false, error: null } // 合并开但组没审完:纯确认跳下一张
      : await autoApproveGroupIfReady(groupKey) // 合并关:旧行为(整组审完仅通过)
    const outcome = moveAfterFlowAction(taskId, { pendingOnly: true })
    if (groupResult.error) {
      // 组通过失败(缺护照/GROUP_APPROVAL_INVALID 等)后端带 details.taskId → 横幅可定位
      workbench.setError(errorMessageOf(groupResult.error), groupResult.error?.response?.data?.details || null)
    } else if (groupResult.approved) {
      // 尾巴一律走 afterFlowTail:这两处原来各拼一份三态判断,
      // 于是新增 'wrapped' 之后会掉进「本批次已处理完」那一支 —— 又变回说假话。
      // (而且此前已经因为各写一份漏改过一次:那次 `moved` 变量都不存在了,
      //  走到就 ReferenceError,是 lint 的 no-undef 抓到的。)
      workbench.setMessage(`当前客户组已全部通过,${afterFlowTail(outcome)}`)
    } else {
      workbench.setMessage(`已确认,${afterFlowTail(outcome)}`)
    }
  } finally {
    reviewActionLoading.value = ''
  }
}

// 走共用出口(2026-08-01):后端有中文就用中文;后端没来得及回话时(断网/超时/502)
// 不再把 axios 的英文原样吐给审核员 —— 那正是最常见、也最看不懂的一类失败。
function errorMessageOf(error) {
  return humanErrorMessage(error, '操作失败')
}

// 重拍分键选择(0727反馈#10):点「重拍」/按 R 先弹三键(模糊/缺/其他),选了原因才真标——
// 前台补拍时能直接看到为什么重拍,不用回头问审核员。
const rephotoPickerOpen = ref(false)
watch(selectedTaskId, () => { rephotoPickerOpen.value = false }) // 换任务不留残影选择器
async function markRephotoAndNext(reason = '') {
  if (!selectedTask.value) return
  if (!reason) {
    rephotoPickerOpen.value = !rephotoPickerOpen.value // R/点按钮=开关选择器,不直接标
    return
  }
  rephotoPickerOpen.value = false
  const taskId = selectedTask.value.id
  reviewActionLoading.value = 'rephoto-next'
  try {
    await workbench.markTaskRephoto(taskId, reason)
    moveAfterFlowAction(taskId, { pendingOnly: true })
  } finally {
    reviewActionLoading.value = ''
  }
}


// ── 流式逐客户「通过并结算」(与批次级「结算本批次」并存)──
const settleResult = ref(null)
// 确认渠道模式后是否自动跳回建档页(用户反馈:审核时跳走浪费时间 → 默认否,勾选记住)。
const autoBackToIntake = ref(localStorage.getItem('autoBackToIntake') === 'true')
watch(autoBackToIntake, (v) => { try { localStorage.setItem('autoBackToIntake', v ? 'true' : 'false') } catch { /* 忽略 */ } })

// SLIM 车道判定(P4):车道由服务端 applyComputedFields 下发,前端不复制 ENV 白名单。
const isSlimReceipt = computed(() => selectedTask.value?.reviewLane === 'slim')
// S活动强制背书(P4):结算面板模式含 S活动 → 必须勾"红标签已处理"才能确认渠道模式。
const sActivityAcked = ref(false)
// 行上字段是 modeRaw(readSettledReceipts 白名单),原 r.mode 永远 undefined → 背书永不触发(2026-07-18 修)
const settleHasSActivity = computed(() => (settleResult.value?.settledReceipts || []).some((r) => String(r.modeRaw || '').includes('S活动')))
watch(settleResult, () => { sActivityAcked.value = false })
const settleLoading = ref(false)
const confirmLoading = ref(false)

// 确认合并结算(2026-07-08):组内最后一张点「确认」→ 自动 通过审核+单组团号匹配,即时出模式,
// 焊住"审完→结算→补救"的断层。灰度开关默认开,出问题可关(退回旧的"确认仅通过"两步流);
// 手动「通过并结算」按钮保留为退路(「客户组通过」已删,合并后冗余)。
const MERGE_SETTLE_PREF_KEY = 'sign.reviewMergeSettleOnConfirm'
const mergeSettleOnConfirm = ref((() => {
  try { return localStorage.getItem(MERGE_SETTLE_PREF_KEY) !== '0' } catch { return true }
})())
watch(mergeSettleOnConfirm, (v) => {
  try { localStorage.setItem(MERGE_SETTLE_PREF_KEY, v ? '1' : '0') } catch { /* 无痕模式忽略 */ }
})

const currentGroupTasks = computed(() => {
  const key = selectedGroupKey.value
  if (!key) return []
  return (workbench.tasks || []).filter((task) => taskGroupKey(task) === key)
})

// 组级结算状态映射(P2):sourceGroupKey → { settlementStatus, settledAt },喂给组列表徽章。
// 后端结算/确认模式时盖到 batch.sourceGroups(增量合并/fetchBatch 后即最新)。
const groupSettlementByKey = computed(() => {
  const out = {}
  for (const g of (workbench.currentBatch?.sourceGroups || [])) {
    const key = String(g?.key || '').trim()
    if (key) out[key] = { settlementStatus: g.settlementStatus || '', settledAt: g.settledAt || '' }
  }
  return out
})
// 有重拍 → 不能结算(审核员应标重拍跳过,等补图)。徽标/按钮据此禁用。
const currentGroupHasRephoto = computed(() => currentGroupTasks.value.some((t) => t.rephotoRequested))
// 本组所有图都审完(reviewed/approved/重拍 都算"处理过")才可结算。
const currentGroupReady = computed(() => (
  currentGroupTasks.value.length > 0 && currentGroupTasks.value.every((t) => isTaskDone(t))
))
const settleDisabledReason = computed(() => {
  if (!selectedGroupKey.value) return '请先选中一个客户组'
  if (workbench.currentBatch?.groupCodeStatus === 'parsing') return '团号表还在后台解析,稍等再结算'
  if (workbench.currentBatch?.groupCodeStatus === 'awaiting_upload') return '团号表还没上传完成,传完解析后再结算'
  if (currentGroupHasRephoto.value) return '本组有重拍,补图后再结算'
  if (!currentGroupReady.value) return '本组还有图没审完'
  return ''
})

const PRECHECK_LABELS = {
  rephoto_requested: '本组有重拍,先处理重拍再结算',
  invalid_passport_count: '本组护照不是 1 本,先把护照分类/数量处理对',
  no_tasks: '本组没有可结算的内容',
}
function isReceiptMatched(r) { return r.tourMatchStatus === 'matched' }
// 「待归类」≠ 没匹配上:团号在团号表里已命中、模式已带出(modeRaw 有值),只是该模式还没
// 在账单管理"选模式进桶"。旧 UI 把它也标"未命中"且不显示模式名 → 操作员误以为团号没匹配。
function isReceiptModeFound(r) {
  return r.tourMatchStatus === 'matched'
    || (r.tourMatchStatus === 'skipped_mode_not_required' && String(r.modeRaw || '').trim())
}
function receiptModeText(r) {
  if (isReceiptMatched(r)) return r.modeRaw || '已命中'
  if (isReceiptModeFound(r)) return `${r.modeRaw}(已出模式·待归类交付)`
  return TOUR_MATCH_STATUS[r.tourMatchStatus] || r.tourMatchStatus
}
function receiptChip(r) {
  if (isReceiptMatched(r)) return { cls: 'ok', text: '已匹配' }
  if (isReceiptModeFound(r)) return { cls: 'mid', text: '待归类交付' }
  return { cls: 'warn', text: '未命中' }
}

// ── P1 内联补救(2026-07-18 拍板):未命中行在面板内当场救,不再跳补救台排队。
// 模式类=选模式/手填 → PATCH {modeRaw, manualRemedyConfirm}(与补救台 submitMode 完全同构);
// 日期类=改日期+人工背书放行 → PATCH {purchaseDate, manualRemedyConfirm}(跨月自动迁移由后端处理);
// 「稍后处理」=纯关面板,行进补救台托底(needs_remedy 已在结算时持久化,徽章持续提醒)。
const MODE_REMEDY_STATUSES = new Set(['tour_not_found', 'tour_ambiguous', 'tour_store_mismatch', 'agent_mismatch', 'mode_unresolved'])
const DATE_REMEDY_STATUSES = new Set(['date_out_of_window', 'date_missing'])
function remedyKindOf(r) {
  if (MODE_REMEDY_STATUSES.has(r?.tourMatchStatus)) return 'mode'
  if (DATE_REMEDY_STATUSES.has(r?.tourMatchStatus)) return 'date'
  return ''
}
const remedyDrafts = reactive({})      // 行id → { mode, manual, date }
const remedyDone = reactive({})        // 行id → 'matched' | 'migrated:<目标月>'
const remedySavingId = ref(null)
const remedyError = ref('')
const remedyModeOptions = ref([])      // 工作区全量模式池(mode-mapping,兜底候选,与补救台同源)
const remedyTourCandidates = ref({})   // tourNo → 批次团号表候选模式(精准优先)
const lastRemedy = ref(null)           // 最近一次成功的模式补救(供"应用到其余同团号同店")

function remedyDraftOf(r) {
  if (!remedyDrafts[r.id]) {
    remedyDrafts[r.id] = { mode: '', manual: '', date: String(r.purchaseDate || '').slice(0, 10) }
  }
  return remedyDrafts[r.id]
}
function remedyCandidatesFor(r) {
  const fromTour = remedyTourCandidates.value[String(r.tourNo || '').trim()] || []
  const seen = new Set()
  const out = []
  for (const m of [...fromTour, ...remedyModeOptions.value]) {
    const v = String(m || '').trim()
    if (v && !seen.has(v)) { seen.add(v); out.push(v) }
  }
  return out
}
// 未救完的未命中行(迁移走的行不算——它在目标月重验,不阻塞本月收口)
const remedyOutstanding = computed(() => (settleResult.value?.settledReceipts || [])
  .filter((r) => r.id && remedyKindOf(r) && !remedyDone[r.id]))
// "应用到其余":同团号+同店的模式类未救行(客户组可跨店/跨团号,收窄防错桶)
const sameGroupRemaining = computed(() => {
  const last = lastRemedy.value
  if (!last) return []
  return remedyOutstanding.value.filter((r) => remedyKindOf(r) === 'mode'
    && String(r.tourNo || '').trim() === last.tourNo && String(r.shop || '').trim() === last.shop)
})

// 面板弹出即预拉候选:全量池按涉及工作区,团号候选按未命中行 tourNo(批次团号表,与复查弹窗同源)。
// generation token(复核MEDIUM):关面板→快速结算下一组时,慢返回的旧候选不许覆盖新组的池。
let remedyFetchGen = 0
watch(settleResult, async (res) => {
  const gen = ++remedyFetchGen
  remedyError.value = ''
  lastRemedy.value = null
  Object.keys(remedyDrafts).forEach((k) => delete remedyDrafts[k])
  Object.keys(remedyDone).forEach((k) => delete remedyDone[k])
  const rows = (res?.settledReceipts || []).filter((r) => r.id && remedyKindOf(r))
  if (!rows.length) return
  const wsKeys = [...new Set(rows.map((r) => String(r.workspaceKey || '').trim()).filter(Boolean))]
  const modeSet = new Set()
  await Promise.all(wsKeys.map(async (ws) => {
    try {
      const mm = await fetchModeMapping(ws)
      for (const it of (mm?.items || [])) { const m = it.modeRaw ?? it.mode_raw; if (m) modeSet.add(String(m)) }
      for (const u of (mm?.unmapped || [])) { const v = typeof u === 'string' ? u : (u?.modeRaw ?? u?.mode_raw); if (v) modeSet.add(String(v)) }
    } catch { /* 工作区暂无模式 → 空池 */ }
  }))
  if (gen !== remedyFetchGen) return // 面板已切走,旧响应整包丢弃
  remedyModeOptions.value = [...modeSet].sort()
  const tours = [...new Set(rows.map((r) => String(r.tourNo || '').trim()).filter(Boolean))]
  const batchId = selectedBatchId.value
  const primaryWs = wsKeys[0] || ''
  const byTour = {}
  await Promise.all(tours.map(async (tourNo) => {
    try {
      const payload = await fetchBatchGroupCodes(primaryWs, { batchId, tourNo })
      byTour[tourNo] = [...new Set((payload?.rows || []).map((g) => String(g.mode || '').trim()).filter(Boolean))]
    } catch { byTour[tourNo] = [] }
  }))
  if (gen !== remedyFetchGen) return
  remedyTourCandidates.value = byTour
})

async function confirmRemedyRow(r) {
  if (remedySavingId.value) return
  const draft = remedyDraftOf(r)
  const kind = remedyKindOf(r)
  const payload = { manualRemedyConfirm: true }
  if (kind === 'mode') {
    const modeRaw = String(draft.manual || draft.mode || '').trim()
    if (!modeRaw) { remedyError.value = '先选一个模式或手填'; return }
    payload.modeRaw = modeRaw
  } else {
    const date = String(draft.date || '').trim()
    if (!date) { remedyError.value = '先填购买日期(确认=人工核实该票属此团期,直接放行)'; return }
    payload.purchaseDate = date
  }
  remedySavingId.value = r.id
  remedyError.value = ''
  try {
    const res = await updateLedgerFields(r.workspaceKey, r.id, payload)
    if (res?.migrated) {
      // 跨月日期:后端把行迁到目标月置 pending 重验,本月不再有这行
      remedyDone[r.id] = `migrated:${res.targetWorkspaceKey || ''}`
      r.tourMatchStatus = 'pending'
    } else {
      remedyDone[r.id] = 'matched'
      r.tourMatchStatus = 'matched'
      if (payload.modeRaw) r.modeRaw = payload.modeRaw
      if (payload.purchaseDate) r.purchaseDate = payload.purchaseDate
      if (kind === 'mode') {
        lastRemedy.value = { modeRaw: payload.modeRaw, tourNo: String(r.tourNo || '').trim(), shop: String(r.shop || '').trim() }
      }
    }
    await maybeAutoConfirmAfterRemedy()
  } catch (error) {
    remedyError.value = error?.response?.data?.error || error?.message || '补救失败,请重试'
  } finally {
    remedySavingId.value = null
  }
}

async function applyLastRemedyToRest() {
  const last = lastRemedy.value
  if (!last) return
  for (const r of [...sameGroupRemaining.value]) {
    const draft = remedyDraftOf(r)
    draft.manual = last.modeRaw
    draft.mode = ''
    await confirmRemedyRow(r)
    if (remedyError.value) break // 一张失败即停,别静默连环错
  }
}

// 全部未命中救完(或迁移走)→ 自动确认渠道模式收口:状态翻 settled、组徽章即时变。
// 有 S活动 时仍要人工勾背书 → 切到 needs_confirm 分支让操作员点确认。
async function maybeAutoConfirmAfterRemedy() {
  if (remedyOutstanding.value.length) return
  if (settleHasSActivity.value && !sActivityAcked.value) {
    // 属性赋值而非整对象替换:watch(settleResult) 是浅监听,替换对象会重跑预拉并清空
    // remedyDone(救过的行又变回补救区);改属性只驱动模板,不触发 watch。
    if (settleResult.value) settleResult.value.settlementStatus = 'needs_confirm'
    workbench.setMessage('未命中已全部补救——勾选 S活动红标签确认后点「确认」收口')
    return
  }
  await confirmCurrentGroupModes()
}

// 结算 precheck 失败返 422→axios 抛错;从错误体里挖出可读原因(reason→PRECHECK_LABELS)。
function extractSettleReason(error) {
  const data = error?.response?.data
  if (data?.reason) return PRECHECK_LABELS[data.reason] || data.error || '结算被拦截'
  return data?.error || error?.message || '结算失败'
}

// 结算并发护栏(reviewer HIGH):确认合并结算 + 手动「通过并结算」两条路都可能对同一组写台账/批次;
// 结算在飞时(网络往返 0.5~2s)另一个按钮点下去会二次并发。settleInFlightGroup=正在结算的 groupKey,据此互斥。
const settleInFlightGroup = ref('')
// 已结算的组(本会话):防结算面板被点背景关掉后,同一张已 reviewed 的最后一张再点确认
// → 重复结算(后端有去重会自愈,但白跑一趟);恢复审核会让组不再 ready,自然允许重结算。
const settledGroupKeys = ref(new Set())

// 结算/确认模式成功后,把组级 settlementStatus 就地盖到本地 currentBatch.sourceGroups,
// 让实时队列徽章无需整批 refetch 即刻变"已结算/待确认/待补救"(后端也已盖章,刷新一致)。
function stampLocalGroupSettlement(groupKey, settlementStatus) {
  const groups = workbench.currentBatch?.sourceGroups
  if (!Array.isArray(groups)) return
  const g = groups.find((x) => String(x?.key || '').trim() === String(groupKey || '').trim())
  if (g) {
    g.settlementStatus = String(settlementStatus || '')
    g.settledAt = new Date().toISOString()
  }
}

// 百货直通组(0727反馈#2):组内小票全为百货 → 免团号、渠道模式=审核时已人工选的店,
// 结算面板没有可核内容(行行都是「团号 — → 百货店」)。这种组结算后跳过面板,
// 自动确认渠道模式并沿队列跳下一组;混组(百货+免税小票)仍走面板。
function isDeptOnlyGroup(groupKey) {
  const receipts = tasksForGroup(groupKey).filter((t) => normalizeDocType(t) === 'receipt')
  return receipts.length > 0
    && receipts.every((t) => isDeptStoreValue(t.receiptStoreFinal || t.receiptStoreAuto))
}

// 内联结算(供「确认合并结算」复用):成功→弹模式面板并返回 {settled:true, res};
// precheck 拦截/失败→返回 {settled:false, reason}(不弹面板,由调用方决定提示+跳转)。
// panel:false(百货直通,0727反馈#2)= 结算成功不弹面板,res 交调用方自行收口。
async function settleGroupInline(groupKey, { panel = true } = {}) {
  settleInFlightGroup.value = groupKey
  try {
    const res = await settleSourceGroup(selectedBatchId.value, groupKey)
    if (res?.ok === false) {
      // details(嫌疑张 taskId)跟着 reason 一路带回,调用方 setError 才能出「定位到这张图」
      return { settled: false, reason: PRECHECK_LABELS[res.reason] || res.error || '结算被拦截', details: res.details || null }
    }
    if (panel) settleResult.value = res // 弹模式面板,操作员在面板上确认渠道模式/去补救
    settledGroupKeys.value.add(groupKey)
    stampLocalGroupSettlement(groupKey, res.settlementStatus)
    return { settled: true, res }
  } catch (error) {
    // 重复建档/台账超范围等带定位信息的 409/400:details 必须随 reason 一路带回调用方——
    // 2026-07-12 报障:这里 setError(带 details)后,调用方降级提示 setError(reason) 的
    // 默认 detail=null 会把 errorDetail 覆盖清空,「定位到这张图」按钮闪都没闪就没了。
    const data = error?.response?.data
    if (data?.details?.taskId) workbench.setError(data.error || '结算被拦截', data.details)
    return { settled: false, reason: extractSettleReason(error), details: data?.details || null }
  } finally {
    settleInFlightGroup.value = ''
  }
}

async function settleCurrentGroup() {
  const groupKey = selectedGroupKey.value
  const batchId = selectedBatchId.value
  // 护栏:该组结算已在飞(可能由「确认」触发)→ 不重复发。
  if (!groupKey || !batchId || settleDisabledReason.value || settleLoading.value
    || settleInFlightGroup.value === groupKey) return
  settleLoading.value = true
  settleInFlightGroup.value = groupKey
  try {
    const res = await settleSourceGroup(batchId, groupKey)
    if (res?.ok === false) {
      workbench.setError(PRECHECK_LABELS[res.reason] || res.error || '结算被拦截', res.details || null)
      return
    }
    settleResult.value = res
    settledGroupKeys.value.add(groupKey)
    stampLocalGroupSettlement(groupKey, res.settlementStatus) // 徽章即时变(与合并流一致)
  } catch (error) {
    // 结算 precheck 失败后端返 422(重拍/护照数不对),axios 当错误抛到这里——
    // body 里是 { reason },不是 { error }。映射成可读原因(今天报障已修)。
    // details 同步带上(2026-07-12 报障:台账"超范围"错误带 taskId 定位信息,
    // 这条路之前丢弃 → 横幅只有文字没有「定位到这张图」,操作员找不到是哪张)。
    workbench.setError(extractSettleReason(error), error?.response?.data?.details || null)
  } finally {
    settleLoading.value = false
    settleInFlightGroup.value = ''
  }
}

// 台账侧订正(admin,2026-07-21 交付修改#10「删不掉」):撤销已结算组台账 → 组回可编辑态。
// 原因必填(审计留痕);成功后本地撤结算章并刷新批次(sourceGroups 已被后端清章)。
const ledgerCorrectionLoading = ref(false)
async function correctLedgerCurrentGroup() {
  const groupKey = selectedGroupKey.value
  const batchId = selectedBatchId.value
  if (!groupKey || !batchId || ledgerCorrectionLoading.value) return
  const reason = window.prompt('台账订正原因(必填,进审计日志):', '')
  if (reason === null) return // 取消
  if (!String(reason).trim()) { workbench.setError('订正原因必填'); return }
  if (!window.confirm('确认撤销本组结算台账?台账行将删除(快照留审计),组回到可编辑/可删除状态。')) return
  ledgerCorrectionLoading.value = true
  try {
    const res = await correctGroupLedger(batchId, groupKey, String(reason).trim())
    settledGroupKeys.value.delete(groupKey)
    workbench.setMessage(`台账已订正:撤销 ${res?.removedRows ?? 0} 行台账,本组已回到可编辑状态`)
    await workbench.fetchBatch(batchId) // 组级章已清,刷新徽章/面板
  } catch (error) {
    workbench.setError(error?.response?.data?.error || '台账订正失败', error?.response?.data?.details || null)
  } finally {
    ledgerCorrectionLoading.value = false
  }
}

async function confirmCurrentGroupModes() {
  const groupKey = selectedGroupKey.value
  const batchId = selectedBatchId.value
  if (!groupKey || !batchId || confirmLoading.value) return
  confirmLoading.value = true
  try {
    const res = await confirmGroupModes(batchId, groupKey)
    stampLocalGroupSettlement(groupKey, res?.settlementStatus || 'settled')
    settleResult.value = null
    // 用户反馈:审核时自动跳回建档很浪费时间 → 变可选(默认留在审核页,勾选后记住)。
    if (autoBackToIntake.value) {
      workbench.setMessage('已确认渠道模式,本客户结算完成')
      backToIntake()
    } else {
      // 0727反馈#2:确认收口后自动沿队列推进(尊重「自动下一组」开关,关=留在原地)。
      const outcome = moveAfterFlowAction(selectedTaskId.value, { pendingOnly: true })
      // 统一走 afterFlowTail(别再自己判 outcome):新增一种结果时,
      // 自己判的地方会静默掉进"else"那支,把新情况说成旧情况。
      workbench.setMessage(`已确认渠道模式,本客户结算完成,${afterFlowTail(outcome)}`)
    }
  } catch (error) {
    workbench.setError(
      error?.response?.data?.error || error?.message || '确认失败',
      error?.response?.data?.details || null, // 带定位信息的错误照样出「定位到这张图」
    )
  } finally {
    confirmLoading.value = false
  }
}

// P2 精准落位(2026-07-18 设计):去补救台带 批次+客户 参数,补救台直达该客户的待补救行
// (batch=ws::batchId 预选批次卡,customer=sourceCustomerId 只看该客户)。
function remedyDeepLink(ws, batchId, groupKey) {
  const w = String(ws || '').trim()
  if (!w) return '/daily/remedy'
  const query = {}
  if (String(batchId || '').trim()) query.batch = `${w}::${batchId}`
  if (String(groupKey || '').trim()) query.customer = String(groupKey)
  return { path: `/daily/remedy/${encodeURIComponent(w)}`, query }
}
function goRemedyForSettle() {
  const ws = settleResult.value?.affectedWorkspaces?.[0]
  router.push(remedyDeepLink(ws, selectedBatchId.value, selectedGroupKey.value))
}
// 客户组「待补救」徽章点击(GroupedTaskList emit):同款深链,批次月份取 currentBatch。
function goRemedyForGroup(group) {
  const ws = workbench.currentBatch?.monthlyWorkspaceKey
  router.push(remedyDeepLink(ws, selectedBatchId.value, group?.key))
}
function closeSettle() { settleResult.value = null }
// 闭环导航最后一段:结算确认后回建档,继续采集下一个客户。
function backToIntake() { router.push({ name: 'intake' }) }

// 波2 承接提示(0728#2,image96 三类提示统一写法):导台账产生待补救不再弹确认框
// 打断,改常驻琥珀提示行(下一步工作流可随时点,不逼当场决定)。
const remedyNotice = ref(0)
async function importLedgerAndMatch() {
  if (!window.confirm('结算本批次？\n\n把已通过、非重拍、有小票的客户组写进收票台账，并自动跑团号匹配；\n没匹配上或日期对不上的,会进「异常补救」等人处理。')) return
  const payload = await workbench.importLedgerAndMatch()
  remedyNotice.value = countLedgerImportRemedyItems(payload)
}

function countLedgerImportRemedyItems(payload = {}) {
  const results = Array.isArray(payload.tourMatchResults) && payload.tourMatchResults.length
    ? payload.tourMatchResults
    : [payload.tourMatch || {}]
  return results.reduce((sum, item) => sum
    + Number(item.tourNotFound || 0)
    + Number(item.dateOutOfWindow || 0)
    + Number(item.agentMismatch || 0)
    + Number(item.modeUnresolved || 0), 0)
}

async function restoreTask() {
  if (selectedTask.value) {
    const groupKey = groupKeyOfTask(selectedTask.value)
    await workbench.restoreTask(selectedTask.value.id)
    // 恢复审核 → 组不再"全审完",清掉"已结算"标记,改完后允许再次确认结算。
    if (groupKey) settledGroupKeys.value.delete(groupKey)
  }
}

// T2 逃生门(2026-07-21):误点「无团号·直接确认」的一键回头路。
// 已通过的票先恢复审核(复用 restoreTask,含清结算标记),再撤销表态——
// 写入层会把哨兵团号「无」回滚成空(no_tour 单测锁死),表态块回到第一步待输入。
async function undoNoTourStance() {
  const task = selectedTask.value
  if (!task) return
  try {
    if (task.reviewed) await restoreTask()
    await workbench.updateTask(task.id, { tourStance: '' })
    workbench.setMessage('已撤销「无团号」——请在第一步输入本票真团号')
  } catch (error) {
    workbench.setError(error?.response?.data?.error || error?.message || '撤销失败')
  }
}

async function deleteSelectedTask() {
  if (!selectedTask.value) return
  // 弹窗要说清三件事(2026-08-01):删哪一张、删了回不来、以及"回不来"具体是什么意思。
  // 原文案只有"确认删除当前文件?" —— 既没说是哪张(菜单里点的,视线不在图上),
  // 也没说这是硬删:services/workbench_write/task.js 的 deleteTask 会摘任务+删文件,
  // 还写墓碑 deletedSourcePaths,以后补图/追加同客户时这个来源会被**跳过**,不会自己回来。
  const label = selectedTaskFriendlyName.value || selectedTask.value.id
  const confirmed = window.confirm(
    `确认删除「${label}」?\n\n`
    + '删除是不可逆的:图片文件会一起删掉,而且以后补图/追加同一个客户时,\n'
    + '这张图不会自己回来(系统会记住它被删过)。要找回只能重新导入或传一张新图。\n\n'
    + '如果你是想"换一条更好的",建议先把新的那条建好、验过,再回来删这条。',
  )
  if (!confirmed) return
  const currentIndex = workbench.tasks.findIndex((task) => task.id === selectedTask.value.id)
  await workbench.deleteTask(selectedTask.value.id)
  selectedTaskId.value = workbench.tasks[currentIndex]?.id || workbench.tasks[currentIndex - 1]?.id || workbench.tasks[0]?.id || ''
}

function triggerAppendImages() {
  if (!selectedTask.value) {
    workbench.setError('请先选择客户组内的一张图片')
    return
  }
  appendImageInputRef.value?.click()
}

// 「同图补一条小票」(2026-07-06 漏切人工兜底):一张图两张票只出了一条记录时,
// 同图追加一条空白小票记录,照图手填。新记录建好后自动选中,直接进字段面板。
async function addReceiptOnSameImage() {
  const task = selectedTask.value
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  if (!task || !batchId) {
    workbench.setError('请先选择客户组内的一张图片')
    return
  }
  // 话术跟着 P2-a / P2-b 改:以前补出来的是"一条空白记录、请照图手填",
  // 现在补出来的那条指向**整张原图**、能画框、画完还会自动按框重读。
  // 说明书和实际不符,人就会按旧说明书办事 —— 手填一遍本来能读出来的东西。
  if (!window.confirm(
    '这张图里还有一张票没有生成记录?\n\n'
    + '将基于这张图补一条记录,并自动进入画框态:\n'
    + '· 在整张原图上框出那张漏掉的票\n'
    + '· 松手后系统会按框重读票面字段,你核对确认即可\n'
    + '· 读不出来时字段留空,照图手填'
  )) return
  reviewActionLoading.value = 'manual-receipt'
  try {
    const { data } = await createManualReceiptFromTask(batchId, task.id)
    const newTaskId = String(data?.taskId || '')
    // 已结算组补票:后端已撤章,前端同步清 settledGroupKeys,新票才能再走确认结算入台账
    // (否则被「本组已结算」拦下,8模块审计 HIGH)。
    const reopened = String(data?.reopenedGroupKey || '')
    if (reopened) settledGroupKeys.value.delete(reopened)
    await workbench.fetchBatch(batchId)
    if (newTaskId) {
      selectedTaskId.value = newTaskId
      // 等新任务的图渲染出来再进画框态,否则开关翻了、图还没换,人看着像没反应。
      await nextTick()
      const entered = imageViewerRef.value?.enterDrawMode?.()
      // 2026-08-01:原来这里写着「进不去就静默算了 —— 票已经补上了,那是主诉求」。
      // 理由说得通,但**刚刚那个确认框白纸黑字承诺了三件事**:
      //   「并自动进入画框态 / 在整张原图上框出 / 松手后系统会按框重读票面字段」
      // 承诺过的事没发生却一个字不说,人只会以为自己点错了,或者以为系统卡了 ——
      // 然后对着一条空白记录手填一遍本来能自动读出来的东西(正是 P2-b 要省掉的那步)。
      //
      // 进不去的三种真实成因(services/handlers/workbench/task_handlers.copyOriginalIntoBatch
      // 返回 null):①回溯不到 _original 兄弟;②客户库原图已被清理或重传;
      // ③复制失败(磁盘满/权限)。三种都不是操作员能预判的。
      // canDrawBox.error 里已经有后端给的人话理由,透出来即可,不用另编一套。
      if (entered === false) {
        const why = selectedTask.value?.canDrawBox?.error || '这条记录指向的是切片,不是整张原图'
        workbench.setMessage(
          `票已经补上了,但没能进入画框态:${why}。`
          + '请直接照图手填字段;或用「更多」里的「按店重切」让系统拿原图重切一次。',
        )
      }
    }
  } catch (err) {
    workbench.setError(err?.response?.data?.error || '补小票记录失败,请重试', err?.response?.data?.details || null)
  } finally {
    reviewActionLoading.value = ''
  }
}

// P2d 「按此店重切」:用客户库原图按任务当前店档案强制重调 qwen 重切。
// 两类病例:①改店后(百货↔免税店误判)按新店档案重切;②多票并排漏切,不改店纯重试。
// 该原图切出的旧任务会被删除、新切片自动归回本组;已审任务后端 409 保护。
async function resplitCurrentTask() {
  const task = selectedTask.value
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  if (!task || !batchId) {
    workbench.setError('请先选择客户组内的一张图片')
    return
  }
  const store = String(task.receiptStoreFinal || task.receiptStoreAuto || '').trim()
  const storeText = store ? `按「${store}」店档案` : '按当前识别结果'
  if (!window.confirm(
    `${storeText}用原图重新识别切图?\n\n`
    + '· 这张原图切出的所有记录会被删除,由新切片替代(该图已审过的会被阻止)\n'
    + '· 如果你刚改了店家,请先保存字段再点重切,否则按旧店切'
  )) return
  reviewActionLoading.value = 'resplit'
  try {
    const preIds = new Set((workbench.tasks || []).map((t) => t.id))
    const { data } = await resplitTask(batchId, task.id, store)
    await workbench.fetchBatch(batchId)
    await loadReviewCustomerNames()
    // 落点=这次重切**新产生**的任务(旧逻辑选"组内第一个"会跳到已通过的护照上)
    const removed = new Set(data?.removedTaskIds || [])
    if (removed.has(task.id)) {
      const next = pickTaskAfterFamilyChange(task.sourceGroupKey, preIds)
      if (next) selectedTaskId.value = next.id
    }
  } catch (err) {
    // 原图引用悬空类错误(客户库被重传/清理/该任务本就没有客户库原图)→ 给人话+出路,
    // 不再把工程错误码原样甩给审核员(2026-07-13:曾让人误以为丢数据/bug)。
    const code = err?.response?.data?.code || ''
    const NO_ORIGINAL = ['resplit_image_missing', 'resplit_no_library_ref', 'resplit_original_missing', 'resplit_source_file_missing']
    if (NO_ORIGINAL.includes(code)) {
      workbench.setError('这张的客户库原图已不在(工作区被重传/清理,或该任务无客户库原图),无法「按此店重切」。'
        + '正解:回「客户建档」用一个没被占用过的新工作区名重新上传这个客户的照片,再进批次审核。')
    } else if (code === 'resplit_ambiguous_original') {
      workbench.setError('客户库里有多张同名原图,无法确定重切哪张(撞名),请联系管理员处理。')
    } else {
      workbench.setError(err?.response?.data?.error || '重切失败,请重试', err?.response?.data?.details || null)
    }
  } finally {
    reviewActionLoading.value = ''
  }
}

// 重切/恢复原图后的落点选择(2026-07-14 用户报障:改百货后跳到组里已通过的护照上):
// 优先选**这次新产生的任务**(调用前不存在的 id,先小票后其它)——那才是操作员接下来要处理的;
// 没有新任务再退回组内未审任务;绝不无脑选"组内第一个"(那往往是已通过的护照)。
function pickTaskAfterFamilyChange(groupKey, preIds) {
  const groupTasks = (workbench.tasks || []).filter((t) => t.sourceGroupKey === groupKey)
  return groupTasks.find((t) => !preIds.has(t.id) && normalizeDocType(t) === 'receipt')
    || groupTasks.find((t) => !preIds.has(t.id))
    || groupTasks.find((t) => !t.reviewed)
    || groupTasks[0]
    || null
}

// 家族基名(与后端 task_resplit_service.parseSliceBase 同口径):切片名形如
// <NN>-<base>_receipt_1.jpg / <NN>-<base>_original.jpg → <base>;反推不出(未切图)→ ''。
function familyBaseOf(task) {
  const src = String(task?.sourceOriginalPath || '').trim()
  const fileName = (src.split('/').pop() || '').replace(/^\d+-/, '')
  const m = fileName.match(/^(.+?)_(?:receipt|passport|region|other)_\d+\.\w+$/)
    || fileName.match(/^(.+?)_original\.\w+$/)
  return m ? m[1] : ''
}

// 「这其实是百货」原子定型 + 误切碎片恢复原图(2026-07-13,ReceiptStanceBlock/FieldEditor 共用)。
// 步骤:①原子提交 docType=receipt + 百货店 + 清团号 → isTourExemptTask 立即为真、团号闸消失、
// 面板切百货真字段;②若这张是被切开的百货合影碎片(有原图可回溯)→ 一次确认后按百货店重切,
// 整图直通(百货 split:none)把整张原图放回来、旧碎片合并为一张。
async function declareDeptStore(storeFamily) {
  const task = selectedTask.value
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  if (!task || !batchId || !isDeptStoreValue(storeFamily)) return
  // 重入闸(2026-07-13 复审 MEDIUM):两个入口(表态块 dept-chip / 字段面板 dept 选择器)+ 双击
  // 都会打到这里;整个"定型→可能重切→fetchBatch"round-trip 期间必须独占,否则败者的 taskId
  // 会被赢者重切删掉,只剩一句泛化报错。一道 async 闸门统管所有入口,比逐个按钮 disabled 更稳。
  if (deptDeclaring.value) return
  deptDeclaring.value = 'saving'
  const wasFragment = Boolean(selectedOriginalImageUrl.value) || Boolean(familyBaseOf(task)) // 被切开的碎片
  try {
    try {
      await workbench.updateTask(task.id, {
        docTypeFinal: 'receipt', receiptStoreFinal: storeFamily, groupNoFinal: '', tourStance: '',
      })
    } catch (err) {
      workbench.setError(err?.response?.data?.error || err?.message || '改百货失败,请重试', err?.response?.data?.details || null)
      return
    }
    if (wasFragment && window.confirm(
      '这张百货合影像是被切开成了碎片。\n\n把整张原图放回来吗?\n(该原图切出的碎片会合并为一张百货票,已审过的会被阻止)'
    )) {
      deptDeclaring.value = 'restore' // 横幅切到"正在恢复原图…"
      await resplitToDept(batchId, task, storeFamily)
      return
    }
    await workbench.fetchBatch(batchId)
  } finally {
    deptDeclaring.value = ''
  }
}

// 按百货店重切恢复原图;已审碎片挡路(409)时,一键先撤销家族内已审碎片再重试一次。
async function resplitToDept(batchId, task, storeFamily, { unblocked = false } = {}) {
  reviewActionLoading.value = 'resplit'
  try {
    const preIds = new Set((workbench.tasks || []).map((t) => t.id))
    const { data } = await resplitTask(batchId, task.id, storeFamily)
    await workbench.fetchBatch(batchId)
    await loadReviewCustomerNames()
    // 落点=新恢复出来的百货票(旧逻辑选"组内第一个"会跳到已通过的护照上——用户实撞)
    const removed = new Set(data?.removedTaskIds || [])
    if (removed.has(task.id)) {
      const next = pickTaskAfterFamilyChange(task.sourceGroupKey, preIds)
      if (next) selectedTaskId.value = next.id
    }
    workbench.setMessage('已恢复整张百货原图')
  } catch (err) {
    const code = err?.response?.data?.code || ''
    if (code === 'resplit_no_library_ref' || code === 'resplit_source_file_missing') {
      // 本就是整张(未被切)→ 定型已完成,无需恢复,不当错误报
      await workbench.fetchBatch(batchId)
      workbench.setMessage('已设为百货(此图本就是整张,无需恢复)')
    } else if (code === 'resplit_blocked_reviewed' && !unblocked) {
      const base = familyBaseOf(task)
      const blocked = base
        ? (workbench.tasks || []).filter((t) => t.reviewed && familyBaseOf(t) === base)
        : []
      if (blocked.length && window.confirm(
        `该原图有 ${blocked.length} 张已审碎片挡住了重切。\n\n先撤销这些碎片的审核再重切?`
      )) {
        for (const b of blocked) {
          try { await workbench.restoreTask(b.id) } catch { /* 逐个尽力撤,失败的靠重试再报 */ }
        }
        await resplitToDept(batchId, task, storeFamily, { unblocked: true })
        return
      }
      workbench.setError(err?.response?.data?.error || '该原图有已审碎片,先撤销其审核再恢复', err?.response?.data?.details || null)
    } else {
      workbench.setError(err?.response?.data?.error || '恢复原图失败,请重试', err?.response?.data?.details || null)
    }
  } finally {
    reviewActionLoading.value = ''
  }
}

async function handleAppendImages(event) {
  const files = Array.from(event?.target?.files || [])
  if (event?.target) {
    event.target.value = ''
  }
  if (!files.length) return

  const reference = selectedGroupReference.value
  if (!reference.workspaceKey || !reference.customerId) {
    workbench.setError('当前客户组缺少工作区或客户目录引用，不能直接追加图片')
    return
  }

  const previousIds = new Set((workbench.tasks || []).map((task) => task.id))
  reviewActionLoading.value = 'append-images'
  try {
    await workbench.appendImagesToSourceGroup({
      workspaceKey: reference.workspaceKey,
      customerId: reference.customerId,
      files,
    })
    await loadReviewCustomerNames()
    const appendedTask = (workbench.tasks || []).find((task) => !previousIds.has(task.id))
    if (appendedTask) {
      selectedTaskId.value = appendedTask.id
      // 已结算组补图:清 settledGroupKeys,新图审完能再走确认结算入台账(后端 re-settle 幂等去重),
      // 否则被「本组已结算」拦下,新票永不入台账(8模块审计 HIGH)。
      const gk = groupKeyOfTask(appendedTask)
      if (gk) settledGroupKeys.value.delete(gk)
    }
  } finally {
    reviewActionLoading.value = ''
  }
}

async function deleteCurrentBatch() {
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  if (!batchId) return
  const name = workbench.currentBatch.name || batchId
  if (!window.confirm(`确认删除批次「${name}」？\n此操作会删除批次下所有文件，不可恢复。`)) {
    return
  }
  await workbench.deleteBatch(batchId)
  const fallback = workbench.batches[0]?.id || workbench.batches[0]?.batchId
  if (fallback) {
    router.push({ name: 'review', params: { batchId: fallback } })
  } else {
    router.push({ name: 'workbench' })
  }
}

const exportingCustomerData = ref(false)
async function exportCustomerData() {
  const batchId = workbench.currentBatch?.id || workbench.currentBatch?.batchId
  if (!batchId || exportingCustomerData.value) return
  exportingCustomerData.value = true
  try {
    const blob = await exportBatchCustomerData(batchId)
    const name = `${workbench.currentBatch?.name || batchId}_客户数据.zip`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch (err) {
    let msg = '导出客户数据失败'
    const data = err?.response?.data
    if (data instanceof Blob) {
      try { msg = JSON.parse(await data.text())?.error || msg } catch { /* keep default */ }
    } else if (err?.message) {
      msg = err.message
    }
    window.alert(msg)
  } finally {
    exportingCustomerData.value = false
  }
}

// 预取相邻任务图片:切到下一张时浏览器已缓存 → 秒显,消除"切图卡顿"。
// 持引用(_preloadImages)防止加载中途被 GC 打断;decoding=async 让解码不卡主线程。
// 变量是"只写"的锚(写入即达成目的),_ 前缀告诉 lint 这是有意为之。
let _preloadImages = []
function preloadAdjacentTaskImages() {
  const idx = selectedTaskIndex.value
  if (idx < 0) return
  const tasks = workbench.tasks || []
  const urls = []
  for (const j of [idx + 1, idx + 2, idx - 1]) { // 下一张优先,再下一张,上一张
    const url = tasks[j]?.imageUrl || tasks[j]?.sourceImageUrl || ''
    if (url && !urls.includes(url)) urls.push(url)
  }
  _preloadImages = urls.map((url) => {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    return img
  })
}

watch(() => route.params.batchId, loadBatch)
// 换票防误点保护罩(2026-07-14 视频报障根治):换票后一小拍内检查器不吃鼠标点击——
// 即便布局还有像素级就位,点击也不会落在移动靶上;键盘流(Enter/R)不受影响。
const inspectorSettling = ref(false)
let inspectorSettleTimer = null
watch(() => selectedTask.value?.id, () => {
  activeFieldKey.value = ''
  // 滚回顶部改为**同步**执行(原 nextTick 在新内容绘制后才滚=肉眼可见跳一下;
  // 同步归零发生在重绘前,新票首帧就定格在顶部,零跳动)
  fieldScrollRef.value?.scrollTo?.({ top: 0 })
  inspectorSettling.value = true
  clearTimeout(inspectorSettleTimer)
  inspectorSettleTimer = setTimeout(() => { inspectorSettling.value = false }, 300)
  preloadAdjacentTaskImages()
})
watch(sourceWorkspaceKey, loadReviewCustomerNames)

// 键盘快捷键(审核热路径提速):Enter=确认,R=重拍。仅在焦点不在可编辑控件时触发,
// 避免抢走填字段/选下拉时的按键。熟手一天几百组不用摸鼠标(对标市面审核台键盘流)。
function isEditableTarget(el) {
  if (!el) return false
  const tag = String(el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}
// Enter 会原生"点击"聚焦的按钮/链接 → 全局再触发确认会双动作;这类目标上跳过 Enter。
function isNativeActivateTarget(el) {
  if (!el) return false
  const tag = String(el.tagName || '').toLowerCase()
  return tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button'
}
function onReviewHotkey(e) {
  if (e.defaultPrevented) return
  // Ctrl+F(任务流 P8):接管浏览器查找,聚焦队列搜索框——审核台里"找"的对象是客户组不是网页文字。
  // 放在 editable 判断之前:光标在输入框里按 Ctrl+F 也应跳到搜索框。
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    groupedListRef.value?.focusSearch?.()
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  // Esc:清队列搜索(搜索框自己聚焦时浏览器原生 Esc 已清 type=search 的值,这里兜全局态)
  if (e.key === 'Escape') {
    if (rephotoPickerOpen.value) { rephotoPickerOpen.value = false; return } // 先收重拍选择器,不连带清搜索
    // P4:画框态优先吃 Esc。正在画框的人按 Esc 想的是"别画了",
    // 不是"清掉队列搜索"—— 后者会连带把他好不容易筛出来的队列还原,
    // 这种"按一下退出、顺手毁掉别的东西"最招人烦。exitDrawMode 返回是否真退了。
    if (imageViewerRef.value?.exitDrawMode?.()) return
    groupedListRef.value?.clearSearch?.()
    return
  }
  if (isEditableTarget(e.target)) return
  if (settleResult.value) return // 结算面板开着时,快捷键不得穿透去动后面的任务
  if (!selectedTask.value) return
  // 重拍分键(0727反馈#10):选择器开着时 1/2/3 直选原因,R,1 两键完成标记
  if (rephotoPickerOpen.value && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault()
    const reason = REPHOTO_REASONS[Number(e.key) - 1]?.key
    if (reason && reviewActionLoading.value !== 'rephoto-next') markRephotoAndNext(reason)
    return
  }
  if (e.key === 'Enter') {
    if (isNativeActivateTarget(e.target)) return // 让按钮/链接自己响应,不重复触发确认
    e.preventDefault()
    if (reviewActionLoading.value !== 'confirm-next') confirmAndNext()
  } else if (e.key === 'r' || e.key === 'R') {
    // R 是破坏性动作(标重拍),焦点在按钮/链接上时不触发,防选完选项后误按 R 误标重拍。
    // ⚠️规格十四想把 R 改成"刷新当前组"——不采纳:R=重拍是既有肌肉记忆+有回归测试钉着,
    // 改语义比不加危险得多。
    if (isNativeActivateTarget(e.target)) return
    e.preventDefault()
    if (reviewActionLoading.value !== 'rephoto-next') markRephotoAndNext()
  } else if (e.key === 'b' || e.key === 'B') {
    // P4:B 进画框态。审核台整套是键盘驱动的(Enter / R+1/2/3 / ←→),
    // 画框却只能用鼠标 —— 每纠一次切错的框就要把手挪开一趟。
    // B 取 box 的首字母;和既有键不冲突(Enter/R/1/2/3/←→ 都占着别的意思)。
    if (isNativeActivateTarget(e.target)) return
    e.preventDefault()
    if (!imageViewerRef.value?.enterDrawMode?.()) {
      // 进不去要**说出来**。默默什么都不发生的话,人会以为键没响应、
      // 反复按 —— 而真实原因(这条任务是切片,坐标系对不上)他看不见。
      workbench.setMessage(
        selectedTask.value?.canDrawBox?.error
        || '这条任务不能手动框选(切片任务的坐标系和原图对不上,先用「补小票」或「按店重切」)',
      )
    }
  } else if (e.key === 'Backspace') {
    // P4:Backspace 清框。画歪了要能一键撤,否则只能重画一个盖上去 ——
    // 而"盖上去"改不掉已经存进后端的那个框。
    // 只在**确实有人工框**时才动;没有框时按 Backspace 什么都不做,
    // 不能顺手把模型给的 detectionBox 也删了(那不是人画的,删了没法恢复)。
    if (isNativeActivateTarget(e.target)) return
    if (String(selectedTask.value?.docBoxSource || '') !== 'manual') return
    e.preventDefault()
    if (reviewActionLoading.value !== 'doc-box') handleDocBoxDraw(null)
  } else if (e.key === 'ArrowLeft') {
    // ←/→(任务流 P8):上一组=会话历史回退;下一组=队列序下一组。
    // 图片查看器不吃方向键(缩放是滚轮/按钮),不冲突。
    e.preventDefault()
    goPrevGroup()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    goNextGroup()
  }
}
onMounted(() => window.addEventListener('keydown', onReviewHotkey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onReviewHotkey)
  clearTimeout(inspectorSettleTimer) // 换票护罩计时器,卸载即清
})

// 回执卡(B5 拍板):组内小票全部表态完成(不必等字段审完)→ 弹卡一键复制粘回群。
// R1 只做生成+复制;「已回执」落库标记等 R2 定载体(票级模型暂无组级盖章位)。
const receiptCard = ref(null)
const groupStanceReadySeen = new Set()
function buildReceiptText(groupTasks, name) {
  const receipts = groupTasks.filter((t) => normalizeDocType(t) === 'receipt')
  const tours = new Map()
  for (const t of receipts) {
    const v = t.tourStance === 'none' ? '无团号' : (String(t.groupNoFinal || '').trim() || '无团号')
    const mode = String(t.modeRawPre || '').trim()
    const label = mode ? `${v}(${mode})` : v
    tours.set(label, (tours.get(label) || 0) + 1)
  }
  const tourText = [...tours.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join('、')
  const rephoto = groupTasks.filter((t) => t.rephotoRequested).length
  // 百货护照与小票同框(护照信息落在百货小票任务上)也算齐,不误报缺护照——与后端护照规则同口径。
  const hasPassport = groupHasPassport(groupTasks)
  const issues = [rephoto ? `${rephoto}张需重拍` : '', hasPassport ? '' : '缺护照'].filter(Boolean).join(',')
  return `客户${name}:收到${receipts.length}张小票,${tourText}${issues ? ';' + issues : ''}`
}
function stanceCardName(task) {
  return customerNameById.value[customerIdOfTask(task)] || task.sourceGroupLabel || customerIdOfTask(task) || '客户'
}
watch(() => (workbench.tasks || []).map((t) => `${t.id}:${t.tourStance || ''}`).join('|'), () => {
  const byGroup = new Map()
  for (const t of workbench.tasks || []) {
    const k = taskGroupKey(t) || t.id
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k).push(t)
  }
  for (const [key, list] of byGroup) {
    const receipts = list.filter((t) => normalizeDocType(t) === 'receipt' && !isTourExemptTask(t))
    if (!receipts.length) continue
    const allStanced = receipts.every((t) => String(t.tourStance || '').trim())
    if (allStanced && !groupStanceReadySeen.has(key)) {
      groupStanceReadySeen.add(key)
      const name = stanceCardName(list[0])
      // brief=横幅显示用的短句(2026-07-28 用户截图:横幅铺全文,「陈强」出现两遍、「4张」两遍);
      // text=完整回执原样保留——它是粘回群的交付物,一个字不能省。
      const rephotoN = list.filter((t) => t.rephotoRequested).length
      receiptCard.value = {
        key,
        name,
        text: buildReceiptText(list, name),
        brief: `${receipts.length} 张小票已全部表态${rephotoN ? `,${rephotoN} 张需重拍` : ''}`,
        copied: false,
      }
    }
  }
})
async function copyReceiptText() {
  try {
    await navigator.clipboard.writeText(receiptCard.value?.text || '')
    if (receiptCard.value) receiptCard.value.copied = true
  } catch { /* 剪贴板不可用(http 环境):文案已显示可手动选中复制 */ }
}

onMounted(loadBatch)
</script>

<template>
  <!-- 全局忙碌横幅(2026-07-14):重切/恢复原图/补小票/追加图片等耗时操作,亮着=正在处理,消失=完成 -->
  <div v-if="busyText" class="review-busy-banner" role="status" aria-live="polite">
    <span class="busy-spinner" aria-hidden="true" />
    {{ busyText }}
  </div>
  <ReviewCenterTabs />
  <section class="page-title review-page-title">
    <div>
      <h1>审核</h1>
      <button
        v-if="returnToPath"
        type="button"
        class="review-return-btn"
        :title="`返回${returnToName}(保留筛选)`"
        @click="router.push(returnToPath)"
      >
        ← 返回{{ returnToName }}
      </button>
    </div>
    <!-- 「本批次按代理」切换器已下线(2026-07-17 用户拍板):代理视角由 /agents 全面接管 -->
    <div class="page-actions">
      <BatchSelector
        v-model="selectedBatchId"
        :batches="workbench.batches"
        :loading="workbench.loading"
        @update:model-value="changeBatch"
        @on-refresh="loadBatch"
      />
      <!-- 批次上下文改为内联(2026-07-26 顶部瘦身):原 BatchContextCard 是独占一行的带框卡片,
           光边框+内边距就吃掉 ~46px 而只承载「建档日期 + 换团号表」两个信息 → 并进标题行不带框。 -->
      <span v-if="batchCreatedLabel" class="rv-batch-meta" :title="batchIdHint">建档 {{ batchCreatedLabel }}</span>
      <button
        v-if="workbench.currentBatch"
        type="button"
        class="rv-gc-link"
        title="导错团号表了?换一份(结算本批次时会用新表匹配)"
        @click="triggerReplaceGroupCode"
      >
        换团号表
      </button>
      <span class="rv-actions-gap" />
      <!-- 「结算本批次」(原名「导入台账」,2026-07-29 用户要求换成操作员能懂的词:
           「导入」像是从文件导进来,实际是把本批写进台账;系统既有词汇是「结算」)。
           2026-07-26 用户拍板降级:它是批次级批量结算的**兜底**入口——
           开着「确认即结算」时逐个客户确认就已结算,这里基本空跑;只有关掉开关(或想一次性
           收口整批)才用得上。故从蓝色主按钮降为次要按钮,不再抢「确认」的视觉位。 -->
      <button
        type="button"
        class="ghost-button page-ledger-button"
        :disabled="!workbench.currentBatch || !isBatchReviewComplete || workbench.actionLoading === 'import-ledger'"
        :title="!isBatchReviewComplete
          ? `还有 ${reviewFlowStats.pending} 张没审完,全部审完才能结算本批次`
          : '把本批已通过的客户一次性写进收票台账并跑团号匹配(未匹配的进异常补救)。'
            + '开着「确认即结算」时逐个客户已结算,这里是兜底,通常不用点'"
        @click="importLedgerAndMatch"
      >
        {{ workbench.actionLoading === 'import-ledger'
          ? '结算中…'
          : (isBatchReviewComplete ? '结算本批次' : `结算本批次(还剩 ${reviewFlowStats.pending} 张没审)`) }}
      </button>
      <MoreMenu v-if="workbench.currentBatch">
        <label class="more-menu-toggle" title="开:整组审完点「确认」即自动通过并结算出模式。关:确认仅通过,需在「更多」菜单点「手动结算本组」" @click.stop>
          <input v-model="mergeSettleOnConfirm" type="checkbox">
          确认即结算
        </label>
        <button type="button" :disabled="exportingCustomerData" @click="exportCustomerData">
          {{ exportingCustomerData ? '导出中…' : '导出当前批次客户数据' }}
        </button>
        <button type="button" class="danger" :disabled="workbench.actionLoading.startsWith('batch-delete')" @click="deleteCurrentBatch">
          删除整个批次
        </button>
      </MoreMenu>
    </div>
  </section>

  <input ref="groupCodeReplaceInput" type="file" accept=".xlsx,.xls" style="display: none" @change="onGroupCodeFileChange">

  <!-- 提示行(2026-07-26 顶部瘦身):三类提示统一写法 —— 不带框、单行、图标+彩色字,
       动作用下划线链接而非按钮。报错=红 / 全通过=绿 / 日常提醒=蓝。原来每条都是独立的
       带框 section(边框+内边距+按钮各占一行),三条叠起来能吃掉半屏。 -->
  <section v-if="workbench.error || workbench.message" class="rv-notice" :class="workbench.error ? 'is-error' : 'is-ok'" role="status">
    <template v-if="workbench.error">
      <span class="rv-notice-icon" aria-hidden="true">!</span>
      <span
        class="rv-notice-text"
        :class="{ 'is-locatable': locatableErrorTask }"
        :title="locatableErrorTask ? '点击定位到这张图' : ''"
        @click="locateErrorTask"
      >{{ workbench.error }}</span>
      <button v-if="locatableErrorTask" type="button" class="rv-notice-link" @click="locateErrorTask">定位到这张图</button>
      <button
        v-if="duplicateGroup"
        type="button"
        class="rv-notice-link is-danger"
        :disabled="deletingDupGroup"
        title="删除这组重复客户(已入台账的第一份不受影响)"
        @click="deleteDuplicateGroup"
      >
        {{ deletingDupGroup ? '删除中…' : '删除这组重复客户' }}
      </button>
    </template>
    <template v-else>
      <span class="rv-notice-icon" aria-hidden="true">✓</span>
      <span class="rv-notice-text">{{ workbench.message }}</span>
    </template>
  </section>

  <!-- 波2 承接(0728#2):导台账产生待补救 → 常驻琥珀行指向下一步工作流(不弹框打断) -->
  <section v-if="remedyNotice > 0" class="rv-notice is-warn" role="status">
    <span class="rv-notice-icon" aria-hidden="true">▲</span>
    <span class="rv-notice-text">本次导入产生 {{ remedyNotice }} 行待补救(团号未命中/日期越界/代理不符)</span>
    <button type="button" class="rv-notice-link" @click="router.push('/daily/remedy')">去异常补救处理</button>
    <button type="button" class="rv-notice-close" title="关闭" @click="remedyNotice = 0">×</button>
  </section>

  <section v-if="receiptCard" class="rv-notice is-ok">
    <span class="rv-notice-icon" aria-hidden="true">✓</span>
    <!-- 横幅只显短句(2026-07-28 去冗余:旧版铺完整回执,「陈强」×2「4张」×2 占满整行);
         完整回执在悬停 + 复制里,一个字不少。 -->
    <span class="rv-notice-text" :title="receiptCard.text">{{ receiptCard.name }}:{{ receiptCard.brief || receiptCard.text }}</span>
    <button type="button" class="rv-notice-link" @click="copyReceiptText">{{ receiptCard.copied ? '已复制 ✓' : '复制回执' }}</button>
    <button type="button" class="rv-notice-close" title="关闭" @click="receiptCard = null">×</button>
  </section>

  <!-- 深链 stale:目标客户组已不在本批次(结算/移动)→ 显式提示,不静默跳别的客户 -->
  <section v-if="deepLinkStaleMessage" class="rv-notice is-info" role="alert">
    <span class="rv-notice-icon" aria-hidden="true">i</span>
    <span class="rv-notice-text">{{ deepLinkStaleMessage }}</span>
    <button type="button" class="rv-notice-link" @click="loadBatch">刷新</button>
    <button type="button" class="rv-notice-close" title="知道了" @click="deepLinkStaleMessage = ''">×</button>
  </section>

  <section class="review-console-layout">
    <!-- Left: Task Queue —— 实时队列(时间倒序)。「本批次按代理」已下线(2026-07-17) -->
    <div class="panel queue-panel review-queue-panel">
      <div class="panel-header">
        <strong class="queue-panel-title">客户组队列</strong>
        <!-- ‹ i/N › 放面板头右侧(2026-07-28 参考图对齐):这里本来空着,塞进概览行会把
             数字挤换行(280px 实锤)。i/N 由 queueOrder + selectedGroupKey 自算。 -->
        <span class="queue-nav" role="group" aria-label="组间导航">
          <button type="button" class="queue-nav-btn" title="上一组(←):回到本次会话最近处理过的组" @click="goPrevGroup">‹</button>
          <span class="queue-nav-counter" title="当前组在队列中的位置 / 可见队列组数">{{ queueNavText }}</span>
          <button type="button" class="queue-nav-btn" title="下一组(→):按当前筛选和排序进入下一组" @click="goNextGroup">›</button>
        </span>
      </div>
      <GroupedTaskList
        ref="groupedListRef"
        :tasks="workbench.tasks"
        :selected-task-id="selectedTask?.id || ''"
        :customer-name-by-id="customerNameById"
        :group-settlement-by-key="groupSettlementByKey"
        @on-select="selectedTaskId = $event"
        @go-remedy="goRemedyForGroup"
        @queue-change="onQueueChange"
      />
    </div>

    <template v-if="true">
      <!-- 确认站已删(2026-07-14);原 v-else 包装保留为恒真容器 -->

      <!-- ⚠️ 中栏必须是**一个** grid item。三栏是 280px/1fr/380px 写死的,
           提示条直接当兄弟插进来会变成第 4 个 item,把右侧检查器挤到网格外(整块看不见)。
           0730 生产截图实证。包一层 flex 列:提示条 flex:none,图 flex:1。 -->
      <div class="review-image-col">
        <!-- 这条图会怎么进包(0730):被拦的必须在审核时就看见,不能等导出后读那张纸。
             判定来自 lib/delivery_render.planDeliveryImage,和交付时用的是同一套。 -->
        <div
          v-if="selectedDeliveryPlan"
          class="delivery-plan-bar"
          :class="selectedDeliveryPlan.action"
        >
          <strong>{{ selectedDeliveryPlan.action === 'block' ? '这张图进不了交付包' : '交付时按框裁' }}</strong>
          <span>{{ selectedDeliveryPlan.hint }}</span>
          <!-- 2026-08-01:这个计数原来只判 blockedImageCount > 1,却挂在**整条** bar 上。
               而 bar 在 action==='crop' 时显示的是「交付时按框裁」(正常路径、灰底)。
               于是站在一张"会被裁"的图上,读到「本批共 2 条」自然理解成
               "本批有 2 张要按框裁,不用管" —— 实际那 2 条是**进不了包**的图,
               而且此时条子是灰的、不是 block 的红橙,提示强度还降了一级。
               等交付包出来才发现少图。
               改成只在 block 态出现,并且把数的是什么写进句子里。 -->
          <span
            v-if="selectedDeliveryPlan.action === 'block' && blockedImageCount > 1"
            class="delivery-plan-count"
          >
            本批共 {{ blockedImageCount }} 张进不了包
            <button type="button" @click="gotoFirstBlockedImage">去第一条</button>
          </span>
        </div>
        <ImageViewer
          ref="imageViewerRef"
          class="review-image-panel"
          :task="selectedTask"
          :field-regions="selectedTaskFieldRegions"
          :active-field-key="activeFieldKey"
          :original-image-url="selectedOriginalImageUrl"
          :is-original-image="selectedIsOriginalImage"
          :doc-regions="selectedTaskDocRegions"
          @on-field-region-select="focusReviewField"
          @on-doc-region-select="handleDocRegionSelect"
          @on-doc-box-draw="handleDocBoxDraw"
        />
      </div>
      <aside class="review-inspector" :class="{ settling: inspectorSettling }">
        <!-- 批次完成卡(2026-07-28 用户截图整改):审完是一个正经的界面状态,不是一句话+
             一个飘着的按钮。✓态标 + 三桶去向(与左栏概览同源) + 主CTA + 需重拍联动。 -->
        <div v-if="isBatchReviewComplete" class="review-complete-inline">
          <div class="rc-head">
            <span class="rc-check" aria-hidden="true">✓</span>
            <strong>本批次已审完</strong>
            <span class="rc-nums">
              {{ reviewFlowStats.total }} 张
              <template v-if="queueOrder.summary"> · 已通过 {{ queueOrder.summary.done }} 组<template v-if="queueOrder.summary.abnormal"> · 需重拍 {{ queueOrder.summary.abnormal }} 组</template></template>
            </span>
          </div>
          <div class="rc-actions">
            <button
              v-if="queueOrder.summary && queueOrder.summary.abnormal"
              type="button"
              class="ghost-button small"
              title="把左侧队列切到「需重拍」筛选,逐组处理遗留"
              @click="groupedListRef?.setFilter?.('rephoto')"
            >
              处理需重拍 {{ queueOrder.summary.abnormal }} →
            </button>
            <button
              type="button"
              class="primary-button"
              :disabled="!workbench.currentBatch || workbench.actionLoading === 'import-ledger'"
              @click="importLedgerAndMatch"
            >
              {{ workbench.actionLoading === 'import-ledger' ? '结算中…' : '结算本批次' }}
            </button>
          </div>
        </div>
        <div class="panel review-field-panel">
          <!-- 头部轻量化(2026-07-13 用户拍板:一眼看不懂就砍):
             每个信号只出现一次——任务名(悬停出原始文件名)+ 模式chip + 状态徽章;
             删「第N/M个文件」(数组位置,无业务意义,曾与待处理数撞数造成714/716误读)。 -->
          <div class="panel-header">
            <div class="inspector-title">
              <strong :title="selectedTask ? `原始文件：${rawTaskName(selectedTask)}` : ''">{{ selectedTaskFriendlyName }}</strong>
              <span v-if="inspectorModeText" class="inspector-mode-chip">{{ inspectorModeText }}</span>
            </div>
            <StatusBadge v-if="selectedTask" :task="selectedTask" />
          </div>
          <!-- 进度压成一行(2026-07-27 设计整改):「待处理 N」提到最前(这才是你需要知道的),
             done/total 降为右侧灰色小字,进度条 3px 中性灰。省下的高度让免税店整行露出来。 -->
          <div class="flow-review-bar">
            <div class="flow-review-status">
              <strong class="flow-pending">待处理 {{ reviewFlowStats.pending }}</strong>
              <div class="flow-review-progress" aria-hidden="true">
                <span :style="{ width: `${reviewFlowStats.total ? Math.round((reviewFlowStats.done / reviewFlowStats.total) * 100) : 0}%` }" />
              </div>
              <!-- 斜杠两侧留空格(image84 口径):tabular-nums 的等宽数字紧贴「/」时,
                   643/649 这类同位数会读成一坨,分开才一眼看出是「已完成/总数」 -->
              <span class="muted flow-done">{{ reviewFlowStats.done }} / {{ reviewFlowStats.total }}</span>
            </div>
          </div>
          <div ref="fieldScrollRef" class="review-field-scroll">
            <!-- 票级两步流(2026-07-10):小票第一步先表态团号(匹配/无团号/S标记),
               未表态字段区锁定;护照/其它/豁免票(机场"无"/百货)不出此块不锁。 -->
            <!-- deptIntentActive(0727反馈#5):一等档已切「百货」→ 表态区整个隐掉(百货免团号,
               这块只会把人绕回团号流程),字段区解锁直接选百货店。 -->
            <ReceiptStanceBlock
              v-if="selectedTask && normalizeDocType(selectedTask) === 'receipt' && !isTourExemptTask(selectedTask) && !deptIntentActive"
              :task="selectedTask"
              @declare-dept="declareDeptStore"
            />
            <div :class="{ 'stance-locked-fields': selectedTask && isTaskStanceLocked(selectedTask) && !deptIntentActive }">
              <!-- SLIM 车道(P4,服务端算好 reviewLane;资格=灰度模式+命中表+人工确认三叠加):
               小票免逐字段核对,只确认归属;护照不走此分支,锚字段照旧。 -->
              <div v-if="isSlimReceipt" class="slim-lane-panel">
                <p class="slim-lane-title">免逐项审核 · 该渠道代理标注「不用记」</p>
                <p class="muted">团号 {{ selectedTask?.groupNoFinal || selectedTask?.groupNoAuto }} 已人工确认(渠道 {{ selectedTask?.modeRawPre }})。确认这张票属于该客户点确认即可;字段不进交付物。</p>
              </div>
              <FieldEditor
                v-else
                ref="fieldEditorRef"
                :task="selectedTask"
                :show-submit="false"
                :active-field-key="activeFieldKey"
                :hotkeys-suspended="rephotoPickerOpen"
                @on-save="saveFields"
                @on-field-focus="setActiveReviewField"
                @on-doctype-change="changeDocType"
                @on-declare-dept="declareDeptStore"
                @on-undo-no-tour="undoNoTourStance"
                @on-ui-type-change="editorUiType = $event"
              />
              <SignatureEditor
                v-if="showSignaturePanel"
                :task="selectedTask"
              />
            </div>
          </div>
          <div class="review-action-dock">
            <input
              ref="appendImageInputRef"
              class="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              @change="handleAppendImages"
            >
            <div class="review-primary-actions">
              <!-- 快检没过时确认降级为描边(2026-07-27):用按钮本身的强弱暗示「这张要多看一眼」,
                 让快检结果和确认按钮形成闭环(仍可点——审核员有权自行判断,只是不再是"闭眼按")。 -->
              <button
                class="confirm-cta"
                :class="fieldsQuickCheckPassed ? 'primary-button' : 'ghost-button confirm-cta-caution'"
                type="button"
                :disabled="!selectedTask || reviewActionLoading === 'confirm-next'"
                :title="(fieldsQuickCheckPassed ? '' : '字段快检未过,建议先核对再确认 — ')
                  + (mergeSettleOnConfirm ? '确认本张;整组审完则自动 通过+团号匹配,即时出模式' : '仅确认本张(合并结算已关)') + ' — 快捷键 Enter'"
                @click="confirmAndNext"
              >
                {{ reviewActionLoading === 'confirm-next' ? '处理中…' : '确认' }}
                <span class="kbd-hint">↵</span>
              </button>
              <!-- 重拍改中性描边(2026-07-27):它不危险,只是次要;红色留给真正的破坏性动作 -->
              <!-- 分键选择(0727反馈#10):点开三键(模糊/缺/其他),选原因才落标记;R,1/2/3 两键完成 -->
              <!-- P3 收控件(0731,你拍板「画框 / 补小票 / 重拍」):
                   补小票从「更多」提到明面。切图出问题时的三条主路要一眼看全 ——
                   ①框切错了 → 画框(图上,B);②漏了一张 → 补小票(这里);
                   ③图本身不行 → 重拍。其余(重切/追加图片/删除/恢复/结算类)留在「更多」。
                   补小票在切片任务上会把整张原图拷进批次并自动进画框态(P2-a/P2-c),
                   所以它同时也是"这条切片没法画框"的出路。 -->
              <button
                class="ghost-button"
                type="button"
                title="这张图里还有一张票没生成记录 —— 补一条并自动进入画框态,框完自动按框重读字段"
                :disabled="!selectedTask || reviewActionLoading === 'manual-receipt'"
                @click="addReceiptOnSameImage"
              >
                {{ reviewActionLoading === 'manual-receipt' ? '补建中…' : '补小票' }}
              </button>
              <div class="rephoto-split">
                <button class="ghost-button" type="button" title="标记本张需重拍(选原因) — 快捷键 R" :disabled="!selectedTask || reviewActionLoading === 'rephoto-next'" :aria-expanded="rephotoPickerOpen" @click="markRephotoAndNext()">
                  重拍 <span class="kbd-hint">R</span>
                </button>
                <div v-if="rephotoPickerOpen" class="rephoto-picker" role="menu" aria-label="重拍原因">
                  <button
                    v-for="(r, i) in REPHOTO_REASONS"
                    :key="r.key"
                    type="button"
                    role="menuitem"
                    :disabled="reviewActionLoading === 'rephoto-next'"
                    @click="markRephotoAndNext(r.key)"
                  >
                    {{ r.label }} <span class="kbd-hint">{{ i + 1 }}</span>
                  </button>
                </div>
              </div>
              <!-- 自动推进开关(任务流规格八):默认开;关掉后确认只保存、停在当前张 -->
              <label class="auto-advance-toggle" title="确认成功后自动进入下一张待处理(Enter 连续审核);关掉则确认后停在原地。快捷键:← 上一组 / → 下一组 / Ctrl+F 搜索">
                <input v-model="autoAdvance" type="checkbox"> 自动下一组
              </label>
              <MoreMenu placement="top">
                <button type="button" :disabled="!selectedTask || reviewActionLoading === 'append-images'" @click="triggerAppendImages">
                  {{ reviewActionLoading === 'append-images' ? '追加中…' : '追加图片' }}
                </button>
                <!-- 「同图补小票」已提到明面(P3,0731):切图出问题时它是主路之一,
                     藏在菜单里等于把最常用的补救动作多加一次点击。这里不再重复放。 -->
                <button type="button" :disabled="!selectedTask || reviewActionLoading === 'resplit'" title="用客户库原图让系统重新切一次;这张图切出来的旧记录会被替换" @click="resplitCurrentTask">
                  <!-- P3 改名:「按此店重切」是内部说法(按"店档案"重切)。操作员关心的是
                       "让系统再切一次",不是按什么档案切。降级留在菜单里,名字改成人话。 -->
                  {{ reviewActionLoading === 'resplit' ? '重切中…' : '让系统重新切这张图' }}
                </button>
                <hr>
                <button type="button" :disabled="!highTierPendingTasks.length || reviewActionLoading === 'confirm-high'" @click="confirmHighTierInGroup">
                  全部通过高置信 ({{ highTierPendingTasks.length }})
                </button>
                <button type="button" :disabled="Boolean(settleDisabledReason) || settleLoading || settleInFlightGroup === selectedGroupKey" :title="settleDisabledReason || '整组审完点确认已自动结算;此为手动结算兜底'" @click="settleCurrentGroup">
                  {{ settleLoading ? '结算中…' : (currentGroupHasRephoto ? '手动结算本组（有重拍）' : '手动结算本组') }}
                </button>
                <button v-if="selectedTask" type="button" :disabled="workbench.actionLoading === `restore:${selectedTask.id}`" @click="restoreTask">
                  恢复审核
                </button>
                <button v-if="isAdmin" type="button" class="danger" :disabled="!selectedGroupKey || ledgerCorrectionLoading" title="撤销本组结算台账(删行+审计快照),组回到可编辑/可删除状态;仅管理员" @click="correctLedgerCurrentGroup">
                  {{ ledgerCorrectionLoading ? '订正中…' : '台账订正(撤销结算)' }}
                </button>
                <hr>
                <!-- 删除收进菜单(2026-07-27):一天点几百次确认的界面,破坏性操作贴着主按钮迟早出事 -->
                <button type="button" class="danger" :disabled="!selectedTask || workbench.actionLoading === `delete:${selectedTask.id}`" @click="deleteSelectedTask">
                  删除这张图
                </button>
              </MoreMenu>
            </div>
          </div>
        </div>
      </aside>
    </template>
  </section>

  <div v-if="settleResult" class="settle-overlay" @click.self="closeSettle">
    <div class="settle-card">
      <div class="settle-head">
        <strong>结算结果 · 按小票出渠道模式</strong>
        <button class="ghost-button" type="button" @click="closeSettle">关闭</button>
      </div>
      <p class="settle-meta">
        已入月 {{ settleResult.insertedRows }} 张<span v-if="settleResult.removedOldRows"> · 重结算清旧 {{ settleResult.removedOldRows }}</span>
        · 落月 {{ (settleResult.affectedWorkspaces || []).join('、') || '—' }}
      </p>
      <ul class="settle-list">
        <li v-for="(r, i) in (settleResult.settledReceipts || [])" :key="i" class="settle-row">
          <div class="settle-row-main">
            <span class="settle-no">小票 {{ r.receiptNo || '—' }}</span>
            <span class="settle-arrow">团号 {{ r.tourNo || '—' }} →</span>
            <span class="settle-mode" :class="{ matched: isReceiptModeFound(r) }">
              {{ receiptModeText(r) }}
            </span>
            <span class="settle-chip" :class="receiptChip(r).cls">{{ receiptChip(r).text }}</span>
          </div>
          <!-- P1 内联补救:未命中当场救(模式类=选模式;日期类=改日期人工放行) -->
          <!-- 迁移横幅只看 remedyDone:迁移后行状态已翻 pending,remedyKindOf 变假,不能再依赖它(复核HIGH#2) -->
          <div v-if="r.id && String(remedyDone[r.id] || '').startsWith('migrated')" class="settle-remedy settle-remedy-done">
            已按新日期迁至 {{ String(remedyDone[r.id]).split(':')[1] || '对应' }} 月台账,将在该月重新匹配
          </div>
          <div v-else-if="r.id && remedyKindOf(r) && remedyDone[r.id] !== 'matched'" class="settle-remedy">
            <p class="settle-remedy-hint">{{ TOUR_REMEDY_HINT[r.tourMatchStatus] || '未命中,请人工处理' }}</p>
            <div v-if="remedyKindOf(r) === 'mode'" class="settle-remedy-controls">
              <select v-model="remedyDraftOf(r).mode" class="settle-remedy-select">
                <option value="">选模式{{ (remedyTourCandidates[String(r.tourNo || '').trim()] || []).length ? '(团号表候选优先)' : '' }}</option>
                <option v-for="m in remedyCandidatesFor(r)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-model="remedyDraftOf(r).manual" class="settle-remedy-input" placeholder="或手填模式">
              <button
                type="button"
                class="primary-button settle-remedy-btn"
                :disabled="remedySavingId === r.id"
                @click="confirmRemedyRow(r)"
              >
                {{ remedySavingId === r.id ? '救中…' : '确认补救' }}
              </button>
            </div>
            <div v-else class="settle-remedy-controls">
              <input v-model="remedyDraftOf(r).date" type="date" class="settle-remedy-input">
              <button
                type="button"
                class="primary-button settle-remedy-btn"
                :disabled="remedySavingId === r.id"
                title="确认=人工核实该票属此团期直接放行;改成别的月份会自动迁到对应月台账"
                @click="confirmRemedyRow(r)"
              >
                {{ remedySavingId === r.id ? '救中…' : '改日期并放行' }}
              </button>
            </div>
          </div>
        </li>
        <li v-if="!(settleResult.settledReceipts || []).length" class="settle-empty">
          <template v-if="settleResult.skippedRows > 0">
            本组小票已入过账(同票号+购买日期+店+月已存在,防重复计账已跳过 {{ settleResult.skippedRows }} 张)——不是丢票,是这张之前批次已结算过
          </template>
          <template v-else>本组没有可入台账的小票</template>
        </li>
      </ul>
      <p v-if="remedyError" class="settle-remedy-error">{{ remedyError }}</p>
      <div v-if="sameGroupRemaining.length" class="settle-apply-rest">
        <button type="button" class="ghost-button" :disabled="Boolean(remedySavingId)" @click="applyLastRemedyToRest">
          把「{{ lastRemedy.modeRaw }}」应用到其余 {{ sameGroupRemaining.length }} 张(同团号同店)
        </button>
        <!-- 复核MEDIUM(F9另一半):组内还有别的团号/店的未救行时明示,防操作员以为一键=全救 -->
        <span v-if="remedyOutstanding.length > sameGroupRemaining.length" class="settle-apply-note">
          另有 {{ remedyOutstanding.length - sameGroupRemaining.length }} 张属其他团号/店,需逐张处理
        </span>
      </div>
      <div class="settle-foot">
        <template v-if="settleResult.settlementStatus === 'needs_remedy'">
          <span class="muted">未命中可当场补救;救不了点「稍后处理」,行在异常补救页托底(重新结算会重新查表)</span>
          <button class="ghost-button" type="button" @click="closeSettle">稍后处理</button>
          <button class="ghost-button" type="button" @click="goRemedyForSettle">去补救台</button>
        </template>
        <template v-else-if="settleResult.settlementStatus === 'needs_confirm'">
          <label v-if="settleHasSActivity" class="s-activity-ack">
            <input v-model="sActivityAcked" type="checkbox">
            S活动红标签已处理(挂了红签/进了回发清单)
          </label>
          <label class="auto-back-toggle">
            <input v-model="autoBackToIntake" type="checkbox">
            确认后自动回建档
          </label>
          <span class="muted">渠道模式都对就确认{{ autoBackToIntake ? ',自动回建档收下一个' : ',确认后自动跳下一组' }}</span>
          <button class="primary-button" type="button" :disabled="confirmLoading || (settleHasSActivity && !sActivityAcked)" @click="confirmCurrentGroupModes">
            {{ confirmLoading ? '确认中…' : (autoBackToIntake ? '确认并回建档' : '确认') }}
          </button>
        </template>
        <template v-else>
          <span class="muted">本客户已结算</span>
          <button class="primary-button" type="button" @click="backToIntake">返回建档,收下一个</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 这条图会怎么进包(0730 判定前移)。block=红橙(硬规则:红橙=要处理);
   crop=灰阶告知(它是正常路径,不该抢注意力)。 */
.delivery-plan-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  background: #f8fafc;
  border: 0.5px solid #e2e8f0;
  color: #475467;
}
.delivery-plan-bar strong { font-weight: 500; color: #344054; }
.delivery-plan-bar.block { background: #fef2f2; border-color: #fecaca; color: #9f1239; }
.delivery-plan-bar.block strong { color: #b91c1c; }
.delivery-plan-count { margin-left: auto; display: inline-flex; align-items: baseline; gap: 6px; }
.delivery-plan-count button {
  border: 0.5px solid currentColor;
  background: none;
  color: inherit;
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 12px;
  cursor: pointer;
}
/* 团号确认站(P1) */
.review-tour-confirm { grid-column: 2 / 4; overflow-y: auto; }
.slim-lane-panel { padding: 14px; border: 1px dashed #cbd5e1; border-radius: 10px; background: #f8fafc; }
/* 0729 绿删补漏:窄道标题原绿 #166534,窄道本身不是「要处理」,归灰阶 */
.slim-lane-title { margin: 0 0 6px; font-weight: 500; color: var(--success); }
.s-activity-ack { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #b91c1c; font-weight: 500; }
.auto-back-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }

/* 「本批次按代理」切换器已下线(2026-07-17):view-switch/queue-open-workspace 样式随之移除 */
.review-page-title { flex-wrap: wrap; gap: 10px; }
.queue-panel-title { font-size: 13px; }
/* 面板头右侧的组间导航:‹ i/N ›,与标题同行,不占新行 */
.queue-nav { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; }
.queue-nav-btn {
  min-width: 22px; min-height: 22px; border: 1px solid var(--line-strong); border-radius: 6px;
  background: #fff; color: var(--text); font-size: 14px; line-height: 1; cursor: pointer; padding: 0;
}
.queue-nav-btn:hover { background: var(--surface-soft); }
.queue-nav-counter { font-size: 12px; font-weight: 500; color: var(--text); font-variant-numeric: tabular-nums; }
.review-return-btn {
  border: 1px solid #e4e7ec; background: #fff; border-radius: 6px; padding: 4px 10px;
  cursor: pointer; font-size: 12px; color: #475467;
}
.review-return-btn:hover { border-color: #1849a9; color: #1849a9; }

/* 操作栏主行:确认/重拍/删除/更多 单行排布(覆盖全局 2 列网格,避免 4 个折成两排) */
.review-action-dock .review-primary-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/* 干掉全局 .review-primary-actions button{width:100%}(2列网格时代遗产):
   它把 flex 行内每个按钮撑满整行 → 四个按钮竖摞吃掉~200px(2026-07-13 用户圈图报障)。 */
.review-action-dock .review-primary-actions button { width: auto; }
.review-action-dock .review-primary-actions .confirm-cta {
  flex: 1 1 120px; /* 允许收缩,窄面板下三件套仍同一行 */
  min-height: 34px;
}
/* 快检没过 → 确认降级为描边(2026-07-27):用按钮强弱暗示「这张要多看一眼」。
   仍可点(审核员有权自行判断),只是不再是那个"闭眼按"的蓝色实心块。 */
.review-action-dock .review-primary-actions .confirm-cta-caution {
  border-color: #fbbf24;
  color: #b45309;
  background: #fffbeb;
  font-weight: 500;
}
.review-action-dock .review-primary-actions .confirm-cta-caution:hover:not(:disabled) { background: #fef3c7; }

/* 自动推进开关(任务流):小字复选,不与确认按钮抢视觉 */
.auto-advance-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
/* 次要动作缩小一号:重拍/更多 —— 确认是热路径大按钮,其余点得着就行。
   更多按钮在 MoreMenu 子组件里,scoped 样式要 :deep() 才穿得进去(不然它保持 36px 掉行)。 */
.review-action-dock .review-primary-actions .ghost-button:not(.confirm-cta),
.review-action-dock .review-primary-actions .danger-button,
.review-action-dock .review-primary-actions .danger-ghost-button,
.review-action-dock .review-primary-actions :deep(.more-menu .trigger) {
  flex: 0 0 auto;
  min-height: 30px;
  font-size: 12px;
  font-weight: 500;
  padding: 0 10px;
}
.review-action-dock .review-primary-actions :deep(.more-menu) { flex: 0 0 auto; }

/* 重拍分键选择器(0727反馈#10):锚在重拍按钮上方,三键横排一次点/一次按键完成 */
.rephoto-split { position: relative; flex: 0 0 auto; }
.rephoto-picker {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0; /* 重拍钮在 dock 右侧,左锚 246px 宽弹层会溢出视口右缘(1280 实测 1280.34) */
  display: flex;
  gap: 4px;
  padding: 6px;
  background: var(--panel, #fff);
  border: 1px solid var(--border, #d1d5db);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.14);
  z-index: 30;
  white-space: nowrap;
}
.rephoto-picker button {
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.rephoto-picker button:hover:not(:disabled) { background: #f3f4f6; }

/* 键盘快捷键角标:确认/重拍按钮上的小提示,熟手一眼知道 Enter/R */
/* 检查器模式行:任何状态都有值,一眼知道这张票的处理路数 */
/* 换票护罩:一小拍内吞掉打在移动靶上的点击(键盘流不受影响) */
.review-inspector.settling { pointer-events: none; }

/* 模式=数据不是状态(0728 image84 对齐;d70b9cc4 硬规则:胶囊只作状态)——
   紫底药丸降为灰字纯文本,右上角 StatusBadge 才是这张票唯一的状态胶囊。 */
.inspector-mode-chip {
  display: inline-block;
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}

/* 操作栏整小一号(用户反馈:按钮太大) */
.review-action-dock button {
  min-height: 32px;
  font-size: 13px;
  padding: 4px 12px;
}

/* ── 顶部瘦身(2026-07-26)────────────────────────────────────────────────
   批次上下文内联:建档日期是弱信息(灰小字),换团号表是低频动作(下划线链接),
   两者都不该占一整行带框卡片。 */
.rv-batch-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.rv-gc-link {
  border: none; background: none; padding: 0;
  color: var(--accent, #2563eb); font-size: 12px; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px; white-space: nowrap;
}
.rv-gc-link:hover { color: #1d4ed8; }
.rv-actions-gap { flex: 1 1 auto; min-width: 0; } /* 把结算本批次/更多推到最右 */

/* 三类提示统一写法:不带框、单行、图标+彩色字;动作=下划线链接。
   报错=红 / 全通过=绿 / 日常提醒=蓝。原来三种提示各自一个带框 section,
   边框+内边距+按钮把顶部撑高一大截。 */
.rv-notice {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 2px; margin-bottom: 4px;
  font-size: 13px; line-height: 1.5;
  border-bottom: 1px solid var(--line);
}
.rv-notice-icon {
  flex: none; width: 16px; height: 16px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 500; color: #fff;
}
.rv-notice-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-notice-text.is-locatable { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
.rv-notice-link {
  flex: none; border: none; background: none; padding: 0;
  font-size: 13px; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.rv-notice-link:disabled { opacity: 0.5; cursor: default; }
.rv-notice-link.is-danger { color: #b42318; }
.rv-notice-close {
  flex: none; border: none; background: none; cursor: pointer;
  color: var(--muted); font-size: 16px; line-height: 1; padding: 0 2px;
}
.rv-notice-close:hover { color: var(--text); }
/* 报错=红 */
.rv-notice.is-error { border-bottom-color: #fecdca; }
.rv-notice.is-error .rv-notice-icon { background: #d92d20; }
.rv-notice.is-error .rv-notice-text { color: #b42318; }
.rv-notice.is-error .rv-notice-link { color: #b42318; }
/* 全通过=灰阶(0729 绿删补漏:原 border #a6f4c5 / icon #079455) */
.rv-notice.is-ok { border-bottom-color: #cbd5e1; }
.rv-notice.is-ok .rv-notice-icon { background: #64748b; }
.rv-notice.is-ok .rv-notice-text { color: #475569; }
.rv-notice.is-ok .rv-notice-link { color: var(--accent); } /* 链接=蓝(硬规则:蓝只给可点击) */
/* 日常提醒=蓝 */
.rv-notice.is-info { border-bottom-color: #b2ddff; }
.rv-notice.is-info .rv-notice-icon { background: #2563eb; }
.rv-notice.is-info .rv-notice-text { color: #175cd3; }
.rv-notice.is-info .rv-notice-link { color: #175cd3; }
/* 待办承接=琥珀(波2:待补救指向下一步工作流;硬规则 红橙=要你处理) */
.rv-notice.is-warn { border-bottom-color: #fedf89; }
.rv-notice.is-warn .rv-notice-icon { background: #b45309; }
.rv-notice.is-warn .rv-notice-text { color: #b45309; }
.rv-notice.is-warn .rv-notice-link { color: var(--accent); }

.stance-locked-fields {
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
}

.kbd-hint {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border: 0.5px solid currentColor;
  border-radius: 4px;
  font-size: 11px;
  opacity: 0.75;
  line-height: 1.5;
}

/* 确认即结算开关:移到顶部「更多」菜单(不再占操作栏,UI精简) */
.more-menu-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text, #334155);
  cursor: pointer;
  user-select: none;
}
.more-menu-toggle input { cursor: pointer; }

.settle-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 16px;
}
.settle-card {
  background: #fff;
  border-radius: 14px;
  width: min(520px, 100%);
  max-height: 86vh;
  overflow: auto;
  padding: 18px 20px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}
.settle-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.settle-head strong { font-size: 1rem; color: #111827; }
.settle-meta { margin: 6px 0 12px; font-size: 0.82rem; color: #6b7280; }
.settle-list { list-style: none; margin: 0; padding: 0; }
.settle-row {
  padding: 10px 0; border-top: 1px solid #eef0f3; font-size: 0.86rem;
}
.settle-row-main { display: flex; align-items: center; gap: 10px; }
/* P1 内联补救区:未命中行内展开(原因人话+候选下拉/改日期+确认) */
.settle-remedy {
  margin-top: 8px; padding: 10px 12px;
  background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px;
}
.settle-remedy-hint { margin: 0 0 8px; font-size: 0.78rem; color: #92400e; line-height: 1.5; }
.settle-remedy-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.settle-remedy-select { min-width: 180px; max-width: 240px; font-size: 0.82rem; padding: 4px 8px; }
.settle-remedy-input { width: 140px; font-size: 0.82rem; padding: 4px 8px; }
.settle-remedy-btn { font-size: 0.82rem; padding: 5px 12px; }
.settle-remedy-done {
  background: #f1f5f9; border-color: #cbd5e1; color: #475569; font-size: 0.8rem;
}
.settle-remedy-error { margin: 8px 0 0; font-size: 0.8rem; color: #b91c1c; }
.settle-apply-rest { margin-top: 8px; display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.settle-apply-rest button { font-size: 0.8rem; }
.settle-apply-note { font-size: 0.76rem; color: #b45309; }
.settle-no { font-weight: 500; color: #111827; min-width: 96px; }
.settle-arrow { color: #9ca3af; }
.settle-mode { flex: 1; color: #b45309; font-weight: 500; }
.settle-mode.matched { color: #111827; }
.settle-chip { font-size: 0.74rem; padding: 2px 9px; border-radius: 999px; font-weight: 500; }
.settle-chip.ok { background: #f1f5f9; color: #475569; } /* 0728 绿删:结算完成=正常,灰阶 */
.settle-chip.mid { background: #eef2ff; color: #3730a3; } /* 已出模式·桶待映射(≠未命中) */
.settle-chip.warn { background: #fef3c7; color: #b45309; }
.settle-empty { padding: 14px 0; color: #9ca3af; font-size: 0.85rem; text-align: center; }
.settle-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 16px; padding-top: 12px; border-top: 1px solid #eef0f3;
}
.settle-foot .muted { font-size: 0.8rem; color: #6b7280; }

/* 全局忙碌横幅:固定顶部居中,亮着=正在处理(重切/恢复原图/补小票等),消失=完成 */
.review-busy-banner {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 999px;
  background: #1d4ed8;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 6px 20px rgba(29, 78, 216, 0.35);
}
.busy-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: busy-spin 0.8s linear infinite;
}
@keyframes busy-spin { to { transform: rotate(360deg); } }
</style>
