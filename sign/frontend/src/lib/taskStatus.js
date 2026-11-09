import { PROCESS_RESULT } from './statusLabels.js'
import { isTaskApproved } from './reviewDisplay.js'

const STATUS_MAP = {
  rephoto: { label: '需重拍', tone: 'danger' },
  approved: { label: '已通过', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'danger' },
  waiting_ocr: { label: '等待识别', tone: 'neutral' },
  recognizing: { label: '识别中', tone: 'warning' },
  ocr_error: { label: '识别失败', tone: 'danger' },
  pending_confirm: { label: '待确认', tone: 'warning' },
  pending_other: { label: '待处理', tone: 'neutral' },
}

// "算不算通过"单一判定源=reviewDisplay.isTaskApproved(2026-07-13 架构体检:
// 徽章与队列曾各写一套,processResult='approved' 时一边认一边不认——契约测试④抓的现行)。
function isApproved(task) {
  return isTaskApproved(task)
}

function isRejected(task) {
  return task.reviewStatus === PROCESS_RESULT.REJECTED || task.processResult === PROCESS_RESULT.REJECTED
}

export function getTaskStatusState(task = {}) {
  const t = task || {}
  if (t.rephotoRequested) return STATUS_MAP.rephoto
  if (isApproved(t)) return STATUS_MAP.approved
  if (isRejected(t)) return STATUS_MAP.rejected

  const machineState = String(t.machineState || '').trim()
  if (machineState === 'queued') return STATUS_MAP.waiting_ocr
  if (machineState === 'processing') return STATUS_MAP.recognizing
  if (machineState === 'error') return STATUS_MAP.ocr_error
  if (machineState === 'completed' || t.workflowState || t.processResult) {
    return STATUS_MAP.pending_confirm
  }

  return STATUS_MAP.pending_other
}
