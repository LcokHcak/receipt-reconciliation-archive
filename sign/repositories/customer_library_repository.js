const fs = require('node:fs');
const path = require('node:path');

const {
  assertValidCustomerId,
  assertValidCustomerStatus,
  assertValidCustomerStatusTransition,
  createCustomerRecord,
} = require('../lib/customer_record');
const { ensureDir, formatBusinessDateStamp } = require('../lib/workbench_utils');
const {
  ensureInsideRoot,
  normalizeWorkspaceKey,
  resolveWorkspacePath,
} = require('../lib/customer_library_paths');
const {
  buildOwnerMetadata,
  canAccessAllOperatorData,
  isRecordOwnedByUser,
} = require('../lib/operator_scope');

function createCustomerLibraryRepository({
  defaultRoot,
  settingsPath,
  nowProvider = () => new Date(),
  // 代理工作台V2(Task3):客户增量投影钩子(依赖注入,默认no-op)。
  // 铁律:钩子失败不回滚客户JSON主写入——safeProjectionHook 吞错并转交 onError 记录重试项。
  projectionHooks = null,
}) {
  function safeProjectionHook(event, payload) {
    if (!projectionHooks || typeof projectionHooks[event] !== 'function') return;
    try {
      projectionHooks[event](payload);
    } catch (error) {
      try { projectionHooks.onError?.(error, { event, payload }); } catch { /* onError 自身不许炸主流程 */ }
    }
  }
  function readSettings() {
    if (!settingsPath || !fs.existsSync(settingsPath)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (_error) {
      return {};
    }
  }

  function writeSettings(value) {
    ensureDir(path.dirname(settingsPath));
    fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8');
  }

  function getActiveRoot() {
    const settings = readSettings();
    return path.resolve(settings.activeRoot || defaultRoot);
  }

  function setActiveRoot(rootPath) {
    const resolvedRoot = path.resolve(rootPath);
    ensureDir(resolvedRoot);
    writeSettings({ activeRoot: resolvedRoot });
    return resolvedRoot;
  }

  function resolveWorkspaceKey(workspaceKey, monthKey) {
    return normalizeWorkspaceKey(workspaceKey || monthKey);
  }

  function workspaceMetadataPath(workspaceKey) {
    return path.join(workspaceDir(workspaceKey), '.workspace.json');
  }

  function loadWorkspaceMetadata(workspaceKey) {
    const filePath = workspaceMetadataPath(workspaceKey);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function saveWorkspaceOwnerMetadata(workspaceKey, ownerUser = null) {
    const owner = buildOwnerMetadata(ownerUser);
    if (!owner.ownerUsername && owner.ownerUserId == null) {
      return null;
    }
    const filePath = workspaceMetadataPath(workspaceKey);
    const existing = loadWorkspaceMetadata(workspaceKey) || {};
    const nowIso = nowProvider().toISOString();
    const next = {
      ...existing,
      workspaceKey: resolveWorkspaceKey(workspaceKey),
      ownerUserId: existing.ownerUserId ?? owner.ownerUserId,
      ownerUsername: existing.ownerUsername || owner.ownerUsername,
      createdBy: existing.createdBy || owner.createdBy || owner.ownerUsername || null,
      createdAt: existing.createdAt || nowIso,
      updatedAt: nowIso,
    };
    saveJson(filePath, next);
    return next;
  }

  function ensureWorkspace(workspaceKey, { ownerUser = null } = {}) {
    const workspacePath = resolveWorkspacePath(getActiveRoot(), workspaceKey);
    ensureDir(workspacePath);
    saveWorkspaceOwnerMetadata(workspaceKey, ownerUser);
    return workspacePath;
  }

  function ensureMonth(monthKey) {
    return ensureWorkspace(monthKey);
  }

  function readCustomerRecord(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  function normalizeCustomerRecord(record) {
    if (!record || typeof record !== 'object') {
      return record;
    }
    const workspaceKey = resolveWorkspaceKey(record.workspaceKey, record.monthKey);
    return {
      ...record,
      workspaceKey,
      monthKey: workspaceKey,
    };
  }

  function workspaceDir(workspaceKey) {
    return resolveWorkspacePath(getActiveRoot(), workspaceKey);
  }

  function findExistingCustomerDirectory(workspaceKey, customerId) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey);
    const workspacePath = workspaceDir(resolvedWorkspaceKey);
    if (!fs.existsSync(workspacePath)) {
      return null;
    }

    const directPath = path.join(workspacePath, customerId);
    if (fs.existsSync(path.join(directPath, 'customer.json'))) {
      return directPath;
    }

    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const filePath = path.join(workspacePath, entry.name, 'customer.json');
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        const record = normalizeCustomerRecord(readCustomerRecord(filePath));
        if (String(record?.customerId || '').trim() === customerId) {
          return path.join(workspacePath, entry.name);
        }
      } catch (_error) {
        // Ignore malformed records while scanning.
      }
    }

    return null;
  }

  function findCustomerDirectory(workspaceKey, customerId) {
    const existingDir = findExistingCustomerDirectory(workspaceKey, customerId);
    if (existingDir) {
      return existingDir;
    }
    return path.join(ensureWorkspace(workspaceKey), customerId);
  }

  function customerDir(workspaceKey, customerId) {
    assertValidCustomerId(customerId);
    return findCustomerDirectory(workspaceKey, customerId);
  }

  function customerJsonPath(workspaceKey, customerId) {
    return path.join(customerDir(workspaceKey, customerId), 'customer.json');
  }

  function saveJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  function isWorkspaceVisibleToUser(workspaceKey, operatorUser = null) {
    if (canAccessAllOperatorData(operatorUser)) {
      return true;
    }
    const metadata = loadWorkspaceMetadata(workspaceKey);
    if (metadata && isRecordOwnedByUser(metadata, operatorUser)) {
      return true;
    }
    return listCustomers(workspaceKey).some((customer) => isRecordOwnedByUser(customer, operatorUser));
  }

  function listWorkspaces(operatorUser = null) {
    const rootPath = getActiveRoot();
    if (!fs.existsSync(rootPath)) {
      return [];
    }

    return fs
      .readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((workspaceKey) => isWorkspaceVisibleToUser(workspaceKey, operatorUser))
      .sort((a, b) => a.localeCompare(b));
  }

  function listMonths(operatorUser = null) {
    return listWorkspaces(operatorUser);
  }

  function allocateCustomerId(workspaceKey) {
    const workspacePath = ensureWorkspace(workspaceKey);
    const dateStamp = formatBusinessDateStamp(nowProvider());
    const prefix = `CL${dateStamp}-`;
    const highestSerial = fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => /^CL\d{8}-(\d{3,4})$/.exec(entry.name))
      .filter(Boolean)
      .filter((match) => entryMatchesPrefix(match, prefix))
      .map((match) => Number.parseInt(match[1], 10) || 0)
      .reduce((highest, value) => Math.max(highest, value), 0);

    // 原子占位:同步 mkdirSync(非递归)谁建成功谁占到该序号;EEXIST(被并发占了)→ 试下一个。
    // 整个循环同步、中间无 await → 并发调用被事件循环天然串行,杜绝两人拿到同一个号
    // (旧实现"读 max+1"与建目录之间隔着 await,30 并发时全部读到空目录 → 全撞 -001)。
    // 序号 1-999 → 3 位,1000-9999 → 4 位(padStart 不截断);上限 9999/天/工作区。
    for (let serial = highestSerial + 1; serial <= 9999; serial += 1) {
      const customerId = `${prefix}${String(serial).padStart(3, '0')}`;
      try {
        fs.mkdirSync(customerDir(workspaceKey, customerId));
        return customerId;
      } catch (error) {
        if (error && error.code === 'EEXIST') continue;
        throw error;
      }
    }
    const exhausted = new Error(`当日客户号已达上限(9999):${prefix}`);
    exhausted.code = 'CUSTOMER_ID_EXHAUSTED';
    throw exhausted;
  }

  function entryMatchesPrefix(match, prefix) {
    return match.input.startsWith(prefix);
  }

  function createCustomerFolder({
    workspaceKey,
    monthKey,
    customerId,
    agentName,
    images = [],
    template = {},
    ownerUserId = null,
    ownerUsername = null,
    createdBy = null,
  }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    const nowIso = nowProvider().toISOString();
    const record = createCustomerRecord({
      customerId,
      workspaceKey: resolvedWorkspaceKey,
      monthKey: resolvedWorkspaceKey,
      agentName,
      images,
      template,
      nowIso,
      ownerUserId,
      ownerUsername,
      createdBy,
    });
    const dirPath = customerDir(resolvedWorkspaceKey, customerId);
    ensureDir(dirPath);
    saveJson(customerJsonPath(resolvedWorkspaceKey, customerId), record);
    safeProjectionHook('afterCustomerSaved', record);
    return record;
  }

  function loadCustomer(workspaceKey, customerId) {
    return normalizeCustomerRecord(readCustomerRecord(customerJsonPath(workspaceKey, customerId)));
  }

  function saveCustomer(record) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(record?.workspaceKey, record?.monthKey);
    assertValidCustomerId(record?.customerId);
    assertValidCustomerStatus(record?.status);
    const existingPath = customerJsonPath(resolvedWorkspaceKey, record.customerId);
    const existing = fs.existsSync(existingPath)
      ? loadCustomer(resolvedWorkspaceKey, record.customerId)
      : null;

    if (existing) {
      assertValidCustomerStatusTransition(existing.status, record.status);
    }

    const nextRecord = normalizeCustomerRecord({
      ...record,
      workspaceKey: resolvedWorkspaceKey,
      monthKey: resolvedWorkspaceKey,
      updatedAt: nowProvider().toISOString(),
    });
    saveJson(existingPath, nextRecord);
    safeProjectionHook('afterCustomerSaved', nextRecord);
    return nextRecord;
  }

  // G11a: 默认过滤软删客户 (deletedAt 非空);includeDeleted=true 给 admin tombstone 视图
  function listCustomers(workspaceKey, { includeDeleted = false } = {}) {
    const workspacePath = ensureWorkspace(workspaceKey);
    return fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const filePath = path.join(workspacePath, entry.name, 'customer.json');
        if (!fs.existsSync(filePath)) {
          return null;
        }
        return normalizeCustomerRecord(readCustomerRecord(filePath));
      })
      .filter(Boolean)
      .filter((record) => includeDeleted || !record.deletedAt)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function renameCustomerFolder(workspaceKey, customerId, nextFolderName) {
    const currentDir = customerDir(workspaceKey, customerId);
    const nextDir = ensureInsideRoot(
      getActiveRoot(),
      path.join(workspaceDir(workspaceKey), String(nextFolderName || '').trim())
    );
    if (path.resolve(currentDir) === path.resolve(nextDir)) {
      return nextDir;
    }
    if (fs.existsSync(nextDir)) {
      // 同名归档文件夹已存在 = 同一个人(英文名_护照号)疑似被重复建档。
      // 打 code 让 approve/settle 路由转成可读 409,而不是落兜底 500 "Internal error"。
      const error = new Error(`Customer folder already exists: ${nextFolderName}`);
      error.code = 'CUSTOMER_FOLDER_EXISTS';
      error.folderName = String(nextFolderName || '').trim();
      throw error;
    }
    fs.renameSync(currentDir, nextDir);
    return nextDir;
  }

  // G11a: 三种删法 ——
  //   {}                    → 软删 (新默认): 写 deletedAt + 保留文件夹,审计/月度溯源能找回
  //   { force: true }       → 物理删 (legacy 调用约定不变)
  //   { hard: true }        → 物理删 (新调用方明确意图)
  //   { soft: true } 强制软删,即使 force 也保留 (admin UI 走这个)
  function deleteCustomer(workspaceKey, customerId, { force = false, hard = false, soft = false, deletedBy = null } = {}) {
    const existingDir = findExistingCustomerDirectory(workspaceKey, customerId);
    if (!existingDir) {
      return {
        deleted: false,
        customerId,
        workspaceKey: resolveWorkspaceKey(workspaceKey),
      };
    }

    const targetDir = ensureInsideRoot(getActiveRoot(), existingDir);

    // 物理删: hard 显式 || force 兼容
    if ((hard || force) && !soft) {
      fs.rmSync(targetDir, { recursive: true, force: Boolean(force) });
      safeProjectionHook('afterCustomerDeleted', { workspaceKey: resolveWorkspaceKey(workspaceKey), customerId });
      return {
        deleted: true,
        soft: false,
        customerId,
        workspaceKey: resolveWorkspaceKey(workspaceKey),
        customerDir: targetDir,
      };
    }

    // 软删 — 直接改 customer.json,不走 saveCustomer (避免触发 status transition assert)
    const jsonPath = path.join(targetDir, 'customer.json');
    if (fs.existsSync(jsonPath)) {
      const existing = readCustomerRecord(jsonPath);
      const nowIso = nowProvider().toISOString();
      const tombstone = {
        ...existing,
        deletedAt: nowIso,
        deletedBy: deletedBy ? String(deletedBy) : null,
        updatedAt: nowIso,
      };
      saveJson(jsonPath, tombstone);
    }

    // 软删客户 listCustomers 已过滤 → 读模型同样移除该行(墓碑不进代理工作台)。
    safeProjectionHook('afterCustomerDeleted', { workspaceKey: resolveWorkspaceKey(workspaceKey), customerId });
    return {
      deleted: true,
      soft: true,
      customerId,
      workspaceKey: resolveWorkspaceKey(workspaceKey),
      customerDir: targetDir,
    };
  }

  function deleteWorkspace(workspaceKey, { force = false } = {}) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey);
    const targetDir = workspaceDir(resolvedWorkspaceKey);
    if (!fs.existsSync(targetDir)) {
      return {
        deleted: false,
        workspaceKey: resolvedWorkspaceKey,
      };
    }

    // 投影钩子:整库删除前逐客户通知读模型移除,否则读模型留下永久幽灵行(只能手动 rebuild 清)。
    // 读 customer.json 拿真 customerId(文件夹名可能是改过的显示名)。
    try {
      for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jsonPath = path.join(targetDir, entry.name, 'customer.json');
        if (!fs.existsSync(jsonPath)) continue;
        let customerId = entry.name;
        try {
          const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          customerId = String(parsed.customerId || parsed.id || entry.name).trim() || entry.name;
        } catch {
          // 坏 JSON 用文件夹名兜底
        }
        safeProjectionHook('afterCustomerDeleted', { workspaceKey: resolvedWorkspaceKey, customerId });
      }
    } catch {
      // 枚举失败不阻断删除主操作
    }

    fs.rmSync(targetDir, { recursive: true, force: Boolean(force) });
    return {
      deleted: true,
      workspaceKey: resolvedWorkspaceKey,
      workspacePath: targetDir,
    };
  }

  function findCustomerByReviewReference(batchId, sourceGroupId) {
    for (const workspaceKey of listWorkspaces()) {
      for (const customer of listCustomers(workspaceKey)) {
        if (
          String(customer?.review?.lastBatchId || '').trim() === String(batchId || '').trim()
          && String(customer?.review?.lastSourceGroupId || '').trim() === String(sourceGroupId || '').trim()
        ) {
          return customer;
        }
      }
    }
    return null;
  }

  return {
    allocateCustomerId,
    createCustomerFolder,
    customerDir,
    customerJsonPath,
    deleteCustomer,
    deleteWorkspace,
    ensureMonth,
    ensureWorkspace,
    findCustomerByReviewReference,
    findCustomerDirectory,
    findExistingCustomerDirectory,
    getActiveRoot,
    loadWorkspaceMetadata,
    loadCustomer,
    listCustomers,
    listMonths,
    listWorkspaces,
    renameCustomerFolder,
    saveCustomer,
    setActiveRoot,
    workspaceDir,
  };
}

module.exports = {
  createCustomerLibraryRepository,
};
