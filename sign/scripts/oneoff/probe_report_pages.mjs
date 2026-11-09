/**
 * 一次性:探测各主功能页真正请求了哪些后端接口。
 *
 * 为什么要探:给报告截图造 mock 数据时,靠读源码猜接口路径不可靠 ——
 * 少写一个尾部通配、或漏掉一个"必须先回来才会发下一个请求"的前置接口,
 * 页面就会静默渲染成空壳/被路由守卫踢回登录页。直接问浏览器最准。
 *
 * 用法:vite preview 跑在 5177 上,然后 node scripts/oneoff/probe_report_pages.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SHOT_BASE_URL || 'http://127.0.0.1:5177/app/dist';
const WS = 'demo-2026-07';

const PAGES = [
  ['首页工作台', '/'],
  ['收票建档', '/intake'],
  ['审核台', '/review/demo-batch-01'],
  ['代理工作台', '/agents'],
  ['收票台账', `/monthly/v2/${WS}/ledger`],
  ['账单匹配', `/monthly/v2/${WS}/bill-match`],
  ['未收清单', `/monthly/v2/${WS}/unreceived`],
  ['月度导入', `/monthly/v2/${WS}/imports`],
  ['交付核对', `/monthly/v2/${WS}/delivery-check`],
  ['配置台', '/admin/config'],
  ['审计日志', '/admin/logs'],
  ['用户管理', '/admin/users'],
];

const json = (body) => ({ contentType: 'application/json', body: JSON.stringify(body) });

(async () => {
  const browser = await chromium.launch();
  for (const [label, route] of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const seen = new Set();
    page.on('request', (r) => {
      const u = r.url();
      const m = u.match(/\/api\/.*/);
      if (m) seen.add(`${r.method()} ${m[0].split('?')[0]}${u.includes('?') ? '?…' : ''}`);
    });
    // 兜底:所有 /api/ 一律回空对象,避免 401 把人踢回登录页
    await page.route(/:\d+\/api\//, (r) => r.fulfill(json({})));
    await page.route('**/api/auth/me', (r) => r.fulfill(json({ user: { username: 'admin', role: 'admin' } })));
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
    } catch { /* networkidle 超时不影响已捕获的请求 */ }
    await page.waitForTimeout(1200);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 110);
    console.log(`\n── ${label}  ${route}`);
    console.log(`   页面文字:${text}`);
    for (const s of [...seen].sort()) console.log(`   · ${s}`);
    await page.close();
  }
  await browser.close();
})();
