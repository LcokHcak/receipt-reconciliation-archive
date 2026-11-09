<script setup>
import { reactive, watch } from 'vue'
import { History } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import { useRowHistory } from '@/composables/useRowHistory'
import FieldDiff from './FieldDiff.vue'

const props = defineProps({
  item: { type: Object, default: null },
})

const emit = defineEmits(['skip', 'apply'])
const { openRowHistory } = useRowHistory()
const resolutions = reactive({})
const locks = reactive({})

watch(() => props.item?.id, () => {
  for (const key of Object.keys(resolutions)) delete resolutions[key]
  for (const key of Object.keys(locks)) delete locks[key]
  props.item?.fields.forEach((field) => {
    locks[field.field] = false
  })
}, { immediate: true })

function setResolution(field, value) {
  resolutions[field] = value
}

function setLock(field, value) {
  locks[field] = value
}

function acceptAll() {
  props.item?.fields.forEach((field) => {
    resolutions[field.field] = { field: field.field, action: 'accept', value: field.incoming }
  })
}

function apply() {
  if (!props.item) return
  emit('apply', {
    conflictId: props.item.id,
    passportNo: props.item.passportNo,
    fields: props.item.fields.map((field) => ({
      field: field.field,
      resolution: resolutions[field.field] || null,
      lockField: Boolean(locks[field.field]),
    })),
  })
}
</script>

<template>
  <section class="rounded-lg border border-border bg-card shadow-sm">
    <div v-if="item" class="flex min-h-full flex-col">
      <div class="border-b border-border p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-lg font-medium text-foreground">护照 #{{ item.passportNo }}</h2>
              <StatusBadge variant="info" size="sm">{{ item.mode }}</StatusBadge>
            </div>
            <p class="mt-1 text-sm text-muted-foreground">{{ item.customerName }} · 购买日期 {{ item.purchaseDate || '2026-05-12' }}</p>
          </div>
          <Button variant="outline" size="sm" @click="openRowHistory(item.rowId || item.dailyRowId || 'd1')">
            <History class="h-4 w-4" />
            查看历史
          </Button>
        </div>
      </div>

      <div class="flex-1 space-y-4 p-4">
        <FieldDiff
          v-for="field in item.fields"
          :key="field.field"
          :field="field"
          :resolution="resolutions[field.field]"
          :lock="locks[field.field]"
          @update:resolution="setResolution(field.field, $event)"
          @update:lock="setLock(field.field, $event)"
        />
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
        <Button variant="ghost" @click="emit('skip', item.id)">跳过</Button>
        <Button variant="outline" @click="acceptAll">全部接受新值</Button>
        <Button data-testid="apply-conflict-resolution" @click="apply">应用解决</Button>
      </div>
    </div>

    <div v-else class="p-10 text-center text-sm text-muted-foreground">
      本月所有字段冲突已处理 ✓
    </div>
  </section>
</template>
