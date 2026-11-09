<script setup>
import { X, User, Clock, Monitor, Globe, Hash } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'

defineProps({
  entry: { type: Object, default: null },
  open: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

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

function actionLabel(a) { return ACTION_LABELS[a] || a }
function actionVariant(a) { return ACTION_VARIANT[a] || 'info' }

function fmtTs(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}
</script>

<template>
  <Drawer :open="open" @update:open="(v) => !v && emit('close')">
    <div v-if="entry" class="flex h-full flex-col">
      <!-- header -->
      <header class="flex items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-medium text-foreground">审计详情</h2>
            <StatusBadge :variant="actionVariant(entry.action)" size="sm">
              {{ actionLabel(entry.action) }}
            </StatusBadge>
          </div>
          <p class="mt-1 font-mono text-xs text-muted-foreground">{{ fmtTs(entry.createdAt) }} (KST)</p>
        </div>
        <Button variant="ghost" size="icon" @click="emit('close')">
          <X class="h-4 w-4" />
        </Button>
      </header>

      <!-- body -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- meta fields -->
        <dl class="space-y-4">
          <div class="flex gap-3">
            <User class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">操作人</dt>
              <dd class="mt-0.5 font-medium text-foreground">{{ entry.userId }}</dd>
            </div>
          </div>

          <div class="flex gap-3">
            <Clock class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">时间</dt>
              <dd class="mt-0.5 font-mono text-sm text-foreground">{{ entry.createdAt }}</dd>
            </div>
          </div>

          <div v-if="entry.workspaceKey" class="flex gap-3">
            <Hash class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">工作区</dt>
              <dd class="mt-0.5 text-sm text-foreground">{{ entry.workspaceKey }}</dd>
            </div>
          </div>

          <div v-if="entry.resourceId" class="flex gap-3">
            <Hash class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">资源 ID</dt>
              <dd class="mt-0.5 font-mono text-sm text-foreground">
                <TabularNumber :value="Number(entry.resourceId)" />
              </dd>
            </div>
          </div>

          <div v-if="entry.ipAddress" class="flex gap-3">
            <Globe class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">IP 地址</dt>
              <dd class="mt-0.5 font-mono text-sm text-foreground">{{ entry.ipAddress }}</dd>
            </div>
          </div>

          <div v-if="entry.userAgent" class="flex gap-3">
            <Monitor class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <dt class="text-xs text-muted-foreground">User-Agent</dt>
              <dd class="mt-0.5 break-all text-xs text-muted-foreground">{{ entry.userAgent }}</dd>
            </div>
          </div>
        </dl>

        <!-- details JSON -->
        <div v-if="entry.details" class="mt-6">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">操作详情</h3>
          <div class="rounded-md bg-muted/60 p-3">
            <dl class="space-y-2">
              <div v-for="(val, key) in entry.details" :key="key" class="flex justify-between gap-4 text-sm">
                <dt class="text-muted-foreground">{{ key }}</dt>
                <dd class="font-mono text-foreground">
                  <TabularNumber v-if="typeof val === 'number'" :value="val" />
                  <span v-else>{{ val }}</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  </Drawer>
</template>
