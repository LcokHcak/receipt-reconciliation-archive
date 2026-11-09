<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('relative flex w-full min-w-0 flex-col px-2', props.class)">
    <slot />
  </div>
</template>
