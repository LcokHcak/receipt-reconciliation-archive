<script setup>
// 月度数据导入(灾备 / 历史迁移 / 白盒测试)。
//
// ⚠️ 正常生产流程:台账由 OCR 审核台批次批准后桥接自动写入,团号表绑定到审核批次。
// 本页是后端已保留的灾备/迁移直导端点的 UI 入口(importGroupCode / importDailyReceipt),
// 用于:历史数据迁移、OCR 不可用时的灾备补录、用已核对的样本 xlsx 做白盒对账测试。
// 导入按小票购买日自动入对应月度工作区(daily-receipt 走 splitByPurchaseDate)。
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { DatabaseBackup, GitBranch, FileSpreadsheet, AlertTriangle } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import FileDropzone from '@/components/v2/FileDropzone.vue'
import { uploadImport, fetchImportJobs } from '@/api/v2/imports'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

// 本页只暴露两类灾备直导:团号汇总 + 日度台账(收票)。店家账单走「账单匹配」页分桶导入。
const KINDS = [
  {
    slug: 'group-code',
    icon: GitBranch,
    label: '团号汇总',
    target: 'group_code',
    desc: '团号表 xlsx → group_code,供团号匹配。正常流程在 OCR 审核台建批次时绑定团号表。',
    accept: '.xlsx,.xls',
  },
  {
    slug: 'daily-receipt',
    icon: FileSpreadsheet,
    label: '日度台账(收票汇总)',
    target: 'daily_receipt_export',
    desc: '收票汇总 xlsx → 台账 daily_receipt_export,按购买日自动入对应月度。正常流程台账由 OCR 审核台桥接自动写。',
    accept: '.xlsx,.xls',
  },
]

const state = {}
for (const k of KINDS) {
  state[k.slug] = ref({ busy: false, progress: 0, fileName: '', error: '', success: '' })
}
function s(slug) { return state[slug].value }

const jobs = ref([])
const jobsLoading = ref(false)

function describeError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback
}

async function loadJobs() {
  if (!workspaceKey.value) return
  jobsLoading.value = true
  try {
    const res = await fetchImportJobs(workspaceKey.value, { limit: 30 })
    jobs.value = Array.isArray(res?.jobs) ? res.jobs : []
  } catch {
    jobs.value = []
  } finally {
    jobsLoading.value = false
  }
}

async function onFile(kind, file) {
  const st = s(kind.slug)
  if (!file || st.busy) return
  st.busy = true
  st.error = ''
  st.success = ''
  st.progress = 0
  st.fileName = file.name
  try {
    const payload = await uploadImport(workspaceKey.value, kind.slug, file, {
      onUploadProgress: (e) => {
        st.progress = e.total ? Math.round((e.loaded / e.total) * 100) : 20
      },
    })
    const job = payload?.job || payload || {}
    const inserted = Number(job.rowsInserted ?? job.rows_inserted ?? 0)
    const skipped = Number(job.rowsSkipped ?? job.rows_skipped ?? 0)
    const total = Number(job.rowsTotal ?? job.rows_total ?? 0)
    st.success = `已导入 ${inserted || total} 行${skipped ? `(跳过 ${skipped} 重复)` : ''}`
    // ⭐0729:两类"文件本身可能不完整"的告警,必须盖过"已导入 N 行"的成功感。
    // ① 源文件被 Excel 行数上限截断:生产实测有一次读到 1 048 574 行,而上限是 1 048 576
    //    —— 表是被塞满的,尾巴多半在别人另存为 xlsx 时就被 Excel 切掉了。这种丢失发生在
    //    我们系统之外,我们只能认出来并说出去,否则没人知道账少了一截。
    // ② 流式漏 sheet 被守卫救回:结果是对的,但值得让人知道这个文件结构有问题、
    //    下次最好重新另存一份,免得哪天守卫也兜不住。
    const d = job.details || {}
    const truncated = Array.isArray(d.truncatedAtExcelLimit) ? d.truncatedAtExcelLimit : []
    const recovered = d.recoveredFromStreamSheetLoss || null
    if (truncated.length) {
      st.error = `⚠ 这些表已达 Excel 行数上限(${truncated.join('、')})——`
        + '源文件很可能在导出时就被截断了,导入进来的只是前一百多万行。'
        + '请让对方改用 csv 或分表导出后重新给一份,否则账会少一截。'
    } else if (recovered) {
      st.error = `⚠ 读取时漏掉了 ${(recovered.missing || []).join('、') || '部分'} 表,已自动重读补回。`
        + '数据是完整的,但这个文件结构有问题,建议重新另存一份再用。'
    }
    await loadJobs()
  } catch (error) {
    st.error = describeError(error, `${kind.label}导入失败`)
  } finally {
    st.busy = false
  }
}

function resetKind(slug) {
  const st = s(slug)
  st.error = ''
  st.success = ''
  st.fileName = ''
  st.progress = 0
}

function jobKindLabel(job) {
  const t = job.jobType || job.job_type
  return KINDS.find((k) => k.target === `${t}` || k.slug.replace('-', '_') === t)?.label
    || t || '—'
}
function jobStatusVariant(status) {
  if (status === 'done') return 'ok'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'info'
  return 'warn'
}

onMounted(loadJobs)
watch(workspaceKey, loadJobs)
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex flex-wrap items-start gap-3 px-1">
        <DatabaseBackup class="mt-1 h-6 w-6 text-primary" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-xl font-medium text-foreground">月度数据导入</h1>
            <StatusBadge variant="warn" size="sm">灾备 / 迁移</StatusBadge>
            <StatusBadge v-if="workspaceKey.startsWith('demo-')" variant="test" size="sm">测试模式</StatusBadge>
          </div>
          <p class="text-sm text-muted-foreground">
            团号表 + 日度台账的直接导入入口,按小票购买日自动入对应月度。
          </p>
        </div>
      </header>

      <div class="flex items-start gap-3 rounded-lg border border-status-warn/30 bg-status-warn/5 px-4 py-3">
        <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-status-warn" />
        <div class="text-sm text-foreground">
          <p class="font-medium">正常流程台账走 OCR 审核台(拍照 → 审核 → 批准 → 自动桥接)。</p>
          <p class="mt-1 text-muted-foreground">
            本页仅用于:历史数据迁移、OCR 不可用时灾备补录、用已核对样本 xlsx 做白盒对账测试。
            导入会按购买日自动拆分到对应月度工作区。
          </p>
        </div>
      </div>

      <section class="grid gap-4 lg:grid-cols-2">
        <article
          v-for="kind in KINDS"
          :key="kind.slug"
          class="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div class="flex items-center gap-2">
            <component :is="kind.icon" class="h-5 w-5 text-primary" />
            <h2 class="text-base font-medium text-foreground">{{ kind.label }}</h2>
          </div>
          <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{{ kind.desc }}</p>
          <div class="mt-3">
            <FileDropzone
              :accept="kind.accept"
              :hint="`拖入${kind.label} xlsx`"
              :uploading="s(kind.slug).busy"
              :progress="s(kind.slug).progress"
              :file-name="s(kind.slug).fileName"
              :error="s(kind.slug).error"
              :success="s(kind.slug).success"
              @file="(f) => onFile(kind, f)"
              @reset="resetKind(kind.slug)"
            />
          </div>
        </article>
      </section>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-medium text-foreground">导入历史</h2>
          <button class="text-xs text-muted-foreground hover:text-foreground" :disabled="jobsLoading" @click="loadJobs">刷新</button>
        </div>
        <div v-if="jobs.length" class="mt-3 overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-border text-left text-muted-foreground">
                <th class="py-2 pr-3 font-medium">类型</th>
                <th class="py-2 pr-3 font-medium">文件</th>
                <th class="py-2 pr-3 text-right font-medium">导入</th>
                <th class="py-2 pr-3 text-right font-medium">跳过</th>
                <th class="py-2 pr-3 font-medium">状态</th>
                <th class="py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id" class="border-b border-border/50">
                <td class="py-2 pr-3">{{ jobKindLabel(job) }}</td>
                <td class="max-w-[220px] truncate py-2 pr-3 text-foreground">{{ job.sourceFile || job.source_file || '—' }}</td>
                <td class="py-2 pr-3 text-right"><TabularNumber :value="Number(job.rowsInserted ?? job.rows_inserted ?? 0)" /></td>
                <td class="py-2 pr-3 text-right text-muted-foreground"><TabularNumber :value="Number(job.rowsSkipped ?? job.rows_skipped ?? 0)" /></td>
                <td class="py-2 pr-3">
                  <StatusBadge :variant="jobStatusVariant(job.status)" size="sm">{{ job.status }}</StatusBadge>
                </td>
                <td class="py-2 text-muted-foreground">{{ job.finishedAt || job.finished_at || job.startedAt || job.started_at || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="mt-3 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          本月还没有导入记录
        </p>
      </section>
    </div>
  </AppLayout>
</template>
