<script setup>
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from 'radix-vue'
</script>

<template>
  <DialogRoot v-bind="$attrs">
    <slot name="trigger" :trigger="DialogTrigger" />
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-6 shadow-lg">
        <slot :title="DialogTitle" :description="DialogDescription" :close="DialogClose" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
