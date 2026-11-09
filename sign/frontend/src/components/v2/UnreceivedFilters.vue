<script setup>
defineProps({
  filters: { type: Object, required: true },
  modes: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
})

const emit = defineEmits(['update'])
const priorities = ['priority_1', 'priority_2', 'priority_3', 'priority_4', 'priority_5', 'priority_6']

function patch(key, value) {
  emit('update', { key, value })
}
</script>

<template>
  <div class="grid gap-3 rounded-lg border border-border bg-card p-3 shadow-sm md:grid-cols-6">
    <select :value="filters.folder" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @change="patch('folder', $event.target.value)">
      <option value="all">全部账单桶</option>
      <option v-for="item in folders" :key="item.folder" :value="item.folder">
        {{ item.folder }}{{ item.count ? ` (${item.count})` : '' }}
      </option>
    </select>
    <select :value="filters.mode" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @change="patch('mode', $event.target.value)">
      <option value="all">全部模式</option>
      <option v-for="mode in modes" :key="mode" :value="mode">{{ mode }}</option>
    </select>
    <select :value="filters.priority" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @change="patch('priority', $event.target.value)">
      <option value="all">全部优先级</option>
      <option v-for="priority in priorities" :key="priority" :value="priority.split('_')[1]">{{ priority }}</option>
    </select>
    <input :value="filters.dateFrom" type="date" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @input="patch('dateFrom', $event.target.value)">
    <input :value="filters.dateTo" type="date" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @input="patch('dateTo', $event.target.value)">
    <input :value="filters.search" placeholder="搜索账单/护照/姓名" class="h-10 rounded-md border border-input bg-background px-3 text-sm" @input="patch('search', $event.target.value)">
  </div>
</template>
