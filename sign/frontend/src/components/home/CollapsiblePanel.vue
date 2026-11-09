<script setup>
// 可收起工作块(2026-07-26 用户需求③:所有工作块都能一键收起)。
// 收起状态按 storageKey 记 localStorage —— 管理员各自把不关心的块折起来,刷新后保持。
// 结构沿用全站 .panel/.panel-header,收起时只留标题行(标题右侧的摘要/工具仍可见)。
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'

const props = defineProps({
  title: { type: String, required: true },
  // localStorage 键;不传则不记忆(仅本次会话)
  storageKey: { type: String, default: '' },
  defaultCollapsed: { type: Boolean, default: false },
})

const STORAGE_PREFIX = 'home_panel_collapsed:'

const collapsed = ref((() => {
  if (!props.storageKey) return props.defaultCollapsed
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + props.storageKey)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch { /* localStorage 不可用 → 用默认值 */ }
  return props.defaultCollapsed
})())

function toggle() {
  collapsed.value = !collapsed.value
  if (!props.storageKey) return
  try {
    localStorage.setItem(STORAGE_PREFIX + props.storageKey, collapsed.value ? '1' : '0')
  } catch { /* 写不进就只本次生效 */ }
}

const toggleTitle = computed(() => (collapsed.value ? '展开' : '收起'))
</script>

<template>
  <section class="panel cp-panel">
    <div class="panel-header cp-head">
      <button
        type="button"
        class="cp-toggle"
        :aria-expanded="!collapsed"
        :title="toggleTitle"
        @click="toggle"
      >
        <ChevronDown v-if="!collapsed" :size="15" />
        <ChevronRight v-else :size="15" />
        <strong>{{ title }}</strong>
      </button>
      <!-- 标题右侧:摘要徽标/工具(收起时仍显示,一眼知道里面还有多少东西) -->
      <span class="cp-head-extra"><slot name="header-extra" /></span>
    </div>
    <div v-show="!collapsed" class="cp-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.cp-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cp-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  border: none; background: none; padding: 0; cursor: pointer;
  color: inherit; font: inherit; text-align: left;
}
.cp-toggle:hover strong { color: var(--accent, #2563eb); }
.cp-toggle svg { color: var(--muted, #9ca3af); flex: none; }
.cp-head-extra { display: inline-flex; align-items: center; gap: 8px; }
</style>
