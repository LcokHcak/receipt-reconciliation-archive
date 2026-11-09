'use strict';

const crypto = require('crypto');

const { buildOwnerMetadata } = require('../../lib/operator_scope');
const { incrementTaskVersion } = require('../../lib/workbench_task_versioning');
const { normalizeEditableFieldsForDocType } = require('../../lib/workbench_field_normalizer');
const { NO_TOUR_LITERAL } = require('../../lib/no_tour');
const { logger } = require('../../lib/logger');
const { normalizeManualBox, canAcceptManualBox, isClearRequest } = require('../../lib/manual_doc_box');

function createTaskOperations({
  common,
  defaultScenario,
  nowStamp,
  buildBatchSkeleton,
  batchSubdirs,
  createManualTaskFromFactory,
  createManualReceiptTaskFromSource,
  normalizeFieldValue,
  resolveTask,
  normalizeTask,
  normalizeDocType,
  clearTaskSignatureArtifacts,
  clearEditableFieldsForDocTypeSwitch,
  markClassificationConfirmed,
  didEditableWorkflowChange,
  syncWebsiteSignatureAfterFieldChange,
  websiteSignatureSource,
  removeFileIfExists,
  resolveBatchRelativePath,
  recoverCompletedStateAfterManualReview,
  recalcTask,
  touchTask,
  removeTaskArtifacts,
  clearActiveBatch,
  removeBatchDirectory,
  applyComputedFields,
  queueAutomaticWebsiteSignature,
  groupCodePrematchHolder = { service: null }, // 团号预匹配(晚绑定,改团号/改类型时当场重跑)
  workflowTaskCoordinatorHolder = { service: null }, // V2 Task7:票级表态→运营任务对账(晚绑定)
}) {
  const {
    error,
    hasBatch,
    loadBatch,
    ok,
    removeProjectionSafely,
    saveBatchAsync,
    summarizeBatch,
    withBatchWrite,
  } = common;

  async function createManualTask({ batchId, batchName, recordLabel, ownerUser = null }) {
    const ownerMetadata = buildOwnerMetadata(ownerUser);
    const useExisting = Boolean(batchId && hasBatch(batchId));
    const stamp = nowStamp();
    // 既有批次→与审核并发必须上锁;全新批次→id 现生成无并发,但一律走锁(新 id 无争用,零副作用)。
    const targetBatchId = useExisting ? batchId : `batch_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
    return withBatchWrite(targetBatchId, async () => {
      let batch;
      if (useExisting) {
        batch = loadBatch(targetBatchId);
      } else {
        batch = buildBatchSkeleton(targetBatchId, batchName || `manual_batch_${stamp}`, defaultScenario);
        Object.assign(batch, ownerMetadata);
        batch.machineState = 'completed';
        batchSubdirs(batch.id);
      }

      const task = createManualTaskFromFactory(recordLabel);
      if (ownerMetadata.ownerUsername || ownerMetadata.ownerUserId != null) {
        task.customerOwnerUserId = ownerMetadata.ownerUserId;
        task.customerOwnerUsername = ownerMetadata.ownerUsername || '';
      }
      recalcTask(task);
      batch.tasks.unshift(task);
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        batchId: batch.id,
        taskId: task.id,
        batch: summarizeBatch(batch, { includeTasks: true }),
      });
    }, { label: 'createManualTask' });
  }

  // taskOverrides(P2-a,0731):调用方(handler 层)已经把整张原图拷进批次时,
  // 用它把新任务指到那张图上。为什么不在这儿自己解析原图:写服务手上没有客户库依赖,
  // 而原图住在客户库;硬加一条依赖只为了拷个文件,不如让本来就有它的 handler 拷完再传进来。
  async function createManualReceiptFromTask({ batchId, taskId, recordLabel, taskOverrides = {} }) {
    if (!hasBatch(batchId)) {
      return error(404, { error: 'Batch not found' });
    }
    // 「同图补小票」审核时常调,与审核 updateTask 并发——必须走同一把批次写锁,否则
    // loadBatch→改→saveBatchAsync 与审核落盘交错会整份覆盖、吞掉刚审好的态(2026-07-13 复审 HIGH)。
    return withBatchWrite(batchId, async () => {
      const batch = loadBatch(batchId);
      const sourceTaskIndex = batch.tasks.findIndex((item) => item.id === taskId);
      if (sourceTaskIndex < 0) {
        return error(404, { error: 'Task not found' });
      }

      const sourceTask = batch.tasks[sourceTaskIndex];
      if (!normalizeFieldValue(sourceTask.sourceImagePath)) {
        return error(400, { error: 'Current task has no source image to attach another receipt to' });
      }

      const task = createManualReceiptTaskFromSource(sourceTask, recordLabel, taskOverrides);
      recalcTask(task);
      batch.tasks.splice(sourceTaskIndex + 1, 0, task);

      // 已结算组补票:让前端清 settledGroupKeys 放行「重新确认结算」把新票并入台账
      // (re-settle 幂等:cleanOldUnmatchedRows+syncApprovedGroup 重读全组,新票入账、旧行不重复)。
      // ⚠️绝不后端撤章(清 settledAt):深度审计 HIGH——f9e368b 曾在这里 clearGroupSettlement,
      //   把 settledAt 清空后到重新结算前有个窗口,deleteTask/deleteBatch 的 B5 删除守卫只认
      //   settledAt/settlementStatus,被解除→组内已入台账票可被物理删(证据图丢+台账行悬空)。
      //   保留 settledAt=删除守卫全程在岗;只回 reopenedGroupKey 让前端解除拦截即够(re-settle 重盖章)。
      let reopenedGroupKey = '';
      const gk = String(task.sourceGroupKey || '').trim();
      const group = gk && Array.isArray(batch.sourceGroups)
        ? batch.sourceGroups.find((g) => String(g?.key || '').trim() === gk)
        : null;
      if (group && (group.settledAt || String(group.settlementStatus || '') === 'settled')) {
        reopenedGroupKey = gk;
      }
      await saveBatchAsync(batch);

      return ok({
        ok: true,
        batchId: batch.id,
        taskId: task.id,
        // 前端据此清 settledGroupKeys,并知道要重新确认结算(补票已让组重开)
        reopenedGroupKey,
        batch: summarizeBatch(batch, { includeTasks: true }),
      });
    }, { label: 'createManualReceiptFromTask' });
  }

  async function updateTask({ batchId, taskId, body }) {
    return withBatchWrite(batchId, async () => { // label: updateTask
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const task = resolveTask(batch, taskId);
      if (!task) {
        return error(404, { error: 'Task not found' });
      }

      // L152(2026-07-23 拍板「禁止编辑已结算组·引导台账订正」):已结算组的原始票改字段不会回台账
      // (已对账/人工锁定行重结算被业务键去重静默吞掉,removedOldRows=0/skippedRows≥1,操作员误以为改了)。
      // 与 B5 删除闸同码同流程:409 引导走台账订正(撤销结算→改→重结算)。⚠️豁免 sourceType='manual'
      // (「同图补小票」新加的票):它尚未入台账、正等审核+re-settle,补图流程保留 settledAt 只让前端重开
      // (71cd807),不能连它一起拦死。已审未结算组照常可改(settledGroup 未命中)。
      if (String(task.sourceType || '') !== 'manual') {
        const settledGroup = (Array.isArray(batch.sourceGroups) ? batch.sourceGroups : []).find(
          (g) => String(g?.key || g?.groupKey || '').trim() === String(task.sourceGroupKey || '').trim()
            && (g?.settledAt || String(g?.settlementStatus || '') === 'settled')
        );
        if (settledGroup) {
          return error(409, {
            error: '本组已产生结算台账,改字段不会回写台账(会被去重静默吞掉);确需修改请走台账侧订正(撤销结算→修改→重新结算)',
            code: 'edit_blocked_settled',
          });
        }
      }

      const {
        originalFileName,
        docTypeFinal,
        extractedNameFinal,
        passportNoFinal,
        chineseNameFinal,
        receiptStoreFinal,
        receiptNoFinal,
        groupNoFinal,
        purchaseDateFinal,
        departureDateFinal,
        // 百货真字段(P2):金额/门店/品牌/上家
        receiptAmountFinal,
        branchFinal,
        brandFinal,
        upstreamFinal,
        signatureStyle,
        reviewNote,
        reviewed,
        rephotoRequested,
        rephotoReason,
        // 票级表态(两步流):stance/S标记/人工选模式
        tourStance,
        tourStancedBy,
        sActivityFlag,
        modeManualPick,
        modeManualPickTour,
      } = body || {};

      const previousTask = normalizeTask(task);

      if (typeof originalFileName === 'string' && originalFileName.trim()) {
        task.originalFileName = originalFileName.trim();
      }

      const nextDocType = typeof docTypeFinal === 'string'
        ? normalizeDocType(docTypeFinal)
        : normalizeDocType(task.docTypeFinal);
      const docTypeChanged = nextDocType !== normalizeDocType(task.docTypeFinal);

      if (docTypeChanged) {
        clearTaskSignatureArtifacts(batch.id, task);
        Object.assign(task, clearEditableFieldsForDocTypeSwitch(task, nextDocType));
      } else {
        task.docTypeFinal = nextDocType;
      }

      markClassificationConfirmed(task);
      const normalizedEditableFields = normalizeEditableFieldsForDocType(nextDocType, {
        extractedNameFinal,
        passportNoFinal,
        chineseNameFinal,
        receiptStoreFinal,
        receiptNoFinal,
        groupNoFinal,
        purchaseDateFinal,
        departureDateFinal,
        receiptAmountFinal,
        branchFinal,
        brandFinal,
        upstreamFinal,
      });

      // 百货身份护栏(2026-07-14 审计中危):normalizer 对"非百货小票的非空身份值"是**有意丢弃**
      // (免税店小票身份真相在护照任务上,不给小票夹带护照号开口子)——此处 `?? raw.trim()` 兜底
      // 曾把护栏整体架空,拒收的值原样写回。receipt 且 normalizer 未放行 = 拒收,不回填。
      const identityRejected = (key) => nextDocType === 'receipt'
        && !Object.prototype.hasOwnProperty.call(normalizedEditableFields, key);
      if (typeof extractedNameFinal === 'string' && !identityRejected('extractedNameFinal')) {
        task.extractedNameFinal = normalizedEditableFields.extractedNameFinal ?? extractedNameFinal.trim();
      }
      if (typeof passportNoFinal === 'string' && !identityRejected('passportNoFinal')) {
        task.passportNoFinal = normalizedEditableFields.passportNoFinal ?? passportNoFinal.trim();
      }
      if (typeof chineseNameFinal === 'string') {
        task.chineseNameFinal = normalizedEditableFields.chineseNameFinal ?? chineseNameFinal.trim();
      }
      if (typeof receiptStoreFinal === 'string') {
        task.receiptStoreFinal = normalizedEditableFields.receiptStoreFinal ?? receiptStoreFinal.trim();
      }
      if (typeof receiptNoFinal === 'string') {
        task.receiptNoFinal = normalizedEditableFields.receiptNoFinal ?? receiptNoFinal.trim();
      }
      if (typeof groupNoFinal === 'string') {
        const nextGroupNo = normalizedEditableFields.groupNoFinal ?? groupNoFinal.trim();
        // B2 安全网(2026-07-10 票级两步流):已通过的小票团号被改 → 强制清通过+清表态重走两步。
        // 防"配错了+又没人看过"双暴露(免审票尤甚);前端也会做,这里是后端兜底口径。
        if (nextGroupNo !== String(task.groupNoFinal || '') && task.reviewed) {
          task.reviewed = false;
          task.reviewedAt = '';
          task.tourStance = '';
          task.tourStancedAt = '';
          task.tourStancedBy = '';
        }
        task.groupNoFinal = nextGroupNo;
      }
      if (typeof purchaseDateFinal === 'string') {
        task.purchaseDateFinal = normalizedEditableFields.purchaseDateFinal ?? purchaseDateFinal.trim();
      }
      if (typeof departureDateFinal === 'string') {
        task.departureDateFinal = normalizedEditableFields.departureDateFinal ?? departureDateFinal.trim();
      }
      if (typeof receiptAmountFinal === 'string') {
        task.receiptAmountFinal = normalizedEditableFields.receiptAmountFinal ?? receiptAmountFinal.trim();
      }
      if (typeof branchFinal === 'string') {
        task.branchFinal = normalizedEditableFields.branchFinal ?? branchFinal.trim();
      }
      if (typeof brandFinal === 'string') {
        task.brandFinal = normalizedEditableFields.brandFinal ?? brandFinal.trim();
      }
      if (typeof upstreamFinal === 'string') {
        task.upstreamFinal = normalizedEditableFields.upstreamFinal ?? upstreamFinal.trim();
      }
      // 改店清残留落地(2026-07-14 审计中危):normalizer 在 PATCH 带 receiptStoreFinal 时按
      // 目标店档案白名单产出百货字段清空指令——**即便请求体没带这些字段也要应用**。
      // 原子定型 PATCH(只带 docType+store,如「这其实是百货」)正是残留高发路径:
      // 乐天百货→新世界百货 留 branch/brand、百货→免税店 留全四件,上面按 body 出现才合的
      // 逻辑覆盖不到。只应用清空('')不应用值,不与上面的显式赋值打架。
      if (typeof receiptStoreFinal === 'string') {
        for (const key of ['receiptAmountFinal', 'branchFinal', 'brandFinal', 'upstreamFinal']) {
          if (normalizedEditableFields[key] === '' && typeof (body || {})[key] !== 'string') {
            task[key] = '';
          }
        }
      }
      // 票级表态(2026-07-10 两步流):tourStancedAt 由服务端盖时间,不信客户端时钟。
      if (typeof tourStance === 'string') {
        const previousStance = String(task.tourStance || '');
        const stanceChanged = task.tourStance !== tourStance;
        task.tourStance = tourStance;
        if (tourStance) {
          if (stanceChanged || !task.tourStancedAt) task.tourStancedAt = new Date().toISOString();
          if (typeof tourStancedBy === 'string' && tourStancedBy.trim()) {
            task.tourStancedBy = tourStancedBy.trim().slice(0, 50);
          }
        } else {
          task.tourStancedAt = '';
          task.tourStancedBy = '';
          // 撤销「无团号」表态 → 连带撤掉自动回填的「无」,恢复"必须重新给团号表态"的强制力;
          // 只回滚哨兵字面量,人工敲过真团号的值不动。
          if (previousStance === 'none' && String(task.groupNoFinal || '').trim() === NO_TOUR_LITERAL) {
            task.groupNoFinal = '';
          }
        }
      }
      // 无团号表态自动回填「无」(2026-07-20 行为三合一):tourStance='none' 与机场票字面量「无」
      // 是同一业务语义,下游(确认硬闸/机场模式推断/代理视图豁免)全绕「无」建——表态时把空团号
      // 统一成「无」,两条路在写入层物理汇流;回填前的存量空值行由 lib/no_tour 表态容错兜住。
      // 放在 groupNoFinal 赋值之后:前端旧草稿把「无」覆盖回空串也会当场自愈。
      if (nextDocType === 'receipt'
        && String(task.tourStance || '') === 'none'
        && !String(task.groupNoFinal || '').trim()) {
        task.groupNoFinal = NO_TOUR_LITERAL;
      }
      if (typeof sActivityFlag === 'boolean') {
        task.sActivityFlag = sActivityFlag;
      }
      if (typeof modeManualPick === 'string') {
        // 人工选模式绑定当时团号:号变了预匹配守卫会自动作废(prematchTask)。
        task.modeManualPick = modeManualPick.trim();
        task.modeManualPickTour = (typeof modeManualPickTour === 'string' && modeManualPickTour.trim())
          ? modeManualPickTour.trim()
          : String(task.groupNoFinal || '').trim();
      }
      if (typeof signatureStyle === 'string') {
        task.signatureStyle = signatureStyle;
      }
      if (typeof reviewNote === 'string') {
        task.reviewNote = reviewNote;
      }

      // 触发点③:字段落定后当场重跑团号预匹配(改团号→红绿即时反馈;改类型→清残留)。
      // 本地SQL毫秒级,每次任务更新都跑,幂等;失败不阻断保存(advisory)。
      // 复核LOW(2026-07-20):advisory 失败必须留痕——resolveTaskModeRule 现在无条件信
      // modeManualPick,prematch 挂掉时人选守卫(团号变了作废旧人选)不跑,旧人选会带着
      // 过期团号污染分桶/台账票号形态,没日志根本查不到。
      if (groupCodePrematchHolder.service) {
        try { groupCodePrematchHolder.service.prematchTask(batch.id, task); } catch (prematchErr) {
          logger.warn({ event: 'prematch_advisory_failed', batchId: batch.id, taskId: task.id, err: prematchErr?.message }, 'prematch advisory failed on task PATCH');
        }
      }

      const invalidatedWebsiteOutput = syncWebsiteSignatureAfterFieldChange(previousTask, task);
      if (
        invalidatedWebsiteOutput
        && previousTask.finalSignatureSource === websiteSignatureSource
        && previousTask.finalSignaturePath
      ) {
        removeFileIfExists(resolveBatchRelativePath(batch.id, previousTask.finalSignaturePath));
      }

      const editableWorkflowChanged = docTypeChanged || didEditableWorkflowChange(previousTask, task);
      if (editableWorkflowChanged && typeof reviewed !== 'boolean' && !task.rephotoRequested) {
        task.reviewed = false;
        task.reviewedAt = '';
      }

      if (typeof reviewed === 'boolean') {
        markClassificationConfirmed(task);
        // 改文档类型与"标记已通过"不能同一笔完成(2026-07-13「其他→小票」补救 bug):
        // 类型刚变=分类刚定,新类型的要求(小票团号两步流等)还没走一遍,不能同笔就通过——
        // 否则误分类成"其他"的小票改回小票时,会跳过团号两步锁直接盖已通过。类型变更优先,
        // "通过"留作操作员下一步动作;仅拦 reviewed=true,取消通过(false)照常。
        const approve = reviewed && !docTypeChanged;
        task.reviewed = approve;
        task.reviewedAt = approve ? new Date().toISOString() : '';
        if (approve) {
          task.rephotoRequested = false;
          task.rephotoReason = '';
        }
      }

      if (typeof rephotoRequested === 'boolean') {
        markClassificationConfirmed(task);
        task.rephotoRequested = rephotoRequested;
        if (rephotoRequested) {
          task.reviewed = false;
          task.reviewedAt = '';
          // 重拍原因分键(0727反馈#10):只认三键,不认的值不落(旧客户端裸标重拍=原因留空,兼容)。
          if (['blurry', 'missing', 'other'].includes(String(rephotoReason || ''))) {
            task.rephotoReason = String(rephotoReason);
          }
        } else {
          // 取消重拍/恢复审核:原因一起清,不留"幽灵原因"挂在正常任务上。
          task.rephotoReason = '';
        }
      }

      recoverCompletedStateAfterManualReview(task);
      recalcTask(task);
      await queueAutomaticWebsiteSignature(batch, task);
      incrementTaskVersion(task);
      touchTask(task);
      await saveBatchAsync(batch);

      // V2 Task7(修订④):主写落盘后对账运营任务(全表态→send_upstream;重开→取消/更正)。
      // advisory:协调器内部吞错记 retry,绝不回滚已落盘的批次主写。
      if (workflowTaskCoordinatorHolder.service) {
        workflowTaskCoordinatorHolder.service.afterTaskWrite({
          batch,
          previousTask,
          task: normalizeTask(task),
          operator: String(body?.tourStancedBy || body?.operator || ''),
        });
      }

      return ok({
        ok: true,
        task: applyComputedFields(batch, task),
        // 轻量批次元信息(2026-07-08 增量合并配套):前端确认/重拍不再整批 refetch 后,
        // groupCodeStatus(团号表后台解析 parsing→ready)会陈旧、结算按钮多锁——
        // 这里捎带一份(与 summarizeBatch 同口径),store 顺手合并。别在这加重字段。
        batchMeta: { groupCodeStatus: batch.groupCodeImport?.status || null },
      });
    }, { label: 'updateTask' });
  }

  async function deleteTask({ batchId, taskId }) {
    return withBatchWrite(batchId, async () => { // label: deleteTask
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      const taskIndex = batch.tasks.findIndex((item) => item.id === taskId);
      if (taskIndex < 0) {
        return error(404, { error: 'Task not found' });
      }

      // B5(2026-07-16 同步一致性审计):已结算组的票不可删——台账行 source_task_id 会悬空、
      // 证据图被物理删除且删除会同步进镜像/投影。已审未结算仍可删(现有查重清理流程)。
      const pendingDelete = batch.tasks[taskIndex];
      const settledGroup = (Array.isArray(batch.sourceGroups) ? batch.sourceGroups : []).find(
        (g) => String(g?.key || g?.groupKey || '').trim() === String(pendingDelete?.sourceGroupKey || '').trim()
          && (g?.settledAt || String(g?.settlementStatus || '') === 'settled')
      );
      if (settledGroup) {
        return error(409, {
          error: '本组已产生结算台账,票据是台账证据不可删除(确需处理请联系管理员走台账侧订正)',
          code: 'delete_blocked_settled',
        });
      }

      const [task] = batch.tasks.splice(taskIndex, 1);
      removeTaskArtifacts(batch.id, task, batch.tasks);

      // 已删路径墓碑:审核台删掉的图(如重复护照),客户库原图还在;补图/追加同客户时
      // append 按"路径不在批次里就加"会把它原样加回来(删了又回到待处理)。记下被删任务的
      // 来源路径,append 去重时跳过 → 删了就是删了;真要恢复走"重识别/重新导入"或传新图(新路径不受影响)。
      const deletedSourcePath = String(task.sourceOriginalPath || '').trim();
      if (deletedSourcePath) {
        const tombstones = Array.isArray(batch.deletedSourcePaths) ? batch.deletedSourcePaths : [];
        if (!tombstones.includes(deletedSourcePath)) tombstones.push(deletedSourcePath);
        // L593:不再 slice(-500)——墓碑是去重唯一真相源(bridge getBatchSourceOriginalPathSet 消费),
        // 截断会逐出最旧墓碑→审核台删过的重复护照/废图在下次 append/sweep 去重时放行、重建任务复活。
        // 墓碑只随「不同」删除路径增长(上一行 includes 去重),上界=该批次曾出现的图片数量级(与
        // tasks[] 同量级,路径字符串体量小),并非真无限,去掉截断安全。
        batch.deletedSourcePaths = tombstones;
      }

      if (batch.tasks.length === 0) {
        clearActiveBatch(batch.id);
        removeProjectionSafely(batch.id);
        removeBatchDirectory(batch.id);
        return ok({
          ok: true,
          batchDeleted: true,
          batchId: batch.id,
          deletedTaskId: task.id,
        });
      }

      await saveBatchAsync(batch);
      return ok({
        ok: true,
        batchDeleted: false,
        batch: summarizeBatch(batch, { includeTasks: true }),
        deletedTaskId: task.id,
      });
    }, { label: 'deleteTask' });
  }

  // 手画文档框(第 2 期):操作员在原图上拖一个框 → 这条任务从此按那个框出交付图。
  // 走同一把批次写锁,理由和补票一样:审核 updateTask 会并发落盘,不加锁会整份覆盖。
  async function setTaskDocBox({ batchId, taskId, box }) {
    if (!hasBatch(batchId)) return error(404, { error: 'Batch not found' });

    // 传 null / [] = 清除(画错了要能撤销,不能只让人覆盖)
    const clearing = isClearRequest(box);
    // 校验放在锁外:纯判断,不需要占锁(也让明显的坏输入更快被打回)
    const normalized = clearing ? { box: null } : normalizeManualBox(box);
    if (!clearing && !normalized.box) return error(400, { error: normalized.error });

    return withBatchWrite(batchId, async () => {
      const batch = loadBatch(batchId);
      const task = batch.tasks.find((item) => item.id === taskId);
      if (!task) return error(404, { error: 'Task not found' });

      const accept = canAcceptManualBox(task);
      if (!accept.ok) return error(400, { error: accept.error });

      // detectionBox 是交付侧和文档框显示都在读的那个字段;manualBox 留痕"这是人画的",
      // 便于日后区分模型框和人工框(比如重识别时不要覆盖人工框)。
      if (clearing) {
        // 只清人工框;模型原本给的 detectionBox 若和人工框相同也一并清掉(它就是被覆盖的那个)
        delete task.manualBox;
        delete task.docBoxSource;
        delete task.docBoxSetAt;
        delete task.detectionBox;
      } else {
        task.detectionBox = normalized.box;
        task.manualBox = normalized.box;
        task.docBoxSource = 'manual';
        task.docBoxSetAt = new Date().toISOString();
      }
      incrementTaskVersion(task);
      await saveBatchAsync(batch);

      logger.info({ event: clearing ? 'task_doc_box_cleared' : 'task_doc_box_set', batchId, taskId, box: normalized.box }, 'manual doc box updated');
      return ok({
        ok: true,
        batchId: batch.id,
        taskId: task.id,
        box: normalized.box,
        batch: summarizeBatch(batch, { includeTasks: true }),
      });
    }, { label: 'setTaskDocBox' });
  }

  return {
    createManualReceiptFromTask,
    createManualTask,
    deleteTask,
    updateTask,
    setTaskDocBox,
  };
}

module.exports = {
  createTaskOperations,
};
