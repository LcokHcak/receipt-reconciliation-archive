const { normalizeUploadImages } = require('../lib/heic_normalize');

function toTrimmedString(value) {
  return String(value || '').trim();
}

// 0729 静默排查:原来是 `try { return loadBatch(id) } catch { return null }`,
// 把「没接这个加载器」和「加载器抛错(batch.json 损坏)」压成同一个 null。
// 而调用侧的护栏写作 `batchWorkspace && batchWorkspace !== workspaceKey` ——
// 左值为空就**短路跳过**,于是批次文件一旦损坏,跨工作区护栏形同虚设、上传照常放行。
// 后果不是丢图:客户会正常建档,但下游桥接的第二道护栏会把它判成跨工作区跳过,
// 客户从此**悬在库里、永远进不了任何批次的审核队列**,而没有任何一处告诉操作员为什么。
// 这里改成把两种情况分开:读不出来就明说,别让人上传进一个空洞。
function safeLoadBatch(loadBatch, batchId) {
  try { return { batch: loadBatch(batchId), error: null }; }
  catch (err) { return { batch: null, error: String(err?.message || err) }; }
}

function toErrorResponse(res, error) {
  return res.status(400).json({ error: String(error?.message || error) });
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

function createCustomerLibraryHandlers({
  customerIntakeService,
  workbenchStateService,
  removeReviewCustomerGroup = async () => null,
  batchExists = () => true,
  loadBatchForGuard = null, // 批次前置校验用(读 batch.monthlyWorkspaceKey 比对工作区)
}) {
  function getCustomerLibraryState(req, res) {
    return res.json(workbenchStateService.getCustomerLibraryState(req.user));
  }

  function setCustomerLibraryRoot(req, res) {
    const rootPath = toTrimmedString(req.body?.rootPath);
    if (!rootPath) {
      return res.status(400).json({ error: 'rootPath is required' });
    }

    try {
      const activeRoot = customerIntakeService.setActiveRoot(rootPath);
      const workspaces = customerIntakeService.listWorkspaces(req.user);
      return res.json({
        ok: true,
        activeRoot,
        workspaceKey: workspaces.at(-1) || '',
        workspaces,
        months: customerIntakeService.listMonths(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  function listCustomerLibraryWorkspaces(req, res) {
    const workspaces = customerIntakeService.listWorkspaces(req.user);
    return res.json({
      ok: true,
      workspaceKey: workspaces.at(-1) || '',
      workspaces,
      months: customerIntakeService.listMonths(req.user),
    });
  }

  function ensureCustomerLibraryWorkspace(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    if (!workspaceKey) {
      return res.status(400).json({ error: 'workspaceKey is required' });
    }

    try {
      const workspacePath = customerIntakeService.ensureWorkspace(workspaceKey, { ownerUser: req.user || null });
      const workspaces = customerIntakeService.listWorkspaces(req.user);
      return res.json({
        ok: true,
        workspaceKey,
        workspacePath,
        workspaces,
        months: customerIntakeService.listMonths(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  function listWorkspaceCustomers(req, res) {
    const workspaceKey = toTrimmedString(req.params?.workspaceKey || req.params?.monthKey);
    try {
      return res.json({
        ok: true,
        workspaceKey,
        monthKey: workspaceKey,
        customers: customerIntakeService.listCustomers(workspaceKey, req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  function createCustomer(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    const agentName = toTrimmedString(req.body?.agentName);
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    if (!workspaceKey) {
      return res.status(400).json({ error: 'workspaceKey is required' });
    }
    if (!agentName) {
      return res.status(400).json({ error: 'agentName is required' });
    }

    try {
      return res.json({
        ok: true,
        ...customerIntakeService.createCustomer({
          workspaceKey,
          agentName,
          images,
          ownerUser: req.user || null,
        }),
        workspaceKey,
        workspaces: customerIntakeService.listWorkspaces(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  async function createCustomerFromFiles(req, res) {
    const workspaceKey = toTrimmedString(req.body?.workspaceKey || req.body?.monthKey);
    const agentName = toTrimmedString(req.body?.agentName);
    // HEIC/HEIF(iPhone 默认)先转 jpg,再进 intake——下游浏览器/审核台才显示得了。
    const files = await normalizeUploadImages(Array.isArray(req.files) ? req.files : []);
    const editManifest = parseEditManifest(req.body?.editManifest || []);

    if (!workspaceKey) {
      return res.status(400).json({ error: 'workspaceKey is required' });
    }
    if (!agentName) {
      return res.status(400).json({ error: 'agentName is required' });
    }
    // 批次前置(硬性要求):必须先建/选当前审核批次才能收图。
    // 架构意义:团号表绑批次 → 保证识别时预匹配一定有表可查;顺带杜绝"未入批次"游离客户。
    // 只拦"新建客户收图";审核台补图(append)走别的 handler 不受影响(坏图补救不能被卡)。
    const batchId = toTrimmedString(req.body?.batchId);
    if (!batchId) {
      return res.status(400).json({ error: '请先建立/选择「当前审核批次」再导入图片(批次会绑团号表,识别完自动出团号模式)' });
    }
    if (!batchExists(batchId)) {
      return res.status(400).json({ error: '当前审核批次已不存在(可能被删),请重选或新建批次后再导入' });
    }
    const guard = typeof loadBatchForGuard === 'function' ? safeLoadBatch(loadBatchForGuard, batchId) : null;
    // 读得出批次记录才谈得上校验工作区。读不出来(batch.json 损坏/权限异常)时,
    // 旧写法会因为 batchWorkspace 为空而**短路跳过整个护栏**,把图收进一个稍后
    // 桥接必被跳过的批次里——客户从此悬在库里、永远进不了审核队列,还没人知道为什么。
    // 与其放行,不如当场说清:批次本身坏了,换一个。
    if (guard?.error) {
      return res.status(400).json({
        error: `当前审核批次的记录文件读不出来(可能已损坏),没法确认它属于哪个工作区,`
          + `为避免图片收进去之后进不了审核队列,请重选或新建批次。技术信息:${guard.error}`,
      });
    }
    const batchWorkspace = String(guard?.batch?.monthlyWorkspaceKey || '').trim();
    if (batchWorkspace && batchWorkspace !== workspaceKey) {
      return res.status(400).json({ error: `当前批次属于工作区「${batchWorkspace}」,与本次上传的工作区「${workspaceKey}」不一致,请重选批次` });
    }
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    try {
      return res.json({
        ok: true,
        ...await customerIntakeService.createCustomerFromFiles({
          workspaceKey,
          agentName,
          files,
          editManifest,
          ownerUser: req.user || null,
          // T6-B 归属快照:上面已校验过存在性+工作区一致,落盘给自动追加定向归属用。
          intendedBatchId: batchId,
        }),
        workspaceKey,
        workspaces: customerIntakeService.listWorkspaces(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  async function deleteCustomerLibraryWorkspace(req, res) {
    const workspaceKey = toTrimmedString(req.params?.workspaceKey);
    if (!workspaceKey) {
      return res.status(400).json({ error: 'workspaceKey is required' });
    }

    try {
      // L631:deleteWorkspace 现走 workspace-exclusive(等 shared drain)→ async,必须 await。
      const deleted = await customerIntakeService.deleteWorkspace({
        workspaceKey,
        force: true,
      });
      const workspaces = customerIntakeService.listWorkspaces(req.user);
      return res.json({
        ok: true,
        ...deleted,
        workspaceKey: workspaces.at(-1) || '',
        workspaces,
        months: customerIntakeService.listMonths(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  async function deleteWorkspaceCustomer(req, res) {
    const workspaceKey = toTrimmedString(req.params?.workspaceKey);
    const customerId = toTrimmedString(req.params?.customerId);
    if (!workspaceKey) {
      return res.status(400).json({ error: 'workspaceKey is required' });
    }
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    try {
      const reviewSync = await removeReviewCustomerGroup({
        workspaceKey,
        customerId,
        operatorUser: req.user || null,
      });
      // B5(2026-07-16 同步一致性审计):批次侧拒绝(已审/已结算)时此前照样物理删客户目录 →
      // "客户删了、批次任务留着"的半删状态(原图404/投影orphan)。改为整体拒绝,让操作员先处理批次侧。
      if (reviewSync && reviewSync.removed === false
        && ['already_reviewed', 'already_settled'].includes(String(reviewSync.reason || ''))) {
        return res.status(409).json({
          ok: false,
          error: reviewSync.reason === 'already_settled'
            ? '该客户组已结算,不可删除(台账证据保护)'
            : '该客户组已审核,先在审核台处理(撤销审核/删除组)后再删客户,避免半删状态',
          code: `delete_blocked_${reviewSync.reason}`,
          reviewSync,
        });
      }
      const deleted = await customerIntakeService.deleteCustomer({
        workspaceKey,
        customerId,
        force: true,
        operatorUser: req.user || null,
      });
      return res.json({
        ok: true,
        ...deleted,
        reviewSync,
        workspaceKey,
        customers: customerIntakeService.listCustomers(workspaceKey, req.user),
        workspaces: customerIntakeService.listWorkspaces(req.user),
        months: customerIntakeService.listMonths(req.user),
      });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  // 库清理:列出"孤儿客户"——曾导入某审核批次,但该批次已被删 → 库里原图变废数据。
  // 判定:review.lastBatchId 指向的批次 batchExists()=false。没 lastBatchId = 没导入过(还是活数据,不算孤儿)。
  function listLibraryOrphans(req, res) {
    try {
      const workspaces = customerIntakeService.listWorkspaces(req.user) || [];
      const orphans = [];
      let totalImages = 0;
      for (const ws of workspaces) {
        const customers = customerIntakeService.listCustomers(ws, req.user) || [];
        for (const c of customers) {
          const lastBatchId = toTrimmedString(c?.review?.lastBatchId);
          if (!lastBatchId) continue;
          if (batchExists(lastBatchId)) continue;
          const imageCount = Array.isArray(c.images) ? c.images.length : 0;
          totalImages += imageCount;
          orphans.push({
            workspaceKey: ws,
            customerId: c.customerId,
            agentName: c.agentName || c?.review?.customerAgentName || '',
            imageCount,
            lastBatchId,
            status: c.status || '',
          });
        }
      }
      return res.json({ ok: true, orphans, totalCustomers: orphans.length, totalImages });
    } catch (error) {
      return toErrorResponse(res, error);
    }
  }

  // 批量删除孤儿客户(删前二次校验:批次确实仍不存在才删,防并发误删)。复用单客户删除逻辑。
  async function deleteLibraryOrphans(req, res) {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: '没有要删除的项' });
    }
    const results = [];
    for (const it of items) {
      const workspaceKey = toTrimmedString(it?.workspaceKey);
      const customerId = toTrimmedString(it?.customerId);
      if (!workspaceKey || !customerId) {
        results.push({ workspaceKey, customerId, ok: false, error: '参数缺失' });
        continue;
      }
      try {
        const customers = customerIntakeService.listCustomers(workspaceKey, req.user) || [];
        const found = customers.find((x) => String(x.customerId) === customerId);
        const lastBatchId = toTrimmedString(found?.review?.lastBatchId);
        // 孤儿=在库、曾导入过某批次(有 lastBatchId)、且该批次现已不存在。其余一律**非孤儿,拒删**
        // (审计MEDIUM:此前 found/lastBatchId 缺失时直接放行物理删,把活客户/漏判的图删掉):
        //  - 不在库:已删或客户端自报了坏 customerId,别删;
        //  - 没 lastBatchId:从没导入过审核批次=活数据(与 listLibraryOrphans:259 同口径);
        //  - 批次仍在:正在用,防并发误删。
        if (!found) {
          results.push({ workspaceKey, customerId, ok: false, error: '客户不存在或已删除,已跳过' });
          continue;
        }
        if (!lastBatchId) {
          results.push({ workspaceKey, customerId, ok: false, error: '未导入过审核批次的活客户,非孤儿,已跳过' });
          continue;
        }
        if (batchExists(lastBatchId)) {
          results.push({ workspaceKey, customerId, ok: false, error: '该客户的批次仍存在,已跳过' });
          continue;
        }
        // 复核视图侧拒绝(已审/已结算)→ 尊重它,不物理删(照 deleteWorkspaceCustomer:227 先例,避免半删)
        const reviewSync = await removeReviewCustomerGroup({ workspaceKey, customerId, operatorUser: req.user || null });
        if (reviewSync && reviewSync.removed === false
          && ['already_reviewed', 'already_settled'].includes(String(reviewSync.reason || ''))) {
          results.push({ workspaceKey, customerId, ok: false, error: `复核视图拒绝(${reviewSync.reason}),已跳过`, reason: reviewSync.reason });
          continue;
        }
        await customerIntakeService.deleteCustomer({ workspaceKey, customerId, force: true, operatorUser: req.user || null });
        results.push({ workspaceKey, customerId, ok: true });
      } catch (error) {
        results.push({ workspaceKey, customerId, ok: false, error: error?.message || String(error) });
      }
    }
    const deleted = results.filter((r) => r.ok).length;
    return res.json({ ok: true, deleted, total: items.length, results });
  }

  return {
    createCustomer,
    createCustomerFromFiles,
    deleteCustomerLibraryWorkspace,
    deleteWorkspaceCustomer,
    deleteLibraryOrphans,
    ensureCustomerLibraryWorkspace,
    getCustomerLibraryState,
    listCustomerLibraryWorkspaces,
    listLibraryOrphans,
    listWorkspaceCustomers,
    setCustomerLibraryRoot,
  };
}

module.exports = {
  createCustomerLibraryHandlers,
};
