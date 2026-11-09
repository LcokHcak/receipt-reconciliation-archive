'use strict';

/**
 * library_mode_export_service — 资料库「按团号匹配模式(mode_raw)分类 + 导出客户数据 + 需重拍回收」。
 *
 * 两个数据源:
 *   ① 已结算客户(按模式) → 月度台账 daily_receipt_export(带 workspace_key + source_batch_id,可按工作区/批次筛)。
 *   ② 需重拍/去回收客户 → 只在审核批次里(task.rephotoRequested);重拍客户不进台账(结算被 rephoto 拦),
 *      所以单独从 batchRepository 拉,放进导出的「需重拍·去回收」sheet。
 *
 * 分类粒度:mode_raw(细团号模式)。导出:一个 xlsx,每个模式一 sheet + 一个重拍 sheet。
 */

const ExcelJS = require('exceljs');
const { applyExcelStyle } = require('../../lib/excel_style');
const { filterBatchesByOperator, canAccessAllOperatorData } = require('../../lib/operator_scope');
const {
  formatReceiptNoForMode,
  isNoRecordMode,
  resolveCollectedDateFromLedgerRow,
} = require('../../lib/workbench_receipt_export');
const { lookupModeRecordRule } = require('../../lib/mode_record_matrix');
const { deptBranchName } = require('../../lib/store_profiles');
const { rephotoReasonLabel } = require('../../lib/rephoto_reasons');
const { normalizeStoreFamily } = require('../../lib/validation/field_rules');

// 2026-07-20 用户拍板(百货交付重构§2/§4):「免税分店」拆两列(免税店+门店编号)+加「上家」列。
// branch_name/branch_code 是**出口计算列**(台账 branch 仍存"明洞(0394)"单列,存储口径不动)。
const COLUMNS = Object.freeze([
  ['购买日期', 'purchase_date'],
  // 收票日期(=我们收到并上传小票那天,2026-07-24 用户拍板):出口计算列,取客户编号
  // CLyyyymmdd(KST 上传日)优先、回落 created_at;非台账 receipt_date(那是审核/结算当天)。
  ['收票日期', 'collected_date'],
  ['团号', 'tour_no'],
  ['姓名', 'name'],
  ['护照号', 'passport_no'],
  ['小票号', 'receipt_no'],
  ['代理', 'agent'],
  ['上家', 'upstream'],
  ['返点模式', 'mode_raw'],
  ['免税店', 'branch_name'],
  ['门店编号', 'branch_code'],
  ['品牌', 'brand'],
  ['数量', 'qty'],
  ['总卖出(￦)', 'gross_krw'],
  ['纯卖出(￦)', 'net_krw'],
  ['客人返点金额', 'customer_rebate'],
  ['出境日期', 'departure_date'],
]);

// 百货页签表头改叫法(0727反馈#13-1/#14-2):百货票面没有"小票号/总卖出"这两个词,
// 上家对账认的是「交易编号/交易金额」。只换**整页都是百货行**的模式页签表头;
// ⭐汇总页永远用通用叫法(2026-08-01 用户拍板,writeSheet 传 allowDeptHeader:false 落实),
// 判定走 shop 归一(*_DEPT),不靠模式名含"百货"的字面。
//
// 另:月度族(最终交付/收票清单)的百货行**保持「总卖出」不改**(2026-08-01 用户拍板)——
// 那两张表是照上家账单模板做的,上家认旧叫法。所以"资料库叫交易金额、月度族叫总卖出"
// 是刻意的,不是漏改,别顺手统一。
const DEPT_HEADER_OVERRIDES = Object.freeze({ receipt_no: '交易编号', gross_krw: '交易金额(￦)' });
function isDeptLedgerRow(row) {
  return String(normalizeStoreFamily(String(row?.shop || '').trim()) || '').endsWith('_DEPT');
}

// 出口计算列(不在台账 SELECT 里);listRows 实际取的真列=显示真列+拆列依赖(branch 原列、shop 反查)
const VIRTUAL_KEYS = new Set(['branch_name', 'branch_code', 'collected_date']);
const SELECT_KEYS = Object.freeze([
  ...COLUMNS.map(([, k]) => k).filter((k) => !VIRTUAL_KEYS.has(k)),
  // imported_at:收票日期的兜底真列(2026-08-01 用户拍板)。以前兜底写的是 created_at,
  // 而这张表没有那一列、查询里也没查它 —— 客户编号不标准的行整列空白(截图 image37)。
  'branch', 'shop', 'source_customer_id', 'imported_at',
]);

// 台账 branch"明洞(0394)"拆 名+码:"名(码)"直接拆(全/半角括号都认);裸码
// (2026-07-13 前存量/未识别码)按行 shop 反查店名(deptBranchName 单源),查不到店名留空、码照出。
function splitBranchCell(row) {
  const raw = String(row?.branch || '').trim();
  if (!raw) return { name: '', code: '' };
  const m = /^(.*?)[(（]([^()（）]+)[)）]$/.exec(raw);
  if (m) return { name: m[1].trim(), code: m[2].trim() };
  const name = deptBranchName(normalizeStoreFamily(String(row?.shop || '').trim()), raw);
  return { name, code: raw };
}

// ⭐「重拍原因」这一列 2026-08-01 才补上。0727#10 加原因分键的**全部理由**就是
// 「前台补拍不用再猜」,而拿这张表去回收照片的人恰恰最需要它 —— 原来这张表只有
// 「需重拍·去回收」五个字,回收的人还得再回审核台一条条翻。
// 一个客户组里可能有多张票、原因不同 → 汇总成「模糊×2、缺×1」,别只报第一个。
const REPHOTO_COLUMNS = Object.freeze([
  ['客户组', 'label'],
  ['代理', 'agent'],
  ['收票员', 'collector'],
  ['所在批次', 'batchName'],
  ['状态', 'status'],
  ['重拍原因', 'reasonSummary'],
]);

const NO_MODE = '（未匹配·空模式）';
const REPHOTO_SHEET = '需重拍·去回收';
// 需求F③:第一页固定是全部模式汇总(sheet2 起才按模式分页)
const SUMMARY_SHEET = '汇总';

function sanitizeSheetName(name, used) {
  const base = (String(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28)) || '空';
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}~${i++}`.slice(0, 31);
  used.add(candidate);
  return candidate;
}

function taskIsRephoto(task) {
  const pr = String(task?.processResult || '').toLowerCase();
  return Boolean(task?.rephotoRequested) || pr.includes('rephoto') || pr.includes('重拍');
}

// 客户数据 Excel 小票号出口重排(2026-07-20 五问题#5修②):台账存量混有"被剥了字母/杠"
// 的旧口径行(修①之前的兜底数字投影),导出瞬间按**行自己的 mode_raw** 走交付合同
// formatReceiptNoForMode(letters14 保G、dashed19 干净16位数字补杠 2-6-3-5、digits13/14 剥杠)。
// 模式未知/无票号形态/重排失败 → 原样输出,绝不空值。只改出口,不回写存储
// (存量订正走 scripts/oneoff/backfill_receipt_no_letters.js,等用户批)。
function formatReceiptNoCell(row) {
  const value = row?.receipt_no;
  if (value == null || value === '') return '';
  try {
    const rule = lookupModeRecordRule(String(row.mode_raw || '').trim());
    if (!rule?.known || !rule.receiptNoForm) return value; // 模式无形态 → 原样
    // formatReceiptNoForMode 吃任务形状字段;台账行只有存储串,包一层即可同口径复用
    return formatReceiptNoForMode({ receiptNoFinal: String(value) }, rule) || value;
  } catch {
    return value; // 重排失败 → 原样(导出永不因格式化炸行)
  }
}

function createLibraryModeExportService({ db, batchRepository = null }) {
  if (!db) throw new Error('library_mode_export_service: db required');

  // owner 隔离基础:某操作员"拥有"的批次(admin/finance 返回全部)。台账无 owner 列,
  // 靠 source_batch_id 映射到批次的 owner(batch.ownerUsername,已在建批次时盖章)。
  function ownedBatches(operatorUser) {
    if (!batchRepository?.listBatches) return [];
    let all;
    try { all = batchRepository.listBatches() || []; } catch { all = []; }
    if (canAccessAllOperatorData(operatorUser)) return all;
    return filterBatchesByOperator(all, operatorUser);
  }

  function buildFilter({ workspaceKey = '', batchId = '', batchIds = [], operatorUser = undefined } = {}) {
    const clauses = [];
    const args = [];
    const ws = String(workspaceKey || '').trim();
    const bid = String(batchId || '').trim();
    // 跨批多选(2026-07-28,F4 参考图第二刀):batchIds[] 优先于单 batchId;
    // 所有下游(listRows/summary/buildWorkbook/precheck)经同一 buildFilter 自动获得跨批口径。
    const bids = [...new Set((Array.isArray(batchIds) ? batchIds : []).map((b) => String(b || '').trim()).filter(Boolean))];
    if (ws) { clauses.push('workspace_key = ?'); args.push(ws); }
    if (bids.length) { clauses.push(`source_batch_id IN (${bids.map(() => '?').join(',')})`); args.push(...bids); }
    else if (bid) { clauses.push('source_batch_id = ?'); args.push(bid); }
    // owner 隔离:非全局权限只能看自己批次的台账;没有自己的批次 → 1=0 空结果。
    if (operatorUser !== undefined && !canAccessAllOperatorData(operatorUser)) {
      const ids = ownedBatches(operatorUser).map((b) => b.id || b.batchId).filter(Boolean);
      if (!ids.length) { clauses.push('1 = 0'); }
      else { clauses.push(`source_batch_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  // 有台账数据的月度工作区(下拉)——按 owner 过滤:只留自己拥有批次对应的工作区。
  function listWorkspaces(operatorUser = undefined) {
    const all = db.prepare(`
      SELECT workspace_key AS workspaceKey, COUNT(*) AS receipts
      FROM daily_receipt_export
      GROUP BY workspace_key
      ORDER BY workspace_key DESC
    `).all().filter((r) => r.workspaceKey);
    if (operatorUser === undefined || canAccessAllOperatorData(operatorUser)) return all;
    const ownedWs = new Set(
      ownedBatches(operatorUser).map((b) => String(b.monthlyWorkspaceKey || '').trim()).filter(Boolean),
    );
    return all.filter((w) => ownedWs.has(String(w.workspaceKey).trim()));
  }

  // 活审核批次(下拉)——按 owner 过滤(ownedBatches:全局权限返回全部,否则只返回自己的)。
  // createdAt/ownerUsername 给前端按天分组+消歧义(admin 每天几十个批次,靠这个找)。
  function listBatches(operatorUser = undefined) {
    return ownedBatches(operatorUser)
      .map((b) => ({
        id: b.id || b.batchId,
        name: b.name || b.id || b.batchId,
        createdAt: b.createdAt || '',
        ownerUsername: b.ownerUsername || b.createdBy || '',
        workspaceKey: String(b.monthlyWorkspaceKey || '').trim(),
      }))
      .filter((b) => b.id);
  }

  function listModeSummary(opts = {}) {
    const { where, args } = buildFilter(opts);
    return db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(mode_raw), ''), ?) AS mode,
             COUNT(DISTINCT source_customer_id) AS customers,
             COUNT(*) AS receipts
      FROM daily_receipt_export
      ${where}
      GROUP BY mode
      ORDER BY receipts DESC
    `).all(NO_MODE, ...args);
  }

  function listRows(opts = {}) {
    const { where, args } = buildFilter(opts);
    const cols = SELECT_KEYS.join(', ');
    return db.prepare(`
      SELECT ${cols}
      FROM daily_receipt_export
      ${where}
      ORDER BY mode_raw, source_customer_id, purchase_date, id
    `).all(...args);
  }

  // ── 导出前真实预检(0727反馈#15)──────────────────────────────────────
  // 旧「预检」按钮零信息已删(ff5c583);这回按交付合同真检:对台账行的票号形态/购买日期
  // 逐行核对,疑似审核失误带批次+客户定位返回,前端前置展示+跳审核台修。
  // 只读不拦导出——预检是眼睛不是闸,拦不拦由人决定。提示写人话(用户注:简单明了)。
  function receiptNoProblem(modeRaw, receiptNo) {
    const rule = lookupModeRecordRule(String(modeRaw || '').trim());
    if (!rule?.known || !rule.receiptNoForm) return ''; // 模式没有票号形态合同 → 不妄断
    if (rule.columns?.receiptNo === false) return ''; // 该模式不记票号
    const raw = String(receiptNo || '').trim();
    if (!raw) return '票号是空的';
    const digits = raw.replace(/\D/g, '');
    const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hasLetter = /[A-Za-z]/.test(raw);
    const form = rule.receiptNoForm;
    if (form === 'digits13' || form === 'digits14') {
      const n = form === 'digits13' ? 13 : 14;
      // 尾缀单字母豁免(0728 生产实锤):5+ 张票 OCR 是纯数字、审核员逐张手动补「R」
      // (task_0246/0706 的 auto→final 对比铁证)——是票面/团队有意标记不是失误,
      // 报出来全是假警报。只豁免「位数正好 + 单个尾字母」;字母在中间照报,位数不对照报。
      const compact = raw.toUpperCase().replace(/-/g, '');
      const tailLetterOnly = new RegExp(`^\\d{${n}}[A-Z]$`).test(compact);
      if (tailLetterOnly) return '';
      if (hasLetter) return `票号里混了字母(${raw}),这家店应是 ${n} 位纯数字`;
      if (digits.length !== n) return `票号 ${digits.length} 位(${raw}),这家店应是 ${n} 位`;
    } else if (form === 'dashed19') {
      if (digits.length !== 16) return `票号数字 ${digits.length} 位(${raw}),应是 16 位(带杠 2-6-3-5)`;
      if (raw.includes('-') && !/^\d{2}-\d{6}-\d{3}-\d{5}$/.test(raw)) return `票号的杠打错位置(${raw}),应是 2-6-3-5`;
    } else if (form === 'letters14') {
      if (alnum.length !== 14) return `票号 ${alnum.length} 位(${raw}),这家店应是 14 位(可含字母)`;
    } else if (form === 'dash44') {
      if (hasLetter) return `交易编号里混了字母(${raw}),应是 8 位数字(4-4)`;
      if (digits.length !== 8) return `交易编号 ${digits.length} 位(${raw}),应是 8 位(4-4)`;
      if (raw.includes('-') && !/^\d{4}-\d{4}$/.test(raw)) return `交易编号的杠打错位置(${raw}),应是 4-4(XXXX-XXXX)`;
    }
    return '';
  }

  // 护照号形态(0728 截图驱动,image36 实锤:MRZ 第二行整串「N7904233F3306242MLM…」
  // 灌进护照号列)。只抓两种铁证:带 MRZ 填充符 < / 去符号后超 12 位——护照最长 9 位、
  // 越南身份证 12 位(image36 绿框 079089021273 是合法值),12 位以内一律不妄断。
  // 空也不查:百货免护照店/身份在护照任务,台账行护照空有合法业态(同姓名列)。
  function passportNoProblem(passportNo) {
    const raw = String(passportNo || '').trim();
    if (!raw) return '';
    if (raw.includes('<')) return `护照号带机读行填充符<(${raw}),像是把 MRZ 整行抄进来了`;
    const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (alnum.length > 12) return `护照号 ${alnum.length} 位(${raw}),超过证件号上限(护照≤9位/身份证12位),疑似把 MRZ 整行抄进来了`;
    return '';
  }

  function listFormatIssues(opts = {}) {
    const { where, args } = buildFilter(opts);
    const rows = db.prepare(`
      SELECT id, workspace_key, source_batch_id, source_customer_id, mode_raw,
             name, receipt_no, purchase_date, passport_no
      FROM daily_receipt_export
      ${where}
      ORDER BY mode_raw, source_customer_id, id
    `).all(...args);
    const issues = [];
    let checked = 0;
    for (const r of rows) {
      if (isNoRecordMode(r.mode_raw)) continue; // 「不用记」行不进导出,也不预检
      checked += 1;
      const problems = [];
      const rp = receiptNoProblem(r.mode_raw, r.receipt_no);
      if (rp) problems.push(rp);
      const pp = passportNoProblem(r.passport_no);
      if (pp) problems.push(pp);
      // 购买日期:空值必查(所有模式都记日期);格式坏值在录入层已被归一挡住,这里不重复
      const rule = lookupModeRecordRule(String(r.mode_raw || '').trim());
      if ((!rule?.known || rule.columns?.purchaseDate !== false) && !String(r.purchase_date || '').trim()) {
        problems.push('购买日期是空的');
      }
      // 姓名空不查:百货借位(上家→姓名列)/免税身份在护照任务,台账行姓名空有合法业态,
      // 查了全是假警报把真问题淹掉。
      if (!problems.length) continue;
      issues.push({
        rowId: r.id,
        workspaceKey: String(r.workspace_key || ''),
        batchId: String(r.source_batch_id || ''),
        customerId: String(r.source_customer_id || ''),
        mode: String(r.mode_raw || '').trim() || NO_MODE,
        receiptNo: String(r.receipt_no || ''),
        problems,
      });
    }
    return { checkedRows: checked, issues };
  }

  // 需重拍/去回收的客户组。batchId/batchIds 指定则只看这些批次;否则扫描(可按 workspaceKey 过滤)活批次。
  function listRephotoGroups({ batchId = '', batchIds: pickedIds = [], workspaceKey = '', operatorUser = undefined } = {}) {
    if (!batchRepository?.loadBatch) return [];
    const bid = String(batchId || '').trim();
    // 跨批多选(2026-07-28):与 buildFilter 同口径,batchIds[] 优先于单 batchId
    const picked = [...new Set((Array.isArray(pickedIds) ? pickedIds : []).map((b) => String(b || '').trim()).filter(Boolean))];
    const ws = String(workspaceKey || '').trim();
    // owner 隔离:非全局权限只扫自己的批次。
    const scoped = operatorUser !== undefined && !canAccessAllOperatorData(operatorUser);
    const ownedIds = scoped
      ? new Set(ownedBatches(operatorUser).map((b) => b.id || b.batchId).filter(Boolean))
      : null;
    let batchIds = [];
    if (picked.length) {
      batchIds = picked.filter((id) => !ownedIds || ownedIds.has(id)); // 混入别人的批次 → 剔除
    } else if (bid) {
      batchIds = (!ownedIds || ownedIds.has(bid)) ? [bid] : []; // 请求别人的批次 → 空
    } else if (ownedIds) {
      batchIds = [...ownedIds];
    } else if (batchRepository.listBatchIds) {
      batchIds = batchRepository.listBatchIds() || [];
    } else if (batchRepository.listBatches) {
      batchIds = (batchRepository.listBatches() || []).map((b) => b.id || b.batchId).filter(Boolean);
    }

    const out = [];
    // 0729 静默排查 B2:批次 JSON 损坏/被移走/权限异常时,原来是 catch{}continue ——
    // 该批次里「需重拍·去回收」的客户组就从名单里彻底消失,运营会以为这批不用重拍,
    // 实际是系统压根没读到。低频事件,但「重拍名单少了人」在业务上很敏感:
    // 少通知一个客户 = 少收一张票 = 少一笔返点。不阻断(其余批次照常出),但必须报出来。
    const unreadableBatches = [];
    for (const id of batchIds) {
      let batch;
      try { batch = batchRepository.loadBatch(id); }
      catch (err) { unreadableBatches.push({ batchId: String(id), error: String(err?.message || err).slice(0, 120) }); continue; }
      if (!batch) { unreadableBatches.push({ batchId: String(id), error: '批次读出来是空的' }); continue; }
      if (ws && !bid && String(batch.monthlyWorkspaceKey || '').trim() !== ws) continue;
      const batchName = batch.name || batch.id || id;
      const collector = batch.ownerDisplayName || batch.ownerUsername || batch.owner || '';
      const sourceGroups = Array.isArray(batch.sourceGroups) ? batch.sourceGroups : [];
      const labelByKey = new Map(sourceGroups.map((g) => [String(g.key || g.groupKey || '').trim(), g.label || '']));
      const groups = new Map();
      for (const task of (Array.isArray(batch.tasks) ? batch.tasks : [])) {
        const key = String(task?.sourceGroupKey || '').trim() || '(默认组)';
        if (!groups.has(key)) groups.set(key, { rephoto: false, agent: '', reasons: new Map() });
        const g = groups.get(key);
        if (taskIsRephoto(task)) {
          g.rephoto = true;
          // 原因按张计数:同组多张票原因常常不同,只报第一个会误导回收的人
          const label = rephotoReasonLabel(task?.rephotoReason) || '未填原因';
          g.reasons.set(label, (g.reasons.get(label) || 0) + 1);
        }
        if (!g.agent && task?.customerAgentName) g.agent = task.customerAgentName;
      }
      for (const [key, g] of groups) {
        if (!g.rephoto) continue;
        out.push({
          batchId: id,
          batchName,
          collector,
          groupKey: key,
          label: labelByKey.get(key) || key,
          agent: g.agent,
          status: '需重拍·去回收',
          // 「模糊×2、缺×1」;只有一张就是「模糊」。没填原因的如实写「未填原因」,不留空白
          // ——空白会被读成"不用重拍",而这张表上每一行都是要重拍的。
          reasonSummary: [...g.reasons.entries()]
            .map(([label, n]) => (n > 1 ? `${label}×${n}` : label))
            .join('、'),
        });
      }
    }
    // 读不出的批次挂成**不可枚举**属性:全部 5 个调用方都把返回值当纯数组用
    // (.length / 展开 / .map),改成 { groups, unreadable } 会连带改五处并把
    // 「重拍名单」这条热路径搅动一遍;不可枚举 = 数组行为、JSON 序列化都不受影响。
    Object.defineProperty(out, 'unreadableBatches', {
      value: unreadableBatches, enumerable: false, writable: false,
    });
    return out;
  }

  // 已结算客户(台账按客户聚合,带护照/模式/小票数)——listCustomers/listOverview 共用
  function listSettledCustomers(opts = {}) {
    const { where, args } = buildFilter(opts);
    return db.prepare(`
      SELECT source_customer_id AS customerId,
             MAX(name) AS name,
             MAX(passport_no) AS passportNo,
             COALESCE(NULLIF(TRIM(mode_raw), ''), ?) AS mode,
             MAX(tour_no) AS tourNo,
             MAX(agent) AS agent,
             MAX(purchase_date) AS purchaseDate,
             COUNT(*) AS receipts
      FROM daily_receipt_export
      ${where}
      GROUP BY source_customer_id, mode
      ORDER BY mode, name
    `).all(NO_MODE, ...args).map((r) => ({ ...r, status: 'reviewed', statusLabel: '审核完·已结算' }));
  }

  function rephotoAsCustomerRow(g) {
    return {
      customerId: g.groupKey,
      name: g.label,
      passportNo: '',
      mode: '（需重拍）',
      tourNo: '',
      agent: g.agent,
      purchaseDate: '',
      receipts: 0,
      status: 'rephoto',
      statusLabel: '需重拍·去回收',
      batchName: g.batchName,
    };
  }

  // 客户级列表(资料库展示用):已结算客户 + 需重拍客户(批次)。
  // 前端可再按模式筛选;不含账单信息(还没到账单匹配)。
  function listCustomers(opts = {}) {
    return [...listSettledCustomers(opts), ...listRephotoGroups(opts).map(rephotoAsCustomerRow)];
  }

  // 每批次已结算计数(一条 GROUP BY,批次列表徽章用;owner 过滤由调用方按批次集收窄)
  function settledCountsByBatch() {
    try {
      return new Map(db.prepare(`
        SELECT source_batch_id AS batchId,
               COUNT(DISTINCT source_customer_id) AS customers,
               COUNT(*) AS receipts
        FROM daily_receipt_export
        WHERE source_batch_id IS NOT NULL AND TRIM(source_batch_id) != ''
        GROUP BY source_batch_id
      `).all().map((r) => [r.batchId, { customers: r.customers, receipts: r.receipts }]));
    } catch {
      return new Map();
    }
  }

  // 资料库首屏聚合(2026-07-16 P0 性能修):老页面 summary+customers 两个端点**各扫一遍**
  // 全部批次 JSON 找重拍(listRephotoGroups O(批次×任务) 跑两遍)——这里单遍扫描全复用。
  // lite(复核H2):首屏引导只要 workspaces+batches 徽章——admin 无批次筛选时重拍扫描=
  // 全系统批次 JSON 逐个 loadBatch,且结果选中批次后立刻被覆盖,纯浪费 → lite 跳过重活。
  function listOverview(opts = {}) {
    const operatorUser = opts.operatorUser;
    if (opts.lite) {
      const counts = settledCountsByBatch();
      return {
        workspaces: listWorkspaces(operatorUser),
        batches: listBatches(operatorUser).map((b) => ({
          ...b,
          settledCustomers: counts.get(b.id)?.customers || 0,
          settledReceipts: counts.get(b.id)?.receipts || 0,
        })),
        modes: [],
        rephotoCount: 0,
        customers: [],
        lite: true,
      };
    }
    const rephotoGroups = listRephotoGroups(opts); // ⭐唯一一遍重拍扫描
    const settled = listSettledCustomers(opts);
    const counts = settledCountsByBatch();
    const batches = listBatches(operatorUser).map((b) => ({
      ...b,
      settledCustomers: counts.get(b.id)?.customers || 0,
      settledReceipts: counts.get(b.id)?.receipts || 0,
    }));
    return {
      workspaces: listWorkspaces(operatorUser),
      batches,
      modes: listModeSummary(opts),
      rephotoCount: rephotoGroups.length,
      // 0729 B2:读不出的批次要露到界面上。「重拍名单少了人」= 少通知一个客户 =
      // 少收一张票 = 少一笔返点,而这条以前只会静默 —— 运营看到的名单是"完整"的。
      unreadableBatches: rephotoGroups.unreadableBatches || [],
      customers: [...settled, ...rephotoGroups.map(rephotoAsCustomerRow)],
    };
  }

  // 构建 xlsx:每模式一 sheet(已结算客户数据)+「需重拍·去回收」sheet。
  function buildWorkbook(opts = {}) {
    // 「不用记」行不进任何导出账单(2026-07-24 用户拍板):台账仍保留(免被未收对账误催),
    // 只在导出出口按行 mode_raw 过滤。过滤后某模式全是不用记 → 该 sheet 不出现(容忍空)。
    const rows = listRows(opts).filter((r) => !isNoRecordMode(r.mode_raw));
    const byMode = new Map();
    for (const r of rows) {
      const mode = String(r.mode_raw || '').trim() || NO_MODE;
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push(r);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sign Workbench';
    workbook.created = new Date();

    // 一个 sheet 的写法(表头 + 数据行 + 统一样式)。汇总页与各模式页共用,避免两处各写一遍
    // 单元格取值规则(小票号按行 mode_raw 重排 / branch 拆列 / 收票日期计算列)后失步。
    function writeSheet(name, sheetRows, { allowDeptHeader = true } = {}) {
      const sheet = workbook.addWorksheet(sanitizeSheetName(name, used));
      // 整页皆百货 → 表头换「交易编号/交易金额」(0727#13/#14);空页/混流页用通用表头。
      // ⭐汇总页**永远**用通用叫法(2026-08-01 用户拍板):它是跨店对比用的,列名跟着当天
      // 数据变(纯百货的日子换、混了一张免税店票又换回来)会让人以为看错了表。
      // 改之前实现与本文件第 52 行的注释不一致——注释写"汇总页混流保持通用叫法",
      // 而纯百货的日子汇总页也会跟着换,且纯百货现在很常见。
      const deptSheet = allowDeptHeader && sheetRows.length > 0 && sheetRows.every(isDeptLedgerRow);
      sheet.addRow(COLUMNS.map(([header, key]) => (deptSheet && DEPT_HEADER_OVERRIDES[key]) || header));
      for (const row of sheetRows) {
        // 小票号列按行 mode_raw 重排(五问题#5修②);免税店/门店编号=branch 出口拆列;其余列原样
        const branchCells = splitBranchCell(row);
        sheet.addRow(COLUMNS.map(([, key]) => {
          if (key === 'receipt_no') return formatReceiptNoCell(row);
          if (key === 'branch_name') return branchCells.name;
          if (key === 'branch_code') return branchCells.code;
          if (key === 'collected_date') return resolveCollectedDateFromLedgerRow(row);
          return row[key] ?? '';
        }));
      }
      // 统一表格样式(仅视觉层:字体/表头/隔行/边框/对齐/文本格式/冻结首行等)。
      // freezeCols=0:首两列为购买日期/团号,非身份定位列,只冻表头。
      applyExcelStyle(sheet, { columnCount: COLUMNS.length });
      return sheet;
    }

    const used = new Set();
    const modes = [...byMode.keys()];
    // 2026-07-27 需求F③:sheet1 = 全部模式汇总,sheet2 起每模式一页。
    // 之前第一页就是某个模式,想看整批全貌得自己把 N 页拼起来——这是每次导出后的第一个动作。
    // 列与各模式页完全一致(含「返点模式」列,汇总页靠它区分行归属),不另立一套表头。
    writeSheet(SUMMARY_SHEET, rows, { allowDeptHeader: false });
    if (!modes.length) workbook.addWorksheet('（无已结算数据）');
    for (const mode of modes) writeSheet(mode, byMode.get(mode));

    // 需重拍 sheet(始终加,便于回收的人一眼看到)。
    const rephoto = listRephotoGroups(opts);
    const rsheet = workbook.addWorksheet(sanitizeSheetName(REPHOTO_SHEET, used));
    rsheet.addRow(REPHOTO_COLUMNS.map(([header]) => header));
    for (const g of rephoto) {
      rsheet.addRow(REPHOTO_COLUMNS.map(([, key]) => g[key] ?? ''));
    }
    applyExcelStyle(rsheet, { columnCount: REPHOTO_COLUMNS.length });

    return workbook;
  }

  return {
    listWorkspaces, listBatches, listModeSummary, listRows, listRephotoGroups, listCustomers,
    listOverview, buildWorkbook, listFormatIssues,
    COLUMNS, REPHOTO_COLUMNS, NO_MODE, REPHOTO_SHEET, SUMMARY_SHEET,
  };
}

module.exports = {
  createLibraryModeExportService, COLUMNS, NO_MODE, REPHOTO_SHEET, splitBranchCell,
  // 小票号出口重排(按行 mode_raw 走交付合同):DSL Excel 计划复用同一函数,防两个 Excel 出口副本失步(审计MEDIUM)
  formatReceiptNoCell,
};
