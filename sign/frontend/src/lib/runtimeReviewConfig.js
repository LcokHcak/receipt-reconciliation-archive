import { ref } from 'vue'

import api from '../api/client'
import {
  DEPT_KEY_TO_FINAL,
  applyDeptFieldFilter,
  buildReviewFieldPayload,
  getDeptPanelBase,
  getReviewFieldConfig,
  normalizeReviewDocType,
} from './reviewFieldConfig.js'

// ══ P3c:审核台运行时配置(配置台 C 类勾选 → 百货面板字段格)══
//
// 红线(用户:别影响我的小票):
//   - 只服务**百货面板的渲染过滤**;小票/护照面板、清场语义(buildReviewFieldPayload)一概不碰。
//   - 只有店**真配置过**(configVersion>0)才过滤;出厂店(=0)返回 null → 面板走内置常量,逐字节零变化。
//   - 拉取失败/超时静默吞掉,下个 TTL 再试——审核台永不因配置台挂(P0 手法的前端版)。
//
// state 用 Vue ref:面板 computed 依赖它,配置拉到后自动重渲,不需要组件自己轮询。
const TTL_MS = 60_000
const state = ref(null) // /api/review-config 响应:{ stamp, stores: { FAMILY: { fields, passportFree, configVersion } }, ... }
let fetchedAt = 0
let inflight = null

function refreshIfStale() {
  if (inflight || Date.now() - fetchedAt < TTL_MS) return
  inflight = api
    .get('/review-config')
    .then((data) => {
      state.value = data
    })
    .catch(() => {
      /* 拉不到=继续用出厂常量;fetchedAt 照记,防失败风暴 */
    })
    .finally(() => {
      fetchedAt = Date.now()
      inflight = null
    })
}

/**
 * 百货面板渲染用:该店配置的字段短名清单(passportNo/brand/…)。
 * 返回 null = 店没配置过(configVersion 0)或还没拉到 → 调用方走内置常量原样渲染。
 */
export function runtimeDeptFields(family) {
  refreshIfStale()
  const store = state.value?.stores?.[String(family || '')]
  if (!store || !(store.configVersion > 0)) return null
  return Array.isArray(store.fields) ? store.fields : null
}

/**
 * 门店码点选清单(0727反馈#6):出厂∪配置台增减,后端 /review-config 已合成有效清单。
 * 返回 null = 该店无门店码概念/还没拉到 → 调用方回落前端出厂镜像(LOTTE_DEPT_BRANCH_NAMES)。
 * 形状 [{ code:'0394', name:'明洞' }],name 可空(新码没店名照收)。
 */
export function runtimeBranchOptions(family) {
  refreshIfStale()
  const list = state.value?.stores?.[String(family || '')]?.branchOptions
  return Array.isArray(list) && list.length ? list : null
}

/**
 * T4(2026-07-21):某模式的有效免审键(显式relax∪「记哪些列」派生,后端已减require补回)。
 * 前端两处消费:①FieldEditor 折叠免审字段格 ②validateForSubmit 同源豁免(否则服务端放宽了、
 * 客户端本地必填仍拦确认)。canonical 归一由调用方传入(FieldEditor 经 no_tour 同款相对路径
 * 引后端单源 resolveCanonicalModeName,禁抄归一逻辑)。拉不到/无映射=空数组→全审(安全方向)。
 */
export function runtimeModeRelax(canonicalMode) {
  refreshIfStale()
  const map = state.value?.modeRelax
  if (!map || !canonicalMode) return []
  const list = map[String(canonicalMode)]
  return Array.isArray(list) ? list : []
}

/** 测试/登出场景复位。 */
export function resetRuntimeReviewConfig() {
  state.value = null
  fetchedAt = 0
  inflight = null
}

/**
 * ⭐渲染专用:百货面板按店配置过滤字段格(店没配置/拉不到=与 getReviewFieldConfig 完全一致)。
 * 面板渲染用这个;payload/草稿语义用下面的 *Runtime 包装(白名单=出厂∪配置补充键,只增不减)。
 */
export function getReviewFieldConfigRuntime(docType, store = '') {
  const dept = getDeptPanelBase(docType, store)
  if (dept) return applyDeptFieldFilter(dept.config, runtimeDeptFields(dept.canonical))
  return getReviewFieldConfig(docType, store)
}

/**
 * 配置补充键(断点⑥根修):该店配置勾选映射成 finalKey 清单,交给 buildReviewFieldPayload
 * 做**并集**白名单。注意语义:是"配置勾了什么就补什么"(∪ 出厂),不是"面板显示什么留什么"
 * (∩)——后者会在配置放宽出厂字段时把票上已填值保存时清掉(丢数据红线)。
 * 店没配置/拉不到 → 空数组=纯出厂白名单,行为逐字节不变。
 */
export function runtimeDeptExtraPayloadKeys(docType, store = '') {
  if (normalizeReviewDocType(docType) !== 'receipt') return []
  const dept = getDeptPanelBase(docType, store)
  if (!dept) return []
  const configured = runtimeDeptFields(dept.canonical)
  if (!configured) return []
  return configured.map((key) => DEPT_KEY_TO_FINAL[key]).filter(Boolean)
}

/** payload 包装:出厂白名单 ∪ 配置补充键。FieldEditor 保存/ReviewView 批量通过一律走这里。 */
export function buildReviewFieldPayloadRuntime(docType, values = {}) {
  return buildReviewFieldPayload(docType, values, runtimeDeptExtraPayloadKeys(docType, values?.receiptStoreFinal))
}

/** 草稿初始化包装:同一并集口径——配置补充字段的已存值要能进草稿,不然面板显示空、用户重敲。 */
export function normalizeReviewFieldsForTaskRuntime(task = {}) {
  const docType = task?.docTypeFinal || task?.docTypeAuto || task?.docType
  return buildReviewFieldPayloadRuntime(docType, task || {})
}
