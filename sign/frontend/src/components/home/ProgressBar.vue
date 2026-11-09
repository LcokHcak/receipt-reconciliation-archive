<script setup>
// 完成率统一绿色 Progress(提示词四:完成率统一使用 Progress Bar,绿色)。
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 }, // 0..1
  showLabel: { type: Boolean, default: false },
})

// 文字与条同 clamp(计数字段被并发脏写>1 时,条被压 100%,title 不能显示 130%)
const pctText = computed(() => `${Math.min(100, Math.max(0, Math.round((Number(props.value) || 0) * 100)))}%`)
const width = computed(() => `${Math.min(100, Math.max(0, (Number(props.value) || 0) * 100))}%`)
</script>

<template>
  <div class="hp-progress" :title="pctText">
    <span class="hp-progress__track">
      <span class="hp-progress__fill" :style="{ width }" />
    </span>
    <span v-if="showLabel" class="hp-progress__label">{{ pctText }}</span>
  </div>
</template>

<style scoped>
.hp-progress { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hp-progress__track {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-soft, #eef2f7);
  overflow: hidden;
}
.hp-progress__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--success, #94a3b8);
  transition: width 300ms ease;
}
.hp-progress__label {
  font-size: 0.76rem;
  color: var(--muted, #6b7280);
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: right;
}
</style>
