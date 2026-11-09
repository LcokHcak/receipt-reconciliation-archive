export const allowV2MockFallback =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_V2_MOCK_FALLBACK === 'true'

export const v2MockFallbackLabel = allowV2MockFallback ? 'mock 回退' : '接口失败'

export const v2MockFallbackVariant = allowV2MockFallback ? 'warn' : 'error'
