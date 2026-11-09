const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');

const { sanitizeAsciiFileComponent } = require('../lib/workbench_utils');
const { assertRecordAccess, filterRecordsByOperator } = require('../lib/operator_scope');
const { reconcileCustomerPassport } = require('../lib/qwen_ocr/customer_reconcile');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
const { withWorkspaceShared } = require('../lib/customer_workspace_lock'); // L631:与 deleteWorkspace exclusive 互斥
const { runPool } = require('../lib/qwen_ocr/concurrency_pool');
const { createSemaphore } = require('../lib/simple_semaphore');

// 每张图切图输出的 startIndex 块宽:并行处理一个客户的多张图时,每张图分到 [i*BLOCK, ...) 的
// 独立文件名序号段,保证并行写盘绝不撞名(单图产出远小于 BLOCK)。最终 imageId/sortOrder 会按
// 客户内原图顺序重排,块号只影响磁盘文件名(内部存储,不影响展示)。
const FILENAME_INDEX_BLOCK = 1000;

function buildFileName(index, originalname, suffix = '') {
  const parsed = path.parse(String(originalname || 'image.png'));
  const baseName = sanitizeAsciiFileComponent(parsed.name || '', `image_${index + 1}`) || `image_${index + 1}`;
  const ext = parsed.ext || '.png';
  return `${String(index + 1).padStart(2, '0')}-${baseName}${suffix}${ext}`;
}

function buildImageRecord(outputIndex, output = {}, fallbackOriginalFileName = '') {
  const fileName = String(output.fileName || '').trim();
  const record = {
    imageId: `img_${String(outputIndex).padStart(3, '0')}`,
    originalFileName: String(output.originalFileName || fallbackOriginalFileName || '').trim(),
    relativePath: path.posix.join('images', fileName),
    kind: 'document',
    source: String(output.source || 'uploaded').trim() || 'uploaded',
    sortOrder: outputIndex,
    preprocessStatus: 'processed',
  };

  [
    'autoSplit',
    'autoSplitRole',
    'docTypeHint',
    'docTypeConfidence',
    'detectionBox',
    'modelMeta',
  ].forEach((key) => {
    if (output[key] !== undefined) {
      record[key] = output[key];
    }
  });

  return record;
}

async function canReadSourceImage(sourcePath) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return false;
    }
    await sharp(sourcePath).metadata();
    return true;
  } catch (_error) {
    return false;
  }
}

function createCustomerDocumentPreprocessService({
  customerLibraryRepository,
  documentSplitService,
  concurrency = 1, // 整 workspace 预处理时按客户并发数;默认 1(paddle 串行,零回归)。qwen 模式装配根传 6。
  imageConcurrency = 1, // 单客户内多图并行数;默认 1(零回归)。qwen 模式装配根传 3,提速建档识别。
  maxConcurrentSplits = Number(process.env.PREPROCESS_MAX_CONCURRENT) || 6, // 全局切图并发闸(跨所有客户/操作员),防 N 人同时建档各开数路把 qwen 账户打爆。
} = {}) {
  if (!customerLibraryRepository) {
    throw new Error('customerLibraryRepository is required');
  }
  const workspaceConcurrency = Math.max(1, Number(concurrency) || 1);
  const perCustomerImageConcurrency = Math.max(1, Number(imageConcurrency) || 1);
  // 全局闸:只卡**同时在飞的 qwen 切图调用数**≤maxConcurrentSplits(默认6),不卡 worker 总数
  // (worker 可有 workspace并发×单客户图并发 个存活,多数阻塞在 acquire——目录隔离+每客户写锁,安全)。
  // 队列容量放很大(只排队不拒绝——建档预处理该等,不该丢图)。
  const splitGate = createSemaphore({
    maxConcurrent: Math.max(1, Number(maxConcurrentSplits) || 6),
    maxQueue: 100000,
    busyMessage: 'preprocess split queue full',
  });
  async function runGatedSplit(fn) {
    await splitGate.acquire();
    try { return await fn(); } finally { splitGate.release(); }
  }

  function loadCurrentCustomerIfStillPresent(workspaceKey, customerId, originalCustomer) {
    const existingDir = customerLibraryRepository.findExistingCustomerDirectory?.(workspaceKey, customerId);
    if (!existingDir) {
      return null;
    }

    try {
      const currentCustomer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
      if (
        originalCustomer?.createdAt
        && currentCustomer?.createdAt
        && String(currentCustomer.createdAt) !== String(originalCustomer.createdAt)
      ) {
        return null;
      }
      return currentCustomer;
    } catch (_error) {
      return null;
    }
  }

  function savePreprocessProgress({ workspaceKey, customerId, originalCustomer, progress }) {
    const currentCustomer = loadCurrentCustomerIfStillPresent(workspaceKey, customerId, originalCustomer);
    if (!currentCustomer) {
      return null;
    }
    return customerLibraryRepository.saveCustomer({
      ...currentCustomer,
      preprocess: {
        ...(currentCustomer.preprocess || {}),
        ...progress,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // L631:workspace-shared 外层(与 deleteWorkspace exclusive 互斥),per-customer 内层——preprocess 有
  // qwen ~18s 让点后写盘,尾部不得落在整库 rmSync 之后复活残壳。shared 间零串行化(多客户并发)。
  async function preprocessCustomer(args = {}) {
    return withWorkspaceShared(String(args?.workspaceKey || '').trim(), () => preprocessCustomerLocked(args));
  }

  async function preprocessCustomerLocked({ workspaceKey, customerId, operatorUser = null } = {}) {
    return withCustomerWriteLock(customerLockKey(workspaceKey, customerId), async () => {
    const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
    assertRecordAccess(customer, operatorUser, 'customer');
    const customerPath = customerLibraryRepository.customerDir(workspaceKey, customerId);
    const imagesDir = path.join(customerPath, 'images');
    const nextImages = [];
    const inputImages = Array.isArray(customer.images) ? customer.images : [];
    let splitImages = 0;
    let failedImages = 0;
    let warningImages = 0;

    savePreprocessProgress({
      workspaceKey,
      customerId,
      originalCustomer: customer,
      progress: {
        status: 'processing',
        inputImages: inputImages.length,
        totalImages: inputImages.length,
        currentImage: inputImages.length > 0 ? 1 : 0,
        outputImages: 0,
        splitImages: 0,
        failedImages: 0,
        warningImages: 0,
        startedAt: new Date().toISOString(),
        processedAt: null,
      },
    });

    // 每张图切图(调 qwen)相互独立 → 并行跑(单客户并发 perCustomerImageConcurrency,
    // 全局 splitGate 兜底防多人建档打爆账户);每张分独立 startIndex 块防文件名撞。
    // 结果按 imageIndex 收集,下面**按原图顺序**重建 nextImages(imageId/sortOrder 重排)。
    const outcomes = new Array(inputImages.length);
    let doneCount = 0;
    await runPool(
      inputImages.map((_, i) => i),
      perCustomerImageConcurrency,
      async (imageIndex) => {
        const image = inputImages[imageIndex];
        try {
          if (image?.autoSplitRole) {
            outcomes[imageIndex] = { kind: 'preserved', image };
            return;
          }
          const sourcePath = path.join(customerPath, String(image.relativePath || '').replaceAll('/', path.sep));
          const splitResult = documentSplitService
            ? await runGatedSplit(() => documentSplitService.splitImage({
              sourcePath,
              imagesDir,
              originalFileName: image.originalFileName || path.basename(image.relativePath || ''),
              startIndex: imageIndex * FILENAME_INDEX_BLOCK, // 独立块:并行写盘不撞名
              buildFileName,
              // 强制重调 qwen(深度审计 MEDIUM):preprocessCustomer 是(重新)识别入口,
              // 不带 forceRefresh 会命中进程内 cache(pm2 长跑)回放旧 OCR——误读点「重新识别」修不掉。
              // 建档首次分析本就 cache miss,加此无副作用;重新识别时强制新读才能纠错。
              forceRefresh: true,
            }))
            : null;
          if (splitResult?.splitApplied && Array.isArray(splitResult.outputs) && splitResult.outputs.length) {
            outcomes[imageIndex] = { kind: 'split', image, outputs: splitResult.outputs };
          } else {
            outcomes[imageIndex] = { kind: 'keep', image };
          }
        } catch (error) {
          const message = String(error?.message || error || 'preprocess failed');
          const sourcePath = path.join(customerPath, String(image.relativePath || '').replaceAll('/', path.sep));
          outcomes[imageIndex] = (await canReadSourceImage(sourcePath))
            ? { kind: 'warning', image, message }
            : { kind: 'failed', image, message };
        } finally {
          doneCount += 1;
          // 进度尽力更新(客户删了返回 null 也不阻断;最终 loadCurrentCustomerIfStillPresent 兜底)
          savePreprocessProgress({
            workspaceKey,
            customerId,
            originalCustomer: customer,
            progress: {
              status: 'processing',
              inputImages: inputImages.length,
              totalImages: inputImages.length,
              currentImage: doneCount,
              outputImages: 0,
              splitImages,
              failedImages,
              warningImages,
            },
          });
        }
      }
    );

    // 按原图顺序重建;imageId/sortOrder 顺序重排(不受并行完成顺序影响)
    const nextSeq = () => nextImages.length + 1;
    for (const outcome of outcomes) {
      if (!outcome) continue;
      const { kind, image } = outcome;
      const fallbackName = image.originalFileName || path.basename(image.relativePath || '');
      if (kind === 'preserved') {
        const seq = nextSeq();
        if (image.autoSplitRole === 'region') splitImages += 1;
        nextImages.push({ ...image, imageId: `img_${String(seq).padStart(3, '0')}`, sortOrder: seq });
      } else if (kind === 'split') {
        for (const output of outcome.outputs) {
          const record = buildImageRecord(nextSeq(), output, fallbackName);
          if (record.autoSplitRole === 'region') splitImages += 1;
          nextImages.push(record);
        }
      } else if (kind === 'keep') {
        const seq = nextSeq();
        nextImages.push({
          ...image,
          imageId: `img_${String(seq).padStart(3, '0')}`,
          sortOrder: seq,
          preprocessStatus: 'processed',
          preprocessMessage: 'no_split_detected',
        });
      } else if (kind === 'warning') {
        warningImages += 1;
        const seq = nextSeq();
        nextImages.push({
          ...image,
          imageId: `img_${String(seq).padStart(3, '0')}`,
          sortOrder: seq,
          preprocessStatus: 'processed',
          preprocessWarning: true,
          preprocessMessage: `split_failed_keep_original: ${outcome.message}`,
        });
      } else if (kind === 'failed') {
        failedImages += 1;
        const seq = nextSeq();
        nextImages.push({
          ...image,
          imageId: `img_${String(seq).padStart(3, '0')}`,
          sortOrder: seq,
          preprocessStatus: 'failed',
          preprocessMessage: outcome.message,
        });
      }
    }

    // P1.1 千问模式:跨该客户所有图做护照号共识(回写 sidecar)。
    // paddle 模式无 sidecar → no-op;best-effort,绝不破坏预处理。
    try {
      reconcileCustomerPassport(imagesDir);
    } catch (error) {
      console.error('[preprocess] 跨图护照共识失败(忽略)', error?.message || error);
    }

    const summary = {
      status: failedImages > 0 || warningImages > 0 ? 'needs_review' : 'processed',
      inputImages: inputImages.length,
      currentImage: inputImages.length,
      totalImages: inputImages.length,
      outputImages: nextImages.length,
      splitImages,
      failedImages,
      warningImages,
      processedAt: new Date().toISOString(),
    };

    const currentCustomer = loadCurrentCustomerIfStillPresent(workspaceKey, customerId, customer);
    if (!currentCustomer) {
      return {
        customer: null,
        summary: {
          ...summary,
          status: 'deleted_during_preprocess',
          outputImages: 0,
          splitImages: 0,
        },
      };
    }

    const savedCustomer = customerLibraryRepository.saveCustomer({
      ...currentCustomer,
      images: nextImages,
      preprocess: summary,
    });

    return {
      customer: savedCustomer,
      summary,
    };
    });
  }

  async function preprocessWorkspace({ workspaceKey, operatorUser = null } = {}) {
    const customers = filterRecordsByOperator(
      customerLibraryRepository.listCustomers(workspaceKey),
      operatorUser
    );
    // 按客户并发(客户间独立、各写各的文件);默认并发1=原串行行为。
    const results = new Array(customers.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < customers.length) {
        const cur = nextIndex++;
        const customerId = customers[cur].customerId;
        try {
          results[cur] = await preprocessCustomer({
            workspaceKey,
            customerId,
            operatorUser,
          });
        } catch (error) {
          // 单个客户预处理抛错(customer.json 损坏/落盘 EBUSY/磁盘满/权限断言)不能掀翻整批:
          // 否则 Promise.all 直接 reject,调用方(customer_handlers.preprocessWorkspaceCustomers)的
          // 批次回灌循环整段不执行——已经切好图的兄弟客户拿不到回灌,护照区漏在库里进不了批次,
          // 正是 CL019「缺护照」的放大复发(一个坏客户殃及整批)。失败客户记占位,整批照常继续,
          // 失败清单随返回上报让操作员感知。占位 summary 补齐数值键,下面 reduce 不炸。
          results[cur] = {
            customer: null,
            customerId,
            error: String(error?.message || error),
            summary: {
              status: 'error',
              inputImages: 0,
              outputImages: 0,
              splitImages: 0,
              failedImages: 0,
              warningImages: 0,
            },
          };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(workspaceConcurrency, customers.length || 1) }, worker)
    );
    const failedCustomers = results
      .filter((item) => item && item.error)
      .map((item) => ({ customerId: item.customerId || null, error: item.error }));
    return {
      workspaceKey,
      results,
      customers: filterRecordsByOperator(customerLibraryRepository.listCustomers(workspaceKey), operatorUser),
      failedCustomers,
      summary: {
        customers: results.length,
        failedCustomers: failedCustomers.length,
        inputImages: results.reduce((sum, item) => sum + Number(item.summary.inputImages || 0), 0),
        outputImages: results.reduce((sum, item) => sum + Number(item.summary.outputImages || 0), 0),
        splitImages: results.reduce((sum, item) => sum + Number(item.summary.splitImages || 0), 0),
        failedImages: results.reduce((sum, item) => sum + Number(item.summary.failedImages || 0), 0),
        warningImages: results.reduce((sum, item) => sum + Number(item.summary.warningImages || 0), 0),
      },
    };
  }

  // 启动恢复(审计MEDIUM,与 recoverInterruptedGroupCodeImports 同构):预处理开跑先落盘
  // preprocess.status='processing';进程被杀(pm2 重启/部署窗口)后无人复位 → 该客户永挂「识别中」、
  // customerReadinessInfo 恒 ready:false → 永不自动入批次,操作员也未必注意队列失败注记。开机把
  // 残留 'processing' 如实标 'error'+人话原因,前端显示「识别中断·请重识别」且不自动追批次
  // (idempotent:重跑 preprocessCustomer 时已切图 autoSplitRole 会被 preserved)。
  function recoverInterruptedPreprocess() {
    let recovered = 0;
    const workspaces = (() => { try { return customerLibraryRepository.listWorkspaces() || []; } catch { return []; } })();
    for (const ws of workspaces) {
      const workspaceKey = String(ws?.workspaceKey || ws || '').trim();
      if (!workspaceKey) continue;
      let customers;
      try { customers = customerLibraryRepository.listCustomers(workspaceKey) || []; } catch { continue; }
      for (const c of customers) {
        if (String(c?.preprocess?.status || '') !== 'processing') continue;
        const customerId = String(c?.customerId || '').trim();
        if (!customerId) continue;
        try {
          const fresh = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
          // 竞态尊重:开机后若已被别的路径改动就不动(照 recoverInterruptedGroupCodeImports)
          if (!fresh || String(fresh.preprocess?.status || '') !== 'processing') continue;
          customerLibraryRepository.saveCustomer({
            ...fresh,
            preprocess: {
              ...(fresh.preprocess || {}),
              status: 'error',
              error: '服务重启中断了识别,请点「重新识别」重跑',
              updatedAt: new Date().toISOString(),
            },
          });
          recovered += 1;
           
          console.warn(`[preprocess] 启动恢复:客户 ${workspaceKey}/${customerId} processing → error(重启中断,待重识别)`);
        } catch (error) {
           
          console.error(`[preprocess] 启动恢复失败 ${workspaceKey}/${customerId}: ${error?.message || error}`);
        }
      }
    }
    return recovered;
  }

  return {
    preprocessCustomer,
    preprocessWorkspace,
    recoverInterruptedPreprocess,
  };
}

module.exports = {
  createCustomerDocumentPreprocessService,
  // P2d 重切复用(task_resplit_service):切图产物记录/文件名口径必须与建档预处理完全一致,
  // 否则重切出来的图批处理不认。这里是唯一真相源,别在别处复制。
  buildFileName,
  buildImageRecord,
};
