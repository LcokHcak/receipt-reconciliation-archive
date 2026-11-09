import assert from 'node:assert/strict'
import test from 'node:test'

import { handleApiError, handleApiResponse } from '../interceptor.js'

function createRouter(route = {}) {
  const pushes = []
  return {
    pushes,
    currentRoute: {
      value: {
        name: route.name || 'workbench',
        fullPath: route.fullPath || '/review/batch-1?group=g-1',
      },
    },
    async push(location) {
      pushes.push(location)
    },
  }
}

test('401 response clears local session and redirects to login with redirect query', async () => {
  const router = createRouter()
  let clearCalls = 0
  const error = {
    response: {
      status: 401,
      data: { code: 'AUTH_REQUIRED', requestId: 'req-401' },
    },
  }

  await assert.rejects(
    () => handleApiError(error, {
      router,
      getAuthStore: async () => ({
        clearLocalSession() {
          clearCalls += 1
        },
      }),
      consoleError: () => {},
    }),
    (rejected) => rejected === error,
  )

  assert.equal(clearCalls, 1)
  assert.deepEqual(router.pushes, [
    { name: 'login', query: { redirect: '/review/batch-1?group=g-1' } },
  ])
  assert.equal(error.code, 'AUTH_REQUIRED')
  assert.equal(error.requestId, 'req-401')
})

test('401 response on login route clears local session without pushing again', async () => {
  const router = createRouter({ name: 'login', fullPath: '/login?redirect=%2F' })
  let clearCalls = 0
  const error = {
    response: {
      status: 401,
      data: { code: 'AUTH_REQUIRED', requestId: 'req-login' },
    },
  }

  await assert.rejects(
    () => handleApiError(error, {
      router,
      getAuthStore: async () => ({
        clearLocalSession() {
          clearCalls += 1
        },
      }),
      consoleError: () => {},
    }),
    (rejected) => rejected === error,
  )

  assert.equal(clearCalls, 1)
  assert.deepEqual(router.pushes, [])
})

test('5xx response exposes code and requestId and reports the server error', async () => {
  const reports = []
  const error = {
    response: {
      status: 503,
      data: { code: 'UPSTREAM_TIMEOUT', requestId: 'req-503' },
    },
  }

  await assert.rejects(
    () => handleApiError(error, {
      router: createRouter(),
      getAuthStore: async () => ({ clearLocalSession() {} }),
      consoleError: (...args) => reports.push(args),
    }),
    (rejected) => rejected === error,
  )

  assert.equal(error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(error.requestId, 'req-503')
  assert.equal(reports.length, 1)
})

test('200 response returns response data without rejecting', () => {
  const response = {
    data: { ok: true },
    headers: { 'x-request-id': 'req-200' },
  }

  assert.deepEqual(handleApiResponse(response), { ok: true })
})
