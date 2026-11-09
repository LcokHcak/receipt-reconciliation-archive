const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchSqliteRepository } = require('../repositories/workbench_sqlite_repository');

test('workbench SQLite repository enables foreign key enforcement for its connection', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-sqlite-'));
  const repository = createWorkbenchSqliteRepository({
    dbPath: path.join(tempRoot, 'workbench.sqlite'),
  });

  try {
    assert.equal(repository.getForeignKeysEnabled(), true);
  } finally {
    repository.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
