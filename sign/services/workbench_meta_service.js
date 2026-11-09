const { buildWorkflowMeta } = require('../lib/workbench_definition');

function buildWorkbenchStatePayload({ rootDir, batches, signatureService, customerLibrary = null }) {
  const workflowMeta = buildWorkflowMeta();
  return {
    rootDir,
    batches,
    customerLibrary,
    signatureService,
    signatureStyleOptions: [...workflowMeta.signature.styleOptions],
    workflowMeta,
  };
}

function buildSignatureServicePayload(service) {
  const workflowMeta = buildWorkflowMeta();
  return {
    ok: true,
    service,
    styleOptions: [...workflowMeta.signature.styleOptions],
    workflowMeta,
  };
}

module.exports = {
  buildSignatureServicePayload,
  buildWorkbenchStatePayload,
};
