<script setup>
import { LockKeyhole, MoreHorizontal } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import Tooltip from '@/components/ui/tooltip.vue'

defineProps({
  events: { type: Array, default: () => [] },
  hasMore: { type: Boolean, default: false },
})

const emit = defineEmits(['load-more', 'open-conflict'])

const sourceMeta = {
  ocr: { label: 'OCR', variant: 'info' },
  manual_edit: { label: '手动修改', variant: 'warn' },
  pending_resolution: { label: '冲突处理', variant: 'test' },
  bridge_migration: { label: '跨月迁移', variant: 'ok' },
  manual_no_image: { label: '无图录入', variant: 'info' },
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function meta(source) {
  return sourceMeta[source] || { label: source, variant: 'info' }
}
</script>

<template>
  <div class="space-y-0 p-4">
    <p v-if="!events.length" class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      此行还没有历史记录
    </p>

    <div v-for="event in events" :key="`${event.ts}-${event.field}-${event.changeSource}`" data-testid="history-event" class="relative grid grid-cols-[1rem_1fr] gap-3 pb-5 last:pb-0">
      <div class="relative flex justify-center">
        <span class="mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
        <span class="absolute top-4 h-full w-px bg-border last:hidden" />
      </div>
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-xs text-muted-foreground">{{ formatTime(event.ts) }}</span>
          <StatusBadge :variant="event.actorType === 'system' ? 'info' : 'warn'" size="sm">{{ event.actor }}</StatusBadge>
          <StatusBadge :variant="meta(event.changeSource).variant" size="sm">{{ meta(event.changeSource).label }}</StatusBadge>
        </div>
        <div class="mt-2 rounded-lg border border-border bg-muted/20 p-3">
          <div class="flex items-center gap-2 text-sm font-medium text-foreground">
            <span>{{ event.label || event.field }}</span>
            <Tooltip v-if="event.locked">
              <template #trigger>
                <LockKeyhole class="h-4 w-4 text-status-warn" />
              </template>
              已锁定字段,不会被自动复跑覆盖
            </Tooltip>
          </div>
          <p class="mt-2 break-words text-sm">
            <span class="text-muted-foreground line-through">{{ event.before ?? '—' }}</span>
            <span class="mx-2 text-muted-foreground">→</span>
            <span class="text-foreground">{{ event.after ?? '—' }}</span>
          </p>
          <Button v-if="event.conflictId" variant="link" size="sm" class="mt-1 h-auto p-0" @click="emit('open-conflict', event.conflictId)">
            关联冲突 #{{ event.conflictId }}
          </Button>
        </div>
      </div>
    </div>

    <div v-if="hasMore" class="flex justify-center pt-2">
      <Button variant="outline" size="sm" @click="emit('load-more')">
        <MoreHorizontal class="h-4 w-4" />
        加载更多
      </Button>
    </div>
  </div>
</template>
