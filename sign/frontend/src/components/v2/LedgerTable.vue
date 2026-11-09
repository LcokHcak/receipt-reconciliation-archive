<script setup>
import { computed } from 'vue'
import { Pencil, Trash2 } from 'lucide-vue-next'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'

defineProps({
  rows:    { type: Array, required: true },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['edit', 'delete'])

const TOUR_STATUS = {
  pending:                   { label: '待匹配', variant: 'info' },
  matched:                   { label: '已匹配', variant: 'ok' },
  tour_not_found:            { label: '未命中', variant: 'warn' },
  agent_mismatch:            { label: '代理不一致', variant: 'warn' },
  date_out_of_window:        { label: '日期越界', variant: 'warn' },
  mode_unresolved:           { label: '模式未归类', variant: 'warn' },
  skipped_mode_not_required: { label: '未选择·待归类', variant: 'info' },
  date_missing:              { label: '缺购买日期', variant: 'warn' },
}

const BILL_STATUS = {
  unmatched:      { label: '未匹配', variant: 'warn' },
  matched:        { label: '已匹配', variant: 'ok' },
  pending_review: { label: '待人工', variant: 'warn' },
}

const SOURCE_LABEL = { workbench: '审核台', imported: '导入', manual: '手工' }
const BILL_PRIORITY = {
  1: { label: 'P1 票号',      variant: 'ok' },
  2: { label: 'P2 护照+日期', variant: 'ok' },
  3: { label: 'P3 护照',      variant: 'info' },
  4: { label: 'P4 团+护照',   variant: 'info' },
  5: { label: 'P5 模糊',      variant: 'warn' },
  6: { label: 'P6 兜底',      variant: 'warn' },
}

function sourceLabel(row) {
  return SOURCE_LABEL[row.sourceType] || row.sourceType || '—'
}

function tourStatusOf(row) {
  return TOUR_STATUS[row.tourMatchStatus] || { label: row.tourMatchStatus || '—', variant: 'info' }
}

function billStatusOf(row) {
  return BILL_STATUS[row.billMatchStatus] || { label: row.billMatchStatus || '—', variant: 'info' }
}

function priorityOf(row) {
  const p = Number(row.billMatchPriority ?? row.bill_match_priority)
  if (!Number.isFinite(p) || p <= 0) return null
  return BILL_PRIORITY[p] || { label: `P${p}`, variant: 'info' }
}

const colSpan = computed(() => 10)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full caption-bottom text-sm">
      <thead class="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
        <tr>
          <th class="px-3 py-2 text-left">日期</th>
          <th class="px-3 py-2 text-left">来源</th>
          <th class="px-3 py-2 text-left">姓名 / 护照</th>
          <th class="px-3 py-2 text-left">匹配模式</th>
          <th class="px-3 py-2 text-left">归类</th>
          <th class="px-3 py-2 text-left">团号</th>
          <th class="px-3 py-2 text-right">净额 KRW</th>
          <th class="px-3 py-2 text-left">团号匹配</th>
          <th class="px-3 py-2 text-left">账单匹配</th>
          <th class="px-3 py-2 text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading">
          <td :colspan="colSpan" class="px-3 py-8 text-center text-muted-foreground">加载中…</td>
        </tr>
        <tr v-else-if="!rows.length">
          <td :colspan="colSpan" class="px-3 py-8 text-center text-muted-foreground">当前筛选条件下没有台账行</td>
        </tr>
        <tr
          v-for="row in rows"
          v-else
          :key="row.id"
          data-testid="ledger-row"
          class="border-b border-border/60 hover:bg-muted/30"
        >
          <td class="px-3 py-2 font-mono text-xs">{{ row.purchaseDate || '—' }}</td>
          <td class="px-3 py-2 text-xs">{{ sourceLabel(row) }}</td>
          <td class="px-3 py-2">
            <div class="font-medium text-foreground">{{ row.name || '—' }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ row.passportNo || '—' }}</div>
          </td>
          <td class="px-3 py-2 text-xs">{{ row.modeRaw || row.modeNormalized || row.modeFolder || '—' }}</td>
          <td class="px-3 py-2 text-xs">{{ row.modeFolder || '—' }}</td>
          <td class="px-3 py-2 font-mono text-xs">{{ row.tourNo || '—' }}</td>
          <td class="px-3 py-2 text-right">
            <TabularNumber :value="row.netKrw" placeholder="—" />
          </td>
          <td class="px-3 py-2">
            <StatusBadge :variant="tourStatusOf(row).variant" size="sm">{{ tourStatusOf(row).label }}</StatusBadge>
          </td>
          <td class="px-3 py-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <StatusBadge :variant="billStatusOf(row).variant" size="sm">{{ billStatusOf(row).label }}</StatusBadge>
              <StatusBadge v-if="priorityOf(row)" :variant="priorityOf(row).variant" size="sm">{{ priorityOf(row).label }}</StatusBadge>
            </div>
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right">
            <button
              type="button"
              title="编辑字段"
              class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              @click="emit('edit', row)"
            >
              <Pencil class="h-3 w-3" />
            </button>
            <button
              type="button"
              title="删除"
              class="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-status-error hover:bg-status-error/10"
              @click="emit('delete', row)"
            >
              <Trash2 class="h-3 w-3" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
