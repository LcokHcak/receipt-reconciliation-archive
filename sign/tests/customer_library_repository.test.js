const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-library-repo-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('uses default root until active root is explicitly changed', () => {
  const tempRoot = makeTempDir();

  try {
    const defaultRoot = path.join(tempRoot, 'default-library');
    const settingsPath = path.join(tempRoot, 'settings.json');
    const repo = createCustomerLibraryRepository({
      defaultRoot,
      settingsPath,
    });

    assert.equal(repo.getActiveRoot(), path.resolve(defaultRoot));
    assert.equal(fs.existsSync(settingsPath), false);

    const switchedRoot = path.join(tempRoot, 'custom-library');
    repo.setActiveRoot(switchedRoot);

    assert.equal(repo.getActiveRoot(), path.resolve(switchedRoot));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
      { activeRoot: path.resolve(switchedRoot) }
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('ensureWorkspace creates workspace directories and listWorkspaces mirrors the month compatibility alias', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
    });

    const createdWorkspacePath = repo.ensureWorkspace('20260421-first-batch');
    repo.ensureWorkspace('wechat-receipts-wed');
    fs.mkdirSync(path.join(repo.getActiveRoot(), 'misc-folder'), { recursive: true });

    assert.equal(createdWorkspacePath, path.join(repo.getActiveRoot(), '20260421-first-batch'));
    assert.equal(fs.existsSync(createdWorkspacePath), true);
    assert.deepEqual(
      [...repo.listWorkspaces()].sort(),
      ['20260421-first-batch', 'misc-folder', 'wechat-receipts-wed'].sort()
    );
    assert.deepEqual(
      [...repo.listMonths()].sort(),
      ['20260421-first-batch', 'misc-folder', 'wechat-receipts-wed'].sort()
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('allocateCustomerId increments within the selected workspace using the current date stamp', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T09:30:00+09:00'),
    });

    const workspacePath = repo.ensureWorkspace('wechat-receipts-wed');
    fs.mkdirSync(path.join(workspacePath, 'CL20260420-001'));
    fs.mkdirSync(path.join(workspacePath, 'CL20260420-002'));
    fs.mkdirSync(path.join(workspacePath, 'CL20260419-007'));

    assert.equal(repo.allocateCustomerId('wechat-receipts-wed'), 'CL20260420-003');
    assert.equal(repo.allocateCustomerId('202604'), 'CL20260420-001');
  } finally {
    cleanup(tempRoot);
  }
});

test('allocateCustomerId uses the local business date instead of the UTC date', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-05-03T15:30:00.000Z'),
    });

    assert.equal(repo.allocateCustomerId('202605'), 'CL20260504-001');
  } finally {
    cleanup(tempRoot);
  }
});

test('rejects workspace keys that attempt to escape the active root, while month aliases accept custom workspace names', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
    });

    assert.throws(() => repo.ensureWorkspace('../oops'), /Invalid workspace key/);
    assert.throws(() => repo.ensureWorkspace('bad/name'), /Invalid workspace key/);
    assert.equal(
      repo.ensureMonth('korea-visa-0421'),
      path.join(repo.getActiveRoot(), 'korea-visa-0421')
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('loadCustomer upgrades legacy monthKey-only records to workspaceKey compatibility on save', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    const customerDir = path.join(repo.ensureWorkspace('202604'), 'CL20260420-001');
    fs.mkdirSync(customerDir, { recursive: true });
    fs.writeFileSync(
      path.join(customerDir, 'customer.json'),
      JSON.stringify({
        customerId: 'CL20260420-001',
        status: 'ready_for_review',
        agentName: 'Agent Han',
        monthKey: '202604',
        displayName: null,
        passportNumber: null,
        folderNameInitial: 'CL20260420-001',
        folderNameFinal: null,
        template: {
          templateVersion: 'receipt-template-v1',
          sourceTemplatePath: 'template-source.xlsx',
          workingCopyPath: 'template/template.xlsx',
          finalOutputPath: null,
          filledAt: null,
        },
        images: [],
        review: {
          lastBatchId: null,
          lastSourceGroupId: null,
          approvedAt: null,
        },
        createdAt: '2026-04-20T01:15:00.000Z',
        updatedAt: '2026-04-20T01:15:00.000Z',
      }, null, 2),
      'utf8'
    );

    const customer = repo.loadCustomer('202604', 'CL20260420-001');
    assert.equal(customer.workspaceKey, '202604');
    assert.equal(customer.monthKey, '202604');

    const saved = repo.saveCustomer({
      ...customer,
      status: 'in_review',
    });
    assert.equal(saved.workspaceKey, '202604');

    const persisted = JSON.parse(fs.readFileSync(path.join(customerDir, 'customer.json'), 'utf8'));
    assert.equal(persisted.workspaceKey, '202604');
    assert.equal(persisted.monthKey, '202604');
  } finally {
    cleanup(tempRoot);
  }
});

test('deleteCustomer and deleteWorkspace force-delete only inside the active root', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    const customer = repo.createCustomerFolder({
      workspaceKey: 'wechat-receipts-wed',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = repo.customerDir(customer.workspaceKey, customer.customerId);
    fs.mkdirSync(path.join(customerDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'nested', 'note.txt'), 'hello', 'utf8');

    const deleteCustomerResult = repo.deleteCustomer('wechat-receipts-wed', 'CL20260420-001', { force: true });
    assert.equal(deleteCustomerResult.deleted, true);
    assert.equal(fs.existsSync(customerDir), false);

    const workspacePath = repo.ensureWorkspace('20260421-first-batch');
    fs.mkdirSync(path.join(workspacePath, 'orphan-folder'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'orphan-folder', 'note.txt'), 'hello', 'utf8');

    const deleteWorkspaceResult = repo.deleteWorkspace('20260421-first-batch', { force: true });
    assert.equal(deleteWorkspaceResult.deleted, true);
    assert.equal(fs.existsSync(workspacePath), false);
  } finally {
    cleanup(tempRoot);
  }
});
