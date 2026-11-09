const path = require('node:path');

const { createBillingExportService } = require('./billing_export_service');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');

function sanitizeFolderLabel(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const { isDeptStore } = require('../lib/store_profiles');

// 纯百货组：组内所有小票任务都是百货店(2026-07-14 拍板：此类组可整组无护照)
function isPureDeptGroup(groupTasks = []) {
  const receipts = (Array.isArray(groupTasks) ? groupTasks : [])
    .filter((task) => String(task?.docTypeFinal || '').trim() === 'receipt');
  return receipts.length > 0 && receipts.every(
    (task) => isDeptStore(String(task?.receiptStoreFinal || task?.receiptStoreAuto || '').trim())
  );
}

function resolvePassportTask(groupTasks = []) {
  return groupTasks.find((task) => String(task?.docTypeFinal || '').trim() === 'passport')
    || groupTasks.find((task) => task?.passportNoFinal || task?.extractedNameFinal)
    || null;
}

function resolveReceiptTask(groupTasks = []) {
  return groupTasks.find((task) => String(task?.docTypeFinal || '').trim() === 'receipt') || null;
}

function createApprovalValidationError(message, task = {}, issue = '') {
  const error = new Error(message);
  error.code = 'GROUP_APPROVAL_INVALID';
  error.taskId = String(task?.id || '').trim();
  error.issue = issue;
  return error;
}

function normalizeFolderMatchValue(value) {
  return String(value || '').trim().toLowerCase();
}

function createCustomerFinalizeService({
  customerLibraryRepository,
  customerTemplateFillService,
  billingExportService = createBillingExportService({ templateFillService: customerTemplateFillService }),
}) {
  // 已入台账小票号查重(晚绑定:monthlyDb 晚于本服务创建,server 装配后注入)。
  // (passportNo, receiptNos[]) => 已在台账里的票号列表。用于归档改名冲突时分辨
  // "真重复建档"(票号撞台账)vs"合法二次收票"(全新票号)。
  let settledReceiptLookup = null;

  // 归档改名冲突分流:
  //   同名文件夹已存在 + 新组票号与该护照已入台账票号有重叠 → 真重复,拦(带撞的票号);
  //   同名已存在 + 票号全新 → 同客二次收票,自动加序号后缀 _2/_3… 继续归档。
  function renameWithCollisionFork({ workspaceKey, customerId, finalFolderName, passportNo, groupTasks }) {
    try {
      return {
        dir: customerLibraryRepository.renameCustomerFolder(workspaceKey, customerId, finalFolderName),
        folderName: finalFolderName,
      };
    } catch (error) {
      if (error?.code !== 'CUSTOMER_FOLDER_EXISTS') throw error;
      const receiptNos = (groupTasks || [])
        .filter((t) => String(t?.docTypeFinal || t?.docTypeAuto || '').toLowerCase() === 'receipt')
        .map((t) => String(t?.receiptNoFinal || t?.receiptNoAuto || '').trim())
        .filter(Boolean);
      const duplicated = (typeof settledReceiptLookup === 'function' && receiptNos.length)
        ? (settledReceiptLookup(passportNo, receiptNos) || [])
        : [];
      if (duplicated.length) {
        // 2026-07-14 拍板(二次修正:百货与小票**分家**,处理方式不混)——
        //   纯百货组:老票+新票混组=客人多笔交易常态 → 有任何新交易编号就放行走后缀归档,
        //           已入账票由台账行级去重兜底;
        //   含免税店小票的组:保持原严格口径,任一票号撞台账即拦(重传老票=操作失误,早拦早清)。
        // 比对用数字投影:5801-0110 与 58010110 是同一张票(带杠只是形态,两类通用的纠错)。
        const digitsOf = (value) => String(value || '').replace(/\D+/g, '');
        const dupDigits = new Set(duplicated.map(digitsOf).filter(Boolean));
        const hasFreshReceipt = receiptNos.some((no) => digitsOf(no) && !dupDigits.has(digitsOf(no)));
        if (!(isPureDeptGroup(groupTasks) && hasFreshReceipt)) {
          error.duplicateReceiptNos = duplicated; // 路由层报「小票 xxx 已入过台账」
          throw error;
        }
      }
      // 后缀上限分家(2026-07-14 现场:百货客人归档超9次撞'同名归档过多'):
      // 纯百货组一天多笔/多次归档是常态 → _2.._99;免税店保持 _2.._9(超过=异常密集人工看)。
      const maxSuffix = isPureDeptGroup(groupTasks) ? 99 : 9;
      for (let n = 2; n <= maxSuffix; n += 1) {
        const candidate = `${finalFolderName}_${n}`;
        try {
          return {
            dir: customerLibraryRepository.renameCustomerFolder(workspaceKey, customerId, candidate),
            folderName: candidate,
          };
        } catch (retryError) {
          if (retryError?.code !== 'CUSTOMER_FOLDER_EXISTS') throw retryError;
        }
      }
      throw error; // _2.._9 全被占,异常密集,按冲突拦下人工看
    }
  }
  function resolveWorkspaceKey(customer) {
    return String(customer?.workspaceKey || customer?.monthKey || '').trim();
  }

  function findCustomerBySourceGroupMatch(sourceGroupLabel, sourceGroupFolderPath) {
    const candidates = [
      normalizeFolderMatchValue(sourceGroupFolderPath),
      normalizeFolderMatchValue(sourceGroupLabel),
    ].filter(Boolean);

    if (!candidates.length) {
      return null;
    }

    for (const workspaceKey of customerLibraryRepository.listWorkspaces()) {
      for (const customer of customerLibraryRepository.listCustomers(workspaceKey)) {
        const folderValues = [
          customer?.folderNameFinal,
          customer?.folderNameInitial,
          customer?.customerId,
        ].map(normalizeFolderMatchValue).filter(Boolean);
        if (folderValues.some((value) => candidates.includes(value))) {
          return customer;
        }
      }
    }

    return null;
  }

  async function finalizeApprovedGroup({
    batchId,
    groupKey,
    sourceGroupLabel = '',
    sourceGroupFolderPath = '',
    groupTasks = [],
  }) {
    const located = customerLibraryRepository.findCustomerByReviewReference(batchId, groupKey)
      || findCustomerBySourceGroupMatch(sourceGroupLabel, sourceGroupFolderPath);
    if (!located) {
      return null;
    }

    // 客户写锁(8模块审计 HIGH:终审读改写 customer.json 无锁,与补图/审图/删图并发互吞丢更新)——
    // 本函数在 :exportCustomerBill 处有 await 让点,尾部 saveCustomer 会用旧快照整盘覆盖,
    // 丢掉并发追加的图片记录/审图更新。照 bridge appendCustomerImagesToBatch 先例:进锁+锁内重载 fresh。
    // 锁序 批次→客户(finalize 由 approve/settle 在批次写锁内调用;补图/审图只持客户锁、bridge 也只持
    // 客户锁不反向取批次锁,无 customer→batch 反转,不会死锁)。
    const lockWorkspaceKey = resolveWorkspaceKey(located);
    const lockCustomerId = String(located.customerId || '').trim();
    return withCustomerWriteLock(customerLockKey(lockWorkspaceKey, lockCustomerId), async () => {
      // 锁内重载:排队等锁期间补图/审图/删图可能已落盘,拿最新快照再改,避免整盘覆盖丢更新。
      const customer = customerLibraryRepository.loadCustomer(lockWorkspaceKey, lockCustomerId) || located;

      const passportTask = resolvePassportTask(groupTasks);
    // 纯百货组免护照(2026-07-14 用户拍板)：组里既无护照任务、票上也无身份 → 放行归档，
    // 文件夹保留建档原名(没有 姓名_护照号 可拼)，账单身份留空；其余组照旧硬校验。
    const deptNoIdentity = !passportTask && isPureDeptGroup(groupTasks);
    if (!deptNoIdentity && (!passportTask?.extractedNameFinal || !passportTask?.passportNoFinal)) {
      throw createApprovalValidationError(
        'Approved group is missing final passport name or number',
        passportTask || groupTasks[0] || {},
        passportTask ? 'passport_identity_missing' : 'passport_missing'
      );
    }

    const receiptTask = resolveReceiptTask(groupTasks);
    const travelerName = passportTask?.extractedNameFinal || '';
    const travelerPassportNo = passportTask?.passportNoFinal || '';
    const approvedAt = passportTask?.reviewedAt || receiptTask?.reviewedAt || new Date().toISOString();
    const finalFolderName = deptNoIdentity
      ? (customer.folderNameFinal || customer.folderNameInitial || customer.customerId)
      : `${sanitizeFolderLabel(travelerName)}_${sanitizeFolderLabel(travelerPassportNo)}`;
    const workspaceKey = resolveWorkspaceKey(customer);

    if (customer.status === 'template_generated') {
      const customerDir = customerLibraryRepository.customerDir(workspaceKey, customer.customerId);
      const finalTemplatePath = customer.template?.finalOutputPath
        ? path.join(customerDir, customer.template.finalOutputPath)
        : '';
      return {
        customer,
        customerDir,
        folderNameFinal: customer.folderNameFinal || finalFolderName,
        workingTemplatePath: customer.template?.workingCopyPath
          ? path.join(customerDir, customer.template.workingCopyPath)
          : '',
        finalTemplatePath,
        previousCustomerDir: customerDir,
        alreadyGenerated: true,
      };
    }

    customer.review = {
      ...(customer.review || {}),
      lastBatchId: batchId,
      lastSourceGroupId: groupKey,
    };
    if (customer.status === 'ready_for_review') {
      customer.status = 'in_review';
      customerLibraryRepository.saveCustomer(customer);
    }

    customer.status = 'approved';
    customer.displayName = travelerName || customer.displayName || String(sourceGroupLabel || '').trim() || customer.customerId;
    customer.passportNumber = travelerPassportNo || customer.passportNumber || '';
    customer.review = {
      ...(customer.review || {}),
      approvedAt,
    };
    customerLibraryRepository.saveCustomer(customer);

    const currentDir = customerLibraryRepository.customerDir(workspaceKey, customer.customerId);
    // 同名冲突智能分流:真重复(票号撞台账)拦下;二次收票(全新票号)自动 _2/_3 后缀。
    // 纯百货免护照组：没有 姓名_护照号 可改名，保持建档文件夹；改名冲突分流依赖护照号，跳过
    const { dir: renamedDir, folderName: archivedFolderName } = deptNoIdentity
      ? { dir: currentDir, folderName: finalFolderName }
      : renameWithCollisionFork({
        workspaceKey,
        customerId: customer.customerId,
        finalFolderName,
        passportNo: travelerPassportNo,
        groupTasks,
      });

    // 2026-06-13 中文签名下线:不再把系统生成的中文签名图复制进客户文件夹,
    // 也不嵌进客户账单。客户账单/PDF 仅保留模板自带的手签留白行(客户手写)。
    const workingTemplatePath = path.join(renamedDir, customer.template.workingCopyPath);
    const billExport = await billingExportService.exportCustomerBill({
      outputDir: path.join(renamedDir, 'template'),
      customer: {
        travelerName,
        passportNumber: travelerPassportNo,
        contactPhone: customer.contactPhone || '',
        receiptAmount: receiptTask?.receiptAmountFinal || receiptTask?.receiptAmountAuto || '',
      },
      approvedAt,
    });
    const finalTemplatePath = billExport.outputPath;

    customer.folderNameFinal = archivedFolderName;
    customer.status = 'template_generated';
    customer.template = {
      ...(customer.template || {}),
      finalOutputPath: path.relative(renamedDir, finalTemplatePath).split(path.sep).join('/'),
      filledAt: approvedAt,
    };
    customer.generatedSignaturePath = '';
    customerLibraryRepository.saveCustomer(customer);

    return {
      customer,
      customerDir: renamedDir,
      folderNameFinal: archivedFolderName,
      // 二次收票自动后缀时给上层/弹窗提示用(如 CHEN WEIQING_EJ4797716_2)
      folderSuffixed: archivedFolderName !== finalFolderName,
      workingTemplatePath,
      finalTemplatePath,
      previousCustomerDir: currentDir,
    };
    }); // withCustomerWriteLock:终审客户读改写整段串行,防补图/审图并发丢更新
  }

  return {
    finalizeApprovedGroup,
    // 晚绑定注入台账票号查重(monthlyDb 建好后 server 调用)。
    setSettledReceiptLookup(fn) {
      settledReceiptLookup = typeof fn === 'function' ? fn : null;
    },
  };
}

module.exports = {
  createCustomerFinalizeService,
};
