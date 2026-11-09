<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { AlertTriangle, CheckCircle2 } from 'lucide-vue-next'

import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import { fetchModeMapping, updateModeMapping } from '@/api/v2/setup'

// 缺口D: 待决定模式面板。
// 把"台账里出现、但还没决定归桶/不参与"的模式做成显眼清单,
// 每个模式三选一:归到某桶 / 明确不参与 / (留空=待决定,会拦 merge)。
const props = defineProps({
  workspaceKey: { type: String, required: true },
  // 4 个业务桶名(从父级 buckets 传入)
  folders: { type: Array, default: () => [] },
})
const emit = defineEmits(['changed'])

const loading = ref(false)
const errorMsg = ref('')
const busyMode = ref('')
const items = ref([])      // [{ modeRaw, modeFolder }] 已决定(含 folder=null=不参与)
const unmapped = ref([])   // [string] 待决定(无任何决定)
const picks = ref({})      // modeRaw -> 选中的桶

const undecided = computed(() => unmapped.value.slice())
const excluded = computed(() => items.value.filter((it) => !it.modeFolder).map((it) => it.modeRaw))

function describeError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback
}

async function load() {
  if (!props.workspaceKey) return
  loading.value = true
  errorMsg.value = ''
  try {
    const payload = await fetchModeMapping(props.workspaceKey)
    items.value = Array.isArray(payload?.items)
      ? payload.items.map((it) => ({ modeRaw: it.modeRaw ?? it.mode_raw, modeFolder: it.modeFolder ?? it.mode_folder ?? null }))
      : []
    unmapped.value = Array.isArray(payload?.unmapped)
      ? payload.unmapped.map((m) => (typeof m === 'string' ? m : m?.modeRaw)).filter(Boolean)
      : []
  } catch (error) {
    errorMsg.value = describeError(error, '读取待决定模式失败')
  } finally {
    loading.value = false
  }
}

async function decide(modeRaw, modeFolder) {
  if (!modeRaw || busyMode.value) return
  busyMode.value = modeRaw
  errorMsg.value = ''
  try {
    // modeFolder = 桶名 → 归桶参与;modeFolder = null → 明确不参与(已决定,不卡 merge)
    await updateModeMapping(props.workspaceKey, { mappings: [{ modeRaw, modeFolder: modeFolder || null }] })
    await load()
    emit('changed')
  } catch (error) {
    errorMsg.value = describeError(error, '模式决定保存失败')
  } finally {
    busyMode.value = ''
  }
}

function assignPicked(modeRaw) {
  const folder = picks.value[modeRaw]
  if (folder) decide(modeRaw, folder)
}

onMounted(load)
watch(() => props.workspaceKey, load)
defineExpose({ reload: load, undecidedCount: () => undecided.value.length })
</script>

<template>
  <section
    class="rounded-lg border p-4 shadow-sm"
    :class="undecided.length
      ? 'border-status-warn/40 bg-status-warn/5'
      : 'border-status-ok/30 bg-status-ok/5'"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <AlertTriangle v-if="undecided.length" class="h-5 w-5 text-status-warn" />
        <CheckCircle2 v-else class="h-5 w-5 text-status-ok" />
        <h2 class="text-sm font-medium text-foreground">模式归类</h2>
        <StatusBadge :variant="undecided.length ? 'warn' : 'ok'" size="sm" dot>
          {{ undecided.length ? `${undecided.length} 个模式待决定` : '全部已决定' }}
        </StatusBadge>
        <span v-if="excluded.length" class="text-xs text-muted-foreground">· {{ excluded.length }} 个不参与</span>
      </div>
      <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
    </div>

    <p class="mt-1 text-xs text-muted-foreground">
      团号匹配后台账里出现的模式都列在这里。未决定的会拦住交付——请给每个模式选「归到某桶」或「不参与」。
    </p>

    <div v-if="errorMsg" class="mt-2 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
      {{ errorMsg }}
    </div>

    <ul v-if="undecided.length" class="mt-3 space-y-2">
      <li
        v-for="mode in undecided"
        :key="mode"
        class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
      >
        <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground" :title="mode">{{ mode }}</span>
        <select
          v-model="picks[mode]"
          class="h-8 rounded-md border border-border bg-background px-2 text-xs"
          :disabled="busyMode === mode"
        >
          <option value="">归到桶…</option>
          <option v-for="f in folders" :key="f" :value="f">{{ f }}</option>
        </select>
        <Button size="sm" variant="outline" class="h-8 px-3 text-xs" :disabled="busyMode === mode || !picks[mode]" @click="assignPicked(mode)">
          归桶
        </Button>
        <Button size="sm" variant="ghost" class="h-8 px-3 text-xs text-muted-foreground" :disabled="busyMode === mode" @click="decide(mode, null)">
          不参与
        </Button>
      </li>
    </ul>

    <p v-else-if="!loading" class="mt-3 text-xs text-status-ok">
      ✓ 所有模式都已归桶或标记不参与，可以继续匹配和交付。
    </p>
  </section>
</template>
