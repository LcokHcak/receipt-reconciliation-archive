'use strict';

/**
 * workbench_approve_settle_service — 流式逐客户「通过并结算」编排(P0,纯后端链路)。
 *
 * 把现有 3 个件串成一个动作,审核员审完一个客户组即时拿到「按小票的渠道模式」:
 *   ① groupApprovalService.approveGroup     通过 + 出包定稿(复用,本就不写台账)
 *   ② ledgerBridgeService.syncApprovedGroup  组级写台账(posted / 按购买日期落月,复用)
 *   ③ tourMatchService.run({ws, batchId})    每个受影响 workspace 增量跑团号匹配(复用)
 *                                            —— per-ws 串行锁已下沉进 run 内部,防并发踩
 *   ④ dailyReceiptRepo.listBySourceGroup     回读本组台账行 → 返回每张小票 {团号,渠道模式,状态}
 *
 * 不改任何旧件,不接路由/前端(P1 再做)。旧的批次级「导入台账」流程原样保留。
 * 设计依据见对话:逐客户真写台账 + 即时 tour_match + 审核员手动确认渠道模式(确认在 P1)。
 */

const { DOC_TYPES } = require('../lib/package_constants');
const { groupPassportIssue } = require('../lib/validation/group_passport_rule');
const { getLockedFields } = require('../lib/monthly/manual_lock');

// 台账去重业务键(insertMany 预查按 {票号+店+日期}):computeDeletableIdsByWorkspace 判断"保护手改行会不会
// 因业务键变了留双行"用它——锁了非业务键列(姓名/护照/团号/代理)重插会被去重跳过,可安全保护;
// 锁了业务键列(购买日期)则保护会留双行(双计),故不保护。
const SETTLE_BUSINESS_KEY_FIELDS = new Set(['receipt_no', 'shop', 'purchase_date']);

function normalizeKey(value) {
  return String(value || '').trim();
}

function isRephotoTask(task) {
  const pr = normalizeKey(task?.processResult).toLowerCase();
  return Boolean(task?.rephotoRequested) || pr.includes('rephoto') || pr.includes('重拍');
}

function docTypeOf(task) {
  return normalizeKey(task?.docTypeFinal || task?.docTypeAuto).toLowerCase();
}

// 结算前资格校验(与批次级 classifyGroup 的「非 not_approved 部分」对齐;not_approved 不查,
// 因为 settle 本身就负责 approve)。返回不合格原因,空串=合格。
function preCheckGroup(groupTasks) {
  const tasks = Array.isArray(groupTasks) ? groupTasks : [];
  if (tasks.length === 0) return { reason: 'no_tasks', taskId: '' };
  // ① 有重拍 → 不能结算未拍完的客户(审核员应标重拍跳过,等补图)
  const rephotoTask = tasks.find(isRephotoTask);
  if (rephotoTask) return { reason: 'rephoto_requested', taskId: String(rephotoTask.id || '') };
  // ② 护照数量:普通组恰好 1 本;百货组(护照+小票同框)护照落在小票任务上,允许 0 独立护照
  //    ——统一口径 lib/validation/group_passport_rule(防三处副本漂移)。
  const passports = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.PASSPORT && !isRephotoTask(t));
  const receipts = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.RECEIPT && !isRephotoTask(t));
  const passportIssue = groupPassportIssue({ passportTasks: passports, receiptTasks: receipts });
  if (passportIssue) {
    // 多本护照→第二本是嫌疑张;缺护照是组级问题→落到组内第一张,定位后组会展开
    const suspect = passports[1] || passports[0] || receipts[0] || tasks[0];
    return { reason: passportIssue, taskId: String(suspect?.id || '') };
  }
  return null;
}

function createWorkbenchApproveSettleService({
  groupApprovalService,
  ledgerBridgeService,
  tourMatchService,
  dailyReceiptRepo,
  logger = console,
}) {
  if (!groupApprovalService || typeof groupApprovalService.approveGroup !== 'function') {
    throw new Error('groupApprovalService.approveGroup required');
  }
  if (!ledgerBridgeService || typeof ledgerBridgeService.syncApprovedGroup !== 'function') {
    throw new Error('ledgerBridgeService.syncApprovedGroup required');
  }
  if (!tourMatchService || typeof tourMatchService.run !== 'function') {
    throw new Error('tourMatchService.run required');
  }
  if (!dailyReceiptRepo || typeof dailyReceiptRepo.listBySourceGroup !== 'function') {
    throw new Error('dailyReceiptRepo.listBySourceGroup required');
  }

  // 派生标脏服务(晚绑定,照 ledgerBridge setter 先例):台账订正删行后必须标脏受影响
  // workspace 的派生链(8模块审计 HIGH:删行不标脏=对账/交付派生继续用已删行的旧结论)。
  let derivationRecomputeService = null;
  function setDerivationRecomputeService(svc) { derivationRecomputeService = svc || null; }

  function groupTasksOf(batch, groupKey) {
    const key = normalizeKey(groupKey);
    return (batch?.tasks || []).filter((task) => normalizeKey(task?.sourceGroupKey) === key);
  }

  function affectedWorkspacesOf(sync) {
    if (Array.isArray(sync?.affectedWorkspaces) && sync.affectedWorkspaces.length) {
      return sync.affectedWorkspaces.filter(Boolean);
    }
    return sync?.workspaceKey ? [sync.workspaceKey] : [];
  }

  function readSettledReceipts(workspaceKey, batchId, groupKey) {
    const rows = dailyReceiptRepo.listBySourceGroup({
      workspaceKey,
      sourceBatchId: batchId,
      sourceCustomerId: normalizeKey(groupKey),
    }) || [];
    return rows.map((row) => ({
      workspaceKey,
      // 台账行 id(P1 内联补救,2026-07-18):结算面板当场补救要调 PATCH /ledger/:id/fields,
      // SQL 本就查了 id,这里带出去;confirmGroupModes/getGroupSettlement 同函数自动受益。
      id: row.id ?? null,
      receiptNo: row.receiptNo ?? row.receipt_no ?? null,
      // shop/purchaseDate(P1 内联补救):组级"同模式应用"按 同团号+同店 收窄;日期类补救预填原日期
      shop: row.shop ?? null,
      purchaseDate: row.purchaseDate ?? row.purchase_date ?? null,
      tourNo: row.tourNo ?? row.tour_no ?? null,
      modeRaw: row.modeRaw ?? row.mode_raw ?? null,
      modeFolder: row.modeFolder ?? row.mode_folder ?? null,
      tourMatchStatus: row.tourMatchStatus ?? row.tour_match_status ?? null,
      billMatchStatus: row.billMatchStatus ?? row.bill_match_status ?? null,
      modeConfirmedAt: row.modeConfirmedAt ?? row.mode_confirmed_at ?? null,
      sourceTaskId: row.sourceTaskId ?? row.source_task_id ?? null,
    }));
  }

  // tour_match 未命中/异常(需补救)的状态集合;skipped_mode_not_required(渠道模式有、桶待映射)
  // 当作"待确认"(审核员确认渠道模式后由 mapping/补救落桶),不算补救。
  const REMEDY_STATUSES = new Set([
    'tour_not_found', 'tour_ambiguous', 'tour_store_mismatch', 'agent_mismatch',
    'date_missing', 'date_out_of_window', 'mode_unresolved',
  ]);

  // 由一组小票的台账行派生客户组结算状态(驱动客户看板徽标)。
  function deriveSettlementStatus(receipts) {
    const rows = Array.isArray(receipts) ? receipts : [];
    if (rows.length === 0) return 'no_receipts';
    if (rows.some((r) => REMEDY_STATUSES.has(String(r.tourMatchStatus)))) return 'needs_remedy';
    if (rows.every((r) => r.modeConfirmedAt)) return 'settled';
    return 'needs_confirm';
  }

  // 重结算前**计算**本组应清掉的旧台账行(只读,不执行删除):返回 [{workspaceKey, ids}] 交给桥接,
  // 由 repo.settleGroupAtomic 把删旧与写新放进同一事务(L180 原子)——不再 service 端先删、再靠内存
  // 快照失败补插(那套非原子:进程崩溃就"删了没补",且补不回级联删的 error_record/pending_review)。
  // 为何删必须与写同事务、且删在写之前:改了票号/日期/店后旧行会变孤儿(双计);去重哈希只按
  // {票号/日期/店},改了团号/姓名等非键字段时 hash 不变——唯有先删旧行 insertRowsCore 才会真写入
  // 更新值(否则 UNIQUE 冲突被去重跳过)。
  // 只清「未账单匹配」的行——已 matched/对账过的不动,保护下游成果。首次结算本组无旧行,返回 []。
  function computeDeletableIdsByWorkspace(batchId, groupKey) {
    if (typeof dailyReceiptRepo.listWorkspaceKeysForSourceGroup !== 'function'
      || typeof dailyReceiptRepo.listBySourceGroup !== 'function') {
      return []; // 老 repo 不支持列举就不算删除(行为退回旧版:可能留孤儿,但不报错)
    }
    const workspaces = dailyReceiptRepo.listWorkspaceKeysForSourceGroup({
      sourceBatchId: batchId,
      sourceCustomerId: normalizeKey(groupKey),
    }) || [];
    const out = [];
    for (const ws of workspaces) {
      const rows = dailyReceiptRepo.listBySourceGroup({
        workspaceKey: ws, sourceBatchId: batchId, sourceCustomerId: normalizeKey(groupKey),
      }) || [];
      const ids = rows
        .filter((r) => String(r.billMatchStatus ?? r.bill_match_status ?? 'unmatched') === 'unmatched')
        // 人工手改过的行不删(审计MEDIUM,扩 F6 保护面):F6 原只护 tour_match_status(补救确认才锁),
        // 但普通手改(PATCH 不带 manualRemedyConfirm)只锁被改的**非业务键**列(姓名/护照/团号/代理),
        // 这些行照删→重结算用任务旧值重建→手改静默翻回(复现:台账页改护照号后重结算翻回)。
        // 改为:锁了非业务键列且没锁业务键的行一律保护——重插行业务键(票号+店+日期)不变会被去重
        // 跳过,手改保留且不产生双行(与 F6 注释同理)。极端:锁了业务键(改了购买日期)的行仍按旧
        // 行为删——保护会因业务键变了留双行(双计,更糟);"改业务键还要留"需删前合并,属更大改动(另立)。
        .filter((r) => {
          const locks = getLockedFields(r);
          if (locks.size === 0) return true; // 无人工锁 → 可删(首次结算/纯机器行)
          const locksBusinessKey = [...locks].some((f) => SETTLE_BUSINESS_KEY_FIELDS.has(f));
          return locksBusinessKey; // 仅非业务键锁 → 保护(false=不删);锁了业务键 → 可删(避免双行)
        })
        .map((r) => r.id)
        .filter((id) => id != null);
      if (ids.length) out.push({ workspaceKey: ws, ids });
    }
    return out;
  }

  async function approveAndSettleGroup({ batch, groupKey, operator = null, workspaceKey = null }) {
    if (!batch?.id) throw new Error('batch required');
    if (!normalizeKey(groupKey)) throw new Error('groupKey required');

    const groupTasks = groupTasksOf(batch, groupKey);
    // 加固①:结算前资格校验(重拍/护照数)→ 不合格不 approve、不写台账,返回清晰原因给前端。
    const ineligible = preCheckGroup(groupTasks);
    if (ineligible) {
      return {
        ok: false, stage: 'precheck', reason: ineligible.reason,
        // 带上嫌疑张 taskId:前端红条「定位到这张图」直接跳到重拍/多护照那张
        details: ineligible.taskId ? { taskId: ineligible.taskId } : null,
        approvedTaskIds: [], affectedWorkspaces: [], insertedRows: 0,
        settledReceipts: [], settlementStatus: 'blocked', tourResults: [],
      };
    }

    // 加固③(2026-07-14 审计#9):购买日期预检**先于一切不可逆动作**——写台账时的日期落月
    // 解析会 throw(如 OCR 把年份读错超窗),曾发生在 approve+出包定稿之后 → 组定稿了台账
    // 0 行,操作员只见一条 400 不知道整组没进账。预检拦下=干净拒绝,什么都没发生。
    const requestedKey = normalizeKey(workspaceKey) || normalizeKey(batch.monthlyWorkspaceKey) || null;
    if (typeof ledgerBridgeService.precheckPurchaseDates === 'function') {
      const dateCheck = ledgerBridgeService.precheckPurchaseDates({ groupTasks, workspaceKey: requestedKey });
      if (dateCheck && dateCheck.ok === false) {
        return {
          ok: false, stage: 'precheck', reason: dateCheck.code || 'purchase_date_out_of_range',
          error: dateCheck.error || '购买日期超出可落月范围,请先核对日期', details: dateCheck.details || null,
          approvedTaskIds: [], affectedWorkspaces: [], insertedRows: 0,
          settledReceipts: [], settlementStatus: 'blocked', tourResults: [],
        };
      }
    }

    // ① 通过 + 出包定稿(复用;approveGroup 内部已 saveBatchAsync,本就不写台账)
    const approval = await groupApprovalService.approveGroup({ batch, groupKey });

    // 加固②(L180):重结算先算本组应清的旧未匹配台账行(不在此删),交给桥接与写台账在同一
    // 事务里原子执行——删旧+写新要么全成、要么全回滚,不再需要"删了失败再补插"的内存快照。
    const deleteIdsByWorkspace = computeDeletableIdsByWorkspace(batch.id, groupKey);

    // ② 组级写台账(posted,按购买日期落月;并原子清旧行)。兜底 try/catch:预检已拦日期类,
    // 这里再炸(磁盘/库异常等)也转结构化失败返回,不让业务错漏进兜底 500(历史事故同款)。
    // settleGroupAtomic 抛错=整事务回滚(删旧一并撤销、旧行不丢),故失败路径无需再补插回滚。
    let sync;
    try {
      sync = await ledgerBridgeService.syncApprovedGroup({
        groupTasks,
        groupKey,
        batchId: batch.id,
        operator,
        workspaceKey: requestedKey,
        deleteIdsByWorkspace,
      });
    } catch (syncError) {
      logger?.error?.(`[approve_settle] batch=${batch.id} group=${groupKey} ledger threw: ${syncError?.message}`);
      return {
        ok: false, stage: 'ledger', error: String(syncError?.message || syncError),
        details: syncError?.details || null,
        approvedTaskIds: approval?.approvedTaskIds || [],
        affectedWorkspaces: [], insertedRows: 0, settledReceipts: [], tourResults: [],
      };
    }
    if (sync?.error) {
      // 桥接失败不静默:返回失败让调用方/前端显式感知,不计成功(旧行已随事务回滚保住)。
      logger?.error?.(`[approve_settle] batch=${batch.id} group=${groupKey} ledger failed: ${sync.error}`);
      return {
        ok: false,
        stage: 'ledger',
        error: sync.error,
        approvedTaskIds: approval?.approvedTaskIds || [],
        affectedWorkspaces: affectedWorkspacesOf(sync),
        insertedRows: 0,
        settledReceipts: [],
        tourResults: [],
      };
    }

    const affected = affectedWorkspacesOf(sync);

    // ③ 每个受影响 workspace 串行跑增量 tour_match(防 30 人并发互踩 error/pending_review)。
    // 锁已下沉进 tourMatchService.run 内部(8模块审计 HIGH 收口),这里不再外包——
    // 锁不可重入,同 key 双取会死锁。三条 run 调用路径现由 run 自身统一串行。
    const tourResults = [];
    for (const ws of affected) {
      const result = await tourMatchService.run({
        workspaceKey: ws,
        operator: operator || 'approve_settle',
        batchId: batch.id,
      });
      tourResults.push({ workspaceKey: ws, ...result });
    }

    // ④ 回读本组台账行 → 按小票的渠道模式/状态(P0 链路验证产物)
    const settledReceipts = [];
    for (const ws of affected) {
      settledReceipts.push(...readSettledReceipts(ws, batch.id, groupKey));
    }

    return {
      ok: true,
      approvedTaskIds: approval?.approvedTaskIds || [],
      affectedWorkspaces: affected,
      removedOldRows: Number(sync.removed || 0), // L180:删旧计数来自原子 op(sync.removed)
      insertedRows: Number(sync.inserted || 0),
      skippedRows: Number(sync.skipped || 0),
      // 无小票/整组护照 等非错误跳过原因透传(P1 前端据此提示"无小票可结算")。
      skippedReason: sync.skippedReason || null,
      settledReceipts,
      settlementStatus: deriveSettlementStatus(settledReceipts),
      tourResults,
    };
  }

  function readGroupAcrossWorkspaces(batchId, groupKey) {
    const workspaces = dailyReceiptRepo.listWorkspaceKeysForSourceGroup({
      sourceBatchId: batchId,
      sourceCustomerId: normalizeKey(groupKey),
    }) || [];
    const receipts = [];
    for (const ws of workspaces) receipts.push(...readSettledReceipts(ws, batchId, groupKey));
    return { workspaces, receipts };
  }

  // 台账侧订正(2026-07-21 交付修改#10):管理员撤销一个已结算组的台账——删该组全部台账行
  // (deleteRowsWithCascade 级联清下游,单事务)并返回完整快照供审计留痕。调用方(handler)
  // 负责:admin 门禁、withBatchWrite 锁内清组级结算盖章、审计日志。原则:台账行真删
  // (下游 tour/bill match 派生一致性由级联维护),证据保全走 audit_log 快照 + 组 meta 留痕,
  // 不引入下游读方都不认识的 voided 状态。订正后组回到已审未结算态,可改字段/删除/重新结算。
  function correctGroupLedger({ batch, groupKey, reason = '' }) {
    if (!batch?.id) throw new Error('batch required');
    const key = normalizeKey(groupKey);
    if (!key) throw new Error('groupKey required');
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      const err = new Error('订正原因必填(审计留痕)');
      err.code = 'LEDGER_CORRECTION_REASON_REQUIRED';
      throw err;
    }
    const { workspaces, receipts } = readGroupAcrossWorkspaces(batch.id, key);
    if (!receipts.length) {
      const err = new Error('该组没有台账行(未结算或已订正过),无需订正');
      err.code = 'LEDGER_CORRECTION_NO_ROWS';
      throw err;
    }
    // 快照先取全、后删——删完就取不到了;快照进审计与组 meta,是"证据不灭"的载体
    const snapshot = receipts.map((r) => ({
      workspaceKey: r.workspaceKey, id: r.id, receiptNo: r.receiptNo, shop: r.shop,
      purchaseDate: r.purchaseDate, tourNo: r.tourNo, modeRaw: r.modeRaw,
      tourMatchStatus: r.tourMatchStatus, billMatchStatus: r.billMatchStatus,
      sourceTaskId: r.sourceTaskId,
    }));
    let removed = 0;
    for (const ws of workspaces) {
      const ids = receipts.filter((r) => r.workspaceKey === ws && Number.isFinite(Number(r.id)))
        .map((r) => Number(r.id));
      if (ids.length) removed += dailyReceiptRepo.deleteMany({ workspaceKey: ws, ids });
      // 删行=上游变更:从最浅阶段 tour_match 起标脏,派生链(对账/交付)重算不再引用已删行
      // 删行标脏=bill_match(照 listing_routes 删行先例):配对账单回未收池+月度刷新即可;
      // 不用更浅的 tour_match——无谓重跑团号匹配会碰人工背书锁行(人工匹配不抗重跑,A级已知病)。
      try { derivationRecomputeService?.markDirty?.(ws, 'bill_match'); } catch { /* 标脏失败不阻断订正 */ }
    }
    logger.warn?.(`[ledger_correction] batch=${batch.id} group=${key} removed=${removed} reason=${trimmedReason}`);
    return { ok: true, removedRows: removed, workspaces, snapshot };
  }

  // 审核员确认本组已命中小票的渠道模式(人工背书),逐个落进的 workspace 处理(跨月也覆盖)。
  async function confirmGroupModes({ batch, groupKey, operator = null }) {
    if (!batch?.id) throw new Error('batch required');
    if (!normalizeKey(groupKey)) throw new Error('groupKey required');
    const { workspaces } = readGroupAcrossWorkspaces(batch.id, groupKey);
    let confirmed = 0;
    for (const ws of workspaces) {
      confirmed += Number(dailyReceiptRepo.confirmModesByGroup({
        workspaceKey: ws,
        sourceBatchId: batch.id,
        sourceCustomerId: normalizeKey(groupKey),
        operator,
      }) || 0);
    }
    const { receipts } = readGroupAcrossWorkspaces(batch.id, groupKey);
    return {
      ok: true,
      confirmed,
      settledReceipts: receipts,
      settlementStatus: deriveSettlementStatus(receipts),
    };
  }

  // 客户看板徽标用:读某客户组当前结算状态 + 按小票模式明细。
  function getGroupSettlement({ batch, groupKey }) {
    if (!batch?.id) throw new Error('batch required');
    const { receipts } = readGroupAcrossWorkspaces(batch.id, normalizeKey(groupKey));
    return {
      settlementStatus: deriveSettlementStatus(receipts),
      settledReceipts: receipts,
    };
  }

  return { approveAndSettleGroup, confirmGroupModes, getGroupSettlement, correctGroupLedger, setDerivationRecomputeService };
}

module.exports = { createWorkbenchApproveSettleService };
