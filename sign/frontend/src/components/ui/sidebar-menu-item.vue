<script setup>
import { cn } from '@/lib/cn'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <li :class="cn('group/menu-item relative', props.class)">
    <slot />
  </li>
</template>
