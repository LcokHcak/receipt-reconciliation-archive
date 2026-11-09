// 配置台深链解析(2026-07-29):代理视图「状态·任务」列头的齿轮带 ?nav=&focus= 跳进来,
// 配置台据此切板块 + 滚到任务设置那一块并高亮。
//
// 单独抽成纯函数的理由:视图里那段是 DOM 副作用(scrollIntoView / 高亮),测不了;
// 但「URL 参数 → 该切到哪、要不要聚焦」是纯判断,必须有一条真的执行它的测试
// (档案 0729:源码字符串断言锁不住"它还能不能跑")。

/**
 * @param {object} query 路由 query(route.query)
 * @param {string[]} navKeys 配置台合法的板块 key 清单(NAV.map(n => n.key))
 * @returns {{ nav: string, focusTasks: boolean }}
 *   nav:''=不切板块(参数缺失或不认识,保持默认,绝不切到一个不存在的板块把页面搞空)
 *   focusTasks:是否要滚到「任务设置」并高亮
 */
export function readConfigDeepLink(query = {}, navKeys = []) {
  const wanted = String(query?.nav ?? '').trim()
  const keys = Array.isArray(navKeys) ? navKeys : []
  return {
    nav: keys.includes(wanted) ? wanted : '',
    focusTasks: String(query?.focus ?? '').trim() === 'tasks',
  }
}
