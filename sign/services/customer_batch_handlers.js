const { decodeMultipartFilename } = require('../lib/workbench_utils');
const { logger } = require('../lib/logger');
const { normalizeUploadImages } = require('../lib/heic_normalize');
const { assertBatchAccess } = require('../lib/operator_scope');

function toTrimmedString(value) {
  return String(value || '').trim();
}

function parseEditManifest(value) {
  if (typeof value !== 'string') {
    return Array.isArray(value) ? value : [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function sendBadRequest(res, message) {
  return res.status(400).json({ error: message });
}

function sendError(res, error) {
  return res.status(400).json({ error: String(error?.message || error) });
}

function requireValue(res, value, message) {
  if (!value) {
    sendBadRequest(res, message);
    return false;
  }
  return true;
}

function createCustomerBatchHandlers({
  customerIntakeService,
  customerBatchBridgeService,
  scheduleBatch,
  loadBatch,
  summarizeBatch,
  // 追加图片/换团号表的批次写盘必须走同一把 withBatchWrite 锁(2026-07-13 修丢数据):
  // 否则它们各自 loadBatch→改→saveBatchAsync 绕开锁,与审核 updateTask 的写入交错时整份覆盖
  // batch.json,把刚审好的 reviewed/团号态吞回旧值(刷新即回退)。缺省给直通,防旧测试/调用崩。
  withBatchWrite = (batchId, action) => action(),
  defaultScenario = 'FullProcess',
}) {
  async function appendCustomerImagesFromFiles(req, res) {
    const workspaceKey = toTrimmedString(req.params?.workspaceKey || req.body?.workspaceKey || req.body?.monthKey);
    const customerId = toTrimmedString(req.params?.customerId || req.body?.customerId);
    const batchId = toTrimmedString(req.body?.batchId);
    // HEIC/HEIF 先转 jpg 再进 intake(浏览器/审核台不能显示 heic)。
    const files = await normalizeUploadImages(Array.isArray(req.files) ? req.files : []);
    const editManifest = parseEditManifest(req.body?.editManifest || []);

    if (!requireValue(res, workspaceKey, 'workspaceKey is required')) return res;
    if (!requireValue(res, customerId, 'customerId is required')) return res;
    if (!files.length) return sendBadRequest(res, 'No files uploaded');

    try {
      const appendedImages = await customerIntakeService.appendCustomerImagesFromFiles({
        workspaceKey,
        customerId,
        files,
        editManifest,
        operatorUser: req.user || null,
      });
      let batchAppend = null;
      if (batchId) {
        batchAppend = await withBatchWrite(batchId, () => customerBatchBridgeService.appendCustomerToBatch({
          workspaceKey,
          customerId,
          batchId,
          operatorUser: req.user || null,
        // 单客户追加要拷图,给足超时:withBatchWrite 超时=放行下一个写但动作仍在跑(掉进 clobber 老路),
        // 复审 HIGH——文件拷贝再慢也远不到 3 分钟,拉满兜住(同图在同盘=硬链秒回)。
        }), { label: 'appendCustomerToBatch(images)', timeoutMs: 180_000 });
        if (batchAppend.appendedTasks > 0) {
          scheduleBatch(batchId, { priority: true }); // 操作员在等,插队到补识别前面
        }
      }

      return res.json({
        ok: true,
        workspaceKey,
        batchId,
        ...appendedImages,
        appendedCustomers: batchAppend?.appendedCustomers || 0,
        appendedTasks: batchAppend?.appendedTasks || 0,
        batch: batchAppend?.batch ? summarizeBatch(loadBatch(batchAppend.batch.id), { includeTasks: true }) : null,
        workspaces: customerIntakeService.listWorkspaces(req.user),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async function importCustomerWorkspace(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    const batchName = toTrimmedString(req.body?.batchName);
    const scenario = toTrimmedString(req.body?.scenario || defaultScenario) || defaultScenario;
    const monthlyWorkspaceKey = toTrimmedString(req.body?.monthlyWorkspaceKey);
    const groupCodeImportJobId = toTrimmedString(req.body?.groupCodeImportJobId);
    const groupCodeSourceFile = decodeMultipartFilename(toTrimmedString(req.body?.groupCodeSourceFile || req.file?.originalname));
    const groupCodeFilePath = toTrimmedString(req.file?.path);

    if (!requireValue(res, workspaceKey, 'workspaceKey is required')) return res;
    // 建批次必须绑团号表(2026-07-09 拍板:一批次一表,没表拒建)。三种合法绑定:
    // ①请求直接带表文件 ②两步走先声明文件名(批次出生盖 awaiting_upload,后台上传跟进)
    // ③遗留 monthly jobId 绑定。全没有 → 400,堵住直连 API 造无表批次(预匹配全 pending_table)。
    const hasLegacyMonthlyBinding = Boolean(monthlyWorkspaceKey && groupCodeImportJobId);
    if (!groupCodeFilePath && !groupCodeSourceFile && !hasLegacyMonthlyBinding) {
      return sendBadRequest(res, '建批次必须绑定团号表:请先选择团号表文件');
    }

    try {
      const { batch, pendingGroupCode } = await customerBatchBridgeService.importWorkspaceToBatch({
        workspaceKey,
        batchName: batchName || `${workspaceKey} 客户导入`,
        scenario,
        monthlyWorkspaceKey,
        groupCodeImportJobId,
        groupCodeSourceFile,
        groupCodeFilePath,
        operatorUser: req.user || null,
        allowEmpty: req.body?.allowEmpty === 'true' || req.body?.allowEmpty === true,
        // 用户手填了批次名才校验重名(留空走自动命名,不拦)。
        enforceUniqueName: Boolean(batchName),
      });
      scheduleBatch(batch.id, { priority: true }); // 操作员在等,插队到补识别前面
      // 团号表状态如实取自批次盖章:parsing(带文件)/awaiting_upload(两步走声明)/none(遗留)。
      // 不能只按 pendingGroupCode 推断,否则两步走会被误记成 'none'(reviewer MEDIUM)。
      const groupCodeStatus = pendingGroupCode ? 'parsing' : (batch.groupCodeImport?.status || 'none');
      // 业务日志:谁在哪个工作区建了哪个批次、带几个任务、团号表状态(建批次膨胀/串台可追溯)。
      logger.info({
        event: 'batch_import_workspace',
        operator: req.user?.username || null,
        workspaceKey, batchId: batch.id, batchName: batch.name || null,
        taskCount: (batch.tasks || []).length,
        allowEmpty: req.body?.allowEmpty === 'true' || req.body?.allowEmpty === true,
        groupCodeStatus,
      }, 'import-workspace');
      // 团号表后台化:先把批次秒返回,团号表解析(18~60s)放后台跑,不卡操作员。
      res.json({
        ok: true,
        batchId: batch.id,
        groupCodeStatus,
        batch: summarizeBatch(loadBatch(batch.id), { includeTasks: false }),
      });
      if (pendingGroupCode && typeof customerBatchBridgeService.runBatchGroupCodeParse === 'function') {
        Promise.resolve()
          .then(() => customerBatchBridgeService.runBatchGroupCodeParse(pendingGroupCode))
           
          .catch((err) => console.error('[groupcode bg parse]', batch.id, err?.message || err));
      }
      return res;
    } catch (error) {
      return sendError(res, error);
    }
  }

  async function appendCustomerWorkspaceToBatch(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    const batchId = toTrimmedString(req.body?.batchId || req.body?.currentBatchId);

    if (!requireValue(res, workspaceKey, 'workspaceKey is required')) return res;
    if (!requireValue(res, batchId, 'batchId is required')) return res;

    try {
      // 整个工作区追加:遍历所有客户逐张拷图,最重——给 5 分钟超时(复审 HIGH:超时会放行下一个写
      // 但拷图动作仍在后台跑 saveBatchAsync 盖掉它,重演丢数据;拉满避免大工作区超 30s 默认值)。
      const result = await withBatchWrite(batchId, () => customerBatchBridgeService.appendWorkspaceToBatch({
        workspaceKey,
        batchId,
        operatorUser: req.user || null,
      }), { label: 'appendWorkspaceToBatch', timeoutMs: 300_000 });

      // T6-B 改道执行(死锁修复,审计 HIGH line 510):service 只**收集** pendingRedirects,
      // 由这里在**当前批次锁已释放**后逐个 withBatchWrite(intended) 单锁执行——任一时刻只持一把
      // 批次锁,跨 sweep 交叉也不成环。单个失败 try/catch 计 redirectFailed 不拖垮整轮(客户留库
      // 下轮再试);appendedTasks>0 的意向批次各自插队补识别。
      let redirectedCustomers = 0;
      let redirectedTasks = 0;
      let redirectFailed = 0;
      for (const redirect of (Array.isArray(result.pendingRedirects) ? result.pendingRedirects : [])) {
        try {
          const out = await withBatchWrite(redirect.intended, () => customerBatchBridgeService.appendCustomerToBatch({
            workspaceKey,
            customerId: redirect.customerId,
            batchId: redirect.intended,
            operatorUser: req.user || null,
          }), { label: 'appendWorkspaceRedirect', timeoutMs: 180_000 });
          redirectedCustomers += out.appendedCustomers || 0;
          redirectedTasks += out.appendedTasks || 0;
          if ((out.appendedTasks || 0) > 0) {
            scheduleBatch(redirect.intended, { priority: true });
          }
        } catch (redirectError) {
          redirectFailed += 1;
          logger.warn({
            event: 'batch_append_redirect_failed',
            operator: req.user?.username || null,
            workspaceKey, customerId: redirect.customerId, intended: redirect.intended,
            error: String(redirectError?.message || redirectError),
          }, 'append-workspace-redirect-failed');
        }
      }

      // 业务日志:谁把几个客户从哪个工作区追进哪个批次(串台/膨胀一眼可查)。
      logger.info({
        event: 'batch_append_workspace',
        operator: req.user?.username || null,
        workspaceKey, batchId,
        appendedCustomers: result.appendedCustomers,
        appendedTasks: result.appendedTasks,
        redirectedCustomers, redirectedTasks, redirectFailed,
      }, 'append-workspace');
      if (result.appendedTasks > 0) {
        scheduleBatch(batchId, { priority: true }); // 操作员在等,插队到补识别前面
      }
      return res.json({
        ok: true,
        workspaceKey,
        batchId,
        appendedCustomers: result.appendedCustomers,
        appendedTasks: result.appendedTasks,
        redirectedCustomers,
        redirectedTasks,
        redirectFailed,
        batch: summarizeBatch(loadBatch(batchId), { includeTasks: false }),
        customers: customerIntakeService.listCustomers(workspaceKey, req.user),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async function appendCustomerToBatch(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    const customerId = toTrimmedString(req.body?.customerId);
    const batchId = toTrimmedString(req.body?.batchId || req.body?.currentBatchId);

    if (!requireValue(res, workspaceKey, 'workspaceKey is required')) return res;
    if (!requireValue(res, customerId, 'customerId is required')) return res;
    if (!requireValue(res, batchId, 'batchId is required')) return res;

    try {
      const result = await withBatchWrite(batchId, () => customerBatchBridgeService.appendCustomerToBatch({
        workspaceKey,
        customerId,
        batchId,
        operatorUser: req.user || null,
      }), { label: 'appendCustomerToBatch', timeoutMs: 180_000 });
      if (result.appendedTasks > 0) {
        scheduleBatch(batchId, { priority: true }); // 操作员在等,插队到补识别前面
      }
      return res.json({
        ok: true,
        workspaceKey,
        customerId,
        batchId,
        appendedCustomers: result.appendedCustomers,
        appendedTasks: result.appendedTasks,
        batch: summarizeBatch(loadBatch(batchId), { includeTasks: true }),
        customers: customerIntakeService.listCustomers(workspaceKey, req.user),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  // 替换本批次团号表（审核台「当前批次」卡入口）：只换 batch_group_code，不动客户图/审核进度。
  // 适用于 tour_match（导入日度台账）之前换表 —— 零副作用，下次匹配自动用新表。
  async function replaceBatchGroupCode(req, res) {
    const batchId = toTrimmedString(req.params?.batchId || req.body?.batchId);
    const filePath = toTrimmedString(req.file?.path);
    const sourceFileName = decodeMultipartFilename(toTrimmedString(req.file?.originalname));
    if (!requireValue(res, batchId, 'batchId is required')) return res;
    if (!requireValue(res, filePath, '请选择团号表文件')) return res;
    try {
      const batch = loadBatch(batchId);
      if (!batch) return sendBadRequest(res, '批次不存在');
      // owner 门禁(8模块审计 HIGH:换团号表会改写 monthlyWorkspaceKey/工作区绑定,影响后续匹配)——
      // 仅本人批次或 admin/finance 可换表,reviewer 不得给他人批次换表。照 assertBatchAccess 全局口径。
      try {
        assertBatchAccess(batch, req.user);
      } catch {
        return res.status(403).json({ error: '无权修改他人批次的团号表(仅本人或管理员可换表)' });
      }
      const sourceWorkspaceKey = toTrimmedString(batch.monthlyWorkspaceKey || batch.sourceWorkspaceKey || batch.workspaceKey);
      // 团号表后台化:bridge 只把上传好的文件标 'parsing' 秒回,真正解析在响应返回后 fire-and-forget 跑。
      // 这一步(标 parsing)也写 batch.json,必须走批次写锁,否则与审核 updateTask 并发互吞。
      const { pendingGroupCode, ...result } = await withBatchWrite(batchId, () => customerBatchBridgeService.replaceBatchGroupCode({
        batchId, sourceWorkspaceKey, filePath, sourceFileName, operator: req.user?.username || null,
      }), { label: 'replaceBatchGroupCode' });
      res.json({
        ok: true, batchId, ...result,
        batch: summarizeBatch(loadBatch(batchId), { includeTasks: false }),
      });
      if (pendingGroupCode && typeof customerBatchBridgeService.runBatchGroupCodeParse === 'function') {
        Promise.resolve()
          .then(() => customerBatchBridgeService.runBatchGroupCodeParse(pendingGroupCode))
           
          .catch((err) => console.error('[groupcode bg parse]', batchId, err?.message || err));
      }
      return res;
    } catch (error) {
      return sendError(res, error);
    }
  }

  return {
    appendCustomerImagesFromFiles,
    appendCustomerToBatch,
    appendCustomerWorkspaceToBatch,
    importCustomerWorkspace,
    replaceBatchGroupCode,
  };
}

module.exports = {
  createCustomerBatchHandlers,
};
