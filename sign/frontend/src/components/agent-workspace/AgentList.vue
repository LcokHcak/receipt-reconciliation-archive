<script setup>
// 左栏:代理列表(计数+异常低调标记)。搜索是本地过滤(API 上限 200 已覆盖当月全量)。
import { computed, ref, watch, nextTick } from 'vue'
import { RefreshCw, Search } from 'lucide-vue-next'

const props = defineProps({
  agents: { type: Array, default: () => [] },
  activeAgentKey: { type: String, default: '' },
  // 联动高亮(0724反馈E4):全代理视角点了某客户 → 亮起它的代理但**不改筛选**。
  // 与 active(=已选中筛选)分开:active 蓝实底,highlight 只描边提示归属。
  highlightKey: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['pick', 'retry'])

const search = ref('')

// 联动高亮滚动(E4):高亮变化时把该代理滚进可视区(nearest 不打扰上下文)。
// 173 个代理的列表,亮了但在视口外等于没亮。
const rootEl = ref(null)
watch(() => props.highlightKey, (key) => {
  if (!key || props.activeAgentKey) return
  nextTick(() => {
    rootEl.value?.querySelector?.(`[data-agent-key="${CSS.escape(key)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })
})

const filtered = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return props.agents
  return props.agents.filter((a) => String(a.agentName || '').toLowerCase().includes(kw))
})
</script>

<template>
  <div ref="rootEl" class="agent-list">
    <div class="al-head">
      <span class="al-head-title">代理列表</span>
      <span class="al-head-count" :title="`本月共 ${agents.length} 位代理`">共 {{ agents.length }}</span>
    </div>
    <label class="al-search">
      <Search :size="14" aria-hidden="true" />
      <input v-model="search" type="search" placeholder="搜索代理" aria-label="搜索代理">
    </label>

    <div v-if="error" class="al-state">
      <span class="al-error">{{ error }}</span>
      <button type="button" class="al-retry" @click="emit('retry')"><RefreshCw :size="13" /> 重试</button>
    </div>
    <div v-else-if="loading && !agents.length" class="al-state al-muted">代理加载中…</div>
    <div v-else-if="!filtered.length" class="al-state al-muted">
      {{ search ? '没有匹配的代理' : '本月还没有客户数据' }}
    </div>

    <ul v-else class="al-items" role="listbox" aria-label="代理列表">
      <li v-for="agent in filtered" :key="agent.agentKey">
        <button
          type="button"
          class="al-item"
          role="option"
          :aria-selected="activeAgentKey === agent.agentKey"
          :class="{
            active: activeAgentKey === agent.agentKey,
            unlabeled: agent.agentUnlabeled,
            highlight: !activeAgentKey && highlightKey === agent.agentKey,
          }"
          :data-agent-key="agent.agentKey"
          @click="emit('pick', agent.agentKey)"
        >
          <span class="al-name" :title="agent.agentName">{{ agent.agentName }}</span>
          <span class="al-counts">
            <em v-if="agent.abnormalCount > 0" class="al-open" :title="`待处理 ${agent.abnormalCount}(待确认结算/要重拍/待补救)`">{{ agent.abnormalCount }}</em>
            <span class="al-total" :title="`客户组 ${agent.customerCount} · 小票 ${agent.receiptCount || 0}`">{{ agent.customerCount }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.agent-list { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.al-head { display: flex; align-items: center; justify-content: space-between; }
.al-head-title { font-size: 13px; font-weight: 500; color: #344054; }
/* 一次踩两条硬规则:蓝给了不可点的东西 + 胶囊装了数量。
   「共 23」既不是状态也点不动,收成朴素灰字。 */
.al-head-count { font-size: 12px; color: #667085; }
.al-search { display: flex; align-items: center; gap: 6px; border: 1px solid #e4e7ec; border-radius: 6px; padding: 5px 8px; color: #98a2b3; }
.al-search input { border: none; outline: none; flex: 1; font-size: 13px; min-width: 0; background: transparent; }
.al-items { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
.al-item {
  width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 7px 10px; border: none; background: none; cursor: pointer; border-radius: 6px;
  font-size: 13px; color: #344054; text-align: left;
}
.al-item:hover { background: #f9fafb; }
.al-item.active { background: #eef4ff; color: #1849a9; font-weight: 500; }
/* 联动高亮(E4):描边+浅底,与 active(实底蓝)可区分——它是"归属提示"不是"已筛选" */
.al-item.highlight { box-shadow: inset 0 0 0 1px var(--accent, #2563eb); background: #f5f9ff; }
.al-item.unlabeled .al-name { color: #98a2b3; font-style: italic; }
.al-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.al-counts { display: flex; align-items: center; gap: 6px; flex: none; }
.al-open { font-style: normal; font-size: 12px; color: #b54708; background: #fffaeb; border-radius: 8px; padding: 0 6px; }
.al-total { font-size: 12px; color: #98a2b3; }
.al-state { padding: 12px 8px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.al-muted { color: #98a2b3; }
.al-error { color: #b42318; }
.al-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e4e7ec; background: #fff; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
</style>
