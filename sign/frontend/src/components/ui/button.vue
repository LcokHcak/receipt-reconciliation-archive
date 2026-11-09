<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    // default | destructive | outline | secondary | ghost | link
  },
  size: {
    type: String,
    default: 'default',
    // default | sm | lg | icon
  },
  class: { type: String, default: '' },
  disabled: Boolean,
  type: { type: String, default: 'button' },
})

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

const variants = {
  default:     'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline:     'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  secondary:   'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost:       'hover:bg-accent hover:text-accent-foreground',
  link:        'text-primary underline-offset-4 hover:underline',
}

const sizes = {
  default: 'h-10 px-4 py-2',
  sm:      'h-9 rounded-md px-3',
  lg:      'h-11 rounded-md px-8',
  icon:    'h-10 w-10',
}

const classes = computed(() =>
  cn(base, variants[props.variant] ?? variants.default, sizes[props.size] ?? sizes.default, props.class),
)
</script>

<template>
  <button :type="type" :disabled="disabled" :class="classes">
    <slot />
  </button>
</template>
