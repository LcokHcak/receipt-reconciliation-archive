'use strict';

/**
 * workbench_ledger_bridge_service — 审核台 → 月度 receipt_ledger 桥接。
 *
 * 触发：审核台"客户组通过"成功后，把该组所有 task 转成 daily_receipt_export 行
 * (source_type='workbench')，写入当月工作区。
 *
 * 字段映射（审核台 → daily_receipt_export）：
 *   extractedNameFinal → name (英文姓名)
 *   chineseNameFinal   → remark (保留中文名)
 *   passportNoFinal    → passport_no
 *   receiptStoreFinal  → shop
 *   receiptNoFinal     → receipt_no
 *   groupNoFinal       → tour_no
 *   purchaseDateFinal  → purchase_date
 *   departureDateFinal → departure_date
 *
 * 幂等：UNIQUE(workspace_key, row_hash)，同一 task 多次通过不会重复写。
 */

const { computeDailyRowHash } = require('../lib/monthly/daily_row_hash');
const { normalizeGroupNo } = require('../lib/workbench_field_normalizer');
const { formatReceiptNoForMode, resolveTaskModeRule } = require('../lib/workbench_receipt_export');
const {
  normalizeWorkspaceKey,
  resolveOptionalWorkspaceForPurchaseDate,
} = require('../lib/monthly/workspace_resolver');
const { BadRequestError } = require('../lib/errors');
const { DOC_TYPES } = require('../lib/package_constants');
const { normalizeReceiptNoDigits, normalizeReceiptNo } = require('../lib/workbench_field_normalizer');
const { getStoreProfile, FAMILY, formatDeptBranch } = require('../lib/store_profiles');
const { normalizeStoreFamily } = require('../lib/validation/field_rules');
const { findDeptPassportDonor } = require('../lib/validation/group_passport_rule');

// ── 台账小票号口径(单一真相;存量回填脚本 scripts/oneoff/backfill_receipt_no_letters.js 同源)──
// 铁律:存储路径禁数字化投影(2026-07-10 字段清洗审计)。三条路:
//   ① 百货:交易编号原样保留(2026-07-14 审计#1;哈希投影由 dailyRowHashOf 按 shop 判定,不在这)
//   ② 模式已知且有票号形态:按交付合同 formatReceiptNoForMode
//      (digits13/14 剥杠纯数字、letters14 保字母、dashed19 保杠,与交付包/Excel 出口同口径)
//   ③ 兜底(未命中模式):2026-07-20 五问题#5修①——旧版落 normalizeReceiptNoDigits,
//      济州乐天V的 G、现代/新世界的杠被剥没;改走 normalizeReceiptNo(保字母保杠,
//      只去空格/点/标签前缀,与审核台存储同口径)。hashProjection='digits' 标记该路径的
//      **去重哈希仍用数字投影**(哈希≠存储):与修复前已入库的兜底行(存的就是纯数字,
//      哈希=数字串)兼容,重结算不产生重复行。
function computeLedgerReceiptNo(task) {
  const clean = (v) => (v == null ? '' : String(v).trim());
  const pick = (finalKey, autoKey) => clean(task?.[finalKey]) || clean(task?.[autoKey]);
  const raw = pick('receiptNoFinal', 'receiptNoAuto');
  const storeProfile = getStoreProfile(normalizeStoreFamily(pick('receiptStoreFinal', 'receiptStoreAuto')));
  if (storeProfile.family === FAMILY.DEPT) {
    return { receiptNo: clean(raw), hashProjection: null };
  }
  // 模式解析走任务级单源 resolveTaskModeRule(行为三合一):人选模式(modeManualPick)/
  // 机场推断(团号「无」或表态none)也吃到各自模式的票号形态——此前只认 modeRawPre 快照,
  // 人选/机场行跌到兜底原样,与交付包/审核台导出的格式化产物分家。
  const { rule, source } = resolveTaskModeRule(task);
  if (rule?.known && rule.receiptNoForm) {
    // ⭐哈希投影按来源分流:pick/airport 是 2026-07-20 才进格式化路径的类别——它们的存量行
    // 修改前走兜底(存原样,哈希=数字投影),格式化串直接当哈希会让重结算去重失配产重复行;
    // 数字投影对格式化前后同数字核恒等,新旧行哈希一致。snapshot(matched 老路径)口径不动。
    const newlyFormatted = source === 'pick' || source === 'airport';
    return { receiptNo: formatReceiptNoForMode(task, rule), hashProjection: newlyFormatted ? 'digits' : null };
  }
  return { receiptNo: normalizeReceiptNo(raw), hashProjection: 'digits' };
}

function createWorkbenchLedgerBridgeService({
  dailyReceiptRepo,
  userService,
  workspaceService,
  // 派生新鲜度:桥接是「生产台账」的来源,新小票进台账后,该月派生(匹配→合并→导出)
  // 已过期,标脏 tour_match 让进核对页/出包时自动重算。recompute 服务构造晚于本服务,
  // 经 setter 后注入(同 setLedgerBridgeService 模式);未注入则跳过,纯桥接行为不变。
  derivationRecomputeService = null,
  logger = console,
}) {
  if (!dailyReceiptRepo) throw new Error('dailyReceiptRepo required');
  let recomputeService = derivationRecomputeService;

  function normalize(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  function pickReceiptField(task, finalKey, autoKey) {
    const final = normalize(task[finalKey]);
    if (final) return final;
    return normalize(task[autoKey]);
  }

  // 团号归一委托中央 normalizeGroupNo(保字母团号 26V00041/R2299001、剥标签前缀、"无"识别)。
  // ⚠️2026-07-10 生产病例:这里曾是 replace(/\D/g,'') 的老副本——审核员手填 26V00041,
  // 结算写台账被剥成 2600041,终匹配永远未命中且"字母看起来消失了"。与 07-06 票号回弹 bug
  // 同病理:中央归一修了、这份副本漏了。改校验先 grep 全库副本(结算事故铁律)。
  // 机场票"无"在台账口径落空串(与旧行为一致,不当团号参与匹配)。
  function normalizeTourNo(value) {
    const normalized = normalizeGroupNo(value);
    return normalized === '无' ? '' : normalized;
  }

  function isReceiptTask(task) {
    const docType = normalize(task?.docTypeFinal || task?.docTypeAuto).toLowerCase();
    return docType === DOC_TYPES.RECEIPT;
  }

  function resolveWorkspaceKey(explicitKey = null) {
    return normalizeWorkspaceKey(explicitKey);
  }

  function resolveTargetWorkspace({ purchaseDate, requestedKey }) {
    return resolveOptionalWorkspaceForPurchaseDate({
      purchaseDate,
      currentWorkspaceKey: requestedKey,
    });
  }

  function describeReceiptTask(task, purchaseDate) {
    const parts = [];
    const group = normalize(task.sourceGroupLabel || task.sourceGroupKey);
    const taskId = normalize(task.id);
    const receiptNo = normalizeReceiptNoDigits(pickReceiptField(task, 'receiptNoFinal', 'receiptNoAuto'));
    const fileName = normalize(task.fileName || task.originalFileName);
    if (group) parts.push(`客户组 ${group}`);
    if (taskId) parts.push(taskId.startsWith('task_') ? taskId : `task ${taskId}`);
    if (receiptNo) parts.push(`小票号 ${receiptNo}`);
    if (fileName) parts.push(`文件 ${fileName}`);
    parts.push(`purchaseDate ${purchaseDate || '(空)'}`);
    return parts.join(' / ');
  }

  function wrapPurchaseDateError(error, { task, purchaseDate }) {
    if (error?.code !== 'purchase_date_out_of_range' && error?.code !== 'invalid_purchase_date') {
      throw error;
    }
    const wrapped = new BadRequestError(`${describeReceiptTask(task, purchaseDate)} 超范围`, {
      code: error.code,
      cause: error,
    });
    // 结构化定位信息:供前端把这条错误渲染成"跳到该图"的链接(message 仍是人读文本,向后兼容)。
    wrapped.details = {
      taskId: normalize(task.id) || null,
      groupKey: normalize(task.sourceGroupKey || task.sourceFolderPath || task.sourceGroupLabel) || null,
      groupLabel: normalize(task.sourceGroupLabel || task.sourceGroupKey) || null,
      fileName: normalize(task.fileName || task.originalFileName) || null,
      purchaseDate: purchaseDate || null,
      reason: error.code,
    };
    throw wrapped;
  }

  async function ensureWorkspace(workspaceKey, operator) {
    if (!workspaceService) return;
    try {
      workspaceService.getOrThrow(workspaceKey);
    } catch (_e) {
      workspaceService.open({ workspaceKey, operator: operator || 'workbench_bridge' });
    }
  }

  async function resolveAgent(operator) {
    if (!operator || !userService) return { agentId: null, agentCode: null };
    try {
      const users = await userService.listUsers();
      const user = users.find((u) => u.username === operator);
      if (!user) return { agentId: null, agentCode: null };
      return {
        agentId: user.id,
        agentCode: user.agent_code || null,
      };
    } catch (err) {
      // 0729 静默排查:原来是空 catch,把两件完全不同的事压成同一个返回值——
      //   ① 查不到这个操作员(数据问题,合法态,下游会走 agent 文本匹配兜底)
      //   ② 用户服务本身挂了(临时故障)
      // 第 ② 种下,这一行台账的代理归属是空的,而它是**带钱的结算行**;
      // 下游收票汇总只会把它计进「未分配行数」,没人知道那是一次服务故障造成的。
      // 不阻断结算(代理归属可事后补),但必须留下可追的痕迹:
      // 「未分配」数字异常升高时,能查到是这里挂过,而不是去怀疑代理没填对。
      // 写法对齐本文件既有风格(logger 默认是 console,别传结构化对象进去)
      logger?.error?.(`[ledger_bridge] resolveAgent(${operator}) failed → 台账行将没有代理归属: ${err?.message || err}`);
      return { agentId: null, agentCode: null };
    }
  }

  function taskToLedgerRow({ task, groupTasks, workspaceKey, batchId, agentId, agentCode, operator, receiptDate }) {
    const passportTask = (groupTasks || []).find((t) => {
      const dt = normalize(t?.docTypeFinal || t?.docTypeAuto).toLowerCase();
      return dt === DOC_TYPES.PASSPORT;
    });
    const passportChineseName = passportTask
      ? normalize(passportTask.chineseNameFinal || passportTask.chineseNameAuto)
      : '';
    const passportExtractedName = passportTask
      ? normalize(passportTask.extractedNameFinal || passportTask.extractedNameAuto)
      : '';
    const passportNoFromPassport = passportTask
      ? normalize(passportTask.passportNoFinal || passportTask.passportNoAuto)
      : '';
    // 百货同框护照跨票传播(2026-07-13,修 reviewer HIGH):无独立护照任务时,身份可能
    // 只落在组内另一张百货小票上(这张没读到护照角)。找"身份捐赠者"作最后兜底,
    // 与护照数量闸门"组内有一张即合格"口径对齐,防兄弟票静默落库空身份。
    // 有独立护照任务时(免税店常态)不借位——护照任务才是权威身份源。
    const donor = passportTask ? null : findDeptPassportDonor(groupTasks, task);
    const donorChineseName = donor ? normalize(donor.chineseNameFinal || donor.chineseNameAuto) : '';
    const donorExtractedName = donor ? normalize(donor.extractedNameFinal || donor.extractedNameAuto) : '';
    const donorPassportNo = donor ? normalize(donor.passportNoFinal || donor.passportNoAuto) : '';
    const chineseName = normalize(
      passportChineseName || task.chineseNameFinal || task.chineseNameAuto
    ) || donorChineseName;
    const extractedName = normalize(
      passportExtractedName || task.extractedNameFinal || task.extractedNameAuto
    ) || donorExtractedName;
    const passportNo = normalize(
      passportNoFromPassport || task.passportNoFinal || task.passportNoAuto
    ) || donorPassportNo;

    const shop = pickReceiptField(task, 'receiptStoreFinal', 'receiptStoreAuto');
    // 百货(P4):无团号,模式=档案常量;真字段落正列(金额→gross_krw 总卖出￦);
    // tourMatchStatus 直接 matched——百货行不进团号匹配队列(否则 tour_match 会把
    // 空团号行的模式清空,常量白注入)。免税店 profile.family!==DEPT 走原路零回归。
    const storeProfile = getStoreProfile(normalizeStoreFamily(shop));
    const isDept = storeProfile.family === FAMILY.DEPT;
    const deptAmountText = isDept
      ? String(pickReceiptField(task, 'receiptAmountFinal', 'receiptAmountAuto') || '').replace(/\D/g, '')
      : '';

    // 票号台账口径=模块级 computeLedgerReceiptNo 单一真相(百货原样/模式合同/兜底保字母保杠),
    // 细节见函数头注释。2026-07-20 五问题#5修①:兜底不再数字投影(丢G/丢杠),存储保原串;
    // receiptNoHashProjection 只喂 dailyRowHashOf(去重哈希),不是列——insertMany 按列白名单落库自动忽略。
    const { receiptNo, hashProjection: receiptNoHashProjection } = computeLedgerReceiptNo(task);
    const tourNo = normalizeTourNo(pickReceiptField(task, 'groupNoFinal', 'groupNoAuto'));
    const purchaseDate = pickReceiptField(task, 'purchaseDateFinal', 'purchaseDateAuto');
    const departureDate = pickReceiptField(task, 'departureDateFinal', 'departureDateAuto');
    const customerAgent = normalize(
      task.customerAgentName
      || task.sourceGroupLabel
      || task.sourceFolderName
      || task.sourceFolderPath
    );

    const nowIso = new Date().toISOString();
    const row = {
      workspaceKey,
      sourceCustomerId: normalize(task.sourceGroupKey || task.sourceGroupLabel),
      shop: shop || null,
      agent: customerAgent || null,
      purchaseDate: purchaseDate || null,
      tourNo: tourNo || null,
      name: extractedName || null,
      passportNo: passportNo || null,
      departureDate: departureDate || null,
      receiptNo: receiptNo || null,
      modeRaw: isDept ? storeProfile.mode : null,
      modeFolder: null,
      // 门店记"明洞(0001)"(2026-07-13 用户拍板:店名+码都留);存储值仍是原始码,这里只格式化输出列。
      branch: isDept ? (formatDeptBranch(normalizeStoreFamily(shop), pickReceiptField(task, 'branchFinal', 'branchAuto')) || null) : null,
      upstream: isDept ? (pickReceiptField(task, 'upstreamFinal', 'upstreamAuto') || null) : null,
      brand: isDept ? (pickReceiptField(task, 'brandFinal', 'brandAuto') || null) : null,
      grossKrw: isDept && deptAmountText ? Number(deptAmountText) : null,
      billMatchStatus: 'unmatched',
      tourMatchStatus: isDept ? 'matched' : 'pending',
      sourceFile: task.fileName || task.originalFileName || null,
      sourceSheet: 'workbench',
      sourceRow: null,
      rawPayload: null,
      importedAt: nowIso,
      importJobId: null,
      receiptDate: receiptDate,
      agentId: agentId || null,
      agentCode: agentCode || null,
      sourceType: 'workbench',
      sourceBatchId: batchId || null,
      sourceTaskId: normalize(task.id) || null,
      modifiedBy: operator || null,
      ledgerStatus: 'posted',
      postedAt: nowIso,
      postedBy: operator || null,
      remark: chineseName || null,
    };
    // 非列辅助字段:兜底路径去重哈希的数字投影标记(哈希≠存储;insertMany 列白名单不落库)
    row.receiptNoHashProjection = receiptNoHashProjection;
    row.rowHash = dailyRowHashOf(row);
    return row;
  }

  // 去重哈希(2026-07-14 审计#1 配套):百货行 receipt_no 存储改为原样保杠后,哈希继续用
  // **数字投影**——与修复前已入库的百货行(存的就是纯数字)哈希兼容,重结算不产生重复行。
  // 2026-07-20 五问题#5修①配套:未命中模式的兜底行存储改保字母保杠后,同理也走数字投影
  // (receiptNoHashProjection='digits',由 computeLedgerReceiptNo 标记)——与修复前存纯数字的
  // 兜底行哈希兼容。已知模式行(letters14/dashed19/digits*)哈希口径不变(按存储值),
  // 不动存量去重。比较投影合规;存储列才禁数字化(lib/monthly/daily_row_hash 本身零改动)。
  function dailyRowHashOf(row) {
    const profile = getStoreProfile(normalizeStoreFamily(row.shop));
    if (profile.family === FAMILY.DEPT && row.receiptNo) {
      return computeDailyRowHash({ ...row, receiptNo: normalizeReceiptNoDigits(row.receiptNo) });
    }
    if (row.receiptNoHashProjection === 'digits' && row.receiptNo) {
      return computeDailyRowHash({ ...row, receiptNo: normalizeReceiptNoDigits(row.receiptNo) });
    }
    return computeDailyRowHash(row);
  }

  // 结算前购买日期预检(2026-07-14 审计#9):syncApprovedGroup 的日期落月解析会 throw
  // (BadRequestError),而流式结算在它之前已完成不可逆的 approve+出包定稿——炸在写台账
  // 这步=组定稿了台账 0 行。结算方先调本预检,坏日期在任何不可逆动作前拦下,不 throw。
  function precheckPurchaseDates({ groupTasks, workspaceKey = null }) {
    const tasks = Array.isArray(groupTasks) ? groupTasks : [];
    for (const task of tasks.filter((t) => isReceiptTask(t))) {
      const purchaseDate = pickReceiptField(task, 'purchaseDateFinal', 'purchaseDateAuto');
      try {
        resolveTargetWorkspace({ purchaseDate, requestedKey: workspaceKey || null });
      } catch (error) {
        try {
          wrapPurchaseDateError(error, { task, purchaseDate });
        } catch (wrapped) {
          // 只把日期类错误转结构化返回;其它异常原样上抛(复审 MEDIUM:与真写库路径同口径,
          // 别把无关故障错贴成"核对日期"误导操作员)。
          if (wrapped?.code === 'purchase_date_out_of_range' || wrapped?.code === 'invalid_purchase_date') {
            return { ok: false, error: wrapped.message, code: wrapped.code, details: wrapped.details || null };
          }
          throw wrapped;
        }
      }
    }
    return { ok: true };
  }

  // deleteIdsByWorkspace:[{workspaceKey, ids}] —— 结算前应清掉的本组旧未匹配台账行(由 service 端
  // computeDeletableIdsByWorkspace 预算,含 F6/非业务键锁保护过滤)。L180:删旧与写新在 repo 的
  // settleGroupAtomic 里同一事务执行,原子——不再由 service 先删后靠内存快照补插回滚。
  async function syncApprovedGroup({ groupTasks, batchId, operator, workspaceKey = null, deleteIdsByWorkspace = [] }) {
    const tasks = Array.isArray(groupTasks) ? groupTasks : [];
    if (tasks.length === 0) {
      return { inserted: 0, skipped: 0, workspaceKey: null, agent: null, skippedReason: 'no_tasks' };
    }

    const receiptTasks = tasks.filter((t) => isReceiptTask(t));
    if (receiptTasks.length === 0) {
      // 整组只有护照没小票（罕见）— 没有东西可以入台账
      return { inserted: 0, skipped: 0, workspaceKey: null, agent: null, skippedReason: 'no_receipt_tasks' };
    }

    const bucketEntries = receiptTasks.map((task) => {
      const purchaseDate = pickReceiptField(task, 'purchaseDateFinal', 'purchaseDateAuto');
      try {
        return {
          task,
          ...resolveTargetWorkspace({ purchaseDate, requestedKey: workspaceKey }),
        };
      } catch (error) {
        wrapPurchaseDateError(error, { task, purchaseDate });
      }
      return null;
    });

    const agent = await resolveAgent(operator);
    const today = new Date().toISOString().slice(0, 10);
    const buckets = new Map();
    for (const entry of bucketEntries) {
      if (!buckets.has(entry.workspaceKey)) buckets.set(entry.workspaceKey, []);
      buckets.get(entry.workspaceKey).push(entry);
    }

    let inserted = 0;
    let skipped = 0;
    let removed = 0;
    const affectedWorkspaces = Array.from(buckets.keys());
    try {
      // ① 先 ensureWorkspace 所有插入桶并构建待插行(注册月度工作区是幂等操作,须在原子事务之外
      //    完成——事务里做 DDL/注册会自成事务或破坏 savepoint 嵌套)。
      const insertBuckets = [];
      for (const [targetWorkspaceKey, entries] of buckets) {
        await ensureWorkspace(targetWorkspaceKey, operator);
        const rows = entries.map((entry) => {
          const row = taskToLedgerRow({
            task: entry.task,
            groupTasks: tasks,
            workspaceKey: targetWorkspaceKey,
            batchId,
            agentId: agent.agentId,
            agentCode: agent.agentCode,
            operator,
            receiptDate: today,
          });
          row.purchaseDate = entry.purchaseDate;
          if (!entry.hasPurchaseDate) {
            row.tourMatchStatus = 'date_missing';
          }
          row.rowHash = dailyRowHashOf(row);
          return row;
        });
        insertBuckets.push({ workspaceKey: targetWorkspaceKey, rows });
      }

      // ② 删旧 + 写新:优先走 repo 的原子复合 op(同一事务,L180)。
      const deletes = Array.isArray(deleteIdsByWorkspace) ? deleteIdsByWorkspace : [];
      if (typeof dailyReceiptRepo.settleGroupAtomic === 'function') {
        // L180:删旧未匹配台账行 + 写新台账行放进同一事务——进程崩溃/某桶抛错整体回滚,
        // 旧行不丢、新行不半写(替代此前 service 端"删+内存快照+失败补插"的非原子链;
        // 且事务回滚会一并撤销级联删的 error_record/pending_review,补插方案则补不回来)。
        const atomic = dailyReceiptRepo.settleGroupAtomic({ deletes, insertBuckets });
        removed = Number(atomic.removed || 0);
        inserted = Number(atomic.inserted || 0);
        skipped = Number(atomic.skipped || 0);
        logger?.log?.(`[ledger_bridge] batch=${batchId} atomic removed=${removed} inserted=${inserted} skipped=${skipped} workspaces=${affectedWorkspaces.join('|') || '-'}`);
      } else {
        // 兼容不支持原子 op 的 repo(仅测试桩):退回逐桶 insertMany(不做删除,deletes 忽略)。
        for (const bucket of insertBuckets) {
          const result = dailyReceiptRepo.insertMany(bucket.rows);
          inserted += Number(result.inserted || 0);
          skipped += Number(result.skipped || 0);
          logger?.log?.(`[ledger_bridge] batch=${batchId} inserted=${result.inserted} skipped=${result.skipped} workspace=${bucket.workspaceKey}`);
        }
      }

      // ③ 有新台账进库 → 受影响月份派生过期,标脏 tour_match(导出会自动跟最新台账重算)
      if (inserted > 0 && recomputeService) {
        for (const ws of affectedWorkspaces) {
          try { recomputeService.markDirty(ws, 'tour_match'); } catch (markErr) {
            // 标记失败不阻断桥接,但必须留痕(2026-07-14 审计中危):曾裸吞——月度派生
            // 不知已过期,新结算客户可能悄悄漏出后续 monthly_data/交付包,无从排查。
            logger?.error?.(`[ledger_bridge] markDirty(${ws}, tour_match) failed: ${markErr?.message || markErr}`);
          }
        }
      }
      return {
        removed,
        inserted,
        skipped,
        workspaceKey: affectedWorkspaces[0] || null,
        affectedWorkspaces,
        agent,
      };
    } catch (error) {
      logger?.error?.('[ledger_bridge] syncApprovedGroup failed', error);
      // settleGroupAtomic 抛错=整事务回滚,删旧一并撤销、旧行不丢——调用方无需再回滚(M5 快照退役)。
      return {
        removed: 0,
        inserted: 0,
        skipped: receiptTasks.length,
        workspaceKey: affectedWorkspaces[0] || null,
        affectedWorkspaces,
        agent,
        error: error?.message || String(error),
      };
    }
  }

  return {
    syncApprovedGroup,
    precheckPurchaseDates,
    setDerivationRecomputeService(svc) { recomputeService = svc || null; },
    _resolveWorkspaceKey: resolveWorkspaceKey,
    _resolveTargetWorkspace: resolveTargetWorkspace,
    _taskToLedgerRow: taskToLedgerRow,
  };
}

module.exports = {
  createWorkbenchLedgerBridgeService,
  // 台账小票号口径单一真相(存量回填脚本/回归测试同源,防副本漂移)
  computeLedgerReceiptNo,
};
