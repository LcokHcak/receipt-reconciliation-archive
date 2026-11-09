<script setup>
import {
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'radix-vue'

defineProps({
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: '选择' },
})
</script>

<template>
  <SelectRoot v-bind="$attrs">
    <SelectTrigger class="inline-flex h-10 min-w-36 items-center justify-between rounded-md border border-input bg-background px-3 text-sm">
      <SelectValue :placeholder="placeholder" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="z-50 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        <SelectViewport>
          <SelectItem v-for="item in items" :key="item.value ?? item" :value="item.value ?? item" class="rounded-sm px-3 py-2 text-sm hover:bg-muted">
            <SelectItemText>{{ item.label ?? item }}</SelectItemText>
          </SelectItem>
          <slot />
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
