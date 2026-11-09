'use strict';

/**
 * tour_confirm_service — 团号确认站(2026-07-10,P1-P4 主体)。
 *
 * 职责:
 *   buildCandidates  组级候选聚合:组内小票的团号读数 → 候选清单(值/票数/命中表/模式/冲突)。
 *   confirmTour      人工确认:校验表内命中 → 盖章 sourceGroups[].tourConfirm → 回填组内空票
 *                    groupNoFinal(只写空票/未人工改过票,matched 异值票绝不覆盖)→ 逐票重跑
 *                    预匹配 → 写确认流水(先验+审计)→ 时效模式入回发队列。
 *   unconfirmTour    撤销(未结算):旧确认进 revisions;曾走 slim 车道 → 组内小票强制清 reviewed。
 *   assertTourConfirmed 硬闸(ENV WORKBENCH_REQUIRE_TOUR_CONFIRM=true 才生效):未确认组拦通过/结算。
 *
 * 铁律:
 *   - 确认永远是人点的;本服务不做任何自动确认(50% OCR 兜底,准比快重要——用户拍板)。
 *   - 组级 tourConfirm 是闸和回填器,不是台账真相源:结算权威终匹配(tour_match)照旧。
 *   - 手填只有命中团号表才允许 confirmed;查不到只能存 pending_table(表外待核)。
 */

const { AppError } = require('../lib/errors');
const { DOC_TYPES } = require('../lib/package_constants');
const { stampGroupTourConfirm, normalizeTourConfirm } = require('../lib/source_group_utils');
const { laneOfMode, parseSlimModes, sendbackActionOfMode } = require('../lib/review_lane');
const { isNoTourTask } = require('../lib/no_tour');

// mismatchModes 的真实契约是 ' / ' 拼接的字符串(group_code_prematch_service 一直如此,
// task.modeStoreMismatch 同款)——绝不能按数组假设(reviewer CRITICAL:按数组判永远空,
// 店不符场景 70299 病例会变成永远 422 的死路)。这里统一解析成数组。
function parseModeOptions(mismatchModes) {
  if (Array.isArray(mismatchModes)) return mismatchModes.filter(Boolean);
  return String(mismatchModes || '').split(' / ').map((s) => s.trim()).filter(Boolean);
}

function docTypeOf(task) {
  const raw = String(task?.docTypeFinal || task?.docTypeAuto || task?.docType || '').toLowerCase();
  if (raw.includes('passport') || raw.includes('护照')) return DOC_TYPES.PASSPORT;
  if (raw.includes('receipt') || raw.includes('小票')) return DOC_TYPES.RECEIPT;
  return 'other';
}

function groupTasksOf(batch, groupKey) {
  const key = String(groupKey || '').trim();
  return (batch?.tasks || []).filter((t) => String(t?.sourceGroupKey || '').trim() === key);
}

function tourValueOf(task) {
  return String(task.groupNoFinal || task.groupNoAuto || '').trim();
}

// 人工改过的票:groupNoFinal 有值且 ≠ OCR 读数 → 回填绝不覆盖。
function isHumanEdited(task) {
  const fin = String(task.groupNoFinal || '').trim();
  const auto = String(task.groupNoAuto || '').trim();
  return Boolean(fin) && fin !== auto;
}

function createTourConfirmService({
  groupCodePrematchHolder,        // { service: { lookupTour, prematchTask, MATCH_STATUS } } 晚绑定
  tourConfirmLogRepo = null,      // P2 先验流水(可空:未接时确认照常,只是没先验)
  sendbackQueueRepo = null,       // P3 回发队列(可空)
  slimModesEnv = () => process.env.WORKBENCH_SLIM_MODES,
  requireConfirmEnv = () => process.env.WORKBENCH_REQUIRE_TOUR_CONFIRM,
  now = () => new Date().toISOString(),
  logger = null,                  // V2 Task7:入队失败可观测(结构化日志+retry环)
} = {}) {
  // 回发入队失败记录(confirmTour 是同步契约不能 await;失败不再静默吞,记环形队列供诊断/补齐)
  const sendbackRetryItems = [];
  function recordSendbackFailure(error, context) {
    sendbackRetryItems.push({
      at: now(),
      batchId: context?.batchId || '',
      groupKey: context?.groupKey || '',
      action: context?.action || '',
      message: String(error?.message || error),
    });
    if (sendbackRetryItems.length > 200) sendbackRetryItems.splice(0, sendbackRetryItems.length - 200);
    logger?.warn?.('sendback_enqueue_failed', {
      batchId: context?.batchId,
      groupKey: context?.groupKey,
      action: context?.action,
      error: String(error?.message || error),
    });
  }

  function prematchService() {
    const svc = groupCodePrematchHolder?.service;
    if (!svc) throw new AppError('团号预匹配服务未就绪', { status: 503, code: 'PREMATCH_NOT_READY' });
    return svc;
  }

  // ── 豁免判定:百货票(模式=档案常量)/机场票(团号"无")/整组无小票 → 不需要确认 ──
  function exemptOf(tasks) {
    const receipts = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.RECEIPT);
    if (!receipts.length) return { isExempt: true, reason: 'no_receipts' };
    const allSkippable = receipts.every((t) => {
      // 机场票/无团号:字面量「无」或表态none+空值(存量行),单源 lib/no_tour——
      // 此前只认字面量,表态行在 ENV 硬闸(WORKBENCH_REQUIRE_TOUR_CONFIRM)下 approve/settle 双双 409。
      if (isNoTourTask(t)) return true;
      const store = String(t.receiptStoreFinal || t.receiptStoreAuto || '');
      // 百货识别兼容两种形态:canonical 枚举(生产存 LOTTE_DEPT/SHINSEGAE_DEPT/HYUNDAI_DEPT)
      // 和原始文字(乐天百货/백화점)。曾只认"百货"字样 → 生产 canonical 值永不命中,
      // 百货组不豁免卡进确认队列(2026-07-10 审计 HIGH,测试用原始文字喂掩盖了漂移)。
      return /_DEPT$/i.test(store) || /百货|백화점/.test(store);
    });
    if (allSkippable) return { isExempt: true, reason: 'dept_or_airport' };
    return { isExempt: false, reason: '' };
  }

  // ── 组级候选聚合(确认卡数据源)──────────────────────────────────────────
  function buildCandidates(batch, groupKey) {
    const tasks = groupTasksOf(batch, groupKey);
    if (!tasks.length) throw new AppError('客户组不存在或为空', { status: 404, code: 'GROUP_NOT_FOUND' });
    const svc = prematchService();
    const receipts = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.RECEIPT);
    const passports = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.PASSPORT);

    const byValue = new Map(); // 团号值 → { votes, taskIds, matchedVotes }
    const fuzzy = [];
    for (const t of receipts) {
      const v = tourValueOf(t);
      if (v && v !== '无') {
        if (!byValue.has(v)) byValue.set(v, { votes: 0, taskIds: [], matchedVotes: 0 });
        const e = byValue.get(v);
        e.votes += 1;
        e.taskIds.push(t.id);
        if (t.groupNoMatchStatus === 'matched') e.matchedVotes += 1;
      }
      const sug = String(t.groupNoSuggestion || '').trim();
      if (sug) fuzzy.push({ taskId: t.id, read: v, suggestion: sug });
    }

    // 每个候选值查表定性(店家取该值支持票里第一张的店,与预匹配同口径)。
    const candidates = [...byValue.entries()].map(([value, e]) => {
      const firstTask = receipts.find((t) => e.taskIds.includes(t.id));
      const store = String(firstTask?.receiptStoreFinal || firstTask?.receiptStoreAuto || '');
      const verdict = svc.lookupTour(batch.id, value, store);
      return {
        tourNo: value,
        votes: e.votes,
        matchedVotes: e.matchedVotes,
        taskIds: e.taskIds,
        tableStatus: verdict.status || '',
        mode: verdict.mode || '',
        modeOptions: parseModeOptions(verdict.mismatchModes),
      };
    }).sort((a, b) => b.votes - a.votes);

    // 冲突 = 出现 ≥2 个不同读数(用户实锤:多票组 30% 内部不一致 → 前端强制展开)。
    const conflict = candidates.length >= 2;
    const group = (batch.sourceGroups || []).find((g) => String(g?.key || '').trim() === String(groupKey).trim());

    return {
      groupKey: String(groupKey).trim(),
      counts: { tasks: tasks.length, receipts: receipts.length, passports: passports.length },
      exempt: exemptOf(tasks),
      candidates,
      fuzzy,
      conflict,
      emptyReceiptTaskIds: receipts.filter((t) => !tourValueOf(t)).map((t) => t.id),
      tourConfirm: normalizeTourConfirm(group?.tourConfirm),
    };
  }

  // ── 手填/候选即时查表(前端输入框边打边查)────────────────────────────────
  function probeTour(batch, tourNo, store = '') {
    const v = String(tourNo || '').trim();
    if (!v) return { status: '', mode: '', modeOptions: [] };
    const verdict = prematchService().lookupTour(batch.id, v, store);
    return {
      status: verdict.status || '',
      mode: verdict.mode || '',
      modeOptions: parseModeOptions(verdict.mismatchModes),
    };
  }

  // ── 人工确认 ─────────────────────────────────────────────────────────────
  // 就地改 batch(盖章+回填+重跑预匹配),不落盘——由 handler 在 withBatchWrite 内 save(照 confirmGroupModes 模板)。
  function confirmTour(batch, groupKey, {
    tourNo,
    mode = '',
    source = 'manual',
    basis = null,
    operator = null,
    allowPendingTable = false,
  } = {}) {
    const tasks = groupTasksOf(batch, groupKey);
    if (!tasks.length) throw new AppError('客户组不存在或为空', { status: 404, code: 'GROUP_NOT_FOUND' });
    const value = String(tourNo || '').trim();
    if (!value) throw new AppError('团号不能为空', { status: 400, code: 'TOUR_REQUIRED' });

    const svc = prematchService();
    const receipts = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.RECEIPT);
    const store = String(receipts[0]?.receiptStoreFinal || receipts[0]?.receiptStoreAuto || '');
    const verdict = svc.lookupTour(batch.id, value, store);

    let status = 'confirmed';
    let confirmedMode = '';
    if (verdict.status === 'matched') {
      confirmedMode = String(mode || verdict.mode || '').trim();
    } else if (verdict.status === 'store_mismatch' || verdict.status === 'mode_ambiguous') {
      // 团号在表里但一号多模式(店不符 / 同店双代理撞号):必须人工从表内候选里挑一个,
      // 不许瞎配(2026-07-12 用户拍板:系统绝不默取)。
      const options = parseModeOptions(verdict.mismatchModes);
      if (!mode || !options.includes(mode)) {
        const err = new AppError('该团号对应多个模式,请从候选模式中选择', { status: 422, code: 'MODE_CHOICE_REQUIRED' });
        err.details = { modeOptions: options }; // AppError 构造器不吃 details,挂实例(create_app 读 error.details)
        throw err;
      }
      confirmedMode = mode;
    } else if (allowPendingTable) {
      // 表外待核:团号表还没有这个号(表滞后),存起来等换表 sweep 自动复核。
      status = 'pending_table';
      confirmedMode = '';
    } else {
      const err = new AppError(`团号 ${value} 未命中团号表(${verdict.status || '无结果'});确认前请核对,或存为「表外待核」`, { status: 422, code: 'TOUR_NOT_IN_TABLE' });
      err.details = { tableStatus: verdict.status || '' };
      throw err;
    }

    // 回填:只写空票/OCR 值票;人工改过的票、有值且≠确认值的票绝不覆盖(留作例外人工裁决)。
    const backfilled = [];
    const exceptions = [];
    for (const t of receipts) {
      const cur = tourValueOf(t);
      // 机场票/无团号表态不动(单源 lib/no_tour):人工背书"票上没团号"的票,
      // 组级确认的团号绝不回填覆盖(存量表态行 cur 为空,此前会被静默灌上组团号)。
      if (isNoTourTask(t)) continue;
      if (isHumanEdited(t) && cur !== value) { exceptions.push({ taskId: t.id, value: cur, reason: 'human_edited' }); continue; }
      if (cur && cur !== value && t.groupNoMatchStatus === 'matched') {
        exceptions.push({ taskId: t.id, value: cur, reason: 'matched_other_tour' }); continue;
      }
      if (cur !== value) {
        t.groupNoFinal = value;
        backfilled.push(t.id);
      }
      // 确认回执(任务级,分车道审核的资格凭据之一;unconfirm 时清掉)。
      t.tourConfirmedAt = now();
      svc.prematchTask(batch.id, t); // 重跑预匹配 → 徽章/modeRawPre 翻新(实时审核里立刻看到)
    }

    const confirmedAt = now();
    const tourConfirm = {
      status,
      tourNo: value,
      mode: confirmedMode,
      source: String(source || 'manual'),
      basis: basis && typeof basis === 'object' ? basis : null,
      confirmedBy: String(operator || ''),
      confirmedAt,
    };
    // 幂等(reviewer MEDIUM):双标签页/网络重试重复提交同内容确认,不当作"更正"堆 revisions。
    const groupBefore = (batch.sourceGroups || []).find((g) => String(g?.key || '').trim() === String(groupKey).trim());
    const prevConfirm = normalizeTourConfirm(groupBefore?.tourConfirm);
    const identical = Boolean(prevConfirm && prevConfirm.status === status
      && prevConfirm.tourNo === value && prevConfirm.mode === confirmedMode);
    stampGroupTourConfirm(batch, groupKey, tourConfirm, { keepRevisions: !identical });

    // 确认流水(先验候选排序 + 审计)。失败不阻断确认(advisory)。
    if (tourConfirmLogRepo?.append && status === 'confirmed' && !identical) {
      // advisory:异步落流水,失败只吞不阻断确认;Promise.resolve 包住同步/异步两种实现,
      // .catch 兜住 rejection(裸 try/catch 接不住 Promise 失败——reviewer HIGH)。
      Promise.resolve().then(() => tourConfirmLogRepo.append({
        workspaceKey: String(batch.monthlyWorkspaceKey || ''),
        date: confirmedAt.slice(0, 10),
        tourNo: value,
        mode: confirmedMode,
        confirmedBy: String(operator || ''),
        confirmedAt,
        batchId: batch.id,
        groupKey: String(groupKey).trim(),
      })).catch((error) => {
        // 静默失败审计 2026-07-12:审计流水断档原先无痕(8 行后的 sendback 早修过同病)
        logger?.warn?.('tour_confirm_log_append_failed', {
          batchId: batch.id, groupKey: String(groupKey).trim(),
          error: String(error?.message || error),
        });
      });
    }

    // 时效模式(发12/17/18号、S活动)→ 入回发队列(P3;确认即触发,不等审核)。
    const action = sendbackActionOfMode(confirmedMode);
    if (action && sendbackQueueRepo?.enqueue) {
      // advisory:enqueue 返回 Promise,.catch 兜 rejection(裸 try/catch 接不住)。
      // V2 Task7 改可观测:失败进 retry 环 + 日志可 grep sendback_enqueue_failed,不再静默吞
      // (看板缺条目 → 查日志 → getSendbackRetryItems 补齐)。
      Promise.resolve().then(() => sendbackQueueRepo.enqueue({
        batchId: batch.id,
        groupKey: String(groupKey).trim(),
        workspaceKey: String(batch.monthlyWorkspaceKey || ''),
        action,
        mode: confirmedMode,
        tourNo: value,
        createdAt: confirmedAt,
        createdBy: String(operator || ''),
      })).catch((error) => recordSendbackFailure(error, {
        batchId: batch.id,
        groupKey: String(groupKey).trim(),
        action,
      }));
    }

    return {
      tourConfirm: { ...tourConfirm, revisions: undefined },
      lane: laneOfMode(confirmedMode, { slimModes: parseSlimModes(slimModesEnv()) }),
      backfilledTaskIds: backfilled,
      exceptions,
      sendbackAction: action || '',
    };
  }

  // ── 撤销(未结算)───────────────────────────────────────────────────────
  function unconfirmTour(batch, groupKey, { operator = null, reason = '' } = {}) {
    const tasks = groupTasksOf(batch, groupKey);
    const group = (batch.sourceGroups || []).find((g) => String(g?.key || '').trim() === String(groupKey).trim());
    const previous = normalizeTourConfirm(group?.tourConfirm);
    if (!previous || !previous.status) {
      throw new AppError('该组没有可撤销的团号确认', { status: 409, code: 'TOUR_NOT_CONFIRMED' });
    }
    // 已结算的组不许在这撤(动台账,高危;走人工SOP+月度对账——用户拍板)。
    if (String(group?.settlementStatus || '') === 'settled') {
      throw new AppError('该组已结算,不能在确认站撤销;请走人工更正流程', { status: 409, code: 'GROUP_ALREADY_SETTLED' });
    }

    const slimModes = parseSlimModes(slimModesEnv());
    const wasSlim = laneOfMode(previous.mode, { slimModes }) === 'slim';
    const receipts = tasks.filter((t) => docTypeOf(t) === DOC_TYPES.RECEIPT);
    let reviewCleared = 0;
    for (const t of receipts) {
      t.tourConfirmedAt = ''; // 收回车道资格凭据 → fail-safe 全审
      if (wasSlim && t.reviewed) {
        // 安全绳:曾按"不用记"免审过的票,确认被撤销 = 没人真正看过 → 强制回炉。
        t.reviewed = false;
        t.reviewedAt = '';
        reviewCleared += 1;
      }
    }
    stampGroupTourConfirm(batch, groupKey, {
      status: '',
      revisions: [], // stamp 内部会把 previous 推进 revisions
      basis: reason ? { unconfirmReason: String(reason) } : null,
      confirmedBy: String(operator || ''),
      confirmedAt: now(),
    });
    return { previous: { ...previous, revisions: undefined }, wasSlim, reviewCleared };
  }

  // ── 硬闸(P2,ENV 默认关)────────────────────────────────────────────────
  function requireConfirmEnabled() {
    return String(requireConfirmEnv() || '').toLowerCase() === 'true';
  }

  // 通过/结算前调用:硬闸开着且组非豁免且未确认 → 409。浏览/编辑/补图不经这里,永不拦。
  function assertTourConfirmed(batch, groupKey) {
    if (!requireConfirmEnabled()) return;
    const tasks = groupTasksOf(batch, groupKey);
    if (!tasks.length) return;
    if (exemptOf(tasks).isExempt) return;
    const group = (batch.sourceGroups || []).find((g) => String(g?.key || '').trim() === String(groupKey).trim());
    const tc = normalizeTourConfirm(group?.tourConfirm);
    const ok = tc && ['confirmed', 'exempt', 'pending_table'].includes(tc.status);
    if (!ok) {
      throw new AppError('本组团号还没确认,先到「团号确认」确认后再通过/结算', {
        status: 409, code: 'TOUR_UNCONFIRMED',
      });
    }
  }

  return {
    buildCandidates,
    probeTour,
    confirmTour,
    unconfirmTour,
    assertTourConfirmed,
    requireConfirmEnabled,
    getSendbackRetryItems: () => [...sendbackRetryItems],
    laneOfMode: (mode) => laneOfMode(mode, { slimModes: parseSlimModes(slimModesEnv()) }),
  };
}

module.exports = { createTourConfirmService };
