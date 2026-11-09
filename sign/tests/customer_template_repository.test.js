const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCustomerTemplateRepository } = require('../repositories/customer_template_repository');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-template-repo-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('resolves the stable source template path', () => {
  const tempRoot = makeTempDir();

  try {
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const repo = createCustomerTemplateRepository({ sourceTemplatePath });

    assert.equal(repo.getSourceTemplatePath(), sourceTemplatePath);
  } finally {
    cleanup(tempRoot);
  }
});

test('creates a blank working copy at template/账单模板.xlsx inside the customer folder', () => {
  const tempRoot = makeTempDir();

  try {
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const customerPath = path.join(tempRoot, '202604', 'CL20260420-001');
    fs.mkdirSync(customerPath, { recursive: true });
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const repo = createCustomerTemplateRepository({ sourceTemplatePath });
    const workingCopyPath = repo.createWorkingTemplate(customerPath);

    assert.equal(workingCopyPath, path.join(customerPath, 'template', '账单模板.xlsx'));
    assert.equal(fs.readFileSync(workingCopyPath, 'utf8'), 'template-bytes');
  } finally {
    cleanup(tempRoot);
  }
});

test('builds the final template output path as 账单-NAME.xlsx', () => {
  const tempRoot = makeTempDir();

  try {
    const repo = createCustomerTemplateRepository({
      sourceTemplatePath: path.join(tempRoot, 'customer-receipt-template.xlsx'),
    });
    const customerPath = path.join(tempRoot, '202604', 'CL20260420-001');

    assert.equal(
      repo.getFinalTemplatePath(customerPath, 'HUANG YU'),
      path.join(customerPath, 'template', '账单-HUANG YU.xlsx')
    );
  } finally {
    cleanup(tempRoot);
  }
});
