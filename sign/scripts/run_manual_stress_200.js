const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3218';
const DEFAULT_SAMPLE_ROOT = path.resolve(__dirname, '..', '..', 'data_sample');
const DEFAULT_COUNT = 200;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function parseArgs(argv) {
  const phase = argv[2] || 'help';
  const args = {
    phase,
    baseUrl: DEFAULT_BASE_URL,
    sampleRoot: DEFAULT_SAMPLE_ROOT,
    count: DEFAULT_COUNT,
    seed: 20260501,
    workspace: '',
    workspaceProvided: false,
    runId: '',
    batchId: '',
    batchTimeoutMs: 90 * 60 * 1000,
    pollMs: 3000,
    preprocessMode: 'mix-only',
    export: false,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      index += 1;
    } else if (current === '--sample-root' && next) {
      args.sampleRoot = path.resolve(next);
      index += 1;
    } else if (current === '--count' && next) {
      args.count = Math.max(1, Number.parseInt(next, 10) || DEFAULT_COUNT);
      index += 1;
    } else if (current === '--seed' && next) {
      args.seed = Number.parseInt(next, 10) || args.seed;
      index += 1;
    } else if (current === '--workspace' && next) {
      args.workspace = next;
      args.workspaceProvided = true;
      index += 1;
    } else if (current === '--run-id' && next) {
      args.runId = next;
      index += 1;
    } else if (current === '--batch-id' && next) {
      args.batchId = next;
      index += 1;
    } else if (current === '--batch-timeout-ms' && next) {
      args.batchTimeoutMs = Math.max(10000, Number.parseInt(next, 10) || args.batchTimeoutMs);
      index += 1;
    } else if (current === '--poll-ms' && next) {
      args.pollMs = Math.max(1000, Number.parseInt(next, 10) || args.pollMs);
      index += 1;
    } else if (current === '--preprocess-mode' && next) {
      args.preprocessMode = ['all', 'mix-only', 'none'].includes(next) ? next : args.preprocessMode;
      index += 1;
    } else if (current === '--export') {
      args.export = true;
    }
  }

  if (!args.runId) {
    args.runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  }
  if (!args.workspace && args.phase === 'prepare') {
    args.workspace = `stress-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${args.count}`;
  }

  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createRunPaths(runId) {
  const runDir = path.resolve(__dirname, '..', 'agent_docs', 'e2e-runs', runId);
  ensureDir(runDir);
  return {
    runDir,
    statePath: path.join(runDir, 'manual_stress_state.json'),
    logPath: path.join(runDir, 'manual_stress.log'),
    prepareReportPath: path.join(runDir, 'prepare_report.md'),
    baselinePath: path.join(runDir, 'baseline_tasks.json'),
    baselineReportPath: path.join(runDir, 'baseline_report.md'),
    finalReportPath: path.join(runDir, 'final_accuracy_report.md'),
  };
}

function createLogger(logPath) {
  return function log(event, data = {}) {
    const payload = {
      at: new Date().toISOString(),
      event,
      ...data,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
    console.log(`[${payload.at}] ${event} ${JSON.stringify(data)}`);
  };
}

function listImages(dirPath) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Sample folder not found: ${dirPath}`);
  }
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

function makeRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne(files, random) {
  if (!files.length) {
    throw new Error('Cannot pick from an empty image folder');
  }
  return files[Math.floor(random() * files.length) % files.length];
}

function buildCustomerPlans(count, samples, random) {
  const plans = [];
  for (let index = 0; index < count; index += 1) {
    const serial = index + 1;
    const bucket = random();
    let kinds;
    if (bucket < 0.40) {
      kinds = ['mix'];
    } else if (bucket < 0.70) {
      kinds = ['passport', 'receipt'];
    } else if (bucket < 0.90) {
      kinds = ['passport', 'receipt', 'other'];
    } else {
      kinds = ['passport', 'receipt', 'receipt'];
    }
    plans.push({
      serial,
      agentName: `Stress Agent ${String(serial).padStart(3, '0')}`,
      files: kinds.map((kind, fileIndex) => ({
        kind,
        fileIndex,
        path: pickOne(samples[kind], random),
      })),
    });
  }
  return plans;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function requestJson(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || text || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function saveJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizePlan(plans) {
  const counts = {};
  plans.forEach((plan) => {
    plan.files.forEach((file) => {
      counts[file.kind] = (counts[file.kind] || 0) + 1;
    });
  });
  return {
    customers: plans.length,
    files: plans.reduce((sum, plan) => sum + plan.files.length, 0),
    counts,
  };
}

function isActionableImage(image = {}) {
  return isImageReviewRelevant(image) && !isImageAcceptedForReview(image);
}

function isRawUploadedImage(image = {}) {
  return !image.autoSplitRole && !image.preprocessStatus;
}

function isImageReviewRelevant(image = {}) {
  if (image.autoSplitRole === 'original') {
    return false;
  }
  if (isRawUploadedImage(image)) {
    return false;
  }
  return true;
}

function isImageAcceptedForReview(image = {}) {
  if (String(image.reviewStatus || '').trim() === 'accepted') {
    return true;
  }
  return isRawUploadedImage(image);
}

function countImageReviewState(customers = []) {
  let total = 0;
  let pending = 0;
  let accepted = 0;
  let failed = 0;
  customers.forEach((customer) => {
    (customer.images || []).forEach((image) => {
      if (!isImageReviewRelevant(image)) {
        return;
      }
      total += 1;
      if (isImageAcceptedForReview(image)) {
        accepted += 1;
      } else {
        pending += 1;
      }
      if (image.preprocessStatus === 'failed' || image.error) {
        failed += 1;
      }
    });
  });
  return { total, accepted, pending, failed };
}

function inferExpectedDocType(value) {
  const text = String(value || '').toLowerCase();
  if (/(^|[_\-\s])passport($|[_\-\s])|passport_region|_passport_|\bpassport\b/.test(text)) {
    return 'passport';
  }
  if (/(^|[_\-\s])receipt($|[_\-\s])|receipt_region|_receipt_|\breceipt\b/.test(text)) {
    return 'receipt';
  }
  if (/(^|[_\-\s])(other|ohter)($|[_\-\s])|\bother\b|\bohter\b/.test(text)) {
    return 'other';
  }
  return '';
}

function getTaskExpectedDocType(task = {}) {
  return inferExpectedDocType(task.sourceFileName)
    || inferExpectedDocType(task.originalFileName)
    || inferExpectedDocType(task.sourceOriginalPath);
}

function normalizeDocType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ticket') return 'other';
  if (['passport', 'receipt', 'other'].includes(normalized)) return normalized;
  return '';
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeCompare(field, value) {
  const text = normalizeText(value);
  if (field === 'chineseName') {
    return text.replace(/[^\u3400-\u9fff]/gu, '');
  }
  if (field === 'englishName') {
    return text.toUpperCase().replace(/[^A-Z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (field === 'passportNo') {
    return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  if (field.endsWith('Date')) {
    return text.replace(/[./]/g, '-');
  }
  return text.toUpperCase();
}

function snapshotTasks(batch = {}) {
  return (batch.tasks || []).map((task) => ({
    id: task.id,
    sourceGroupKey: task.sourceGroupKey || '',
    originalFileName: task.originalFileName || '',
    sourceFileName: task.sourceFileName || '',
    expectedDocType: getTaskExpectedDocType(task),
    docTypeAuto: task.docTypeAuto || '',
    docTypeFinal: task.docTypeFinal || '',
    docTypeConfidence: task.docTypeConfidence || 0,
    classificationSource: task.classificationSource || '',
    needsReview: Boolean(task.needsReview),
    reviewReasons: task.reviewReasons || [],
    passportFieldModelUsed: Boolean(task.passportFieldModelUsed),
    auto: {
      englishName: task.extractedNameAuto || '',
      chineseName: task.chineseNameAuto || '',
      passportNo: task.passportNoAuto || '',
      receiptStore: task.receiptStoreAuto || '',
      receiptNo: task.receiptNoAuto || '',
      groupNo: task.groupNoAuto || '',
      purchaseDate: task.purchaseDateAuto || '',
      departureDate: task.departureDateAuto || '',
      receiptAmount: task.receiptAmountAuto || '',
    },
    final: {
      englishName: task.extractedNameFinal || '',
      chineseName: task.chineseNameFinal || '',
      passportNo: task.passportNoFinal || '',
      receiptStore: task.receiptStoreFinal || '',
      receiptNo: task.receiptNoFinal || '',
      groupNo: task.groupNoFinal || '',
      purchaseDate: task.purchaseDateFinal || '',
      departureDate: task.departureDateFinal || '',
      receiptAmount: task.receiptAmountFinal || task.receiptAmountAuto || '',
    },
  }));
}

function computeBaselineMetrics(tasks = []) {
  const counted = tasks.filter((task) => task.expectedDocType);
  const classificationCorrect = counted.filter((task) => normalizeDocType(task.docTypeAuto) === task.expectedDocType).length;
  const passportTasks = tasks.filter((task) => normalizeDocType(task.docTypeFinal || task.docTypeAuto) === 'passport');
  const receiptTasks = tasks.filter((task) => normalizeDocType(task.docTypeFinal || task.docTypeAuto) === 'receipt');
  const passportComplete = passportTasks.filter((task) => task.auto.englishName && task.auto.chineseName && task.auto.passportNo).length;
  const receiptComplete = receiptTasks.filter((task) => (
    task.auto.receiptStore && task.auto.receiptNo && task.auto.groupNo && task.auto.purchaseDate && task.auto.departureDate
  )).length;
  return {
    totalTasks: tasks.length,
    classification: {
      tested: counted.length,
      correct: classificationCorrect,
      accuracy: counted.length ? classificationCorrect / counted.length : 0,
      modelSource: counted.filter((task) => task.classificationSource === 'model').length,
      needsReview: counted.filter((task) => task.needsReview).length,
    },
    passportFields: {
      tested: passportTasks.length,
      complete: passportComplete,
      completeRate: passportTasks.length ? passportComplete / passportTasks.length : 0,
      passportFieldModelUsed: passportTasks.filter((task) => task.passportFieldModelUsed).length,
    },
    receiptFields: {
      tested: receiptTasks.length,
      complete: receiptComplete,
      completeRate: receiptTasks.length ? receiptComplete / receiptTasks.length : 0,
    },
  };
}

function computeFinalAccuracy(baselineTasks, finalBatch) {
  const finalById = new Map(snapshotTasks(finalBatch).map((task) => [task.id, task]));
  const fields = {
    passport: ['englishName', 'chineseName', 'passportNo'],
    receipt: ['receiptStore', 'receiptNo', 'groupNo', 'purchaseDate', 'departureDate', 'receiptAmount'],
  };
  const result = {
    taskCount: 0,
    classification: { tested: 0, correct: 0, accuracy: 0 },
    passport: {},
    receipt: {},
    changedExamples: [],
  };

  Object.values(fields).flat().forEach((field) => {
    result.passport[field] = result.passport[field] || undefined;
    result.receipt[field] = result.receipt[field] || undefined;
  });

  function bump(group, field, ok, baselineValue, finalValue, task) {
    if (!result[group][field]) {
      result[group][field] = { tested: 0, correct: 0, blankAuto: 0, accuracy: 0 };
    }
    result[group][field].tested += 1;
    if (!normalizeText(baselineValue)) {
      result[group][field].blankAuto += 1;
    }
    if (ok) {
      result[group][field].correct += 1;
    } else if (result.changedExamples.length < 50) {
      result.changedExamples.push({
        taskId: task.id,
        sourceGroupKey: task.sourceGroupKey,
        docType: group,
        field,
        auto: baselineValue,
        final: finalValue,
        file: task.originalFileName,
      });
    }
  }

  baselineTasks.forEach((baseline) => {
    const current = finalById.get(baseline.id);
    if (!current) {
      return;
    }
    result.taskCount += 1;
    const finalDocType = normalizeDocType(current.docTypeFinal || current.docTypeAuto);
    if (finalDocType) {
      result.classification.tested += 1;
      if (normalizeDocType(baseline.docTypeAuto) === finalDocType) {
        result.classification.correct += 1;
      }
    }
    if (finalDocType === 'passport') {
      fields.passport.forEach((field) => {
        const autoValue = baseline.auto[field];
        const finalValue = current.final[field] || current.auto[field];
        const ok = normalizeCompare(field, autoValue) === normalizeCompare(field, finalValue);
        bump('passport', field, ok, autoValue, finalValue, baseline);
      });
    } else if (finalDocType === 'receipt') {
      fields.receipt.forEach((field) => {
        const autoValue = baseline.auto[field];
        const finalValue = current.final[field] || current.auto[field];
        const ok = normalizeCompare(field, autoValue) === normalizeCompare(field, finalValue);
        bump('receipt', field, ok, autoValue, finalValue, baseline);
      });
    }
  });

  result.classification.accuracy = result.classification.tested
    ? result.classification.correct / result.classification.tested
    : 0;
  ['passport', 'receipt'].forEach((group) => {
    Object.values(result[group]).filter(Boolean).forEach((item) => {
      item.accuracy = item.tested ? item.correct / item.tested : 0;
    });
  });
  return result;
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function _ms(value) { // 备用,_=有意保留未用
  const numeric = Number(value || 0);
  if (numeric >= 60000) return `${(numeric / 60000).toFixed(2)} min`;
  return `${(numeric / 1000).toFixed(2)} s`;
}

async function phasePrepare(args, paths, log) {
  const startedAt = performance.now();
  const random = makeRandom(args.seed);
  const samples = {
    mix: listImages(path.join(args.sampleRoot, 'mix')),
    passport: listImages(path.join(args.sampleRoot, 'passport')),
    receipt: listImages(path.join(args.sampleRoot, 'receipt')),
    other: listImages(path.join(args.sampleRoot, 'ohter')),
  };
  const plans = buildCustomerPlans(args.count, samples, random);
  const planSummary = summarizePlan(plans);
  await requestJson(args.baseUrl, '/api/customer-library/workspaces', {
    method: 'POST',
    body: JSON.stringify({ workspaceKey: args.workspace }),
  });

  const customers = [];
  for (const plan of plans) {
    const form = new FormData();
    form.append('workspaceKey', args.workspace);
    form.append('agentName', plan.agentName);
    form.append('editManifest', JSON.stringify(plan.files.map(() => ({ mode: 'keep' }))));
    for (const file of plan.files) {
      const fileName = `${file.kind}__S${String(plan.serial).padStart(3, '0')}__${file.fileIndex}__${path.basename(file.path)}`;
      const blob = await fs.openAsBlob(file.path, { type: getMimeType(file.path) });
      form.append('files', blob, fileName);
    }
    const payload = await requestJson(args.baseUrl, '/api/customer-library/customers/upload', {
      method: 'POST',
      body: form,
    });
    customers.push({
      serial: plan.serial,
      customerId: payload.customer.customerId,
      files: plan.files.map((file) => ({ kind: file.kind, name: path.basename(file.path) })),
    });
    if (customers.length % 10 === 0 || customers.length === plans.length) {
      log('upload_progress', { uploaded: customers.length, total: plans.length });
    }
  }

  const preprocess = [];
  for (const customer of customers) {
    const hasMix = customer.files.some((file) => file.kind === 'mix');
    const shouldPreprocess = args.preprocessMode === 'all'
      || (args.preprocessMode === 'mix-only' && hasMix);
    if (!shouldPreprocess) {
      preprocess.push({
        customerId: customer.customerId,
        summary: {
          status: 'skipped',
          reason: args.preprocessMode === 'none' ? 'preprocess_disabled' : 'no_mix_input',
          inputImages: customer.files.length,
          outputImages: customer.files.length,
          splitImages: 0,
          failedImages: 0,
        },
      });
      if (preprocess.length % 10 === 0 || preprocess.length === customers.length) {
        log('preprocess_progress', {
          processed: preprocess.length,
          total: customers.length,
          splitImages: preprocess.reduce((sum, item) => sum + Number(item.summary.splitImages || 0), 0),
          failedImages: preprocess.reduce((sum, item) => sum + Number(item.summary.failedImages || 0), 0),
        });
      }
      continue;
    }
    const payload = await requestJson(
      args.baseUrl,
      `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers/${encodeURIComponent(customer.customerId)}/preprocess`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    preprocess.push({ customerId: customer.customerId, summary: payload.summary || {} });
    if (preprocess.length % 10 === 0 || preprocess.length === customers.length) {
      log('preprocess_progress', {
        processed: preprocess.length,
        total: customers.length,
        splitImages: preprocess.reduce((sum, item) => sum + Number(item.summary.splitImages || 0), 0),
        failedImages: preprocess.reduce((sum, item) => sum + Number(item.summary.failedImages || 0), 0),
      });
    }
  }

  const customersPayload = await requestJson(
    args.baseUrl,
    `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers`
  );
  const imageReview = countImageReviewState(customersPayload.customers || []);
  const state = {
    runId: args.runId,
    workspace: args.workspace,
    baseUrl: args.baseUrl,
    sampleRoot: args.sampleRoot,
    seed: args.seed,
    count: args.count,
    preprocessMode: args.preprocessMode,
    phase: 'prepared',
    createdAt: new Date().toISOString(),
    planSummary,
    customers,
    preprocess,
    imageReview,
    timings: {
      prepareMs: Math.round(performance.now() - startedAt),
    },
  };
  await saveJson(paths.statePath, state);
  await fsp.writeFile(paths.prepareReportPath, buildPrepareReport(state), 'utf8');
  log('prepare_done', { workspace: args.workspace, imageReview, statePath: paths.statePath });
}

function buildPrepareReport(state) {
  return `# ${state.count || state.planSummary?.customers || 0} Customer Manual Stress Prepare

Run ID: \`${state.runId}\`

Workspace: \`${state.workspace}\`

## Generated Data

- Customers: ${state.planSummary.customers}
- Uploaded files: ${state.planSummary.files}
- mix: ${state.planSummary.counts.mix || 0}
- passport: ${state.planSummary.counts.passport || 0}
- receipt: ${state.planSummary.counts.receipt || 0}
- other: ${state.planSummary.counts.other || 0}

## Image Review State

- Reviewable images: ${state.imageReview.total}
- Accepted: ${state.imageReview.accepted}
- Pending manual review: ${state.imageReview.pending}
- Failed/error images: ${state.imageReview.failed}

## Next Manual Step

Open \`${state.baseUrl}/app/\`, go to customer workspace \`${state.workspace}\`, check the image split/crop results, delete bad cuts if needed, then accept the images you want imported.

After manual confirmation, run:

\`\`\`powershell
node scripts/run_manual_stress_200.js continue-batch --run-id ${state.runId}
\`\`\`
`;
}

async function requireState(paths) {
  if (!fs.existsSync(paths.statePath)) {
    throw new Error(`State file not found: ${paths.statePath}`);
  }
  return loadJson(paths.statePath);
}

async function phaseContinueBatch(args, paths, log) {
  const state = await requireState(paths);
  const workspace = args.workspace || state.workspace;
  const customersPayload = await requestJson(
    args.baseUrl,
    `/api/customer-library/workspaces/${encodeURIComponent(workspace)}/customers`
  );
  const imageReview = countImageReviewState(customersPayload.customers || []);
  if (imageReview.pending > 0) {
    const pendingExamples = [];
    for (const customer of customersPayload.customers || []) {
      for (const image of customer.images || []) {
        if (isActionableImage(image) && pendingExamples.length < 20) {
          pendingExamples.push({
            customerId: customer.customerId,
            imageId: image.imageId,
            fileName: image.originalFileName || image.fileName || '',
            status: image.reviewStatus || '',
          });
        }
      }
    }
    await saveJson(path.join(paths.runDir, 'pending_images.json'), pendingExamples);
    throw new Error(`There are still ${imageReview.pending} unaccepted images. Review them first. Examples saved to pending_images.json`);
  }

  const importPayload = await requestJson(args.baseUrl, '/api/customer-library/import-workspace', {
    method: 'POST',
    body: JSON.stringify({
      workspaceKey: workspace,
      batchName: `${workspace} manual stress import`,
      // 2026-07-09 起建批次必须绑团号表:声明文件名即过闸(两步走 awaiting_upload)。
      groupCodeSourceFile: 'stress-groupcode-placeholder.xlsx',
    }),
  });
  const batchId = args.batchId || importPayload.batchId;
  log('batch_imported', { batchId });

  const startedAt = performance.now();
  let batch = null;
  while (performance.now() - startedAt < args.batchTimeoutMs) {
    batch = await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
    const counts = batch.counts || {};
    log('batch_poll', {
      machineState: batch.machineState,
      total: counts.total,
      queued: counts.queued,
      processing: counts.processing,
      completed: counts.completed,
      error: counts.error,
    });
    const active = Number(counts.queued || 0) + Number(counts.processing || 0);
    if (batch.machineState === 'completed' && active === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }
  if (!batch || batch.machineState !== 'completed') {
    throw new Error(`Batch did not complete within ${args.batchTimeoutMs}ms`);
  }

  const baselineTasks = snapshotTasks(batch);
  const baselineMetrics = computeBaselineMetrics(baselineTasks);
  await saveJson(paths.baselinePath, baselineTasks);
  state.phase = 'batch_completed';
  state.batchId = batchId;
  state.imageReview = imageReview;
  state.baselineMetrics = baselineMetrics;
  state.timings = {
    ...(state.timings || {}),
    batchMs: Math.round(performance.now() - startedAt),
  };
  await saveJson(paths.statePath, state);
  await fsp.writeFile(paths.baselineReportPath, buildBaselineReport(state), 'utf8');
  log('continue_batch_done', { batchId, baselineMetrics });
}

function buildBaselineReport(state) {
  const m = state.baselineMetrics || {};
  return `# Manual Stress Baseline

Run ID: \`${state.runId}\`

Workspace: \`${state.workspace}\`

Batch ID: \`${state.batchId}\`

## Before Human Field Review

- Total tasks: ${m.totalTasks || 0}
- Classification: ${m.classification?.correct || 0}/${m.classification?.tested || 0} (${pct(m.classification?.accuracy)})
- Model classification source count: ${m.classification?.modelSource || 0}
- Needs review count: ${m.classification?.needsReview || 0}
- Passport fields complete: ${m.passportFields?.complete || 0}/${m.passportFields?.tested || 0} (${pct(m.passportFields?.completeRate)})
- Passport field model used: ${m.passportFields?.passportFieldModelUsed || 0}
- Receipt fields complete: ${m.receiptFields?.complete || 0}/${m.receiptFields?.tested || 0} (${pct(m.receiptFields?.completeRate)})

## Next Manual Step

Open the batch in \`${state.baseUrl}/app/\`, review and correct fields manually, generate/confirm signatures, then final approve/export.

After that, run:

\`\`\`powershell
node scripts/run_manual_stress_200.js final-report --run-id ${state.runId} --export
\`\`\`
`;
}

async function phaseStatus(args, paths) {
  const state = await requireState(paths);
  const workspace = args.workspace || state.workspace;
  const customersPayload = await requestJson(
    args.baseUrl,
    `/api/customer-library/workspaces/${encodeURIComponent(workspace)}/customers`
  ).catch(() => null);
  const imageReview = customersPayload ? countImageReviewState(customersPayload.customers || []) : null;
  let batch = null;
  if (state.batchId) {
    batch = await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(state.batchId)}`).catch(() => null);
  }
  console.log(JSON.stringify({
    runId: state.runId,
    workspace,
    phase: state.phase,
    imageReview,
    batchId: state.batchId || '',
    batchCounts: batch?.counts || null,
    reports: {
      prepare: paths.prepareReportPath,
      baseline: paths.baselineReportPath,
      final: paths.finalReportPath,
    },
  }, null, 2));
}

async function phaseFinalReport(args, paths, log) {
  const state = await requireState(paths);
  const batchId = args.batchId || state.batchId;
  if (!batchId) {
    throw new Error('No batchId found. Run continue-batch first or pass --batch-id.');
  }
  if (!fs.existsSync(paths.baselinePath)) {
    throw new Error(`Baseline file not found: ${paths.baselinePath}`);
  }
  const baselineTasks = loadJson(paths.baselinePath);
  const batch = await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
  const accuracy = computeFinalAccuracy(baselineTasks, batch);
  const exports = {};
  if (args.export) {
    exports.workbook = await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(batchId)}/export`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    exports.batchTraining = await requestJson(args.baseUrl, `/api/batches/${encodeURIComponent(batchId)}/export-training-dataset`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch((error) => ({ ok: false, error: error.message }));
    exports.globalTraining = await requestJson(args.baseUrl, '/api/training-dataset/export-global', {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch((error) => ({ ok: false, error: error.message }));
  }
  state.phase = 'final_reported';
  state.finalAccuracy = accuracy;
  state.exports = exports;
  await saveJson(paths.statePath, state);
  await fsp.writeFile(paths.finalReportPath, buildFinalReport(state), 'utf8');
  log('final_report_done', { finalReportPath: paths.finalReportPath, accuracy });
}

function fieldRows(groupMetrics = {}) {
  return Object.entries(groupMetrics)
    .filter(([, item]) => item && typeof item === 'object')
    .map(([field, item]) => `| ${field} | ${item.correct}/${item.tested} | ${pct(item.accuracy)} | ${item.blankAuto} |`)
    .join('\n') || '| none | 0/0 | 0.0% | 0 |';
}

function buildFinalReport(state) {
  const a = state.finalAccuracy || {};
  const exports = state.exports || {};
  return `# 200 Customer Manual Stress Final Accuracy

Run ID: \`${state.runId}\`

Workspace: \`${state.workspace}\`

Batch ID: \`${state.batchId}\`

## Accuracy After Human Review

- Compared tasks: ${a.taskCount || 0}
- Classification: ${a.classification?.correct || 0}/${a.classification?.tested || 0} (${pct(a.classification?.accuracy)})

## Passport Field Accuracy

| Field | Correct/Tested | Accuracy | Blank auto |
|---|---:|---:|---:|
${fieldRows(a.passport)}

## Receipt Field Accuracy

| Field | Correct/Tested | Accuracy | Blank auto |
|---|---:|---:|---:|
${fieldRows(a.receipt)}

## Changed Examples

${(a.changedExamples || []).slice(0, 30).map((item) => `- ${item.taskId} ${item.docType}.${item.field}: auto=\`${item.auto || ''}\`, final=\`${item.final || ''}\`, file=\`${item.file || ''}\``).join('\n') || '- None'}

## Exports

- Workbook: ${exports.workbook?.xlsxUrl || exports.workbook?.csvUrl || 'not requested'}
- Batch training: ${exports.batchTraining?.indexUrl || exports.batchTraining?.error || 'not requested'}
- Global training: ${exports.globalTraining?.indexUrl || exports.globalTraining?.error || 'not requested'}
`;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run_manual_stress_200.js prepare --count 300 --workspace stress-20260505-300
  node scripts/run_manual_stress_200.js prepare --count 300 --workspace stress-20260505-300 --preprocess-mode mix-only
  node scripts/run_manual_stress_200.js prepare --count 200 --workspace stress-20260501-200
  node scripts/run_manual_stress_200.js status --run-id <runId>
  node scripts/run_manual_stress_200.js continue-batch --run-id <runId>
  node scripts/run_manual_stress_200.js final-report --run-id <runId> --export
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.phase === 'help' || args.phase === '--help' || args.phase === '-h') {
    printHelp();
    return;
  }
  const paths = createRunPaths(args.runId);
  const log = createLogger(paths.logPath);
  if (args.phase !== 'status') {
    log('phase_started', { phase: args.phase, runId: args.runId, workspace: args.workspace });
  }

  if (args.phase === 'prepare') {
    await phasePrepare(args, paths, log);
  } else if (args.phase === 'continue-batch') {
    await phaseContinueBatch(args, paths, log);
  } else if (args.phase === 'final-report') {
    await phaseFinalReport(args, paths, log);
  } else if (args.phase === 'status') {
    await phaseStatus(args, paths);
  } else {
    printHelp();
    throw new Error(`Unknown phase: ${args.phase}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
