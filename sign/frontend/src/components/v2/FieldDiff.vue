<script setup>
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/button.vue'
import Input from '@/components/ui/input.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import LockToggle from './LockToggle.vue'

const props = defineProps({
  field: { type: Object, required: true },
  resolution: { type: Object, default: null },
  lock: { type: Boolean, default: false },
})

const emit = defineEmits(['update:resolution', 'update:lock'])

const manualValue = ref(props.resolution?.value || '')
watch(() => props.field, () => {
  manualValue.value = ''
})

const severityVariant = computed(() => props.field.severity === 'error' ? 'error' : 'warn')

function choose(action, value) {
  emit('update:resolution', { field: props.field.field, action, value })
}

function chooseManual(value) {
  manualValue.value = value
  choose('manual', value)
}
</script>

<template>
  <article class="rounded-lg border border-border bg-card p-4 shadow-sm">
    <div class="mb-4 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <h3 class="font-medium text-foreground">{{ field.label }}</h3>
        <StatusBadge :variant="severityVariant" size="sm">{{ field.severity }}</StatusBadge>
      </div>
      <StatusBadge v-if="field.isLocked" variant="info" size="sm">已锁</StatusBadge>
    </div>

    <div class="grid gap-3 md:grid-cols-2">
      <div class="rounded-md border border-border bg-muted/30 p-3">
        <p class="text-xs text-muted-foreground">库内值</p>
        <p class="mt-2 font-mono text-lg text-foreground">{{ field.current || '—' }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ field.currentSource }}</p>
      </div>
      <div class="rounded-md border border-border bg-muted/30 p-3">
        <p class="text-xs text-muted-foreground">OCR 新值</p>
        <p class="mt-2 font-mono text-lg text-foreground">{{ field.incoming || '—' }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ field.incomingSource }}</p>
      </div>
    </div>

    <div class="mt-4 grid gap-2 md:grid-cols-3">
      <Button
        data-testid="field-use-daily"
        variant="outline"
        :class="resolution?.action === 'keep' ? 'border-primary bg-primary/10 text-primary' : ''"
        @click="choose('keep', field.current)"
      >
        保留库内
      </Button>
      <Button
        data-testid="field-use-bill"
        variant="outline"
        :class="resolution?.action === 'accept' ? 'border-primary bg-primary/10 text-primary' : ''"
        @click="choose('accept', field.incoming)"
      >
        接受新值
      </Button>
      <Input
        :model-value="manualValue"
        placeholder="手动输入"
        :class="resolution?.action === 'manual' ? 'border-primary bg-primary/10' : ''"
        @update:model-value="chooseManual"
      />
    </div>

    <div class="mt-3">
      <LockToggle
        :model-value="lock"
        :disabled="field.isLocked"
        @update:model-value="emit('update:lock', $event)"
      />
    </div>
  </article>
</template>
