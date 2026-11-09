const LAST_REQUEST_ID_KEY = 'lastRequestId'

function getDefaultStorage() {
  try {
    return globalThis.sessionStorage || null
  } catch {
    return null
  }
}

function readHeader(headers, name) {
  if (!headers) return undefined
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()]
}

function rememberLastRequestId(requestId, storage = getDefaultStorage()) {
  if (!requestId || !storage) return
  try {
    storage.setItem(LAST_REQUEST_ID_KEY, requestId)
  } catch {
    // Best effort only; API handling should not fail because storage is blocked.
  }
}

function getResponseRequestId(response) {
  return response?.data?.requestId || readHeader(response?.headers, 'x-request-id')
}

export function enrichApiError(error) {
  const data = error.response?.data || {}
  const code = data.code
  const requestId = data.requestId || readHeader(error.response?.headers, 'x-request-id')
  error.code = code
  error.requestId = requestId
  return {
    status: error.response?.status,
    code,
    requestId,
  }
}

export function handleApiResponse(response, options = {}) {
  rememberLastRequestId(getResponseRequestId(response), options.storage)
  return response.data
}

export async function handleApiError(error, options = {}) {
  const {
    router,
    getAuthStore,
    snapshotDraft,
    consoleError = console.error,
    storage,
  } = options
  const { status, code, requestId } = enrichApiError(error)
  rememberLastRequestId(requestId, storage)

  if (status === 401) {
    if (typeof snapshotDraft === 'function') {
      snapshotDraft(error)
    }
    if (typeof getAuthStore === 'function') {
      const authStore = await getAuthStore()
      authStore?.clearLocalSession?.()
    }
    const currentRoute = router?.currentRoute?.value
    if (currentRoute?.name !== 'login' && typeof router?.push === 'function') {
      await router.push({
        name: 'login',
        query: { redirect: currentRoute?.fullPath || '/' },
      })
    }
  }

  if (status >= 500 && status < 600) {
    consoleError('API server error', { status, code, requestId, error })
  }

  return Promise.reject(error)
}
