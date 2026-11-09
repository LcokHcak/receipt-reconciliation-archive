'use strict';

/**
 * store_profiles — 店家档案注册表(2026-07-06,百货接入地基)。
 *
 * 唯一真相源:每个店家一个档案,管道各层(切图/字段/校验/结算/交付)只读它分流。
 *   免税店 = 默认档案(family=duty_free),行为=现状,零回归。
 *   百货   = 新档案(family=dept):无团号、图不切、真字段(金额/上家/门店/品牌)。
 *
 * 设计哲学(用户拍板):不手动选场景、批次随便混、qwen 识别时自动认店;百货用真字段,
 * 0731 起**不再借位**(用户口径:什么字段就填什么列)。金额和上家在导出表里各有自己的列,
 * 审核层和导出层现在是同一套字段语义,没有第二套口径。
 *
 * 字段规范来源:docs/百货规范/*.docx(乐天百货/新世界现代百货)。
 */

const { STORE_FAMILIES } = require('./validation/field_rules');

const FAMILY = Object.freeze({ DUTY_FREE: 'duty_free', DEPT: 'dept' });

// 免税店默认档案:切图auto、走团号匹配、标准免税店字段。5 家共用一份。
const DUTY_FREE_DEFAULT = Object.freeze({
  family: FAMILY.DUTY_FREE,
  split: 'auto',        // 照旧自动切护照/小票
  tourMatch: true,      // 结算走团号表匹配
  combined: false,
  // 审核字段 = 现有免税店那套(护照号/英文名/免税店/票号/团号/日期);不在这里重列,
  // 前端 reviewFieldConfig 的 receipt 配置即默认档案的字段(P2 才按档案渲染)。
});

// 百货档案:family=dept,不切、不查团号、模式=常量。fields 声明该店审核要填哪些真字段。
const PROFILES = Object.freeze({
  // ── 免税店(默认档案,规则细节仍在 field_rules)──
  [STORE_FAMILIES.LOTTE]: DUTY_FREE_DEFAULT,
  [STORE_FAMILIES.THE_SHILLA]: DUTY_FREE_DEFAULT,
  [STORE_FAMILIES.SHILLA_IPARK]: DUTY_FREE_DEFAULT,
  [STORE_FAMILIES.SHINSEGAE]: DUTY_FREE_DEFAULT,
  [STORE_FAMILIES.HYUNDAI]: DUTY_FREE_DEFAULT,

  // ── 百货 ──
  [STORE_FAMILIES.LOTTE_DEPT]: Object.freeze({
    family: FAMILY.DEPT,
    label: '乐天百货',
    mode: '乐天百货',
    split: 'none',       // ⭐不可裁图:护照+小票同框,整图直通
    combined: true,      // 一张图里既有小票也有(打码)护照
    tourMatch: false,    // 无团号,模式=常量
    fields: Object.freeze(['passportNo', 'extractedName', 'receiptNo', 'receiptAmount', 'branch', 'brand', 'purchaseDate']),
    rules: Object.freeze({
      // transNo44:거래번호 印 4位-4位 带杠(金标实锤)→ 适配器诚实闸/条码锚推导只对这类店接管;
      // 现代百货 16 位 2-6-3-5 不带此旗标,票号走中央 normalizeReceiptNo 透传(复审 HIGH 回归修复)
      // 0727反馈#13-4:交易编号按票面 4-4 带杠存(旧「8位不打-」作废——去杠后前4位像门店编号,
      // 交付包文件名被用户当成"以门店编号命名了"。存量8位由 dash44 出口形态补杠,存储不回写)。
      receiptNo: Object.freeze({ digits: 8, dash: true, transNo44: true }),
      // 门店=票面4位编号**原样保留**为存储值(2026-07-12 用户拍板:0001就是0001,不换门店名);
      // 校验只查"4位纯数字"不锁清单(新门店码随时出现)。
      // 2026-07-13 用户追加:审核界面显示对应免税店名、交付/台账记"明洞(0001)"——码是唯一确定的
      // (一店两码:明洞0394/0001),故只做**码→店名**单向映射;新码不在表→店名空,码照收。
      branch: Object.freeze(['0001', '0394', '0002', '0348', '0005', '0344']),
      branchNames: Object.freeze({
        '0394': '明洞', '0001': '明洞',
        '0002': '蚕室', '0348': '蚕室',
        '0005': '釜山',
        '0344': '仁川',
      }),
      brand: Object.freeze(['루이비통', '반클리프 아펠', '티파니']), // 只记这3个韩文(忽略后缀)
      amount: 'total',    // 金额只记总金额(用户拍板)
    }),
    delivery: 'lotte_dept', // 专门交付包:按门店分文件夹+双图(交易编号图/护照图)命名
  }),

  [STORE_FAMILIES.SHINSEGAE_DEPT]: Object.freeze({
    family: FAMILY.DEPT,
    label: '新世界百货',
    mode: '新世界百货',
    split: 'none',
    combined: false,
    tourMatch: false,
    passportFree: true, // 票面无护照(2026-07-14 拍板):纯组可整组无护照放行;组级闸/前端选填都以此为真相源
    // 2026-07-17 用户拍板:出厂字段去掉 passportNo/extractedName——票面无护照,票级两格恒空
    // 白占审核眼力;组级身份兜底走 passportFree 旗标+独立护照任务(台账桥传播),与票级勾选无关。
    fields: Object.freeze(['receiptNo', 'receiptAmount', 'upstream', 'purchaseDate']),
    rules: Object.freeze({
      receiptNo: Object.freeze({ dash: true, transNo44: true }),  // 带横线 4位-4位(金标口径 2921-7193;P3只查字符集)
      amount: 'total',
      upstream: Object.freeze(['梁总']),  // 上家固定=梁总(P3校验枚举;defaults 负责自动填)
    }),
    defaults: Object.freeze({ upstream: '梁总' }),  // 新世界百货上家固定=梁总
  }),

  [STORE_FAMILIES.HYUNDAI_DEPT]: Object.freeze({
    family: FAMILY.DEPT,
    label: '现代百货',
    mode: '现代百货',
    split: 'none',
    combined: false,
    tourMatch: false,
    passportFree: true, // 同新世界:票面无护照,纯组免护照;乐天百货是同框票**不设**此旗标
    // 2026-07-12 实票纠正(用户报障截图):现代百货交易编号是 8位 4位-4位 带杠(如 1622-0011),
    // 原 16位 2-6-3-5 是从现代**免税店** BILL NO 借来的错口径;金额票面有 합계,要记。
    // 2026-07-17 用户拍板:出厂去掉 passportNo/extractedName(同新世界,票面无护照两格恒空)。
    fields: Object.freeze(['receiptNo', 'receiptAmount', 'upstream', 'purchaseDate']),
    rules: Object.freeze({
      receiptNo: Object.freeze({ dash: true, digits: 8, transNo44: true }), // 거래번호 4-4 带杠原样存
      amount: 'total',
      upstream: Object.freeze(['金浦奥莱', '东方']), // 贴金浦奥莱积分卡=金浦奥莱,其余=东方
      upstreamConfirm: true, // 自动默认"东方"后仍标红让审核员看一眼贴没贴卡(钱的归属,准比快)
    }),
    defaults: Object.freeze({ upstream: '东方' }), // 无卡=东方是规则本体,默认它;贴卡人工翻金浦奥莱
  }),
});

// 免护照店(2026-07-14 复核细化):票面不带护照的百货(新世界/现代)。
// 乐天百货是护照同框票——身份必须落在票上(交付包双图/组级兜底都依赖),不免。
function isPassportFreeDeptStore(storeFamily) {
  const profile = getStoreProfile(storeFamily);
  return Boolean(profile && profile.passportFree);
}

// 查档案。查不到(未知店/空)→ 默认免税店档案(保守:拿不准按免税店走,免税店零风险)。
function getStoreProfile(storeFamily) {
  const key = String(storeFamily || '').trim().toUpperCase();
  return PROFILES[key] || DUTY_FREE_DEFAULT;
}

function isDeptStore(storeFamily) {
  return getStoreProfile(storeFamily).family === FAMILY.DEPT;
}

// 门店编码→免税店名(2026-07-13):码唯一确定,查档案 rules.branchNames。未识别码→''。
function deptBranchName(storeFamily, code) {
  const map = getStoreProfile(storeFamily).rules?.branchNames;
  const key = String(code == null ? '' : code).trim();
  if (!map) return '';
  if (map[key]) return map[key];
  // 前导零容错(0728 红批注核对实锤:生产包出现「00394」5位异常码,查不到店名
  // → 码自成一夹与明洞并列)。纯数字且去前导零后能命中表(补齐4位)→ 归对店;
  // 仍查不到照旧返回 ''(码原样成夹,不丢票的老兜底不变)。
  if (/^\d{5,}$/.test(key)) {
    const squeezed = key.replace(/^0+/, '').padStart(4, '0');
    if (map[squeezed]) return map[squeezed];
  }
  return '';
}

// 百货上家解析(2026-07-20 交付规则5/存量回填共用,单一真相防第二副本):
// 任务值(Final||Auto)→ 档案 defaults.upstream(新世界=梁总/现代=东方;金浦奥莱只能来自
// 任务值——贴卡是人工判定,兜底不猜)。非百货/无默认返回 ''(调用方自定未知兜底)。
function resolveDeptUpstream(storeFamily, task) {
  const clean = (v) => String(v == null ? '' : v).trim();
  return clean(task && task.upstreamFinal) || clean(task && task.upstreamAuto)
    || clean(getStoreProfile(storeFamily).defaults?.upstream);
}

// 交付包/台账门店列格式="明洞(0001)"(用户拍板店名+码都留);未识别码只留码;空→空。
function formatDeptBranch(storeFamily, code) {
  const key = String(code == null ? '' : code).trim();
  if (!key) return '';
  const name = deptBranchName(storeFamily, key);
  return name ? `${name}(${key})` : key;
}

module.exports = {
  isPassportFreeDeptStore,
  FAMILY, PROFILES, DUTY_FREE_DEFAULT, getStoreProfile, isDeptStore,
  deptBranchName, formatDeptBranch, resolveDeptUpstream,
};
