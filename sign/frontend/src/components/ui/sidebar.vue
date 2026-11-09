<script setup>
/**
 * Sidebar — the fixed-width nav panel.
 * Must be a child of SidebarProvider (from AppLayout).
 */
import { cn } from '@/lib/cn'
import { useSidebar } from '@/composables/useSidebar'
import { computed } from 'vue'

const props = defineProps({
  side: { type: String, default: 'left' }, // left | right
  variant: { type: String, default: 'sidebar' }, // sidebar | floating | inset
  collapsible: { type: String, default: 'offcanvas' }, // none | offcanvas | icon
  class: { type: String, default: '' },
})

const { isOpen } = useSidebar()

const classes = computed(() =>
  cn(
    'relative hidden h-svh w-[--sidebar-width] flex-col bg-sidebar text-sidebar-foreground md:flex',
    'transition-[width] duration-200 ease-linear',
    !isOpen.value && 'w-0 overflow-hidden',
    props.class,
  ),
)
</script>

<template>
  <aside
    :class="classes"
    :data-state="isOpen ? 'expanded' : 'collapsed'"
    :data-collapsible="collapsible"
    :data-side="side"
    :data-variant="variant"
    :style="{ '--sidebar-width': '16rem' }"
  >
    <div class="flex h-full flex-col">
      <slot />
    </div>
  </aside>
</template>
