const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  VALID_USER_ROLES,
  UserService,
} = require('../services/user_service');

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-auth-service-'));
  return {
    dbPath: path.join(dir, 'auth.sqlite'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('UserService creates users with hashed passwords and authenticates them', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();

  const service = new UserService({ dbPath });
  t.after(() => {
    service.close();
    cleanup();
  });
  const user = await service.createUser('admin', 'secret123', 'admin');

  assert.equal(user.username, 'admin');
  assert.equal(user.role, 'admin');
  assert.equal(user.password_hash, undefined);

  const stored = await service.getUserById(user.id, { includePasswordHash: true });
  assert.notEqual(stored.password_hash, 'secret123');
  assert.match(stored.password_hash, /^\$2[aby]\$/);

  const authenticated = await service.authenticate('admin', 'secret123');
  assert.equal(authenticated.id, user.id);
  assert.equal(authenticated.password_hash, undefined);
  assert.equal(await service.authenticate('admin', 'wrong'), null);
});

test('UserService validates roles and blocks duplicate usernames', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();

  const service = new UserService({ dbPath });
  t.after(() => {
    service.close();
    cleanup();
  });
  assert.deepEqual(VALID_USER_ROLES, [
    'admin',
    'reviewer',
    'finance',
  ]);

  await service.createUser('operator', 'secret123', 'reviewer');
  await assert.rejects(
    service.createUser('operator', 'secret123', 'reviewer'),
    /already exists/
  );
  await assert.rejects(
    service.createUser('bad-role', 'secret123', 'root'),
    /Invalid role/
  );
  await assert.rejects(
    service.createUser('legacy-role', 'secret123', 'image_reviewer'),
    /Invalid role/
  );
  await assert.rejects(
    service.createUser('read-only', 'secret123', 'viewer'),
    /Invalid role/
  );
});

test('UserService updates, lists, and soft-deletes users', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();

  const service = new UserService({ dbPath });
  t.after(() => {
    service.close();
    cleanup();
  });
  const user = await service.createUser('reviewer', 'secret123', 'reviewer');
  const updated = await service.updateUser(user.id, {
    role: 'finance',
    displayName: 'Finance User',
  });

  assert.equal(updated.role, 'finance');
  assert.equal(updated.display_name, 'Finance User');
  assert.equal((await service.listUsers()).length, 1);

  await service.deleteUser(user.id);
  assert.equal(await service.authenticate('reviewer', 'secret123'), null);
  assert.equal((await service.getUserById(user.id)).is_active, 0);
});

test('UserService bootstraps the first admin only when the user table is empty', async (t) => {
  const { dbPath, cleanup } = createTempDbPath();

  const service = new UserService({ dbPath });
  t.after(() => {
    service.close();
    cleanup();
  });

  const admin = await service.ensureBootstrapAdmin({
    username: 'admin',
    password: 'secret123',
  });
  const skipped = await service.ensureBootstrapAdmin({
    username: 'other',
    password: 'secret123',
  });

  assert.equal(admin.username, 'admin');
  assert.equal(admin.role, 'admin');
  assert.equal(skipped, null);
  assert.equal(await service.getUserCount(), 1);
});
