<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  modelValue: { type: String, default: '' },
  class: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const classes = computed(() => cn('flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', props.class))
</script>

<template>
  <textarea :value="modelValue" :class="classes" @input="emit('update:modelValue', $event.target.value)" />
</template>
