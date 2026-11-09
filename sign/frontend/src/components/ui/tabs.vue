<script setup>
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

defineProps({
  tabs: { type: Array, default: () => [] },
})
</script>

<template>
  <TabsRoot v-bind="$attrs">
    <TabsList class="inline-flex rounded-lg bg-muted p-1">
      <TabsTrigger v-for="tab in tabs" :key="tab.value" :value="tab.value" class="rounded-md px-3 py-1.5 text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
        {{ tab.label }}
      </TabsTrigger>
      <slot name="list" />
    </TabsList>
    <TabsContent v-for="tab in tabs" :key="`${tab.value}-content`" :value="tab.value">
      <slot :name="tab.value" />
    </TabsContent>
    <slot />
  </TabsRoot>
</template>
