const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const sharp = require('sharp');

const {
  getTaskRequiredFieldChecks,
  normalizeDocType,
} = require('../lib/workbench_task_flow');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3218';
const DEFAULT_SAMPLE_ROOT = path.resolve(__dirname, '..', '..', 'data_sample');
const DEFAULT_WORKSPACE = `biztest-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-100`;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PROCESS_RESULTS = {
  APPROVED: '已通过',
  FINAL_REVIEW: '待终审',
  SIGNATURE: '待签字',
  FIELDS: '待补字段',
  CLASSIFY: '待分类确认',
  REPHOTO: '需重拍',
};

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    sampleRoot: DEFAULT_SAMPLE_ROOT,
    workspace: DEFAULT_WORKSPACE,
    count: 100,
    signatureTimeoutMs: 12 * 60 * 1000,
    batchTimeoutMs: 45 * 60 * 1000,
    pollMs: 2500,
    runId: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
    resumeExisting: false,
    preprocessMode: 'all',
    resumeBatchId: '',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--base-url' && next) {
      args.baseUrl = next.replace(/\/+$/, '');
      index += 1;
    } else if (current === '--sample-root' && next) {
      args.sampleRoot = path.resolve(next);
      index += 1;
    } else if (current === '--workspace' && next) {
      args.workspace = next;
      index += 1;
    } else if (current === '--count' && next) {
      args.count = Math.max(1, Number.parseInt(next, 10) || args.count);
      index += 1;
    } else if (current === '--signature-timeout-ms' && next) {
      args.signatureTimeoutMs = Math.max(10000, Number.parseInt(next, 10) || args.signatureTimeoutMs);
      index += 1;
    } else if (current === '--batch-timeout-ms' && next) {
      args.batchTimeoutMs = Math.max(10000, Number.parseInt(next, 10) || args.batchTimeoutMs);
      index += 1;
    } else if (current === '--run-id' && next) {
      args.runId = next;
      index += 1;
    } else if (current === '--resume-existing') {
      args.resumeExisting = true;
    } else if (current === '--preprocess-mode' && next) {
      args.preprocessMode = next;
      index += 1;
    } else if (current === '--resume-batch-id' && next) {
      args.resumeBatchId = next;
      index += 1;
    }
  }

  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function makeRotatingPicker(files) {
  let index = 0;
  return () => {
    if (!files.length) {
      throw new Error('Cannot pick from an empty sample folder');
    }
    const filePath = files[index % files.length];
    index += 1;
    return filePath;
  };
}

function inferCustomerPlanKinds(customer = {}) {
  const kinds = new Set();
  (customer.images || []).forEach((image) => {
    const text = [
      image.originalFileName,
      image.relativePath,
      image.source,
    ].join(' ').toLowerCase();
    if (text.includes('mix__')) kinds.add('mix');
    if (text.includes('passport__')) kinds.add('passport');
    if (text.includes('receipt__')) kinds.add('receipt');
    if (text.includes('other__') || text.includes('ohter__')) kinds.add('other');
  });
  return [...kinds];
}

function inferExpectedDocTypeFromName(value) {
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

function inferTaskExpectedDocType(task) {
  return inferExpectedDocTypeFromName(task.sourceFileName)
    || inferExpectedDocTypeFromName(task.originalFileName)
    || inferExpectedDocTypeFromName(task.sourceOriginalPath);
}

function inferTaskTargetDocType(task, selectedPassportTaskId) {
  if (task.id === selectedPassportTaskId) {
    return 'passport';
  }
  const expected = inferTaskExpectedDocType(task);
  if (expected === 'receipt') {
    return 'receipt';
  }
  if (expected === 'other') {
    return 'other';
  }
  const autoType = normalizeDocType(task.docTypeAuto || task.docTypeFinal || 'other');
  if (autoType === 'receipt') {
    return 'receipt';
  }
  return 'other';
}

function choosePassportTask(groupTasks) {
  return groupTasks.find((task) => normalizeDocType(task.docTypeAuto || task.docTypeFinal) === 'passport')
    || groupTasks.find((task) => inferTaskExpectedDocType(task) === 'passport')
    || groupTasks[0]
    || null;
}

function buildCustomerPlans(count, pickers) {
  const plans = [];
  for (let index = 0; index < count; index += 1) {
    const serial = index + 1;
    const bucket = index % 10;
    let kinds;
    if (bucket <= 2) {
      kinds = ['mix'];
    } else if (bucket <= 5) {
      kinds = ['passport', 'receipt'];
    } else if (bucket <= 7) {
      kinds = ['passport', 'other'];
    } else {
      kinds = ['passport', 'receipt', 'other'];
    }

    plans.push({
      serial,
      agentName: `Biz Agent ${String(serial).padStart(3, '0')}`,
      files: kinds.map((kind) => ({
        kind,
        path: pickers[kind](),
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
    const message = payload.error || payload.message || text || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function timed(metrics, name, action) {
  const startedAt = performance.now();
  return Promise.resolve()
    .then(action)
    .finally(() => {
      const durationMs = Math.round(performance.now() - startedAt);
      metrics.timings[name] = (metrics.timings[name] || 0) + durationMs;
    });
}

function createLogger(runDir) {
  const logPath = path.join(runDir, 'run.log');
  return {
    logPath,
    write(event, data = {}) {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        event,
        ...data,
      });
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
      console.log(`[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}`);
    },
  };
}

function normalizeFieldSummary(task) {
  const summary = getTaskRequiredFieldChecks(task);
  return {
    missing: summary.missingFields.length,
    invalid: summary.invalidFields.length,
    needsSignature: summary.needsSignature,
    hasFinalSignature: summary.hasFinalSignature,
  };
}

function computeModelMetrics(batch, preprocessResults, plans) {
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const sourcePlanKinds = new Map();
  plans.forEach((plan) => {
    sourcePlanKinds.set(plan.serial, plan.files.map((file) => file.kind));
  });

  const splitMixCustomers = preprocessResults.filter((item) => item.planKinds.includes('mix'));
  const splitSuccess = splitMixCustomers.filter((item) => Number(item.summary?.splitImages || 0) >= 2).length;
  const splitFailed = splitMixCustomers.length - splitSuccess;

  const classificationItems = tasks.map((task) => {
    const expected = inferTaskExpectedDocType(task);
    const actual = normalizeDocType(task.docTypeAuto || task.docTypeFinal || 'other');
    return {
      taskId: task.id,
      expected,
      actual,
      confidence: Number(task.docTypeConfidence || 0),
      source: task.classificationSource || '',
      needsReview: Boolean(task.needsReview),
      counted: Boolean(expected),
      success: Boolean(expected && expected === actual),
    };
  });
  const countedClassification = classificationItems.filter((item) => item.counted);
  const modelClassification = countedClassification.filter((item) => item.source === 'model');

  const passportTasks = tasks.filter((task) => normalizeDocType(task.docTypeFinal || task.docTypeAuto) === 'passport');
  const receiptTasks = tasks.filter((task) => normalizeDocType(task.docTypeFinal || task.docTypeAuto) === 'receipt');
  const passportAutoComplete = passportTasks.filter((task) => {
    const probe = {
      ...task,
      extractedNameFinal: '',
      passportNoFinal: '',
      chineseNameFinal: '',
    };
    const summary = getTaskRequiredFieldChecks(probe);
    return summary.missingFields.length === 0 && summary.invalidFields.length === 0;
  }).length;
  const receiptAutoComplete = receiptTasks.filter((task) => {
    const probe = {
      ...task,
      receiptStoreFinal: '',
      receiptNoFinal: '',
      groupNoFinal: '',
      purchaseDateFinal: '',
      departureDateFinal: '',
    };
    const summary = getTaskRequiredFieldChecks(probe);
    return summary.missingFields.length === 0 && summary.invalidFields.length === 0;
  }).length;

  return {
    splitDetection: {
      tested: splitMixCustomers.length,
      success: splitSuccess,
      failed: splitFailed,
      successRate: splitMixCustomers.length ? splitSuccess / splitMixCustomers.length : 0,
    },
    classification: {
      tested: countedClassification.length,
      modelTested: modelClassification.length,
      success: countedClassification.filter((item) => item.success).length,
      modelSuccess: modelClassification.filter((item) => item.success).length,
      lowConfidence: countedClassification.filter((item) => item.confidence > 0 && item.confidence < 0.8).length,
      needsReview: countedClassification.filter((item) => item.needsReview).length,
      successRate: countedClassification.length
        ? countedClassification.filter((item) => item.success).length / countedClassification.length
        : 0,
      modelSuccessRate: modelClassification.length
        ? modelClassification.filter((item) => item.success).length / modelClassification.length
        : 0,
    },
    fieldOcr: {
      passportTested: passportTasks.length,
      passportAutoComplete,
      passportAutoRate: passportTasks.length ? passportAutoComplete / passportTasks.length : 0,
      receiptTested: receiptTasks.length,
      receiptAutoComplete,
      receiptAutoRate: receiptTasks.length ? receiptAutoComplete / receiptTasks.length : 0,
      passportSecondPassUsed: passportTasks.filter((task) => task.passportSecondPassUsed).length,
      receiptSecondPassUsed: receiptTasks.filter((task) => task.receiptSecondPassUsed).length,
    },
    taskExamples: classificationItems.slice(0, 20),
  };
}

const CHINESE_SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤'.split('');
const CHINESE_GIVEN = '安明海文雅宁宇佳诚泽欣俊慧晨一然若晴思远子涵语桐嘉怡诗琪浩然梓轩雨泽'.split('');
const ENGLISH_GIVEN = [
  'ALICE', 'BRIAN', 'CINDY', 'DAVID', 'EMILY', 'FRANK', 'GRACE', 'HELEN', 'IRIS', 'JASON',
  'KELLY', 'LEO', 'MONICA', 'NANCY', 'OSCAR', 'PETER', 'QUEEN', 'RAY', 'SALLY', 'TONY',
];
const ENGLISH_FAMILY = [
  'KIM', 'LEE', 'PARK', 'CHOI', 'JUNG', 'KANG', 'CHO', 'YOON', 'JANG', 'LIM',
];

function buildPersonFields(index) {
  const surname = CHINESE_SURNAMES[index % CHINESE_SURNAMES.length];
  const first = CHINESE_GIVEN[(index * 2) % CHINESE_GIVEN.length];
  const second = CHINESE_GIVEN[(index * 2 + 7) % CHINESE_GIVEN.length];
  const chineseName = `${surname}${first}${second}`;
  const englishName = `${ENGLISH_GIVEN[index % ENGLISH_GIVEN.length]} ${ENGLISH_FAMILY[index % ENGLISH_FAMILY.length]}`;
  const passportNo = `E${String(26000000 + index).padStart(8, '0')}`;
  return { chineseName, englishName, passportNo };
}

function buildReceiptFields(index) {
  const stores = ['THE SHILLA', 'SHILLA IPARK', 'LOTTE'];
  const store = stores[index % stores.length];
  const receiptNo = store === 'LOTTE'
    ? String(20260430000000 + index).slice(0, 14)
    : String(2026043000000 + index).slice(0, 13);
  const groupNo = store === 'LOTTE'
    ? String(70000000 + index).slice(0, 8)
    : String(30000 + index).slice(0, 5);
  const day = String((index % 20) + 1).padStart(2, '0');
  return {
    receiptStoreFinal: store,
    receiptNoFinal: receiptNo,
    groupNoFinal: groupNo,
    purchaseDateFinal: `2026-04-${day}`,
    departureDateFinal: `2026-05-${day}`,
  };
}

function buildTaskPatch(task, targetDocType, groupIndex) {
  const body = {
    docTypeFinal: targetDocType,
    reviewNote: `E2E 真实业务压测：${targetDocType}`,
  };

  if (targetDocType === 'passport') {
    const person = buildPersonFields(groupIndex);
    Object.assign(body, {
      extractedNameFinal: person.englishName,
      passportNoFinal: person.passportNo,
      chineseNameFinal: person.chineseName,
    });
  } else if (targetDocType === 'receipt') {
    Object.assign(body, buildReceiptFields(groupIndex));
  }

  return body;
}

function groupTasksBySourceGroup(batch) {
  const groups = new Map();
  (batch.tasks || []).forEach((task) => {
    const key = String(task.sourceGroupKey || 'root').trim() || 'root';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(task);
  });
  return groups;
}

async function createManualSignatureDataUrl(label = 'manual') {
  const svg = `
    <svg width="420" height="160" viewBox="0 0 420 160" xmlns="http://www.w3.org/2000/svg">
      <rect width="420" height="160" fill="white" fill-opacity="0"/>
      <path d="M34 103 C90 18, 142 140, 214 62 S336 52, 386 98" fill="none" stroke="#0f172a" stroke-width="8" stroke-linecap="round"/>
      <path d="M62 119 C132 99, 218 128, 356 112" fill="none" stroke="#0f172a" stroke-width="5" stroke-linecap="round" opacity="0.75"/>
      <text x="34" y="145" font-size="12" fill="#475569">${label}</text>
    </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const runRoot = path.resolve(__dirname, '..', 'agent_docs', 'e2e-runs');
  const runDir = path.join(runRoot, args.runId);
  ensureDir(runDir);
  const logger = createLogger(runDir);
  const metrics = {
    args,
    timings: {},
    counts: {},
    errors: [],
    modelMetricsBeforeManual: null,
    signatureMetrics: {},
    exportResult: null,
    trainingExportResult: null,
    globalTrainingExportResult: null,
  };

  const baseUrl = args.baseUrl.replace(/\/+$/, '');
  logger.write('run_started', { runId: args.runId, workspace: args.workspace, count: args.count, baseUrl });

  const samples = {
    mix: listImages(path.join(args.sampleRoot, 'mix')),
    passport: listImages(path.join(args.sampleRoot, 'passport')),
    receipt: listImages(path.join(args.sampleRoot, 'receipt')),
    other: listImages(path.join(args.sampleRoot, 'ohter')),
  };
  Object.entries(samples).forEach(([kind, files]) => logger.write('sample_count', { kind, count: files.length }));
  const pickers = Object.fromEntries(Object.entries(samples).map(([kind, files]) => [kind, makeRotatingPicker(files)]));
  let plans = buildCustomerPlans(args.count, pickers);
  metrics.counts.plannedCustomers = plans.length;
  metrics.counts.plannedFiles = plans.reduce((sum, plan) => sum + plan.files.length, 0);

  await timed(metrics, 'ensureWorkspaceMs', async () => {
    await requestJson(baseUrl, '/api/customer-library/workspaces', {
      method: 'POST',
      body: JSON.stringify({ workspaceKey: args.workspace }),
    });
  });

  let uploadedCustomers = [];
  if (args.resumeExisting) {
    const existing = await requestJson(
      baseUrl,
      `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers`
    );
    uploadedCustomers = (existing.customers || []).map((customer, index) => ({
      serial: index + 1,
      customerId: customer.customerId,
      planKinds: inferCustomerPlanKinds(customer),
      fileCount: Array.isArray(customer.images) ? customer.images.length : 0,
      hasPreprocess: Boolean(customer.preprocess),
      preprocess: customer.preprocess || null,
    }));
    plans = uploadedCustomers.map((customer) => ({
      serial: customer.serial,
      files: customer.planKinds.map((kind) => ({ kind, path: '' })),
    }));
    metrics.counts.plannedCustomers = uploadedCustomers.length;
    metrics.counts.plannedFiles = uploadedCustomers.reduce((sum, customer) => sum + customer.fileCount, 0);
    logger.write('resume_existing_workspace', { customers: uploadedCustomers.length });
  } else {
    await timed(metrics, 'uploadMs', async () => {
      for (const plan of plans) {
        const form = new FormData();
        form.append('workspaceKey', args.workspace);
        form.append('agentName', plan.agentName);
        form.append('editManifest', JSON.stringify(plan.files.map(() => ({ mode: 'keep' }))));
        for (const file of plan.files) {
          const fileName = `${file.kind}__C${String(plan.serial).padStart(3, '0')}__${path.basename(file.path)}`;
          const blob = await fs.openAsBlob(file.path, { type: getMimeType(file.path) });
          form.append('files', blob, fileName);
        }
        const payload = await requestJson(baseUrl, '/api/customer-library/customers/upload', {
          method: 'POST',
          body: form,
        });
        uploadedCustomers.push({
          serial: plan.serial,
          customerId: payload.customer.customerId,
          planKinds: plan.files.map((file) => file.kind),
          fileCount: plan.files.length,
        });
        if (uploadedCustomers.length % 10 === 0 || uploadedCustomers.length === plans.length) {
          logger.write('upload_progress', { uploaded: uploadedCustomers.length, total: plans.length });
        }
      }
    });
  }
  metrics.counts.uploadedCustomers = uploadedCustomers.length;

  const preprocessResults = [];
  await timed(metrics, 'preprocessMs', async () => {
    for (const customer of uploadedCustomers) {
      if (customer.preprocess) {
        preprocessResults.push({
          ...customer,
          summary: customer.preprocess,
          durationMs: 0,
          reused: true,
        });
        continue;
      }
      const shouldPreprocess =
        args.preprocessMode === 'all'
        || (args.preprocessMode === 'mix-only' && customer.planKinds.includes('mix'));
      if (!shouldPreprocess) {
        preprocessResults.push({
          ...customer,
          summary: {
            status: 'skipped_single_document',
            inputImages: customer.fileCount,
            outputImages: customer.fileCount,
            splitImages: 0,
            failedImages: 0,
          },
          durationMs: 0,
          skipped: true,
        });
        if (preprocessResults.length % 10 === 0 || preprocessResults.length === uploadedCustomers.length) {
          logger.write('preprocess_progress', {
            processed: preprocessResults.length,
            total: uploadedCustomers.length,
            splitImages: preprocessResults.reduce((sum, item) => sum + Number(item.summary?.splitImages || 0), 0),
            failedImages: preprocessResults.reduce((sum, item) => sum + Number(item.summary?.failedImages || 0), 0),
          });
        }
        continue;
      }
      const startedAt = performance.now();
      const payload = await requestJson(
        baseUrl,
        `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers/${encodeURIComponent(customer.customerId)}/preprocess`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      preprocessResults.push({
        ...customer,
        summary: payload.summary,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (preprocessResults.length % 10 === 0 || preprocessResults.length === uploadedCustomers.length) {
        logger.write('preprocess_progress', {
          processed: preprocessResults.length,
          total: uploadedCustomers.length,
          splitImages: preprocessResults.reduce((sum, item) => sum + Number(item.summary?.splitImages || 0), 0),
          failedImages: preprocessResults.reduce((sum, item) => sum + Number(item.summary?.failedImages || 0), 0),
        });
      }
    }
  });

  let customersPayload = await requestJson(
    baseUrl,
    `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers`
  );
  let confirmedImages = 0;
  await timed(metrics, 'imageConfirmMs', async () => {
    for (const customer of customersPayload.customers || []) {
      for (const image of customer.images || []) {
        if (image.autoSplitRole === 'original') {
          continue;
        }
        if (String(image.reviewStatus || '') === 'accepted') {
          continue;
        }
        await requestJson(
          baseUrl,
          `/api/customer-library/workspaces/${encodeURIComponent(args.workspace)}/customers/${encodeURIComponent(customer.customerId)}/images/${encodeURIComponent(image.imageId)}/review`,
          { method: 'POST', body: JSON.stringify({ status: 'accepted' }) }
        );
        confirmedImages += 1;
      }
    }
  });
  metrics.counts.confirmedImages = confirmedImages;
  logger.write('image_confirmation_done', { confirmedImages });

  let batchId = args.resumeBatchId;
  if (batchId) {
    logger.write('resume_existing_batch', { batchId });
  } else {
    const importPayload = await timed(metrics, 'importWorkspaceMs', () => requestJson(
      baseUrl,
      '/api/customer-library/import-workspace',
      {
        method: 'POST',
        body: JSON.stringify({
          workspaceKey: args.workspace,
          batchName: `${args.workspace} 客户导入`,
          // 2026-07-09 起建批次必须绑团号表:声明文件名即过闸(两步走 awaiting_upload)。
          groupCodeSourceFile: 'e2e-groupcode-placeholder.xlsx',
        }),
      }
    ));
    batchId = importPayload.batchId;
  }
  metrics.batchId = batchId;
  logger.write('batch_imported', { batchId });

  const batchStartedAt = performance.now();
  let batch = null;
  while (performance.now() - batchStartedAt < args.batchTimeoutMs) {
    batch = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
    const counts = batch.counts || {};
    logger.write('batch_poll', {
      machineState: batch.machineState,
      total: counts.total,
      queued: counts.queued,
      processing: counts.processing,
      completed: counts.completed,
      error: counts.error,
      fields: counts.fields,
      signature: counts.signature,
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
  metrics.timings.batchOcrAndClassificationMs = Math.round(performance.now() - batchStartedAt);
  metrics.modelMetricsBeforeManual = computeModelMetrics(batch, preprocessResults, plans);

  await timed(metrics, 'manualFieldCorrectionMs', async () => {
    const groups = groupTasksBySourceGroup(batch);
    let groupIndex = 0;
    for (const [, tasks] of groups) {
      groupIndex += 1;
      const selectedPassport = choosePassportTask(tasks);
      for (const task of tasks) {
        const targetDocType = inferTaskTargetDocType(task, selectedPassport?.id || '');
        const patchBody = buildTaskPatch(task, targetDocType, groupIndex);
        await requestJson(
          baseUrl,
          `/api/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: JSON.stringify(patchBody) }
        );
      }
      if (groupIndex % 10 === 0 || groupIndex === groups.size) {
        logger.write('field_correction_progress', { groups: groupIndex, total: groups.size });
      }
    }
  });

  await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}/queue-website-signatures`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).catch((error) => {
    logger.write('signature_batch_queue_warning', { error: error.message });
  });

  const signatureStartedAt = performance.now();
  let signaturePoll = null;
  while (performance.now() - signatureStartedAt < args.signatureTimeoutMs) {
    signaturePoll = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
    const passportTasks = (signaturePoll.tasks || []).filter((task) => normalizeDocType(task.docTypeFinal) === 'passport');
    const done = passportTasks.filter((task) => String(task.finalSignaturePath || '').trim()).length;
    const failed = passportTasks.filter((task) => task.signatureJobStatus === 'failed').length;
    const active = passportTasks.filter((task) => ['queued', 'generating', 'idle'].includes(String(task.signatureJobStatus || '')) && !String(task.finalSignaturePath || '').trim()).length;
    logger.write('signature_poll', { passportTasks: passportTasks.length, done, failed, active });
    if (passportTasks.length > 0 && done + failed >= passportTasks.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }
  metrics.timings.signatureGenerationMs = Math.round(performance.now() - signatureStartedAt);

  signaturePoll = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
  let passportTasks = (signaturePoll.tasks || []).filter((task) => normalizeDocType(task.docTypeFinal) === 'passport');
  const failedSignatureTasks = passportTasks.filter((task) => !String(task.finalSignaturePath || '').trim());
  let manualSignatureFallbacks = 0;
  for (const task of failedSignatureTasks) {
    await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(task.id)}/queue-website-signature`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch((error) => logger.write('signature_retry_warning', { taskId: task.id, error: error.message }));
  }

  if (failedSignatureTasks.length) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(30000, args.signatureTimeoutMs / 4)));
    signaturePoll = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
    passportTasks = (signaturePoll.tasks || []).filter((task) => normalizeDocType(task.docTypeFinal) === 'passport');
    const stillMissing = passportTasks.filter((task) => !String(task.finalSignaturePath || '').trim());
    for (const task of stillMissing) {
      const dataUrl = await createManualSignatureDataUrl(task.chineseNameFinal || task.id);
      await requestJson(
        baseUrl,
        `/api/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(task.id)}/manual-signature`,
        { method: 'POST', body: JSON.stringify({ dataUrl }) }
      );
      manualSignatureFallbacks += 1;
    }
  }

  signaturePoll = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
  passportTasks = (signaturePoll.tasks || []).filter((task) => normalizeDocType(task.docTypeFinal) === 'passport');
  metrics.signatureMetrics = {
    passportTasks: passportTasks.length,
    websiteGenerated: passportTasks.filter((task) => task.finalSignatureSource === 'website_generated' && task.finalSignaturePath).length,
    manualFallbacks: manualSignatureFallbacks,
    failed: passportTasks.filter((task) => !task.finalSignaturePath).length,
  };

  await timed(metrics, 'groupApprovalMs', async () => {
    let approvedGroups = 0;
    const groups = signaturePoll.sourceGroups || [];
    for (const group of groups) {
      try {
        await requestJson(
          baseUrl,
          `/api/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(group.key)}/approve`,
          { method: 'POST', body: JSON.stringify({}) }
        );
        approvedGroups += 1;
      } catch (error) {
        metrics.errors.push({
          stage: 'groupApproval',
          groupKey: group.key,
          error: error.message,
          payload: error.payload || null,
        });
        logger.write('group_approval_error', { groupKey: group.key, error: error.message, issue: error.payload?.issue || '' });
      }
      if (approvedGroups % 10 === 0 || approvedGroups === groups.length) {
        logger.write('group_approval_progress', { approvedGroups, total: groups.length });
      }
    }
    metrics.counts.approvedGroups = approvedGroups;
    metrics.counts.totalGroups = groups.length;
  });

  const finalBatch = await requestJson(baseUrl, `/api/batches/${encodeURIComponent(batchId)}`);
  metrics.finalCounts = finalBatch.counts;
  metrics.taskStateSummary = {
    total: finalBatch.tasks.length,
    approved: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.APPROVED).length,
    finalReview: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.FINAL_REVIEW).length,
    fields: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.FIELDS).length,
    signature: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.SIGNATURE).length,
    classify: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.CLASSIFY).length,
    rephoto: finalBatch.tasks.filter((task) => task.processResult === PROCESS_RESULTS.REPHOTO).length,
    unresolvedExamples: finalBatch.tasks
      .filter((task) => task.processResult !== PROCESS_RESULTS.APPROVED)
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        sourceGroupKey: task.sourceGroupKey,
        originalFileName: task.originalFileName,
        docTypeFinal: task.docTypeFinal,
        processResult: task.processResult,
        fieldSummary: normalizeFieldSummary(task),
        actionSuggestion: task.actionSuggestion,
      })),
  };

  metrics.exportResult = await timed(metrics, 'workbookExportMs', () => requestJson(
    baseUrl,
    `/api/batches/${encodeURIComponent(batchId)}/export`,
    { method: 'POST', body: JSON.stringify({}) }
  ));
  metrics.trainingExportResult = await timed(metrics, 'batchTrainingExportMs', () => requestJson(
    baseUrl,
    `/api/batches/${encodeURIComponent(batchId)}/export-training-dataset`,
    { method: 'POST', body: JSON.stringify({}) }
  ));
  metrics.globalTrainingExportResult = await timed(metrics, 'globalTrainingExportMs', () => requestJson(
    baseUrl,
    '/api/training-dataset/export-global',
    { method: 'POST', body: JSON.stringify({}) }
  ));

  const metricsPath = path.join(runDir, 'metrics.json');
  await fsp.writeFile(metricsPath, JSON.stringify(metrics, null, 2), 'utf8');
  const reportPath = path.join(runDir, 'report.md');
  await fsp.writeFile(reportPath, buildReport(metrics), 'utf8');
  logger.write('run_completed', { metricsPath, reportPath, batchId });
}

function pct(value) {
  const numeric = Number(value || 0);
  return `${(numeric * 100).toFixed(1)}%`;
}

function ms(value) {
  const numeric = Number(value || 0);
  if (numeric >= 60000) {
    return `${(numeric / 60000).toFixed(2)} min`;
  }
  return `${(numeric / 1000).toFixed(2)} s`;
}

function buildReport(metrics) {
  const model = metrics.modelMetricsBeforeManual || {};
  const split = model.splitDetection || {};
  const classification = model.classification || {};
  const field = model.fieldOcr || {};
  const signature = metrics.signatureMetrics || {};
  const timings = metrics.timings || {};
  const nonRecognitionMs =
    Number(timings.uploadMs || 0)
    + Number(timings.imageConfirmMs || 0)
    + Number(timings.manualFieldCorrectionMs || 0)
    + Number(timings.groupApprovalMs || 0)
    + Number(timings.workbookExportMs || 0)
    + Number(timings.batchTrainingExportMs || 0)
    + Number(timings.globalTrainingExportMs || 0);

  return `# Sign 真实业务链路压测报告

运行时间：${new Date().toLocaleString('zh-CN')}

## 范围

- 工作目录：${metrics.args.workspace}
- 客户数：${metrics.counts.uploadedCustomers || 0}
- 上传原图：${metrics.counts.plannedFiles || 0}
- 审核批次：${metrics.batchId || ''}
- 目标：从客户导入、模型预处理、图片确认、审核批次、字段补齐、外部签字、终审通过到导出。

## 跑通结论

- 批次任务数：${metrics.finalCounts?.total ?? 0}
- 已通过任务：${metrics.taskStateSummary?.approved ?? 0}
- 未完成任务：${(metrics.taskStateSummary?.total ?? 0) - (metrics.taskStateSummary?.approved ?? 0)}
- 审核分组：${metrics.counts.approvedGroups || 0}/${metrics.counts.totalGroups || 0}
- 导出文件：${metrics.exportResult?.xlsxUrl || metrics.exportResult?.csvUrl || metrics.exportResult?.url || metrics.exportResult?.outputPath || '未返回'}
- 批次训练集：${metrics.trainingExportResult?.indexUrl || metrics.trainingExportResult?.rootPath || '未返回'}
- 全局训练集：${metrics.globalTrainingExportResult?.indexUrl || metrics.globalTrainingExportResult?.latestPath || '未返回'}

## 模型成功率

| 模型/阶段 | 测试数 | 成功数 | 成功率 | 备注 |
|---|---:|---:|---:|---|
| 混合图目标检测/切割 | ${split.tested || 0} | ${split.success || 0} | ${pct(split.successRate)} | mix 客户切出 2 张以上区域图算成功 |
| 文档分类总体 | ${classification.tested || 0} | ${classification.success || 0} | ${pct(classification.successRate)} | 用来源文件名/切图后缀作为弱标签 |
| PaddleX 分类模型 | ${classification.modelTested || 0} | ${classification.modelSuccess || 0} | ${pct(classification.modelSuccessRate)} | classificationSource=model |
| 护照字段 OCR 自动齐全 | ${field.passportTested || 0} | ${field.passportAutoComplete || 0} | ${pct(field.passportAutoRate)} | 英文名、护照号、中文名完整且格式通过 |
| 小票字段 OCR 自动齐全 | ${field.receiptTested || 0} | ${field.receiptAutoComplete || 0} | ${pct(field.receiptAutoRate)} | 免税店、小票号、团号、购买/出境日期完整且格式通过 |
| 外部签字 API | ${signature.passportTasks || 0} | ${signature.websiteGenerated || 0} | ${pct(signature.passportTasks ? signature.websiteGenerated / signature.passportTasks : 0)} | 失败后会记录人工兜底数 |

补充：护照二次 OCR 使用 ${field.passportSecondPassUsed || 0} 条，小票二次 OCR 使用 ${field.receiptSecondPassUsed || 0} 条；签字人工兜底 ${signature.manualFallbacks || 0} 条，仍失败 ${signature.failed || 0} 条。

## 耗时

| 阶段 | 耗时 |
|---|---:|
| 上传客户资料 | ${ms(timings.uploadMs)} |
| 模型预处理/切图 | ${ms(timings.preprocessMs)} |
| 图片确认 | ${ms(timings.imageConfirmMs)} |
| OCR + 分类 + 字段抽取 | ${ms(timings.batchOcrAndClassificationMs)} |
| 人工字段兜底 | ${ms(timings.manualFieldCorrectionMs)} |
| 外部签字生成 | ${ms(timings.signatureGenerationMs)} |
| 终审通过 | ${ms(timings.groupApprovalMs)} |
| 导出工作簿 | ${ms(timings.workbookExportMs)} |
| 导出训练集 | ${ms((timings.batchTrainingExportMs || 0) + (timings.globalTrainingExportMs || 0))} |

除识别以外的操作耗时合计：${ms(nonRecognitionMs)}。

## 未完成/异常

${metrics.errors.length ? metrics.errors.map((item) => `- ${item.stage}: ${item.groupKey || ''} ${item.error}`).join('\n') : '- 无阻塞异常。'}

${metrics.taskStateSummary?.unresolvedExamples?.length ? metrics.taskStateSummary.unresolvedExamples.map((item) => `- ${item.id} ${item.docTypeFinal} ${item.processResult}: ${item.actionSuggestion}`).join('\n') : ''}

## 真实业务观察

- 图片确认环节适合只处理“低置信度/失败/切图错误”，高置信度通过图不应该再让员工逐条点通过。
- 审核台最耗人工的是字段兜底，不是按钮点击；需要把异常字段集中到右侧或顶部，而不是让审核员自己在所有字段里找问题。
- 混合图如果切错，真实流程应该保留原图、允许删除错误切片、支持手动补图/重切，而不是反复重新导入同一张导致重复错误。
- 签字 API 是外部链路，应该显示队列、失败原因、重试按钮和人工补签兜底；不要让审核员猜现在是不是卡住。

## 建议

1. 给预处理和签字队列增加批量进度条：已处理、失败、平均耗时、预计剩余。
2. 图片确认页只展示需处理图片；通过图折叠到“已自动通过”里，避免列表噪音。
3. 字段审核页按“缺字段/格式错/待签字/待终审”分组，进入客户后默认定位第一处问题。
4. 把模型结果写入可导出的评估表：docTypeAuto、docTypeConfidence、reviewReasons、OCR 字段缺失原因，方便之后继续训练。
5. 外部签字要保留缓存命中率和失败重试次数，这会直接影响真实大批量审核速度。
`;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
