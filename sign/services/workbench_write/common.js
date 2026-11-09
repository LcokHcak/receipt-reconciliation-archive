'use strict';

function createCommon({
  withBatchWrite,
  hasBatch,
  loadBatch,
  saveBatchAsync,
  summarizeBatch,
  fileSystem,
  removeBatchProjection,
  onProjectionRemoveError,
}) {
  function ok(body) {
    return {
      status: 200,
      body,
    };
  }

  function error(status, body) {
    return {
      status,
      body,
    };
  }

  function removeProjectionSafely(batchId) {
    try {
      removeBatchProjection(batchId);
    } catch (projectionError) {
      onProjectionRemoveError(projectionError, batchId);
    }
  }

  async function writeFile(filePath, contents) {
    if (fileSystem.promises?.writeFile) {
      await fileSystem.promises.writeFile(filePath, contents);
      return;
    }
    if (fileSystem.writeFile) {
      await new Promise((resolve, reject) => {
        fileSystem.writeFile(filePath, contents, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return;
    }
    fileSystem.writeFileSync(filePath, contents);
  }

  async function removeFileIfPresent(filePath) {
    if (fileSystem.promises?.rm) {
      await fileSystem.promises.rm(filePath, { force: true });
      return;
    }
    if (fileSystem.promises?.unlink) {
      try {
        await fileSystem.promises.unlink(filePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') {
          throw unlinkError;
        }
      }
      return;
    }
    if (fileSystem.existsSync(filePath)) {
      fileSystem.unlinkSync(filePath);
    }
  }

  return {
    error,
    hasBatch,
    loadBatch,
    ok,
    removeFileIfPresent,
    removeProjectionSafely,
    saveBatchAsync,
    summarizeBatch,
    withBatchWrite,
    writeFile,
  };
}

module.exports = {
  createCommon,
};
