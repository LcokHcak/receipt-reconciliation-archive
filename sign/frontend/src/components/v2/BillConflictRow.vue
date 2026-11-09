<script setup>
import { reactive, computed, watch } from 'vue'
import { FolderSearch, RefreshCw } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'

const props = defineProps({
  // 台账冲突行(daily_receipt_export 整行,含台账基础信息 + conflictFields 字段名)
  row: { type: Object, required: true },
  // 每个冲突字段的台账/账单两侧值: [{ field, dailyValue, billValue }]
  conflicts: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'use-daily', 'use-bill', 'rerun', 'track-folder'])

const FIELD_LABELS = {
  receiptNo: '小票号',
  passportNo: '护照号',
  purchaseDate: '购买日期',
  departureDate: '离境日期',
  tourNo: '团号',
  name: '姓名',
  netKrw: '净卖出(₩)',
}

function label(field) {
  return FIELD_LABELS[field] || field
}

// 兼容三种来源:① 带值的 conflicts(pending detail);
// ② row.conflictFields 为对象数组 [{field,dailyValue,billValue,kind}](账单字段冲突 / 台账一致性B类);
// ③ row.conflictFields 为纯字段名字符串数组(旧/退化)。
const conflictFields = computed(() => {
  if (props.conflicts.length) return props.conflicts
  return (props.row.conflictFields || []).map((c) => {
    if (c && typeof c === 'object') {
      return {
        field: c.field,
        dailyValue: c.dailyValue ?? props.row[c.field] ?? null,
        billValue: c.billValue ?? null,
        kind: c.kind || null,
      }
    }
    return { field: c, dailyValue: props.row[c] ?? null, billValue: null }
  })
})

// 每个字段的选择: 'daily' | 'bill' | 'custom'，默认保留台账值
const choices = reactive({})
const customValues = reactive({})

watch(conflictFields, (list) => {
  for (const key of Object.keys(choices)) delete choices[key]
  for (const key of Object.keys(customValues)) delete customValues[key]
  for (const c of list) {
    choices[c.field] = 'daily'
    customValues[c.field] = ''
  }
}, { immediate: true })

function fmt(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

// 根据当前选择，组装 updates(只含需要改写台账的字段)
function buildUpdates() {
  const updates = {}
  for (const c of conflictFields.value) {
    const choice = choices[c.field]
    if (choice === 'bill' && c.billValue != null) {
      updates[c.field] = c.billValue
    } else if (choice === 'custom' && customValues[c.field] !== '') {
      updates[c.field] = customValues[c.field]
    }
    // 'daily' → 保留台账原值，不写 updates
  }
  return updates
}

function onConfirm() {
  emit('confirm', { dailyId: Number(props.row.id), updates: buildUpdates() })
}

function onUseDaily() {
  // 全部以台账为准:不改字段值，仅确认匹配
  emit('use-daily', { dailyId: Number(props.row.id), updates: {} })
}

function onUseBill() {
  // 全部以账单为准:把每个冲突字段写成账单值
  const updates = {}
  for (const c of conflictFields.value) {
    if (c.billValue != null) updates[c.field] = c.billValue
  }
  emit('use-bill', { dailyId: Number(props.row.id), updates })
}
</script>

<template>
  <div class="grid grid-cols-[220px_1fr_auto] gap-4 rounded-lg border border-status-warn/40 bg-card p-4 shadow-sm">
    <!-- 行前:台账基础信息 -->
    <dl class="space-y-1.5 border-r border-border pr-4 text-xs">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">台账基础信息</div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">代理</dt><dd class="font-medium text-foreground">{{ fmt(row.agent) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">收票日期</dt><dd class="font-medium text-foreground">{{ fmt(row.receiptDate) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">购买日期</dt><dd class="font-medium text-foreground">{{ fmt(row.purchaseDate) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">姓名</dt><dd class="font-medium text-foreground">{{ fmt(row.name) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">护照号</dt><dd class="font-medium text-foreground">{{ fmt(row.passportNo) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">团号</dt><dd class="font-medium text-foreground">{{ fmt(row.tourNo) }}</dd></div>
    </dl>

    <!-- 中间:字段对比 + 用台账/用账单/自定义 -->
    <div class="space-y-3">
      <div
        v-for="c in conflictFields"
        :key="c.field"
        class="rounded-md border border-border bg-muted/30 p-3"
      >
        <div class="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
          {{ label(c.field) }}
          <span v-if="c.kind === 'consistency'" class="rounded bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-normal text-status-warn">台账一致性</span>
        </div>
        <p v-if="c.kind === 'consistency' && c.note" class="mb-2 text-[11px] text-status-warn">
          ⚠️ {{ c.note }} —— 同一个客户在不同小票上{{ c.field === 'name' ? '姓名' : '护照' }}不一致,请核对真实信息后改正(用"自定义"填正确值)。
        </p>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <label
            :class="['flex cursor-pointer items-start gap-2 rounded-md border p-2 transition',
                     choices[c.field] === 'daily' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50']"
          >
            <input v-model="choices[c.field]" type="radio" class="mt-0.5" :value="'daily'">
            <span class="min-w-0">
              <span class="block text-[11px] text-muted-foreground">台账(收票)</span>
              <span class="block break-words font-medium text-foreground">{{ fmt(c.dailyValue) }}</span>
            </span>
          </label>
          <label
            :class="['flex cursor-pointer items-start gap-2 rounded-md border p-2 transition',
                     c.billValue == null ? 'cursor-not-allowed opacity-50' : '',
                     choices[c.field] === 'bill' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50']"
          >
            <input v-model="choices[c.field]" type="radio" class="mt-0.5" :value="'bill'" :disabled="c.billValue == null">
            <span class="min-w-0">
              <span class="block text-[11px] text-muted-foreground">账单(免税店)</span>
              <span class="block break-words font-medium text-status-warn">{{ fmt(c.billValue) }}</span>
            </span>
          </label>
        </div>
        <label
          :class="['mt-2 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs transition',
                   choices[c.field] === 'custom' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50']"
        >
          <input v-model="choices[c.field]" type="radio" :value="'custom'">
          <span class="text-[11px] text-muted-foreground">自定义</span>
          <input
            v-model="customValues[c.field]"
            class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs"
            :placeholder="`输入 ${label(c.field)}`"
            @focus="choices[c.field] = 'custom'"
          >
        </label>
      </div>
    </div>

    <!-- 行尾:5 按钮 -->
    <div class="flex w-[120px] flex-col gap-2">
      <Button size="sm" variant="ghost" :disabled="busy" @click="emit('track-folder', row)">
        <FolderSearch class="h-4 w-4" /> 文件夹追踪
      </Button>
      <Button size="sm" variant="outline" :disabled="busy" title="所有冲突字段都采用台账(收票)的值" @click="onUseDaily">全用台账</Button>
      <Button size="sm" variant="outline" :disabled="busy" title="所有冲突字段都采用账单(免税店)的值" @click="onUseBill">全用账单</Button>
      <Button size="sm" :disabled="busy" title="按上面每个字段所选(台账/账单/自定义)确认" @click="onConfirm">按所选确认</Button>
      <Button size="sm" variant="ghost" :disabled="busy" @click="emit('rerun', Number(row.id))">
        <RefreshCw class="h-4 w-4" /> 重新匹配
      </Button>
    </div>
  </div>
</template>
