const fs = require('node:fs');
const path = require('node:path');

const { ensureDir } = require('../lib/workbench_utils');

function sanitizeTemplateName(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || '未命名';
}

function createCustomerTemplateRepository({ sourceTemplatePath }) {
  function getSourceTemplatePath() {
    return sourceTemplatePath;
  }

  function createWorkingTemplate(customerPath) {
    const templateDir = path.join(customerPath, 'template');
    const workingCopyPath = path.join(templateDir, '账单模板.xlsx');
    ensureDir(templateDir);
    fs.copyFileSync(getSourceTemplatePath(), workingCopyPath);
    return workingCopyPath;
  }

  function getFinalTemplatePath(customerPath, name) {
    const normalizedName = sanitizeTemplateName(name);
    return path.join(customerPath, 'template', `账单-${normalizedName}.xlsx`);
  }

  return {
    createWorkingTemplate,
    getFinalTemplatePath,
    getSourceTemplatePath,
  };
}

module.exports = {
  createCustomerTemplateRepository,
};
