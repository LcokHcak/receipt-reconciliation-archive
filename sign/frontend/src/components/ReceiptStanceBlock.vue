<script setup>
/**
 * ReceiptStanceBlock — 票级两步流的第一步:本票团号表态区(2026-07-10 用户拍板)。
 *
 * 放在检查器字段区上方,仅小票且非豁免时出现。三件套:
 *   ①匹配:输入框=groupNoFinal 唯一录入口(改团号不用改第二遍),保存即触发预匹配出模式;
 *   ②无团号·直接确认:人看图确认票上没有团号 → tourStance='none' 解锁全审;
 *   ③S活动勾选:票面属性查团号查不出,人工标记(强制升S处理,独立于①②)。
 * 附:同团号多模式店消歧不了(store_mismatch)→ 列候选模式按钮人选一(写 modeManualPick,
 *     仅影响审核侧;结算权威终匹配照旧自查表);同组其它票已确认的号 → 置顶建议(点了才上屏)。
 */
import { computed, nextTick, ref, watch } from 'vue'

import { groupKeyOfTask, normalizeDocType } from '../lib/reviewDisplay'
import { useWorkbenchStore } from '../stores/workbench'

const props = defineProps({
  task: { type: Object, required: true },
})
// 'stanced':表态完成(匹配/无团号)→ 父层可推进 Enter 流。
// 'declare-dept':这其实是百货 → 父层原子定型为百货(免团号)并按需恢复被切碎的原图。
const emit = defineEmits(['stanced', 'declare-dept'])

const workbench = useWorkbenchStore()
const saving = ref('')
const draftTour = ref('')
const tourInputRef = ref(null)

watch(() => props.task?.id, () => { draftTour.value = String(props.task?.groupNoFinal || props.task?.groupNoAuto || '').trim() }, { immediate: true })

// 键盘直达(2026-07-13 报障"输入框打不进字"加固):切到未表态小票就把焦点放进团号输入框,
// 操作员不用先点一下——即便有浏览器插件浮层(如翻译挂件)压在面板上抢点击,键盘照样能敲。
// 监听 [id, stanced] 二元组:换票聚焦;「改」回锁(stanced→未表态)也重新聚焦。
watch(() => [props.task?.id, String(props.task?.tourStance || '').trim()], ([, stance]) => {
  if (stance) return
  // preventScroll(2026-07-13 跳票误点报障):切到下一张未表态小票时聚焦团号输入框,但绝不让浏览器
  // 顺带把 .review-field-scroll 容器滚回顶部——那次瞬间跳动会把[匹配]下方的[改成护照]顶到鼠标下,
  // 一点就误改类型清空 OCR 字段。键盘直达保留,滚动副作用掐断。
  nextTick(() => { tourInputRef.value?.focus?.({ preventScroll: true }) })
}, { immediate: true })

// 整块点哪都聚焦输入框(点到按钮/输入框本体除外):把"可点中"面积放大到整个表态卡
function focusTourInput(e) {
  const tag = String(e?.target?.tagName || '').toLowerCase()
  if (tag === 'button' || tag === 'input' || tag === 'label') return
  tourInputRef.value?.focus?.({ preventScroll: true })
}

const matchStatus = computed(() => String(props.task?.groupNoMatchStatus || ''))
const suggestion = computed(() => String(props.task?.groupNoSuggestion || ''))
// store_mismatch / mode_ambiguous 时后端把表内候选模式串放 modeStoreMismatch。
// 分隔符容错(2026-07-12 审计顺手修):后端实际用 " / " 拼,旧注释写顿号——两种都认,
// 存量任务字段不重算也能拆出独立按钮(原先整串黏成一颗按钮,点了写错 manualPick)。
const mismatchModes = computed(() => String(props.task?.modeStoreMismatch || '').split(/\s*[、/]\s*/).map((s) => s.trim()).filter(Boolean))

// 同组其它小票已表态 matched 的团号(去重):置顶建议,点了才填,不自动灌(准比快)。
const siblingTours = computed(() => {
  const key = groupKeyOfTask(props.task)
  const seen = new Set()
  for (const t of workbench.tasks || []) {
    if (t.id === props.task.id || groupKeyOfTask(t) !== key) continue
    if (normalizeDocType(t) !== 'receipt' || t.tourStance !== 'matched') continue
    const v = String(t.groupNoFinal || '').trim()
    if (v && v !== '无') seen.add(v)
  }
  return [...seen].slice(0, 3)
})

async function patch(payload, label) {
  if (saving.value) return null
  saving.value = label
  try {
    return await workbench.updateTask(props.task.id, payload)
  } catch { return null } finally { saving.value = '' }
}

// ①匹配:写团号(唯一入口)+ 表态 matched;保存触发预匹配,徽章/模式即时更新。
async function confirmMatch() {
  const v = draftTour.value.trim()
  if (!v) return
  const res = await patch({ groupNoFinal: v, tourStance: 'matched' }, 'match')
  if (res) emit('stanced')
}

// ②无团号:空着确认,人背书"票上没有团号",解锁全审;下游走现有无团号路径。
async function confirmNoTour() {
  const res = await patch({ groupNoFinal: '', tourStance: 'none' }, 'none')
  if (res) emit('stanced')
}

// ③S活动:票面属性人工标记,独立开关(表态前后都能勾)。
async function toggleSActivity(e) {
  await patch({ sActivityFlag: Boolean(e.target.checked) }, 'sflag')
}

// 多模式候选人选:写 modeManualPick(绑定当时团号),预匹配守卫尊重人选。
async function pickMode(mode) {
  const res = await patch({ modeManualPick: mode, modeManualPickTour: draftTour.value.trim(), tourStance: 'matched' }, 'pick')
  if (res) emit('stanced')
}

function useSibling(v) { draftTour.value = v }

// 误分类逃生口(2026-07-13 登机牌病例):这张根本不是小票(登机牌/包装/截图)时,
// 不该被表态锁逼着先对不存在的团号表态——这里直接改类型走人。
// 后端 clearEditableFieldsForDocTypeSwitch 连字段+表态残留一起清,预匹配触发点③清徽章。
async function retype(docType) {
  // 误点兜底(2026-07-13 跳票误点报障):改类型后端会清空该票所有 OCR 字段且不可逆。
  // 只在这张票**已经识别出关键字段**时才拦一道确认——真误分类(还没数据)的空票不加摩擦。
  const hasData = ['receiptNoFinal', 'receiptNoAuto', 'groupNoFinal', 'groupNoAuto', 'receiptStoreFinal', 'receiptStoreAuto']
    .some((k) => String(props.task?.[k] || '').trim())
  if (hasData && !window.confirm('这张票已识别出小票号/团号等字段,改类型会把这些字段清空且无法恢复。确定要改吗?')) return
  await patch({ docTypeFinal: docType }, 'retype')
}

// 「这其实是百货」逃生口(2026-07-13):百货被误当成免税小票卡在团号闸时,一键点百货店定型。
// 交父层(ReviewView)原子处理:docType=receipt + 百货店 + 清团号,isTourExemptTask 立即为真、
// 本表态块自行消失;若这张是被切碎的百货合影,父层再确认恢复整张原图。放在锁定区之外,点得到。
function declareDept(store) {
  if (saving.value) return
  emit('declare-dept', store)
}

const stanced = computed(() => Boolean(String(props.task?.tourStance || '').trim()))

// 与本组其它票不一致的黄提示(误中防线之一):已匹配且组内存在别的号。
const siblingMismatch = computed(() => (
  stanced.value
  && props.task?.tourStance === 'matched'
  && siblingTours.value.length > 0
  && !siblingTours.value.includes(String(props.task?.groupNoFinal || '').trim())
))

// 「改」:回锁本票重走两步(B2:后端也会在团号变化时清通过)。
async function reopen() {
  await patch({ tourStance: '' }, 'reopen')
}

function statusHint(s) {
  return {
    matched: '命中团号表',
    not_found: '表里查不到——核对团号;确认没写错就先匹配,换表后自动复核',
    fuzzy_candidate: '近似候选可用',
    pending_table: '团号表还没就绪',
    store_mismatch: '同团号多模式,票店分不开——下面人选一个',
    mode_ambiguous: '该团号在表里对应多个渠道(同一家店两位代理)——系统不自动选,请在下面点一个',
  }[s] || ''
}
</script>

<template>
  <div class="stance-block" :class="{ done: stanced }" @click="focusTourInput">
    <template v-if="!stanced">
      <div class="stance-head">
        <strong>第一步 · 本票团号</strong>
        <span v-if="matchStatus" class="stance-hint" :class="matchStatus">{{ statusHint(matchStatus) }}</span>
      </div>
      <div v-if="siblingTours.length" class="stance-siblings">
        <span class="muted">本组已确认:</span>
        <button v-for="v in siblingTours" :key="v" type="button" class="sib-chip" @click="useSibling(v)">{{ v }}</button>
        <span class="muted">(点了才填,不自动)</span>
      </div>
      <div class="stance-input-row">
        <input
          ref="tourInputRef"
          v-model="draftTour"
          type="text"
          placeholder="团号(读出的已带入;票上没有则点右边「无团号」)"
          @keydown.enter.prevent="confirmMatch"
        >
        <button type="button" class="primary-button" :disabled="!draftTour.trim() || Boolean(saving)" @click="confirmMatch">
          {{ saving === 'match' ? '匹配中…' : '匹配 ↵' }}
        </button>
        <button type="button" class="ghost-button" :disabled="Boolean(saving)" @click="confirmNoTour">
          {{ saving === 'none' ? '…' : '无团号·直接确认' }}
        </button>
      </div>
      <div v-if="suggestion && suggestion !== draftTour" class="stance-suggestion">
        近似候选:<button type="button" class="sib-chip" @click="useSibling(suggestion)">{{ suggestion }}</button>
      </div>
      <div v-if="mismatchModes.length" class="stance-pick">
        <span>该团号对应多个模式,选一个:</span>
        <button v-for="m in mismatchModes" :key="m" type="button" class="sib-chip" @click="pickMode(m)">{{ m }}</button>
      </div>
      <div class="stance-retype">
        <span class="muted">识别错了?这不是小票:</span>
        <button type="button" class="ghost-button" :disabled="Boolean(saving)" @click="retype('passport')">改成护照</button>
        <button type="button" class="ghost-button" :disabled="Boolean(saving)" @click="retype('other')">改成其他(登机牌/包装等)</button>
      </div>
      <div class="stance-retype stance-dept">
        <span class="muted">这其实是百货(免团号):</span>
        <button type="button" class="dept-chip" :disabled="Boolean(saving)" @click="declareDept('LOTTE_DEPT')">乐天百货</button>
        <button type="button" class="dept-chip" :disabled="Boolean(saving)" @click="declareDept('SHINSEGAE_DEPT')">新世界百货</button>
        <button type="button" class="dept-chip" :disabled="Boolean(saving)" @click="declareDept('HYUNDAI_DEPT')">现代百货</button>
      </div>
    </template>
    <template v-else>
      <div class="stance-done-row">
        <span v-if="task.tourStance === 'none'" class="stance-done-text none">已确认:票上无团号(全审)</span>
        <template v-else>
          <span class="stance-done-text">{{ task.groupNoFinal }}</span>
          <span v-if="matchStatus === 'not_found'" class="stance-hint not_found">表内暂无·换表自动复核</span>
        </template>
        <!-- 「改」不再挂 ghost-button(image84 对齐):它是低频逃生口,不该有和「匹配」同级的
             按钮框;纯文字链接,靠 margin-left:auto 贴到内容右缘 -->
        <button type="button" class="stance-edit" :disabled="Boolean(saving)" @click="reopen">改</button>
      </div>
      <p v-if="siblingMismatch" class="stance-warn">与本组其它票团号不一致——多团是可能的,顺手看一眼原图</p>
    </template>
    <label class="stance-sflag" :title="'S活动是票面属性(红标签/活动特征),查团号查不出——看图确认后勾上,强制按S处理(全审+红签+按S交付)'">
      <input type="checkbox" :checked="Boolean(task.sActivityFlag)" :disabled="Boolean(saving)" @change="toggleSActivity">
      S活动票
    </label>
  </div>
</template>

<style scoped>
.stance-block {
  border: 1px solid #93c5fd;
  border-radius: 10px;
  background: #eff6ff;
  padding: 10px 12px;
  margin-bottom: 10px;
  display: grid;
  gap: 8px;
}
/* 已表态态取消整块绿底(2026-07-27 设计整改):背景色是很重的强调手段,只该用在需要
   打断你的时候。「已通过」状态由右上角徽章负责,这里回到中性,不再是第 3、4 处绿色。
   2026-07-29 image84 对齐:连框一起去掉。表态做完之后这块不再是"要你填的表单",
   而是一条**结论**(团号是多少);边框+内边距在这里只是噪音,还把「改」往里推了 12px,
   和上面 done/total 的右缘对不齐。去框后 68420 靠字号自己站住。
   ⚠️未表态态(蓝卡)不动:那时它是待办输入区,框是有意义的。 */
.stance-block.done {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  margin-bottom: 8px;
  gap: 3px;
}
.stance-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.stance-hint { font-size: 11px; color: #1d4ed8; }
.stance-hint.not_found, .stance-hint.store_mismatch, .stance-hint.mode_ambiguous { color: #b45309; }
.stance-siblings, .stance-suggestion, .stance-pick, .stance-retype { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
/* 与[匹配]拉开真实间距 + 实色分隔(2026-07-13 跳票误点):改类型是破坏性操作,不能贴着[匹配]热区 */
.stance-retype { margin-top: 14px; padding-top: 8px; border-top: 1px solid #dbeafe; }
.stance-dept { border-top: none; padding-top: 0; margin-top: 0; }
.dept-chip {
  border: 1px solid #c4b5fd;
  border-radius: 999px;
  background: #f5f3ff;
  color: #6d28d9;
  padding: 3px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.dept-chip:hover { background: #ede9fe; border-color: #a78bfa; }
.dept-chip:disabled { opacity: .5; cursor: default; }
.sib-chip {
  border: 1px solid #93c5fd;
  border-radius: 999px;
  background: #fff;
  padding: 2px 10px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  cursor: pointer;
}
.sib-chip:hover { background: #dbeafe; }
.stance-input-row { display: flex; gap: 6px; align-items: center; }
.stance-input-row input { flex: 1; min-height: 32px; font-family: ui-monospace, monospace; }
/* baseline 对齐(image84):30px 的号码和 13px 的「改」按中线对会让「改」浮在半空,
   按基线对才是同一行字的关系。 */
.stance-done-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
/* 团号恢复中性主文本色:它是**数据**,不是状态。绿色只留给「已通过」徽章和快检那行小字。
   字号 20→30px(image84):去掉卡片后,这条结论靠**大小**建立层级,不靠边框。 */
.stance-done-text { font-family: ui-monospace, monospace; font-weight: 500; color: var(--text); font-size: 30px; line-height: 1.15; }
/* 「票上无团号」是一句话不是一个号,不能跟着涨到 30px(会换行占两行) */
.stance-done-text.none { font-family: inherit; font-weight: 500; font-size: 16px; }
.stance-edit {
  margin-left: auto;
  border: none;
  background: none;
  min-height: 0;
  padding: 0;
  color: var(--accent, #2563eb);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.stance-edit:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 2px; }
.stance-edit:disabled { opacity: .5; cursor: default; }
.stance-warn { margin: 0; font-size: 11px; color: #b45309; }
/* S活动票回中性(image84):没勾时它只是个可选项,常年红字会把真正该红的地方稀释掉。
   勾上=票面确实被标了 S(强制升S处理、全审、按S交付),那时才转红加重——
   颜色留给"真的发生了"。:has 不支持的浏览器退化成中性,不影响功能。 */
.stance-sflag { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); font-weight: 400; }
.stance-sflag:has(input:checked) { color: #b91c1c; font-weight: 500; }
.muted { color: var(--muted); font-size: 11px; }
</style>
