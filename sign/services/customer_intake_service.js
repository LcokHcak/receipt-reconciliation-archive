const {
  assertRecordAccess,
  buildOwnerMetadata,
  filterRecordsByOperator,
} = require('../lib/operator_scope');
const { ensureDir } = require('../lib/workbench_utils');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
// L631:per-workspace 读写锁——建档类(异步且 await 后写盘)走 shared 保并发,deleteWorkspace 走
// exclusive 独占整库 rmSync。防「rmSync 删一半、await 让点后建档 op 尾部 saveCustomer 复活残壳」竞态。
const { withWorkspaceShared, withWorkspaceExclusive } = require('../lib/customer_workspace_lock');

function createCustomerIntakeService({
  customerLibraryRepository,
  customerTemplateRepository,
  customerImagePrepService,
}) {
  function resolveWorkspaceKey(workspaceKey, monthKey) {
    return String(workspaceKey || monthKey || '').trim();
  }

  function getState() {
    return {
      activeRoot: customerLibraryRepository.getActiveRoot(),
    };
  }

  function setActiveRoot(rootPath) {
    return customerLibraryRepository.setActiveRoot(rootPath);
  }

  function ensureWorkspace(workspaceKey, { ownerUser = null } = {}) {
    return customerLibraryRepository.ensureWorkspace(workspaceKey, { ownerUser });
  }

  function ensureMonth(monthKey, { ownerUser = null } = {}) {
    return customerLibraryRepository.ensureWorkspace(monthKey, { ownerUser });
  }

  function listWorkspaces(operatorUser = null) {
    return customerLibraryRepository.listWorkspaces(operatorUser);
  }

  function listMonths(operatorUser = null) {
    return customerLibraryRepository.listWorkspaces(operatorUser);
  }

  function listCustomers(workspaceKey, operatorUser = null) {
    return filterRecordsByOperator(
      customerLibraryRepository.listCustomers(workspaceKey),
      operatorUser
    );
  }

  function createCustomer({ workspaceKey, monthKey, agentName, images = [], ownerUser = null }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    ensureWorkspace(resolvedWorkspaceKey, { ownerUser });
    const customerId = customerLibraryRepository.allocateCustomerId(resolvedWorkspaceKey);
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: resolvedWorkspaceKey,
      customerId,
      agentName,
      images,
      ...buildOwnerMetadata(ownerUser),
    });
    const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, customerId);
    customerTemplateRepository.createWorkingTemplate(customerPath);
    return {
      customer,
      customers: listCustomers(resolvedWorkspaceKey, ownerUser),
    };
  }

  async function createCustomerFromFiles({
    workspaceKey,
    monthKey,
    agentName,
    files = [],
    editManifest = [],
    ownerUser = null,
    intendedBatchId = '',
  }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    // L631:异步建档(await prepareImages 后写盘)走 workspace-shared,与 deleteWorkspace 的 exclusive
    // 互斥——防其尾部 saveCustomer 落在整库 rmSync 之后复活残壳。shared 间零串行化(多客户并发)。
    return withWorkspaceShared(resolvedWorkspaceKey, async () => {
      ensureWorkspace(resolvedWorkspaceKey, { ownerUser });
      const customerId = customerLibraryRepository.allocateCustomerId(resolvedWorkspaceKey);
      const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, customerId);
      ensureDir(customerPath);
      const images = await customerImagePrepService.prepareCustomerImages({
        customerPath,
        files,
        editManifest,
      });

      let customer = customerLibraryRepository.createCustomerFolder({
        workspaceKey: resolvedWorkspaceKey,
        customerId,
        agentName,
        images,
        ...buildOwnerMetadata(ownerUser),
      });
      // T6-B 归属快照(8模块审计 HIGH):上传时选定的批次落盘为 review.intendedBatchId,
      // 自动追加按它定向归属——换批次窗口里老队列客户不再被吸进「当下」批次。
      const intended = String(intendedBatchId || '').trim();
      if (intended) {
        customer = customerLibraryRepository.saveCustomer({
          ...customer,
          review: { ...(customer.review || {}), intendedBatchId: intended },
        });
      }
      customerTemplateRepository.createWorkingTemplate(customerPath);
      return {
        customer,
        customers: listCustomers(resolvedWorkspaceKey, ownerUser),
      };
    });
  }

  function getNextImageIndex(images = []) {
    return (Array.isArray(images) ? images : [])
      .map((image) => {
        const idMatch = /^img_(\d+)$/.exec(String(image?.imageId || '').trim());
        const sortOrder = Number.parseInt(String(image?.sortOrder || 0), 10) || 0;
        return Math.max(idMatch ? Number.parseInt(idMatch[1], 10) || 0 : 0, sortOrder);
      })
      .reduce((highest, value) => Math.max(highest, value), 0);
  }

  async function appendCustomerImagesFromFiles({
    workspaceKey,
    monthKey,
    customerId,
    files = [],
    editManifest = [],
    operatorUser = null,
  }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    // L631:workspace-shared 外层(与 deleteWorkspace exclusive 互斥)、per-customer 内层(锁序固定
    // 防死锁)。append 有 await prepareImages 让点,尾部 saveCustomer 不得落在整库 rmSync 之后复活残壳。
    return withWorkspaceShared(resolvedWorkspaceKey, () =>
      withCustomerWriteLock(customerLockKey(resolvedWorkspaceKey, customerId), async () => {
    const customer = customerLibraryRepository.loadCustomer(resolvedWorkspaceKey, customerId);
    assertRecordAccess(customer, operatorUser, 'customer');
    const customerPath = customerLibraryRepository.customerDir(resolvedWorkspaceKey, customerId);
    const existingImages = Array.isArray(customer.images) ? customer.images : [];
    const appendedImages = await customerImagePrepService.prepareCustomerImages({
      customerPath,
      files,
      editManifest,
      startIndex: getNextImageIndex(existingImages),
    });
    const savedCustomer = customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        ...existingImages,
        ...appendedImages,
      ],
    });
    return {
      customer: savedCustomer,
      appendedImages,
      customers: listCustomers(resolvedWorkspaceKey, operatorUser),
    };
    }));
  }

  // G11a: 默认软删 (写 deletedAt + 保留文件夹便于审计);hard=true 走旧物理删
  async function deleteCustomer({ workspaceKey, monthKey, customerId, force = false, hard = false, operatorUser = null }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    // 物理删客户进客户写锁(深度审计 HIGH):与补图/审图/终审同锁串行。否则整目录 rmSync 落在
    // appendCustomerImagesFromFiles 的 await prepareCustomerImages 让点间隙——append 尾部 saveCustomer
    // 用删前旧快照 ensureDir 重建目录重写 customer.json,已删客户悄悄复活(无 deletedAt)或半删残缺。
    return withCustomerWriteLock(customerLockKey(resolvedWorkspaceKey, customerId), () => {
      const existingDir = customerLibraryRepository.findExistingCustomerDirectory(resolvedWorkspaceKey, customerId);
      if (existingDir) {
        const customer = customerLibraryRepository.loadCustomer(resolvedWorkspaceKey, customerId);
        assertRecordAccess(customer, operatorUser, 'customer');
      }
      const deletedBy = operatorUser?.username || operatorUser?.id || null;
      return customerLibraryRepository.deleteCustomer(resolvedWorkspaceKey, customerId, { force, hard, deletedBy });
    });
  }

  // L631:整库 rmSync 走 workspace-exclusive——等在飞 shared(建档/补图/预处理)全部 drain 后独占,
  // 杜绝 rmSync 与 await 后写盘交错的复活残壳/半删。sync→async:handler 需 await(见 customer_library_handlers)。
  async function deleteWorkspace({ workspaceKey, monthKey, force = false }) {
    const resolvedWorkspaceKey = resolveWorkspaceKey(workspaceKey, monthKey);
    return withWorkspaceExclusive(resolvedWorkspaceKey, () =>
      customerLibraryRepository.deleteWorkspace(resolvedWorkspaceKey, { force }));
  }

  return {
    createCustomer,
    createCustomerFromFiles,
    appendCustomerImagesFromFiles,
    deleteCustomer,
    deleteWorkspace,
    ensureMonth,
    ensureWorkspace,
    getState,
    listCustomers,
    listMonths,
    listWorkspaces,
    setActiveRoot,
  };
}

module.exports = {
  createCustomerIntakeService,
};
