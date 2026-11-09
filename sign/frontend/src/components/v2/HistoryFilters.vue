<script setup>
defineProps({
  model: { type: Object, required: true },
  fields: { type: Array, default: () => [] },
  actors: { type: Array, default: () => [] },
})

const emit = defineEmits(['update'])

const sources = [
  { value: 'all', label: '全部来源' },
  { value: 'ocr', label: 'OCR' },
  { value: 'manual_edit', label: '手动修改' },
  { value: 'pending_resolution', label: '冲突处理' },
  { value: 'bridge_migration', label: '跨月迁移' },
  { value: 'manual_no_image', label: '无图录入' },
]

const ranges = [
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '90', label: '最近 90 天' },
  { value: 'all', label: '全部' },
]

function update(key, value) {
  emit('update', { ...model, [key]: value })
}
</script>

<template>
  <div class="grid grid-cols-2 gap-2 border-b border-border p-4 text-xs md:grid-cols-4">
    <label class="space-y-1 text-muted-foreground">
      来源
      <select class="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground" :value="model.source" @change="update('source', $event.target.value)">
        <option v-for="source in sources" :key="source.value" :value="source.value">{{ source.label }}</option>
      </select>
    </label>
    <label class="space-y-1 text-muted-foreground">
      字段
      <select class="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground" :value="model.field" @change="update('field', $event.target.value)">
        <option value="all">全部字段</option>
        <option v-for="field in fields" :key="field" :value="field">{{ field }}</option>
      </select>
    </label>
    <label class="space-y-1 text-muted-foreground">
      操作人
      <select class="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground" :value="model.actor" @change="update('actor', $event.target.value)">
        <option value="all">全部操作人</option>
        <option v-for="actor in actors" :key="actor" :value="actor">{{ actor }}</option>
      </select>
    </label>
    <label class="space-y-1 text-muted-foreground">
      时间
      <select class="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground" :value="model.range" @change="update('range', $event.target.value)">
        <option v-for="range in ranges" :key="range.value" :value="range.value">{{ range.label }}</option>
      </select>
    </label>
  </div>
</template>
