import api from './client'

export function login(credentials) {
  return api.post('/auth/login', credentials)
}

export function logout() {
  return api.post('/auth/logout')
}

export function fetchCurrentUser() {
  return api.get('/auth/me')
}

export function refreshToken() {
  return api.post('/auth/refresh')
}
