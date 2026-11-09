'use strict';

/**
 * export_plan_engine — 配置台 P2:文件夹导出计划引擎(纯函数,不碰磁盘)。
 *
 * ⭐架构裁决(2026-07-14,偏离原执行指令并有意为之):
 *   既有四规则/乐天百货包 **不** 改写成 DSL——把一套在产的复杂管线重写成配置再逐路径对照,
 *   等于造第二个真相源,正是本仓库反复吃亏的"副本失步"病(cb24667/字段清洗20处 前科)。
 *   它们在配置台登记为 builtin 计划,预览直接调老 planner(planModeDelivery/planDelivery),零漂移。
 *   本引擎只服务 **新增的简单计划**(新上家=按几个字段分层+命名,业务真实高频诉求),
 *   这类计划天生没有旧行为要对照,DSL 是它们的第一真相源。
 *
 * 计划 payload(kind='export_plan'):
 *   { planLabel, builtin: 'mode_delivery'|'lotte_dept' }        ← 内置引用型(引擎不处理)
 *   或 DSL 型:
 *   {
 *     planLabel: '按团号整理示例',
 *     scope:   { modes: ['乐天SG-本司'] },        // 命中哪些渠道模式(canonical);空数组=全部
 *     levels:  [ { template: '{groupNo}' } ],     // 文件夹层级,1..3 层
 *     naming:  { template: '{name}{passportNo:0,4}_{docLabel}{i}' },  // 叶子文件名(无扩展名)
 *     includes: ['receipt', 'passport'],          // 拷哪些件:receipt|passport|other
 *     emptyPolicy: 'block_prefix',                // block_prefix(默认拍板)|skip_log
 *     duplicate: 'suffix'                         // 重名 _2/_3(唯一实现)
 *   }
 *
 * 模板 token:
 *   {字段key}        取任务/组值(见 TOKEN_SOURCES;组级 token 取组内首个非空)
 *   {字段key:a,b}    切片(如 {passportNo:0,4} 取前4位)
 *   {docLabel} {i}   件类中文标签(小票/护照/其他)与件内序号(naming 专用)
 *   {mode} {groupNo} {name} {passportNo} {receiptNo} {customerId} 为最常用组级/票级值
 */

const pathPosix = require('node:path').posix;
const { FIELD_REGISTRY } = require('./field_registry');
const { parseCustomerRefFromTask } = require('./customer_ref');
const { BUILTIN_PLAN_KEYS } = require('./builtin_export_plan_specs');
const { resolveCanonicalModeName } = require('./mode_record_matrix');
const { resolveTaskModeRule } = require('./workbench_receipt_export');

// ── Excel 明细表列词汇(P3b):key=台账 daily_receipt_export 列名,导出层单源 ──
// need = 冲突检查v2的来源要求:system(恒有)/receipt-base:<finalKey>(小票基线)/
//        passport:<finalKey>(护照基线)/dept:<档案字段>(仅百货有来源)
const EXCEL_COLUMN_DEFS = Object.freeze({
  stmt_date: { header: '收票日期', need: 'system', width: 13 },
  agent: { header: '代理', need: 'system', width: 14 },
  mode_raw: { header: '模式', need: 'system', width: 22 },
  shop: { header: '免税店', need: 'receipt-base:receiptStoreFinal', width: 16 },
  purchase_date: { header: '购买日期', need: 'receipt-base:purchaseDateFinal', width: 13 },
  departure_date: { header: '出境日期', need: 'receipt-base:departureDateFinal', width: 13 },
  receipt_no: { header: '小票号/交易编号', need: 'receipt-base:receiptNoFinal', width: 20 },
  tour_no: { header: '团号', need: 'receipt-base:groupNoFinal', width: 14 },
  name: { header: '护照姓名', need: 'passport:extractedNameFinal', width: 18 },
  passport_no: { header: '护照号', need: 'passport:passportNoFinal', width: 15 },
  brand: { header: '品牌', need: 'dept:brand', width: 16 },
  gross_krw: { header: '交易金额(￦)', need: 'dept:receiptAmount', width: 15 },
  branch: { header: '门店编号', need: 'dept:branch', width: 14 },
  upstream: { header: '上家', need: 'dept:upstream', width: 12 },
});

// DSL 模板 token → 同一套来源要求(冲突检查v2共用;system=引擎/系统生成恒有)
const TOKEN_REQUIREMENTS = Object.freeze({
  docLabel: 'system', i: 'system', customerId: 'system', mode: 'system',
  name: 'passport:extractedNameFinal',
  passportNo: 'passport:passportNoFinal',
  extractedName: 'passport:extractedNameFinal',
  receiptStore: 'receipt-base:receiptStoreFinal',
  receiptNo: 'receipt-base:receiptNoFinal',
  groupNo: 'receipt-base:groupNoFinal',
  purchaseDate: 'receipt-base:purchaseDateFinal',
  departureDate: 'receipt-base:departureDateFinal',
  receiptAmount: 'dept:receiptAmount',
  branch: 'dept:branch',
  brand: 'dept:brand',
  upstream: 'dept:upstream',
  receiptNoRaw: 'receipt-base:receiptNoFinal',
});
function tokenRequirement(token) {
  return TOKEN_REQUIREMENTS[token] || 'system';
}

const DOC_LABELS = Object.freeze({ receipt: '小票', passport: '护照', other: '其他' });

// token → 从(task, group)取值。字段注册表 exportable 的 *_Final||*_Auto 自动可用(去掉 Final 后缀作 token 名)。
const TOKEN_SOURCES = (() => {
  const map = new Map();
  for (const field of FIELD_REGISTRY) {
    if (!field.exportable) continue;
    const base = field.key.replace(/Final$/, '').replace(/Auto$/, '');
    const finalKey = `${base}Final`;
    const autoKey = `${base}Auto`;
    map.set(base, (task) => String(task?.[finalKey] ?? task?.[field.key] ?? task?.[autoKey] ?? '').trim());
  }
  // 常用别名/组级
  map.set('name', (task) => String(task?.extractedNameFinal || task?.extractedNameAuto || '').trim());
  // {mode}=任务级模式单源(百货档案常量/人选/matched快照/机场推断)——此前直读 modeRawPre,
  // 百货票恒空、人选模式渲染不出来(行为三合一,与 scope 圈选同源)
  map.set('mode', (task) => String(resolveTaskModeRule(task).mode || '').trim());
  map.set('groupNo', (task) => String(task?.groupNoFinal || task?.groupNoAuto || '').trim());
  map.set('receiptNo', (task) => String(task?.receiptNoFinal || task?.receiptNoAuto || '').trim());
  map.set('passportNo', (task) => String(task?.passportNoFinal || task?.passportNoAuto || '').trim());
  return map;
})();

const KNOWN_EXTRA_TOKENS = new Set(['docLabel', 'i', 'customerId']);
const TEMPLATE_TOKEN_RE = /\{([A-Za-z][A-Za-z0-9_]*)(?::(\d+),(\d+))?\}/g;

function listTemplateTokens(template) {
  const tokens = [];
  let match;
  TEMPLATE_TOKEN_RE.lastIndex = 0;
  while ((match = TEMPLATE_TOKEN_RE.exec(String(template || '')))) {
    tokens.push(match[1]);
  }
  return tokens;
}

/** 校验计划形状:未知 token/层数/枚举 一票否决(拒存,绝不半信半疑落盘)。 */
function validateExportPlan(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload 不是对象' };
  }
  if (payload.builtin !== undefined) {
    // 白名单=builtin_export_plan_specs 键清单单源(2026-07-16 收编后 5 键,别在这写死)
    if (!BUILTIN_PLAN_KEYS.includes(payload.builtin)) {
      return { ok: false, reason: `未知 builtin:${payload.builtin}` };
    }
    return { ok: true, kind: 'builtin' };
  }
  // Excel 明细表变体(P3b):{ excel: { columns:[台账列key] }, scope } —— 与 levels 文件夹型互斥
  if (payload.excel !== undefined) {
    if (payload.levels !== undefined || payload.naming !== undefined) {
      return { ok: false, reason: 'excel 计划不能同时带 levels/naming(两种类型二选一)' };
    }
    const cols = payload.excel && payload.excel.columns;
    if (!Array.isArray(cols) || !cols.length) return { ok: false, reason: 'excel.columns 必须是非空数组' };
    for (const key of cols) {
      if (!EXCEL_COLUMN_DEFS[key]) return { ok: false, reason: `未知台账列 ${key}` };
    }
    if (new Set(cols).size !== cols.length) return { ok: false, reason: 'excel.columns 有重复' };
    if (payload.scope !== undefined) {
      if (typeof payload.scope !== 'object' || Array.isArray(payload.scope)
        || (payload.scope.modes !== undefined && !Array.isArray(payload.scope.modes))) {
        return { ok: false, reason: 'scope.modes 必须是数组' };
      }
    }
    return { ok: true, kind: 'excel' };
  }
  const levels = payload.levels;
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > 3) {
    return { ok: false, reason: 'levels 必须是 1..3 层' };
  }
  const templates = [...levels.map((l) => l?.template), payload.naming?.template];
  for (const template of templates) {
    if (typeof template !== 'string' || !template.trim()) {
      return { ok: false, reason: '层级/命名模板不能为空' };
    }
    for (const token of listTemplateTokens(template)) {
      if (!TOKEN_SOURCES.has(token) && !KNOWN_EXTRA_TOKENS.has(token)) {
        return { ok: false, reason: `未知模板字段 {${token}}(只能引用字段注册表可导出字段)` };
      }
    }
  }
  const includes = payload.includes;
  if (!Array.isArray(includes) || !includes.length
    || includes.some((d) => !['receipt', 'passport', 'other'].includes(d))) {
    return { ok: false, reason: 'includes 必须是 receipt/passport/other 的非空子集' };
  }
  if (payload.scope !== undefined) {
    if (typeof payload.scope !== 'object' || Array.isArray(payload.scope)
      || (payload.scope.modes !== undefined && !Array.isArray(payload.scope.modes))) {
      return { ok: false, reason: 'scope.modes 必须是数组' };
    }
  }
  if (payload.emptyPolicy !== undefined && !['block_prefix', 'skip_log'].includes(payload.emptyPolicy)) {
    return { ok: false, reason: `emptyPolicy 非法:${payload.emptyPolicy}` };
  }
  return { ok: true, kind: 'dsl' };
}

// 与交付链同口径的文件夹清洗(非法字符→_;首尾空白/点去掉)
function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80);
}

function renderTemplate(template, resolveToken) {
  const missing = [];
  const text = String(template || '').replace(TEMPLATE_TOKEN_RE, (_, token, from, to) => {
    let value = resolveToken(token);
    if (from !== undefined) value = String(value || '').slice(Number(from), Number(to));
    if (!String(value || '').trim()) missing.push(token);
    return String(value || '');
  });
  return { text, missing };
}

function docTypeOf(task) {
  const d = String(task?.docTypeFinal || task?.docTypeAuto || '').toLowerCase();
  if (d === 'passport') return 'passport';
  if (d === 'receipt') return 'receipt';
  return 'other';
}

/**
 * 解析 DSL 计划 → 路径清单(不落盘)。
 * groups: [{ customerId, label, tasks: [task] }](调用方按客户组喂;task 需带 sourcePath 供拷贝)
 * 返回 { entries:[{srcPath,destPath,taskId}], blocked:[{reason,taskId,customerId}], skipped:[...], stats }
 */
function resolveExportPlan(plan, groups = []) {
  const verdict = validateExportPlan(plan);
  if (!verdict.ok) throw new Error(`导出计划不合法:${verdict.reason}`);
  if (verdict.kind === 'builtin') throw new Error('builtin 计划由老 planner 处理,引擎只吃 DSL 计划');

  // A4(2026-07-16 同步一致性审计):scope 匹配双方归一到正名——此前裸串精确比对,团号表里的
  // 别名写法/带尾巴串(如「(发小票17)」)的票会静默漏出 scope,而冲突检查按正名判说没问题(口径分裂)。
  const scopeModes = new Set(
    (plan.scope?.modes || []).map((m) => resolveCanonicalModeName(String(m).trim())).filter(Boolean),
  );
  const inScopeMode = (raw) => scopeModes.has(resolveCanonicalModeName(String(raw || '').trim()));
  const emptyPolicy = plan.emptyPolicy || 'block_prefix';
  const entries = [];
  const blocked = [];
  const skipped = [];
  const collisions = []; // 跨客户重名(复核MEDIUM):不同客户落同一路径=模板区分度不够,单列示警
  const missingSource = []; // 任务图缺失/路径解析失败(sourcePath 空=图被清理/盘故障):此前静默少图,单列示警(审计MEDIUM)
  const usedDest = new Map(); // destBase → { count, customers:Set }(重名 _2/_3 + 撞名归因)

  for (const group of groups) {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    // 断点⑤(2026-07-20 行为三合一):scope 圈选按任务级模式单源判——此前只认 modeRawPre,
    // 百货票(恒空)/人选模式票永远出 scope,冲突检查却按字段来源判绿灯,配置台绿灯运行时恒空。
    const inScope = !scopeModes.size
      || tasks.some((t) => inScopeMode(resolveTaskModeRule(t).mode));
    if (!inScope) { skipped.push({ customerId: group.customerId, reason: '模式不在计划范围' }); continue; }
    if (tasks.some((t) => docTypeOf(t) !== 'other' && !t.reviewed)) {
      skipped.push({ customerId: group.customerId, reason: '整组未审核完' });
      continue;
    }

    // 组级 token 取组内首个非空(与老 planner personKey 同思路)
    const groupToken = (token) => {
      const source = TOKEN_SOURCES.get(token);
      if (!source) return '';
      for (const t of tasks) { const v = source(t); if (v) return v; }
      return '';
    };

    const perDocIndex = { receipt: 0, passport: 0, other: 0 };
    for (const task of tasks) {
      const docType = docTypeOf(task);
      if (!plan.includes.includes(docType)) continue;
      // L117(2026-07-23 拍板「只放本渠道的票」):scope 指定了模式时,**小票**按票级模式过滤——
      // 混模式客户的范围外模式小票不进本上家包(与 mode_delivery 按票分桶同口径,不再整组带出)。
      // 护照/other 无渠道模式,不参与过滤(仍按 plan.includes 收);scope.modes 为空=不筛(维持现状)。
      // 用与组级 inScope 判定(:234)完全相同的 resolveTaskModeRule+inScopeMode 谓词,口径一致。
      if (scopeModes.size && docType === 'receipt' && !inScopeMode(resolveTaskModeRule(task).mode)) {
        skipped.push({ customerId: group.customerId, taskId: task.id, reason: '票级模式不在计划范围' });
        continue;
      }
      const srcPath = String(task?.sourcePath || '').trim();
      if (!srcPath) {
        // 图路径解析失败(sourcePath 空=图被清理/盘故障)不再静默 continue:计入 missingSource,
        // 与 copyFailed 同款出包前可见,否则包内静默少这张图、预检/回执零提示(审计MEDIUM)。
        missingSource.push({ customerId: group.customerId, taskId: task.id, docType, reason: '任务图缺失/路径解析失败' });
        continue;
      }
      perDocIndex[docType] += 1;

      const resolveToken = (token) => {
        if (token === 'docLabel') return DOC_LABELS[docType];
        if (token === 'i') return String(perDocIndex[docType]);
        if (token === 'customerId') return String(group.customerId || '');
        const perTask = TOKEN_SOURCES.get(token)?.(task) || '';
        return perTask || groupToken(token);
      };

      const segments = [];
      const missingAll = [];
      for (const level of plan.levels) {
        const { text, missing } = renderTemplate(level.template, resolveToken);
        segments.push(sanitizeSegment(text));
        missingAll.push(...missing);
      }
      const named = renderTemplate(plan.naming.template, resolveToken);
      missingAll.push(...named.missing);

      if (missingAll.length) {
        if (emptyPolicy === 'skip_log') {
          skipped.push({ customerId: group.customerId, taskId: task.id, reason: `缺{${missingAll[0]}}` });
          continue;
        }
        // block_prefix(拍板默认):进 blocked 名单,建议名带缺失前缀(S活动缺票号先例)
        blocked.push({
          customerId: group.customerId,
          taskId: task.id,
          reason: `缺{${missingAll[0]}}`,
          suggested: `缺${missingAll[0]}_${sanitizeSegment(named.text) || task.id}`,
        });
        continue;
      }

      const ext = (srcPath.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
      const baseDest = pathPosix.join(...segments, sanitizeSegment(named.text));
      const slot = usedDest.get(baseDest) || { count: 0, customers: new Set() };
      if (slot.count > 0 && !slot.customers.has(String(group.customerId || ''))) {
        collisions.push({
          destBase: baseDest,
          customers: [...slot.customers, String(group.customerId || '')],
          reason: '不同客户落进同一路径(模板缺少区分字段,如姓名/护照前4/客户号)',
        });
      }
      slot.count += 1;
      slot.customers.add(String(group.customerId || ''));
      usedDest.set(baseDest, slot);
      const destPath = `${baseDest}${slot.count > 1 ? `_${slot.count}` : ''}${ext}`;
      if (destPath.length > 240) {
        blocked.push({ customerId: group.customerId, taskId: task.id, reason: `路径过长(${destPath.length}>240,Windows解压会炸)` });
        continue;
      }
      entries.push({ srcPath, destPath, taskId: task.id });
    }
  }

  return {
    entries,
    blocked,
    skipped,
    collisions,
    missingSource,
    stats: {
      entries: entries.length,
      blocked: blocked.length,
      skipped: skipped.length,
      collisions: collisions.length,
      missingSource: missingSource.length,
      groups: groups.length,
    },
  };
}

/**
 * 批次任务 → 客户组(DSL 预览/落盘共用的**唯一**分组器;复核HIGH教训:
 * 分组必须按客户库ID,文件夹/团号粒度会跨客户借值)。resolveTaskFile 由调用方注入。
 */
function buildCustomerGroups(batch, resolveTaskFile) {
  const byGroup = new Map();
  for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
    const ref = parseCustomerRefFromTask(task);
    const key = ref.customerId
      ? `${ref.workspaceKey}/${ref.customerId}`
      : `task:${String(task?.id || byGroup.size)}`;
    if (!byGroup.has(key)) byGroup.set(key, { customerId: ref.customerId || String(task?.id || key), tasks: [] });
    byGroup.get(key).tasks.push({ ...task, sourcePath: resolveTaskFile ? resolveTaskFile(task) : '' });
  }
  return [...byGroup.values()];
}

module.exports = {
  validateExportPlan,
  resolveExportPlan,
  buildCustomerGroups,
  listTemplateTokens,
  sanitizeSegment,
  tokenRequirement,
  EXCEL_COLUMN_DEFS,
};
