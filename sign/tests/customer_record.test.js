const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-record-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('createCustomerFolder writes customer.json and loadCustomer returns the same logical record', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    const record = repo.createCustomerFolder({
      monthKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Kim',
      images: [
        {
          imageId: 'img_001',
          relativePath: 'images/01-passport.jpg',
          kind: 'passport',
          source: 'cropped',
          sortOrder: 1,
        },
      ],
    });

    const customerPath = path.join(repo.getActiveRoot(), '202604', 'CL20260420-001');
    assert.equal(fs.existsSync(path.join(customerPath, 'customer.json')), true);
    assert.equal(record.status, 'ready_for_review');
    assert.equal(record.agentName, 'Agent Kim');
    assert.equal(record.template.workingCopyPath, 'template/账单模板.xlsx');

    const loaded = repo.loadCustomer('202604', 'CL20260420-001');
    assert.deepEqual(loaded, record);
  } finally {
    cleanup(tempRoot);
  }
});

test('saveCustomer persists updates and listCustomers returns records for a month', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    const record = repo.createCustomerFolder({
      monthKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Park',
      images: [],
    });

    record.status = 'in_review';
    record.displayName = 'HUANG YU';
    repo.saveCustomer(record);

    const reloaded = repo.loadCustomer('202604', 'CL20260420-001');
    assert.equal(reloaded.status, 'in_review');
    assert.equal(reloaded.displayName, 'HUANG YU');
    assert.equal(repo.listCustomers('202604').length, 1);
  } finally {
    cleanup(tempRoot);
  }
});

test('rejects malformed customer ids and invalid status changes', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    assert.throws(() => repo.createCustomerFolder({
      monthKey: '202604',
      customerId: 'bad-id',
      agentName: 'Agent Han',
      images: [],
    }), /Invalid customer id/);

    const record = repo.createCustomerFolder({
      monthKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });

    record.status = 'in_review';
    repo.saveCustomer(record);

    record.status = 'approved';
    repo.saveCustomer(record);

    record.status = 'template_generated';
    repo.saveCustomer(record);

    record.status = 'draft';
    assert.throws(() => repo.saveCustomer(record), /Invalid customer status transition/);
  } finally {
    cleanup(tempRoot);
  }
});

test('template-generated customer can re-enter review after new batch sync', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });

    const record = repo.createCustomerFolder({
      monthKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });

    record.status = 'in_review';
    repo.saveCustomer(record);
    record.status = 'approved';
    repo.saveCustomer(record);
    record.status = 'template_generated';
    repo.saveCustomer(record);

    record.status = 'in_review';
    repo.saveCustomer(record);

    assert.equal(repo.loadCustomer('202604', 'CL20260420-001').status, 'in_review');
  } finally {
    cleanup(tempRoot);
  }
});
