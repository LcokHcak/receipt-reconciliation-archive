<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'

const monthMenu = ref(null)

const props = defineProps({
  data: { type: Object, required: true },
  workspaces: { type: Array, default: () => [] },
})
const emit = defineEmits(['workspace-change'])

const fallbackKeys = [
  'demo-2026-06', 'demo-2026-05', 'demo-2026-04',
  '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12', '2025-11', '2025-10',
]

const workspaceList = computed(() => {
  if (!Array.isArray(props.workspaces) || props.workspaces.length === 0) {
    return fallbackKeys.map((key) => ({ workspaceKey: key }))
  }
  return props.workspaces.map((w) => ({
    workspaceKey: String(w.workspaceKey || w.key || w),
  }))
})

const monthLabel = computed(() => props.data.workspaceKey?.replace('demo-', '') || '加载中')

function closeDetails(target) {
  if (target?.value) target.value.open = false
}

function choose(key) {
  emit('workspace-change', key)
  closeDetails(monthMenu)
}
</script>

<template>
  <header class="space-y-3" data-testid="monthly-header">
    <div v-if="data.isDemo" class="rounded-lg border border-status-test/30 bg-status-test/10 px-4 py-2 text-sm text-status-test">
      <StatusBadge variant="test" size="sm" dot>测试模式</StatusBadge>
      <span class="ml-2">当前在 {{ data.workspaceKey }} · 数据不进正式统计</span>
    </div>
    <div class="flex min-w-0 flex-wrap items-center gap-3">
      <details ref="monthMenu" class="relative max-w-full">
        <summary class="inline-flex h-10 cursor-pointer list-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
          {{ monthLabel }} ▾
        </summary>
        <div class="fixed left-4 right-4 z-20 mt-2 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg md:absolute md:left-auto md:right-auto md:w-56">
          <button
            v-for="ws in workspaceList"
            :key="ws.workspaceKey"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
            @click="choose(ws.workspaceKey)"
          >
            <StatusBadge v-if="ws.workspaceKey.startsWith('demo-')" variant="test" size="sm">demo</StatusBadge>
            <span class="flex-1 text-left">{{ ws.workspaceKey.replace('demo-', '') }}</span>
          </button>
          <div v-if="workspaceList.length === 0" class="px-3 py-2 text-sm text-muted-foreground">暂无月份</div>
        </div>
      </details>
    </div>
    <p class="text-xs text-muted-foreground">最近 <TabularNumber :value="workspaceList.length" /> 个月可切换；当前工作区 <code class="rounded bg-muted px-1.5 py-0.5 font-mono">{{ data.workspaceKey }}</code></p>
  </header>
</template>
