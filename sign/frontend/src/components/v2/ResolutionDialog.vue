<script setup>
import { ref, watch } from 'vue'
import Button from '@/components/ui/button.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import Textarea from '@/components/ui/textarea.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  action: { type: String, default: '' },
  count: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'confirm'])
const reason = ref('')

watch(() => props.open, () => {
  reason.value = ''
})
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
    <div class="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
      <h2 class="text-lg font-medium text-foreground">处理原因</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        将处理 <TabularNumber :value="count" /> 条记录 · {{ action === 'delay' ? '标记延迟' : '标记作废' }}
      </p>
      <Textarea v-model="reason" class="mt-4" placeholder="请输入原因" />
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="ghost" @click="emit('close')">取消</Button>
        <Button :disabled="!reason.trim()" @click="emit('confirm', reason)">确认</Button>
      </div>
    </div>
  </div>
</template>
