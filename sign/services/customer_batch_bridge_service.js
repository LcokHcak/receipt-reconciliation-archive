const crypto = require('node:crypto');
const { logger: structuredLogger } = require('../lib/request_logger');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { sanitizeAsciiFileComponent } = require('../lib/workbench_utils');
const { upsertSourceGroup } = require('../lib/source_group_utils');
const { SIDECAR_SUFFIX } = require('../lib/qwen_ocr/sidecar');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
const {
  assertBatchAccess,
  assertRecordAccess,
  buildOwnerMetadata,
  filterRecordsByOperator,
} = require('../lib/operator_scope');

function createCustomerBatchBridgeService({
  customerLibraryRepository,
  batchRepository,
  batchGroupCodeImportService: initialBatchGroupCodeImportService = null,
  buildBatchSkeleton,
  createImportedImageTask,
  nowStamp,
}) {
  let batchGroupCodeImportService = initialBatchGroupCodeImportService;
  // 团号预匹配(晚绑定,同上模式):表解析完成后整批补跑用。
  let groupCodePrematchService = null;

  function resolveWorkspaceKey(workspaceKey, monthKey) {
    return String(workspaceKey || monthKey || '').trim();
  }

  function nextTaskSerial(batch) {
    return (Array.isArray(batch.tasks) ? batch.tasks : [])
      .map((task) => /^task_(\d+)$/.exec(String(task?.id || '').trim()))
      .filter(Boolean)
      .map((match) => Number.parseInt(match[1], 10) || 0)
      .reduce((highest, value) => Math.max(highest, value), 0);
  }

  // 图片进批次:优先硬链接(同一份磁盘数据两个名字,零额外空间——批次目录曾是客户库的
  // 30G 镜像拷贝),跨设备/文件系统不支持等失败时退回真拷贝,行为完全等价:
  //   读:两个路径读到同样字节;删:删批次侧只解开批次这个名字,客户库那份不受影响。
  // ⚠️只对图片安全:图片写入后不可变(重拍/重切都是新文件名)。sidecar 会被
  // ensureQwenSidecar 原地改写,硬链会把改写穿透到客户库副本 → sidecar 仍走真拷贝。
  // 异步版(2026-07-14 审计#3):曾是 linkSync/copyFileSync 同步大循环——批次追加/导入持
  // withBatchWrite 锁期间阻塞整个 Node 事件循环,一人批量追加大工作区,全站 30 人集体卡顿。
  // 改 await 逐张让出事件循环:硬链秒回不受影响,跨设备真拷贝时其它请求照常处理。
  async function linkOrCopyImage(srcAbsPath, destAbsPath) {
    try {
      await fsp.link(srcAbsPath, destAbsPath);
    } catch {
      await fsp.copyFile(srcAbsPath, destAbsPath);
    }
  }

  function isCustomerImageAcceptedForBatch(image = {}) {
    if (image.autoSplitRole === 'original') {
      return false;
    }
    return true;
  }

  function customerDisplayLabel(customer = {}, fallback = '') {
    return String(
      customer.displayName
      || customer.finalName
      || customer.agentName
      || customer.name
      || customer.folderNameFinal
      || customer.folderNameInitial
      || fallback
      || ''
    ).trim();
  }

  function getCustomerImagesForBatch(customer = {}) {
    const images = Array.isArray(customer.images) ? customer.images : [];
    return images.filter((image) => isCustomerImageAcceptedForBatch(image));
  }

  function buildCustomerSourceOriginalPath({ resolvedWorkspaceKey, customerId, image }) {
    return path.posix.join(
      resolvedWorkspaceKey,
      customerId,
      path.posix.basename(String(image.relativePath || ''))
    );
  }

  function getBatchSourceOriginalPathSet(batch = {}) {
    const paths = (Array.isArray(batch.tasks) ? batch.tasks : [])
      .map((task) => String(task?.sourceOriginalPath || '').trim())
      .filter(Boolean);
    // 已删路径墓碑也算"存在":审核台删掉的图(重复护照等)补图/追加时不再加回来。
    for (const tomb of (Array.isArray(batch.deletedSourcePaths) ? batch.deletedSourcePaths : [])) {
      const t = String(tomb || '').trim();
      if (t) paths.push(t);
    }
    return new Set(paths);
  }

  // 原图残留清理(管道级):切图完成后原图被改名(xxx.jpg → xxx_original.jpg),
  // 批次里切图前建的旧任务指向已不存在的文件名,滞留成审核台"废图"(既显示不了又反复出现)。
  // 2026-07-02 事故靠一次性脚本清了 123 个,此处根治:每次给客户追加切片时,顺手清掉该客户
  // 未审核+未要求重拍+文件名已不在客户当前图列表 的任务;删除路径进墓碑防回魂。
  function cleanupStaleCustomerTasks({ batch, customer, resolvedWorkspaceKey }) {
    const customerId = String(customer.customerId || customer.folderNameInitial || '').trim();
    if (!customerId || !Array.isArray(batch.tasks)) return 0;
    const prefix = `${resolvedWorkspaceKey}/${customerId}/`;
    const currentBasenames = new Set((Array.isArray(customer.images) ? customer.images : [])
      .map((image) => path.posix.basename(String(image.relativePath || '')))
      .filter(Boolean));
    const keep = [];
    let removed = 0;
    for (const task of batch.tasks) {
      const src = String(task?.sourceOriginalPath || '').trim();
      const isStale = src.startsWith(prefix)
        && !task.reviewed
        && !task.rephotoRequested
        && !currentBasenames.has(path.posix.basename(src));
      if (!isStale) {
        keep.push(task);
        continue;
      }
      removed += 1;
      const tombstones = Array.isArray(batch.deletedSourcePaths) ? batch.deletedSourcePaths : [];
      if (!tombstones.includes(src)) tombstones.push(src);
      // L593:不再 slice(-500)——本墓碑主要来源是 cleanupStaleCustomerTasks 每次 append 把切图前
      // 原图路径写入,增量大;截断会逐出仍相关的墓碑→已删重复图在去重时复活。上界=该批次曾出现的
      // 不同图片路径数(有界,体量小),去掉截断安全。与 task.js 删票墓碑同口径。
      batch.deletedSourcePaths = tombstones;
    }
    if (removed) batch.tasks = keep;
    return removed;
  }

  async function appendCustomerImagesToBatch({
    batch,
    dirs,
    customer,
    customerPath,
    resolvedWorkspaceKey,
    startIndex,
    existingSourceOriginalPaths = new Set(),
    customerLockHeld = false,
  }) {
    const customerId = String(customer.customerId || customer.folderNameInitial || '').trim();
    // 客户写锁(2026-07-14 复审 CRITICAL):拷图改异步后本函数出现 await 让点,customer.json 的
    // 读→改→写不再"同步即原子"——审图/删图(走同一把锁)可在让点间落盘,尾部 saveCustomer(旧快照)
    // 会整盘覆盖:丢审图更新/复活已删图记录。修法=进锁 + 锁内重载 fresh(与 image_review/resplit 同款)。
    // customerLockHeld:resplit 已在同键锁内调进来(锁=同键 Promise 链,嵌套等自己=死锁),持锁方旁路。
    const run = async () => {
      let fresh;
      try {
        fresh = customerLibraryRepository.loadCustomer(resolvedWorkspaceKey, customerId);
      } catch { fresh = null; }
      if (!fresh) {
        // 排队等锁期间客户被删/读不到:无事可做,跳过这个客户(别让整个批量追加炸掉)
        return { taskIndex: startIndex, sourceGroup: null, taskCount: 0 };
      }
      let taskIndex = startIndex;
      const imagesForBatch = getCustomerImagesForBatch(fresh)
        .filter((image) => !existingSourceOriginalPaths.has(buildCustomerSourceOriginalPath({
          resolvedWorkspaceKey,
          customerId,
          image,
        })));
      if (!imagesForBatch.length) {
        return {
          taskIndex,
          sourceGroup: null,
          taskCount: 0,
        };
      }
      const sourceGroup = upsertSourceGroup(batch, customerId);
      const displayLabel = customerDisplayLabel(fresh, customerId);
      if (displayLabel) {
        sourceGroup.label = displayLabel;
        batch.sourceGroups = (batch.sourceGroups || []).map((group) => (
          group.key === sourceGroup.key ? { ...group, label: displayLabel } : group
        ));
      }

      let appendedCount = 0;
      let copyFailedExisting = 0; // 源图仍在却拷失败的切片数(L714:>0 则不打 lastBatchId,留给前端自动追加重试)
      for (const image of imagesForBatch) {
        taskIndex += 1;
        const taskId = `task_${String(taskIndex).padStart(4, '0')}`;
        const parsedImagePath = path.parse(String(image.relativePath || image.originalFileName || 'image.jpg'));
        const sourceExt = parsedImagePath.ext || '.jpg';
        const sourceBaseName = sanitizeAsciiFileComponent(parsedImagePath.name || '', `image_${taskIndex}`) || `image_${taskIndex}`;
        const sourceImageName = `${taskId}__${sourceBaseName}${sourceExt}`;
        const sourceImagePath = path.join('source', sourceImageName);
        const sourceOriginalPath = buildCustomerSourceOriginalPath({
          resolvedWorkspaceKey,
          customerId,
          image,
        });
        const srcImageAbsPath = path.join(customerPath, String(image.relativePath || '').replaceAll('/', path.sep));
        const destImageAbsPath = path.join(dirs.source, sourceImageName);
        try {
          await linkOrCopyImage(srcImageAbsPath, destImageAbsPath);
        } catch (copyErr) {
          // 拷图失败分两类(L714):
          // ①源图已不在(审图删图删掉了它)→ 这张本就该丢,静默跳过、照常打 lastBatchId,
          //   与「删除即尊重」一致,重试也拷不回(源没了)不该无限重挑。
          // ②源图仍在却拷失败(瞬时盘错/ENOSPC/权限)→ 这张本应入批次却漏了;若照打 lastBatchId,
          //   前端自动追加只认 !lastBatchId 永不重试→切片永久缺失且操作员零报错。故累计此类,
          //   让本客户不打 lastBatchId,交前端自动追加重挑一轮(源图还在,重试通常即成)。
          const sourceGone = !fs.existsSync(srcImageAbsPath);
          if (sourceGone) {
            structuredLogger.warn('batch_append_copy_skip', { workspaceKey: resolvedWorkspaceKey, customerId, image: image.relativePath, error: String(copyErr?.message || copyErr) });
          } else {
            copyFailedExisting += 1;
            structuredLogger.error('batch_append_copy_failed', { workspaceKey: resolvedWorkspaceKey, customerId, image: image.relativePath, error: String(copyErr?.message || copyErr) });
          }
          continue;
        }
        // 千问模式:预处理已写好的 <图>.qwen.json 随图带到批次,批处理直接读 sidecar,
        // 不必在批处理阶段对每张图再调一次千问(否则等于每张识别两次、双倍成本+耗时)。
        // paddle 模式源图旁没有 sidecar → existsSync 为 false,自然跳过(no-op)。
        const srcSidecarPath = srcImageAbsPath + SIDECAR_SUFFIX;
        if (fs.existsSync(srcSidecarPath)) {
          try {
            await fsp.copyFile(srcSidecarPath, destImageAbsPath + SIDECAR_SUFFIX);
          } catch {
            // sidecar 复制失败不阻断导入;批处理 ensureQwenSidecar 会兜底重算。
          }
        }

        batch.tasks.push(createImportedImageTask({
          taskId,
          originalFileName: image.originalFileName || path.basename(image.relativePath || ''),
          sourceImagePath,
          sourceOriginalPath,
          sourceFileName: path.basename(image.relativePath || ''),
          sourceFolderName: customerId,
          sourceFolderPath: customerId,
          sourceGroupKey: sourceGroup.key,
          sourceGroupLabel: sourceGroup.label,
          customerAgentName: fresh.agentName,
          autoSplitRole: image.autoSplitRole,
          preprocessMessage: image.preprocessMessage,
          preprocessWarning: image.preprocessWarning,
          customerOwnerUserId: fresh.ownerUserId,
          customerOwnerUsername: fresh.ownerUsername,
        }));
        existingSourceOriginalPaths.add(sourceOriginalPath);
        appendedCount += 1;
      }

      // 只改本函数负责的字段再落盘(fresh 是锁内刚读的最新态,不会覆盖别人的并发写)。
      // L714:有「源图仍在却拷失败」的切片时不打 lastBatchId,让前端自动追加重挑本客户重试;
      // 成功入批次的切片已进 batch.tasks 且计入 existingSourceOriginalPaths,重试只补漏那几张(幂等)。
      fresh.review = {
        ...(fresh.review || {}),
        ...(copyFailedExisting === 0 ? { lastBatchId: batch.id } : {}),
        lastSourceGroupId: sourceGroup.key,
      };
      if (fresh.status !== 'approved') {
        fresh.status = 'in_review';
      }
      customerLibraryRepository.saveCustomer(fresh);

      return {
        taskIndex,
        sourceGroup,
        taskCount: appendedCount,
      };
    };
    return customerLockHeld
      ? run()
      : withCustomerWriteLock(customerLockKey(resolvedWorkspaceKey, customerId), run);
  }

  // ⚠️"一批次必须绑团号表"(2026-07-09 拍板)目前只在 HTTP handler 层拦(importCustomerWorkspace),
  // 本函数自身不校验——新调用方若绕过 handler 直调,会造出无表批次(预匹配全 pending_table)。
  // 直调前请自带 groupCodeFilePath 或 groupCodeSourceFile。
  async function importWorkspaceToBatch({
    workspaceKey,
    monthKey,
    batchName,
    scenario = 'FullProcess',
    monthlyWorkspaceKey = '',
    groupCodeImportJobId = '',
    groupCodeSourceFile = '',
    groupCodeFilePath = '',
    operatorUser = null,
    allowEmpty = false,
    enforceUniqueName = false,
  }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    // 批次名去重:同一工作区内,操作员手填的批次名不能重复(留空自动生成的不校验)。
    // 目的:批次隐形 bug 期间操作员看不到批次→反复用同名新建,留一堆重名重复批次。
    if (enforceUniqueName) {
      const wantName = String(batchName || '').trim();
      const wsKey = String(monthlyWorkspaceKey || '').trim() || resolvedWorkspaceKey;
      if (wantName && typeof batchRepository.listBatches === 'function') {
        let existing;
        try { existing = batchRepository.listBatches() || []; } catch { existing = []; } // 无批次目录=无重名
        const dup = existing.find((b) =>
          String(b.monthlyWorkspaceKey || b.workspaceKey || '').trim() === wsKey
          && String(b.name || '').trim() === wantName);
        if (dup) {
          const err = new Error(`批次名「${wantName}」已存在,请换一个名字`);
          err.code = 'DUPLICATE_BATCH_NAME';
          throw err;
        }
      }
    }
    const customers = filterRecordsByOperator(
      customerLibraryRepository.listCustomers(resolvedWorkspaceKey),
      operatorUser
    );
    // ⭐allowEmpty=新流程"建空批次"(建档页唯一入口):**必须真的是空批次,一个存量客户都不导**。
    // 2026-07-05 事故:操作员在有79个已审客户的老工作区上点"新建批次",本函数把全工作区客户
    // (含已审已结算的)全量吸入新批次并改写 lastBatchId → 老数据整批变"等待识别"、新旧混杂。
    // 空批次的客户来源只有两条腿:建档自动进 + 自动追加(两处都有"从没进过批次"护栏)。
    // 无 allowEmpty 的全量导入是遗留 API 行为(UI 已不可达),保持原样。
    const customersWithImages = allowEmpty
      ? []
      : customers.filter((customer) => getCustomerImagesForBatch(customer).length > 0);
    if (!customersWithImages.length && !allowEmpty) {
      throw new Error(`No customer images found for workspace ${resolvedWorkspaceKey}`);
    }

    const batchId = `batch_${nowStamp()}_${crypto.randomUUID().slice(0, 8)}`;
    const batch = buildBatchSkeleton(batchId, batchName || `Batch ${resolvedWorkspaceKey}`, scenario);
    Object.assign(batch, buildOwnerMetadata(operatorUser));
    const normalizedMonthlyWorkspaceKey = String(monthlyWorkspaceKey || '').trim();
    // 批次始终记下来源工作区:新流程"先建空批次、之后后台传团号表"要靠它给 group_code 定匹配范围。
    batch.monthlyWorkspaceKey = normalizedMonthlyWorkspaceKey || resolvedWorkspaceKey;
    // 团号表解析(18~60s)挪到后台:导入请求不再同步等。先标 status='parsing',批次秒建好返回,
    // 操作员立刻能传图/建档;解析在 runBatchGroupCodeParse 里跑完后把 status 改 'ready'。
    let pendingGroupCode = null;
    if (groupCodeFilePath && batchGroupCodeImportService?.importFile) {
      batch.monthlyWorkspaceKey = normalizedMonthlyWorkspaceKey || resolvedWorkspaceKey;
      batch.groupCodeImport = {
        scope: 'batch',
        status: 'parsing',
        sourceWorkspaceKey: resolvedWorkspaceKey,
        sourceFile: groupCodeSourceFile || null,
      };
      pendingGroupCode = {
        batchId,
        filePath: groupCodeFilePath,
        sourceFile: groupCodeSourceFile,
        sourceWorkspaceKey: resolvedWorkspaceKey,
        operator: operatorUser?.username || operatorUser?.name || null,
      };
    } else if (normalizedMonthlyWorkspaceKey) {
      batch.monthlyWorkspaceKey = normalizedMonthlyWorkspaceKey;
      batch.groupCodeImport = {
        scope: 'monthly_legacy',
        workspaceKey: normalizedMonthlyWorkspaceKey,
        jobId: String(groupCodeImportJobId || '').trim(),
        sourceFile: String(groupCodeSourceFile || '').trim(),
      };
    } else if (String(groupCodeSourceFile || '').trim()) {
      // 两步走(建空批次+后台传表):建批次时没带文件、只声明了文件名 → 出生即盖 awaiting_upload。
      // 一批次必须绑一表(2026-07-09 拍板):这样"上传半路断了"的批次也有可见的绑定状态,
      // 而不是无声地留成没表批次;后台上传到达后由 replace 路径改写为 parsing→ready。
      // 注意放在 monthly_legacy 之后:遗留调用也带 sourceFile,不能被本分支截胡。
      batch.groupCodeImport = {
        scope: 'batch',
        status: 'awaiting_upload',
        sourceWorkspaceKey: resolvedWorkspaceKey,
        sourceFile: String(groupCodeSourceFile || '').trim(),
      };
    }
    const dirs = batchRepository.batchSubdirs(batchId);

    let taskIndex = 0;
    for (const customer of customersWithImages) {
      const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, customer.customerId);
      const appended = await appendCustomerImagesToBatch({
        batch,
        dirs,
        customer,
        customerPath,
        resolvedWorkspaceKey,
        startIndex: taskIndex,
      });
      taskIndex = appended.taskIndex;
    }

    await batchRepository.saveBatchAsync(batch);
    return { batch, pendingGroupCode };
  }

  // 落批次状态的短写段必须进批次写队列(2026-07-12 审计 HIGH):本函数是 HTTP 返回后的
  // fire-and-forget,原先 loadBatch→改→saveBatchAsync 完全绕开 withBatchWrite——与队列内
  // 正在进行的 load→save 窗口交错时谁后落盘谁赢,互吞写入。慢的 importFile(18~60s)留在
  // 队列外,只有毫秒级的"fresh 加载→盖状态→save"进队列。老测试的 mock 仓库没有
  // withBatchWrite 时降级直跑(生产仓库恒有该方法)。
  function stampInBatchQueue(batchId, label, mutate) {
    const run = async () => {
      if (!batchRepository.hasBatch(batchId)) return false; // 批次被删了就算了
      const fresh = batchRepository.loadBatch(batchId);
      mutate(fresh);
      await batchRepository.saveBatchAsync(fresh);
      return true;
    };
    return typeof batchRepository.withBatchWrite === 'function'
      ? batchRepository.withBatchWrite(batchId, run, { label })
      : run();
  }

  // 后台解析团号表(由 handler 在响应返回后 fire-and-forget 调用):解析完把批次的
  // groupCodeImport.status 改成 'ready'(失败改 'failed')。期间批次照常可建档/上传。
  async function runBatchGroupCodeParse({ batchId, filePath, sourceFile, sourceWorkspaceKey, operator }) {
    let imported = null;
    try {
      try {
        imported = await batchGroupCodeImportService.importFile({
          batchId,
          sourceWorkspaceKey,
          filePath,
          sourceFileName: sourceFile,
          operator: operator || null,
        });
      } catch (error) {
        try {
          await stampInBatchQueue(batchId, 'groupCodeParseFailed', (fresh) => {
            fresh.groupCodeImport = { ...(fresh.groupCodeImport || {}), status: 'failed', error: error?.message || String(error) };
          });
        } catch (stampError) {
          // 复核 MEDIUM:落 failed 状态自身失败(含新引入的队列超时)不能再静默——
          // 否则 groupCodeImport 卡 parsing 时看不出这一步也炸了
          structuredLogger.warn('groupcode_failed_stamp_failed', { batchId, error: String(stampError?.message || stampError) });
        }
        throw error;
      }
      await stampInBatchQueue(batchId, 'groupCodeParseReady', (fresh) => {
        fresh.groupCodeImport = {
          ...(fresh.groupCodeImport || {}),
          scope: 'batch',
          status: 'ready',
          sourceWorkspaceKey,
          sourceFile: imported.sourceFile,
          importedAt: imported.importedAt,
          rowsTotal: imported.rowsTotal,
          rowsInserted: imported.rowsInserted,
          rowsSkipped: imported.rowsSkipped,
        };
        // 触发点②:团号表就绪 → 整批补跑预匹配(解析晚于识别的时序兜底;换表 replace 后同样走这里刷新)。
        if (groupCodePrematchService) {
          try { groupCodePrematchService.sweepBatch(fresh); } catch { /* advisory,不阻断 */ }
        }
      });
      return imported;
    } finally {
      // 解析完(成功/失败/批次已删 都)删掉 multer 上传的临时团号表,防止 tmp_uploads 堆积。
      if (filePath) {
        try { fs.rmSync(filePath, { force: true }); } catch { /* 删不掉不影响主流程 */ }
      }
    }
  }

  async function appendWorkspaceToBatch({ workspaceKey, monthKey, batchId, operatorUser = null }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    if (!batchRepository.hasBatch(batchId)) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    const batch = batchRepository.loadBatch(batchId);
    assertBatchAccess(batch, operatorUser);
    // 串台护栏②(跨工作区):批次绑定某工作区,只允许追加「同一工作区」的客户。
    // 防 admin 会话停在别人工作区时,自动追加把那个工作区的客户吸进本批次
    // (线上实测:admin 停在小票03工作区、当前批次却是小票22的 → 把小票03的6个客户灌进了小票22批次)。
    const batchWorkspace = String(batch.monthlyWorkspaceKey || batch.workspaceKey || '').trim();
    if (batchWorkspace && batchWorkspace !== resolvedWorkspaceKey) {
      return { batch, appendedCustomers: 0, appendedTasks: 0, crossWorkspaceSkipped: true };
    }
    const dirs = batchRepository.batchSubdirs(batchId);
    const customers = filterRecordsByOperator(
      customerLibraryRepository.listCustomers(resolvedWorkspaceKey),
      operatorUser
    );
    const existingSourceOriginalPaths = getBatchSourceOriginalPathSet(batch);
    // T6-B 归属修正(8模块审计 HIGH):上传时快照的 review.intendedBatchId 决定归属。
    // 换批次窗口里,老队列客户不被吸进「当下」批次,而是改道逐客户追加到各自意向批次;
    // 意向批次已删/未落快照(存量客户)→ 回落当前批次,不搁浅(H1教训:搁浅=永不入批次)。
    const redirects = [];
    const customersWithImages = customers
      .filter((customer) => getCustomerImagesForBatch(customer).length > 0)
      // 串台护栏:跳过「已属于别的、且仍存在的批次」的客户,防止把别人批次的客户吸进本批次。
      // 允许:没进过批次、或就是本批次、或原批次已删(孤儿可重新归入)。
      .filter((customer) => {
        const lastBatchId = String(customer?.review?.lastBatchId || '').trim();
        return !lastBatchId || lastBatchId === batchId || !batchRepository.hasBatch(lastBatchId);
      })
      .filter((customer) => {
        const intended = String(customer?.review?.intendedBatchId || '').trim();
        if (intended && intended !== batchId && batchRepository.hasBatch(intended)) {
          redirects.push({
            customerId: String(customer.customerId || customer.folderNameInitial || '').trim(),
            intended,
          });
          return false;
        }
        return true;
      })
      .filter((customer) => {
        const customerId = String(customer.customerId || customer.folderNameInitial || '').trim();
        return getCustomerImagesForBatch(customer).some((image) => !existingSourceOriginalPaths.has(
          buildCustomerSourceOriginalPath({ resolvedWorkspaceKey, customerId, image })
        ));
      });

    let taskIndex = nextTaskSerial(batch);
    let appendedTasks = 0;
    let appendedCustomers = 0;
    for (const customer of customersWithImages) {
      const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, customer.customerId);
      const appended = await appendCustomerImagesToBatch({
        batch,
        dirs,
        customer,
        customerPath,
        resolvedWorkspaceKey,
        startIndex: taskIndex,
        existingSourceOriginalPaths,
      });
      taskIndex = appended.taskIndex;
      appendedTasks += appended.taskCount;
      if (appended.taskCount > 0) {
        appendedCustomers += 1;
      }
      cleanupStaleCustomerTasks({ batch, customer, resolvedWorkspaceKey });
    }

    if (appendedTasks > 0) {
      batch.machineState = 'queued';
    }
    await batchRepository.saveBatchAsync(batch);

    // 改道**不在此处就地执行**(死锁修复,审计 HIGH line 510):本函数由 handler 包在
    // withBatchWrite(当前) 锁内运行,若在这里再取 withBatchWrite(intended) 就是双批次嵌套,
    // 两 sweep 交叉(A:B1→B2,B:B2→B1)会 ABBA 死锁;而不取锁又会与意向批次的并发结算/审核
    // 互吞(line 459)。正解=把改道收集成 pendingRedirects 交回 handler,由 handler 在**当前锁
    // 释放后**逐个 withBatchWrite(intended) 单锁执行(任一时刻只持一把批次锁,无环)。
    // service 无法感知自己是否已在外层锁内(测试直调时没有),故执行权必须上交掌握外层锁的 handler。
    return {
      batch,
      appendedCustomers,
      appendedTasks,
      pendingRedirects: redirects.map((redirect) => ({
        customerId: redirect.customerId,
        intended: redirect.intended,
      })),
    };
  }

  // customerLockHeld:调用方已持同客户写锁时传 true(resplit 在锁内调进来;同键嵌套=死锁)。
  async function appendCustomerToBatch({ workspaceKey, monthKey, customerId, batchId, operatorUser = null, customerLockHeld = false }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    if (!batchRepository.hasBatch(batchId)) {
      throw new Error(`Batch not found: ${batchId}`);
    }
    const normalizedCustomerId = String(customerId || '').trim();
    if (!normalizedCustomerId) {
      throw new Error('customerId is required');
    }

    const batch = batchRepository.loadBatch(batchId);
    assertBatchAccess(batch, operatorUser);
    // 跨工作区护栏(串台 bug 的单客户版):批次属于工作区 A,就不能把工作区 B 的客户塞进来。
    // 之前只堵了 bulk 的 appendWorkspaceToBatch;admin 拥有所有工作区,这条路径同样会串台。
    // 与 bulk 一致:跳过(返回 0),不硬报错——客户图已存好,留在本工作区待正确批次自动追加。
    const batchWorkspace = String(batch.monthlyWorkspaceKey || batch.workspaceKey || '').trim();
    if (batchWorkspace && batchWorkspace !== resolvedWorkspaceKey) {
      return { batch, appendedCustomers: 0, appendedTasks: 0, crossWorkspaceSkipped: true };
    }
    const dirs = batchRepository.batchSubdirs(batchId);
    const customer = customerLibraryRepository.loadCustomer(resolvedWorkspaceKey, normalizedCustomerId);
    assertRecordAccess(customer, operatorUser, 'customer');
    const existingSourceOriginalPaths = getBatchSourceOriginalPathSet(batch);
    const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, normalizedCustomerId);
    const appended = await appendCustomerImagesToBatch({
      batch,
      dirs,
      customer,
      customerPath,
      resolvedWorkspaceKey,
      startIndex: nextTaskSerial(batch),
      existingSourceOriginalPaths,
      customerLockHeld,
    });
    const staleRemoved = cleanupStaleCustomerTasks({ batch, customer, resolvedWorkspaceKey });

    if (appended.taskCount > 0) {
      batch.machineState = 'queued';
    }
    await batchRepository.saveBatchAsync(batch);
    return {
      batch,
      appendedCustomers: appended.taskCount > 0 ? 1 : 0,
      appendedTasks: appended.taskCount,
      staleRemoved,
    };
  }

  async function importMonthToBatch({ monthKey, batchName, scenario = 'FullProcess' }) {
    return importWorkspaceToBatch({ workspaceKey: monthKey, batchName, scenario });
  }

  // 启动恢复扫描(2026-07-21 全链路排查 B6):团号表解析是 fire-and-forget,'parsing' 与
  // 'awaiting_upload' 都是内存态任务的落盘影子——进程重启后解析协程/客户端上传必然已死,
  // 没有任何 reconciler 会再改这两个状态 → 批次永卡「解析中/等上传」,前端据此永久禁用结算
  // (F1 的 pm2 内存重启击杀即此病;OOM 诱因已修,这里补"重启后无恢复"的另一半)。
  // 开机把它们如实标 failed(带人话原因),操作员经「换团号表」重传即可恢复。
  async function recoverInterruptedGroupCodeImports() {
    const ids = (() => { try { return batchRepository.listBatchIds() || []; } catch { return []; } })();
    let recovered = 0;
    for (const batchId of ids) {
      let status;
      try { status = String(batchRepository.loadBatch(batchId)?.groupCodeImport?.status || ''); }
      catch { continue; } // 批次损坏/被删,跳过
      if (status !== 'parsing' && status !== 'awaiting_upload') continue;
      try {
        await stampInBatchQueue(batchId, 'groupCodeRecoverInterrupted', (fresh) => {
          const cur = String(fresh.groupCodeImport?.status || '');
          if (cur !== 'parsing' && cur !== 'awaiting_upload') return; // 竞态:已被别人改,尊重
          fresh.groupCodeImport = {
            ...(fresh.groupCodeImport || {}),
            status: 'failed',
            error: cur === 'parsing'
              ? '服务重启中断了团号表解析,请重新上传团号表(换团号表)'
              : '服务重启中断了团号表上传,请重新上传团号表(换团号表)',
          };
        });
        recovered += 1;
         
        console.warn(`[group_code] 启动恢复:批次 ${batchId} 团号表 ${status} → failed(重启中断,待重传)`);
      } catch (error) {
         
        console.error(`[group_code] 启动恢复失败 ${batchId}: ${error?.message || error}`);
      }
    }
    return recovered;
  }

  return {
    appendCustomerToBatch,
    appendWorkspaceToBatch,
    importMonthToBatch,
    importWorkspaceToBatch,
    recoverInterruptedGroupCodeImports,
    runBatchGroupCodeParse,
    // 给已存在批次挂/换团号表。解析(18~60s)挪后台:这里只把上传好的文件标成 'parsing' 并秒回,
    // 真正解析由 handler 在响应返回后 fire-and-forget 调 runBatchGroupCodeParse 跑完改 'ready'。
    // tour_match 在「结算 / 导入日度台账」时才跑,所以匹配前换表零副作用,下次匹配自动用新表。
    async replaceBatchGroupCode({ batchId, sourceWorkspaceKey = '', filePath, sourceFileName = null, operator = null }) {
      if (!batchGroupCodeImportService?.importFile) throw new Error('团号表导入服务未就绪');
      if (!batchId) throw new Error('batchId required');
      if (!filePath) throw new Error('团号表文件缺失');
      if (!batchRepository.hasBatch(batchId)) throw new Error('批次不存在');
      const resolvedSourceKey = String(sourceWorkspaceKey || '').trim();
      const batch = batchRepository.loadBatch(batchId);
      if (resolvedSourceKey) batch.monthlyWorkspaceKey = resolvedSourceKey;
      batch.groupCodeImport = {
        ...(batch.groupCodeImport || {}),
        scope: 'batch',
        status: 'parsing',
        sourceWorkspaceKey: resolvedSourceKey,
        sourceFile: sourceFileName || null,
      };
      await batchRepository.saveBatchAsync(batch);
      return {
        groupCodeStatus: 'parsing',
        pendingGroupCode: {
          batchId,
          filePath,
          sourceFile: sourceFileName,
          sourceWorkspaceKey: resolvedSourceKey,
          operator,
        },
      };
    },
    setBatchGroupCodeImportService(service) {
      batchGroupCodeImportService = service || null;
    },
    setGroupCodePrematchService(service) {
      groupCodePrematchService = service || null;
    },
  };
}

module.exports = {
  createCustomerBatchBridgeService,
};
