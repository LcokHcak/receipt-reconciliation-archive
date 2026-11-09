// F10-hotfix regression guard: v2 routes must not double-render the v1
// outer shell. App.vue must let v2 monthly / v2 audit routes through to
// their own AppLayout (SidebarProvider + AppSidebar).
//
// Why this exists: F10 shipped without this guard. On the deployed UI
// users saw two sidebars stacked (v1 outer "Sign 审核工作台" + v2 inner
// "收票对账系统"), because every non-login route fell into the v1 shell
// branch of App.vue. This test pins the contract so the regression can
// not silently come back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('App.vue lets v2 monthly / v2 audit routes bypass the v1 outer shell', () => {
  const app = read('frontend/src/App.vue');

  // Must compute an isV2Layout flag based on /monthly/v2 or /audit/v2 prefix.
  assert.match(app, /isV2Layout/, 'App.vue should compute isV2Layout');
  assert.match(app, /\/monthly\/v2/, 'isV2Layout must match /monthly/v2 prefix');
  assert.match(app, /\/audit\/v2/,   'isV2Layout must match /audit/v2 prefix');

  // Template must short-circuit isV2Layout before falling into <div class="shell">.
  assert.match(
    app,
    /v-else-if=["']isV2Layout["']/,
    'template must branch on isV2Layout before the v1 shell'
  );

  // Sanity: v1 shell (with sidebar/brand) is still present for legacy daily / admin pages.
  assert.match(app, /<aside class="sidebar">/, 'v1 shell must stay for /intake /review /admin etc.');
});

test('AppLayout (v2) is the sole sidebar provider for v2 monthly views', () => {
  // Every v2 view should import AppLayout so the v2 sidebar renders inside.
  const dir = path.join(root, 'frontend/src/views/v2');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vue'));
  assert.ok(files.length >= 12, 'expected at least 12 v2 views');

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // AuditLogsView is an exception path (/audit/v2/logs) — still uses AppLayout.
    assert.match(src, /AppLayout/, `${f} must use AppLayout (gets v2 sidebar)`);
  }
});
