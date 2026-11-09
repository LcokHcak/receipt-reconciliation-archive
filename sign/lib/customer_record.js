const VALID_CUSTOMER_STATUSES = new Set([
  'draft',
  'ready_for_review',
  'in_review',
  'approved',
  'needs_rephoto',
  'template_generated',
]);

const ALLOWED_STATUS_TRANSITIONS = new Map([
  ['draft', new Set(['draft', 'ready_for_review'])],
  ['ready_for_review', new Set(['ready_for_review', 'in_review', 'needs_rephoto'])],
  ['in_review', new Set(['in_review', 'approved', 'needs_rephoto', 'ready_for_review'])],
  ['approved', new Set(['approved', 'template_generated'])],
  ['needs_rephoto', new Set(['needs_rephoto', 'ready_for_review', 'in_review'])],
  ['template_generated', new Set(['template_generated', 'in_review', 'needs_rephoto'])],
]);

function assertValidCustomerId(customerId) {
  if (!/^CL\d{8}-\d{3,4}$/.test(String(customerId || ''))) {
    throw new Error(`Invalid customer id: ${customerId}`);
  }
}

function assertValidCustomerStatus(status) {
  if (!VALID_CUSTOMER_STATUSES.has(status)) {
    throw new Error(`Invalid customer status: ${status}`);
  }
}

function assertValidCustomerStatusTransition(previousStatus, nextStatus) {
  assertValidCustomerStatus(previousStatus);
  assertValidCustomerStatus(nextStatus);
  const allowed = ALLOWED_STATUS_TRANSITIONS.get(previousStatus);
  if (!allowed || !allowed.has(nextStatus)) {
    throw new Error(`Invalid customer status transition: ${previousStatus} -> ${nextStatus}`);
  }
}

function createCustomerRecord({
  customerId,
  workspaceKey,
  monthKey,
  agentName,
  images = [],
  template = {},
  nowIso,
  ownerUserId = null,
  ownerUsername = null,
  createdBy = null,
}) {
  assertValidCustomerId(customerId);
  const status = 'ready_for_review';
  assertValidCustomerStatus(status);
  const normalizedWorkspaceKey = String(workspaceKey || monthKey || '').trim();

  return {
    customerId,
    status,
    agentName: String(agentName || '').trim(),
    workspaceKey: normalizedWorkspaceKey,
    monthKey: normalizedWorkspaceKey,
    displayName: null,
    passportNumber: null,
    ownerUserId: ownerUserId == null ? null : ownerUserId,
    ownerUsername: String(ownerUsername || '').trim() || null,
    createdBy: String(createdBy || ownerUsername || '').trim() || null,
    folderNameInitial: customerId,
    folderNameFinal: null,
    template: {
      templateVersion: template.templateVersion || 'receipt-template-v1',
      sourceTemplatePath: template.sourceTemplatePath || 'passport_review_workbench/templates/customer-receipt-template.xlsx',
      workingCopyPath: template.workingCopyPath || 'template/账单模板.xlsx',
      finalOutputPath: template.finalOutputPath || null,
      filledAt: template.filledAt || null,
    },
    images: Array.isArray(images) ? images : [],
    review: {
      lastBatchId: null,
      lastSourceGroupId: null,
      approvedAt: null,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

module.exports = {
  VALID_CUSTOMER_STATUSES,
  assertValidCustomerId,
  assertValidCustomerStatus,
  assertValidCustomerStatusTransition,
  createCustomerRecord,
};
