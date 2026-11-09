<script setup>
/**
 * BatchContextCard — 审核台/导出台顶部的"当前批次概览卡"。
 *
 * 作用：让用户任何时候都能清楚"我在哪个批次、批次有多大、还剩多少活"。
 * 数据来源：workbench.currentBatch + workbench.tasks（前端可本地聚合）。
 */

import { computed } from 'vue'

const props = defineProps({
  batch: { type: Object, default: null },
  tasks: { type: Array, default: () => [] },
})
const emit = defineEmits(['replace-group-code'])

// isPending/groupKeyOf 已随 stats computed 一并删除(级联孤儿,lint 清理确认)

// stats computed 已删(2026-07-26 顶部瘦身后无消费方,lint 死代码清理确认)

const title = computed(() => {
  const b = props.batch || {}
  return b.name || b.batchName || b.title || b.id || b.batchId || '未选择批次'
})

// 信号轻量化(2026-07-13):批次ID长哈希是排查用的开发者信息,不占可视行——
// 降级进批次名悬停;副标题只留操作员关心的建档日期。
const subtitle = computed(() => {
  const b = props.batch || {}
  return b.createdAt ? `建档 ${String(b.createdAt).slice(0, 10)}` : ''
})

const idHint = computed(() => {
  const b = props.batch || {}
  const id = b.id || b.batchId
  return id ? `批次ID：${id}` : ''
})
</script>

<template>
  <div class="batch-context-card" :class="{ empty: !batch }">
    <div class="ctx-title">
      <div class="ctx-name">
        <span class="ctx-label">当前批次</span>
        <strong :title="idHint">{{ title }}</strong>
      </div>
      <span v-if="subtitle" class="ctx-sub">{{ subtitle }}</span>
      <button
        v-if="batch"
        type="button"
        class="ctx-replace-gc"
        title="导错团号表了?换一份(导入日度台账时会用新表匹配)"
        @click="emit('replace-group-code')"
      >
        换团号表
      </button>
    </div>
    <!-- 统计排已删(2026-07-11 用户拍板):与左栏组数chips/检查器张数进度三套口径并存致混淆,
         此排是唯一纯展示可删项。stats computed 保留备用。 -->
  </div>
</template>

<style scoped>
.batch-context-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-soft) 100%);
  margin-bottom: 12px;
}

.batch-context-card.empty {
  border-left-color: var(--line-strong);
  opacity: 0.7;
}

.ctx-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.ctx-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.ctx-label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ctx-name strong {
  font-size: 15px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 360px;
}

.ctx-sub {
  color: var(--muted);
  font-size: 12px;
}

.ctx-replace-gc {
  flex: 0 0 auto;
  border: 1px solid var(--line-strong);
  background: #fff;
  color: var(--accent, #2563eb);
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ctx-replace-gc:hover { background: var(--surface-soft); }

.ctx-metrics {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}

.metric-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.metric-item span.muted {
  font-size: 11px;
  color: var(--muted);
  font-weight: 500;
}

.metric-item strong {
  font-size: 16px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.metric-item.pending strong { color: var(--warning); }
.metric-item.approved strong { color: var(--success); }
.metric-item.rephoto strong { color: var(--danger); }
</style>
