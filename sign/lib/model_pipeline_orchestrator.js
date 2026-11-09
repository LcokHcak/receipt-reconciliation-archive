function normalizeStageName(stageName) {
  return String(stageName || '').trim();
}

function normalizeDurationMs(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : 0;
}

function normalizeErrorMessage(error) {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function normalizeStageTimings(stageTimings = {}) {
  const source = stageTimings && typeof stageTimings === 'object' ? stageTimings : {};
  return Object.entries(source).reduce((normalized, [stageName, timing]) => {
    const normalizedStageName = normalizeStageName(stageName);
    if (!normalizedStageName || !timing || typeof timing !== 'object') {
      return normalized;
    }

    normalized[normalizedStageName] = {
      runs: normalizeDurationMs(timing.runs),
      totalMs: normalizeDurationMs(timing.totalMs),
      lastMs: normalizeDurationMs(timing.lastMs),
      failedRuns: normalizeDurationMs(timing.failedRuns),
    };
    return normalized;
  }, {});
}

function recordStageTiming(progress, stageName, elapsedMs, { error } = {}) {
  if (!progress || typeof progress !== 'object') {
    return progress;
  }

  const normalizedStageName = normalizeStageName(stageName);
  if (!normalizedStageName) {
    return progress;
  }

  const stageTimings = normalizeStageTimings(progress.stageTimings);
  const previous = stageTimings[normalizedStageName] || {
    runs: 0,
    totalMs: 0,
    lastMs: 0,
    failedRuns: 0,
  };
  const durationMs = normalizeDurationMs(elapsedMs);
  const failed = Boolean(error);

  stageTimings[normalizedStageName] = {
    runs: previous.runs + 1,
    totalMs: previous.totalMs + durationMs,
    lastMs: durationMs,
    failedRuns: previous.failedRuns + (failed ? 1 : 0),
  };

  progress.stageTimings = stageTimings;
  if (failed) {
    progress.failedStage = normalizedStageName;
    progress.lastStageError = normalizeErrorMessage(error);
    progress.currentStage = normalizedStageName;
  } else {
    progress.lastCompletedStage = normalizedStageName;
    progress.currentStage = '';
  }

  return progress;
}

function createModelPipelineOrchestrator({ nowMs = () => Date.now() } = {}) {
  async function runStage(progress, stageName, action) {
    const normalizedStageName = normalizeStageName(stageName);
    if (progress && typeof progress === 'object') {
      progress.currentStage = normalizedStageName;
      progress.failedStage = '';
      progress.lastStageError = '';
    }

    const startedAt = nowMs();
    try {
      const result = await action();
      recordStageTiming(progress, normalizedStageName, nowMs() - startedAt);
      return result;
    } catch (error) {
      recordStageTiming(progress, normalizedStageName, nowMs() - startedAt, { error });
      throw error;
    }
  }

  async function runPersistedStage({ stageName, begin, action, finish }) {
    const normalizedStageName = normalizeStageName(stageName);
    if (typeof begin === 'function') {
      await begin(normalizedStageName);
    }

    const startedAt = nowMs();
    let result;
    try {
      result = await action();
    } catch (error) {
      if (typeof finish === 'function') {
        await finish({
          stageName: normalizedStageName,
          elapsedMs: nowMs() - startedAt,
          error,
        });
      }
      throw error;
    }

    if (typeof finish === 'function') {
      await finish({
        stageName: normalizedStageName,
        elapsedMs: nowMs() - startedAt,
        error: null,
      });
    }
    return result;
  }

  return {
    runStage,
    runPersistedStage,
  };
}

module.exports = {
  createModelPipelineOrchestrator,
  normalizeStageTimings,
  recordStageTiming,
};
