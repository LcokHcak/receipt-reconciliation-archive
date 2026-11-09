// 门店码 → 店名映射的"生效边界"提醒(2026-08-01)。
//
// 边界本身是有意留的:配置台的门店码清单只喂**审核台点选与店名提示**;
// 台账/交付包的码→店名映射运行时仍读 lib/store_profiles 的出厂表
// (见 routes/config_console_routes.js 的 effectiveBranchOptions 上方注释)。
//
// 问题不在边界,在**告知时机**。配置台页面上确实写了一段"生效边界"说明,
// 但那是静态文字,没人会逐字读。管理员加了「0999 江南」,审核台点得到,
// 月底出交付包才发现夹名是「0999」—— 那时包已经发出去了。
//
// 所以在**保存那一刻**把这次真正会掉链子的码点出来。抽成纯函数是为了能真测:
// 之前把这段逻辑写在组件里,测试只能扫源码文本,把计算改坏了也照样绿。

/**
 * 找出"出厂表里没有、因而在台账/交付包里只会显示码本身"的那些码。
 * @param {Array<{code?: string}>} options 配置台这次要保存的清单
 * @param {Record<string, string>} factoryNames 出厂表 code→店名
 * @returns {string[]} 未映射的码(去重、保持输入顺序)
 */
export function unmappedBranchCodes(options = [], factoryNames = {}) {
  const names = factoryNames && typeof factoryNames === 'object' ? factoryNames : {};
  const seen = new Set();
  const out = [];
  for (const o of Array.isArray(options) ? options : []) {
    const code = String(o?.code ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    // 出厂表里有名字才算"映射到了";空字符串的名字等于没有(交付包还是只能显示码)
    if (!String(names[code] || '').trim()) out.push(code);
  }
  return out;
}

/** 保存成功后的提示语:有未映射的码就点名 + 说清后果,没有就不添噪音。 */
export function branchSaveMessage(unmapped = []) {
  const base = '门店码清单已保存,审核台点选即刻生效';
  if (!unmapped.length) return base;
  return `${base}。⚠️ ${unmapped.join('、')} 不在出厂表里——`
    + '台账/交付包里这几个码会按码原样显示(不会显示你填的店名),要让店名也生效需要改代码。';
}
