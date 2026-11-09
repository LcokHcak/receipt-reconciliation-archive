<script setup>
import { History } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { useRowHistory } from '@/composables/useRowHistory'

defineProps({ candidates: { type: Array, default: () => [] } })
const emit = defineEmits(['link'])
const { openRowHistory } = useRowHistory()

function scoreVariant(score) {
  if (score >= 0.8) return 'ok'
  if (score >= 0.6) return 'warn'
  return 'info'
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="candidate in candidates.slice(0, 3)"
      :key="candidate.rowId"
      class="rounded-md border border-border bg-muted/30 p-2"
    >
      <div class="flex items-center justify-between gap-2">
        <div>
          <p class="text-sm font-medium text-foreground">{{ candidate.passportNo }} / {{ candidate.customerName }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ candidate.matchedFields.join(' · ') }}</p>
        </div>
        <div class="flex items-center gap-2">
          <StatusBadge :variant="scoreVariant(candidate.score)" size="sm">
            匹配度 <TabularNumber :value="Math.round(candidate.score * 100)" />%
          </StatusBadge>
          <Button data-testid="candidate-history" size="icon" variant="ghost" @click="openRowHistory(candidate.rowId)">
            <History class="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" @click="emit('link', candidate)">link</Button>
        </div>
      </div>
    </div>
    <p v-if="!candidates.length" class="text-xs text-muted-foreground">暂无候选</p>
  </div>
</template>
