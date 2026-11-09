'use strict';

/**
 * mode_record_matrix — 《所有模式小票具体记录流程.xlsx》的代码化(2026-07,源文件存 docs/)。
 *
 * 定位(用户拍板的架构):**统一审核 + 出口过滤**。
 *   - 审核台对所有模式一律全字段审(数据都在),这张表**只作用于导出层**:
 *     决定台账里该模式记哪些列、小票号输出成什么形态、要不要提示动作(发群/红标签)。
 *   - 未知模式 = 普通模式:全列照记、照常结算,绝不特殊拦截。
 *   - 小票号带杠/带字母是**导出格式问题**(用 receiptNoRawAuto 原串还原),永远不进审核员的手。
 *
 * 模式名匹配:团号表里的模式串带各种小尾巴(「（发小票17）」「（单独整理）」「不用记」…),
 * 归一化后按基名查;尾巴本身转成 actions/flags 保留语义。
 */

// 台账 8 个记录列(列序与 Excel 一致)。true=记录 false=不用记录。
const ALL = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});
// 简记模式(只记 收票日期/代理/团号)
const SLIM = Object.freeze({
  recordDate: true, agent: true, purchaseDate: false, receiptNo: false,
  groupNo: true, name: false, passportNo: false, departureDate: false,
});
// 现代-JEOCU(现代免税店渠道):简记 + 小票号(带杠19位)
const SLIM_WITH_RECEIPT = Object.freeze({ ...SLIM, receiptNo: true });

// receiptNoForm:导出时小票号的形态提示(纯信息,导出层据此选 raw 还原或原样输出)
//   digits13 / digits14        纯数字定长
//   dashed19                   要带 "-",加杠共 19 位(机场/现代)
//   letters14                  含英文字母,加字母共 14 位(济州乐天V特殊)
//   ''                         不记小票号或无特殊形态
const MATRIX = [
  { mode: '新世界SG-荣晨国际', columns: SLIM, receiptNoForm: '' },
  { mode: '济州新罗SG-道辉', columns: SLIM, receiptNoForm: '' },
  { mode: '济州新罗SG-宋总', columns: SLIM, receiptNoForm: '' },
  { mode: '新罗PKG-孙恩子', columns: ALL, receiptNoForm: 'digits13', actions: ['及时发上家'], note: '需小票17及时发上家群' },
  { mode: '新罗SG-新琪', columns: SLIM, receiptNoForm: '' },
  { mode: '新世界机场-振华', columns: ALL, receiptNoForm: 'dashed19', groupNoLiteral: '无', note: '无团号,团号写"无";印花+小票号前两位15/17判定机场票' },
  { mode: '爱宝客PKG-本司', columns: ALL, receiptNoForm: 'digits13' },
  { mode: '爱宝客SG-本司', columns: ALL, receiptNoForm: 'digits13' },
  { mode: '济州新罗V团-本司', columns: ALL, receiptNoForm: 'digits13' },
  { mode: '乐天H团（原乐天V）-本司', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '乐天SG-本司', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '乐天釜山P特殊-本司', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '乐天釜山SG-本司', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '济州乐天V团特殊-道辉', columns: ALL, receiptNoForm: 'letters14', actions: ['及时发上家'], note: '需小票18及时发上家群;小票号含英文字母' },
  { mode: '乐天R团', columns: ALL, receiptNoForm: 'digits14', note: '团号有英文字母' },
  { mode: '乐天首尔V团-乐天免税店', columns: ALL, receiptNoForm: 'digits14', note: '团号有英文字母' },
  { mode: '乐天PKG-新琪', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '新罗V团-新琪', columns: SLIM, receiptNoForm: '' },
  { mode: '乐天B团-joy', columns: ALL, receiptNoForm: 'digits14' },
  { mode: '现代-JEOCU', columns: SLIM_WITH_RECEIPT, receiptNoForm: 'dashed19' },
  { mode: '济州乐天SG-道辉', columns: SLIM, receiptNoForm: '', actions: ['按团号单独整理'], note: '需按团号单独整理分类' },
  { mode: '乐天H团-S活动', columns: ALL, receiptNoForm: 'digits14', actions: ['S活动红标签'], note: 'S活动按小票红色标签判定,无标签需代理告知' },
  { mode: '乐天SG-S活动', columns: ALL, receiptNoForm: 'digits14', actions: ['S活动红标签'], note: 'S活动按小票红色标签判定,无标签需代理告知' },
  { mode: '新世界SG-振华', columns: SLIM, receiptNoForm: '' },
  // ── 2026-07-12 团号表审计新收编(用户拍板:全记)──
  { mode: '新罗V团-本司', columns: ALL, receiptNoForm: 'digits13', note: '2026-07-12 拍板全记;与新罗V团-新琪同店双代理,团号撞号时预匹配强制人选' },
  { mode: '新世界PKG-宋总', columns: ALL, receiptNoForm: 'dashed19', note: '2026-07-12 拍板全记' },
  // ── 百货(P4,2026-07-08):模式=店名常量(无团号,桥接注入),列配置先全列照记,
  //    等上家实际反馈再收窄。
  //    ⚠️ 借位(金额→团号列/上家→姓名列)0731 已连根拔掉(用户口径「什么字段就填什么列」),
  //    金额与上家在导出表里各有专列。这段注释 2026-08-01 才跟上,别再照旧版理解。
  // 0727反馈#13/#14:三家百货交易编号导出一律按票面 4位-4位 带杠(dash44:已带杠原样,
  // 8位存量/人工省杠输入补杠)。乐天原「8位不打-」系旧规范假设,用户看导出实件后推翻。
  { mode: '乐天百货', columns: ALL, receiptNoForm: 'dash44', note: '百货无团号;交易编号4-4带杠(0727拍板,旧8位不打-作废);金额/门店/品牌落专列' },
  // ⚠️ note 会**逐行写进每日收票 Excel 的备注列**(workbench_receipt_export:368 notes.push(rule.note)),
  // 所以这里写错的话,是直接写到上家和审核员眼前的。
  // 0731 用户口径「什么字段就填什么列,不要串」已经把借位连根拔掉(见 lib/store_profiles.js 头部
  // 与 lib/workbench_receipt_export.js:22),这两条却还在教人「金额→团号列/上家→姓名列」——
  // 谁照着这句去对账就对错列。2026-08-01 删掉。
  { mode: '新世界百货', columns: ALL, receiptNoForm: 'dash44', note: '百货无团号;交易编号4-4带杠;金额/上家各有专列(0731 起不再借位)' },
  { mode: '现代百货', columns: ALL, receiptNoForm: 'dash44', note: '百货无团号;交易编号8位4-4带杠原样(2026-07-12实票纠正,原16位2-6-3-5系现代免税店BILL NO误借);金额/上家各有专列(0731 起不再借位)' },
];

// 尾巴 → 语义动作(团号表模式串里手写的备注型后缀)
const SUFFIX_ACTIONS = [
  { re: /发小票17/, action: '及时发上家' },
  { re: /发小票18/, action: '及时发上家' },
  { re: /发12号/, action: '发12号' },
  { re: /单独整理/, action: '按团号单独整理' },
];

// 模式名归一:去空白、ASCII 大写化、全角括号统一、剥尾部括号备注与「不用记/不用记录」尾巴。
// 注意「乐天H团（原乐天V）-本司」的括号在名字中间,是名字本体——只剥**尾部**括号。
// 大写化:2026-07-12 生产团号表实测 251 行写「爱宝客pkg-本司」(小写 pkg)→ 查矩阵
// 落空走默认全记,digits13 形态提示丢失;代理手打大小写不可控,归一层折叠。
function normalizeModeName(raw) {
  let s = String(raw || '').trim()
    .replace(/\s+/g, '')
    .replace(/[a-z]+/g, (m) => m.toUpperCase())
    .replace(/[()]/g, (m) => (m === '(' ? '（' : '）'));
  for (;;) {
    const before = s;
    s = s.replace(/（[^（）]*）$/, '').replace(/不用记录?$/, '').trim();
    if (s === before) break;
  }
  return s;
}

const BY_NAME = new Map(MATRIX.map((row) => [normalizeModeName(row.mode), row]));
// 表侧拼写别名(2026-07-12 生产表直方图实锤):代理写的名字与矩阵名同义不同形,
// 归一化解不开的在这里显式建桥——**只加实锤出现过的拼写**,别猜。
//   「乐天H团-本司（原乐天V-本司）」×10141:尾括号剥掉后=「乐天H团-本司」,
//   与矩阵名「乐天H团（原乐天V）-本司」(括号在中间,是名字本体)对不上。
const MODE_ALIASES = [
  ['乐天H团-本司', '乐天H团（原乐天V）-本司'],
];
for (const [alias, canonical] of MODE_ALIASES) {
  const row = BY_NAME.get(normalizeModeName(canonical));
  if (row && !BY_NAME.has(normalizeModeName(alias))) {
    BY_NAME.set(normalizeModeName(alias), row);
  }
}

// 默认(未知模式)= 普通模式:全列照记,照常结算。known=false 仅供导出层想标注时用。
const DEFAULT_RULE = Object.freeze({
  mode: '', known: false, columns: ALL, receiptNoForm: '', actions: [], note: '', noRecord: false, groupNoLiteral: '',
});

/**
 * 规则合成:矩阵行(或配置行)+ 原串 → 最终规则。
 * 尾巴动作(发小票17/单独整理…)与「不用记」永远按**原串**现算——
 * 配置台 resolver 也复用这一份,绝不抄第二份(配置台P0)。
 */
function composeModeRule(hit, modeRaw) {
  const raw = String(modeRaw || '').trim();
  // 尾巴动作:矩阵内建 + 原串手写后缀(去重)
  const actions = new Set(hit && hit.actions ? hit.actions : []);
  for (const { re, action } of SUFFIX_ACTIONS) {
    if (re.test(raw)) actions.add(action);
  }
  // 「不用记」尾巴 = 代理明说这票不入台账(导出层跳过行,审核照常)
  const noRecord = /不用记录?/.test(raw);
  if (!hit) {
    return { ...DEFAULT_RULE, mode: raw, actions: [...actions], noRecord };
  }
  return {
    mode: hit.mode,
    known: true,
    columns: hit.columns,
    receiptNoForm: hit.receiptNoForm || '',
    actions: [...actions],
    note: hit.note || '',
    noRecord,
    groupNoLiteral: hit.groupNoLiteral || '',
  };
}

// ── 运行时配置挂钩(配置台P0)────────────────────────────────────────────
// server 启动时挂 DB resolver:命中返回规则、未配置/坏配置返回 null → 回落下方出厂查询。
// 未挂钩(单测/脚本/前端构建)= 出厂行为,与挂钩前逐字节一致——系统永不因配置挂。
let runtimeModeRuleResolver = null;
function setModeRuleResolver(fn) {
  runtimeModeRuleResolver = typeof fn === 'function' ? fn : null;
}

/**
 * 查模式记录规则。永不 throw、永不返回 null——查不到给默认全记录。
 * @param {string} modeRaw 团号表里的模式原串(可带「（发小票17）」「不用记」等尾巴)
 */
function lookupModeRecordRule(modeRaw) {
  const raw = String(modeRaw || '').trim();
  if (!raw) return DEFAULT_RULE;
  if (runtimeModeRuleResolver) {
    // 兜底(复核HIGH):本函数承诺永不 throw 且服务台账/结算热路径——
    // 挂钩函数任何异常一律按"未命中"回落出厂,绝不让配置层把导出打成 500。
    try {
      const resolved = runtimeModeRuleResolver(raw);
      if (resolved) return resolved;
    } catch {
      // 回落出厂;resolver 内部已有 config_fallback 留痕,此处静默即可
    }
  }
  return composeModeRule(BY_NAME.get(normalizeModeName(raw)), raw);
}

/**
 * 归一到矩阵正名:别名(表侧实锤拼写,MODE_ALIASES 已建桥进 BY_NAME)→ 正名归一串;
 * 矩阵不认识的模式返回其归一串本身。配置台读写与 resolver 查询都必须用它——
 * 只在读侧桥别名会让管理员把配置存到别名名下,×10141 票与正名票分裂吃两套规则(复核HIGH)。
 */
function resolveCanonicalModeName(value) {
  const base = normalizeModeName(value);
  const row = BY_NAME.get(base);
  return row ? normalizeModeName(row.mode) : base;
}

module.exports = {
  lookupModeRecordRule,
  composeModeRule,
  setModeRuleResolver,
  normalizeModeName,
  resolveCanonicalModeName,
  MATRIX,
  BY_NAME, // 出厂矩阵按归一名索引(含别名桥):审核免审派生无 DB 行时回落读它的 columns,与导出抹列同源
  MODE_ALIASES,
  DEFAULT_RULE,
};
