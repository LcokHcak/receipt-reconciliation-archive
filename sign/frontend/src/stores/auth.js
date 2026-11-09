import { defineStore } from 'pinia'

import { fetchCurrentUser, login as loginRequest, logout as logoutRequest } from '../api/auth'
import { humanErrorMessage } from '../lib/errorMessage'

/**
 * 登录失败到底该说什么。
 *
 * 只有一种情况能说"用户名或密码不正确":后端**收到并校验过**凭据、明确判否(401)。
 * 其余每一种都不是用户的密码问题,说成密码错会把人引到完全错误的方向
 * (最典型:被限流锁住时不停换密码试,而每试一次都刷不到新窗口)。
 */
function describeLoginError(error) {
  const status = Number(error?.response?.status || 0)
  const data = error?.response?.data || {}

  // 限流:后端连"还要等多久"都算好了(Retry-After / retryAfter),带上它,
  // 否则人只知道"稍后重试",不知道是等 10 秒还是 10 分钟,还是会继续乱试。
  if (status === 429) {
    const wait = Number(data.retryAfter || error?.response?.headers?.['retry-after'] || 0)
    const base = String(data.error || '登录尝试过多,已暂时锁定')
    // ⚠️ 不要在这里写 markdown 的 **:这句会**原样**显示在登录框的错误条上,
    // 星号会一起显示出来(0801 出报告截图时看见的)。要强调就用标点或措辞。
    return wait > 0
      ? `${base}。请等 ${wait} 秒后再试 —— 锁定期间「即使密码正确也会被拦下」,换密码没有用。`
      : `${base} —— 锁定期间即使密码正确也会被拦下,换密码没有用。`
  }
  // 401:唯一真正"凭据不对"的情况
  if (status === 401) return String(data.error || '用户名或密码不正确')
  // 后端有话就用后端的;没有(断网/服务没起来/网关)走统一的人话口径
  return humanErrorMessage(error, '登录失败')
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    checked: false,
    loading: false,
    error: '',
  }),

  actions: {
    async restoreSession() {
      this.loading = true
      try {
        const payload = await fetchCurrentUser()
        this.user = payload.user
      } catch (_error) {
        this.user = null
      } finally {
        this.checked = true
        this.loading = false
      }
    },

    async login(credentials) {
      this.loading = true
      this.error = ''
      try {
        const payload = await loginRequest(credentials)
        this.user = payload.user
        this.checked = true
        return payload.user
      } catch (error) {
        // 2026-08-01:这里原来是无条件的 `this.error = '用户名或密码不正确'` ——
        // 不看状态码、也不用后端给的话。于是下面这些全被说成"你密码错了":
        //   · 429 被限流锁住(同 IP 60 秒内失败 5 次)——**此时输对密码也进不去**,
        //     请求在 rate_limiter 就被拦掉,根本到不了校验;
        //   · ERR_NETWORK(服务没起来 / 网断)、502/504(网关)、以及登录接口的任何 500。
        // 实际后果:早上手滑输错两三次的人,从第 5 次起进入"密码永远错"的死循环,
        // 于是不停换密码试(每试一次都刷不到新窗口),最后去找管理员重置一个**没坏的密码**。
        // 服务端重启或断网时同理:整组人以为账号坏了,谁也不会去看服务状态。
        // 后端其实准备了「登录尝试过多,请稍后重试」+ Retry-After 秒数,一次都没显示过。
        this.error = describeLoginError(error)
        throw error
      } finally {
        this.loading = false
      }
    },

    async logout() {
      await logoutRequest().catch(() => {})
      this.clearLocalSession()
    },

    clearLocalSession() {
      this.user = null
      this.checked = true
      this.loading = false
      this.error = ''
    },
  },
})
