<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('flex flex-col gap-2 p-4 border-b border-sidebar-border', props.class)">
    <slot />
  </div>
</template>
