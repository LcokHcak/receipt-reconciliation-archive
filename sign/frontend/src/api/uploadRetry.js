// 上传自动重试(2026-07-08):瞬断导致的 Network Error 自动重试,用户无感。
// 病例:①部署重启窗口(~25s,Caddy 502 connection refused);②主线程拥堵时
// node 掐 keep-alive 连接(08:37 小票06 四张上传失败,Caddy 报 use of closed
// network connection)。两类都是"请求根本没被服务端处理",重发安全。
//
// 铁律——只重试「确定没被处理」的失败形态:
//   ERR_NETWORK   浏览器层失败,无 HTTP 响应(连接被掐/连不上)
//   502/503/504   Caddy 报后端不可达(部署窗口 connection refused)
// 绝不重试:
//   ECONNABORTED  超时——服务端可能仍在处理,重发 = 重复建客户/重复图片
//   4xx           业务拒绝(校验/权限/重复),重试无意义
//   500           业务代码异常,重试只会再炸一次
// 已知残余风险:502 里极小概率"服务端已处理完但响应没送达"(EOF 形态),
// 重试会造重复客户——操作员可见可删,代价远小于上传静默失败让人重选重传。
//
// makeRequest 必须是**工厂**(每次调用重建请求含 FormData),不复用请求对象。

const DEFAULT_RETRY_DELAYS_MS = [2000, 6000]

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export function isTransientUploadError(error) {
  if (error?.code === 'ERR_NETWORK') return true
  const status = error?.response?.status
  return status === 502 || status === 503 || status === 504
}

export async function postWithRetry(makeRequest, { delaysMs = DEFAULT_RETRY_DELAYS_MS, sleep = defaultSleep } = {}) {
  let lastError
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await makeRequest()
    } catch (error) {
      lastError = error
      if (attempt >= delaysMs.length || !isTransientUploadError(error)) {
        throw error
      }
      await sleep(delaysMs[attempt])
    }
  }
  throw lastError
}
