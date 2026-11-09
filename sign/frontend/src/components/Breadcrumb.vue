<script setup>
/**
 * Breadcrumb — 页面顶部面包屑。
 *
 * 输入：items 数组，每项 { label, to?, muted? }
 *   - 有 to 的渲染为 RouterLink（可点击）
 *   - 最后一项（当前页）或 muted: true 渲染为灰色文字
 *
 * 用法：
 *   <Breadcrumb :items="[
 *     { label: '首页', to: { name: 'overview' } },
 *     { label: '批次 5月团B', to: { name: 'review', params: { batchId: 'xxx' }}},
 *     { label: '字段审核' }
 *   ]" />
 */

defineProps({
  items: { type: Array, default: () => [] },
})
</script>

<template>
  <nav v-if="items.length" class="breadcrumb" aria-label="breadcrumb">
    <template v-for="(item, idx) in items" :key="idx">
      <RouterLink
        v-if="item.to && idx < items.length - 1"
        :to="item.to"
        class="crumb link"
      >
        {{ item.label }}
      </RouterLink>
      <span v-else :class="['crumb', { muted: idx === items.length - 1 || item.muted }]">
        {{ item.label }}
      </span>
      <span v-if="idx < items.length - 1" class="sep" aria-hidden="true">/</span>
    </template>
  </nav>
</template>

<style scoped>
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  margin-bottom: 8px;
  color: var(--muted);
}

.crumb {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb.link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}

.crumb.link:hover {
  text-decoration: underline;
}

.crumb.muted {
  color: var(--text);
  font-weight: 500;
}

.sep {
  color: var(--line-strong);
  user-select: none;
}
</style>
