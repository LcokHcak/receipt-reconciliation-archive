<script setup>
// 中栏顶部统计卡(2026-07-24 改版:主行 3 状态桶互斥+和=总数,副行活动/量)。
// 数据口径在 agentWorkspaceDisplay.buildStatCards(纯函数,享单测);此处只负责呈现。
// X/Y = 当前代理 / 全部代理(选了代理才显示分母)。
import { computed, ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'

import { buildStatCards, projectionLagText } from '../../lib/agentWorkspaceDisplay'

// P3 真票数下钻:按客户组 / 按票 切换(记 localStorage);仅换主行数值口径。
const AW_UNIT_KEY = 'aw_stat_unit'
const unit = ref((() => {
  try { return localStorage.getItem(AW_UNIT_KEY) === 'receipt' ? 'receipt' : 'group' } catch { return 'group' }
})())
function setUnit(u) {
  unit.value = u
  try { localStorage.setItem(AW_UNIT_KEY, u) } catch { /* localStorage 不可用则仅本次生效 */ }
}

const props = defineProps({
  summary: { type: Object, default: null },
  projectionLagMs: { type: Number, default: null },
  warnings: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  // 需求E②:选中日(YYYY-MM-DD)。后端已把统计窗口收窄到那天,这里只负责改说法(今日→当日)。
  day: { type: String, default: '' },
})
const emit = defineEmits(['retry'])

const cards = computed(() => buildStatCards(props.summary, unit.value, Boolean(props.day)))
const mainCards = computed(() => cards.value.filter((c) => c.row === 'main'))
const auxCards = computed(() => cards.value.filter((c) => c.row === 'aux'))
const lagText = computed(() => projectionLagText(props.projectionLagMs))
const unlabeled = computed(() => props.warnings?.unlabeledAgentCustomers || 0)
// 0729:后端 warnings 里一直有两个数,界面只显示了「未标代理」一个,
// **「月份判不出来」算了但全站零处消费**。它的后果比未标代理更隐蔽:
// 这些客户在按月筛选时根本不出现 —— 操作员看「2026-07」时他们是隐形的,
// 不会有任何地方提示"还有 N 个人你没看到"。
// 生产实测当前为 0(18083 个客户投影里 0 个),所以补上显示零噪音;
// 正因为健康态是 0,它一旦亮起来就一定是真问题。
const unknownMonth = computed(() => props.warnings?.unknownMonthCustomers || 0)

// null = 该口径在当前筛选下不适用(如选了历史日的「当日已审」——投影时间不是审核时间,
// 后端拒绝给一个假的 0)。渲染成「—」,不把"不知道"画成"是 0"。
function rawValue(card) {
  return card.hasAgent ? card.agentCount : card.allCount
}
function shown(card) {
  const v = rawValue(card)
  return v == null ? '—' : v
}
// 值是「—」时不跟单位:「— 批」读着像个数量,而这里的意思是"这个口径现在没法算"
function unitOf(card) {
  return rawValue(card) == null ? '' : card.unitText
}
function titleOf(card) {
  if (rawValue(card) == null) return '选中历史日期时无法统计:投影刷新时间不等于审核时间,给不出可信数字'
  return card.hasAgent ? '数字 = 当前代理 / 全部代理' : '数字 = 全部代理'
}
</script>

<template>
  <div class="ws-summary" role="status" aria-label="工作台统计">
    <div v-if="error" class="ws-err">
      <span>{{ error }}</span>
      <button type="button" class="ws-icon-btn" title="重试" aria-label="重试统计" @click="emit('retry')">
        <RefreshCw :size="14" />
      </button>
    </div>
    <template v-else-if="summary">
      <div class="ws-unit-toggle" role="group" aria-label="统计口径:按客户组或按票">
        <button type="button" :class="{ active: unit === 'group' }" @click="setUnit('group')">按客户组</button>
        <button type="button" :class="{ active: unit === 'receipt' }" @click="setUnit('receipt')">按票</button>
      </div>
      <div class="ws-cards">
        <div
          v-for="card in mainCards"
          :key="card.key"
          class="ws-card"
          :class="`ws-card--${card.tone}`"
          :title="[card.hint, card.hasAgent ? '数字 = 当前代理 / 全部代理' : '数字 = 全部代理'].filter(Boolean).join('\n')"
        >
          <span class="ws-card-label">{{ card.label }}</span>
          <span class="ws-card-num">
            <strong>{{ shown(card) }}</strong>
            <em v-if="card.hasAgent">/{{ card.allCount }}</em>
            <!-- 需求E④:数字带单位——2700 看不出是「组」还是「张」 -->
            <i v-if="card.unitText" class="ws-card-unit">{{ card.unitText }}</i>
          </span>
          <span class="ws-card-bar" aria-hidden="true">
            <span :style="{ width: `${Math.round(card.ratio * 100)}%` }" />
          </span>
        </div>
      </div>
      <div class="ws-aux">
        <span
          v-for="card in auxCards"
          :key="card.key"
          class="ws-aux-item"
          :title="titleOf(card)"
        >
          <span class="ws-aux-label">{{ card.label }}</span>
          <span class="ws-aux-val">{{ shown(card) }}<em v-if="card.hasAgent && card.agentCount != null">/{{ card.allCount }}</em><i v-if="unitOf(card)" class="ws-card-unit">{{ unitOf(card) }}</i></span>
        </span>
      </div>
      <div v-if="lagText || unlabeled > 0 || unknownMonth > 0" class="ws-notes">
        <span v-if="lagText" class="ws-note">{{ lagText }}</span>
        <span v-if="unlabeled > 0" class="ws-note">未标代理 {{ unlabeled }}</span>
        <!-- 说清后果:这些人按月筛选时看不见,不是"少了个标签"那么轻 -->
        <span
          v-if="unknownMonth > 0"
          class="ws-note ws-note-warn"
          title="这些客户的月份判不出来,按月份筛选时不会出现在任何一个月里 —— 需要去建档页确认他们的收票日期"
        >月份不明 {{ unknownMonth }}(按月筛选看不到)</span>
      </div>
    </template>
    <span v-else-if="loading" class="ws-muted">统计加载中…</span>
  </div>
</template>

<style scoped>
.ws-summary { min-width: 0; }
/* 按组/按票 切换(P3):小分段控件 */
.ws-unit-toggle { display: inline-flex; margin-bottom: 8px; border: 1px solid #e4e7ec; border-radius: 8px; overflow: hidden; }
.ws-unit-toggle button { border: none; background: #fff; color: #667085; font-size: 12px; padding: 4px 12px; cursor: pointer; }
.ws-unit-toggle button + button { border-left: 1px solid #e4e7ec; }
.ws-unit-toggle button.active { background: #2563eb; color: #fff; font-weight: 500; }
.ws-unit-toggle button:not(.active):hover { background: #f9fafb; }
.ws-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.ws-card {
  display: flex; flex-direction: column; gap: 4px; min-width: 0;
  border: 1px solid #eef0f3; border-radius: 12px; padding: 10px 12px; background: #fbfcfd;
}
.ws-card-label { font-size: 12px; color: #667085; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-card-num { display: flex; align-items: baseline; gap: 1px; }
.ws-card-num strong { font-size: 22px; font-weight: 500; color: #101828; font-variant-numeric: tabular-nums; }
.ws-card-num em { font-style: normal; font-size: 13px; color: #98a2b3; }
/* 单位跟在数字后,比数字小一号、灰一档:只做量纲说明,不跟数字抢眼 */
.ws-card-unit { font-style: normal; font-size: 12px; color: #98a2b3; margin-left: 2px; }
.ws-card-bar { height: 3px; border-radius: 999px; background: #eef0f3; overflow: hidden; }
.ws-card-bar > span { display: block; height: 100%; background: #64748b; border-radius: 999px; }
/* 状态桶配色语义(克制:只给数字+底色浅一点,不整卡大红大绿) */
.ws-card--ok { background: #f8fafc; border-color: #e2e8f0; } /* 0728 绿删:已完成=正常,灰阶 */
.ws-card--ok .ws-card-num strong { color: #0f172a; }
.ws-card--ok .ws-card-bar > span { background: #94a3b8; }
/* accent 桶 = 「排队待审」,它自己的 hint 就写着「不用特别去动」。
   原来给的是蓝 —— 整行最响的颜色,给了唯一一个不用你管的桶,比「已完成」还抢眼。
   硬规则「蓝只给可点击」把它挪回灰阶;灰阶是**一个阶**,取比 --ok 深一档,
   「排队中」仍然重于「已完成」,只是不再喊。 */
.ws-card--accent { background: #f1f5f9; border-color: #e2e8f0; }
.ws-card--accent .ws-card-num strong { color: #334155; }
.ws-card--warn { background: #fffaeb; border-color: #fedf89; }
.ws-card--warn .ws-card-num strong { color: #b54708; }
.ws-card--warn .ws-card-bar > span { background: #f79009; }
/* 副行:小号活动/量读数 */
.ws-aux { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
.ws-aux-item {
  display: inline-flex; align-items: baseline; gap: 6px;
  border: 1px solid #eef0f3; border-radius: 8px; padding: 4px 10px; background: #fbfcfd;
}
.ws-aux-label { font-size: 12px; color: #667085; }
.ws-aux-val { font-size: 14px; font-weight: 500; color: #344054; font-variant-numeric: tabular-nums; }
.ws-aux-val em { font-style: normal; font-size: 12px; color: #98a2b3; font-weight: 400; }
.ws-notes { margin-top: 6px; display: flex; gap: 8px; }
.ws-note { color: #b54708; background: #fffaeb; border-radius: 4px; padding: 1px 8px; font-size: 12px; }
/* 「月份不明」比「未标代理」严重:那些人按月筛选时压根不出现,所以给更强的红橙
   (硬规则:红橙=要处理)。健康态是 0,不会平白多一块颜色。 */
.ws-note-warn { color: #b91c1c; background: #fee2e2; }
.ws-err { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #b42318; }
.ws-muted { color: #98a2b3; font-size: 13px; }
.ws-icon-btn { display: inline-flex; align-items: center; border: none; background: none; cursor: pointer; color: #475467; padding: 2px; }

@media (max-width: 1100px) {
  .ws-cards { grid-template-columns: repeat(2, 1fr); }
}
</style>
