const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildRoleUiRoutes,
  parseArgs,
} = require('../scripts/run_operator_regression_probe');

test('operator regression probe covers admin, reviewer, and finance UI surfaces', () => {
  const admin = buildRoleUiRoutes('admin').map(([id]) => id);
  const reviewer = buildRoleUiRoutes('reviewer').map(([id]) => id);
  const finance = buildRoleUiRoutes('finance').map(([id]) => id);

  assert.ok(admin.includes('admin-users'));
  assert.ok(admin.includes('remedy'));
  assert.ok(reviewer.includes('intake'));
  assert.ok(reviewer.includes('remedy'));
  assert.ok(finance.includes('ledger'));
  assert.ok(finance.includes('finance-remedy-denied'));
  assert.ok(finance.includes('finance-admin-denied'));
});

test('operator regression probe keeps output configurable for repeatable full runs', () => {
  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3999',
    '--out-dir',
    'tmp/operator-probe',
    '--keep-data',
  ]);

  assert.equal(args.baseUrl, 'http://127.0.0.1:3999');
  // parseArgs 对 out-dir 做 path.resolve;断言用同一解析,跨平台(不写死 D: 字面量)
  assert.equal(args.outDir, path.resolve('tmp/operator-probe'));
  assert.equal(args.keepData, true);
});
