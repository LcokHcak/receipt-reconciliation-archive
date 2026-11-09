<script setup>
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'
</script>

<template>
  <TooltipProvider>
    <TooltipRoot>
      <TooltipTrigger as-child><slot name="trigger" /></TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="z-50 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md" side="top">
          <slot />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
