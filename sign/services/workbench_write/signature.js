'use strict';

const { incrementTaskVersion } = require('../../lib/workbench_task_versioning');

const AUTO_SIGNATURE_QUEUE_STATUSES = new Set(['', 'idle']);

function createSignatureOperations({
  common,
  batchSubdirs,
  normalizeFieldValue,
  resolveTask,
  markClassificationConfirmed,
  removeFileIfExists,
  resolveBatchRelativePath,
  recalcTask,
  touchTask,
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
  createSignatureJob,
  signatureSiteWorker,
  clearWebsiteFinalSignatureAsset,
  manualSignatureSource,
  restoreAutomaticSignatureState,
  batchDir,
  pathModule,
  applyComputedFields,
  signatureProcessResult,
}) {
  const {
    error,
    hasBatch,
    loadBatch,
    ok,
    removeFileIfPresent,
    saveBatchAsync,
    summarizeBatch,
    withBatchWrite,
    writeFile,
  } = common;

  function canAutoQueueWebsiteSignature(task) {
    const signatureJobStatus = String(task?.signatureJobStatus || '').trim();
    return (
      AUTO_SIGNATURE_QUEUE_STATUSES.has(signatureJobStatus) &&
      String(task?.processResult || '').trim() === signatureProcessResult &&
      !String(task?.finalSignaturePath || '').trim() &&
      task?.finalSignatureSource !== manualSignatureSource &&
      isEligibleForWebsiteGeneration(task)
    );
  }

  async function queueAutomaticWebsiteSignature(batch, task) {
    if (!canAutoQueueWebsiteSignature(task)) {
      return {
        queued: false,
        reason: 'not_eligible',
      };
    }

    const queued = await signatureSiteWorker.queueJob(createSignatureJob(batch, task));
    if (queued.queued) {
      task.signatureJobStatus = 'queued';
      task.signatureJobError = '';
      recalcTask(task);
      touchTask(task);
    }

    return queued;
  }

  function buildWebsiteSignatureOverwriteCandidate(task) {
    return {
      ...task,
      finalSignaturePath: '',
      finalSignatureSource: '',
      signatureGeneratedAt: '',
      signatureJobStatus: task?.chineseNameFinal ? 'idle' : 'pending_name',
      signatureJobError: '',
    };
  }

  function clearFinalSignatureForWebsiteOverwrite(batch, task) {
    const finalSignaturePath = normalizeFieldValue(task.finalSignaturePath);
    if (finalSignaturePath) {
      removeFileIfExists(resolveBatchRelativePath(batch.id, finalSignaturePath));
    }
    task.finalSignaturePath = '';
    task.finalSignatureSource = '';
    task.signatureGeneratedAt = '';
    task.signatureJobError = '';
    task.signatureJobStatus = task.chineseNameFinal ? 'idle' : 'pending_name';
  }

  async function queueTaskWebsiteSignature({ batchId, taskId }) {
    return withBatchWrite(batchId, async () => { // label: queueTaskWebsiteSignature
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const task = resolveTask(batch, taskId);
      if (!task) {
        return error(404, { error: 'Task not found' });
      }

      if (['queued', 'generating'].includes(task.signatureJobStatus)) {
        return error(409, { error: 'Website signature task is still running. Please wait for it to finish.' });
      }

      const eligibilityIssue = getWebsiteSignatureEligibilityIssue(buildWebsiteSignatureOverwriteCandidate(task));
      if (eligibilityIssue) {
        return error(400, { error: eligibilityIssue });
      }

      const job = createSignatureJob(batch, task);
      const queued = await signatureSiteWorker.queueJob(job);
      if (queued.queued) {
        clearFinalSignatureForWebsiteOverwrite(batch, task);
        task.signatureJobStatus = 'queued';
        task.signatureJobError = '';
        recalcTask(task);
        touchTask(task);
        await saveBatchAsync(batch);
      }

      return ok({
        ok: true,
        queued: queued.queued,
        reason: queued.reason || '',
        service: queued.state,
        task: applyComputedFields(batch, task),
      });
    }, { label: 'queueTaskWebsiteSignature' });
  }

  async function queueBatchWebsiteSignatures({ batchId }) {
    return withBatchWrite(batchId, async () => { // label: queueBatchWebsiteSignatures
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const eligibleTasks = batch.tasks.filter((task) => isEligibleForWebsiteGeneration(task));

      if (eligibleTasks.length === 0) {
        return ok({
          ok: true,
          queuedCount: 0,
          service: signatureSiteWorker.getState(),
          batch: summarizeBatch(batch, { includeTasks: true }),
        });
      }

      const jobs = eligibleTasks.map((task) => createSignatureJob(batch, task));
      const queued = await signatureSiteWorker.queueJobs(jobs);
      const queuedKeys = new Set(
        (queued.results || [])
          .filter((result) => result.queued)
          .map((result, index) => jobs[index]?.taskKey)
          .filter(Boolean)
      );

      batch.tasks.forEach((task) => {
        const taskKey = `${batch.id}:${task.id}`;
        if (queuedKeys.has(taskKey)) {
          task.signatureJobStatus = 'queued';
          task.signatureJobError = '';
          recalcTask(task);
          touchTask(task);
        }
      });
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        queuedCount: queued.queuedCount,
        service: queued.state,
        batch: summarizeBatch(batch, { includeTasks: true }),
      });
    }, { label: 'queueBatchWebsiteSignatures' });
  }

  async function deleteWebsiteSignature({ batchId, taskId }) {
    return withBatchWrite(batchId, async () => { // label: deleteWebsiteSignature
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const task = resolveTask(batch, taskId);
      if (!task) {
        return error(404, { error: 'Task not found' });
      }

      if (task.finalSignatureSource === manualSignatureSource) {
        return error(400, { error: 'Current final signature is handwritten. Use the handwritten delete action instead.' });
      }

      if (['queued', 'generating'].includes(task.signatureJobStatus)) {
        return error(409, { error: 'Website signature task is still running. Please wait for it to finish.' });
      }

      clearWebsiteFinalSignatureAsset(batch.id, task);
      recalcTask(task);
      incrementTaskVersion(task);
      touchTask(task);
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        task: applyComputedFields(batch, task),
      });
    }, { label: 'deleteWebsiteSignature' });
  }

  async function saveManualSignature({ batchId, taskId, dataUrl }) {
    return withBatchWrite(batchId, async () => { // label: saveManualSignature
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const task = resolveTask(batch, taskId);
      if (!task) {
        return error(404, { error: 'Task not found' });
      }

      const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl || '');
      if (!match) {
        return error(400, { error: 'Invalid signature payload' });
      }

      const dirs = batchSubdirs(batch.id);
      const fileName = `${task.id}__manual_signature.png`;
      const relative = pathModule.join('final_signatures', fileName);

      clearWebsiteFinalSignatureAsset(batch.id, task);
      await writeFile(
        pathModule.join(dirs.finalSignatures, fileName),
        Buffer.from(match[1], 'base64')
      );

      task.finalSignaturePath = relative;
      task.finalSignatureSource = manualSignatureSource;
      task.rephotoRequested = false;
      markClassificationConfirmed(task);
      recalcTask(task);
      incrementTaskVersion(task);
      touchTask(task);
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        task: applyComputedFields(batch, task),
      });
    }, { label: 'saveManualSignature' });
  }

  async function deleteManualSignature({ batchId, taskId }) {
    return withBatchWrite(batchId, async () => { // label: deleteManualSignature
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const task = resolveTask(batch, taskId);
      if (!task) {
        return error(404, { error: 'Task not found' });
      }

      if (task.finalSignatureSource === manualSignatureSource && task.finalSignaturePath) {
        const fullPath = pathModule.join(batchDir(batch.id), task.finalSignaturePath);
        await removeFileIfPresent(fullPath);
      }

      restoreAutomaticSignatureState(batch.id, task);
      recalcTask(task);
      incrementTaskVersion(task);
      touchTask(task);
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        task: applyComputedFields(batch, task),
      });
    }, { label: 'deleteManualSignature' });
  }

  return {
    deleteManualSignature,
    deleteWebsiteSignature,
    queueAutomaticWebsiteSignature,
    queueBatchWebsiteSignatures,
    queueTaskWebsiteSignature,
    saveManualSignature,
  };
}

module.exports = {
  createSignatureOperations,
};
