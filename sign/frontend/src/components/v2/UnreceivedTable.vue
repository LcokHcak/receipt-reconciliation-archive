<script setup>
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import LinkSuggestion from './LinkSuggestion.vue'

defineProps({
  rows: { type: Array, default: () => [] },
  selectedIds: { type: Object, required: true },
  expandedIds: { type: Object, required: true },
  type: { type: String, default: 'bill' },
})

const emit = defineEmits(['toggle', 'select', 'select-all', 'link', 'delay', 'void'])

function priorityVariant(priority) {
  if (priority <= 2) return 'ok'
  if (priority <= 4) return 'warn'
  return 'info'
}

function primaryColumnLabel(type) {
  if (type === 'bill') return '账单号'
  if (type === 'known') return '未收小票'
  return 'daily 行'
}
</script>

<template>
  <div data-testid="unreceived-table" class="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
    <table class="w-full text-sm">
      <thead class="bg-muted/40 text-xs text-muted-foreground">
        <tr>
          <th class="w-10 px-3 py-3 text-left">
            <input type="checkbox" :checked="rows.length > 0 && rows.every((row) => selectedIds.has(row.id))" @change="emit('select-all', $event.target.checked)">
          </th>
          <th class="px-3 py-3 text-left">{{ primaryColumnLabel(type) }}</th>
          <th class="px-3 py-3 text-left">账单桶</th>
          <th class="px-3 py-3 text-left">模式</th>
          <th class="px-3 py-3 text-left">金额</th>
          <th class="px-3 py-3 text-left">优先</th>
          <th class="px-3 py-3 text-left">日期</th>
          <th class="px-3 py-3 text-left">候选</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.id">
          <tr data-testid="unreceived-row" class="border-t border-border hover:bg-muted/40">
            <td class="px-3 py-3">
              <input type="checkbox" :checked="selectedIds.has(row.id)" @change="emit('select', row.id, $event.target.checked)">
            </td>
            <td class="px-3 py-3 font-medium text-foreground">{{ row.billNo || row.id }}</td>
            <td class="px-3 py-3">{{ row.folder || '—' }}</td>
            <td class="px-3 py-3">{{ row.mode }}</td>
            <td class="px-3 py-3">
              <TabularNumber :value="row.amount" /> {{ row.currency }}
            </td>
            <td class="px-3 py-3">
              <StatusBadge v-if="row.priority != null" :variant="priorityVariant(row.priority)" size="sm">P<TabularNumber :value="row.priority" /></StatusBadge>
              <span v-else class="text-muted-foreground">—</span>
            </td>
            <td class="px-3 py-3 font-mono">{{ row.date }}</td>
            <td class="px-3 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" @click="emit('toggle', row.id)">
                  <ChevronDown v-if="expandedIds.has(row.id)" class="h-4 w-4" />
                  <ChevronRight v-else class="h-4 w-4" />
                  <TabularNumber :value="row.candidates.length" /> 个候选
                </Button>
                <Button size="sm" variant="outline" @click="emit('delay', row)">标延</Button>
                <Button size="sm" variant="outline" @click="emit('void', row)">作废</Button>
              </div>
            </td>
          </tr>
          <tr v-if="expandedIds.has(row.id)" class="border-t border-border bg-muted/20">
            <td />
            <td colspan="7" class="px-3 py-3">
              <LinkSuggestion :candidates="row.candidates" @link="emit('link', row, $event)" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-if="!rows.length" class="p-10 text-center text-sm text-muted-foreground">本月所有未匹配账单已处理 ✓</p>
  </div>
</template>
