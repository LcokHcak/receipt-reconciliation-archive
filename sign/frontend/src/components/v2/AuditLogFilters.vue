<script setup>
import { X } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'

const props = defineProps({
  model: { type: Object, required: true },
  actions: { type: Array, default: () => [] },
  users: { type: Array, default: () => [] },
  workspaces: { type: Array, default: () => [] },
  resourceTypes: { type: Array, default: () => [] },
})

const emit = defineEmits(['update'])

function set(key, value) {
  emit('update', { ...props.model, [key]: value })
}

function clear() {
  emit('update', { action: 'all', userId: 'all', workspaceKey: 'all', resourceType: 'all', range: '30' })
}

const isFiltered = () =>
  props.model.action !== 'all' ||
  props.model.userId !== 'all' ||
  props.model.workspaceKey !== 'all' ||
  props.model.resourceType !== 'all' ||
  props.model.range !== '30'

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
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
    <!-- action filter -->
    <div class="flex items-center gap-1.5">
      <label class="text-xs text-muted-foreground">操作</label>
      <select
        data-testid="audit-action-filter"
        :value="model.action"
        class="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        @change="set('action', $event.target.value)"
      >
        <option value="all">全部</option>
        <option v-for="a in actions" :key="a" :value="a">{{ ACTION_LABELS[a] || a }}</option>
      </select>
    </div>

    <!-- user filter -->
    <div class="flex items-center gap-1.5">
      <label class="text-xs text-muted-foreground">操作人</label>
      <select
        data-testid="audit-user-filter"
        :value="model.userId"
        class="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        @change="set('userId', $event.target.value)"
      >
        <option value="all">全部</option>
        <option v-for="u in users" :key="u" :value="u">{{ u }}</option>
      </select>
    </div>

    <!-- workspace filter -->
    <div class="flex items-center gap-1.5">
      <label class="text-xs text-muted-foreground">工作区</label>
      <select
        data-testid="audit-workspace-filter"
        :value="model.workspaceKey"
        class="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        @change="set('workspaceKey', $event.target.value)"
      >
        <option value="all">全部</option>
        <option v-for="ws in workspaces" :key="ws" :value="ws">{{ ws }}</option>
      </select>
    </div>

    <!-- resource type filter -->
    <div class="flex items-center gap-1.5">
      <label class="text-xs text-muted-foreground">resource</label>
      <select
        data-testid="audit-resource-filter"
        :value="model.resourceType"
        class="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        @change="set('resourceType', $event.target.value)"
      >
        <option value="all">鍏ㄩ儴</option>
        <option v-for="resourceType in resourceTypes" :key="resourceType" :value="resourceType">{{ resourceType }}</option>
      </select>
    </div>

    <!-- date range -->
    <div class="flex items-center gap-1.5">
      <label class="text-xs text-muted-foreground">时间范围</label>
      <select
        :value="model.range"
        class="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        @change="set('range', $event.target.value)"
      >
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
        <option value="90">近 90 天</option>
        <option value="all">全部</option>
      </select>
    </div>

    <!-- clear -->
    <Button v-if="isFiltered()" variant="ghost" size="sm" class="h-7 gap-1 text-xs" @click="clear">
      <X class="h-3 w-3" />
      清除筛选
    </Button>
  </div>
</template>
