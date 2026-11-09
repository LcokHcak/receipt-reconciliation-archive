const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRoutePlan,
  parseArgs,
} = require('../scripts/run_vue_smoke_probe');

test('Vue smoke probe defaults to the packaged app dist shell', () => {
  const args = parseArgs(['node', 'script'], {});

  assert.equal(args.baseUrl, 'http://127.0.0.1:3218');
  assert.equal(args.appBase, '/app/dist');
  assert.equal(args.username, 'admin');
  assert.equal(args.password, '');
});

test('Vue smoke probe covers the migrated workflow pages', () => {
  const routes = buildRoutePlan({ appBase: '/app/dist' }).map((route) => route.path);

  assert.deepEqual(routes, [
    '/app/dist/',
    '/app/dist/intake',
    '/app/dist/review/latest',
    '/app/dist/monthly/overview',
    '/app/dist/monthly/audit',
    '/app/dist/monthly/delivery',
    '/app/dist/monthly/logs',
    '/app/dist/monthly/ledger',
    '/app/dist/admin/dashboard',
  ]);
});
