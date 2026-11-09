<script setup>
import { Lock } from 'lucide-vue-next'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import Tooltip from '@/components/ui/tooltip.vue'

defineProps({
  items: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
})

const emit = defineEmits(['select'])

function topSeverity(item) {
  return item.fields.some((field) => field.severity === 'error') ? 'error' : 'warn'
}

function lockedCount(item) {
  return item.fields.filter((field) => field.isLocked).length
}
</script>

<template>
  <aside class="rounded-lg border border-border bg-card shadow-sm">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="font-medium text-foreground">冲突列表</h2>
      <StatusBadge variant="info" size="sm">
        <TabularNumber :value="items.length" /> 条
      </StatusBadge>
    </div>

    <div class="max-h-[680px] overflow-auto p-2">
      <button
        v-for="item in items"
        :key="item.id"
        data-testid="conflict-row"
        type="button"
        class="mb-2 w-full rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-muted/50"
        :class="activeId === item.id ? 'border-primary bg-primary/10' : ''"
        @click="emit('select', item.id)"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-medium text-foreground">{{ item.passportNo }} · {{ item.customerName }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ item.mode }} · {{ item.age }}</p>
          </div>
          <StatusBadge :variant="topSeverity(item)" size="sm">{{ topSeverity(item) }}</StatusBadge>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span v-for="field in item.fields" :key="field.field">{{ field.label }}</span>
          <Tooltip v-if="lockedCount(item)">
            <template #trigger>
              <span class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
                <Lock class="h-3 w-3" />
                <TabularNumber :value="lockedCount(item)" />
              </span>
            </template>
            此字段已锁定,不会被 OCR 覆盖
          </Tooltip>
        </div>
      </button>
      <p v-if="!items.length" class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        本月所有字段冲突已处理 ✓
      </p>
    </div>
  </aside>
</template>
