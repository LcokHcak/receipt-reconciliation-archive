<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <ul :class="cn('flex w-full min-w-0 flex-col gap-0.5', props.class)" role="list">
    <slot />
  </ul>
</template>
