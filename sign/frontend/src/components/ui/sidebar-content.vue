<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('flex flex-1 flex-col gap-2 overflow-auto p-2', props.class)">
    <slot />
  </div>
</template>
