<script setup>
/**
 * SidebarInset — the main content area next to the sidebar.
 */
import { cn } from '@/lib/cn'

const props = defineProps({
  class: { type: String, default: '' },
})
</script>

<template>
  <main
    :class="cn('relative flex min-h-svh min-w-0 flex-1 flex-col bg-background', props.class)"
    data-sidebar="inset"
  >
    <slot />
  </main>
</template>
