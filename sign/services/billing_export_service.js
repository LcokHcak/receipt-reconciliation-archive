const fs = require('node:fs');
const path = require('node:path');

const { createCustomerTemplateFillService } = require('./customer_template_fill_service');

const DEFAULT_BILLING_TEMPLATE_PATH = path.join(
  __dirname,
  '..',
  'passport_review_workbench',
  'templates',
  'customer-receipt-template.xlsx'
);

function resolveTravelerName(customer = {}) {
  return String(
    customer.travelerName
      || customer.displayName
      || customer.extractedNameFinal
      || customer.passportName
      || customer.name
      || ''
  ).trim();
}

function sanitizeBillName(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'customer';
}

function resolveOutputPath({ outputDir, outputPath, travelerName }) {
  if (outputPath) {
    return outputPath;
  }
  const safeName = sanitizeBillName(travelerName);
  return path.join(outputDir, `账单-${safeName}.xlsx`);
}

function createBillingExportService({
  templateFillService = createCustomerTemplateFillService(),
  defaultTemplatePath = DEFAULT_BILLING_TEMPLATE_PATH,
} = {}) {
  async function exportCustomerBill({
    outputDir,
    outputPath,
    customer = {},
    approvedAt,
    templatePath = defaultTemplatePath,
  }) {
    if (!outputDir && !outputPath) {
      throw new Error('outputDir or outputPath is required');
    }
    if (!templatePath || !fs.existsSync(templatePath)) {
      throw new Error(`Billing template not found: ${templatePath || '(empty)'}`);
    }

    const travelerName = resolveTravelerName(customer);
    const finalOutputPath = resolveOutputPath({ outputDir, outputPath, travelerName });
    await templateFillService.fillTemplate({
      workingTemplatePath: templatePath,
      outputPath: finalOutputPath,
      travelerName,
      passportNumber: customer.passportNumber || customer.passportNoFinal || '',
      contactPhone: customer.contactPhone || '',
      receiptAmount: customer.receiptAmount || customer.receiptAmountFinal || customer.receiptAmountAuto || '',
      approvedAt,
    });

    return {
      outputPath: finalOutputPath,
      templatePath,
    };
  }

  return {
    exportCustomerBill,
  };
}

module.exports = {
  DEFAULT_BILLING_TEMPLATE_PATH,
  createBillingExportService,
};
