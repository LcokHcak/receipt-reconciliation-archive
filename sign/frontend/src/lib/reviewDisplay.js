// 无团号判定单源(后端同文件,行为三合一;rolldown/Node ESM 均可吃 CJS 命名导出)
import { isNoTourTask } from '../../../lib/no_tour.js'

const DOC_TYPE_LABELS = {
  passport: '护照',
  receipt: '小票',
  other: '其他',
}

// 重拍原因分键(0727反馈#10):标重拍时顺手带一个原因,前台补拍不用再猜。
// key 落库(后端 normalizeTask 白名单),label 仅呈现;顺序即快捷键 1/2/3。
export const REPHOTO_REASONS = [
  { key: 'blurry', label: '模糊' },
  { key: 'missing', label: '缺' },
  { key: 'other', label: '其他' },
]

export function rephotoReasonLabel(key) {
  return REPHOTO_REASONS.find((r) => r.key === String(key || ''))?.label || ''
}

function clean(value) {
  return String(value || '').trim()
}

export function parseSourceReference(task = {}) {
  const parts = clean(task.sourceOriginalPath)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length < 2) {
    return { workspaceKey: '', customerId: '' }
  }

  return {
    workspaceKey: parts[0],
    customerId: parts[1],
  }
}

export function customerIdOfTask(task = {}) {
  const reference = parseSourceReference(task)
  return clean(task.sourceFolderName)
    || clean(task.sourceFolderPath)
    || reference.customerId
    || clean(task.customerId)
    || ''
}

function isTechnicalGroupLabel(value) {
  const text = clean(value)
  return /^group_[0-9a-f]{8,}$/i.test(text) || text === '__root__'
}

export function buildReviewGroupDisplay(task = {}, customerNameById = {}) {
  const customerId = customerIdOfTask(task)
  const rawLabel = clean(task.sourceGroupLabel) || clean(task.folderName) || clean(task.sourceFolderPath)
  const mappedName = clean(customerNameById[customerId]) || clean(customerNameById[rawLabel])
  const fallbackName = isTechnicalGroupLabel(rawLabel) ? customerId : rawLabel
  // 2026-07-14 报障:结算归档把客户档案 displayName 改成护照英文名(交付命名用),
  // mappedName 吃到它 → 队列组名从代理跳成客人名。左侧恒显**代理**;客户身份看 id 徽章/检查器。
  const agentName = clean(task.customerAgentName)
  const name = agentName || mappedName || fallbackName || customerId || '未归组'

  return {
    name,
    id: customerId && customerId !== name ? customerId : '',
  }
}

export function normalizeDocType(value = {}) {
  const raw = typeof value === 'string'
    ? value
    : (value.docTypeFinal || value.docTypeAuto || value.docType || '')
  const normalized = clean(raw).toLowerCase()
  if (normalized === 'passport' || normalized.includes('护照')) return 'passport'
  if (normalized === 'receipt' || normalized.includes('小票') || normalized.includes('收据')) return 'receipt'
  if (normalized === 'other' || normalized.includes('其他')) return 'other'
  return 'other'
}

export function docTypeLabel(task = {}) {
  return DOC_TYPE_LABELS[normalizeDocType(task)] || DOC_TYPE_LABELS.other
}

// ── 组/任务状态判定(单一真相源:GroupedTaskList/ReviewView 等共用,防语义漂移)──
// 客户组分组键:sourceGroupKey → sourceFolderPath → sourceGroupLabel → folderName → 未归组
const UNGROUPED_KEY = '__ungrouped__'
export function groupKeyOfTask(task = {}) {
  return task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel || task.folderName || UNGROUPED_KEY
}

export function isTaskApproved(task = {}) {
  const pr = clean(task.processResult)
  return Boolean(task.reviewed) || pr === 'approved' || pr.includes('通过')
}

// 待处理判定:重拍=待处理;已通过/已拒绝(reviewStatus/processResult 含"拒绝")都不算待处理。
// ⚠️必须与此保持一致:漏判"已拒绝"会让代理视图计数与组徽章自相矛盾(reviewer P3 HIGH)。
export function isTaskPending(task = {}) {
  if (task.rephotoRequested) return true
  if (isTaskApproved(task)) return false
  const pr = clean(task.processResult)
  const rs = clean(task.reviewStatus)
  if (pr.includes('拒绝') || rs.includes('拒绝')) return false
  return true
}

// 组内小票已命中的渠道模式(去重):识别完预匹配就有 modeRawPre,不用等结算。
export function collectGroupModes(tasks = []) {
  const seen = new Set()
  for (const task of tasks) {
    if (normalizeDocType(task) !== 'receipt') continue
    const mode = clean(task.modeRawPre)
    if (mode && (task.groupNoMatchStatus === 'matched' || task.groupNoMatchStatus === 'skipped_mode_not_required')) {
      seen.add(mode)
    }
  }
  return [...seen]
}

export function isOriginalLikeTask(task = {}) {
  const role = clean(task.autoSplitRole).toLowerCase()
  const message = clean(task.preprocessMessage).toLowerCase()
  return role === 'original'
    || message.includes('keep_original')
    || message.includes('no_split_detected')
}

export function friendlyTaskName(task = {}, sequence = 1) {
  if (isOriginalLikeTask(task)) {
    return '原图'
  }
  return `切图-${docTypeLabel(task)}-${Math.max(1, Number(sequence) || 1)}`
}

export function rawTaskName(task = {}) {
  return clean(task.fileName)
    || clean(task.originalFileName)
    || clean(task.originalName)
    || clean(task.sourceFileName)
    || clean(task.id)
}

// ── 百货店家判定(单一真相源,2026-07-13)────────────────────────────
// 后端唯一真相源在 lib/store_profiles.js isDeptStore + lib/validation/field_rules.js STORE_FAMILIES;
// 前端不能 require CJS,这里保留镜像常量,但**全前端只此一处**判定"这个店家是不是百货",
// 其它文件(reviewDisplay 各处/ReviewView/FieldEditor)一律调用 isDeptStoreValue,严禁再抄正则。
// 命中:canonical *_DEPT(LOTTE_DEPT/…含 DEPT)或原始识别文字含 百货/백화점/DEPT/DEPARTMENT。
// 关键词集与后端 lib/validation/field_rules.js DEPT_KEYWORDS 逐字对齐(复审 MEDIUM:原先漏了
// 英文 DEPT/DEPARTMENT,paddle 后端写未归一店名时会把真百货误判成免税店)。
const DEPT_STORE_RE = /百货|백화점|DEPT|DEPARTMENT/i
export function isDeptStoreValue(store) {
  return DEPT_STORE_RE.test(String(store == null ? '' : store))
}

// ── 票级两步流(2026-07-10)────────────────────────────────────────
// 票级豁免:机场票团号"无"(或表态none+空值存量行,单源 lib/no_tour)/ 百货票——免表态直接可审。
export function isTourExemptTask(task = {}) {
  if (normalizeDocType(task) !== 'receipt') return true // 护照/其它不吃团号
  if (isNoTourTask(task)) return true
  return isDeptStoreValue(task.receiptStoreFinal || task.receiptStoreAuto)
}

// 票级锁定判定:小票 && 非豁免 && 未表态(tourStance 空)→ 字段区锁定,先表态。
export function isTaskStanceLocked(task = {}) {
  if (normalizeDocType(task) !== 'receipt') return false
  if (isTourExemptTask(task)) return false
  return !clean(task.tourStance)
}

// 客户组"护照是否齐"(与后端 lib/validation/group_passport_rule 同口径):普通组=有独立护照任务;
// 百货票护照与小票同框,护照信息落在百货小票任务上(passportNo/英文名)也算齐。回执"缺护照"用。
function isDeptReceiptCarryingPassport(task = {}) {
  if (normalizeDocType(task) !== 'receipt') return false
  if (!isDeptStoreValue(task.receiptStoreFinal || task.receiptStoreAuto)) return false
  return Boolean(clean(task.passportNoFinal || task.passportNoAuto) || clean(task.extractedNameFinal || task.extractedNameAuto))
}
// ⚠️ 这份实现必须与后端 lib/validation/group_passport_rule.js 的 groupPassportIssue 逐例一致。
// 「一致」不是靠这行注释,是靠 tests/group_passport_front_back_parity.test.js **真的把两份跑同一批
// 用例对拍**。原来这里写着"此清单由 parity 测试锁平",可那条测试从头到尾只加载后端那份 ——
// 承诺是假的,分歧因此活了下来:2 本独立护照时前端判「齐」(界面不提示)、后端判不合格(拦结算),
// 审核员看着没问题、点确认才被拒。
//
// 结构按后端逐段抄下来(顺序也一样),改动时两边一起改,parity 测试会咬。
export function groupHasPassport(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : []
  const passports = list.filter((t) => normalizeDocType(t) === 'passport')
  const receipts = list.filter((t) => normalizeDocType(t) === 'receipt')
  // 真相源=lib/store_profiles 的 passportFree 旗标;这份清单由 parity 测试锁平,别单独改。
  const PASSPORT_FREE_DEPT = ['SHINSEGAE_DEPT', 'HYUNDAI_DEPT']
  const storeOf = (t) => String(t.receiptStoreFinal || t.receiptStoreAuto || '').trim().toUpperCase()
  const isDept = (t) => isDeptStoreValue(t.receiptStoreFinal || t.receiptStoreAuto)
  const isPassportFree = (t) => PASSPORT_FREE_DEPT.includes(storeOf(t))

  if (receipts.some(isDept)) {
    if (passports.length > 1) return false // 2+ 独立护照会取错,后端也拦
    if (passports.length === 1) return true
    const pureDept = receipts.length > 0 && receipts.every(isDept)
    if (pureDept) {
      if (receipts.every(isPassportFree)) return true // 新世界/现代票面本就无护照
      return receipts.some(isDeptReceiptCarryingPassport) // 乐天同框票:有一张带身份即可
    }
    // 混合组(百货+免税同组):免税那部分离不开护照,要求百货票自带身份兜底
    return receipts.some((t) => isDept(t) && isDeptReceiptCarryingPassport(t))
  }
  return passports.length === 1 // 普通免税组:恰好 1 本
}

// 组内展示/Enter 流排序:护照 → 小票 → 其它,原图参考件殿后;同类保持原始相对顺序(稳定)。
// ⚠️只用于显示与导航,绝不回写存储顺序(切图/任务命名依赖原始顺序,乱序=串图前科)。
export function sortTasksForReview(tasks = []) {
  const rank = (t) => {
    if (isOriginalLikeTask(t)) return 3
    const d = normalizeDocType(t)
    if (d === 'passport') return 0
    if (d === 'receipt') return 1
    return 2
  }
  return tasks
    .map((task, index) => ({ task, index, rank: rank(task) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((x) => x.task)
}

// ── 确认站豁免与待确认计数(TourConfirmPanel 与顶栏角标共用,防口径漂移)──────
// 豁免(与后端 exemptOf 同口径):百货(canonical *_DEPT 或原始文字)/机场票"无"/整组无小票。
export function isTourExemptGroupTasks(tasks = []) {
  const receipts = tasks.filter((t) => normalizeDocType(t) === 'receipt')
  if (!receipts.length) return true
  return receipts.every((t) => {
    if (isNoTourTask(t)) return true
    return isDeptStoreValue(t.receiptStoreFinal || t.receiptStoreAuto)
  })
}

// 待匹配组数(2026-07-10 票级两步流):组内存在"未表态的小票"即待匹配。
// 给顶栏角标/队列筛选用;票级判定=isTaskStanceLocked(单一真相源)。
export function tourConfirmPendingCount(tasks = []) {
  const pendingGroups = new Set()
  for (const task of tasks) {
    if (isTaskStanceLocked(task)) pendingGroups.add(groupKeyOfTask(task))
  }
  return pendingGroups.size
}

// ── 队列时间显示(实时队列/代理视图共用)────────────────────────────
function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 组时间 = 组内最早一张图的 createdAt(组创建时间)。稳定、对应"第几个上传的组",
 * 追加图片不会让组乱跳。缺失/无效返回空串。
 * @param {Array<{createdAt?: string}>} tasks
 * @returns {string} ISO 时间串或 ''
 */
export function groupCreatedAt(tasks = []) {
  let earliest = ''
  for (const task of tasks) {
    const at = clean(task.createdAt)
    if (at && (earliest === '' || at < earliest)) earliest = at
  }
  return earliest
}

/**
 * 完整时间戳(悬停提示用):YYYY-MM-DD HH:mm:ss。无效返回 ''。
 * @param {string} iso
 * @returns {string}
 */
export function fullTimestamp(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 队列排序(纯函数,可测):按 mode 排客户组,返回新数组、不改原数组。
 * group 需含 { createdAt, label, pendingCount, rephotoCount }。
 *   newest       组创建时间降序(默认,最新在上)
 *   oldest       组创建时间升序(最早在上)
 *   pendingFirst 有待审工作的组(pending>0||rephoto>0)在前、已通过沉底,组内再按时间降序
 * createdAt 相同时按 label 本地化比较兜底,保证确定性。
 * @param {Array<{createdAt?: string, label?: string, pendingCount?: number, rephotoCount?: number}>} groups
 * @param {'newest'|'oldest'|'pendingFirst'} [mode]
 * @returns {Array}
 */
export function sortReviewGroups(groups = [], mode = 'newest') {
  const tieByLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN')
  // dir=-1 降序(晚的在前),dir=1 升序(早的在前);时间相等按 label 兜底。
  const cmpTime = (a, b, dir) => {
    const at = clean(a.createdAt)
    const bt = clean(b.createdAt)
    if (at !== bt) return at < bt ? -dir : dir
    return tieByLabel(a, b)
  }
  const hasWork = (g) => ((g.pendingCount > 0 || g.rephotoCount > 0) ? 0 : 1) // 0=待审在前,1=已通过沉底
  const arr = [...groups]
  arr.sort((a, b) => {
    if (mode === 'oldest') return cmpTime(a, b, 1)
    if (mode === 'pendingFirst') {
      const ra = hasWork(a)
      const rb = hasWork(b)
      if (ra !== rb) return ra - rb
      return cmpTime(a, b, -1)
    }
    // 异常优先(任务流改造):重拍组置顶(要人处理的堵点集中清),其余待办次之、已完成沉底;
    // 桶内 FIFO(最早在前)—— 异常也不许无限压制更早的正常件之外的顺序感。
    if (mode === 'abnormalFirst') {
      const rank = (g) => ((g.rephotoCount || 0) > 0 ? 0 : hasWork(g) === 0 ? 1 : 2)
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      return cmpTime(a, b, 1)
    }
    // 代理连续(任务流改造):同代理(组名代理化后 displayName=代理名)的组排在一起,
    // 代理间按"该代理最早一组"的时间定先后 —— 连续处理同一代理,但不无限压制更早任务:
    // 谁先来谁的代理先整体处理。组内仍 FIFO。
    if (mode === 'agentGroup') {
      const an = String(a.displayName || a.label || '')
      const bn = String(b.displayName || b.label || '')
      if (an !== bn) {
        const firstOf = (name) => {
          let min = ''
          for (const g of groups) {
            const n = String(g.displayName || g.label || '')
            if (n !== name) continue
            const t = clean(g.createdAt)
            if (!min || (t && t < min)) min = t
          }
          return min
        }
        const fa = firstOf(an)
        const fb = firstOf(bn)
        if (fa !== fb) return fa < fb ? -1 : 1
        return an.localeCompare(bn, 'zh-Hans-CN')
      }
      return cmpTime(a, b, 1)
    }
    return cmpTime(a, b, -1) // newest
  })
  return arr
}

/**
 * 相对时间(24h 内显示"8分钟前/3小时前"),更早显示 MM-DD HH:mm。
 * nowMs 可注入便于测试;负差(时钟偏差)按"刚刚"处理。
 * @param {string} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatQueueTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = nowMs - t
  if (diff < 60000) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const d = new Date(t)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 队列行只显示时刻(2026-07-26 用户需求②):日期由顶部「建档 MM-DD」承载,
// 每行再带一遍 MM-DD 是重复信息还挤掉了名字宽度。完整时间戳仍在 title 悬停里。
export function formatQueueClock(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 客户号短号(2026-07-26 用户需求④):完整 CL20260722-001 里 CL+日期段与批次建档日重复,
// 列表宽度不够只能截成没用的「C…」。只留末段序号(001)——同代理多组照样能一眼区分,
// 完整客户号进 title 悬停(排查/搜索仍可用全号)。
export function shortCustomerId(customerId) {
  const s = String(customerId || '').trim()
  if (!s) return ''
  const m = /-(\w+)$/.exec(s)
  return m ? m[1] : s
}

// ── 队列搜索(2026-07-13 用户需求:861组里翻"已通过"找 JIANG AITONG 只能挨个看)──
// 归一口径:大写化+去所有空白 → "jiang aitong"/"JIANGAITONG"都命中"JIANG AITONG"。
export function normalizeQueueQuery(raw) {
  // 大写化 + 去空白**与连字符**:小票号/护照号常带杠(901125-26-006433、CHN-H231),
  // 搜纯数字/字母串要能命中带杠的存储值(2026-07-24 用户反馈:审核台搜小票号搜不到)。
  return String(raw || '').toUpperCase().replace(/[\s-]/g, '')
}

// 组是否命中搜索词:组显示名/客户号/组标签 + 组内任务的英文名/护照号/团号/中文名。
// query 传归一化后的串(normalizeQueueQuery);空串=不过滤恒真。
export function matchesGroupSearch(group = {}, normalizedQuery = '') {
  if (!normalizedQuery) return true
  const hay = [group.displayName, group.customerId, group.label, group.key]
  for (const task of group.tasks || []) {
    if (!task) continue // 脏元素(删除残留引用)不许炸穿整个队列 computed(体检 MEDIUM)
    hay.push(
      task.extractedNameFinal, task.extractedNameAuto,
      task.chineseNameFinal, task.chineseNameAuto,
      task.passportNoFinal, task.passportNoAuto,
      task.groupNoFinal, task.groupNoAuto,
      // 小票号(2026-07-24 用户反馈:审核台搜小票号搜不到)——Final/Auto/原始串都进 hay,
      // 归一化去杠后纯数字可命中带杠存储值。
      task.receiptNoFinal, task.receiptNoAuto, task.receiptNoRawAuto,
    )
  }
  return hay.some((v) => normalizeQueueQuery(v).includes(normalizedQuery))
}

// ══ 任务流水线改造(2026-07-27 用户提词)══════════════════════════════════════
// 队列从"资料列表"转向"工作队列":等待分级/概览/命中字段/多排序 的纯口径都放这层,
// 组件只做渲染 —— 数字算错在这层就能被 node 测试逮住。

// 等待分级阈值(十一:统一配置,禁止散落多文件)。这是**审核队列内**的节奏线,
// 与批次级 stale(24h,workbench_overview)是两个层面的规则,阈值独立。
export const WAIT_TIERS = Object.freeze({
  warningMs: 2 * 60 * 60 * 1000, // 2小时:即将超时(当天审当天票的业务节奏)
  overdueMs: 4 * 60 * 60 * 1000, // 4小时:已超时
})

/**
 * 组等待分级:normal | warning | overdue。只对"还有活"的组有意义,
 * 已审完的组传 hasWork=false 恒回 normal(完成件不存在"超时")。
 */
export function waitTierOf(iso, nowMs = Date.now(), hasWork = true) {
  if (!hasWork) return 'normal'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'normal'
  const diff = nowMs - t
  if (diff >= WAIT_TIERS.overdueMs) return 'overdue'
  if (diff >= WAIT_TIERS.warningMs) return 'warning'
  return 'normal'
}

/**
 * 队列概览(P6):三桶与 groupFilterKey 同构(rephoto>0→异常;pending==0→已完成;其余→待处理),
 * 互斥且穷尽,done+pending+abnormal === total 恒成立 —— 顶部数字与页签计数天然一致。
 */
export function buildQueueSummary(groups = []) {
  let done = 0
  let pending = 0
  let abnormal = 0
  for (const g of groups) {
    if ((g.rephotoCount || 0) > 0) abnormal += 1
    else if ((g.pendingCount || 0) === 0 && (g.total || 0) > 0) done += 1
    else pending += 1
  }
  const total = groups.length
  return { total, done, pending, abnormal, ratio: total > 0 ? done / total : 0 }
}

// 搜索命中字段(十三.7):帮用户确认"为什么这条命中了"。返回首个命中的字段中文名,''=未知。
const SEARCH_FIELD_LABELS = [
  [(g) => [g.displayName, g.label], '姓名'],
  [(g) => [g.customerId], '客户号'],
  [(g) => (g.tasks || []).flatMap((t) => t ? [t.extractedNameFinal, t.extractedNameAuto, t.chineseNameFinal, t.chineseNameAuto] : []), '姓名'],
  [(g) => (g.tasks || []).flatMap((t) => t ? [t.passportNoFinal, t.passportNoAuto] : []), '护照号'],
  [(g) => (g.tasks || []).flatMap((t) => t ? [t.groupNoFinal, t.groupNoAuto] : []), '团号'],
  [(g) => (g.tasks || []).flatMap((t) => t ? [t.receiptNoFinal, t.receiptNoAuto, t.receiptNoRawAuto] : []), '小票号'],
]
export function matchedFieldOfGroup(group = {}, normalizedQuery = '') {
  if (!normalizedQuery) return ''
  for (const [pick, label] of SEARCH_FIELD_LABELS) {
    if (pick(group).some((v) => normalizeQueueQuery(v).includes(normalizedQuery))) return label
  }
  return ''
}
