import { reactive } from 'vue'

const state = reactive({
  open: false,
  rowId: null,
})

export function useRowHistory() {
  function openRowHistory(rowId) {
    if (!rowId) return
    state.rowId = rowId
    state.open = true
  }

  function closeRowHistory() {
    state.open = false
  }

  return {
    rowHistoryState: state,
    openRowHistory,
    closeRowHistory,
  }
}
