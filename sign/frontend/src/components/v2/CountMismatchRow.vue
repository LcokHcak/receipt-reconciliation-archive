<script setup>
import { computed } from 'vue'
import { FolderSearch, RefreshCw, ExternalLink } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'

const props = defineProps({
  // customer_reconciliation getMismatches 的一行
  row: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  // 2026-06-12 tab 拆分:'unreceived'=只显示未收红条 / 'daily_without_bill'=只显示
  // 小票无账单黄条 / 'both'=两条都显示(兼容旧用法)
  direction: { type: String, default: 'both' },
})

const emit = defineEmits(['confirm', 'add-bill', 'rerun', 'track-folder', 'goto-unreceived'])

const showUnreceived = computed(() => props.direction !== 'daily_without_bill' && props.row.missingInDaily?.length)
const showDailyWithoutBill = computed(() => props.direction !== 'unreceived' && props.row.missingInBill?.length)
// 未收方向:账单已存在、缺的是台账,「账单新增/一键确认/重新匹配」都不适用。
// 真正的处理(追小票/补录入台账/标延/作废)在「未收清单」页,这里只给跳转入口避免误操作。
const isUnreceived = computed(() => props.direction === 'unreceived')

function fmt(value) {
  if (value == null || value === '') return '—'
  return String(value)
}
</script>

<template>
  <div class="grid grid-cols-[220px_1fr_auto] gap-4 rounded-lg border border-status-warn/40 bg-card p-4 shadow-sm">
    <!-- 行前:客户基础信息 -->
    <dl class="space-y-1.5 border-r border-border pr-4 text-xs">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">客户基础信息</div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">代理</dt><dd class="font-medium text-foreground">{{ fmt(row.agent) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">姓名</dt><dd class="font-medium text-foreground">{{ fmt(row.name) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">护照号</dt><dd class="font-medium text-foreground">{{ fmt(row.passportNo) }}</dd></div>
      <div class="flex justify-between gap-2"><dt class="text-muted-foreground">团号</dt><dd class="font-medium text-foreground">{{ fmt(row.tourNo) }}</dd></div>
    </dl>

    <!-- 中间:数量对比 -->
    <div class="space-y-3 text-xs">
      <!-- 未收方向只关心账单里有几张该客户没交,不做台账/账单计数对比(易误导) -->
      <div v-if="!isUnreceived" class="flex items-center gap-4">
        <span class="rounded-md bg-muted/40 px-3 py-1.5">
          台账收 <TabularNumber :value="row.dailyCount" class="font-medium text-foreground" /> 张小票
        </span>
        <span class="text-muted-foreground">vs</span>
        <span class="rounded-md bg-muted/40 px-3 py-1.5">
          账单出现 <TabularNumber :value="row.billCount" class="font-medium text-foreground" /> 条小票
        </span>
      </div>

      <div v-if="showUnreceived" class="rounded-md border border-status-error/30 bg-status-error/10 p-2">
        <div class="mb-1 font-medium text-status-error">未收(账单有、台账无) · {{ row.missingInDaily.length }}</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="r in row.missingInDaily" :key="`md-${r}`" class="rounded bg-background px-2 py-0.5 font-mono text-[11px]">{{ r }}</span>
        </div>
      </div>

      <div v-if="showDailyWithoutBill" class="rounded-md border border-status-warn/30 bg-status-warn/10 p-2">
        <div class="mb-1 font-medium text-status-warn">小票无账单(台账有、账单无) · {{ row.missingInBill.length }}</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="r in row.missingInBill" :key="`mb-${r}`" class="rounded bg-background px-2 py-0.5 font-mono text-[11px]">{{ r }}</span>
        </div>
      </div>
    </div>

    <!-- 行尾:未收方向只给「去未收清单」+文件夹追踪;其余方向保留账单新增/确认/重新匹配 -->
    <div class="flex w-[140px] flex-col gap-2">
      <Button size="sm" variant="ghost" :disabled="busy" @click="emit('track-folder', row)">
        <FolderSearch class="h-4 w-4" /> 文件夹追踪
      </Button>
      <template v-if="isUnreceived">
        <Button size="sm" :disabled="busy" @click="emit('goto-unreceived', row)">
          <ExternalLink class="h-4 w-4" /> 去未收清单
        </Button>
      </template>
      <template v-else>
        <Button size="sm" variant="outline" :disabled="busy || !row.missingInDaily.length" @click="emit('add-bill', row)">账单新增</Button>
        <!-- 曾经叫「一键确认」(2026-08-01 改名):它不落库,只在本次浏览里把这行隐去。
             「确认」二字会让人以为核对结果被记下来了 —— 而刷新就全回来,
             他做过的判断一点痕迹都没有。名字必须说它真正做的那件事。 -->
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          title="仅本次浏览隐去这一行;不落库,刷新或切页签会回来"
          @click="emit('confirm', row)"
        >
          本次隐去
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy" @click="emit('rerun', row)">
          <RefreshCw class="h-4 w-4" /> 重新匹配
        </Button>
      </template>
    </div>
  </div>
</template>
