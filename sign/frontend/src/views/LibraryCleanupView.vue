<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { fetchLibraryOrphans, deleteLibraryOrphans } from '../api/customer'

const loading = ref(false)
const deleting = ref(false)
const error = ref('')
const message = ref('')
const orphans = ref([])
const totalImages = ref(0)
const selected = reactive(new Set())

const keyOf = (o) => `${o.workspaceKey}\u0000${o.customerId}`

const grouped = computed(() => {
  const map = new Map()
  for (const o of orphans.value) {
    if (!map.has(o.workspaceKey)) map.set(o.workspaceKey, [])
    map.get(o.workspaceKey).push(o)
  }
  return [...map.entries()].map(([workspaceKey, rows]) => ({ workspaceKey, rows }))
})

const allSelected = computed(() => orphans.value.length > 0 && selected.size === orphans.value.length)
const selectedImageCount = computed(() =>
  orphans.value.filter((o) => selected.has(keyOf(o))).reduce((n, o) => n + (o.imageCount || 0), 0)
)

function toggle(o) {
  const k = keyOf(o)
  if (selected.has(k)) selected.delete(k)
  else selected.add(k)
}
function toggleAll() {
  if (allSelected.value) selected.clear()
  else for (const o of orphans.value) selected.add(keyOf(o))
}
function toggleGroup(group) {
  const keys = group.rows.map(keyOf)
  const allOn = keys.every((k) => selected.has(k))
  for (const k of keys) (allOn ? selected.delete(k) : selected.add(k))
}

async function load() {
  loading.value = true
  error.value = ''
  message.value = ''
  selected.clear()
  try {
    const res = await fetchLibraryOrphans()
    orphans.value = res.orphans || []
    totalImages.value = res.totalImages || 0
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载孤儿数据失败'
  } finally {
    loading.value = false
  }
}

async function deleteSelected() {
  const items = orphans.value
    .filter((o) => selected.has(keyOf(o)))
    .map((o) => ({ workspaceKey: o.workspaceKey, customerId: o.customerId }))
  if (!items.length) return
  if (!window.confirm(`确认删除 ${items.length} 个孤儿客户(共 ${selectedImageCount.value} 张图片)?\n这些客户的审核批次已被删,库里原始图片将被永久删除,不可恢复。`)) return
  deleting.value = true
  error.value = ''
  message.value = ''
  try {
    const res = await deleteLibraryOrphans(items)
    const failed = (res.results || []).filter((r) => !r.ok)
    message.value = `已删除 ${res.deleted}/${res.total} 个孤儿客户。`
    if (failed.length) error.value = `${failed.length} 个未删:${failed.map((f) => f.error).join('；')}`
    await load()
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '删除失败'
  } finally {
    deleting.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="lc">
    <header class="lc-head">
      <div>
        <h1>库清理</h1>
        <p class="lc-sub">列出「审核批次已被删、但库里原始图片还留着」的孤儿客户 —— 这些是占空间的废数据。勾选删除即可释放。</p>
      </div>
      <button class="ghost-button" type="button" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
    </header>

    <div class="lc-summary">
      <span class="lc-chip" :class="orphans.length ? 'warn' : 'ok'">孤儿客户 {{ orphans.length }}</span>
      <span class="lc-chip">图片 {{ totalImages }} 张</span>
      <span v-if="selected.size" class="lc-chip sel">已选 {{ selected.size }} · {{ selectedImageCount }} 张图</span>
    </div>

    <div v-if="error" class="lc-alert err">{{ error }}</div>
    <div v-if="message" class="lc-alert ok">{{ message }}</div>

    <div class="lc-toolbar">
      <label class="lc-selall">
        <input type="checkbox" :checked="allSelected" :disabled="!orphans.length" @change="toggleAll">
        全选
      </label>
      <button class="danger-button" type="button" :disabled="!selected.size || deleting" @click="deleteSelected">
        {{ deleting ? '删除中…' : `删除选中 (${selected.size})` }}
      </button>
    </div>

    <p v-if="!loading && !orphans.length" class="lc-empty">没有孤儿数据 —— 库里很干净 ✓</p>

    <div v-for="group in grouped" :key="group.workspaceKey" class="lc-group">
      <div class="lc-group-head">
        <label class="lc-selall">
          <input
            type="checkbox"
            :checked="group.rows.every((r) => selected.has(keyOf(r)))"
            @change="toggleGroup(group)"
          >
          <strong>{{ group.workspaceKey }}</strong>
        </label>
        <span class="muted">{{ group.rows.length }} 个孤儿</span>
      </div>
      <ul class="lc-rows">
        <li v-for="o in group.rows" :key="o.customerId" class="lc-row" :class="{ on: selected.has(keyOf(o)) }">
          <label class="lc-rowmain">
            <input type="checkbox" :checked="selected.has(keyOf(o))" @change="toggle(o)">
            <span class="lc-cust">{{ o.customerId }}</span>
            <span v-if="o.agentName" class="lc-agent">{{ o.agentName }}</span>
          </label>
          <span class="lc-imgs">{{ o.imageCount }} 张图</span>
          <span class="lc-batch" :title="o.lastBatchId">已删批次 {{ o.lastBatchId.slice(-8) }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.lc { max-width: 960px; margin: 0 auto; padding: 18px 16px 60px; }
.lc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.lc-head h1 { font-size: 1.4rem; margin: 0 0 4px; color: var(--text, #111827); }
.lc-sub { margin: 0; font-size: 0.85rem; color: var(--muted, #6b7280); max-width: 620px; line-height: 1.5; }
.lc-summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
.lc-chip { padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--surface-soft, #f1f5f9); color: var(--muted, #6b7280); }
.lc-chip.ok { background: #f1f5f9; color: #475569; }
.lc-chip.warn { background: #fff4dd; color: #b45309; }
.lc-chip.sel { background: #e0edff; color: #1d4ed8; }
.lc-alert { padding: 9px 13px; border-radius: 9px; font-size: 0.85rem; margin-bottom: 10px; }
.lc-alert.err { background: #fce4e4; color: #b42318; }
.lc-alert.ok { background: #f1f5f9; color: #475569; }
.lc-toolbar { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line, #e5e7eb); position: sticky; top: 0; background: var(--bg, #fff); z-index: 2; }
.lc-selall { display: inline-flex; align-items: center; gap: 7px; font-size: 0.85rem; cursor: pointer; user-select: none; }
.danger-button { background: #dc2626; color: #fff; border: none; padding: 7px 16px; border-radius: 8px; font-weight: 500; font-size: 0.85rem; cursor: pointer; }
.danger-button:disabled { opacity: 0.45; cursor: not-allowed; }
.lc-empty { text-align: center; color: var(--muted, #6b7280); padding: 48px 0; font-size: 0.95rem; }
.lc-group { margin-top: 18px; }
.lc-group-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 2px; }
.lc-group-head strong { color: var(--text, #111827); }
.lc-rows { list-style: none; margin: 6px 0 0; padding: 0; border: 1px solid var(--line, #e5e7eb); border-radius: 10px; overflow: hidden; }
.lc-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid #f1f3f5; font-size: 0.86rem; }
.lc-row:first-child { border-top: none; }
.lc-row.on { background: #f5f9ff; }
.lc-rowmain { display: flex; align-items: center; gap: 10px; flex: 1; cursor: pointer; min-width: 0; }
.lc-cust { font-weight: 500; color: var(--text, #111827); }
.lc-agent { font-size: 0.76rem; color: #6b7280; background: #f1f5f9; padding: 1px 8px; border-radius: 999px; }
.lc-imgs { color: #6b7280; white-space: nowrap; }
.lc-batch { color: #9ca3af; font-size: 0.78rem; white-space: nowrap; }
.muted { color: var(--muted, #6b7280); font-size: 0.8rem; }
</style>
