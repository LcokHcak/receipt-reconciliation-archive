<script setup>
import { computed } from 'vue'

import { groupBatchesByDay, batchOptionLabel } from '../lib/batchGrouping'

const props = defineProps({
  batches: {
    type: Array,
    default: () => [],
  },
  modelValue: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['update:modelValue', 'on-refresh'])

// 按创建日分组(今天/昨天/MM-DD),admin 全量批次也能一眼定位。
const groupedBatches = computed(() => groupBatchesByDay(props.batches))
</script>

<template>
  <div class="batch-selector">
    <!-- image96 顶部一行化(0728):「批次」标签隐去(选择器本身就是批次上下文),
         select 收紧宽度,刷新降为 ⟳ 图标——省出的宽度让整个标题行排进一行。 -->
    <label for="batchSelector" class="sr-only">批次</label>
    <select
      id="batchSelector"
      :value="modelValue"
      @change="$emit('update:modelValue', $event.target.value)"
    >
      <option value="" disabled>选择批次</option>
      <optgroup v-for="group in groupedBatches" :key="group.key" :label="group.label">
        <option v-for="batch in group.items" :key="batch.id || batch.batchId" :value="batch.id || batch.batchId">
          {{ batchOptionLabel(batch) }}
        </option>
      </optgroup>
    </select>
    <button class="ghost-button refresh-icon" type="button" :disabled="loading" :title="loading ? '刷新中…' : '刷新'" aria-label="刷新" @click="$emit('on-refresh')">
      {{ loading ? '…' : '⟳' }}
    </button>
  </div>
</template>

<style scoped>
.batch-selector {
  display: grid;
  grid-template-columns: minmax(160px, 240px) auto;
  align-items: center;
  gap: 6px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.refresh-icon {
  min-height: 32px;
  padding: 0 9px;
  font-size: 15px;
  font-weight: 400;
}

select {
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  padding: 0 10px;
}

@media (max-width: 720px) {
  .batch-selector {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}
</style>
