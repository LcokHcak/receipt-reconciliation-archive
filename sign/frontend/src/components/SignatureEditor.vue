<script setup>
import { computed } from 'vue'

const props = defineProps({
  task: {
    type: Object,
    default: null,
  },
})

const hasSignature = computed(() => Boolean(props.task?.finalSignatureUrl || props.task?.finalSignaturePath))
const isBusy = computed(() => ['queued', 'generating'].includes(props.task?.signatureJobStatus))
</script>

<template>
  <section class="signature-display">
    <div class="signature-display-head">
      <strong>签字展示</strong>
      <span class="status" :class="{ success: hasSignature, warning: isBusy }">
        {{ hasSignature ? '已生成' : (task?.signatureJobStatus || '待生成') }}
      </span>
    </div>
    <div class="signature-display-box">
      <img v-if="task?.finalSignatureUrl" class="signature-preview" :src="task.finalSignatureUrl" alt="">
      <span v-else class="signature-name-preview">{{ task?.chineseNameFinal || '待识别姓名' }}</span>
    </div>
    <div class="signature-display-foot">
      <p class="muted">护照确认后自动按当前中文签名展示生成。</p>
      <p v-if="task?.signatureJobError" class="error-text">{{ task.signatureJobError }}</p>
    </div>
  </section>
</template>
