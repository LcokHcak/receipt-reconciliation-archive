<script setup>
// F5: 通用分页表 — Bills / GroupCodes 共用,后续 Errors/Missing 也可复用。
//
// columns: Array<{
//   key:    string,                        // row[key] 取值
//   label:  string,                        // 表头
//   align?: 'left' | 'right' | 'center',
//   width?: string,                        // CSS width
//   format?: (row) => string,              // 单元格格式化(纯文本)
// }>
// 视图可以通过命名插槽 `#cell-{key}="{ row }"` 完全覆盖某列的渲染。
//
// 分页通过 @prev / @next 抛出,父组件管理 offset。
import { ref } from 'vue'
import Button from '@/components/ui/button.vue'

defineProps({
  columns:    { type: Array,  required: true },
  rows:       { type: Array,  required: true },
  rowKey:     { type: String, default: 'id' },
  loading:    { type: Boolean, default: false },
  total:      { type: Number, default: 0 },
  limit:      { type: Number, default: 50 },
  offset:     { type: Number, default: 0 },
  emptyText:  { type: String, default: '暂无数据' },
  title:      { type: String, default: '' },     // 收起条标题(可选)
  collapsible:{ type: Boolean, default: true },  // 顶部一键收起(默认开)
})
const emit = defineEmits(['prev', 'next'])
const open = ref(true)

function cellText(col, row) {
  if (typeof col.format === 'function') return col.format(row)
  const v = row[col.key]
  return v == null || v === '' ? '—' : v
}
function alignClass(col) {
  if (col.align === 'right') return 'text-right'
  if (col.align === 'center') return 'text-center'
  return 'text-left'
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="collapsible"
      class="flex cursor-pointer select-none items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm hover:bg-muted/50"
      @click="open = !open"
    >
      <span class="inline-block text-xs text-muted-foreground transition-transform" :class="{ 'rotate-90': open }">▸</span>
      <span class="font-medium">{{ title || '数据列表' }}</span>
      <span class="text-xs text-muted-foreground">{{ total || rows.length }} 条</span>
    </div>
    <div v-show="open" class="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
      <table class="w-full caption-bottom text-sm">
        <thead class="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th
              v-for="col in columns" :key="col.key"
              :class="['px-3 py-2', alignClass(col)]"
              :style="col.width ? { width: col.width } : null"
            >
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td :colspan="columns.length" class="px-3 py-8 text-center text-muted-foreground">加载中…</td>
          </tr>
          <tr v-else-if="!rows.length">
            <td :colspan="columns.length" class="px-3 py-8 text-center text-muted-foreground">{{ emptyText }}</td>
          </tr>
          <tr
            v-for="row in rows" v-else :key="row[rowKey]"
            data-testid="data-table-row"
            class="border-b border-border/60 hover:bg-muted/30"
          >
            <td v-for="col in columns" :key="col.key" :class="['px-3 py-2', alignClass(col)]">
              <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">
                <span>{{ cellText(col, row) }}</span>
              </slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-show="open" class="flex items-center justify-between text-sm text-muted-foreground">
      <span>第 {{ Math.floor(offset / limit) + 1 }} 页 · 共 {{ Math.max(1, Math.ceil(total / Math.max(1, limit))) }} 页 · {{ total }} 条</span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="offset === 0" @click="emit('prev')">上一页</Button>
        <Button variant="outline" size="sm" :disabled="offset + limit >= total" @click="emit('next')">下一页</Button>
      </div>
    </div>
  </div>
</template>
