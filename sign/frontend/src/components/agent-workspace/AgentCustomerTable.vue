<script setup>
// 中栏:客户表(服务端分页)。列序对齐规格 2026-07-13:
// 序号 | 姓名 | 收票时间(绝对+相对两行) | 图片数 | 审核状态(仅已通过绿) | 免税店 | 模式(最醒目) | 下一步任务 | 操作(去审核台)。
// 固定列宽+行高,动态文字省略不推布局;模式候选必带「候选」标记(空心)。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ExternalLink, RefreshCw, Settings } from 'lucide-vue-next'

import {
  statusLabel, statusColorKind, customerModeChips,
  formatReceivedDay, relativeTime, customerStoresText,
  taskChipLabel,
} from '../../lib/agentWorkspaceDisplay'

const props = defineProps({
  customers: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  nextCursor: { type: String, default: '' },
  selectedPk: { type: String, default: '' },
  // P1(A2):customerId → pending 任务列表(行内徽章;勾选确认在右栏任务列)
  pendingTaskMap: { type: Object, default: null },
})
const emit = defineEmits(['select', 'open', 'loadMore', 'retry', 'filterMode', 'configTask'])

const seq = (i) => String(i + 1).padStart(3, '0')

// 该客户的 pending 任务(没有就是空数组 → 单元格留空)。pendingTaskMap 由父级从 store.tasks 建。
const EMPTY_TASKS = []
function tasksOf(customer) {
  const map = props.pendingTaskMap
  if (!map || typeof map.get !== 'function') return EMPTY_TASKS
  return map.get(customer.customerId) || EMPTY_TASKS
}

// 相对时间要"活"(复审 MEDIUM):翻页后 60s 轻刷跳过客户列表以保滚动,
// 若只在重渲染时求值,"3分钟前"会永久冻结、误导审核员。每 60s tick 一次强制重算。
const nowMs = ref(Date.now())
let clockTimer = null
onMounted(() => { clockTimer = setInterval(() => { nowMs.value = Date.now() }, 60_000) })
onBeforeUnmount(() => { if (clockTimer) clearInterval(clockTimer) })
</script>

<template>
  <div class="cust-table-wrap">
    <div v-if="error" class="ct-state">
      <span class="ct-error">{{ error }}</span>
      <button type="button" class="ct-retry" @click="emit('retry')"><RefreshCw :size="13" /> 重试</button>
    </div>
    <div v-else-if="!loading && !customers.length" class="ct-state ct-muted">
      当前筛选下没有客户。换个月份、代理或状态试试。
    </div>

    <table v-else class="cust-table" aria-label="客户列表">
      <colgroup>
        <col style="width: 5%">
        <col style="width: 17%">
        <col style="width: 10%">
        <col style="width: 7%">
        <col style="width: 10%">
        <col style="width: 18%">
        <col style="width: 23%">
        <col style="width: 10%">
      </colgroup>
      <thead>
        <tr>
          <th scope="col">序号</th>
          <th scope="col">姓名</th>
          <th scope="col">收票日</th>
          <th scope="col">票/图数</th>
          <th scope="col">免税店</th>
          <th scope="col">模式</th>
          <!-- 齿轮贴在列头(2026-07-29 用户拍板·甲案),只留图标不带字:它是低频跳转,不重要。
               ⚠️措辞刻意**不说**"改这一列的内容"——本列的任务来自 workflow_task,subtype 由
               lib/review_lane.js sendbackActionOfMode() 正则扫**模式名字符串**得出;配置台勾的
               actions 只喂审核台字段区的提醒签(FieldEditor)和批次导出备注列(workbench_receipt_export)。
               两条链目前没有交汇点(已单独立项待接线),tooltip 不许暗示因果,
               否则就是"我在配置台改了这列没反应"的报障源头。 -->
          <th scope="col" class="ct-th-task">
            <span>状态 · 任务</span>
            <button
              type="button"
              class="ct-task-cfg"
              aria-label="配置任务:去配置台设置模式的任务规则"
              title="去配置台设置模式的任务规则(审核台提醒签 + 导出备注列)"
              @click="emit('configTask')"
            >
              <Settings :size="13" />
            </button>
          </th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(c, i) in customers"
          :key="c.customerPk"
          :class="{ selected: selectedPk === c.customerPk }"
          @click="emit('select', c)"
        >
          <td class="ct-seq">{{ seq(i) }}</td>
          <td class="ct-name-cell">
            <!-- P1(A1):姓名不再跳转(与右侧「去审核」重复,用户拍板删一个保右侧) -->
            <span v-if="c.customerName" class="ct-name">{{ c.customerName }}</span>
            <span v-else class="ct-name ct-name-pending">(待识别)</span>
          </td>
          <td class="ct-time">
            <span class="ct-time-abs">{{ formatReceivedDay(c.receivedAt) }}</span>
            <small class="ct-time-rel">{{ relativeTime(c.receivedAt, nowMs) }}</small>
          </td>
          <td class="ct-imgs">
            {{ c.originalImageCount || 0 }}张<em v-if="c.abnormalImageCount > 0" class="ct-abn" :title="`异常图 ${c.abnormalImageCount}`">!</em>
          </td>
          <td class="ct-store" :title="customerStoresText(c)">{{ customerStoresText(c) }}</td>
          <td class="ct-modes-cell">
            <button
              v-for="chip in customerModeChips(c)"
              :key="chip.kind + chip.mode"
              type="button"
              class="ct-mode"
              :class="chip.kind"
              :title="(chip.kind === 'candidate' ? '候选模式,团号未确认' : '已确认模式') + ';点击按此模式筛选'"
              @click.stop="emit('filterMode', chip.mode)"
            >
              {{ chip.label }}
            </button>
            <span v-if="!customerModeChips(c).length" class="ct-muted">—</span>
          </td>
          <td class="ct-nexttask">
            <!-- 2026-07-27 需求E③:状态徽章 + **真实待办任务**。四节点进度条已撤(每行都一样=没信息,
                 且它讲的是审核进度,状态徽章已经说了)。没有 pending 任务就留空——空白即"不用管"。 -->
            <span class="ct-status" :class="statusColorKind(c.reviewStatus)">{{ statusLabel(c.reviewStatus) }}</span>
            <span v-if="tasksOf(c).length" class="ct-tasks">
              <em
                v-for="t in tasksOf(c)"
                :key="t.id"
                class="ct-task"
                :title="`待办:${taskChipLabel(t)}(发出/收齐后系统自动完成)`"
              >{{ taskChipLabel(t) }}</em>
            </span>
          </td>
          <td>
            <button
              v-if="c.batchId"
              type="button"
              class="ct-open"
              :title="`打开审核台(批次 ${c.batchId})`"
              @click.stop="emit('open', c)"
            >
              <ExternalLink :size="13" /> 去审核台
            </button>
            <span v-else class="ct-muted" title="这位客户的图还没进过任何审核批次">未入批次</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="ct-footer">
      <span v-if="loading" class="ct-muted">加载中…</span>
      <button
        v-else-if="nextCursor"
        type="button"
        class="ct-more"
        @click="emit('loadMore')"
      >
        加载更多
      </button>
      <span v-else-if="customers.length" class="ct-muted">已到底(共 {{ customers.length }} 条已载入)</span>
    </div>
  </div>
</template>

<style scoped>
.cust-table-wrap { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
.cust-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
.cust-table th {
  text-align: left; font-weight: 500; color: #667085; font-size: 12px;
  padding: 6px 8px; border-bottom: 1px solid #e4e7ec; position: sticky; top: 0; background: #fff; z-index: 1;
}
.cust-table td { padding: 6px 8px; border-bottom: 1px solid #f2f4f7; min-height: 46px; vertical-align: middle; overflow: hidden; }
/* P1(A3):字段信息必须显示全——长值换行展开,行高自适应,不再省略截断 */
.cust-table tbody tr { cursor: pointer; }
.cust-table tbody tr:hover { background: #f9fafb; }
.cust-table tbody tr.selected { background: #eef4ff; }
.ct-seq { color: #98a2b3; font-variant-numeric: tabular-nums; font-size: 12px; }
.ct-name-cell { overflow: hidden; }
.ct-name { display: block; word-break: break-all; white-space: normal; color: #101828; font-weight: 500; }
.ct-name-pending { color: #98a2b3; font-weight: 400; font-size: 12px; }
.ct-time { color: #667085; white-space: nowrap; }
.ct-time-abs { display: block; font-variant-numeric: tabular-nums; }
.ct-time-rel { display: block; color: #98a2b3; font-size: 11px; }
.ct-imgs { color: #667085; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct-abn { color: #b42318; font-style: normal; margin-left: 3px; font-weight: 500; }
.ct-status.ok { color: #475569; font-weight: 500; }
.ct-status.plain { color: #101828; }
.ct-store { color: #475467; word-break: break-all; white-space: normal; }
.ct-modes-cell { white-space: normal; }
.ct-mode {
  display: inline-block; margin: 1px 4px 1px 0; padding: 1px 8px; border-radius: 10px;
  font-size: 12px; font-weight: 500; vertical-align: middle;
  border: none; cursor: pointer;
}
.ct-mode.confirmed { background: #eef4ff; color: #1849a9; }
.ct-mode.candidate { background: #fff; color: #b54708; border: 1px dashed #f4c790; font-weight: 500; }
.ct-mode:hover { filter: brightness(0.94); }
/* 列头齿轮:常态灰、hover 才亮;th 只有 6px 上下内边距,图标必须 line-height:0 才不撑高表头 */
.ct-th-task { display: flex; align-items: center; gap: 4px; }
.ct-task-cfg {
  display: inline-flex; align-items: center; line-height: 0;
  border: none; background: none; padding: 0; margin: 0; cursor: pointer; color: #98a2b3;
}
.ct-task-cfg:hover { color: #175cd3; }
/* 纯图标按钮必须有可见焦点环——键盘用户看不见 hover */
.ct-task-cfg:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; border-radius: 4px; }
.ct-nexttask { color: #475467; font-size: 12px; }
/* 合并列:精确状态徽章占一行(上),四节点进度+待办徽章在下一行 */
.ct-nexttask .ct-status { display: block; margin-bottom: 3px; font-weight: 500; }
/* 真实待办任务(需求E③):一条都没有时整块不渲染,单元格留空 */
.ct-tasks { display: inline-flex; gap: 3px; flex-wrap: wrap; }
.ct-task {
  font-style: normal; font-size: 11px; padding: 0 6px; border-radius: 8px;
  background: #fef0c7; color: #b54708; line-height: 17px; white-space: nowrap;
}
.ct-open {
  display: inline-flex; align-items: center; gap: 4px; border: 1px solid #b6cff5; background: #eff4ff;
  border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; color: #1849a9; white-space: nowrap;
}
.ct-open:hover { background: #dfeaff; }
.ct-footer { padding: 10px 8px; display: flex; justify-content: center; }
.ct-more { border: 1px solid #e4e7ec; background: #fff; border-radius: 6px; padding: 5px 16px; cursor: pointer; font-size: 13px; }
.ct-state { padding: 16px 8px; display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ct-muted { color: #98a2b3; font-size: 12px; }
.ct-error { color: #b42318; }
.ct-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e4e7ec; background: #fff; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
</style>
