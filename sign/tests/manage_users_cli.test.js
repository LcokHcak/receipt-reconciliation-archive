const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UserService } = require('../services/user_service');
const { runUserManagementCli } = require('../scripts/manage_users');

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-users-cli-'));
  return {
    dbPath: path.join(dir, 'workbench_v2.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function runCli(args, dbPath) {
  const writes = [];
  const errors = [];
  const exitCode = await runUserManagementCli(args, {
    stdout: { write: (chunk) => writes.push(String(chunk)) },
    stderr: { write: (chunk) => errors.push(String(chunk)) },
    env: {},
    defaultDbPath: dbPath,
  });
  return {
    exitCode,
    stdout: writes.join(''),
    stderr: errors.join(''),
  };
}

function parseJsonOutput(result) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('user management CLI creates users and lists public user records', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();
  t.after(cleanup);

  const created = parseJsonOutput(await runCli([
    'create',
    '--username', 'reviewer1',
    '--password', 'secret123',
    '--role', 'reviewer',
    '--display-name', 'Reviewer One',
  ], dbPath));

  assert.equal(created.ok, true);
  assert.equal(created.user.username, 'reviewer1');
  assert.equal(created.user.role, 'reviewer');
  assert.equal(created.user.password_hash, undefined);

  const listed = parseJsonOutput(await runCli(['list'], dbPath));
  assert.deepEqual(listed.users.map((user) => user.username), ['reviewer1']);
  assert.equal(listed.users[0].password_hash, undefined);
});

test('user management CLI updates role, resets password, and deactivates users', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();
  const service = new UserService({ dbPath });
  t.after(() => {
    service.close();
    cleanup();
  });

  await service.createUser('reviewer1', 'secret123', 'reviewer');

  const updated = parseJsonOutput(await runCli([
    'update-role',
    '--username', 'reviewer1',
    '--role', 'finance',
  ], dbPath));
  assert.equal(updated.user.role, 'finance');

  const reset = parseJsonOutput(await runCli([
    'reset-password',
    '--username', 'reviewer1',
    '--password', 'newpass123',
  ], dbPath));
  assert.equal(reset.user.username, 'reviewer1');
  assert.equal(await service.authenticate('reviewer1', 'secret123'), null);
  assert.equal((await service.authenticate('reviewer1', 'newpass123')).role, 'finance');

  const deactivated = parseJsonOutput(await runCli([
    'deactivate',
    '--username', 'reviewer1',
  ], dbPath));
  assert.equal(deactivated.user.is_active, 0);
  assert.equal(await service.authenticate('reviewer1', 'newpass123'), null);
});

test('user management CLI bootstraps an admin only into an empty user table', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();
  t.after(cleanup);

  const bootstrapped = parseJsonOutput(await runCli([
    'bootstrap-admin',
    '--username', 'admin',
    '--password', 'secret123',
  ], dbPath));
  assert.equal(bootstrapped.created, true);
  assert.equal(bootstrapped.user.role, 'admin');

  const skipped = parseJsonOutput(await runCli([
    'bootstrap-admin',
    '--username', 'other',
    '--password', 'secret123',
  ], dbPath));
  assert.equal(skipped.created, false);
  assert.equal(skipped.user, null);
});

test('user management CLI reports validation errors without stack traces', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();
  t.after(cleanup);

  const result = await runCli([
    'create',
    '--username', 'bad',
    '--password', 'short',
    '--role', 'admin',
  ], dbPath);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Password must be at least 6 characters/);
  assert.doesNotMatch(result.stderr, /at .*manage_users/);
});
