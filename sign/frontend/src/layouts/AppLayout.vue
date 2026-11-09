<script setup>
/**
 * AppLayout — global shell for v2 monthly workspace pages.
 * Uses shadcn-vue SidebarProvider + AppSidebar + SidebarInset pattern.
 * Applied as a scoped class="v2-layout" so design tokens don't bleed
 * into legacy CSS custom properties.
 */
import { useRoute } from 'vue-router'
import { computed } from 'vue'

import SidebarProvider from '@/components/ui/sidebar-provider.vue'
import SidebarInset from '@/components/ui/sidebar-inset.vue'
import AppSidebar from '@/layouts/AppSidebar.vue'
import WorkspaceSwitcher from '@/components/v2/WorkspaceSwitcher.vue'

defineProps({
  workspaceKey: { type: String, default: '' },
})

const route = useRoute()

// Breadcrumb from route meta or fallback
const pageTitle = computed(() => route.meta?.title || '结算中心')
</script>

<template>
  <!-- .v2-layout scopes shadcn-vue CSS variables (see style.css) -->
  <div class="v2-layout min-h-svh w-full font-sans">
    <SidebarProvider>
      <AppSidebar :workspace-key="workspaceKey" />

      <SidebarInset>
        <!-- Top header bar -->
        <header class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 backdrop-blur px-4">
          <nav aria-label="ページ位置" class="flex items-center gap-1 text-sm text-muted-foreground">
            <span class="font-medium text-foreground">{{ pageTitle }}</span>
          </nav>
          <div class="ml-auto">
            <WorkspaceSwitcher v-if="workspaceKey" />
          </div>
        </header>

        <!-- Page content -->
        <div class="flex flex-1 flex-col gap-6 p-6">
          <slot />
        </div>
      </SidebarInset>
    </SidebarProvider>
  </div>
</template>
