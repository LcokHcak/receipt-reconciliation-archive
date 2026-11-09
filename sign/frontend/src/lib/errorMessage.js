// 前端错误文案的单一出口(2026-08-01)。
//
// 病灶:全站十几处都写成 `error.response?.data?.error || error.message`。
// 后端给了中文就用中文 —— 这一半是对的;可**后端没来得及回话的那一半**(断网、超时、
// 服务没起来、被网关掐断)根本没有 response.data.error,于是直接把 axios 的英文吐出来:
//   Network Error / timeout of 30000ms exceeded / Request failed with status code 502
// 用户截图里满屏的就是这些。而这恰恰是**最常见**的一类失败 —— 真出问题的时候,
// 界面反而说的是最看不懂的话。
//
// 这里只做一件事:后端有中文就原样用;没有,就按错误形态给一句人话 + 一句"下一步做什么"。
// 不吞错误、不改语义:认不出的形态仍旧把原文带出来(附在括号里),排查时不丢信息。

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);

function statusHint(status) {
  if (status === 401) return '登录已过期,请重新登录';
  if (status === 403) return '这个操作你的账号没有权限';
  if (status === 404) return '要找的东西不在了(可能已被删除或换了批次)';
  if (status === 409) return '和别人的操作撞上了,刷新一下再试';
  if (status === 413) return '文件太大,服务器拒收';
  if (status === 429) return '操作太频繁,稍等一下再点';
  if (status === 502 || status === 503 || status === 504) {
    return '服务器暂时没响应(可能正在重启或负载高),等十几秒再试一次';
  }
  if (status >= 500) return '服务器出错了,请把这一步告诉管理员';
  return '';
}

/**
 * @param {*} error axios 错误(或任意 Error)
 * @param {string} fallback 认不出时的兜底主语,比如「保存失败」
 */
export function humanErrorMessage(error, fallback = '操作失败') {
  // ① 后端明确回话:原样用(它已经是中文的业务话)
  const fromServer = error?.response?.data?.error;
  if (fromServer) return String(fromServer);

  const raw = String(error?.message || '').trim();
  const status = Number(error?.response?.status || 0);

  // ② 有 HTTP 状态但没有 body:按状态说人话
  if (status) {
    const hint = statusHint(status);
    if (hint) return `${fallback}:${hint}`;
    return `${fallback}(服务器返回 ${status})`;
  }

  // ③ 压根没连上/没等到:这是最常见、也最该说人话的一类
  const code = String(error?.code || '');
  if (TIMEOUT_CODES.has(code) || /timeout of \d+ms exceeded/i.test(raw)) {
    // ⚠️ 超时不等于"没做":服务端可能已经处理完只是回话慢,别催人无脑重试
    return `${fallback}:等服务器回话超时了。它可能已经处理完只是回话慢 —— 先刷新看看结果,别直接重试`;
  }
  if (code === 'ERR_NETWORK' || /network error/i.test(raw)) {
    return `${fallback}:连不上服务器。先看看网络,或者服务是不是没起来`;
  }
  if (/canceled|aborted/i.test(raw)) return `${fallback}:请求被中断了(可能是切换了页面),重试即可`;

  // ④ 认不出:兜底话 + 原文(不丢排查信息)
  return raw ? `${fallback}(${raw})` : fallback;
}
