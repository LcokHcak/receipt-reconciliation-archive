'use strict';

/**
 * review_config_resolver — 配置台 P3a:审核必填集接配置(三通道,全出厂回落)。
 *
 * 生效模型(架构设计 2026-07-15,已拍板):
 *   有效必填集 = ①审核基线(docType,全局即生效)
 *              ⊕ ②店家档案字段(百货,店已知即生效)
 *              ⊕ ③模式微调(仅 groupNoMatchStatus=matched 后叠加;时序墙)
 *
 * 铁律:
 *   - 字段**定义**(label/validation)唯一真相源=lib/workbench_definition,配置只存 finalKey 清单/开关;
 *     未知 key=坏配置整条回落出厂——绝不半信半疑地用。
 *   - 本模块纯读;没配置/坏配置/库炸 → 返回 null,由消费方(workbench_task_flow 挂钩)走出厂。
 */

const {
  DOC_TYPE_FIELD_RULES,
} = require('../lib/workbench_definition');
const { DOC_TYPES } = require('../lib/package_constants');
const { resolveCanonicalModeName, BY_NAME, MATRIX, normalizeModeName } = require('../lib/mode_record_matrix');

// ── 词汇表(配置只能引用这些 key)─────────────────────────────────────
const BASE_DEFS = Object.freeze({
  [DOC_TYPES.PASSPORT]: new Map(DOC_TYPE_FIELD_RULES[DOC_TYPES.PASSPORT].fields.map((f) => [f.finalKey, f])),
  [DOC_TYPES.RECEIPT]: new Map(DOC_TYPE_FIELD_RULES[DOC_TYPES.RECEIPT].fields.map((f) => [f.finalKey, f])),
});
// 店家档案 fields 词汇=store_profiles 档案声明用的短名(P0 seed 原样存)
const DEPT_FIELD_VOCAB = Object.freeze(new Set([
  'passportNo', 'extractedName', 'receiptNo', 'receiptAmount', 'branch', 'brand', 'upstream', 'purchaseDate',
]));
// 模式微调 relax/require 词汇=免税店小票基线 finalKey(护照/百货不走模式微调,见架构设计)。
// ⭐店家(receiptStoreFinal)剔除(复核HIGH-2实测):它是路由锚字段——dept/免税店分流、
// 票号/团号规则按店查表、导出店列、结算按店归组全靠它;放宽=空店家小票可终审通过。
// 锚字段共识(护照/姓名/日期/店)不进可配置词汇,relax 它一律 400。
const OVERLAY_VOCAB = Object.freeze(new Set(
  [...BASE_DEFS[DOC_TYPES.RECEIPT].keys()].filter((key) => key !== 'receiptStoreFinal'),
));

// ⭐锚字段:基线通道**不可摘除**(审计H5)。此前模式微调通道用 OVERLAY_VOCAB 剔除 receiptStoreFinal
// (400 硬拒 relax 它),但基线通道 validateReviewBase 无同款护栏——管理员在基线取消勾选"免税店"即可
// 让空店家小票走基线通道终审通过 → 下游 getStoreProfile('') 兜底、tour 按空店查、结算落空桶 → mis-route/残包。
// 同一危险态在 overlay 被硬拒、在基线却静默放行。这里补齐:
//   小票=receiptStoreFinal(路由锚:分流/查表/导出列/结算归组全靠它);护照=姓名+护照号(身份锚)。
const REQUIRED_BASE_ANCHORS = Object.freeze({
  [DOC_TYPES.RECEIPT]: Object.freeze(['receiptStoreFinal']),
  [DOC_TYPES.PASSPORT]: Object.freeze(['passportNoFinal', 'extractedNameFinal']),
});
const ANCHOR_LABEL = Object.freeze({
  receiptStoreFinal: '免税店(路由锚字段)', passportNoFinal: '护照号', extractedNameFinal: '护照姓名',
});

function validateReviewBase(payload, docType) {
  const defs = BASE_DEFS[docType];
  if (!defs) return { ok: false, reason: `不支持的 docType:${docType}` };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload 不是对象' };
  }
  const fields = payload.fields;
  if (!Array.isArray(fields) || !fields.length) {
    return { ok: false, reason: 'fields 必须是非空数组(必填集不能为空——想全放开请用模式微调/SLIM)' };
  }
  for (const key of fields) {
    if (!defs.has(key)) return { ok: false, reason: `未知字段 ${key}(基线只能引用出厂字段定义)` };
  }
  if (new Set(fields).size !== fields.length) return { ok: false, reason: 'fields 有重复' };
  // 锚字段护栏(审计H5):基线绝不能摘除路由/身份锚字段
  const present = new Set(fields);
  for (const anchor of REQUIRED_BASE_ANCHORS[docType] || []) {
    if (!present.has(anchor)) {
      return { ok: false, reason: `「${ANCHOR_LABEL[anchor] || anchor}」是锚字段,基线不可摘除(放宽会让空值票终审通过致错桶/残包;要放宽只能走模式微调,且它本身也禁 relax)` };
    }
  }
  return { ok: true };
}

function validateStoreFields(fields) {
  if (!Array.isArray(fields) || !fields.length) {
    return { ok: false, reason: 'fields 必须是非空数组' };
  }
  for (const key of fields) {
    if (!DEPT_FIELD_VOCAB.has(key)) return { ok: false, reason: `未知档案字段 ${key}` };
  }
  if (new Set(fields).size !== fields.length) return { ok: false, reason: 'fields 有重复' };
  return { ok: true };
}

// 门店码点选清单(0727反馈#6):[{ code:4位数字, name:店名(可空,≤12字) }],≤30 条码唯一。
// 只管清单本身合法;哪些店能配(有门店概念)由路由按出厂档案 rules.branch 把关。
function validateBranchOptions(options) {
  if (!Array.isArray(options) || !options.length) {
    return { ok: false, reason: 'branchOptions 必须是非空数组' };
  }
  if (options.length > 30) return { ok: false, reason: '门店码最多 30 条' };
  const seen = new Set();
  for (const opt of options) {
    const code = String(opt?.code ?? '').trim();
    const name = String(opt?.name ?? '').trim();
    if (!/^\d{4}$/.test(code)) return { ok: false, reason: `门店码「${code || '(空)'}」必须是 4 位数字` };
    if (name.length > 12) return { ok: false, reason: `店名「${name}」太长(≤12 字)` };
    if (seen.has(code)) return { ok: false, reason: `门店码 ${code} 重复` };
    seen.add(code);
  }
  return { ok: true };
}

/** 模式微调段(挂在 mode 配置 payload.review):relax/require/slim/sActivityMark。 */
function validateModeReviewOverlay(review) {
  if (review === undefined || review === null) return { ok: true };
  if (typeof review !== 'object' || Array.isArray(review)) return { ok: false, reason: 'review 必须是对象' };
  for (const listKey of ['relax', 'require']) {
    const list = review[listKey];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, reason: `review.${listKey} 必须是数组` };
    for (const key of list) {
      if (!OVERLAY_VOCAB.has(key)) return { ok: false, reason: `review.${listKey} 未知字段 ${key}` };
    }
  }
  if (review.slim !== undefined && typeof review.slim !== 'boolean') {
    return { ok: false, reason: 'review.slim 必须是布尔' };
  }
  if (review.sActivityMark !== undefined && review.sActivityMark !== null && typeof review.sActivityMark !== 'boolean') {
    return { ok: false, reason: 'review.sActivityMark 必须是布尔或 null' };
  }
  return { ok: true };
}

function createReviewConfigResolver({ modeConfigRepository, logger = console }) {
  if (!modeConfigRepository) throw new Error('review_config_resolver: modeConfigRepository required');

  const cache = new Map(); // `${kind}:${name}` → 解析结果(null=无/坏配置,回落出厂)
  let cachedStamp = -1;

  function ensureFresh() {
    let stamp;
    try {
      stamp = modeConfigRepository.maxStamp();
    } catch (error) {
      logger.warn?.('review_config_store_unavailable', { error: error?.message });
      cache.clear();
      cachedStamp = -1;
      return false;
    }
    if (stamp !== cachedStamp) {
      cache.clear();
      cachedStamp = stamp;
    }
    return true;
  }

  function cached(key, compute) {
    if (cache.has(key)) return cache.get(key);
    let value;
    try {
      value = compute();
    } catch (error) {
      logger.warn?.('review_config_fallback', { key, reason: error?.message });
      value = null;
    }
    cache.set(key, value);
    return value;
  }

  /** ①基线:返回 { fields:[出厂字段定义,按配置顺序], needsSignature:false } | null(回落出厂)。 */
  function getBaseRuleSet(docType) {
    if (!ensureFresh()) return null;
    return cached(`base:${docType}`, () => {
      const row = modeConfigRepository.getActive('review_base', docType);
      if (!row || !row.payload) return null;
      const verdict = validateReviewBase(row.payload, docType);
      if (!verdict.ok) {
        logger.warn?.('review_config_fallback', { key: `base:${docType}`, reason: verdict.reason });
        return null;
      }
      const defs = BASE_DEFS[docType];
      return Object.freeze({
        fields: Object.freeze(row.payload.fields.map((key) => defs.get(key))),
        needsSignature: false,
        configVersion: row.version,
      });
    });
  }

  /** ②店家档案字段清单(短名数组)| null(回落内置档案)。 */
  function getDeptFields(storeFamily) {
    if (!ensureFresh()) return null;
    return cached(`store:${storeFamily}`, () => {
      const row = modeConfigRepository.getActive('store', storeFamily);
      const fields = row?.payload?.fields;
      if (!fields) return null;
      const verdict = validateStoreFields(fields);
      if (!verdict.ok) {
        logger.warn?.('review_config_fallback', { key: `store:${storeFamily}`, reason: verdict.reason });
        return null;
      }
      return Object.freeze([...fields]);
    });
  }

  // T3(2026-07-21 拍板):「记哪些列」单一真相源自动驱动免审——配置台勾掉的列,命中团号后
  // 自动从必审集移除,无需在 review.relax 重复配置(此前 29 模式 relax 全空,"不用记"的照样全审)。
  // 映射边界:只派生 小票号/购买日期/出境日期(均在 OVERLAY_VOCAB 内,天然过锚字段闸);
  //   店家=锚(防错桶)、团号=表态步本就要过 → 不派生;姓名/护照号在护照任务上审且交付夹名
  //   「姓名 护照前4」要用 → 不跟随。显式 require 可把派生免审的字段补回(消费方 require 后于 relax)。
  // 金标依据:部分记模式占单量 ~40%,3列模式命中后必审集自然为空=等效快车道。
  const COLUMNS_RELAX_MAP = Object.freeze({
    receiptNo: 'receiptNoFinal',
    purchaseDate: 'purchaseDateFinal',
    departureDate: 'departureDateFinal',
  });
  function deriveRelaxFromColumns(columns) {
    if (!columns || typeof columns !== 'object') return [];
    const out = [];
    for (const [col, finalKey] of Object.entries(COLUMNS_RELAX_MAP)) {
      if (columns[col] === false) out.push(finalKey);
    }
    return out;
  }

  /** ③模式微调(matched 后叠加;由消费方判 matched)| null。relax=显式∪columns派生。 */
  function getModeReviewOverlay(modeRaw) {
    const raw = String(modeRaw || '').trim();
    if (!raw || !ensureFresh()) return null;
    const base = resolveCanonicalModeName(raw);
    return cached(`overlay:${base}`, () => {
      const row = modeConfigRepository.getActive('mode', base);
      if (!row?.payload) {
        // 无 DB 配置行(模式被「回到默认」deactivate、或 seed 未跑)→ 回落出厂矩阵列派生免审,
        // 与导出层抹列(mode_record_matrix 出厂 BY_NAME,workbench_receipt_export 用它)**同源**,
        // 消除「上面(导出)不记该列、下面(审核)却全审」的 T3 打架态(审计 MEDIUM)。base 已是归一名
        // = BY_NAME 键;未知/全记(ALL)模式派生为空 → 仍返回 null 走全审(不误放宽)。
        const factory = BY_NAME.get(base);
        const factoryRelax = factory ? deriveRelaxFromColumns(factory.columns) : [];
        if (factoryRelax.length === 0) return null;
        return Object.freeze({
          relax: Object.freeze([...new Set(factoryRelax)]),
          require: Object.freeze([]),
          slim: false,
          sActivityMark: null,
        });
      }
      const derivedRelax = deriveRelaxFromColumns(row.payload.columns);
      const review = row.payload.review;
      if (!review && derivedRelax.length === 0) return null;
      let explicit = { relax: [], require: [], slim: false, sActivityMark: null };
      if (review) {
        const verdict = validateModeReviewOverlay(review);
        if (!verdict.ok) {
          // 显式 review 段不合法 → 整体回落全审(保守不变);派生也不叠,免得半生效难排查。
          logger.warn?.('review_config_fallback', { key: `overlay:${base}`, reason: verdict.reason });
          return null;
        }
        explicit = {
          relax: [...(review.relax || [])],
          require: [...(review.require || [])],
          slim: review.slim === true,
          sActivityMark: review.sActivityMark ?? null,
        };
      }
      const relax = Object.freeze([...new Set([...derivedRelax, ...explicit.relax])]);
      return Object.freeze({
        relax,
        require: Object.freeze([...explicit.require]),
        slim: explicit.slim,
        sActivityMark: explicit.sActivityMark,
      });
    });
  }

  function invalidate() {
    cache.clear();
    cachedStamp = -1;
  }

  // T4(2026-07-21):全模式有效 relax 映射(显式∪columns派生),供 /api/review-config 下发前端。
  // 前端折叠免审字段 + validateForSubmit 同源豁免——否则服务端放宽了、客户端本地必填仍拦确认。
  function listModeRelaxMap() {
    if (!ensureFresh()) return {};
    return cached('modeRelaxMap', () => {
      const map = {};
      const add = (name, overlay) => {
        if (!overlay || !overlay.relax.length || map[name]) return; // DB 行优先,已填不覆盖
        // require 补回的键前端也不该折叠/豁免 → 下发前先减掉
        const req = new Set(overlay.require);
        const effective = overlay.relax.filter((key) => !req.has(key));
        if (effective.length) map[name] = effective;
      };
      // ① 已配置模式(DB 行):显式∪列派生
      for (const row of modeConfigRepository.getAllActive('mode') || []) {
        add(row.name, getModeReviewOverlay(row.name));
      }
      // ② 出厂矩阵 SLIM 模式(无 DB 行也要下发免审,否则前端对未配置的出厂 SLIM 模式仍全审、
      //    与导出抹列打架——审计 MEDIUM T3)。getModeReviewOverlay 已对无 DB 行回落矩阵派生。
      for (const factory of MATRIX) {
        add(normalizeModeName(factory.mode), getModeReviewOverlay(factory.mode));
      }
      return Object.freeze(map);
    });
  }

  return { getBaseRuleSet, getDeptFields, getModeReviewOverlay, listModeRelaxMap, invalidate };
}

module.exports = {
  createReviewConfigResolver,
  validateReviewBase,
  validateStoreFields,
  validateBranchOptions,
  validateModeReviewOverlay,
  BASE_FIELD_KEYS: Object.freeze({
    passport: Object.freeze([...BASE_DEFS[DOC_TYPES.PASSPORT].keys()]),
    receipt: Object.freeze([...BASE_DEFS[DOC_TYPES.RECEIPT].keys()]),
  }),
  DEPT_FIELD_VOCAB,
};
