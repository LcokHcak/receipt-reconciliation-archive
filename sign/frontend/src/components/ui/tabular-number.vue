<script setup>
/**
 * TabularNumber — renders a numeric value with tabular (monospaced) digits.
 * Useful for financial data in tables so numbers align vertically.
 *
 * Props:
 *   value    — the number to display (null → shows placeholder)
 *   locale   — BCP47 locale for Intl.NumberFormat (default: 'zh-CN')
 *   currency — ISO 4217 currency code; when set, formats as currency
 *   decimals — fixed decimal places (default: 0 for integers, 2 for currency)
 *   placeholder — shown when value is null/undefined (default: '—')
 *   class    — extra CSS classes
 */
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = defineProps({
  value: { type: Number, default: null },
  locale: { type: String, default: 'zh-CN' },
  currency: { type: String, default: null }, // 'KRW' | 'USD' | null
  decimals: { type: Number, default: null }, // null = auto
  placeholder: { type: String, default: '—' },
  class: { type: String, default: '' },
})

const formatted = computed(() => {
  if (props.value == null) return props.placeholder

  const opts = { style: 'decimal' }

  if (props.currency) {
    opts.style = 'currency'
    opts.currency = props.currency
    // KRW has no cents; USD has 2
    const defaultDp = props.currency === 'KRW' ? 0 : 2
    opts.minimumFractionDigits = props.decimals ?? defaultDp
    opts.maximumFractionDigits = props.decimals ?? defaultDp
  } else if (props.decimals != null) {
    opts.minimumFractionDigits = props.decimals
    opts.maximumFractionDigits = props.decimals
  }

  return new Intl.NumberFormat(props.locale, opts).format(props.value)
})

const classes = computed(() =>
  cn('tabular-nums font-mono', props.class),
)
</script>

<template>
  <span :class="classes">{{ formatted }}</span>
</template>
