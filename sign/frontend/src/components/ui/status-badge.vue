<script setup>
/**
 * StatusBadge — 5-variant status chip for v2 UI.
 *
 * Variants:
 *   ok      → gray  (操作成功 / 已完成 / 通过;0728 绿删改灰阶)
 *   warn    → amber (待处理 / 部分匹配 / 注意)
 *   error   → red   (错误 / 失败 / 冲突)
 *   info    → indigo (信息 / 处理中)
 *   test    → violet (测试模式 / demo 数据)
 */
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  variant: {
    type: String,
    default: 'info',
    validator: (v) => ['ok', 'warn', 'error', 'info', 'test'].includes(v),
  },
  size: { type: String, default: 'default' }, // default | sm
  dot: { type: Boolean, default: false },
  class: { type: String, default: '' },
})

const base =
  'inline-flex items-center gap-1.5 rounded-full font-medium'

const sizes = {
  default: 'px-2.5 py-0.5 text-xs',
  sm:      'px-2 py-px text-[10px]',
}

const variants = {
  ok:    'bg-slate-100 text-slate-600 ring-1 ring-slate-200', // 0728 硬规则:绿删,ok=灰阶
  warn:  'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  error: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  info:  'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
  test:  'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
}

const dotColors = {
  // 0731:0728 那轮把上面 variants.ok 改成灰阶时**漏了圆点**,这里一直是 emerald。
  // 没被看见是因为 118 处 StatusBadge 没有一处传 dot —— 但它照样编进 CSS,
  // 谁哪天加个 dot 就绿回来了。灰阶取 slate-400,压在 slate-100 底上还看得见。
  ok:    'bg-slate-400',
  warn:  'bg-amber-500',
  error: 'bg-red-500',
  info:  'bg-indigo-500',
  test:  'bg-violet-500',
}

const classes = computed(() =>
  cn(base, sizes[props.size] ?? sizes.default, variants[props.variant] ?? variants.info, props.class),
)

const dotClass = computed(() =>
  cn('h-1.5 w-1.5 rounded-full shrink-0', dotColors[props.variant] ?? dotColors.info),
)
</script>

<template>
  <span :class="classes">
    <span v-if="dot" :class="dotClass" aria-hidden="true" />
    <slot />
  </span>
</template>
