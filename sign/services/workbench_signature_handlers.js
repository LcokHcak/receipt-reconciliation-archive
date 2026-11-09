const { buildSignatureServicePayload: defaultBuildSignatureServicePayload } = require('./workbench_meta_service');

function sendPayload(res, payload) {
  return res.status(payload.status).json(payload.body);
}

function createWorkbenchSignatureHandlers({
  signatureSiteWorker,
  workbenchWriteService,
  buildSignatureServicePayload = defaultBuildSignatureServicePayload,
  loadBatch = null,
  assertBatchAccess = null,
} = {}) {
  if (!signatureSiteWorker) {
    throw new Error('signatureSiteWorker is required');
  }
  if (!workbenchWriteService) {
    throw new Error('workbenchWriteService is required');
  }

  function ensureBatchAccess(req) {
    if (!loadBatch || !assertBatchAccess) return;
    const batchId = String(req.params?.batchId || '').trim();
    if (!batchId) return;
    assertBatchAccess(loadBatch(batchId), req.user || null);
  }

  function isBatchAccessDenied(error) {
    return /batch access denied/.test(String(error?.message || error || ''));
  }

  async function openSignatureBrowser(_req, res) {
    try {
      const service = await signatureSiteWorker.openBrowser();
      return res.json(buildSignatureServicePayload(service));
    } catch (error) {
      return res.status(500).json({ error: String(error?.message || error) });
    }
  }

  async function closeSignatureBrowser(_req, res) {
    try {
      const service = await signatureSiteWorker.closeBrowser();
      return res.json(buildSignatureServicePayload(service));
    } catch (error) {
      return res.status(409).json({ error: String(error?.message || error) });
    }
  }

  async function queueTaskWebsiteSignature(req, res) {
    try {
      ensureBatchAccess(req);
      const payload = await workbenchWriteService.queueTaskWebsiteSignature({
        batchId: req.params.batchId,
        taskId: req.params.taskId,
      });
      return sendPayload(res, payload);
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return res.status(409).json({ error: String(error?.message || error) });
    }
  }

  async function queueBatchWebsiteSignatures(req, res) {
    try {
      ensureBatchAccess(req);
      const payload = await workbenchWriteService.queueBatchWebsiteSignatures({
        batchId: req.params.batchId,
      });
      return sendPayload(res, payload);
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return res.status(409).json({ error: String(error?.message || error) });
    }
  }

  async function deleteWebsiteSignature(req, res) {
    try {
      ensureBatchAccess(req);
      const payload = await workbenchWriteService.deleteWebsiteSignature({
        batchId: req.params.batchId,
        taskId: req.params.taskId,
      });
      return sendPayload(res, payload);
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return res.status(500).json({ error: String(error?.message || error) });
    }
  }

  async function saveManualSignature(req, res) {
    try {
      ensureBatchAccess(req);
      const payload = await workbenchWriteService.saveManualSignature({
        batchId: req.params.batchId,
        taskId: req.params.taskId,
        dataUrl: req.body?.dataUrl || '',
      });
      return sendPayload(res, payload);
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return res.status(500).json({ error: String(error?.message || error) });
    }
  }

  async function deleteManualSignature(req, res) {
    try {
      ensureBatchAccess(req);
      const payload = await workbenchWriteService.deleteManualSignature({
        batchId: req.params.batchId,
        taskId: req.params.taskId,
      });
      return sendPayload(res, payload);
    } catch (error) {
      if (isBatchAccessDenied(error)) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return res.status(500).json({ error: String(error?.message || error) });
    }
  }

  return {
    closeSignatureBrowser,
    deleteManualSignature,
    deleteWebsiteSignature,
    openSignatureBrowser,
    queueBatchWebsiteSignatures,
    queueTaskWebsiteSignature,
    saveManualSignature,
  };
}

module.exports = {
  createWorkbenchSignatureHandlers,
};
