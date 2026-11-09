const { DOC_TYPES } = require('./package_constants');
const { ROOT_SOURCE_GROUP_KEY } = require('./source_group_utils');
const { PROCESS_RESULTS, normalizeDocType } = require('./workbench_task_flow');
const { lookupModeRecordRule } = require('./mode_record_matrix');
const { getStoreProfile, FAMILY } = require('./store_profiles');
const { normalizeStoreFamily } = require('./validation/field_rules');
const { hasNoTourStance, isNoTourTask } = require('./no_tour');

const RECEIPT_EXPORT_COLUMNS = Object.freeze([
  { header: '中文姓名', key: 'chinese_name', width: 18 },
  { header: '英文姓名', key: 'passport_name', width: 24 },
  { header: '护照号码', key: 'passport_no', width: 18 },
  { header: '免税店', key: 'receipt_store', width: 18 },
  // 0731 拍板:跟 export_plan_engine / field_registry 对齐。同一个 receiptNoFinal,
  // 审核台按模式显示「小票号」(免税店)或「交易编号」(乐天/新世界/现代百货),
  // 而这张表原来写死「小票号」—— 百货行导出后,审核员当时填的名字和表上的名字对不上。
  // 改名有代价:daily_receipt_mapper 是**按表头字符串**认「这是不是每日台账」的,
  // 所以读取侧必须同步放宽(见该文件 FIELD_ALIASES.receiptNo 与 isDailyLedgerHeaderRow),
  // 且旧名「小票号」必须继续认 —— 存量表格不能因为改个表头就读不进来。
  { header: '小票号/交易编号', key: 'receipt_no', width: 22 },
  { header: '团号', key: 'group_no', width: 16 },
  // 0731 用户口径「什么字段就填什么列,不要串」:百货的金额和上家原来是**借位**塞进
  // 团号列/姓名列的(借位的唯一原因就是这张表当初没这两列)。要拆借位,先得有位置放。
  // 免税店这两格恒空,不影响既有列的读法。
  { header: '金额', key: 'receipt_amount', width: 14 },
  { header: '上家', key: 'upstream', width: 16 },
  { header: '购买日期', key: 'purchase_date', width: 14 },
  { header: '离境日期', key: 'departure_date', width: 14 },
  { header: '代理', key: 'agent', width: 18 },
  { header: '收票日期', key: 'receipt_date', width: 14 },
  { header: '模式', key: 'mode', width: 24 },
  { header: '备注', key: 'note', width: 32 },
]);

const RECEIPT_EXPORT_HEADERS = Object.freeze(RECEIPT_EXPORT_COLUMNS.map((column) => column.header));

function normalizeText(value) {
  return String(value || '').trim();
}

function formatDateParts(date, timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function formatBusinessDate(value, { timeZone = 'Asia/Seoul' } = {}) {
  const text = normalizeText(value);
  if (!text) {
    return '';
  }

  const dateMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (dateMatch && !/[T:]/.test(text)) {
    return [
      dateMatch[1],
      dateMatch[2].padStart(2, '0'),
      dateMatch[3].padStart(2, '0'),
    ].join('-');
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return dateMatch
      ? [dateMatch[1], dateMatch[2].padStart(2, '0'), dateMatch[3].padStart(2, '0')].join('-')
      : text;
  }
  return formatDateParts(parsed, timeZone);
}

function getCustomerIdDate(customerId) {
  const match = /^CL(\d{4})(\d{2})(\d{2})-\d{3}$/.exec(normalizeText(customerId));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

// 收票日期(=我们收到并上传小票那天)的**全系统唯一口径**:客户建档时刻 customer.createdAt
// (渲染为 KST 日历日)优先,回落客户编号 CLyyyymmdd 内嵌日期(天生 KST),再回落任务建档时刻。
// ⚠️禁止用台账 receipt_date(那是"审核通过/结算当天"、且是 UTC 截断)当"上传那天"。
function resolveReceiptCollectedDate({ customerContext = {}, task = {} } = {}) {
  const customerId = normalizeText(customerContext.customerId)
    || normalizeText(task.sourceFolderName)
    || normalizeText(task.sourceFolderPath);
  return formatBusinessDate(customerContext.createdAt)
    || getCustomerIdDate(customerId)
    || formatBusinessDate(task.createdAt);
}

// 台账/月度行(已落库,只有 source_customer_id)的收票日期:客户编号 CLyyyymmdd(KST 上传日)优先。
// 不用行内 receipt_date(=审核通过日/结算当天,语义不同,而且是 UTC 截断)。
//
// ⚠️ 2026-08-01 修:兜底原来写的是 `row.created_at`,而 **daily_receipt_export 这张表压根没有
// created_at 这一列**(实查 PRAGMA table_info 确认)。于是客户编号一旦不是标准 CLyyyymmdd-NNN
// (导入的历史行、改过 ID 的行),这一列就是整列空白 —— 正是用户截图 image37 那个"有表头没数据"。
// 用户 0801 拍板:回落 imported_at(这批数据真正进系统的时间,语义最接近"收票")。
//
// 兜底链放在这里而不是各调用点:改之前三个调用点各写各的(received 回落 receipt_date、
// final_delivery 回落 trace_daily_receipt_date、library_mode 根本没兜底),同一个"收票日期"
// 三个读法三种结果。trace_daily_receipt_date 排在 imported_at 前面是保留 final_delivery 原有
// 语义(它是真·追溯到的收票日),别的行形状上没这个字段,天然跳过。
function resolveCollectedDateFromLedgerRow(row = {}) {
  // 只认 source_customer_id(库列)与它的驼峰别名。原来还兜了 row.customer_id ——
  // 全仓没有任何地方产出这个字段,是**死别名**;而死别名会让人以为"已经兜过了",
  // 正是 created_at 那处坏兜底能活这么久的同类掩护。
  const customerId = normalizeText(row.source_customer_id || row.sourceCustomerId);
  return getCustomerIdDate(customerId)
    || formatBusinessDate(row.trace_daily_receipt_date || '')
    || formatBusinessDate(row.imported_at || row.importedAt || '');
}

// 「不用记」模式判定(供台账族导出统一在出口过滤,不重复散抄尾巴规则)。
function isNoRecordMode(modeName) {
  return Boolean(lookupModeRecordRule(modeName).noRecord);
}

function getGroupKey(task) {
  return normalizeText(task?.sourceGroupKey) || ROOT_SOURCE_GROUP_KEY;
}

function pickField(task, finalKey, autoKey = '') {
  const finalValue = normalizeText(task?.[finalKey]);
  if (finalValue) {
    return finalValue;
  }
  return normalizeText(autoKey ? task?.[autoKey] : '');
}

function getPassportScore(task) {
  return [
    pickField(task, 'extractedNameFinal', 'extractedNameAuto'),
    pickField(task, 'chineseNameFinal', 'chineseNameAuto'),
    pickField(task, 'passportNoFinal', 'passportNoAuto'),
    pickField(task, 'groupNoFinal', 'groupNoAuto'),
    pickField(task, 'departureDateFinal', 'departureDateAuto'),
  ].filter(Boolean).length;
}

function selectPassportContext(tasks) {
  const passportTasks = tasks.filter((task) => normalizeDocType(task?.docTypeFinal || task?.docTypeAuto) === DOC_TYPES.PASSPORT);
  if (!passportTasks.length) {
    return null;
  }

  return passportTasks.reduce((best, current) => {
    if (!best) {
      return current;
    }

    const bestScore = getPassportScore(best);
    const currentScore = getPassportScore(current);
    if (currentScore > bestScore) {
      return current;
    }

    return best;
  }, null);
}

function isReceiptLikeTask(task) {
  return normalizeDocType(task?.docTypeFinal || task?.docTypeAuto) !== DOC_TYPES.PASSPORT;
}

function isApprovedTask(task) {
  return task?.reviewed === true
    || task?.processResult === PROCESS_RESULTS.APPROVED
    || task?.processResult === 'approved';
}

function buildReceiptExportRows(tasks = [], options = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const approvedTasks = normalizedTasks.filter(isApprovedTask);
  const customerContextByGroup = options.customerContextByGroup instanceof Map
    ? options.customerContextByGroup
    : new Map();
  const tasksByGroup = new Map();

  for (const task of approvedTasks) {
    const groupKey = getGroupKey(task);
    if (!tasksByGroup.has(groupKey)) {
      tasksByGroup.set(groupKey, []);
    }
    tasksByGroup.get(groupKey).push(task);
  }
  const passportContextByGroup = new Map();
  for (const [groupKey, groupTasks] of tasksByGroup.entries()) {
    passportContextByGroup.set(groupKey, selectPassportContext(groupTasks));
  }

  const all = approvedTasks
    .filter(isReceiptLikeTask)
    .map((task) => {
      const groupKey = getGroupKey(task);
      const passportTask = passportContextByGroup.get(groupKey) || null;
      const customerContext = customerContextByGroup.get(groupKey) || {};

      const { mode, rule } = resolveTaskModeRule(task);
      const row = {
        chinese_name: pickField(passportTask, 'chineseNameFinal', 'chineseNameAuto')
          || pickField(task, 'chineseNameFinal', 'chineseNameAuto'),
        passport_name: pickField(passportTask, 'extractedNameFinal', 'extractedNameAuto')
          || pickField(task, 'extractedNameFinal', 'extractedNameAuto'),
        passport_no: pickField(passportTask, 'passportNoFinal', 'passportNoAuto')
          || pickField(task, 'passportNoFinal', 'passportNoAuto'),
        receipt_store: pickField(task, 'receiptStoreFinal', 'receiptStoreAuto'),
        receipt_no: formatReceiptNoForMode(task, rule),
        group_no: pickField(task, 'groupNoFinal', 'groupNoAuto')
          || pickField(passportTask, 'groupNoFinal', 'groupNoAuto'),
        // 真字段直填自己的列(不再借团号/姓名的位)。免税店这两个恒空。
        receipt_amount: pickField(task, 'receiptAmountFinal', 'receiptAmountAuto'),
        upstream: pickField(task, 'upstreamFinal', 'upstreamAuto'),
        purchase_date: formatBusinessDate(pickField(task, 'purchaseDateFinal', 'purchaseDateAuto')),
        departure_date: formatBusinessDate(
          pickField(task, 'departureDateFinal', 'departureDateAuto')
            || pickField(passportTask, 'departureDateFinal', 'departureDateAuto')
        ),
        agent: normalizeText(customerContext.agentName),
        receipt_date: resolveReceiptCollectedDate({ customerContext, task }),
        mode,
        note: '',
      };
      // 0731 拆掉百货借位(用户口径:「审核台 UI 是什么字段,表格就填进什么字段,不要串」)。
      // 原来按档案 exportMap 把金额塞进团号列、上家塞进姓名列 —— 审核层存的一直是真字段,
      // 借位只在这一层。但表是给上家看的:列名写着团号/姓名、值却是金额/上家,读表的人没法核。
      // 现在金额和上家各有自己的列(见 RECEIPT_EXPORT_COLUMNS),不用再借。
      const applied = applyModeRecordRule(row, rule);
      // 「不用记」行整行不进表(2026-07-24 用户拍板,逆转 07-21「保留+标注」):
      // 代理标注不用记的票不出现在任何导出表。台账族在各自出口按 isNoRecordMode 过滤;
      // 此处审核台每日收票 Excel 一律剔除(options.excludeNoRecord 保留兼容,恒剔除)。
      applied._noRecord = Boolean(rule.noRecord);
      return applied;
    });
  // 0729 静默排查 B1:剔除本身是拍板过的合法业务(2026-07-24),但**剔了多少一个字都没说**。
  // 操作员核对"今天收了多少票"时,表里行数比审核通过的收据数少,只能自己数、自己猜。
  // 交付包那边已经用【图在包里·账不在单上】解释了同一件事,这个出口一直没有。
  const noRecordExcluded = all.filter((row) => row._noRecord).length;
  const kept = all
    .filter((row) => !row._noRecord)
    .map(({ _noRecord, ...row }) => row);
  // 挂成不可枚举:调用方都把它当纯数组用(遍历/写 sheet/拼 CSV),
  // 不能搅动数组行为与 JSON 序列化。
  Object.defineProperty(kept, 'noRecordExcluded', {
    value: noRecordExcluded, enumerable: false, writable: false,
  });
  return kept;
}

// 任务是百货则返回其档案,否则 null(免税店/未知店都走 null)。
function getDeptProfile(task) {
  const store = normalizeStoreFamily(pickField(task, 'receiptStoreFinal', 'receiptStoreAuto'));
  const profile = getStoreProfile(store);
  return profile.family === FAMILY.DEPT ? profile : null;
}

// 机场票没有团号表行(团号="无"),模式永远不可能走到 matched——
// 用 Excel 自己给的判定口径推断:团号"无" + 小票号前两位 15/17 = 机场票。
const AIRPORT_MODE = '新世界机场-振华';

// 模式解析(每行只算一次)——⭐任务→模式的**单一真相源**(2026-07-20 行为三合一):
// 分桶(mode_delivery)/DSL scope(export_plan_engine)/台账桥票号形态/审核台导出列过滤全走这里,
// 优先级:百货档案常量 > 审核员人选(modeManualPick)> 预匹配快照(matched 的 modeRawPre)> 机场推断。
// 台账 mode_raw(结算后终匹配/人工补救)是更高一层,由消费方按 sourceTaskId 先查台账再回落本函数。
// 返回 { mode, rule, source }:source=解析来源(dept/pick/snapshot/airport/''),
// 台账桥用它区分哈希投影(pick/airport 是 2026-07-20 新进格式化路径的类别,去重哈希
// 必须保持数字投影与存量兼容;snapshot/matched 老路径哈希口径不动)。
function resolveTaskModeRule(task) {
  // 百货(P4):模式=档案常量。必须先于 matched 判断——百货 groupNoMatchStatus 恒为空。
  const deptProfile = getDeptProfile(task);
  if (deptProfile) {
    return { mode: deptProfile.mode, rule: lookupModeRecordRule(deptProfile.mode), source: 'dept' };
  }
  // 审核员人选模式(歧义/**表外**人工裁决,绑定当时团号,prematch 守卫自动作废过期值):
  // 人的裁决高于快照——"我审核了该模式但导出里没进去"的病根:表外团号人选后
  // status 仍是 not_found(prematch 只在歧义/店不符时升 matched),旧的 matched 门闩把人选挡在外。
  const manualPick = normalizeText(task?.modeManualPick);
  if (manualPick) {
    return { mode: manualPick, rule: lookupModeRecordRule(manualPick), source: 'pick' };
  }
  // 预匹配快照:**不锁 matched**——prematch 每次 PATCH 都同步(miss 即清空),快照非空即当前
  // 徽章所见;分桶/scope/切片选择器历史上也都无条件读它,锁门闩会把存量老批次打成未归类。
  const snapshot = normalizeText(task?.modeRawPre);
  if (snapshot) {
    return { mode: snapshot, rule: lookupModeRecordRule(snapshot), source: 'snapshot' };
  }
  const status = String(task?.groupNoMatchStatus || '');
  // 无团号(字面量「无」=no_group;表态none+空值=写入层回填前的存量行,lib/no_tour 单源):
  // 两条路同吃机场推断——此前表态行 status 恒空,同一张机场票打字「无」出机场模式、
  // 点「无团号·直接确认」丢成空模式,三处出口(小票导出/交付包/客户Excel)产物分家。
  if (status === 'no_group' || hasNoTourStance(task)) {
    const receiptDigits = String(pickField(task, 'receiptNoFinal', 'receiptNoAuto') || '').replace(/\D/g, '');
    if (isNoTourTask(task) && /^1[57]/.test(receiptDigits)) {
      return { mode: AIRPORT_MODE, rule: lookupModeRecordRule(AIRPORT_MODE), source: 'airport' };
    }
  }
  return { mode: '', rule: lookupModeRecordRule(''), source: '' };
}

// 小票号导出形态(2026-07-07):存储层保原样(带杠带字母,便于审核员核对票面),
// **导出瞬间按模式格式化**——审核台照旧带杠,只有台账/交付包的最终值按下表出:
//   digits13 / digits14 / letters14 → 剥掉所有杠/空格(乐天14位、新罗系13位纯数字;
//       济州乐天V特殊留字母)。金标实测票面结构:乐天 6-2-6、新罗系 2-3-3-4-1,但输出要纯串。
//   dashed19 → 按金标唯一结构 2-6-3-5(16位数字+3杠)带杠(现代/新世界机场)。已带杠原样;
//       干净16位数字则补杠;数字核以审核值为准(审核员改过不被原串覆盖)。
//   '' / 未知 → 原样输出(普通模式不折腾)。
const alnumOnly = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function formatDashed19(digits) {
  // 2-6-3-5:第 2、8、11 位后各一个杠
  return `${digits.slice(0, 2)}-${digits.slice(2, 8)}-${digits.slice(8, 11)}-${digits.slice(11)}`;
}

function formatReceiptNoForMode(task, rule) {
  const stored = normalizeText(pickField(task, 'receiptNoFinal', 'receiptNoAuto'));
  const form = rule.receiptNoForm;

  if (form === 'digits13' || form === 'digits14' || form === 'letters14') {
    // 剥杠/空格,留字母数字核(alnum);乐天/新罗系→纯数字串,济州乐天V特殊→留字母
    return alnumOnly(stored) || stored;
  }

  if (form === 'dash44') {
    // 百货거래번호(0727反馈#13/#14):票面印 4位-4位 带杠,导出一律按票面形态——
    // 已带杠原样;8位纯数字(乐天旧口径存量/人工省杠输入)补杠 4-4;其余形态原样不硬凑。
    if (stored.includes('-')) return stored;
    const digits8 = stored.replace(/\D/g, '');
    return digits8.length === 8 ? `${digits8.slice(0, 4)}-${digits8.slice(4)}` : stored;
  }

  if (form === 'dashed19') {
    if (stored.includes('-')) {
      return stored; // 已带杠(存储原样),不动
    }
    // 优先用 OCR 原串补杠(数字核与审核值一致才敢用),否则干净16位数字按 2-6-3-5 补
    const raw = normalizeText(task?.receiptNoRawAuto);
    if (raw && raw.includes('-') && alnumOnly(raw) === alnumOnly(stored)) {
      return raw.toUpperCase();
    }
    const digits = stored.replace(/\D/g, '');
    return digits.length === 16 ? formatDashed19(digits) : stored;
  }

  return stored; // '' / 未知模式
}

// 《所有模式小票具体记录流程》出口过滤:审核照常全字段,导出时按模式抹掉"不用记录"的列。
// 未知模式 rule.known=false → 全列照记(普通模式),绝不特殊拦。免税店列是系统列,恒保留。
function applyModeRecordRule(row, rule) {
  const notes = [];
  if (rule.known) {
    const colToRowKeys = {
      recordDate: ['receipt_date'],
      agent: ['agent'],
      purchaseDate: ['purchase_date'],
      receiptNo: ['receipt_no'],
      groupNo: ['group_no'],
      name: ['chinese_name', 'passport_name'],
      passportNo: ['passport_no'],
      departureDate: ['departure_date'],
    };
    for (const [col, rowKeys] of Object.entries(colToRowKeys)) {
      if (rule.columns[col] === false) {
        for (const key of rowKeys) row[key] = '';
      }
    }
    if (rule.note) notes.push(rule.note);
  }
  if (rule.actions.length) notes.push(...rule.actions.map((a) => `【${a}】`));
  // 「不用记」尾巴:行保留但显式标注(静默删行会让人以为丢票;人工按标注处理)
  if (rule.noRecord) notes.unshift('【代理标注:不用记】');
  row.note = [...new Set(notes)].join(' ');
  return row;
}

// 便捷包装:按模式名(团号表的 modeRawPre)格式化票号,供交付包等出口复用,与台账同口径。
function formatReceiptNoByMode(task, modeName) {
  return formatReceiptNoForMode(task, lookupModeRecordRule(modeName));
}

module.exports = {
  RECEIPT_EXPORT_COLUMNS,
  RECEIPT_EXPORT_HEADERS,
  buildReceiptExportRows,
  formatBusinessDate,
  formatDateParts, // 取某时刻的 YYYY-MM-DD(默认 Asia/Seoul):交付包"导出当天"顶层夹名唯一 KST 真源,禁 toISOString(UTC)副本
  formatReceiptNoForMode,
  formatReceiptNoByMode,
  resolveTaskModeRule,
  getCustomerIdDate, // 客户编号 CLyyyymmdd → KST 上传日
  resolveReceiptCollectedDate, // 批次任务的收票日期(=上传那天)唯一口径
  resolveCollectedDateFromLedgerRow, // 台账/月度行的收票日期(=上传那天)
  isNoRecordMode, // 「不用记」模式判定(台账族出口统一过滤)
};
