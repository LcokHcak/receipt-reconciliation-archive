<script setup>
// 已完成批次表(管理员/审核员共用):列按角色开关。
// 2026-07-26 补列(用户需求①):批次|收票员|完成时间|收图|已审|待审|耗时|导出状态|查看
//   收图=批次收到的总张数;已审=审核通过张数;待审=未收尾张数(人工待审+机器没跑完+故障)。
//   已完成批次的待审恒为 0(完成=人工审完+机器不在途),显示 0 是"确认没落下"的正向信号;
//   异常列另算:OCR失败/待重拍不挡完成,但如实列出(2026-07-27 拍板A)。
//   本组件也被别处复用(未完成列表)时该列才会出非零值。
import { computed, ref } from 'vue'

import {
  batchAbnormalCount,
  batchApprovedCount,
  batchCompletedAt,
  batchDurationMs,
  batchOpenWorkCount,
  batchTotalCount,
  exportKindLabel,
  fmtDateTime,
  fmtDuration,
  isBatchCompleted,
  isBatchExported,
} from '../../lib/homeDisplay'

const props = defineProps({
  batches: { type: Array, default: () => [] },
  showOwner: { type: Boolean, default: false },
  // 导出状态列(P1 已点亮):已导出→类型徽标+悬浮时间;未导出→灰字(拍板#3:任一导出即盖章)
  showExport: { type: Boolean, default: false },
  showAction: { type: Boolean, default: false },
  previewCount: { type: Number, default: 5 },
  emptyText: { type: String, default: '暂无已完成批次' },
})

const showAll = ref(false)
const visible = computed(() => (
  showAll.value ? props.batches : props.batches.slice(0, props.previewCount)
))
</script>

<template>
  <div>
    <table v-if="batches.length" class="table blt-table">
      <thead>
        <tr>
          <th>批次</th>
          <th v-if="showOwner">收票员</th>
          <th>完成时间</th>
          <th class="num" title="该批次收到的总张数">收图</th>
          <th class="num" title="审核通过的张数">已审</th>
          <!-- 待审**不含**异常:异常有自己的列,两边都算会让人以为有两拨活 -->
          <th class="num" title="未收尾张数:人工待审 + 机器没跑完(异常另见右侧「异常」列)">待审</th>
          <!-- 2026-07-27 拍板A:异常(OCR失败+待重拍)不再阻止批次进「已完成」,
               但必须单列如实标出——遗留几张一眼可见,去「异常补救」处理,不藏。 -->
          <th class="num" title="遗留异常张数:OCR失败 + 待重拍。不影响本批算完成,去「异常补救」页处理">异常</th>
          <th class="num" title="从建批到最后一次审核,含排队等待时间">耗时</th>
          <th v-if="showExport">导出状态</th>
          <th v-if="showAction" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in visible" :key="b.id || b.batchId">
          <td><strong>{{ b.name || b.id || b.batchId }}</strong></td>
          <td v-if="showOwner">{{ b.ownerUsername || b.createdBy || '—' }}</td>
          <!-- 未完成批次标「进行中」——收票员看板复用本表后必然混入进行中批次。
               2026-08-01:batchCompletedAt 已不再回落 updatedAt/createdAt(那是写盘/建批时间,
               不是谁完成了什么的时刻),零审核动作的批次它返回空 → 这一格自然显「—」。 -->
          <td>
            <template v-if="isBatchCompleted(b)">{{ fmtDateTime(batchCompletedAt(b)) }}</template>
            <span v-else class="blt-inprogress">进行中</span>
          </td>
          <td class="num">{{ batchTotalCount(b) }}</td>
          <td class="num"><span class="count">{{ batchApprovedCount(b) }}</span></td>
          <td class="num">
            <span v-if="batchOpenWorkCount(b) > 0" class="count warning">{{ batchOpenWorkCount(b) }}</span>
            <span v-else class="blt-zero">0</span>
          </td>
          <td class="num">
            <span v-if="batchAbnormalCount(b) > 0" class="count warning" title="OCR失败/待重拍,去「异常补救」处理">{{ batchAbnormalCount(b) }}</span>
            <span v-else class="blt-zero">0</span>
          </td>
          <!-- 耗时=建批→最后审核,只对已完成批次成立;进行中给 — 不给"已用时"充数 -->
          <td class="num">{{ isBatchCompleted(b) ? fmtDuration(batchDurationMs(b)) : '—' }}</td>
          <td v-if="showExport">
            <span
              v-if="isBatchExported(b)"
              class="status success"
              :title="`${exportKindLabel(b.exportKind)} · ${fmtDateTime(b.exportedAt)}${b.exportedBy ? ' · ' + b.exportedBy : ''}`"
            >
              已导出{{ exportKindLabel(b.exportKind) ? `·${exportKindLabel(b.exportKind)}` : '' }}
            </span>
            <span v-else class="status">未导出</span>
          </td>
          <td v-if="showAction" class="blt-action">
            <RouterLink
              class="link-like"
              :to="{ name: 'review', params: { batchId: b.id || b.batchId } }"
            >
              查看
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
    <button
      v-if="batches.length > previewCount"
      type="button"
      class="blt-show-more"
      @click="showAll = !showAll"
    >
      {{ showAll ? '收起' : `显示全部 ${batches.length} 个` }}
    </button>
    <div v-if="!batches.length" class="empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.blt-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.blt-zero { color: var(--muted, #9ca3af); }
.blt-inprogress { color: var(--muted, #9ca3af); }
.blt-action { text-align: right; }
.blt-show-more {
  display: block;
  width: 100%;
  padding: 8px 0;
  margin-top: 2px;
  border: none;
  background: transparent;
  color: var(--accent, #2563eb);
  font-size: 13px;
  cursor: pointer;
}
.blt-show-more:hover { background: var(--surface-soft, #f1f5f9); border-radius: 6px; }
</style>
