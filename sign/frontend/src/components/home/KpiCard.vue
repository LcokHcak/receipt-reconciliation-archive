<script setup>
// 工作台首页 KPI 卡:数字大、标签小、可选提示/进度/警示色。
// tone: default | warn(>0 异常) | success | muted(未上线的占位,如今日导出 P1)
import ProgressBar from './ProgressBar.vue'

defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  hint: { type: String, default: '' },
  tone: { type: String, default: 'default' },
  progress: { type: Number, default: null },
})
</script>

<template>
  <article class="kpi-card" :class="`kpi-card--${tone}`">
    <span class="kpi-card__label">{{ label }}</span>
    <strong class="kpi-card__value">{{ value }}</strong>
    <ProgressBar v-if="progress !== null" :value="progress" class="kpi-card__bar" />
    <span v-if="hint" class="kpi-card__hint">{{ hint }}</span>
  </article>
</template>

<style scoped>
.kpi-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: var(--surface, #fff);
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 12px;
  min-width: 0;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.kpi-card:hover { border-color: var(--accent, #2563eb); box-shadow: 0 4px 14px rgba(37, 99, 235, 0.08); }

.kpi-card__label { font-size: 0.78rem; color: var(--muted, #6b7280); }
.kpi-card__value {
  font-size: 1.7rem;
  font-weight: 500;
  line-height: 1.15;
  color: var(--text, #111);
  font-variant-numeric: tabular-nums;
}
.kpi-card__hint { font-size: 0.72rem; color: var(--muted, #6b7280); }
.kpi-card__bar { margin-top: 2px; }

.kpi-card--warn .kpi-card__value { color: var(--warning, #d97706); }
.kpi-card--success .kpi-card__value { color: var(--success, #475569); }
.kpi-card--muted .kpi-card__value { color: var(--muted, #9ca3af); font-weight: 500; }
</style>
