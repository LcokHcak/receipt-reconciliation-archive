<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import api from '@/api/client'

// 数据集编号 ↔ 模型/格式说明(对应 AI Studio JINHAIMIN/1~6)
const DATASETS = [
  { key: '1_mix_det', repo: '1', name: '混合图切图', model: '目标检测', fmt: 'COCO' },
  { key: '2_cls', repo: '2', name: '文档分类', model: '图像分类', fmt: 'cls' },
  { key: '3_passport_det', repo: '3', name: '护照字段定位', model: '目标检测(弱标注)', fmt: 'COCO' },
  { key: '4_passport_rec', repo: '4', name: '护照文本识别', model: 'OCR rec', fmt: 'mstextrec' },
  { key: '5_receipt_det', repo: '5', name: '小票字段定位', model: '目标检测(弱标注)', fmt: 'COCO' },
  { key: '6_receipt_rec', repo: '6', name: '小票文本识别', model: 'OCR rec', fmt: 'mstextrec' },
]

const status = ref(null)
const loading = ref(false)
const errorMsg = ref('')
const actionMsg = ref('')
let timer = null

const latestBuild = computed(() => status.value?.builds?.[0] || null)
const exportJob = computed(() => status.value?.jobs?.export || { status: 'idle' })
const uploadJob = computed(() => status.value?.jobs?.upload || { status: 'idle' })
const busy = computed(() => exportJob.value.status === 'running' || uploadJob.value.status === 'running')

function dsStat(key) {
  const d = latestBuild.value?.summary?.datasets?.[key]
  if (!d) return null
  const train = Number(d.train || 0)
  const val = Number(d.val || 0)
  return { train, val, total: train + val, corrections: d.corrections, corrected: d.corrected }
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    status.value = await api.get('/admin/training/status')
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function runExport() {
  actionMsg.value = ''
  try {
    await api.post('/admin/training/export', {})
    actionMsg.value = '导出已启动,构建完成后下方状态会更新'
  } catch (error) {
    actionMsg.value = error?.response?.data?.error || error?.message || '导出启动失败'
  }
  await load()
}

async function runUpload() {
  actionMsg.value = ''
  if (!window.confirm('把最新构建上传到 AI Studio 数据集(JINHAIMIN/1~6)?')) return
  try {
    await api.post('/admin/training/upload', {})
    actionMsg.value = '上传已启动'
  } catch (error) {
    actionMsg.value = error?.response?.data?.error || error?.message || '上传启动失败'
  }
  await load()
}

onMounted(() => {
  load()
  timer = setInterval(() => {
    if (busy.value) load()
  }, 4000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

function jobVariant(job) {
  if (job.status === 'running') return 'info'
  if (job.status === 'succeeded') return 'ok'
  if (job.status === 'failed') return 'error'
  return 'muted'
}
function jobLabel(job) {
  return { idle: '空闲', running: '进行中', succeeded: '成功', failed: '失败' }[job.status] || job.status
}
</script>

<template>
  <AppLayout>
    <div class="space-y-4">
      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 class="text-2xl font-medium text-foreground">模型训练数据</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              把人工审核确认过的数据(分类纠正/字段金标/切图框)构建成飞桨数据集并上传到 AI Studio,用于持续优化 6 个模型。
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button :disabled="exportJob.status === 'running'" @click="runExport">
              {{ exportJob.status === 'running' ? '导出中…' : '① 导出数据集' }}
            </Button>
            <Button
              variant="outline"
              :disabled="uploadJob.status === 'running' || !latestBuild"
              @click="runUpload"
            >
              {{ uploadJob.status === 'running' ? '上传中…' : '② 上传到飞桨' }}
            </Button>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge :variant="jobVariant(exportJob)" size="sm">导出:{{ jobLabel(exportJob) }}</StatusBadge>
          <StatusBadge :variant="jobVariant(uploadJob)" size="sm">上传:{{ jobLabel(uploadJob) }}</StatusBadge>
          <StatusBadge v-if="status && !status.tokenConfigured" variant="warn" size="sm">
            AISTUDIO_TOKEN 未配置(.env),上传不可用
          </StatusBadge>
          <span v-if="latestBuild" class="text-muted-foreground">最近构建:{{ latestBuild.dir }}</span>
        </div>
        <p v-if="actionMsg" class="mt-2 text-sm text-status-info">{{ actionMsg }}</p>
        <p v-if="errorMsg" class="mt-2 text-sm text-status-error">{{ errorMsg }}</p>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="ds in DATASETS"
          :key="ds.key"
          class="rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <h2 class="font-medium text-foreground">{{ ds.repo }}. {{ ds.name }}</h2>
            <StatusBadge variant="muted" size="sm">{{ ds.fmt }}</StatusBadge>
          </div>
          <p class="mt-1 text-xs text-muted-foreground">{{ ds.model }} · JINHAIMIN/{{ ds.repo }}</p>
          <div v-if="dsStat(ds.key)" class="mt-3 text-sm">
            <span class="text-2xl font-medium tabular-nums">{{ dsStat(ds.key).total }}</span>
            <span class="ml-1 text-muted-foreground">样本(train {{ dsStat(ds.key).train }} / val {{ dsStat(ds.key).val }})</span>
            <p v-if="dsStat(ds.key).corrections" class="mt-1 text-xs text-status-warn">
              {{ dsStat(ds.key).corrections }} 条 OCR≠金标待人工复核(_corrections_review.tsv)
            </p>
            <p v-if="dsStat(ds.key).corrected" class="mt-1 text-xs text-status-info">
              含 {{ dsStat(ds.key).corrected }} 条人工纠错难例
            </p>
          </div>
          <p v-else class="mt-3 text-sm text-muted-foreground">尚无构建数据</p>
        </div>
      </section>

      <section v-if="uploadJob.log || exportJob.log" class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 class="mb-2 font-medium text-foreground">任务日志(尾部)</h2>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-3 text-xs">{{ (uploadJob.status !== 'idle' ? uploadJob.log : exportJob.log) || '(空)' }}</pre>
      </section>
    </div>
  </AppLayout>
</template>
