<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  pressed: { type: Boolean, default: false },
  class: { type: String, default: '' },
})
const emit = defineEmits(['update:pressed'])
const classes = computed(() => cn('inline-flex h-9 items-center justify-center rounded-md border border-input px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', props.pressed && 'bg-primary text-primary-foreground hover:bg-primary/90', props.class))
</script>

<template>
  <button type="button" :aria-pressed="pressed" :class="classes" @click="emit('update:pressed', !pressed)">
    <slot />
  </button>
</template>
