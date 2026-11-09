<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  as: { type: String, default: 'table' },
  class: { type: String, default: '' },
})
const classes = computed(() => cn('w-full caption-bottom text-sm', props.class))
</script>

<template>
  <component :is="as" :class="classes"><slot /></component>
</template>
