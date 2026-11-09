'use strict';

/**
 * e2e_gate — 部署门禁(#4,2026-07-14):本地起真服务,真浏览器跑关键流,红了就不许上线。
 *
 * 为什么:七月的闪跳/串台/丢字段类事故,1400+ 单元测试一个都拦不住——它们只在真浏览器里发生。
 * 这道闸让"操作员先撞上"变成"部署前先撞上"。
 *
 * 跑什么(v1,只读为主+配置台写回环,不碰 OCR/不污染业务数据):
 *   F1  登录页真登录(门禁账号 e2e_gate,幂等创建)
 *   F2  工作台首页渲染
 *   F3  审核中心:队列渲染
 *   F4  选任务:检查器出现,滚动容器在顶(换票稳定性契约)
 *   F5  换票:护罩出现又消失,面板不跳(2026-07-14 视频报障的机器回归)
 *   F6  配置台:29 模式卡渲染 → 新建测试模式 → 回落出厂(写回环+清理)
 *   F7  异常补救页
 *   F8  库清理页
 *   F9  代理工作台(统计卡)
 *   F10 资料库页 + /readyz
 *   F11 客户建档页(上传队列 store 挂载;2026-07-21 T6-B 补的门禁盲区)
 *   全程看门狗:页面未捕获异常=红;任何 /api/ 响应 5xx=红。
 *
 * 数据依赖的步骤(F4/F5 需要本地有任务)在空库机器上记 SKIP 不记 FAIL——
 * 门禁的判定只看真失败。用法:node scripts/e2e_gate.js(deploy_push 自动调;--skip-e2e 跳过)。
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_GATE_PORT || 3219);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `${BASE}/app/dist`;
const USER = process.env.E2E_GATE_USER || 'e2e_gate';
const PASS = process.env.E2E_GATE_PASSWORD || 'e2e-gate-local-2026';

const results = []; // {flow, status: 'PASS'|'FAIL'|'SKIP', detail}
function record(flow, status, detail = '') {
  results.push({ flow, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️' : '❌';
  console.log(`${icon} ${flow}${detail ? ` — ${detail}` : ''}`);
}

function ensureGateUser() {
  // ⚠️服务端用户库=storage/workbench.sqlite(server/dependencies.js:68);
  // manage_users 的默认 workbench_v2.db 是另一个文件——必须显式 --db 指到服务端同一库,
  // 否则账号建在错库登录恒 Invalid credentials(2026-07-14 首跑实锤)。
  const dbPath = path.join(ROOT, 'passport_review_workbench', 'storage', 'workbench.sqlite');
  const args = ['scripts/manage_users.js'];
  const dbArgs = ['--db', dbPath];
  try {
    execFileSync('node', [...args, 'create', '--username', USER, '--password', PASS, '--role', 'admin', ...dbArgs], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // 已存在 → 重置密码保证可登录(幂等)
    execFileSync('node', [...args, 'reset-password', '--username', USER, '--password', PASS, ...dbArgs], { cwd: ROOT, stdio: 'pipe' });
  }
}

// F6 会新建一个「E2E门禁测试模式」再「回到默认」——但回到默认只**停用**不删除,
// 版本行会永久累积。自 41b0b1f 起 createMode 对同名已存在实体(base>0)直接 409,
// 于是第二次起门禁就再也建不出该模式而卡死(2026-07-23 实锤:本地残留 65 个停用版本)。
// 门禁自清:每次跑前把自己的测试模式版本行清干净,让 createMode 永远从 base=0 起步。
function cleanGateModes() {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(ROOT, 'passport_review_workbench', 'storage', 'monthly.sqlite');
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const { changes } = db.prepare("DELETE FROM config_entries WHERE name LIKE 'E2E门禁测试模式%'").run();
      if (changes) console.log(`[e2e_gate] 清理门禁测试模式残留版本 ${changes} 行`);
    } finally {
      db.close();
    }
  } catch {
    // 库/表还不存在(全新环境)→ 无残留可清,跳过
  }
}

function bootServer() {
  const child = spawn('node', ['--env-file=.env', 'passport_review_workbench.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  return {
    child,
    async waitReady(timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${BASE}/readyz`);
          if (res.status === 200) return;
        } catch { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`server not ready in ${timeoutMs}ms\n--- boot log tail ---\n${bootLog.slice(-2000)}`);
    },
  };
}

async function main() {
  console.log('[e2e_gate] 幂等创建门禁账号…');
  ensureGateUser();
  cleanGateModes();

  console.log(`[e2e_gate] 本地起服务 PORT=${PORT}…`);
  const server = bootServer();
  let browser = null;
  const pageErrors = [];
  const badResponses = [];

  try {
    await server.waitReady();
    console.log('[e2e_gate] readyz=200,起浏览器…');

    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    page.on('dialog', (dialog) => dialog.accept()); // confirm 一律接受(配置台回落出厂)
    page.on('response', (res) => {
      if (res.status() >= 500 && res.url().includes('/api/')) {
        badResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    // ── F1 登录 ──────────────────────────────────────────────
    await page.goto(`${APP}/login`);
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.getByText('审核中心').first().waitFor(); // 登录成功=导航出现
    record('F1 登录', 'PASS');

    // ── F2 工作台首页 ─────────────────────────────────────────
    record('F2 工作台首页', 'PASS', '导航与首页已渲染');

    // ── F3 审核中心队列 ───────────────────────────────────────
    await page.getByText('审核中心').first().click();
    await page.waitForSelector('.grouped-list', { timeout: 20_000 });
    async function expandAndCount() {
      const expandAll = page.getByText('全部展开').first();
      if (await expandAll.isVisible().catch(() => false)) await expandAll.click();
      return page.locator('.grouped-list .task-row').count();
    }
    let taskRows = await expandAndCount();
    record('F3 审核队列渲染', 'PASS', `任务行 ${taskRows}`);
    // 旗舰回归(F4/F5)需要 ≥2 行:最新批次不够就翻旧批次找(最多试 6 个)
    if (taskRows < 2) {
      // 页面有多个 select(左栏排序/顶部批次)——批次下拉=选项最多的那个
      const selects = page.locator('select');
      const selectCount = await selects.count();
      let batchSelect = null;
      let batchOptions = 0;
      for (let i = 0; i < selectCount; i += 1) {
        const n = await selects.nth(i).locator('option').count().catch(() => 0);
        if (n > batchOptions) { batchOptions = n; batchSelect = selects.nth(i); }
      }
      for (let i = 1; batchSelect && i < Math.min(batchOptions, 6) && taskRows < 2; i += 1) {
        await batchSelect.selectOption({ index: i }).catch(() => {});
        await page.waitForTimeout(800);
        taskRows = await expandAndCount();
      }
      if (taskRows >= 2) console.log(`[e2e_gate] 切到旧批次凑足任务行:${taskRows}`);
    }

    // ── F4/F5 换票稳定性(需要 ≥2 个任务行;空库机器 SKIP)──────
    if (taskRows >= 2) {
      await page.locator('.grouped-list .task-row').first().click();
      await page.waitForSelector('.review-inspector');
      await page.waitForTimeout(400); // 护罩窗过去
      const topAfterFirst = await page.evaluate(() => document.querySelector('.review-field-scroll')?.scrollTop ?? 0);
      if (topAfterFirst !== 0) throw new Error(`选任务后滚动容器不在顶:scrollTop=${topAfterFirst}`);
      record('F4 选任务·面板在顶', 'PASS');

      await page.locator('.grouped-list .task-row').nth(1).click();
      const settlingSeen = await page.evaluate(() => document.querySelector('.review-inspector')?.classList.contains('settling'));
      await page.waitForFunction(() => !document.querySelector('.review-inspector')?.classList.contains('settling'), null, { timeout: 2000 });
      const topAfterSwitch = await page.evaluate(() => document.querySelector('.review-field-scroll')?.scrollTop ?? 0);
      if (topAfterSwitch !== 0) throw new Error(`换票后滚动容器跳了:scrollTop=${topAfterSwitch}`);
      record('F5 换票·护罩生效且不跳', 'PASS', `护罩出现=${settlingSeen}`);
    } else {
      record('F4 选任务·面板在顶', 'SKIP', '本机无任务数据');
      record('F5 换票·护罩生效且不跳', 'SKIP', '本机任务不足2张');
    }

    // ── F6 配置台写回环(2026-07-16 单导航重排:.cc/.list-item/.list-new/回到默认)──
    await page.getByText('配置台').first().click();
    await page.waitForSelector('.cc');                       // 旧 .config-console 已改名 .cc
    await page.waitForSelector('.list-item');                // 渠道模式列表(nav 默认 modes)
    const cardCount = await page.locator('.list-item').count();
    if (cardCount < 29) throw new Error(`模式卡不足:${cardCount} < 29`);
    const gateModeName = 'E2E门禁测试模式';
    await page.fill('.list-new input', gateModeName);        // 旧 .new-mode input
    await page.locator('.list-new button').click();          // 旧「+ 新增模式」→「+ 新增」
    await page.getByText(gateModeName, { exact: true }).first().waitFor();
    // 清理:回到默认(dialog 已全局接受)→ 该模式从列表消失
    await page.getByText('回到默认', { exact: true }).first().click();   // 旧「回落出厂规则」
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('.list-item .li-name')].some((el) => el.textContent.trim() === name),
      gateModeName,
      { timeout: 10_000 },
    );
    record('F6 配置台·新建/回落回环', 'PASS', `模式卡 ${cardCount}`);

    // ── F7-F10 关键页面渲染 ───────────────────────────────────
    // 2026-07-28 波3 导航正名对齐(0728文档#3-#6):代理视图→客户中心、资料库→日交付、
    // 建档收票→收票建档;库清理收进配置台(F8 改走保留的直达路由验证)。
    const pages = [
      ['F7 异常补救', '异常补救', '补救'],
      ['F9 客户中心(原代理视图)', '客户中心', '客户组'], // 本地投影可能为空,只验视图挂载
      ['F10 日交付(原资料库)', '日交付', '导出'],
      // 2026-07-21 T6-B 补缺口:建档页此前从不在门禁里(上传链路盲区)。上传队列 store
      // 在此页首次实例化——挂载即验 Pinia 接线;队列面板空队列隐藏属预期,只验收图区渲染。
      ['F11 客户建档·上传队列挂载', '收票建档', '拖入客户图'],
    ];
    for (const [flow, navText, expectText] of pages) {
      await page.getByText(navText).first().click();
      await page.getByText(expectText).first().waitFor({ timeout: 20_000 });
      record(flow, 'PASS');
    }

    // F8 库清理(0724#3 收进配置台后,主导航无此文字):直达保留路由验组件挂载
    await page.goto(`${BASE}/app/dist/library-cleanup`);
    await page.getByText('孤儿客户').first().waitFor({ timeout: 20_000 });
    record('F8 库清理(直达路由)', 'PASS');

    const readyz = await fetch(`${BASE}/readyz`);
    if (readyz.status !== 200) throw new Error(`readyz=${readyz.status}`);

    // ── 看门狗结算 ────────────────────────────────────────────
    if (pageErrors.length) throw new Error(`页面未捕获异常 ${pageErrors.length} 条:\n${pageErrors.slice(0, 5).join('\n')}`);
    if (badResponses.length) throw new Error(`API 5xx ${badResponses.length} 条:\n${badResponses.slice(0, 5).join('\n')}`);
  } catch (error) {
    record('GATE', 'FAIL', String(error?.message || error));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.child.kill();
  }

  const fails = results.filter((r) => r.status === 'FAIL');
  const skips = results.filter((r) => r.status === 'SKIP');
  console.log(`\n[e2e_gate] 结果:${results.length - fails.length - skips.length} PASS / ${skips.length} SKIP / ${fails.length} FAIL`);
  if (fails.length) {
    console.error('[e2e_gate] ❌ 门禁不通过,禁止部署(紧急旁路:deploy_push --skip-e2e,事后必须补跑)');
    process.exit(1);
  }
  console.log('[e2e_gate] ✅ 门禁通过');
}

main().catch((error) => {
  console.error('[e2e_gate] 崩溃:', error);
  process.exit(1);
});
