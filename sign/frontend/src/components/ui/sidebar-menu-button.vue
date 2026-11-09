<script setup>
/**
 * SidebarMenuButton — a nav link button inside the sidebar.
 * Renders as <a> when `to` prop is set (vue-router RouterLink),
 * otherwise as <button>.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { cn } from '@/lib/cn'

const props = defineProps({
  to: { type: [String, Object], default: null },
  isActive: { type: Boolean, default: false },
  tooltip: { type: String, default: '' },
  size: { type: String, default: 'default' }, // default | sm | lg
  class: { type: String, default: '' },
})

const sizes = {
  default: 'h-8 text-sm',
  sm:      'h-7 text-xs',
  lg:      'h-12 text-sm',
}

const base =
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 ' +
  'text-left text-sidebar-foreground outline-none ring-sidebar-ring ' +
  'transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
  'focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground ' +
  'disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8'

const activeClass = 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'

const classes = computed(() =>
  cn(base, sizes[props.size] ?? sizes.default, props.isActive && activeClass, props.class),
)

const component = computed(() => (props.to ? RouterLink : 'button'))
const linkProps = computed(() => (props.to ? { to: props.to } : { type: 'button' }))
</script>

<template>
  <component
    :is="component"
    v-bind="linkProps"
    :class="classes"
    :data-active="isActive"
    :aria-label="tooltip"
  >
    <slot />
  </component>
</template>
