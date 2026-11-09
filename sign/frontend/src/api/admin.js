import api from './client'

export function fetchAdminDashboard() {
  return api.get('/admin/dashboard')
}

export function fetchAdminLogs(params = {}) {
  return api.get('/admin/logs', { params })
}

export function fetchAdminFeedback(params = {}) {
  return api.get('/admin/feedback', { params })
}

export function resolveAdminFeedback(id, resolution = '') {
  return api.post(`/admin/feedback/${id}/resolve`, { resolution })
}

export function submitFeedback(payload) {
  return api.post('/feedback', payload)
}
