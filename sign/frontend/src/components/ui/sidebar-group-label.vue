<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div
    :class="cn(
      'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium tracking-wider',
      'text-sidebar-foreground/50 outline-none',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
