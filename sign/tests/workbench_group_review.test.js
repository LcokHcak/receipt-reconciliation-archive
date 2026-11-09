const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { PROCESS_RESULTS, deriveTaskState } = require('../lib/workbench_task_flow');
const {
  approveSourceGroupTasks,
  getTaskFinalApprovalIssue,
} = require('../lib/workbench_group_review');

function createPassportTask(overrides = {}) {
  return {
    id: 'passport-1',
    originalFileName: 'passport.jpg',
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: true,
    extractedNameFinal: 'KIM MINSU',
    passportNoFinal: 'M12345678',
    chineseNameFinal: '\u91d1\u654f\u73e0',
    finalSignaturePath: 'final/passport.png',
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    processResult: PROCESS_RESULTS.FINAL_REVIEW,
    ...overrides,
  };
}

function createReceiptTask(overrides = {}) {
  return {
    id: 'receipt-1',
    originalFileName: 'receipt.jpg',
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'THE SHILLA',
    receiptNoFinal: '0325652400439',
    groupNoFinal: '71992',
    purchaseDateFinal: '2026-04-16',
    departureDateFinal: '2026-04-20',
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    processResult: PROCESS_RESULTS.FINAL_REVIEW,
    ...overrides,
  };
}

function createReviewHelpers() {
  const calls = {
    recalc: 0,
    touch: 0,
  };
  return {
    calls,
    helpers: {
      now: () => '2026-04-19T09:00:00.000Z',
      recalcTask(task) {
        calls.recalc += 1;
        task.processResult = deriveTaskState(task).processResult;
      },
      touchTask(task) {
        calls.touch += 1;
        task.updatedAt = '2026-04-19T09:00:00.000Z';
      },
    },
  };
}

test('getTaskFinalApprovalIssue reports missing receipt store first', () => {
  const issue = getTaskFinalApprovalIssue(createReceiptTask({
    receiptStoreFinal: '',
    receiptStoreAuto: '',
    receiptNoFinal: '',
    receiptNoAuto: '',
  }));

  assert.equal(issue, '还缺免税店');
});

test('getTaskFinalApprovalIssue:小票号解禁后长度不再拦(13位LOTTE可过),团号仍拦', () => {
  // 解禁前这里断言 /小票号.*格式不对/;2026-07-02 生产事故(结算 Internal error)后
  // 结算闸与 field_rules 的 RECEIPT_NO_STRICT 对齐:小票号非空即过。
  const issue = getTaskFinalApprovalIssue(createReceiptTask({
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '9018232500307',
    groupNoFinal: '25184998', // LOTTE 团号 8 位,合法
  }));
  assert.equal(issue, '');

  // 团号未解禁:错长度仍拦
  const groupIssue = getTaskFinalApprovalIssue(createReceiptTask({
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '90182325003077',
    groupNoFinal: '123',
  }));
  assert.match(groupIssue, /团号/);
  assert.match(groupIssue, /格式不对/);
});

test('getTaskFinalApprovalIssue reports missing receipt fields', () => {
  const issue = getTaskFinalApprovalIssue(createReceiptTask({
    receiptNoFinal: '',
    receiptNoAuto: '',
  }));

  assert.equal(issue, '还缺小票号');
});

test('getTaskFinalApprovalIssue accepts high-confidence machine doc type without manual type confirmation', () => {
  const issue = getTaskFinalApprovalIssue(createReceiptTask({
    classificationConfirmed: false,
    machineState: 'completed',
    docTypeAuto: DOC_TYPES.RECEIPT,
    docTypeFinal: DOC_TYPES.RECEIPT,
    docTypeConfidence: 0.91,
  }));

  assert.equal(issue, '');
});

test('approveSourceGroupTasks marks the whole group approved in one pass', () => {
  const tasks = [
    createPassportTask(),
    createReceiptTask(),
  ];
  let recalcCount = 0;
  let touchCount = 0;
  let classificationCount = 0;

  const approvedTaskIds = approveSourceGroupTasks(tasks, {
    now: () => '2026-04-19T09:00:00.000Z',
    markClassificationConfirmed(task) {
      classificationCount += 1;
      task.classificationConfirmed = true;
      task.needsReview = false;
      task.reviewReasons = [];
    },
    recalcTask(task) {
      recalcCount += 1;
      task.processResult = deriveTaskState(task).processResult;
    },
    touchTask(task) {
      touchCount += 1;
      task.updatedAt = '2026-04-19T09:00:00.000Z';
    },
  });

  assert.deepEqual(approvedTaskIds, ['passport-1', 'receipt-1']);
  assert.equal(classificationCount, 2);
  assert.equal(recalcCount, 2);
  assert.equal(touchCount, 2);
  tasks.forEach((task) => {
    assert.equal(task.reviewed, true);
    assert.equal(task.reviewedAt, '2026-04-19T09:00:00.000Z');
    assert.equal(task.rephotoRequested, false);
    assert.equal(task.processResult, PROCESS_RESULTS.APPROVED);
    assert.equal(task.updatedAt, '2026-04-19T09:00:00.000Z');
  });
});

test('approveSourceGroupTasks:\u4e24\u4e2a\u4e0d\u540c\u62a4\u7167\u53f7(\u771f\u6df7\u653e)\u8f6f\u62e6\u2014\u2014\u62a5\u9519\u4f46\u4e0d\u6467\u6bc1\u4efb\u4f55\u4efb\u52a1\u72b6\u6001', () => {
  const tasks = [
    createPassportTask({ reviewed: true, reviewedAt: '2026-04-19T08:00:00.000Z' }),
    createPassportTask({
      id: 'passport-2',
      originalFileName: 'passport-2.jpg',
      passportNoFinal: 'M87654321',
    }),
    createReceiptTask({ reviewed: true, reviewedAt: '2026-04-19T08:00:00.000Z' }),
  ];
  const { calls, helpers } = createReviewHelpers();

  assert.throws(
    () => approveSourceGroupTasks(tasks, helpers),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.notEqual(error.markedRephoto, true); // \u8f6f\u62e6\u5316:\u4e0d\u518d mass-mark \u6574\u7ec4\u9700\u91cd\u62cd
      assert.equal(error.taskId, 'passport-2');
      assert.match(error.issue, /\u4e0d\u540c\u62a4\u7167\u53f7/); // \u4e24\u4e2a\u4e0d\u540c\u62a4\u7167\u53f7=\u771f\u6df7\u653e
      return true;
    }
  );

  // \u5173\u952e:\u963b\u65ad\u65f6\u96f6\u526f\u4f5c\u7528,\u5df2\u5ba1\u72b6\u6001\u539f\u5c01\u4e0d\u52a8
  assert.equal(calls.recalc, 0);
  assert.equal(calls.touch, 0);
  tasks.forEach((task) => {
    assert.equal(task.rephotoRequested, false);
  });
  assert.equal(tasks[0].reviewed, true); // \u4e4b\u524d\u5df2\u5ba1\u7684\u62a4\u7167\u4fdd\u6301\u5df2\u5ba1
  assert.equal(tasks[2].reviewed, true); // \u5c0f\u7968\u4fdd\u6301\u5df2\u5ba1
});

// 2026-07-07 生产事故回归:同一护照号被识别成多本(一本护照拍多张 / 护照号印在乐天购物卡上),
// 绝不能当"多本护照"把整组标需重拍。同号 = 一本护照,应正常整组通过。
test('approveSourceGroupTasks:同护照号多张(购物卡/多拍)算一本,整组正常通过、不触发重拍', () => {
  const tasks = [
    createPassportTask({ id: 'passport-1', passportNoFinal: 'EQ1035708' }),
    createPassportTask({ id: 'passport-2', originalFileName: 'card-1.jpg', passportNoFinal: 'EQ1035708' }),
    createPassportTask({ id: 'passport-3', originalFileName: 'card-2.jpg', passportNoFinal: 'eq1035708' }), // 大小写/空格差异也算同号
    createReceiptTask(),
  ];
  const { helpers } = createReviewHelpers();
  const approvedIds = approveSourceGroupTasks(tasks, helpers);
  assert.equal(approvedIds.length, 4);
  tasks.forEach((task) => {
    assert.equal(task.reviewed, true);
    assert.equal(task.rephotoRequested, false);
    assert.equal(task.processResult, PROCESS_RESULTS.APPROVED);
  });
});

// 无号误分类护照(购物卡被当护照但没抽到号)+ 1 本真护照 → 不算重复,由字段校验温和拦(缺护照号),
// 不再把整组标需重拍。
test('approveSourceGroupTasks:无号误分类护照不算重复,由缺护照号温和拦、不触发整组重拍', () => {
  const tasks = [
    createPassportTask({ id: 'passport-1', passportNoFinal: 'EM1165629' }),
    createPassportTask({ id: 'passport-2', originalFileName: 'card.jpg', passportNoFinal: '', passportNoAuto: '' }),
    createReceiptTask(),
  ];
  const { helpers } = createReviewHelpers();
  assert.throws(
    () => approveSourceGroupTasks(tasks, helpers),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.notEqual(error.markedRephoto, true); // 关键:不 mass-mark 整组重拍
      return true;
    }
  );
  // 状态未被摧毁:没有任何任务被标需重拍
  tasks.forEach((task) => assert.equal(task.rephotoRequested, false));
});

// 边界:一组全是无号误分类护照(购物卡当护照、都没抽到号,没有真护照)→ distinctNos.size=0 放行
// duplicate 检查;因分类是 passport 不触发"缺护照";每本缺护照号 → issueTask 温和拦,不 mass-rephoto。
test('approveSourceGroupTasks:全组无号误分类护照 → 温和拦(缺护照号),状态不被摧毁', () => {
  const tasks = [
    createPassportTask({ id: 'passport-1', passportNoFinal: '', passportNoAuto: '' }),
    createPassportTask({ id: 'passport-2', originalFileName: 'card-2.jpg', passportNoFinal: '', passportNoAuto: '' }),
    createPassportTask({ id: 'passport-3', originalFileName: 'card-3.jpg', passportNoFinal: '', passportNoAuto: '' }),
  ];
  const { helpers } = createReviewHelpers();
  assert.throws(
    () => approveSourceGroupTasks(tasks, helpers),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.notEqual(error.markedRephoto, true);
      return true;
    }
  );
  tasks.forEach((task) => assert.equal(task.rephotoRequested, false));
});

test('approveSourceGroupTasks:缺护照软拦——报错但已审小票状态不被摧毁', () => {
  const tasks = [
    createReceiptTask({
      reviewed: true,
      reviewedAt: '2026-04-19T08:00:00.000Z',
      processResult: PROCESS_RESULTS.APPROVED,
    }),
  ];
  const { calls, helpers } = createReviewHelpers();

  assert.throws(
    () => approveSourceGroupTasks(tasks, helpers),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.notEqual(error.markedRephoto, true); // 软拦化:缺护照不再 mass-mark 需重拍
      assert.equal(error.taskId, 'receipt-1');
      assert.equal(error.issue, '整组还缺护照');
      return true;
    }
  );

  // 零副作用:已审小票保持已审,绝不因缺护照被打回重拍
  assert.equal(calls.recalc, 0);
  assert.equal(calls.touch, 0);
  assert.equal(tasks[0].reviewed, true);
  assert.equal(tasks[0].rephotoRequested, false);
  assert.equal(tasks[0].processResult, PROCESS_RESULTS.APPROVED);
});

test('approveSourceGroupTasks rejects the whole group when one task is not ready', () => {
  assert.throws(
    () => approveSourceGroupTasks([
      createPassportTask(),
      createReceiptTask({ departureDateFinal: '' }),
    ]),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.equal(error.taskId, 'receipt-1');
      assert.equal(error.issue, '还缺出境日期');
      assert.match(error.message, /receipt\.jpg：还缺出境日期。/);
      return true;
    }
  );
});

test('approveSourceGroupTasks reports invalid receipt with operator-locatable context', () => {
  assert.throws(
    () => approveSourceGroupTasks([
      createPassportTask(),
      createReceiptTask({
        id: 'task_0053',
        sourceGroupLabel: '兜兜',
        sourceFolderName: '六六大顺/兜兜',
        customerAgentName: '六六大顺',
        originalFileName: '46bce53a6b2dfb4fc55092b34b23f0b0.jpg',
        receiptStoreFinal: 'LOTTE',
        receiptNoFinal: '90170826000580',
        groupNoFinal: '12345678',
        purchaseDateFinal: '2066-01-21',
        departureDateFinal: '2026-01-23',
      }),
    ]),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.equal(error.taskId, 'task_0053');
      assert.match(error.message, /代理 六六大顺/);
      assert.match(error.message, /客户组 兜兜/);
      assert.match(error.message, /task_0053/);
      assert.match(error.message, /小票号 90170826000580/);
      assert.match(error.message, /文件 46bce53a6b2dfb4fc55092b34b23f0b0\.jpg/);
      assert.match(error.message, /购买日期/);
      return true;
    }
  );
});

test('approveSourceGroupTasks:纯百货组无护照不拦"整组还缺护照"(2026-07-14 拍板放行)', () => {
  const tasks = [
    createReceiptTask({
      receiptStoreFinal: 'HYUNDAI_DEPT',
      receiptNoFinal: '1622-0011',
      receiptAmountFinal: '4500000',
      upstreamFinal: '东方',
      purchaseDateFinal: '2026-07-01',
      groupNoFinal: '',
      departureDateFinal: '',
      reviewed: true,
      reviewedAt: '2026-07-14T08:00:00.000Z',
      processResult: PROCESS_RESULTS.APPROVED,
    }),
  ];
  const { helpers } = createReviewHelpers();
  try {
    approveSourceGroupTasks(tasks, helpers);
  } catch (error) {
    // 允许因其它字段规则被拦,但绝不允许再报"缺护照"
    assert.notEqual(error.issue, '整组还缺护照');
  }
});
