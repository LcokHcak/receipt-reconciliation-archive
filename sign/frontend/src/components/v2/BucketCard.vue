<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Play, Trash2, UploadCloud } from 'lucide-vue-next'

import Button from '@/components/ui/button.vue'
import Input from '@/components/ui/input.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import FileDropzone from '@/components/v2/FileDropzone.vue'
import { clearBucketBills, runBucketMatch } from '@/api/v2/billMatchBuckets'
import { uploadImport } from '@/api/v2/imports'
import { updateDeductConfig, fetchModeMapping, updateModeMapping } from '@/api/v2/setup'

const props = defineProps({
  bucket: { type: Object, required: true },
  workspaceKey: { type: String, required: true },
})

const emit = defineEmits(['match-finished', 'import-completed', 'config-changed'])

const deductValue = ref('')
const busy = reactive({ deduct: false, match: false, upload: false, clear: false, mode: false })
const uploadState = reactive({ error: '', success: '', fileName: '', progress: 0 })
const errorMsg = ref('')
const uploadMode = ref('replace')
const pendingFiles = ref([])  // replace 模式选中待二次确认的文件

// 清单 #5: 每桶可自选参加匹配的模式(替代写死 7 本司)
const editingModes = ref(false)
const allModeItems = ref([]) // [{ modeRaw, modeFolder }] —— 台账里实际出现的全部模式
const addPick = ref('')
const assignedModes = computed(() => props.bucket?.modeRaws || [])
const candidateModes = computed(() => {
  const taken = new Set(assignedModes.value)
  return allModeItems.value
    .map((it) => it.modeRaw)
    .filter((m) => m && !taken.has(m))
})

async function toggleEditModes() {
  editingModes.value = !editingModes.value
  // 每次展开都重新拉候选:台账后续导入会出现新模式,旧缓存会导致
  // "同一个模式在 A 桶下拉能看到、B 桶显示无可添加"(各卡片缓存时间不一致)。
  if (editingModes.value) {
    await loadModeOptions()
  }
}

async function loadModeOptions() {
  try {
    const payload = await fetchModeMapping(props.workspaceKey)
    const items = Array.isArray(payload?.items) ? payload.items : []
    const unmapped = Array.isArray(payload?.unmapped) ? payload.unmapped : []
    const merged = [...items.map((it) => ({ modeRaw: it.modeRaw, modeFolder: it.modeFolder || null }))]
    for (const m of unmapped) {
      const modeRaw = typeof m === 'string' ? m : m?.modeRaw
      if (modeRaw && !merged.some((x) => x.modeRaw === modeRaw)) merged.push({ modeRaw, modeFolder: null })
    }
    allModeItems.value = merged
  } catch (error) {
    errorMsg.value = describeError(error, '读取模式列表失败')
  }
}

async function assignMode(modeRaw, modeFolder) {
  if (!modeRaw || busy.mode) return
  busy.mode = true
  errorMsg.value = ''
  try {
    await updateModeMapping(props.workspaceKey, {
      mappings: [{ modeRaw, modeFolder: modeFolder || null }],
    })
    addPick.value = ''
    await loadModeOptions()
    emit('config-changed')
  } catch (error) {
    errorMsg.value = describeError(error, '模式归类更新失败')
  } finally {
    busy.mode = false
  }
}

function addMode() {
  if (addPick.value) assignMode(addPick.value, props.bucket.folder)
}

function removeMode(modeRaw) {
  assignMode(modeRaw, null)
}

const billCount = computed(() => Number(props.bucket?.billCount || 0))
const dailyCount = computed(() => Number(props.bucket?.dailyCount || 0))
const matched = computed(() => Number(props.bucket?.matchStats?.matched || 0))
const receivedBillRows = computed(() => Number(props.bucket?.matchStats?.matchedBillRows || 0))
const unmatchedBillRows = computed(() => Number(props.bucket?.matchStats?.unmatched || 0))
const pendingReview = computed(() => Number(props.bucket?.matchStats?.pendingReview || 0))
const ledgerMatchRate = computed(() => dailyCount.value > 0 ? matched.value / dailyCount.value : 0)
const billCoverageRate = computed(() => billCount.value > 0 ? receivedBillRows.value / billCount.value : 0)
const matchRateWidth = computed(() => Math.min(100, Math.max(0, ledgerMatchRate.value * 100)))
const matchRateLabel = computed(() => formatPercent(ledgerMatchRate.value))
const billCoverageLabel = computed(() => formatPercent(billCoverageRate.value))
const isEmpty = computed(() => Boolean(props.bucket?.isEmpty))
const missingBills = computed(() => dailyCount.value > 0 && billCount.value === 0)
const hasDeductValue = computed(() => props.bucket?.deductValue != null)

function formatPercent(value) {
  const percent = Number(value || 0) * 100
  if (!Number.isFinite(percent) || percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  if (percent < 1) return `${percent.toFixed(2)}%`
  return `${Math.round(percent)}%`
}

const status = computed(() => {
  if (isEmpty.value) return { variant: 'info', label: '无数据' }
  if (missingBills.value) return { variant: 'warn', label: '缺账单' }
  if (pendingReview.value > 0) return { variant: 'warn', label: '待核对' }
  if (unmatchedBillRows.value > 0) return { variant: 'warn', label: '有未收' }
  return { variant: 'ok', label: '正常' }
})

watch(
  () => props.bucket?.deductValue,
  (value) => { deductValue.value = value == null ? '' : String(value) },
  { immediate: true },
)

function describeError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback
}

async function saveDeduct() {
  if (busy.deduct) return
  busy.deduct = true
  errorMsg.value = ''
  try {
    await updateDeductConfig(props.workspaceKey, {
      rows: [{ modeFolder: props.bucket.folder, deductValue: deductValue.value === '' ? null : Number(deductValue.value) }],
      confirm: false,
    })
    emit('config-changed')
  } catch (error) {
    errorMsg.value = describeError(error, '扣点保存失败')
  } finally {
    busy.deduct = false
  }
}

async function runMatch() {
  if (busy.match) return
  if (!hasDeductValue.value) {
    errorMsg.value = '请先填写并保存本桶扣点率，再跑本桶匹配'
    return
  }
  busy.match = true
  errorMsg.value = ''
  try {
    await runBucketMatch(props.workspaceKey, props.bucket.folder)
    emit('match-finished')
  } catch (error) {
    errorMsg.value = describeError(error, '本桶匹配失败')
  } finally {
    busy.match = false
  }
}

// 选中文件后:replace 模式先停在「应用内二次确认」(不弹 window.confirm,自动化/真人都能确定性点),
// append 模式直接上传。
async function onFiles(files) {
  const list = Array.from(files || [])
  if (!list.length || busy.upload) return
  if (uploadMode.value === 'replace') {
    pendingFiles.value = list
    return
  }
  await doUpload(list, { replace: false })
}

function confirmReplaceUpload() {
  const list = pendingFiles.value
  pendingFiles.value = []
  if (list.length) doUpload(list, { replace: true })
}

function cancelReplaceUpload() {
  pendingFiles.value = []
}

async function doUpload(list, { replace }) {
  if (!list.length || busy.upload) return
  busy.upload = true
  uploadState.error = ''
  uploadState.success = ''
  uploadState.progress = 0
  try {
    if (replace) {
      await clearBucketBills(props.workspaceKey, props.bucket.folder)
    }
    for (const file of list) {
      uploadState.fileName = file.name
      await uploadImport(props.workspaceKey, 'store-bill', file, {
        bucketFolder: props.bucket.folder,
        onUploadProgress: (event) => {
          uploadState.progress = event.total ? Math.round((event.loaded / event.total) * 100) : 20
        },
      })
    }
    uploadState.success = replace
      ? `已替换本桶账单：${list.length} 个文件`
      : `已追加账单文件：${list.length} 个`
    emit('import-completed')
  } catch (error) {
    uploadState.error = describeError(error, '账单上传失败')
  } finally {
    busy.upload = false
  }
}

async function clearCurrentBucket() {
  if (busy.clear) return
  const ok = window.confirm(`确定删除「${props.bucket.folder}」本桶账单吗？旧匹配结果和旧月度合并结果也会清理，需要重新跑账单匹配和 merge。`)
  if (!ok) return
  busy.clear = true
  errorMsg.value = ''
  uploadState.error = ''
  uploadState.success = ''
  try {
    const result = await clearBucketBills(props.workspaceKey, props.bucket.folder)
    uploadState.success = `已删除本桶账单 ${result.deletedBills || 0} 行，旧月度结果已失效`
    emit('import-completed')
  } catch (error) {
    errorMsg.value = describeError(error, '本桶账单删除失败')
  } finally {
    busy.clear = false
  }
}

function resetUpload() {
  uploadState.error = ''
  uploadState.success = ''
  uploadState.fileName = ''
  uploadState.progress = 0
}
</script>

<template>
  <article class="rounded-lg border border-border bg-card p-4 shadow-sm transition hover:bg-muted/40">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h2 class="truncate text-lg font-medium text-foreground">{{ bucket.folder }}</h2>
          <StatusBadge :variant="status.variant" size="sm" dot>{{ status.label }}</StatusBadge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          模式 <TabularNumber :value="bucket.modeRaws?.length || 0" /> 个 · 账单文件 <TabularNumber :value="bucket.billFiles?.length || 0" /> 个
        </p>
      </div>
      <Button size="sm" :disabled="busy.match || !hasDeductValue" @click="runMatch">
        <Play class="h-4 w-4" />
        {{ busy.match ? '匹配中' : '跑本桶匹配' }}
      </Button>
    </div>

    <div v-if="errorMsg" class="mt-3 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
      {{ errorMsg }}
    </div>

    <div v-if="bucket.filesButNoDetail" class="mt-3 rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
      ⚠️ 有 {{ bucket.billFiles?.length || 0 }} 个导入文件,但账单明细为 0：这些账单已按购买月分流到
      <strong>{{ (bucket.routedWorkspaces && bucket.routedWorkspaces.length) ? bucket.routedWorkspaces.join('、') : '其它月份' }}</strong>
      工作区,当前工作区无这些明细。请切换到对应月份工作区查看。
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_260px]">
      <section class="space-y-3 rounded-md border border-border bg-background p-3">
        <div class="flex items-center justify-between gap-2">
          <Label class="text-xs">扣点率</Label>
          <StatusBadge :variant="hasDeductValue ? 'ok' : 'warn'" size="sm">
            {{ hasDeductValue ? '已填写' : '待填写' }}
          </StatusBadge>
        </div>
        <div class="flex gap-2">
          <Input v-model="deductValue" type="number" step="0.0001" placeholder="0.0000" class="h-9" />
          <Button size="sm" variant="outline" :disabled="busy.deduct" @click="saveDeduct">保存</Button>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-muted-foreground">参加匹配的模式</p>
            <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" :disabled="busy.mode" @click="toggleEditModes">
              {{ editingModes ? '完成' : '编辑' }}
            </Button>
          </div>
          <div v-if="assignedModes.length" class="flex flex-wrap gap-1.5">
            <span
              v-for="mode in assignedModes"
              :key="mode"
              class="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-foreground"
            >
              {{ mode }}
              <button
                v-if="editingModes"
                type="button"
                class="text-muted-foreground hover:text-status-error"
                :disabled="busy.mode"
                title="移出本桶"
                @click="removeMode(mode)"
              >×</button>
            </span>
          </div>
          <p v-else class="text-xs text-muted-foreground">暂无已归类模式</p>

          <div v-if="editingModes" class="flex items-center gap-2 pt-1">
            <select
              v-model="addPick"
              class="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              :disabled="busy.mode || !candidateModes.length"
            >
              <option value="">{{ candidateModes.length ? '选择要加入本桶的模式…' : '无可添加的模式' }}</option>
              <option v-for="m in candidateModes" :key="m" :value="m">{{ m }}</option>
            </select>
            <Button size="sm" variant="outline" class="h-8 px-3 text-xs" :disabled="busy.mode || !addPick" @click="addMode">
              添加
            </Button>
          </div>
          <p v-if="editingModes" class="text-[11px] leading-tight text-muted-foreground">
            候选 = 台账里实际出现的模式;加入后该模式的台账数据进入本桶参加账单匹配。
          </p>
        </div>
      </section>

      <section class="space-y-3 rounded-md border border-border bg-background p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs font-medium text-muted-foreground">账单文件</p>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              :disabled="busy.clear || busy.upload || !bucket.billFiles?.length"
              @click="clearCurrentBucket"
            >
              <Trash2 class="h-4 w-4" />
              {{ busy.clear ? '删除中' : '删除本桶' }}
            </Button>
            <UploadCloud class="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
        <div v-if="bucket.billFiles?.length" class="divide-y divide-border rounded-md border border-border">
          <div v-for="file in bucket.billFiles" :key="`${file.importJobId}-${file.sourceFile}`" class="flex items-center gap-3 px-3 py-2 text-xs">
            <span class="min-w-0 flex-1 truncate text-foreground">{{ file.sourceFile || '未命名文件' }}</span>
            <span class="text-muted-foreground"><TabularNumber :value="Number(file.rows || 0)" /> 行</span>
            <span class="hidden text-muted-foreground sm:inline">{{ file.importedAt || '—' }}</span>
          </div>
        </div>
        <p v-else class="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          还没有导入本桶账单
        </p>

        <div class="rounded-md border border-border bg-muted/30 p-2">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="text-muted-foreground">上传方式</span>
            <Button
              size="sm"
              :variant="uploadMode === 'replace' ? 'default' : 'outline'"
              @click="uploadMode = 'replace'"
            >
              替换本桶
            </Button>
            <Button
              size="sm"
              :variant="uploadMode === 'append' ? 'default' : 'outline'"
              @click="uploadMode = 'append'"
            >
              追加文件
            </Button>
            <span class="text-muted-foreground">
              {{ uploadMode === 'replace' ? '推荐：删除旧账单后再导入' : '只在同桶多文件补充时使用' }}
            </span>
          </div>
        </div>

        <div
          v-if="pendingFiles.length"
          data-testid="replace-confirm"
          class="rounded-md border border-status-warn/40 bg-status-warn/10 p-3 text-xs"
        >
          <p class="text-status-warn">
            将先删除「{{ bucket.folder }}」本桶旧账单、旧匹配结果和旧月度合并结果，再导入
            <TabularNumber :value="pendingFiles.length" /> 个新文件。
          </p>
          <div class="mt-2 flex gap-2">
            <Button size="sm" :disabled="busy.upload" data-testid="replace-confirm-ok" @click="confirmReplaceUpload">
              确认替换并导入
            </Button>
            <Button size="sm" variant="outline" :disabled="busy.upload" @click="cancelReplaceUpload">取消</Button>
          </div>
        </div>

        <FileDropzone
          accept=".xlsx,.xls"
          hint="拖入本桶账单 xlsx"
          multiple
          :uploading="busy.upload"
          :progress="uploadState.progress"
          :file-name="uploadState.fileName"
          :error="uploadState.error"
          :success="uploadState.success"
          @files="onFiles"
          @reset="resetUpload"
        />
      </section>

      <section class="space-y-3 rounded-md border border-border bg-background p-3">
        <p class="text-xs font-medium text-muted-foreground">匹配统计</p>
        <dl class="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt class="text-muted-foreground">账单明细</dt>
            <dd class="mt-1 text-xl font-medium"><TabularNumber :value="billCount" /></dd>
          </div>
          <div>
            <dt class="text-muted-foreground">台账小票</dt>
            <dd class="mt-1 text-xl font-medium"><TabularNumber :value="dailyCount" /></dd>
          </div>
          <div>
            <dt class="text-muted-foreground">命中明细</dt>
            <dd class="mt-1 text-xl font-medium text-status-ok"><TabularNumber :value="receivedBillRows" /></dd>
          </div>
          <div>
            <dt class="text-muted-foreground">未收明细</dt>
            <dd class="mt-1 text-xl font-medium text-status-warn"><TabularNumber :value="unmatchedBillRows" /></dd>
          </div>
        </dl>
        <div class="h-2 rounded-full bg-muted">
          <div class="h-2 rounded-full bg-primary transition-all" :style="{ width: `${matchRateWidth}%` }" />
        </div>
        <p class="text-xs text-muted-foreground">台账匹配率 {{ matchRateLabel }}</p>
        <p class="text-xs text-muted-foreground">台账命中 <TabularNumber :value="matched" /> / <TabularNumber :value="dailyCount" /> 张小票</p>
        <p class="text-xs text-muted-foreground">账单明细覆盖 {{ billCoverageLabel }} · <TabularNumber :value="receivedBillRows" /> / <TabularNumber :value="billCount" /> 行</p>
        <div class="flex flex-wrap gap-2">
          <RouterLink :to="`/monthly/v2/${workspaceKey}/unreceived?folder=${encodeURIComponent(bucket.folder)}`">
            <Button variant="outline" size="sm">去未收清单</Button>
          </RouterLink>
          <RouterLink :to="`/monthly/v2/${workspaceKey}/bill-review?folder=${encodeURIComponent(bucket.folder)}`">
            <Button variant="ghost" size="sm">去账单核对</Button>
          </RouterLink>
        </div>
      </section>
    </div>
  </article>
</template>
