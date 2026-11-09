<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    // default | secondary | destructive | outline
  },
  class: { type: String, default: '' },
})

const base =
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'

const variants = {
  default:     'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
  secondary:   'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
  destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
  outline:     'text-foreground',
}

const classes = computed(() => cn(base, variants[props.variant] ?? variants.default, props.class))
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
