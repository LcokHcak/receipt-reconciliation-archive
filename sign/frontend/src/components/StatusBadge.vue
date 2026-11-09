<script setup>
import { computed } from 'vue'

import { getTaskStatusState } from '../lib/taskStatus'

const props = defineProps({
  task: { type: Object, required: true },
})

const state = computed(() => getTaskStatusState(props.task))
</script>

<template>
  <span class="status-badge" :class="`tone-${state.tone}`">{{ state.label }}</span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.tone-success { background: #f1f5f9; color: var(--success); }
.tone-warning { background: #fff4dd; color: var(--warning); }
.tone-danger  { background: #fce4e4; color: var(--danger);  }
.tone-neutral { background: var(--accent-weak); color: var(--accent); }
</style>
