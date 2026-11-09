const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('playwright');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeAppBase(value) {
  const normalized = `/${String(value || '/app/dist').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function parseArgs(argv = process.argv, env = process.env) {
  const args = {
    allowErrors: false,
    appBase: normalizeAppBase(env.SIGN_SMOKE_APP_BASE || '/app/dist'),
    baseUrl: trimTrailingSlash(env.SIGN_SMOKE_BASE_URL || 'http://127.0.0.1:3218'),
    headful: false,
    help: false,
    outFile: '',
    password: env.SIGN_SMOKE_PASSWORD || env.SIGN_BOOTSTRAP_ADMIN_PASSWORD || '',
    username: env.SIGN_SMOKE_USERNAME || env.SIGN_BOOTSTRAP_ADMIN_USERNAME || 'admin',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--base-url' && next) {
      args.baseUrl = trimTrailingSlash(next);
      index += 1;
    } else if (current === '--app-base' && next) {
      args.appBase = normalizeAppBase(next);
      index += 1;
    } else if (current === '--username' && next) {
      args.username = next;
      index += 1;
    } else if (current === '--password' && next) {
      args.password = next;
      index += 1;
    } else if (current === '--out-file' && next) {
      args.outFile = path.resolve(next);
      index += 1;
    } else if (current === '--headful') {
      args.headful = true;
    } else if (current === '--allow-errors') {
      args.allowErrors = true;
    } else if (current === '--help' || current === '-h') {
      args.help = true;
    }
  }

  return args;
}

function usage() {
  return `Usage:
  node scripts/run_vue_smoke_probe.js --password <admin-password>
  node scripts/run_vue_smoke_probe.js --base-url http://127.0.0.1:5173 --app-base /app/dist --password <password>

Options:
  --base-url <url>    Workbench URL, default http://127.0.0.1:3218
  --app-base <path>   Vue app base path, default /app/dist
  --username <name>   Login username, default admin
  --password <value>  Login password, or SIGN_SMOKE_PASSWORD
  --out-file <path>   Write JSON summary
  --headful           Run with visible browser
  --allow-errors      Exit 0 even if page or console errors are found
`;
}

function buildRoutePlan({ appBase = '/app/dist' } = {}) {
  const base = normalizeAppBase(appBase);
  const pageTitle = '.page-title h1';
  return [
    // 首页分离(2026-07-18):管理员/审核员两版首页都渲染 KPI 卡,以它为落地锚点
    { id: 'workbench', path: `${base}/`, selector: '.kpi-card__value' },
    { id: 'intake', path: `${base}/intake`, selector: pageTitle },
    // 审核页是单队列视图(2026-07-14 起),历史 tab 查询参数已整链删除,一个探针够
    { id: 'review', path: `${base}/review/latest`, selector: pageTitle },
    { id: 'monthly', path: `${base}/monthly/overview`, selector: pageTitle },
    { id: 'monthly-audit', path: `${base}/monthly/audit`, selector: pageTitle },
    { id: 'monthly-delivery', path: `${base}/monthly/delivery`, selector: pageTitle },
    { id: 'monthly-logs', path: `${base}/monthly/logs`, selector: pageTitle },
    { id: 'ledger', path: `${base}/monthly/ledger`, selector: pageTitle },
    { id: 'admin', path: `${base}/admin/dashboard`, selector: pageTitle },
  ];
}

function joinUrl(baseUrl, routePath) {
  return `${trimTrailingSlash(baseUrl)}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

function isIgnoredResponseFailure(url) {
  return url.endsWith('/favicon.svg') || url.includes('/favicon.');
}

async function runProbe(args = parseArgs()) {
  if (!args.password) {
    throw new Error('Password is required. Pass --password or set SIGN_SMOKE_PASSWORD.');
  }

  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const routes = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push({ type: 'console', text: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    errors.push({ type: 'pageerror', text: error.message });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !isIgnoredResponseFailure(response.url())) {
      errors.push({ type: 'response', status: response.status(), url: response.url() });
    }
  });

  try {
    await page.goto(joinUrl(args.baseUrl, `${args.appBase}/login`), { waitUntil: 'networkidle' });
    await page.locator('input[name="username"]').fill(args.username);
    await page.locator('input[name="password"]').fill(args.password);
    await page.locator('button[type="submit"]').click();
    await page.locator('.kpi-card__value').first().waitFor({ timeout: 15000 });

    for (const route of buildRoutePlan(args)) {
      await page.goto(joinUrl(args.baseUrl, route.path), { waitUntil: 'networkidle' });
      if (route.selector) {
        await page.locator(route.selector).first().waitFor({ timeout: 10000 });
      }
      if (route.text) {
        await page.getByText(route.text, { exact: false }).first().waitFor({ timeout: 10000 });
      }
      routes.push({
        id: route.id,
        path: route.path,
        title: await page.locator('.page-title h1').first().textContent().catch(() => ''),
      });
    }
  } finally {
    await browser.close();
  }

  const summary = {
    ok: errors.length === 0,
    baseUrl: args.baseUrl,
    appBase: args.appBase,
    routes,
    errors,
  };

  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, JSON.stringify(summary, null, 2), 'utf8');
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const summary = await runProbe(args);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok && !args.allowErrors) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRoutePlan,
  parseArgs,
  runProbe,
};
