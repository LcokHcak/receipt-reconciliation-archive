<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CalendarPlus, Lock } from 'lucide-vue-next'

import Button from '@/components/ui/button.vue'
import Input from '@/components/ui/input.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import { createMonthlyWorkspace, fetchMonthlyWorkspaces } from '@/api/monthly'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const creating = ref(false)
const errorMsg = ref('')
const workspaces = ref([])
const newWorkspaceKey = ref('')

const currentKey = computed(() => String(route.params?.workspaceKey || ''))
const currentLabel = computed(() => currentKey.value || '选择月份')
const productionWorkspaces = computed(() => normalizedWorkspaces.value.filter((w) => !w.key.startsWith('demo-')))
const demoWorkspaces = computed(() => normalizedWorkspaces.value.filter((w) => w.key.startsWith('demo-')))
const normalizedWorkspaces = computed(() => {
  return workspaces.value
    .map((item) => {
      const key = String(item?.workspaceKey || item?.key || item || '').trim()
      return {
        key,
        isClosed: item?.status === 'closed' || item?.status === 'locked' || Boolean(item?.closedAt || item?.lockedAt),
      }
    })
    .filter((item) => item.key)
    .sort((a, b) => b.key.localeCompare(a.key))
})

function nextRouteFor(targetKey) {
  return {
    name: route.name,
    params: { ...route.params, workspaceKey: targetKey },
    query: route.query,
  }
}

async function loadWorkspaces() {
  loading.value = true
  errorMsg.value = ''
  try {
    const payload = await fetchMonthlyWorkspaces({ mode: 'all' })
    const items = Array.isArray(payload?.workspaces) ? payload.workspaces
      : Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload) ? payload
      : []
    workspaces.value = items
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '月份列表加载失败'
  } finally {
    loading.value = false
  }
}

async function switchTo(key) {
  if (!key || key === currentKey.value) return
  await router.push(nextRouteFor(key))
}

async function createAndSwitch() {
  const key = newWorkspaceKey.value.trim()
  if (!key || creating.value) return
  creating.value = true
  errorMsg.value = ''
  try {
    await createMonthlyWorkspace(key)
    newWorkspaceKey.value = ''
    await loadWorkspaces()
    await switchTo(key)
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '创建月份失败'
  } finally {
    creating.value = false
  }
}

onMounted(loadWorkspaces)
</script>

<template>
  <details class="relative">
    <summary class="list-none">
      <Button variant="outline" size="sm" class="gap-2">
        <CalendarPlus class="h-4 w-4" />
        <span class="font-mono">{{ currentLabel }}</span>
        <span class="text-muted-foreground">▾</span>
      </Button>
    </summary>

    <div class="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <div class="flex items-center gap-2">
        <Input v-model="newWorkspaceKey" class="h-8 flex-1 font-mono text-xs" placeholder="2026-06 或 demo-2026-06" />
        <Button size="sm" :disabled="creating || !newWorkspaceKey.trim()" @click="createAndSwitch">创建</Button>
      </div>
      <p v-if="errorMsg" class="mt-2 rounded-md bg-status-error/10 px-2 py-1 text-xs text-status-error">{{ errorMsg }}</p>
      <p v-else-if="loading" class="mt-2 text-xs text-muted-foreground">加载月份中...</p>

      <div class="mt-3 space-y-3">
        <section>
          <p class="mb-1 text-xs font-medium text-muted-foreground">正式月份</p>
          <div class="max-h-48 space-y-1 overflow-y-auto">
            <button
              v-for="item in productionWorkspaces"
              :key="item.key"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              @click="switchTo(item.key)"
            >
              <span class="flex-1 font-mono">{{ item.key }}</span>
              <Lock v-if="item.isClosed" class="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </section>

        <section>
          <p class="mb-1 text-xs font-medium text-muted-foreground">测试月份</p>
          <div class="max-h-40 space-y-1 overflow-y-auto">
            <button
              v-for="item in demoWorkspaces"
              :key="item.key"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              @click="switchTo(item.key)"
            >
              <StatusBadge variant="test" size="sm">demo</StatusBadge>
              <span class="flex-1 font-mono">{{ item.key }}</span>
              <Lock v-if="item.isClosed" class="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <p v-if="!demoWorkspaces.length" class="px-2 py-1 text-xs text-muted-foreground">暂无测试月份</p>
          </div>
        </section>
      </div>
    </div>
  </details>
</template>
