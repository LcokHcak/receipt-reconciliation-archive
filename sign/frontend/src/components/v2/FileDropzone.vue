<script setup>
// G1: 通用上传 dropzone — 支持拖拽 / 点选 / 进度 / 错误。
//
// 用法:
//   <FileDropzone accept=".xlsx,.xls" hint="把账单 xlsx 拖到这里"
//                 :uploading="loading" :progress="pct"
//                 :error="err" :success="msg"
//                 @file="onPick" @reset="onReset" />
//
// 父组件接 @file 处理上传 (调 api/v2/imports.js#uploadImport)。
import { computed, ref } from 'vue'
import { UploadCloud, CheckCircle, AlertCircle, X } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'

const props = defineProps({
  accept:     { type: String,  default: '.xlsx,.xls' },
  hint:       { type: String,  default: '把 xlsx 文件拖到这里 (或点击选择)' },
  uploading:  { type: Boolean, default: false },
  progress:   { type: Number,  default: 0 },     // 0..100
  error:      { type: String,  default: '' },
  success:    { type: String,  default: '' },
  fileName:   { type: String,  default: '' },     // 上传中/完成时显示
  disabled:   { type: Boolean, default: false },
  // G12b: 多文件模式 — 4 类账单一次拖
  multiple:   { type: Boolean, default: false },
})
// G12b: multiple 时 emit 'files' (Array); 单文件时 emit 'file'。父组件按需选
const emit = defineEmits(['file', 'files', 'reset'])

const dragOver = ref(false)
const inputEl  = ref(null)

const containerClass = computed(() => {
  if (props.error)    return 'border-status-error/50 bg-status-error/5'
  if (props.success)  return 'border-status-ok/50 bg-status-ok/5'
  if (props.uploading) return 'border-status-info/50 bg-status-info/5'
  if (dragOver.value && !props.disabled) return 'border-primary bg-primary/5'
  return 'border-border bg-card'
})

function openPicker() {
  if (props.disabled || props.uploading) return
  inputEl.value?.click()
}

// G12b: 多文件 helper(单文件旧 handleFile 已被 handleFiles 收编,lint 清理确认删)
function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean)
  if (!files.length) return
  if (props.multiple) emit('files', files)
  else emit('file', files[0])
}

function onInputChange(ev) {
  // 先把 FileList 拷成数组,再清空 input.value(允许同名重传)。
  // 不要先清 value 再读——个别浏览器会把刚拿到的引用一并清空,导致拿到 0 个文件。
  const files = Array.from(ev.target.files || [])
  ev.target.value = ''
  handleFiles(files)
}

function onDrop(ev) {
  ev.preventDefault()
  dragOver.value = false
  if (props.disabled || props.uploading) return
  handleFiles(ev.dataTransfer?.files)
}

function onDragOver(ev) {
  ev.preventDefault()
  if (!props.disabled && !props.uploading) dragOver.value = true
}

function onDragLeave() {
  dragOver.value = false
}

function reset() {
  emit('reset')
}
</script>

<template>
  <div
    :class="['rounded-lg border-2 border-dashed p-5 transition', containerClass,
             disabled || uploading ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary/50']"
    role="button"
    :aria-disabled="disabled || uploading"
    @click="openPicker"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <input ref="inputEl" type="file" class="hidden" :accept="accept" :multiple="multiple" @change="onInputChange">

    <!-- 上传中 -->
    <div v-if="uploading" class="space-y-2">
      <div class="flex items-center gap-2 text-sm text-status-info">
        <UploadCloud class="h-4 w-4 animate-pulse" />
        <span>上传中… <span class="font-mono">{{ fileName || '' }}</span></span>
      </div>
      <div class="h-2 w-full rounded-full bg-muted">
        <div class="h-2 rounded-full bg-status-info transition-all" :style="{ width: `${Math.max(5, progress)}%` }" />
      </div>
      <p class="text-xs text-muted-foreground">{{ Math.round(progress) }}%</p>
    </div>

    <!-- 错误 -->
    <div v-else-if="error" class="space-y-2" @click.stop>
      <div class="flex items-start gap-2 text-sm text-status-error">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="flex-1">{{ error }}</span>
        <Button variant="ghost" size="icon" @click="reset"><X class="h-4 w-4" /></Button>
      </div>
      <p class="text-xs text-muted-foreground">点击 dropzone 重新选文件</p>
    </div>

    <!-- 成功 -->
    <div v-else-if="success" class="space-y-2" @click.stop>
      <div class="flex items-start gap-2 text-sm text-status-ok">
        <CheckCircle class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="flex-1">{{ success }}</span>
        <Button variant="ghost" size="sm" @click="reset">再传一个</Button>
      </div>
    </div>

    <!-- 空闲 -->
    <div v-else class="flex flex-col items-center gap-2 py-3 text-center">
      <UploadCloud class="h-7 w-7 text-muted-foreground" />
      <p class="text-sm text-foreground">{{ hint }}</p>
      <p class="font-mono text-[11px] text-muted-foreground">accept: {{ accept }}</p>
    </div>
  </div>
</template>
