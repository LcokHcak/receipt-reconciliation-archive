<script setup>
/**
 * 审核中心页签(0728#2 第 50 条 · 方案2 的页面级那一刀)。
 *
 * 为什么是"两个页面共用一条页签"而不是"把补救页塞进审核台":
 *   审核台是键盘驱动的主作业面(Enter / R+1/2/3 / ←→),把另一个大视图挂进它的
 *   组件树里,那套快捷键就得开始分辨"现在焦点在哪个页签",是给主作业面加风险。
 *   而且 0728 定过 **URL 不动** —— /daily/remedy/:workspaceKey 这种深链要留着。
 *   共用页签既拿到了"一个页面两个标签"的观感,又不动路由、不碰键盘流。
 *
 * 承接角标(琥珀):告诉正在审核的人"那边还压着 N 条"。
 *   计数口径**刻意和补救页完全一致** —— 同一份 REMEDY_TOUR_STATUSES、
 *   同一批工作区。不一致的话角标显示 3、点进去看见 7,那比不显示更糟。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { AlertTriangle, SearchCheck } from 'lucide-vue-next'

import { fetchMonthlyWorkspaces } from '@/api/monthly'
import { fetchLedgerTourStatusCounts } from '@/api/v2/ledger'
import { REMEDY_TOUR_STATUSES } from '@/lib/remedyStatuses'

const route = useRoute()
const pending = ref(null) // null=还没数出来(不显示角标),数字=真实条数
const onRemedy = computed(() => route.path.startsWith('/daily/remedy'))

async function countPending() {
  try {
    const payload = await fetchMonthlyWorkspaces({ mode: 'all' })
    const items = Array.isArray(payload?.workspaces) ? payload.workspaces
      : Array.isArray(payload?.items) ? payload.items : []
    const keys = items.map((it) => (typeof it === 'string' ? it : it?.workspaceKey)).filter(Boolean)
    if (!keys.length) { pending.value = 0; return }
    const counts = await Promise.all(keys.map((k) =>
      fetchLedgerTourStatusCounts(k).then((r) => r?.counts || []).catch(() => null)))
    // 有任何一个工作区没数出来就**不显示**角标 —— 少算的角标会让人以为
    // "那边没剩几条了",而少算恰恰是这类数字最容易犯的错。宁可不显示。
    if (counts.some((c) => c === null)) { pending.value = null; return }
    pending.value = counts.flat()
      .filter((row) => REMEDY_TOUR_STATUSES.includes(row?.status))
      .reduce((sum, row) => sum + (Number(row?.n) || 0), 0)
  } catch {
    pending.value = null
  }
}

onMounted(countPending)
</script>

<template>
  <nav class="rct" aria-label="审核中心">
    <RouterLink to="/review/latest" class="rct-tab" :class="{ active: !onRemedy }">
      <SearchCheck :size="14" aria-hidden="true" />
      <span>审核台</span>
    </RouterLink>
    <RouterLink to="/daily/remedy" class="rct-tab" :class="{ active: onRemedy }">
      <AlertTriangle :size="14" aria-hidden="true" />
      <span>异常补救</span>
      <!-- 0 条不显示角标:健康态不该有东西在那儿闪。
           数不出来也不显示 —— 见上面"宁可不显示"。 -->
      <b v-if="pending" class="rct-badge" :title="`${pending} 条待补救`">{{ pending }}</b>
    </RouterLink>
  </nav>
</template>

<style scoped>
.rct { display: inline-flex; gap: 2px; margin-bottom: 10px; }
.rct-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 8px 8px 0 0;
  font-size: 13px; color: var(--muted); text-decoration: none;
  border-bottom: 2px solid transparent;
}
.rct-tab:hover { background: var(--surface-soft); }
/* ⚠️ 这里**不能**写 var(--accent)。这条页签同时挂在审核台(老页面)和补救页
   (.v2-layout 的 v2 页面)上,而 .v2-layout 把 --accent 从颜色 #1863c6
   重定义成了 shadcn 的 HSL 三元组「243 75% 95%」—— 那不是合法颜色值,
   var() 解析失败,border-bottom-color 静默回退到 currentColor,
   于是同一条页签在两个页面下划线颜色不一样。实机就是这么发现的
   (量到 rgb(19,33,58) = 文字色,而不是预期的蓝)。
   页签是可点的,按硬规则用蓝是对的;写字面量避开这个撞车。 */
.rct-tab.active { color: var(--text); font-weight: 500; border-bottom-color: #1863c6; }
/* 硬规则「胶囊只作状态」:这是数量,所以不给胶囊底和圆角,只留琥珀(要处理) */
.rct-badge { color: var(--warning); font-weight: 500; font-variant-numeric: tabular-nums; }
</style>
