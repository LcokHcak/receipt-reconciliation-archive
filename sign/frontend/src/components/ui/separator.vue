<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  orientation: { type: String, default: 'horizontal' }, // horizontal | vertical
  decorative: { type: Boolean, default: true },
  class: { type: String, default: '' },
})

const classes = computed(() =>
  cn(
    'shrink-0 bg-border',
    props.orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
    props.class,
  ),
)
</script>

<template>
  <div
    :role="decorative ? 'none' : 'separator'"
    :aria-orientation="decorative ? undefined : orientation"
    :class="classes"
  />
</template>
