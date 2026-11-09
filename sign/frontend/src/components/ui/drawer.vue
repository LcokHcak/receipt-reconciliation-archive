<script setup>
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

defineProps({
  title: { type: String, default: '详情抽屉' },
  description: { type: String, default: '查看并处理当前记录的详细信息' },
})
</script>

<template>
  <DialogRoot v-bind="$attrs">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
      <DialogContent class="fixed right-0 top-0 z-50 h-svh w-full max-w-[480px] border-l border-border bg-card p-5 shadow-lg transition-transform">
        <DialogTitle class="sr-only">{{ title }}</DialogTitle>
        <DialogDescription class="sr-only">{{ description }}</DialogDescription>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
