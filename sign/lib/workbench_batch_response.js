const { PROCESS_RESULTS } = require('./workbench_task_flow');
const { businessDate } = require('./business_time');
const { buildTaskFieldRegions } = require('./review_field_regions');
const { buildTaskDocRegions, buildDocRegionIndex } = require('./review_doc_regions');
const { createDeliveryImagePlanner, describeBlock } = require('./delivery_render');
const { canAcceptManualBox } = require('./manual_doc_box');
const { buildOriginalImageUrl, isWholeImageTask } = require('./task_original_image');
const { buildTaskWorkflowState } = require('./workbench_workflow_state');
const { laneOfMode } = require('./review_lane');
const { isSlimLaneTask } = require('./workbench_task_flow');

function createEmptyCounts(total) {
  return {
    total,
    queued: 0,
    processing: 0,
    completed: 0,
    error: 0,
    classification: 0,
    fields: 0,
    signature: 0,
    finalReview: 0,
    approved: 0,
    rephoto: 0,
  };
}

// 审核动作时间统计(工作台首页 2026-07-18):task.reviewedAt 上浮到批次摘要。
// 纯函数于 batch.json 内容 → 摘要 mtime 缓存安全;"今日"判定放在消费方
// (overview service 请求时),这里只按日期桶落值,跨天不脏缓存。
// P2 追加 reviewSpans:每天的首末审核时间(算"张/小时"工时跨度用),
// 与 reviewedByDate(计数)分开存,保持 P0 消费方形状不变。
// ⚠️ 消费方只读:批次列表缓存是浅拷贝,reviewedByDate/reviewSpans 跨请求共享引用,
// 原地赋值会静默污染进程级缓存直到该批次下次落盘(2026-07-19 审计提示)。
function buildReviewStats(tasks) {
  let first = '';
  let last = '';
  const reviewedByDate = {};
  const reviewSpans = {};
  for (const task of tasks) {
    const at = String(task?.reviewedAt || '').trim();
    if (!at) continue;
    if (!first || at < first) first = at;
    if (!last || at > last) last = at;
    const day = businessDate(at);
    if (!day) continue;
    reviewedByDate[day] = (reviewedByDate[day] || 0) + 1;
    const span = reviewSpans[day] || { first: at, last: at };
    if (at < span.first) span.first = at;
    if (at > span.last) span.last = at;
    reviewSpans[day] = span;
  }
  return { firstReviewedAt: first, lastReviewedAt: last, reviewedByDate, reviewSpans };
}

function countTask(counts, task) {
  const machineState = String(task.machineState || '').trim();
  if (Object.prototype.hasOwnProperty.call(counts, machineState)) {
    counts[machineState] += 1;
  }

  switch (task.processResult) {
    case PROCESS_RESULTS.CLASSIFY:
      counts.classification += 1;
      break;
    case PROCESS_RESULTS.FIELDS:
      counts.fields += 1;
      break;
    case PROCESS_RESULTS.SIGNATURE:
      counts.signature += 1;
      break;
    case PROCESS_RESULTS.FINAL_REVIEW:
      counts.finalReview += 1;
      break;
    case PROCESS_RESULTS.APPROVED:
      counts.approved += 1;
      break;
    case PROCESS_RESULTS.REPHOTO:
      counts.rephoto += 1;
      break;
    default:
      break;
  }
}

// 只对**小票**算(护照/机票不按票号单独出图,判定对它们没意义,算了只会平白多一块红)。
// 返回 null = 这条任务没有可说的,前端什么都不显示。
function buildDeliveryImagePlan(planFor, task) {
  const docType = String(task?.docTypeFinal || task?.docTypeAuto || '').trim();
  if (docType !== 'receipt') return null;
  let plan;
  try { plan = planFor(task); } catch { return null; }
  if (!plan || plan.action === 'as-is') return null; // 照旧出图 = 无事可说,不制造噪音
  return {
    action: plan.action,
    reason: plan.reason,
    hint: plan.action === 'block' ? describeBlock(plan.reason) : '交付时会按框裁出这一张',
  };
}

function createWorkbenchBatchResponseBuilder({
  toStorageUrl,
  buildRecognitionProgressSnapshot,
  buildResponseSourceGroups,
}) {
  if (typeof toStorageUrl !== 'function') {
    throw new Error('toStorageUrl is required');
  }
  if (typeof buildRecognitionProgressSnapshot !== 'function') {
    throw new Error('buildRecognitionProgressSnapshot is required');
  }
  if (typeof buildResponseSourceGroups !== 'function') {
    throw new Error('buildResponseSourceGroups is required');
  }

    // 车道计算:slim 需三叠加资格;s_activity/sendback 只看模式(展示/队列用,不免任何审)。
  // laneOfMode 不传 slimModes 白名单永不返回 'slim',无需再兜。
  function computeReviewLane(task) {
    if (isSlimLaneTask(task)) return 'slim';
    return laneOfMode(task.modeRawPre, { slimModes: [] });
  }

// docRegionIndex 可选:summarizeBatch 整批算一次传进来(否则 n 条任务各建一次索引 = O(n²));
// 写操作后的单任务回写路径不传,现建一次 O(n)。**刻意不缓存**——脏索引会让操作员
// 看到别的图的框,而这种错不会有任何报错。
function applyComputedFields(batch, task, docRegionIndex = null, deliveryPlanner = null) {
    const workflowState = buildTaskWorkflowState(task);
    const docIndex = docRegionIndex instanceof Map
      ? docRegionIndex
      : buildDocRegionIndex(batch?.tasks || [task]);
    // 交付护栏判定前移(0730):这套判定原来只在**导出时**体现,写进「导出说明.txt」。
    // 于是顺序是反的 —— 审核员审完、结算、导出、读那张纸,才知道有图没进包,再回来找。
    // 判定逻辑一个字没新写,就是 planDeliveryImage;这里只是把结果提前送到审核台。
    const planFor = typeof deliveryPlanner === 'function'
      ? deliveryPlanner
      : createDeliveryImagePlanner(batch?.tasks ? batch : { tasks: [task] });
    return {
      ...task,
      processResult: workflowState.processResult,
      actionSuggestion: workflowState.actionSuggestion,
      // 分车道审核(2026-07-10):车道由服务端算好下发(slim 资格=灰度模式+命中表+人工确认三叠加),
      // 前端不复制 ENV 白名单——单一真相源在 lib/review_lane + workbench_task_flow.isSlimLaneTask。
      reviewLane: computeReviewLane(task),
      workflowState,
      sourceImageUrl: toStorageUrl(batch.id, task.sourceImagePath),
      signatureRegionUrl: toStorageUrl(batch.id, task.signatureRegionPath),
      finalSignatureUrl: toStorageUrl(batch.id, task.finalSignaturePath),
      rawJsonUrl: toStorageUrl(batch.id, task.rawJsonPath),
      fieldRegions: buildTaskFieldRegions(task),
      // 文档框(切图改框选·第1期):同一张原图上兄弟单据的框,看原图时画出来。
      // 字段框是切片坐标系、文档框是原图坐标系,前端按 showOriginal 二选一显示。
      docRegions: buildTaskDocRegions(task, docIndex),
      // 这条任务能不能手画框。**规则的单一真相源在后端**(lib/manual_doc_box.canAcceptManualBox),
      // 前端不许复制那套判断 —— 复制就会漂。
      // 为什么必须下发:0730 用户实测踩到死路 —— 他在一条指向切片文件的任务上点「画框」,
      // 后端直接 400 拒绝,而**按钮一直是可点的**,于是他点了、失败了、提示没变,
      // 以为是系统坏了。按钮不该在做不到的时候还亮着。
      canDrawBox: canAcceptManualBox(task),
      // 「要看整张原图去哪拿」由后端算(0730)。前端原来自己回溯,用的是**客户级**键,
      // 同一客户下有多张照片时会回溯到别的照片 —— 在照片 X 上画的框存到照片 Y 上,零报错。
      // isOriginalImage:这条任务本身就是整张照片。它恰恰是后端唯一允许画框的那一类,
      // 而它的 originalImageUrl 是空的 —— 前端若只认 URL 就会「能画的地方没按钮」。
      originalImageUrl: buildOriginalImageUrl(batch, task, toStorageUrl),
      isOriginalImage: isWholeImageTask(task),
      // { action:'as-is'|'crop'|'block', reason, hint }
      // hint 是人话(describeBlock),直接给操作员看;action 决定要不要标红。
      deliveryImagePlan: buildDeliveryImagePlan(planFor, task),
    };
  }

  function summarizeBatch(batch, { includeTasks = false } = {}) {
    const docRegionIndex = buildDocRegionIndex(batch.tasks || []);
    // 同 docRegionIndex:整批建一次,否则 n 条任务各建一次 = O(n²)
    const deliveryPlanner = createDeliveryImagePlanner(batch);
    const computedTasks = (batch.tasks || []).map((task) => (
      applyComputedFields(batch, task, docRegionIndex, deliveryPlanner)
    ));
    const counts = createEmptyCounts(computedTasks.length);
    computedTasks.forEach((task) => countTask(counts, task));

    return {
      id: batch.id,
      name: batch.name,
      scenario: batch.scenario,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      ownerUserId: batch.ownerUserId ?? null,
      ownerUsername: batch.ownerUsername || null,
      createdBy: batch.createdBy || null,
      // 批次绑定的工作区:建档页下拉据此只显示当前工作区的批次(防选到别的工作区的批次被 400 拦)。
      monthlyWorkspaceKey: batch.monthlyWorkspaceKey || batch.workspaceKey || null,
      machineState: batch.machineState,
      // 团号表后台解析状态(parsing/ready/failed/null),前端据此在结算前提示"团号表还在解析"。
      groupCodeStatus: batch.groupCodeImport?.status || null,
      // 导出留痕(P1):首页导出状态列/待导出提醒/今日导出 KPI 的数据源。
      exportedAt: batch.exportedAt || '',
      exportedBy: batch.exportedBy || null,
      exportKind: batch.exportKind || '',
      // 导出失败留痕(2026-07-26):首页「待管理事项·导出失败」的数据源。
      exportFailedAt: batch.exportFailedAt || '',
      exportFailedKind: batch.exportFailedKind || '',
      exportFailedError: batch.exportFailedError || '',
      recognitionProgress: buildRecognitionProgressSnapshot(batch, counts),
      counts,
      reviewStats: buildReviewStats(computedTasks),
      sourceGroups: buildResponseSourceGroups(batch),
      tasks: includeTasks ? computedTasks : undefined,
    };
  }

  return {
    applyComputedFields,
    summarizeBatch,
  };
}

module.exports = {
  createWorkbenchBatchResponseBuilder,
  buildDeliveryImagePlan,
};
