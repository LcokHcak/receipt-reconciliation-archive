<script setup>
import { ChevronRight } from 'lucide-vue-next'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'

defineProps({
  rows: { type: Array, default: () => [] },
  selectedId: { type: Number, default: null },
  hasMore: { type: Boolean, default: false },
})

const emit = defineEmits(['select', 'load-more'])

const ACTION_VARIANT = {
  login: 'ok', logout: 'info',
  import_daily: 'info', import_bill: 'info',
  import_group_code: 'info', import_received_receipt: 'info',
  run_tour_match: 'info', run_bill_match: 'info',
  run_merge: 'info', run_second_pass: 'info',
  resolve_pending_review: 'ok',
  export_monthly: 'ok',
  publish_ledger: 'ok',
  update_ledger_fields: 'warn', delete_ledger_row: 'error',
  lock_workspace: 'warn',
  update_ledger_status: 'warn', create_workspace: 'ok', clear_workspace: 'error',
  update_deduct_config: 'warn', update_mode_mapping: 'warn',
  migrate_daily_row: 'warn',
}

const ACTION_LABELS = {
  login: '登录', logout: '登出',
  import_daily: '导入台账', import_bill: '导入账单',
  import_group_code: '导入团号', import_received_receipt: '导入收票',
  run_tour_match: '运行团号匹配', run_bill_match: '运行账单匹配',
  run_merge: '运行合并', run_second_pass: '二次处理',
  resolve_pending_review: '解决待审', export_monthly: '导出月度',
  publish_ledger: '发布台账', update_ledger_fields: '更新台账字段',
  delete_ledger_row: '删除台账行', lock_workspace: '锁定工作区',
  update_ledger_status: '更新台账状态', create_workspace: '创建工作区',
  clear_workspace: '清空工作区', update_deduct_config: '更新扣点配置',
  update_mode_mapping: '更新模式映射', migrate_daily_row: '跨月迁移',
}

function actionVariant(action) {
  return ACTION_VARIANT[action] || 'info'
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action
}

function fmtTs(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
    <table class="w-full text-sm">
      <thead class="bg-muted/40 text-xs text-muted-foreground">
        <tr>
          <th class="px-4 py-3 text-left">时间 (KST)</th>
          <th class="px-4 py-3 text-left">操作人</th>
          <th class="px-4 py-3 text-left">操作</th>
          <th class="px-4 py-3 text-left">工作区</th>
          <th class="px-4 py-3 text-left">资源 ID</th>
          <th class="w-10 px-4 py-3" />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          class="cursor-pointer border-t border-border transition-colors hover:bg-muted/40"
          :class="{ 'bg-accent/30': row.id === selectedId }"
          @click="emit('select', row)"
        >
          <td class="px-4 py-2.5 font-mono text-xs text-muted-foreground">{{ fmtTs(row.createdAt) }}</td>
          <td class="px-4 py-2.5 font-medium text-foreground">{{ row.userId }}</td>
          <td class="px-4 py-2.5">
            <StatusBadge :variant="actionVariant(row.action)" size="sm">{{ actionLabel(row.action) }}</StatusBadge>
          </td>
          <td class="px-4 py-2.5 text-xs text-muted-foreground">{{ row.workspaceKey || '—' }}</td>
          <td class="px-4 py-2.5 font-mono text-xs">
            <TabularNumber v-if="row.resourceId != null" :value="Number(row.resourceId)" />
            <span v-else class="text-muted-foreground">—</span>
          </td>
          <td class="px-4 py-2.5 text-muted-foreground">
            <ChevronRight class="h-4 w-4" />
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="6" class="px-4 py-12 text-center text-sm text-muted-foreground">
            暂无审计记录
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="hasMore" class="border-t border-border px-4 py-3 text-center">
      <button
        class="text-sm text-primary hover:underline"
        @click="emit('load-more')"
      >
        加载更多
      </button>
    </div>
  </div>
</template>
