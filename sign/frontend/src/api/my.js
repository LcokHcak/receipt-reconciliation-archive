import api from './client'

export function fetchMyTodos() {
  return api.get('/my/todos')
}
