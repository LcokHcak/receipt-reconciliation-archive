<script setup>
// P1-1: 工作区级「确认配置 + 复制上月」。扣点表 / 模式归类两项是 merge 的前置门槛
// (services/monthly/mode_config_service.js#validateMergeReady)。本组件把后端已有的
// confirm / copy-from-previous 能力暴露到账单匹配页,操作员一处即可完成确认。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { CheckCircle2, Copy } from 'lucide-vue-next'

import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import {
  fetchDeductConfig,
  updateDeductConfig,
  copyDeductFromPrevious,
  fetchModeMapping,
  updateModeMapping,
  copyModeMappingFromPrevious,
} from '@/api/v2/setup'

const props = defineProps({
  workspaceKey: { type: String, required: true },
})
const emit = defineEmits(['changed'])

const deduct = ref(null)   // { confirmed_at, rows:[{mode_folder, deduct_value}] }
const mapping = ref(null)  // { confirmed_at, unmapped:[...] }
const loading = ref(false)
const errorMsg = ref('')
const busy = reactive({ deductConfirm: false, deductCopy: false, modeConfirm: false, modeCopy: false })

const unmappedCount = computed(() => (mapping.value?.unmapped || []).length)
const missingDeduct = computed(() =>
  (deduct.value?.rows || []).filter((r) => r.deduct_value == null).map((r) => r.mode_folder),
)
// 「已确认」必须同时满足:有 confirmed_at 且当前没有未决项。否则导入新台账带出新 raw mode /
// 新桶缺扣点后,旧的 confirmed_at 会让 UI 误显示「已确认」,与接口实际状态不一致(与 merge 门槛一致)。
const deductConfirmed = computed(() => Boolean(deduct.value?.confirmed_at) && missingDeduct.value.length === 0)
const modeConfirmed = computed(() => Boolean(mapping.value?.confirmed_at) && unmappedCount.value === 0)
const allReady = computed(() => deductConfirmed.value && modeConfirmed.value)

function describeError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback
}

async function load() {
  if (!props.workspaceKey) return
  loading.value = true
  errorMsg.value = ''
  try {
    const [d, m] = await Promise.all([
      fetchDeductConfig(props.workspaceKey),
      fetchModeMapping(props.workspaceKey),
    ])
    deduct.value = d
    mapping.value = m
  } catch (error) {
    errorMsg.value = describeError(error, '配置状态加载失败')
  } finally {
    loading.value = false
  }
}

async function confirmDeduct() {
  if (busy.deductConfirm) return
  busy.deductConfirm = true
  errorMsg.value = ''
  try {
    // 回传当前所有已填扣点 + confirm:true;后端校验四桶齐全才置 confirmed_at
    const rows = (deduct.value?.rows || []).map((r) => ({
      modeFolder: r.mode_folder,
      deductValue: r.deduct_value,
    }))
    deduct.value = await updateDeductConfig(props.workspaceKey, { rows, confirm: true })
    emit('changed')
  } catch (error) {
    errorMsg.value = describeError(error, '确认扣点配置失败')
  } finally {
    busy.deductConfirm = false
  }
}

async function copyDeduct() {
  if (busy.deductCopy) return
  busy.deductCopy = true
  errorMsg.value = ''
  try {
    deduct.value = await copyDeductFromPrevious(props.workspaceKey)
    emit('changed')
  } catch (error) {
    errorMsg.value = describeError(error, '复制上月扣点失败')
  } finally {
    busy.deductCopy = false
  }
}

async function confirmMode() {
  if (busy.modeConfirm) return
  busy.modeConfirm = true
  errorMsg.value = ''
  try {
    // 空 mappings + confirm:true:不改归类,仅在无未归类模式时置 confirmed_at
    mapping.value = await updateModeMapping(props.workspaceKey, { mappings: [], confirm: true })
    emit('changed')
  } catch (error) {
    errorMsg.value = describeError(error, '确认模式归类失败')
  } finally {
    busy.modeConfirm = false
  }
}

async function copyMode() {
  if (busy.modeCopy) return
  busy.modeCopy = true
  errorMsg.value = ''
  try {
    mapping.value = await copyModeMappingFromPrevious(props.workspaceKey)
    emit('changed')
  } catch (error) {
    errorMsg.value = describeError(error, '复制上月归类失败')
  } finally {
    busy.modeCopy = false
  }
}

defineExpose({ reload: load })
onMounted(load)
watch(() => props.workspaceKey, load)
</script>

<template>
  <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <CheckCircle2 class="h-5 w-5" :class="allReady ? 'text-status-ok' : 'text-muted-foreground'" />
        <h2 class="text-sm font-medium text-foreground">合并前置配置</h2>
        <StatusBadge :variant="allReady ? 'ok' : 'warn'" size="sm" dot>
          {{ allReady ? '可出报表' : '待确认' }}
        </StatusBadge>
      </div>
      <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
    </div>

    <p v-if="errorMsg" class="mt-3 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
      {{ errorMsg }}
    </p>

    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <!-- 扣点表 -->
      <div class="rounded-md border border-border bg-background p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-foreground">扣点表</span>
          <StatusBadge :variant="deductConfirmed ? 'ok' : 'warn'" size="sm">
            {{ deductConfirmed ? '已确认' : '待确认' }}
          </StatusBadge>
        </div>
        <p v-if="missingDeduct.length" class="mt-2 text-[11px] leading-tight text-status-warn">
          未填写:{{ missingDeduct.join('、') }}
        </p>
        <p v-else class="mt-2 text-[11px] leading-tight text-muted-foreground">四桶扣点已齐全</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            :disabled="busy.deductConfirm || missingDeduct.length > 0"
            @click="confirmDeduct"
          >
            {{ busy.deductConfirm ? '确认中' : '确认扣点配置' }}
          </Button>
          <Button variant="outline" size="sm" :disabled="busy.deductCopy" @click="copyDeduct">
            <Copy class="h-4 w-4" />
            {{ busy.deductCopy ? '复制中' : '复制上月扣点' }}
          </Button>
        </div>
      </div>

      <!-- 模式归类 -->
      <div class="rounded-md border border-border bg-background p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-foreground">模式归类</span>
          <StatusBadge :variant="modeConfirmed ? 'ok' : 'warn'" size="sm">
            {{ modeConfirmed ? '已确认' : '待确认' }}
          </StatusBadge>
        </div>
        <p v-if="unmappedCount" class="mt-2 text-[11px] leading-tight text-status-warn">
          仍有 <TabularNumber :value="unmappedCount" /> 个模式未归类
        </p>
        <p v-else class="mt-2 text-[11px] leading-tight text-muted-foreground">台账模式已全部归类</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            :disabled="busy.modeConfirm || unmappedCount > 0"
            @click="confirmMode"
          >
            {{ busy.modeConfirm ? '确认中' : '确认模式归类' }}
          </Button>
          <Button variant="outline" size="sm" :disabled="busy.modeCopy" @click="copyMode">
            <Copy class="h-4 w-4" />
            {{ busy.modeCopy ? '复制中' : '复制上月归类' }}
          </Button>
        </div>
      </div>
    </div>
  </section>
</template>
