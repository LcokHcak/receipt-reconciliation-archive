'use strict';

/**
 * agent_unreceived_service — 代理视图 B 页「未收客户组」读模型(P2+P3,2026-07-16/17)。
 *
 * 口径红线:未收判定**完全复用** customer_reconciliation_service.listUnreceived
 * (账单 sale ⟂ 台账在场,normalizeString 归一,resolution 落库过滤,group_code 补代理)
 * ——与未收清单页/交付包 5_未收/核对页同源,不发明第二套对账。
 * 本服务做的事:①盖 first_seen 锚(超7天红起算,拍板③) ②按 护照+团号 归并成客户组、
 * 按代理分桶(查无代理→「未归属」,拍板②) ③状态派生+xlsx 导出
 * ④(P3)在途判定/已建档深链/未收 workflow_task 生命周期/「无需补」灰行留痕。
 *
 * 状态五档(拍板④+mockup 人工态):
 *   received  组内全部票已进台账(变灰)         —— 只显示曾未收过的行(state 有锚)
 *   waived    未收票全部人工标「无需补」(变灰留痕) —— resolution 表 action='waive',
 *             与老未收清单页 link/delay/void 同一张人工标记表,不建第二套
 *   overdue   有票既没收到、又没在途、也没豁免,first_seen+7天 仍未齐(红)
 *   partial   部分票已进台账,或图已收还在审(护照/票号能在工作台镜像里找到=在途)
 *   pending   全部未收、未超期(黄)
 *
 * 任务(核心设计原则3):每个未收客户组一条 workflow_task(task_type=unreceived_followup,
 * due=组内最早 first_seen+7天,超期红由任务体系自带 overdue 判定);收齐(含在途)自动完成,
 * 全豁免自动取消,组重新出现未收票 → 带版本号重建(照 send_upstream correction 手法)。
 */
const ExcelJS = require('exceljs');

const { applyExcelStyle } = require('../../lib/excel_style');
const { normalizeString } = require('../../lib/monthly_pipeline/matching/field_diff');
const { normalizeAgentName } = require('../../lib/agent_workspace/customer_projection');
const { unreceivedItemKey } = require('./customer_reconciliation_service');
const { ConflictError } = require('../../lib/errors');

const OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;
const UNASSIGNED_KEY = '__unassigned__';
const UNASSIGNED_LABEL = '未归属';
const UNRECEIVED_TASK_TYPE = 'unreceived_followup';

// 《未收清单.xlsx》用户模板 9 列(2026-07-16 拍板)+ 末尾追加出账日期(2026-07-21
// SMG总账;追加不插中间,前 9 列列位不动,代理催收的看表习惯零扰动;
// 只有总账来源的行有值,店家账单来源为空)
const EXPORT_COLUMNS = Object.freeze([
  { header: '返点模式', key: 'mode', width: 14 },
  { header: '免税分店', key: 'storeBranch', width: 16 },
  { header: '代理', key: 'agent', width: 12 },
  { header: '购买日期', key: 'purchaseDate', width: 12 },
  { header: '团号', key: 'tourNo', width: 14 },
  { header: '姓名', key: 'name', width: 18 },
  { header: '护照号', key: 'passportNo', width: 16 },
  { header: '小票号', key: 'receiptNo', width: 20 },
  { header: '品牌', key: 'brand', width: 14 },
  { header: '出账日期', key: 'statementDate', width: 12 },
]);

// sheet 名清洗(照资料库 library_mode_export 手法:去 xlsx 非法字符+31 字上限+撞名加序号)
function sanitizeSheetName(name, used) {
  const base = (String(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28)) || '空';
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}~${i++}`.slice(0, 31);
  used.add(candidate);
  return candidate;
}

function fmtDate(value) {
  if (!value) return '';
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function createAgentUnreceivedService({
  customerReconciliationService,
  unreceivedStateRepo,
  unreceivedResolutionRepo = null,
  workflowTaskRepository = null,
  monthlyWorkspaceService = null,
  importJobRepo = null,
  now = () => new Date().toISOString(),
  logger = console,
}) {
  if (!customerReconciliationService) throw new Error('agent_unreceived_service: customerReconciliationService required');
  if (!unreceivedStateRepo) throw new Error('agent_unreceived_service: unreceivedStateRepo required');

  // SMG总账替换窗口隔离(审计 MEDIUM):导入先 deleteByJobType 清28万旧行→流式分批插新行
  // (分钟级),窗口内 store_bill 只剩店家账单行、总账未收暂缺。此刻:①导出 = 残缺催收清单
  // 发给代理;②buildView 的任务同步会把"看着收齐"的组误判 complete。检测本工作区是否有
  // running(<2h 非僵尸,照 import_service 并发守卫口径)的 smg_ledger 导入。未注入 importJobRepo
  // = 恒 false(老装配/测试不传也不改行为)。
  function isSmgImporting(workspaceKey) {
    if (!importJobRepo || typeof importJobRepo.listByWorkspace !== 'function') return false;
    const nowMs = Date.parse(now());
    return importJobRepo.listByWorkspace({ workspaceKey, jobType: 'smg_ledger', limit: 50 })
      .some((j) => j.status === 'running'
        && Number.isFinite(Date.parse(j.startedAt))
        && (!Number.isFinite(nowMs) || (nowMs - Date.parse(j.startedAt)) < 2 * 60 * 60 * 1000));
  }

  // 在途查找(晚绑定:passport_record/receipt_record 在 workbench.sqlite,server 装配后注入)。
  // ({passportNos:Set<归一>, receiptNos:Set<归一>}) =>
  //   { passports: Map<归一护照, {batchId, groupKey}>, receipts: Set<归一票号> }
  // 未注入/失败 = 空结果,在途判定退化为"只认台账",不炸。
  let inFlightLookup = null;
  function setInFlightLookup(fn) {
    inFlightLookup = typeof fn === 'function' ? fn : null;
  }

  function listWorkspaces() {
    if (!monthlyWorkspaceService) return [];
    const rows = monthlyWorkspaceService.list ? monthlyWorkspaceService.list() : [];
    return (rows || []).map((w) => w.workspaceKey || w.workspace_key).filter(Boolean);
  }

  // 对账+盖锚:取含已收/已处理标记的全量行。
  //   - 非 waive 的 resolution 行(link/delay/void)照旧不进 B 页(老页已处理掉);
  //   - waive 行保留展示(灰+留痕),不盖锚不算未收;
  //   - 已收行只保留"曾未收过"的(state 有锚);
  //   - 当前真未收的行补盖 first_seen(已有的不重置)。
  function reconcile(workspaceKey) {
    const all = customerReconciliationService.listUnreceived(workspaceKey, {
      includeReceived: true,
      includeResolved: true,
    });
    const nowIso = now();
    const firstSeenByKey = unreceivedStateRepo.mapByWorkspace(workspaceKey);
    const kept = [];
    const missingKeys = [];
    for (const r of all) {
      const key = unreceivedItemKey({ passportNo: r.passport_no, name: r.name, receiptNo: r.receipt_no });
      const resolution = r.resolution || null;
      if (resolution && resolution.action !== 'waive') continue; // 老页已处理,B 页不管
      if (!r.received && !resolution && !firstSeenByKey.has(key)) missingKeys.push(key);
      if (r.received && !firstSeenByKey.has(key) && !resolution) continue; // 从没未收过→不进 B 页
      kept.push({ raw: r, key, resolution });
    }
    if (missingKeys.length) {
      unreceivedStateRepo.ensureFirstSeen(workspaceKey, missingKeys, nowIso);
      for (const key of missingKeys) firstSeenByKey.set(key, nowIso);
    }
    return { kept, firstSeenByKey, nowIso };
  }

  function groupKeyOf({ passportNo, name, tourNo }) {
    const person = normalizeString(passportNo) || `n:${normalizeString(name)}`;
    return `${person}|${normalizeString(tourNo)}`;
  }

  // 组状态:全收→received;未收全豁免→waived;有"没收到+没在途+没豁免"且超7天→overdue;
  // 有任何进展(台账/在途)→partial;否则 pending。
  function statusOfGroup(rows, nowMs) {
    const unreceived = rows.filter((r) => !r.received);
    if (!unreceived.length) return 'received';
    const outstanding = unreceived.filter((r) => !r.waived && !r.inFlight);
    if (!outstanding.length && unreceived.every((r) => r.waived)) return 'waived';
    if (outstanding.some((r) => r.firstSeenAt && (Date.parse(r.firstSeenAt) + OVERDUE_MS) < nowMs)) return 'overdue';
    if (rows.some((r) => r.received || r.inFlight)) return 'partial';
    return 'pending';
  }

  function matchesSearch(group, term) {
    if (!term) return true;
    const t = normalizeString(term);
    if (!t) return true;
    const hay = [group.name, group.passportNo, group.tourNo, ...group.rows.map((r) => r.receiptNo)];
    return hay.some((v) => normalizeString(v).includes(t));
  }

  // ── P3:未收任务生命周期(每组一条,幂等键+版本号照 send_upstream 手法)──
  function syncGroupTasks(workspaceKey, groups, nowIso) {
    if (!workflowTaskRepository) return;
    try {
      for (const g of groups) {
        // 催收未完 = 存在"没收到+没在途+没豁免"的票
        const outstanding = g.rows.some((r) => !r.received && !r.inFlight && !r.waived);
        // 逐组点查(复核 HIGH#2):repo.list 有 500 硬顶且按创建时间倒序——大工作区(>500 pending)
        // 时最早创建、最该关注的任务会掉出窗口,收齐/豁免分支永远打不中 → 任务永久卡 pending。
        // findPendingByScope 是精确点查,无上限陷阱。
        const existing = workflowTaskRepository.findPendingByScope({
          workspaceKey, customerId: '', batchId: '', groupKey: g.groupKey, taskType: UNRECEIVED_TASK_TYPE,
        });
        if (outstanding && !existing) {
          // 历史版本数(done/cancelled)→ 组"补齐后又冒出未收票"时带版本重建,不与审计终态撞键
          const { settled } = workflowTaskRepository.countByScope({
            workspaceKey, customerId: '', batchId: '', groupKey: g.groupKey, taskType: UNRECEIVED_TASK_TYPE,
          });
          const baseKey = `unreceived:${workspaceKey}:${g.groupKey}`;
          const dueBase = g.firstSeenAt || nowIso;
          workflowTaskRepository.createExpected({
            taskKey: settled > 0 ? `${baseKey}:v${settled + 1}` : baseKey,
            calendarMonth: workspaceKey, // 账期即自然月,与 A 页任务列同窗
            workspaceKey,
            customerId: '',
            groupKey: g.groupKey,
            agentKey: normalizeAgentName(g.agentName === UNASSIGNED_LABEL ? '' : g.agentName).agentKey,
            taskType: UNRECEIVED_TASK_TYPE,
            subtype: 'unreceived',
            dueAt: new Date(Date.parse(dueBase) + OVERDUE_MS).toISOString(),
            payload: { tourNo: g.tourNo, name: g.name, passportNo: g.passportNo },
            createdAt: nowIso,
            createdBy: 'system:unreceived',
            sourceVersion: settled + 1,
          });
        } else if (!outstanding && existing) {
          // 收齐(台账/在途)→完成;纯豁免收场→取消(没催成,不算完成)
          const anyProgress = g.rows.some((r) => r.received || r.inFlight);
          if (anyProgress) {
            workflowTaskRepository.complete(existing.id, { by: 'system:unreceived', at: nowIso, note: '未收票已收齐(对账自动完成)' });
          } else {
            workflowTaskRepository.cancel(existing.id, { reason: 'waived_no_need', at: nowIso });
          }
        }
      }
    } catch (error) {
      // 任务是提示层,不能拖垮对账主链
      logger?.error?.(`[agent_unreceived] task sync ${workspaceKey} failed: ${error?.message || error}`);
    }
  }

  /** 账单导入完成钩子:对账盖锚+任务同步(拍板③:起算点=那次导入对账时)。 */
  function stampWorkspace(workspaceKey) {
    try {
      const view = buildView({ workspaceKey });
      return { ok: true, rows: view.stats.rows };
    } catch (error) {
      logger?.error?.(`[agent_unreceived] stamp ${workspaceKey} failed: ${error?.message || error}`);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  /**
   * B 页视图。
   * @param {{workspaceKey: string, search?: string, agentKey?: string}} params
   */
  function buildView({ workspaceKey, search = '', agentKey = '' } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const { kept, firstSeenByKey, nowIso } = reconcile(workspaceKey);
    const nowMs = Date.parse(nowIso);

    // 在途查找(一次批量,失败退化为空)。receipts 兼容 Set/Map:
    // Map(票号→{batchId,groupKey})才能给免护照百货组"已建档"深链;Set 只判在途。
    let inFlight = { passports: new Map(), receipts: new Map() };
    if (inFlightLookup) {
      try {
        const passportNos = new Set();
        const receiptNos = new Set();
        for (const { raw } of kept) {
          const p = normalizeString(raw.passport_no);
          const rc = normalizeString(raw.receipt_no);
          if (p) passportNos.add(p);
          if (rc) receiptNos.add(rc);
        }
        const found = inFlightLookup({ passportNos, receiptNos });
        if (found && found.passports instanceof Map
          && (found.receipts instanceof Set || found.receipts instanceof Map)) inFlight = found;
      } catch (error) {
        logger?.error?.(`[agent_unreceived] inflight lookup failed: ${error?.message || error}`);
      }
    }

    // 行装配(camelCase 出口)+锚回填+在途/豁免标记
    const viewRows = kept.map(({ raw: r, key, resolution }) => {
      const firstSeenAt = firstSeenByKey.get(key) || null;
      const received = Boolean(r.received);
      const waived = Boolean(resolution && resolution.action === 'waive');
      const inFlightHit = !received && !waived && inFlight.receipts.has(normalizeString(r.receipt_no));
      return {
        itemKey: key,
        name: r.name || '',
        fullName: r.full_name || r.name || '',
        passportNo: r.passport_no || '',
        tourNo: r.tour_no || '',
        receiptNo: r.receipt_no || '',
        storeFamily: r.mode_folder || '',
        storeBranch: r.store_branch || '',
        mode: r.mode_raw || '',
        purchaseDate: fmtDate(r.purchase_date),
        statementDate: fmtDate(r.statement_date), // 出账日期(SMG总账来源才有)
        brand: r.brand || '',
        agent: r.agent || '',
        received,
        inFlight: inFlightHit,
        waived,
        waivedBy: waived ? (resolution.resolvedBy || '') : '',
        waivedAt: waived ? (resolution.resolvedAt || '') : '',
        waivedNote: waived ? (resolution.reason || '') : '',
        firstSeenAt,
        overdue: !received && !waived && !inFlightHit
          && Boolean(firstSeenAt) && (Date.parse(firstSeenAt) + OVERDUE_MS) < nowMs,
      };
    });

    // 护照+团号 → 客户组
    const groupMap = new Map();
    for (const row of viewRows) {
      const gk = groupKeyOf({ passportNo: row.passportNo, name: row.name, tourNo: row.tourNo });
      if (!groupMap.has(gk)) {
        groupMap.set(gk, {
          groupKey: gk,
          name: row.name,
          passportNo: row.passportNo,
          tourNo: row.tourNo,
          agent: row.agent,
          rows: [],
        });
      }
      const g = groupMap.get(gk);
      g.rows.push(row);
      if (!g.agent && row.agent) g.agent = row.agent; // 组内任一行有代理即归属
    }

    let groups = [...groupMap.values()].map((g) => {
      const receivedCount = g.rows.filter((r) => r.received).length;
      const collectedCount = g.rows.filter((r) => r.received || r.inFlight).length;
      const firstSeens = g.rows.map((r) => r.firstSeenAt).filter(Boolean).sort();
      // P3 已建档判定+深链:护照能在工作台镜像(passport_record)里找到 → 已建档,
      // 带上批次/组供前端深链;找不到 → 前端显「未建档」灰徽标,不渲染死按钮(拍板⑤)。
      // 票号兜底(部署前整体复查 HIGH):免护照百货(新世界/现代)纯组零护照任务是常态,
      // 护照镜像永远查不到——组内任一票号命中 receipt_record 同样=图已在系统,给同一深链;
      // 否则同一行"在途审核中"与"未建档"自相矛盾。
      let registration = inFlight.passports.get(normalizeString(g.passportNo)) || null;
      if (!registration && typeof inFlight.receipts.get === 'function') {
        for (const row of g.rows) {
          const hit = inFlight.receipts.get(normalizeString(row.receiptNo));
          if (hit && hit.batchId) { registration = hit; break; }
        }
      }
      return {
        ...g,
        agentKey: g.agent ? normalizeString(g.agent) : UNASSIGNED_KEY,
        agentName: g.agent || UNASSIGNED_LABEL,
        status: statusOfGroup(g.rows, nowMs),
        receivedCount,
        collectedCount,
        totalCount: g.rows.length,
        firstSeenAt: firstSeens[0] || null,
        registered: Boolean(registration),
        reviewBatchId: registration?.batchId || '',
        reviewGroupKey: registration?.groupKey || '',
      };
    });

    // P3:未收任务生命周期(在筛选前跑,任务覆盖全量组)
    // SMG替换窗口:导入进行中不跑任务同步——否则用"只剩店家账单"的残缺数据把组误判收齐、
    // 自动 complete 催收任务(留审计噪声)。导入完成后 stampWorkspace 会以完整数据重跑同步。
    const importing = isSmgImporting(workspaceKey);
    if (!importing) {
      syncGroupTasks(workspaceKey, groups, nowIso);
    }

    // 代理桶(全部组算,不受搜索/代理筛选影响——左栏计数是全景)
    const agentMap = new Map();
    for (const g of groups) {
      if (!agentMap.has(g.agentKey)) {
        agentMap.set(g.agentKey, {
          agentKey: g.agentKey,
          agentName: g.agentName,
          groupCount: 0,
          unreceivedCount: 0,
          overdueCount: 0,
        });
      }
      const a = agentMap.get(g.agentKey);
      a.groupCount += 1;
      a.unreceivedCount += g.rows.filter((r) => !r.received && !r.waived).length;
      if (g.status === 'overdue') a.overdueCount += 1;
    }
    const agents = [...agentMap.values()].sort((a, b) => {
      if (a.agentKey === UNASSIGNED_KEY) return 1; // 未归属殿后
      if (b.agentKey === UNASSIGNED_KEY) return -1;
      return String(a.agentName).localeCompare(String(b.agentName), 'zh');
    });

    // 筛选:代理 → 搜索;排序:红的置顶 → 首次发现早的在前
    if (agentKey) groups = groups.filter((g) => g.agentKey === agentKey);
    if (search) groups = groups.filter((g) => matchesSearch(g, search));
    const STATUS_ORDER = { overdue: 0, pending: 1, partial: 2, waived: 3, received: 4 };
    groups.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
      || String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || ''))
      || String(a.name).localeCompare(String(b.name), 'zh'));

    const allGroups = [...groupMap.values()];
    const statusCount = (want) => allGroups
      .filter((g) => statusOfGroup(g.rows, nowMs) === want).length;
    return {
      workspaceKey,
      generatedAt: nowIso,
      importing, // SMG替换窗口:true 时前端横幅提示"总账导入中,数据可能不全"
      stats: {
        groups: groupMap.size,
        rows: viewRows.length,
        unreceivedRows: viewRows.filter((r) => !r.received && !r.waived).length,
        overdueGroups: statusCount('overdue'),
        receivedGroups: statusCount('received'),
        waivedGroups: statusCount('waived'),
      },
      agents,
      groups,
    };
  }

  /**
   * 《未收清单.xlsx》:sheet1=总表 + 每代理一 sheet(名=代理名)+「未归属」殿后。
   * 只导"还要催"的行:已收/在途/无需补 都不进催收清单。
   */
  function buildWorkbook({ workspaceKey } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    // SMG替换窗口内导出=残缺催收清单(缺大半总账未收行)发给代理 → 直接 409 让操作员等导入完成。
    if (isSmgImporting(workspaceKey)) {
      throw new ConflictError('总账正在导入(替换窗口),此刻导出会拿到残缺未收清单;请等导入完成后再导');
    }
    const view = buildView({ workspaceKey });
    const rows = view.groups.flatMap((g) => g.rows
      // 在途也排除(部署前业务走查 HIGH):图已收还在审的票进催收清单=重复催收,
      // 与导出按钮 tooltip/本函数自述矛盾
      .filter((r) => !r.received && !r.waived && !r.inFlight)
      .map((r) => ({ ...r, agent: g.agentName === UNASSIGNED_LABEL ? '' : g.agentName })));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sign Workbench';
    workbook.created = new Date();
    const used = new Set();

    const addSheet = (title, sheetRows) => {
      const sheet = workbook.addWorksheet(sanitizeSheetName(title, used));
      sheet.columns = EXPORT_COLUMNS.map((c) => ({ ...c }));
      for (const r of sheetRows) sheet.addRow(r);
      // 统一表格样式(只加视觉层:字体/表头深蓝灰/隔行/边框/对齐/文本格式/冻结首行/
      // 自动筛选/打印设置)。freezeCols=0:首两列是返点模式/免税分店,非序号/客户组身份列。
      applyExcelStyle(sheet, { headerRow: 1, freezeCols: 0 });
      return sheet;
    };

    addSheet('未收总表', rows);

    // 每代理一 sheet(有未收行的代理才建),未归属殿后
    const byAgent = new Map();
    for (const r of rows) {
      const label = r.agent || UNASSIGNED_LABEL;
      if (!byAgent.has(label)) byAgent.set(label, []);
      byAgent.get(label).push(r);
    }
    const agentNames = [...byAgent.keys()]
      .filter((n) => n !== UNASSIGNED_LABEL)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    for (const name of agentNames) addSheet(name, byAgent.get(name));
    if (byAgent.has(UNASSIGNED_LABEL)) addSheet(UNASSIGNED_LABEL, byAgent.get(UNASSIGNED_LABEL));

    return { workbook, rowCount: rows.length, sheetCount: workbook.worksheets.length };
  }

  // ── P3:「无需补」标记/撤销(写 unreceived_resolution,与老页同一张人工标记表)──
  function waiveItems({ workspaceKey, items, note = '', by = null } = {}) {
    if (!unreceivedResolutionRepo) throw new Error('未收处理仓储未装配');
    if (!workspaceKey) throw new Error('workspaceKey required');
    // 上限护栏:一组未收票撑死几十张,500 足够;防直调 API 灌爆
    const list = (Array.isArray(items) ? items : []).filter((it) => it && it.itemKey).slice(0, 500);
    if (!list.length) return { waived: 0 };
    // 老页已有 link/delay/void 结论的行不许被 waive 覆盖(ON CONFLICT DO UPDATE 会盖掉
    // 人工处理结论;这类行本就不在 B 页展示,走到这=陈旧客户端/直调,跳过并如实计数)。
    const existingOther = new Set(
      unreceivedResolutionRepo.list(workspaceKey)
        .filter((r) => r.action !== 'waive')
        .map((r) => r.itemKey),
    );
    const eligible = list.filter((it) => !existingOther.has(it.itemKey));
    if (!eligible.length) return { waived: 0, skippedResolved: list.length };
    const { resolved } = unreceivedResolutionRepo.resolveMany({
      workspaceKey,
      items: eligible.map((it) => ({
        itemKey: it.itemKey,
        passportNo: it.passportNo || null,
        name: it.name || null,
        receiptNo: it.receiptNo || null,
      })),
      action: 'waive',
      reason: String(note || '').slice(0, 200) || null,
      resolvedBy: by || null,
    });
    return { waived: resolved, skippedResolved: list.length - eligible.length };
  }

  function unwaiveItems({ workspaceKey, itemKeys } = {}) {
    if (!unreceivedResolutionRepo) throw new Error('未收处理仓储未装配');
    if (!workspaceKey) throw new Error('workspaceKey required');
    // 只撤 waive 行:B 页的「恢复催收」不许顺手撤掉老页的 link/delay/void 处理结论
    const waiveKeys = new Set(
      unreceivedResolutionRepo.list(workspaceKey)
        .filter((r) => r.action === 'waive')
        .map((r) => r.itemKey),
    );
    let restored = 0;
    for (const key of (Array.isArray(itemKeys) ? itemKeys : [])) {
      if (!key || !waiveKeys.has(key)) continue;
      unreceivedResolutionRepo.unresolve({ workspaceKey, itemKey: key });
      restored += 1;
    }
    return { restored };
  }

  return {
    listWorkspaces,
    buildView,
    stampWorkspace,
    buildWorkbook,
    waiveItems,
    unwaiveItems,
    setInFlightLookup,
    isSmgImporting,
  };
}

module.exports = { createAgentUnreceivedService, EXPORT_COLUMNS, UNRECEIVED_TASK_TYPE };
