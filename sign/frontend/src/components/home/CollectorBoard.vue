<script setup>
// 收票员工作看板(管理员首页核心):人 → 批次 → 工作量。
// 排序/搜索/展开全在前端本地做(20~30 人量级,数据一次全量下发)。
// 展开行(2026-07-29 需求A1 修正)=该员**全部**批次,列与「已完成批次」表一致:
//   批次|完成时间|收图|已审|待审|异常|耗时|导出状态|查看 —— 直接复用 BatchListTable,
//   一套列口径一套代码。原三列极简表(批次|待办|进入)作废:那三列装不下需求要的
//   完成时间/耗时/导出状态,用户看到的等于"没补"。
import { computed, ref } from 'vue'

import {
  COLLECTOR_SORTS,
  filterCollectors,
  fmtPct,
  formatWorkspaces,
  ownerBatches,
  sortCollectors,
} from '../../lib/homeDisplay'
import BatchListTable from './BatchListTable.vue'
import ProgressBar from './ProgressBar.vue'

const props = defineProps({
  collectors: { type: Array, default: () => [] },
  batches: { type: Array, default: () => [] },
  // bare=true:外层已由 CollapsiblePanel 提供 panel 外壳与标题,这里不再自带(免双层框)
  bare: { type: Boolean, default: false },
})

const sortKey = ref('owner')
const keyword = ref('')
const expandedOwner = ref('')

const visibleCollectors = computed(() =>
  sortCollectors(filterCollectors(props.collectors, keyword.value), sortKey.value),
)

function toggleExpand(owner) {
  expandedOwner.value = expandedOwner.value === owner ? '' : owner
}

function batchesOf(owner) {
  return ownerBatches(props.batches, owner)
}

function workspaceLabel(c) {
  return formatWorkspaces(c.workspaces)
}
</script>

<template>
  <section class="cb-panel" :class="{ panel: !bare }">
    <div class="panel-header cb-head" :class="{ 'cb-head--bare': bare }">
      <strong v-if="!bare">收票员工作看板</strong>
      <div class="cb-tools">
        <label class="cb-sort-label">排序:</label>
        <div class="cb-sorts" role="radiogroup" aria-label="看板排序">
          <button
            v-for="opt in COLLECTOR_SORTS"
            :key="opt.key"
            type="button"
            class="cb-sort"
            :class="{ active: sortKey === opt.key }"
            @click="sortKey = opt.key"
          >
            {{ opt.label }}
          </button>
        </div>
        <input
          v-model="keyword"
          type="search"
          class="cb-search"
          placeholder="搜索收票员"
          aria-label="搜索收票员"
        >
        <span class="count">{{ visibleCollectors.length }} 人</span>
      </div>
    </div>

    <table class="table cb-table">
      <thead>
        <tr>
          <th>收票员</th>
          <th>工作区</th>
          <th class="num">批次数</th>
          <th class="num">收图</th>
          <th class="num">已审</th>
          <th class="num">待审</th>
          <th class="cb-rate-col">完成率</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <template v-for="c in visibleCollectors" :key="c.owner">
          <tr
            class="cb-row"
            role="button"
            tabindex="0"
            :aria-expanded="expandedOwner === c.owner"
            @click="toggleExpand(c.owner)"
            @keydown.enter="toggleExpand(c.owner)"
            @keydown.space.prevent="toggleExpand(c.owner)"
          >
            <td><strong>{{ c.owner }}</strong></td>
            <td class="muted" :title="workspaceLabel(c).title">{{ workspaceLabel(c).text }}</td>
            <td class="num">{{ c.batches }}</td>
            <td class="num">{{ c.collected }}</td>
            <td class="num"><span class="count">{{ c.reviewed }}</span></td>
            <td class="num"><span class="count" :class="{ warning: c.pending > 0 }">{{ c.pending }}</span></td>
            <td>
              <div class="cb-rate">
                <ProgressBar :value="c.completionRate" />
                <span class="cb-rate__text">{{ fmtPct(c.completionRate) }}</span>
              </div>
            </td>
            <td class="cb-expand-cell">
              <span class="link-like">{{ expandedOwner === c.owner ? '▾ 收起' : '▸ 展开' }}</span>
            </td>
          </tr>
          <tr v-if="expandedOwner === c.owner" class="cb-detail-row">
            <td colspan="8" @click.stop>
              <!-- 需求A1:与「已完成批次」表同一套列(完成时间/收图/已审/待审/异常/耗时/导出状态)。
                   未完成批次在前(还有活的优先),完成时间/导出状态对它们显示「—/未导出」是真实态。 -->
              <BatchListTable
                :batches="batchesOf(c.owner)"
                show-export
                show-action
                :preview-count="5"
                empty-text="该收票员还没有批次"
              />
            </td>
          </tr>
        </template>
        <tr v-if="!visibleCollectors.length">
          <td colspan="8" class="empty">{{ keyword ? '没有匹配的收票员' : '暂无收票员数据' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.cb-head { flex-wrap: wrap; gap: 10px; }
/* bare:标题由外层 CollapsiblePanel 出,这里只剩工具行——去掉标题行的上内边距与分隔线 */
.cb-head--bare { padding-top: 0; border-bottom: none; justify-content: flex-end; }
.cb-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cb-sort-label { font-size: 0.78rem; color: var(--muted, #6b7280); }
.cb-sorts { display: inline-flex; border: 1px solid var(--line, #e5e7eb); border-radius: 8px; overflow: hidden; }
.cb-sort {
  border: none;
  background: var(--surface, #fff);
  padding: 4px 10px;
  font-size: 0.78rem;
  color: var(--muted, #6b7280);
  cursor: pointer;
}
.cb-sort + .cb-sort { border-left: 1px solid var(--line, #e5e7eb); }
.cb-sort:hover { color: var(--accent, #2563eb); }
.cb-sort.active { background: var(--accent, #2563eb); color: #fff; }
.cb-search {
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 0.8rem;
  width: 130px;
}
.cb-search:focus { outline: none; border-color: var(--accent, #2563eb); }

.cb-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.cb-rate-col { width: 150px; }
.cb-rate { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.cb-rate__text { font-size: 0.76rem; color: var(--muted, #6b7280); font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
.cb-row { cursor: pointer; }
.cb-expand-cell { text-align: right; white-space: nowrap; }

.cb-detail-row > td { background: var(--surface-soft, #f8fafc); padding: 8px 14px 12px; }
</style>
