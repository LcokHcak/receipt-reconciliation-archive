<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({ class: { type: String, default: '' } })
const classes = computed(() => cn('text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70', props.class))
</script>

<template>
  <label :class="classes"><slot /></label>
</template>
