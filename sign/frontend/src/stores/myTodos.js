import { defineStore } from 'pinia'

import { fetchMyTodos } from '../api/my'
import { humanErrorMessage } from '../lib/errorMessage'

export const useMyTodosStore = defineStore('myTodos', {
  state: () => ({
    role: '',
    totalPending: 0,
    stages: [],
    todos: [],
    loading: false,
    loaded: false,
    error: '',
  }),

  getters: {
    hasTodos: (state) => state.todos.length > 0,
    stageCount: (state) => (stageKey) => {
      const entry = state.stages.find((item) => item.stage === stageKey)
      return entry ? entry.count : 0
    },
  },

  actions: {
    async fetch() {
      this.loading = true
      this.error = ''
      try {
        const payload = await fetchMyTodos()
        this.role = payload.role || ''
        this.totalPending = Number(payload.totalPending || 0)
        this.stages = Array.isArray(payload.stages) ? payload.stages : []
        this.todos = Array.isArray(payload.todos) ? payload.todos : []
        this.loaded = true
        return payload
      } catch (error) {
        this.error = humanErrorMessage(error)
        throw error
      } finally {
        this.loading = false
      }
    },
  },
})
