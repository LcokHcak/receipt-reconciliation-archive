// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './frontend/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // channel 'chrome' = 系统装的 Google Chrome(开发机上就是你平时用的那个)。
    // CI 上没有它,得用 playwright 自带的 chromium —— 由 PLAYWRIGHT_CHANNEL 切换。
    // 留空字符串表示"不指定 channel",playwright 就用自带的 chromium。
    channel: process.env.PLAYWRIGHT_CHANNEL === '' ? undefined
      : (process.env.PLAYWRIGHT_CHANNEL || 'chrome'),
  },
  webServer: {
    // E2E 跑构建产物(vite preview),与生产 /app/dist 同形态。
    // 换掉 dev server 的原因(2026-07-12):dev 对仓库外 CJS(lib/mode_record_matrix.js)
    // 不做 ESM 互操作,ReviewView 懒加载在 dev 下必崩——测 dev 等于测一个不存在的环境。
    //
    // ⚠️ 2026-08-01:这行原来写的是 `npm.cmd` —— **Windows 专有**,Linux 上根本没有这个命令。
    // 也就是说这套 e2e **在 CI 上从来就起不来**,而这正是它一直没被接进 CI 的原因之一
    // (另一个原因是 playwright 版本劈叉,今天上午修的)。
    // 13 条用例本地全过、看着像有一道闸,实际上没有任何自动化在跑它 ——
    // 和今天修过的另外两处「闸存在但从不触发」同型。
    // process.platform 判据比 npm.cmd 硬编码稳:Windows 上仍走 npm.cmd(PATH 里没有裸 npm)。
    command: process.platform === 'win32'
      ? 'npm.cmd run build && npm.cmd run preview -- --host 127.0.0.1 --port 5177'
      : 'npm run build && npm run preview -- --host 127.0.0.1 --port 5177',
    cwd: './frontend',
    url: 'http://127.0.0.1:5177/app/dist/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
