<script setup>
/**
 * SidebarProvider — wraps the entire page layout, provides sidebar context.
 */
import { provideSidebar } from '@/composables/useSidebar'
import { cn } from '@/lib/cn'

const props = defineProps({
  defaultOpen: { type: Boolean, default: true },
  class: { type: String, default: '' },
})

provideSidebar({ defaultOpen: props.defaultOpen })
</script>

<template>
  <div
    :class="cn('flex min-h-svh w-full', props.class)"
    data-sidebar="provider"
  >
    <slot />
  </div>
</template>
