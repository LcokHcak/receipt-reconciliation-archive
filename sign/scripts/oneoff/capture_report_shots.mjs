/**
 * 一次性:为 0801 交付报告采集界面截图。
 *
 * 做法与 frontend/e2e 的 spec 一致 —— 用 playwright 的 route mock 顶掉后端接口,
 * 喂进能体现"改动后的样子"的数据,再截图存盘。
 * 这样做的三个理由:
 *   ① 不需要输密码(mock 掉 /api/auth/me);
 *   ② 不依赖本地库有没有数据(本地月度/账单是 0 行,真跑只能截出空白页);
 *   ③ 数据可控 —— 可以精确造出"合计是全量 vs 只算一页"这种要对比的场景。
 *
 * 截的是**真实前端产物**(vite preview 的 /app/dist),不是设计稿。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'tmp_report_shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.SHOT_BASE_URL || 'http://127.0.0.1:5177/app/dist';
const WS = 'demo-2026-07';

const shots = [];

/**
 * 截图前必须先确认页面上真有该出现的内容。
 * 没有这道自检就会拍到"登录页"或"全 0 的空壳",而那种图放进报告
 * 比不放更糟 —— 它冒充"改动后的样子"。今天两张都因此被拍错过。
 */
async function shoot(page, name, note, mustContain) {
  if (mustContain) {
    await page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      mustContain,
      { timeout: 15000 },
    ).catch(async () => {
      const head = (await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' / ');
      throw new Error(
        `${name}:页面上没等到「${mustContain}」,拒绝截一张假图。\n  当前页面开头:${head}`,
      );
    });
    await page.waitForTimeout(350);
  }
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, file, note });
  console.log(`  ✓ ${name}.png  ${note}`);
}

const json = (body) => ({ contentType: 'application/json', body: JSON.stringify(body) });

async function baseMocks(page) {
  await page.route('**/api/auth/me', (r) => r.fulfill(json({ user: { username: 'admin', role: 'admin' } })));
  await page.route('**/api/monthly/workspaces?mode=all', (r) => r.fulfill(json({
    workspaces: [{ workspaceKey: WS, isTestMode: true }],
  })));
}

// 四个桶各 160 行、合计约 227 万(与本地真造的数据同量级)
const BUCKETS = [
  { folder: '乐天首尔', n: 160, rebateKrw: 2276160 },
  { folder: '乐天釜山', n: 160, rebateKrw: 2277280 },
  { folder: '爱宝客', n: 160, rebateKrw: 2278400 },
  { folder: '济州新罗V团', n: 160, rebateKrw: 2279520 },
];
const TOTAL_ROWS = 640;

function monthlyRows(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: i + 1,
      mode_folder: BUCKETS[i % 4].folder,
      is_unmatched: i % 9 === 0 ? 1 : 0,
      receipt_no: `ZZTEST-${String(i).padStart(5, '0')}`,
      name: `ZZ TEST${String(i % 40).padStart(2, '0')}`,
      passport_no: `EZ${1000000 + i}`,
      tour_no: `ZZTEST-T${i % 12}`,
      purchase_date: '2026-07-10',
      customer_rebate_krw: 12000 + i * 7,
    });
  }
  return out;
}

(async () => {
  const browser = await chromium.launch();
  let page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('采集中…');

  // ── 1. 交付核对页:返点合计走全量,并明说列表是截断的 ──────────────
  await baseMocks(page);
  await page.route('**/monthly-data**', (r) => r.fulfill(json({
    rows: monthlyRows(500),                 // 列表只回一页
    total: TOTAL_ROWS,                      // 全量行数
    byMode: BUCKETS.map((b) => ({ folder: b.folder, unmatched: 0, n: b.n })),
    totals: {                               // ⭐ 今天新增:全量聚合
      buckets: BUCKETS.map((b) => ({ folder: b.folder, n: b.n, rebateKrw: b.rebateKrw })),
      totalRebateKrw: BUCKETS.reduce((s, b) => s + b.rebateKrw, 0),
      totalRows: TOTAL_ROWS,
    },
    listCap: 500,
  })));
  // 路径一律带尾部通配:少了它就打到真后端拿 401,整页数字回落成 0。
  await page.route('**/exports/final-delivery/readiness**', (r) => r.fulfill(json({
    ok: true, blocking: [], warnings: ['unreceived_rows_excluded'],
  })));
  await page.route('**/overview**', (r) => r.fulfill(json({
    workspace: { workspaceKey: WS, status: 'open' }, counts: {},
  })));
  // ⚠️ 这条必须 mock 且路径要对:loadAll 先 await ensureFresh,它没回来
  // 后面的 monthly-data 请求**根本不会发出** —— 第一版路径写成 '**/stages/ensure-fresh'
  // (少了尾部通配),真打到后端、失败,于是整页数字全是 0。
  await page.route('**/stages/ensure-fresh**', (r) => r.fulfill(json({ ran: [], mergeStats: {} })));
  await page.goto(`${BASE}/monthly/v2/${WS}/delivery-check`, { waitUntil: 'networkidle' });
  // ⚠️ 等到数字真的渲染出来再截。第一版只 waitForTimeout(900) 就拍,
  // 拍到的是全 0 的空壳 —— 那正是"把没数据的页面当成改动后的样子"的陷阱。
  await shoot(page, '01_交付核对_返点合计全量',
    '四个桶合计=全量 640 行的真值;下方明说"列表只列出前 N 行"',
    '2,276,160'); // 乐天首尔那个桶的真值,拍到它才说明全量聚合真的渲染了

  // ── 2. 账单核对页:「本次隐去」+ 不保存横幅 ────────────────────────
  // 用**新开的 page**:上一页注册的一堆 route 会把这页的请求也拦掉/漏掉,
  // 漏掉的那个 401 会让路由守卫把人踢回登录页(第一版就拍到了登录页)。
  await page.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await baseMocks(page);
  // ⚠️ playwright 的 route:**后注册的先匹配**。所以这条"兜底给空"必须先注册,
  // 下面那条更具体的 count-mismatch 才会赢。反过来写的话 count-mismatch 会被兜底吞掉,
  // 页签里一行数据都没有 —— 第一版就是这样,自检报「没等到『本次隐去』」。
  await page.route('**/api/monthly/**', (r) => r.fulfill(json({
    rows: [], total: 0, counts: {}, conflicts: [], hard: 0,
  })));
  await page.route('**/bill-match/count-mismatch**', (r) => r.fulfill(json({
    rows: [
      { agent: 'ZZTEST代理', name: 'ZZ TEST01', passportNo: 'EZ1000001', tourNo: 'ZZTEST-T1',
        dailyCount: 5, billCount: 3, missingInDaily: [], missingInBill: ['ZZTEST-00001', 'ZZTEST-00002'] },
      { agent: 'ZZTEST代理', name: 'ZZ TEST02', passportNo: 'EZ1000002', tourNo: 'ZZTEST-T2',
        dailyCount: 4, billCount: 2, missingInDaily: [], missingInBill: ['ZZTEST-00003', 'ZZTEST-00004'] },
    ],
    total: 2, receiptTotal: null, filter: {},
  })));
  await page.route('**/pending-reviews**', (r) => r.fulfill(json({ rows: [], total: 0 })));
  await page.goto(`${BASE}/monthly/v2/${WS}/bill-review`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  // 页签是 <button>,默认停在「字段冲突」。用 role=button 精确点 ——
  // getByText 会命中说明文字里的同名词,点了不切页签(第一版就是这样)。
  const tab = page.getByRole('button', { name: /小票无账单/ }).first();
  await tab.click();
  await page.waitForTimeout(1200);
  await shoot(page, '02_账单核对_本次隐去按钮',
    '按钮从「一键确认」改成「本次隐去」,悬停说明不落库',
    '本次隐去');
  const hideBtn = page.getByRole('button', { name: '本次隐去' }).first();
  if (await hideBtn.count()) {
    await hideBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    await shoot(page, '03_账单核对_隐去后横幅',
      '点完出现「本次已隐去 N 行 —— 没有保存」横幅',
      '本次已隐去');
  }

  // ── 3. 登录失败话术:限流被锁住时不再说"密码不正确" ────────────────
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page2.route('**/api/auth/me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page2.route('**/api/auth/login', (r) => r.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: '登录尝试过多，请稍后重试', retryAfter: 43 }),
  }));
  await page2.goto(`${BASE}/login`, { waitUntil: 'networkidle' }).catch(async () => {
    await page2.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  });
  await page2.waitForTimeout(500);
  const u = page2.locator('input').first();
  const p = page2.locator('input[type="password"]').first();
  if (await u.count()) await u.fill('zztest');
  if (await p.count()) await p.fill('zztest-not-a-real-password');
  const btn = page2.getByRole('button', { name: /登录/ }).first();
  if (await btn.count()) { await btn.click().catch(() => {}); await page2.waitForTimeout(800); }
  await shoot(page2, '04_登录_限流话术',
    '被限流锁住时说清等待秒数 + 「换密码没有用」,不再一律说"密码不正确"',
    '43 秒');

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(shots, null, 2));
  console.log(`\n共 ${shots.length} 张 → ${OUT}`);
  await browser.close();
})();
