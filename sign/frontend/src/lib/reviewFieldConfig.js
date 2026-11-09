import { isDeptStoreValue } from './reviewDisplay.js'

// ── 一等类型三档(2026-07-13)──护照 / 小票(免税店)/ 百货。
// 底层持久化仍是 docTypeFinal + receiptStoreFinal(百货=receipt+*_DEPT 店),不新增后端 docType 值;
// 但 UI 把百货抬成与护照/小票并列的一等选择,不再是"免税店按钮里的后 3 个"。
// 其他(登机牌/包装):不占一等档,走小票的"改成其他"逃生口(与截图一致),避免误建。
export const REVIEW_TIER1_TYPES = Object.freeze([
  { value: 'passport', label: '护照' },
  { value: 'receipt', label: '小票' },   // 免税店小票
  { value: 'dept', label: '百货' },       // 百货票(乐天/新世界/现代)
])

// 免税店(5 家):小票面板的店家选项,不再混入百货。
export const DUTY_FREE_STORE_OPTIONS = Object.freeze([
  { value: 'LOTTE', label: 'LOTTE' },
  { value: 'THE SHILLA', label: 'THE SHILLA' },
  { value: 'SHILLA IPARK', label: 'SHILLA IPARK' },
  // 2026-07 新增,与后端 field_rules.STORE_FAMILIES 对齐(票号/团号长度未定 → 前端也放宽,不卡)。
  { value: 'SHINSEGAE', label: '新世界 SHINSEGAE' },
  { value: 'HYUNDAI', label: '现代 HYUNDAI' },
])

// 百货(3 家,P2/2026-07-06):无团号、真字段(金额/门店/品牌/上家)。百货面板只显示这 3 家。
export const DEPT_STORE_OPTIONS = Object.freeze([
  { value: 'LOTTE_DEPT', label: '乐天百货' },
  { value: 'SHINSEGAE_DEPT', label: '新世界百货' },
  { value: 'HYUNDAI_DEPT', label: '现代百货' },
])

// 并集(向后兼容:fieldErrors validStores 校验、旧引用)。新代码请用上面两个子集。
export const RECEIPT_STORE_OPTIONS = Object.freeze([
  ...DUTY_FREE_STORE_OPTIONS,
  ...DEPT_STORE_OPTIONS,
])

// 长度规则表:**逐店逐字段**镜像后端 lib/validation/field_rules.js 的两张表。
// 表里没有的店 → 该字段前端不卡长度(新店长度未定,卡了全是假警报)。
//
// ⚠️ 2026-08-01 实测修正。原来这里是一张合并的店名清单 STORES_WITH_LENGTH_RULE,
// 长度则在 FieldEditor 里写死成「LOTTE ? 14 : 13」和「LOTTE ? 8 : 5」。两个问题:
//   ① 后端 2026-07-03 给**新世界免税店**加了团号 5 位规则,这张清单没跟上 ——
//      实跑 validateTourNo('SHINSEGAE','123456') 后端判 field_tour_no_invalid,
//      而界面 hasLenRule=false 一个提示都不给:审核员看着没问题,存下去才被标问题。
//   ② 票号和团号的适用店**不一样**(现代有票号长度、没有团号长度),一个合并清单表达不了;
//      而且后端新世界/现代票号是 16 位,前端却写死非乐天=13 —— 只把店名加进旧清单,
//      会让前端反过来要求 13 位,比不校验更糟。所以必须两张表一起对齐,不能只补清单。
// 一致性由 tests/field_length_front_back_parity.test.js 逐条对拍保证(不是靠这段注释)。
export const RECEIPT_NO_LENGTH_BY_STORE = Object.freeze({
  LOTTE: 14,
  'SHILLA IPARK': 13,
  'THE SHILLA': 13,
  SHINSEGAE: 16,
  HYUNDAI: 16,
})
export const TOUR_NO_LENGTH_BY_STORE = Object.freeze({
  LOTTE: 8,
  'SHILLA IPARK': 5,
  'THE SHILLA': 5,
  SHINSEGAE: 5,
})

// 把长度表念成人话给审核员看:「LOTTE 8位 / THE SHILLA·SHILLA IPARK·SHINSEGAE 5位」。
// 表改了这句自动跟着改 —— 写死的提示语是另一种"两个读者",而且是用户直接看见的那一份。
export function describeLengthRule(table) {
  const byLen = new Map()
  for (const [store, len] of Object.entries(table)) {
    if (!byLen.has(len)) byLen.set(len, [])
    byLen.get(len).push(store)
  }
  return [...byLen.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .map(([len, stores]) => `${stores.join('·')} ${len}位`)
    .join(' / ')
}

export const REVIEW_FIELD_KEYS = Object.freeze([
  'extractedNameFinal',
  'passportNoFinal',
  // 2026-06-30 中文名下线:不再进审核台审核(下游唯一消费者「签字」已于 6/12 整体下线,
  // 出包 PDF / 客户命名 / 月度匹配均用英文名 extractedNameFinal)。OCR 仍会抽 chineseNameAuto,
  // 只是不再人工复核、不再卡任务完成。
  'receiptStoreFinal',
  'receiptNoFinal',
  'groupNoFinal',
  'purchaseDateFinal',
  'departureDateFinal',
  // 百货真字段(P2):不在当前店字段集里的键,payload 会置空(切回免税店时清残留)
  'receiptAmountFinal',
  'branchFinal',
  'brandFinal',
  'upstreamFinal',
])

const FIELD_CONFIGS = Object.freeze({
  passport: Object.freeze({
    // 2026-06-12 签字功能下线;2026-06-30 中文名也下线 → 护照只审英文名 + 护照号。
    needsSignaturePanel: false,
    emptyText: '',
    fields: Object.freeze([
      { key: 'extractedNameFinal', label: '英文名', inputType: 'text', placeholder: '姓␣名,多个名会合并:VU DIEP KHANH HUYEN → VU DIEPKHANHHUYEN' },
      { key: 'passportNoFinal', label: '护照号', inputType: 'text', placeholder: 'EG8761171' },
    ]),
  }),
  receipt: Object.freeze({
    needsSignaturePanel: false,
    emptyText: '',
    fields: Object.freeze([
      { key: 'receiptStoreFinal', label: '免税店', inputType: 'choice', options: DUTY_FREE_STORE_OPTIONS },
      // 提示语跟着上面两张表走(2026-08-01):写死的话表一改它就说错 ——
      // 「新罗系 5位」这句在后端给新世界加了 5 位规则之后就已经不全了。
      { key: 'receiptNoFinal', label: '小票号', inputType: 'text', placeholder: `${describeLengthRule(RECEIPT_NO_LENGTH_BY_STORE)};其余店按实际填` },
      { key: 'groupNoFinal', label: '团号', inputType: 'text', placeholder: `${describeLengthRule(TOUR_NO_LENGTH_BY_STORE)};其余店按实际填` },
      { key: 'purchaseDateFinal', label: '购买日期', inputType: 'date', placeholder: '' },
      { key: 'departureDateFinal', label: '出境日期', inputType: 'date', placeholder: '' },
    ]),
  }),
  other: Object.freeze({
    needsSignaturePanel: false,
    emptyText: '此文件分类为“其他”，无需填写字段。',
    fields: Object.freeze([]),
  }),
})

// ── 百货字段面板(P2)──按店切换,与后端 lib/store_profiles.js 档案对齐。
// 无团号/无出境日期;字段全部真字段,"借位"(金额→团号列/上家→姓名列)只在导出映射层。
// ⚠️ 双副本提醒:门店编号/品牌白名单/上家枚举的真相源是后端 lib/store_profiles.js 的 rules;
// 改档案时这里的 options 必须同步(教训:改规则漏副本曾致结算 Internal error)。
const STORE_FIELD = Object.freeze({
  key: 'receiptStoreFinal', label: '百货店家', inputType: 'choice', options: DEPT_STORE_OPTIONS,
})

// 乐天百货 门店编码→免税店名(前端镜像,2026-07-13 用户拍板:审核界面显示店名、交付/台账记"明洞(0001)")。
// ⚠️ 唯一真相源在后端 lib/store_profiles.js LOTTE_DEPT.rules.branchNames;
// tests/frontend_review_field_config.test.js 交叉锁死两侧逐字一致(防副本漂移)。
export const LOTTE_DEPT_BRANCH_NAMES = Object.freeze({
  '0394': '明洞', '0001': '明洞',
  '0002': '蚕室', '0348': '蚕室',
  '0005': '釜山',
  '0344': '仁川',
})
// 码→免税店名;未识别码(新门店)→ ''(码照收不锁死)。
// 前导零容错(0728 红批注实锤「00394」):与后端 store_profiles.deptBranchName 同口径。
export function deptBranchName(code) {
  const key = String(code == null ? '' : code).trim()
  if (LOTTE_DEPT_BRANCH_NAMES[key]) return LOTTE_DEPT_BRANCH_NAMES[key]
  if (/^\d{5,}$/.test(key)) {
    const squeezed = key.replace(/^0+/, '').padStart(4, '0')
    if (LOTTE_DEPT_BRANCH_NAMES[squeezed]) return LOTTE_DEPT_BRANCH_NAMES[squeezed]
  }
  return ''
}

// 百货"选店中"伪面板(P2/2026-07-13):operator 在一等档点了「百货」但还没选是哪家时,
// 只显示 3 个百货店按钮(绝不混免税店),选完立刻切到该店的百货真字段面板。
export const DEPT_STORE_PICK_CONFIG = Object.freeze({
  needsSignaturePanel: false,
  emptyText: '',
  pendingDeptStore: true,
  fields: Object.freeze([STORE_FIELD]),
})

const DEPT_FIELD_CONFIGS = Object.freeze({
  LOTTE_DEPT: Object.freeze({
    needsSignaturePanel: false,
    emptyText: '',
    fields: Object.freeze([
      STORE_FIELD,
      // 身份字段(2026-07-12 报障#2):护照+小票同框整图直通,姓名/护照号登记在本任务上
      { key: 'extractedNameFinal', label: '英文名', inputType: 'text', placeholder: '姓␣名,多个名会合并:HOANG NGOC BAO → HOANG NGOCBAO' },
      { key: 'passportNoFinal', label: '护照号', inputType: 'text', placeholder: 'EJ9626615' },
      { key: 'receiptNoFinal', label: '交易编号', inputType: 'text', placeholder: '票面 4位-4位,带杠照抄' },
      { key: 'receiptAmountFinal', label: '金额(总金额)', inputType: 'text', placeholder: '只填数字,如 3500000' },
      {
        // 门店=票面4位编号原样存(2026-07-12);2026-07-13 追加:下方自动显示对应免税店名(明洞…)。
        key: 'branchFinal', label: '门店(票面4位编号)', inputType: 'text',
        placeholder: '照票面抄,如 0001/0394', deriveBranchName: true,
      },
      {
        key: 'brandFinal', label: '品牌(只记这3个)', inputType: 'choice',
        options: Object.freeze([
          { value: '루이비통', label: '루이비통 (LV)' },
          { value: '반클리프 아펠', label: '반클리프 아펠 (梵克雅宝)' },
          { value: '티파니', label: '티파니 (Tiffany)' },
        ]),
      },
      { key: 'purchaseDateFinal', label: '购买日期', inputType: 'date', placeholder: '' },
    ]),
  }),
  SHINSEGAE_DEPT: Object.freeze({
    needsSignaturePanel: false,
    emptyText: '',
    fields: Object.freeze([
      STORE_FIELD,
      // 身份字段已下线(2026-07-17 用户拍板,原 2026-07-14 为选填):该店票面不带护照
      // (combined:false),两格恒空白占眼力;身份靠组内护照任务在结算时自动带出
      // (台账桥 findDeptPassportDonor)。乐天百货是护照同框票 → 那边保持必填,别抄这里。
      { key: 'receiptNoFinal', label: '交易编号', inputType: 'text', placeholder: '票面带横线完整抄,如 2921-7193' },
      { key: 'receiptAmountFinal', label: '金额(总金额)', inputType: 'text', placeholder: '只填数字' },
      {
        key: 'upstreamFinal', label: '上家', inputType: 'choice',
        options: Object.freeze([{ value: '梁总', label: '梁总(固定)' }]),
      },
      { key: 'purchaseDateFinal', label: '购买日期', inputType: 'date', placeholder: '' },
    ]),
  }),
  HYUNDAI_DEPT: Object.freeze({
    needsSignaturePanel: false,
    emptyText: '',
    fields: Object.freeze([
      STORE_FIELD,
      // 身份字段已下线(2026-07-17 用户拍板,原 2026-07-14 为选填):同新世界,票面无护照
      // 两格恒空;身份靠组内护照任务结算时自动带出(台账桥 findDeptPassportDonor)。
      // 2026-07-12 实票纠正:现代百货交易编号=8位 4位-4位 带杠(如 1622-0011),不是16位
      { key: 'receiptNoFinal', label: '交易编号', inputType: 'text', placeholder: '票面8位带横线,如 1622-0011' },
      { key: 'receiptAmountFinal', label: '金额(总金额)', inputType: 'text', placeholder: '只填数字' },
      {
        key: 'upstreamFinal', label: '上家', inputType: 'choice',
        options: Object.freeze([
          { value: '金浦奥莱', label: '金浦奥莱(贴积分卡)' },
          { value: '东方', label: '东方(其余)' },
        ]),
      },
      { key: 'purchaseDateFinal', label: '购买日期', inputType: 'date', placeholder: '' },
    ]),
  }),
})

export function normalizeReviewDocType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'passport' || normalized === 'receipt' || normalized === 'other') {
    return normalized
  }
  if (normalized === 'ticket') {
    return 'other'
  }
  return 'other'
}

// ── P3c:运行时过滤(配置台 C 类勾选 → 百货面板字段格)────────────────
// 词汇短名 → 面板 finalKey(与后端 DEPT_FIELD_VOCAB 一一对应)
export const DEPT_KEY_TO_FINAL = Object.freeze({
  passportNo: 'passportNoFinal',
  extractedName: 'extractedNameFinal',
  receiptNo: 'receiptNoFinal',
  receiptAmount: 'receiptAmountFinal',
  branch: 'branchFinal',
  brand: 'brandFinal',
  upstream: 'upstreamFinal',
  purchaseDate: 'purchaseDateFinal',
})
// 配置勾了、但该店富定义里没有的字段 → 通用兜底格(绝不出现"后端必审前端没格"的卡死)。
// 身份两格必须 optional(复核 HIGH,2026-07-17):新世界/现代出厂已删身份格,老 v1 配置
// 还勾着 passportNo 时会走兜底——票面本无护照,兜底格若必填=永远填不满,整店卡审。
const FALLBACK_DEPT_FIELD_DEFS = Object.freeze({
  passportNoFinal: Object.freeze({ key: 'passportNoFinal', label: '护照号', inputType: 'text', placeholder: '无随行护照可留空', optional: true }),
  extractedNameFinal: Object.freeze({ key: 'extractedNameFinal', label: '英文名', inputType: 'text', placeholder: '无随行护照可留空', optional: true }),
  receiptNoFinal: Object.freeze({ key: 'receiptNoFinal', label: '交易编号', inputType: 'text', placeholder: '' }),
  receiptAmountFinal: Object.freeze({ key: 'receiptAmountFinal', label: '金额(总金额)', inputType: 'text', placeholder: '只填数字' }),
  branchFinal: Object.freeze({ key: 'branchFinal', label: '门店(票面4位编号)', inputType: 'text', placeholder: '', deriveBranchName: true }),
  brandFinal: Object.freeze({ key: 'brandFinal', label: '品牌', inputType: 'text', placeholder: '' }),
  upstreamFinal: Object.freeze({ key: 'upstreamFinal', label: '上家', inputType: 'text', placeholder: '' }),
  purchaseDateFinal: Object.freeze({ key: 'purchaseDateFinal', label: '购买日期', inputType: 'date', placeholder: '' }),
})

// 纯过滤器(shortNames 由 runtimeReviewConfig 注入;本文件保持零运行时依赖,node 口径测试直执行)
export function applyDeptFieldFilter(config, configured) {
  if (!configured) return config // null=没配置/没拉到 → 出厂路径逐字节不动
  const wanted = new Set(configured.map((k) => DEPT_KEY_TO_FINAL[k]).filter(Boolean))
  const kept = config.fields.filter((field) => field.key === 'receiptStoreFinal' || wanted.has(field.key))
  const present = new Set(kept.map((field) => field.key))
  const extras = [...wanted].filter((k) => !present.has(k)).map((k) => FALLBACK_DEPT_FIELD_DEFS[k]).filter(Boolean)
  if (!extras.length && kept.length === config.fields.length) return config // 配置≡富定义 → 原对象(零变化)
  return { ...config, fields: Object.freeze([...kept, ...extras]) }
}

/** 纯定位器:receipt+百货富定义命中 → { canonical, config };其余 null。供 runtimeReviewConfig 组合。 */
export function getDeptPanelBase(docType, store = '') {
  const normalizedDocType = normalizeReviewDocType(docType)
  if (normalizedDocType !== 'receipt') return null
  const canonical = normalizeReceiptStore(store)
  return DEPT_FIELD_CONFIGS[canonical] ? { canonical, config: DEPT_FIELD_CONFIGS[canonical] } : null
}

export function getReviewFieldConfig(docType, store = '') {
  const normalizedDocType = normalizeReviewDocType(docType)
  if (normalizedDocType === 'receipt') {
    const canonical = normalizeReceiptStore(store)
    if (DEPT_FIELD_CONFIGS[canonical]) return DEPT_FIELD_CONFIGS[canonical]
  }
  return FIELD_CONFIGS[normalizedDocType] || FIELD_CONFIGS.other
}

// 一等档归类(2026-07-13):把持久化的 docType+store 映射成 UI 三档之一 —— 百货抬成一等。
//   passport → 'passport';other → 'other'(其他,仍可达但不占一等档);
//   receipt + 百货店(*_DEPT)→ 'dept';receipt + 其余 → 'receipt'(免税小票)。
// 单一真相源:百货判定复用 reviewDisplay.isDeptStoreValue,不在本文件另抄正则。
export function uiTypeOf(docType, store = '') {
  const dt = normalizeReviewDocType(docType)
  if (dt !== 'receipt') return dt
  return isDeptStoreValue(store) ? 'dept' : 'receipt'
}

function normalizeUpperWords(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePassportEnglishName(value) {
  let normalized = normalizeUpperWords(value)
  for (;;) {
    const before = normalized
    normalized = normalized
      .replace(/^(?:MSL|MSLI|MSLL|MLZ|MLZI|MLZZ)\s+/, '')
      .replace(/^PO\s+CHN\s+/, '')
      .replace(/^POCHN\s+/, '')
      .replace(/^POCHN(?=[A-Z])/, '')
    normalized = normalizeUpperWords(normalized)
    if (normalized === before) break
  }
  // 审核标准(0727反馈#9):姓(空格)名,名的多段合并——首词=姓,其余名段拼死
  // (PHAM THI THUY LINH → PHAM THITHUYLINH)。护照名段空格是排版不是语义,
  // 越南/马来名 3~4 段全分写,台账/账单两侧排版随缘,统一成单一形态才可对账。
  // 两词以内已是标准形态不动;Auto/Final 同走此函数,人工输入也被收口。
  const parts = normalized.split(' ')
  if (parts.length > 2) {
    normalized = `${parts[0]} ${parts.slice(1).join('')}`
  }
  return normalized
}

function normalizeAlphaNumUpper(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

// ⚠️ 与后端 lib/workbench_field_normalizer.normalizeReceiptNo 逐字镜像(唯一真相源在后端,
// tests/frontend_review_field_config.test.js 有前后端口径一致性测试锁死)。
// 2026-07 解禁口径:保留字母(济州乐天 90G…)**和横线**(新世界/现代 BILL NO 带杠),只去空格/点/标签。
// 修 2026-07-06 回弹 bug:这里曾是 normalizeDigits——操作员手补 "90G203-26-000309",
// 点确认瞬间前端剥成 "9020326000309" 再提交,观感=「改完又自动弹回」;显示路径同函数,
// 后端存对了界面也显示不出字母。
function normalizeReceiptNo(value) {
  const withoutLabel = String(value || '')
    .trim()
    .replace(/^\s*(?:NO|RECEIPT\s*NO|REF\.?\s*NO|APPROVAL\s*NO)\s*[:：.]?\s*/i, '')
    .replace(/^0[.．](?=(?:03|21)[-./．\s])/, '')
  return String(withoutLabel)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ⚠️ 与后端 lib/workbench_field_normalizer.normalizeGroupNo 逐字镜像(同上,一致性测试锁死)。
// 团号保留字母(乐天R团 R2299001/首尔V团),剥"标签式前缀"(G 25184 / G-12345 → 25184);
// 机场票合法值"无"原样保留(旧 normalizeDigits 会剥成空串卡必填)。
function normalizeGroupNo(value) {
  const raw = String(value || '').toUpperCase().trim()
  if (raw === '无' || raw === '无团号') return '无'
  const label = raw.match(/^([A-Z]+)[\s\-_:：]+(.*\d.*)$/)
  const core = label ? label[2] : raw
  return core.replace(/[^A-Z0-9]/g, '')
}

function normalizeReceiptStore(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ')
  // ⭐百货优先(撞名防线,与后端 field_rules.normalizeStoreFamily 镜像):
  // 否则「新世界百货」会被下面 includes('新世界') 误吞进 SHINSEGAE 免税店。
  if (/百货|백화점|DEPT|DEPARTMENT/.test(normalized)) {
    if (normalized.includes('LOTTE') || normalized.includes('乐天') || normalized.includes('롯데')) return 'LOTTE_DEPT'
    if (normalized.includes('SHINSEGAE') || normalized.includes('新世界') || normalized.includes('신세계')) return 'SHINSEGAE_DEPT'
    if (normalized.includes('HYUNDAI') || normalized.includes('现代') || normalized.includes('現代') || normalized.includes('현대')) return 'HYUNDAI_DEPT'
    return normalized // 认出百货但不知哪家:原样保留,审核员从下拉选
  }
  if (normalized === 'LOTTE' || normalized.startsWith('LOTTE ')) return 'LOTTE'
  if (normalized === 'THE SHILLA' || normalized === 'THESHILLA') return 'THE SHILLA'
  if (normalized === 'SHILLA IPARK' || normalized === 'SHILLAIPARK' || normalized === 'SHILLA I PARK') return 'SHILLA IPARK'
  // 2026-07 新增,与后端 normalizeStoreFamily 对齐(用 includes 容整串 + 中/韩写法)。
  if (normalized.includes('SHINSEGAE') || normalized.includes('新世界') || normalized.includes('신세계')) return 'SHINSEGAE'
  if (normalized.includes('HYUNDAI') || normalized.includes('现代') || normalized.includes('現代') || normalized.includes('현대')) return 'HYUNDAI'
  return normalized
}

function normalizeDate(value) {
  const source = String(value || '').trim()
  const full = source.match(/([12]\d{3})[./-](\d{1,2})[./-](\d{1,2})/)
  const short = source.match(/\b(\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/)
  const match = full || short
  if (!match) return source
  const year = full ? Number(match[1]) : 2000 + Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function normalizeReviewValue(docType, key, value) {
  if (docType === 'passport') {
    if (key === 'extractedNameFinal') return normalizePassportEnglishName(value)
    if (key === 'passportNoFinal') return normalizeAlphaNumUpper(value)
  }
  if (docType === 'receipt') {
    if (key === 'receiptStoreFinal') return normalizeReceiptStore(value)
    if (key === 'receiptNoFinal') return normalizeReceiptNo(value)
    if (key === 'groupNoFinal') return normalizeGroupNo(value)
    if (key === 'purchaseDateFinal' || key === 'departureDateFinal') return normalizeDate(value)
    // 百货真字段(P2):金额只留数字;门店/品牌/上家为中/韩文,只去首尾空白(与后端同口径)
    if (key === 'receiptAmountFinal') return normalizeDigits(value)
    // 百货身份字段(2026-07-12 报障#2):与护照任务/后端 receipt 白名单同口径
    if (key === 'extractedNameFinal') return normalizePassportEnglishName(value)
    if (key === 'passportNoFinal') return normalizeAlphaNumUpper(value)
  }
  return String(value || '').trim()
}

// 白名单=**出厂富定义 ∪ extraAllowedKeys(配置补充键)**(断点⑥根修,2026-07-20 行为三合一):
// 此前恒用出厂富定义——配置台给店勾了"富定义没有"的字段(如乐天勾上家)时,前端兜底格
// 显示、用户填值、保存被这里置空、后端(吃配置)必填又打回 → 死循环卡审。
// ⭐红线不变:并集只会**增**不会**减**——配置"放宽"某出厂字段时它仍在出厂侧,已填值绝不被清;
// extraAllowedKeys 由 runtime 层(runtimeReviewConfig.buildReviewFieldPayloadRuntime)按店配置注入,
// 本函数保持纯(node 口径测试直执行,零运行时依赖)。
export function buildReviewFieldPayload(docType, values = {}, extraAllowedKeys = []) {
  const normalizedDocType = normalizeReviewDocType(docType)
  // 店从 values 里取:百货店 → 该店字段集;不在集里的键置空(切店/切类型清残留)
  const allowed = new Set(
    getReviewFieldConfig(normalizedDocType, values.receiptStoreFinal).fields.map((field) => field.key),
  )
  for (const key of extraAllowedKeys) {
    if (REVIEW_FIELD_KEYS.includes(key)) allowed.add(key)
  }
  const payload = { docTypeFinal: normalizedDocType }

  REVIEW_FIELD_KEYS.forEach((key) => {
    payload[key] = allowed.has(key) ? normalizeReviewValue(normalizedDocType, key, values[key]) : ''
  })

  return payload
}

export function normalizeReviewFieldsForTask(task = {}, extraAllowedKeys = []) {
  const normalizedDocType = normalizeReviewDocType(task.docTypeFinal || task.docTypeAuto || task.docType)
  return buildReviewFieldPayload(normalizedDocType, task, extraAllowedKeys)
}

// 注:故意不接 Runtime 过滤——签字 2026-06-12 已下线,所有配置的 needsSignaturePanel 恒 false,
// 且 applyDeptFieldFilter 只过滤 fields 不碰此标志;若未来签字复活并可配,这里需同步评估。
export function taskNeedsSignaturePanel(task = {}) {
  return getReviewFieldConfig(
    task?.docTypeFinal || task?.docTypeAuto || task?.docType,
    task?.receiptStoreFinal || task?.receiptStoreAuto || '',
  ).needsSignaturePanel
}
