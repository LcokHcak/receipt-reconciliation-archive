/**
 * Sidebar context composable for v2 layout.
 * SidebarProvider injects this; all sidebar sub-components consume it.
 */
import { provide, inject, ref, computed } from 'vue'

const SIDEBAR_SYMBOL = Symbol('sidebar-ctx')

export function provideSidebar({ defaultOpen = true } = {}) {
  const _open = ref(defaultOpen)
  const isOpen = computed(() => _open.value)

  function toggle() {
    _open.value = !_open.value
  }

  provide(SIDEBAR_SYMBOL, { isOpen, toggle })
  return { isOpen, toggle }
}

export function useSidebar() {
  const ctx = inject(SIDEBAR_SYMBOL, null)
  if (!ctx) {
    // Fallback when used outside provider (e.g. in tests)
    const isOpen = ref(true)
    return { isOpen, toggle: () => (isOpen.value = !isOpen.value) }
  }
  return ctx
}
