const { DOC_TYPES } = require('./package_constants');

const PROCESS_RESULTS = Object.freeze({
  CLASSIFY: '待分类确认',
  FIELDS: '待补字段',
  SIGNATURE: '待签字',
  FINAL_REVIEW: '待终审',
  APPROVED: '已通过',
  REPHOTO: '需重拍',
});

const STATUS_OPTIONS = Object.freeze([
  '全部',
  PROCESS_RESULTS.CLASSIFY,
  PROCESS_RESULTS.FIELDS,
  PROCESS_RESULTS.SIGNATURE,
  PROCESS_RESULTS.FINAL_REVIEW,
  PROCESS_RESULTS.APPROVED,
  PROCESS_RESULTS.REPHOTO,
]);

const DOC_TYPE_LABELS = Object.freeze({
  [DOC_TYPES.PASSPORT]: '护照',
  [DOC_TYPES.RECEIPT]: '小票',
  [DOC_TYPES.OTHER]: '其他',
});

const DOC_TYPE_FIELD_RULES = Object.freeze({
  [DOC_TYPES.PASSPORT]: Object.freeze({
    fields: Object.freeze([
      Object.freeze({
        label: '英文名',
        draftKey: 'extractedNameFinal',
        finalKey: 'extractedNameFinal',
        autoKey: 'extractedNameAuto',
        validation: Object.freeze({ type: 'english_name' }),
      }),
      Object.freeze({
        label: '护照号',
        draftKey: 'passportNoFinal',
        finalKey: 'passportNoFinal',
        autoKey: 'passportNoAuto',
        validation: Object.freeze({ type: 'passport_no' }),
      }),
      // 2026-07-02 中文名移出必填:前端 6-30 已下线该字段(护照只审英文名+护照号),
      // 后端规则漏删成"僵尸必填"——OCR 没抽到中文名时审核报"还缺中文名",但界面没有
      // 输入框、操作员无法补 → 死锁。OCR 仍抽 chineseNameAuto(训练导出用),不影响。
    ]),
    // 2026-06-12 签字功能整体下线:不再生成网站签字、审核流不卡 SIGNATURE 步骤
    // (canAutoQueueWebsiteSignature 依赖 processResult===SIGNATURE,此开关一关全停)。
    // 字段语义同步从「中文签字名」改为「中文名」。
    needsSignature: false,
  }),
  [DOC_TYPES.RECEIPT]: Object.freeze({
    fields: Object.freeze([
      Object.freeze({
        label: '免税店',
        draftKey: 'receiptStoreFinal',
        finalKey: 'receiptStoreFinal',
        autoKey: 'receiptStoreAuto',
        validation: Object.freeze({ type: 'receipt_store' }),
      }),
      Object.freeze({
        label: '小票号',
        draftKey: 'receiptNoFinal',
        finalKey: 'receiptNoFinal',
        autoKey: 'receiptNoAuto',
        validation: Object.freeze({ type: 'receipt_no' }),
      }),
      Object.freeze({
        label: '团号',
        draftKey: 'groupNoFinal',
        finalKey: 'groupNoFinal',
        autoKey: 'groupNoAuto',
        validation: Object.freeze({ type: 'group_no' }),
      }),
      Object.freeze({
        label: '购买日期',
        draftKey: 'purchaseDateFinal',
        finalKey: 'purchaseDateFinal',
        autoKey: 'purchaseDateAuto',
        validation: Object.freeze({ type: 'purchase_date' }),
      }),
      Object.freeze({
        label: '出境日期',
        draftKey: 'departureDateFinal',
        finalKey: 'departureDateFinal',
        autoKey: 'departureDateAuto',
        validation: Object.freeze({ type: 'departure_date' }),
      }),
    ]),
    needsSignature: false,
  }),
});

const SIGNATURE_STYLE_OPTIONS = Object.freeze([
  '随机签字',
]);

const DEFAULT_SIGNATURE_STYLE = SIGNATURE_STYLE_OPTIONS[0];

const QUEUE_GROUP_META = Object.freeze({
  priority: Object.freeze({ title: '先处理', empty: '当前没有需要先处理的记录。' }),
  review: Object.freeze({ title: '继续审核', empty: '当前没有待签字或待终审记录。' }),
  done: Object.freeze({ title: '已通过', empty: '当前还没有已通过记录。' }),
});

const FINAL_SIGNATURE_SOURCE_LABELS = Object.freeze({
  region_capture: '自动签字区',
  local_fallback: '本地兜底',
  manual_drawn: '手写补签',
  website_generated: '网站生成',
});

const SIGNATURE_JOB_LABELS = Object.freeze({
  pending_name: '待填中文名',
  idle: '未排队',
  queued: '排队中',
  generating: '生成中',
  done: '已生成',
  failed: '生成失败',
});

const WORKFLOW_HEADINGS = Object.freeze({
  [PROCESS_RESULTS.CLASSIFY]: '先确认分类',
  [PROCESS_RESULTS.FIELDS]: '补齐关键字段',
  [PROCESS_RESULTS.SIGNATURE]: '生成最终签字',
  [PROCESS_RESULTS.FINAL_REVIEW]: '进入终审确认',
  [PROCESS_RESULTS.APPROVED]: '记录已审核通过',
  [PROCESS_RESULTS.REPHOTO]: '需要重拍',
});

const EMPTY_FIELD_RULE_SET = Object.freeze({
  fields: Object.freeze([]),
  needsSignature: false,
});

function getDocTypeFieldRuleSet(docType) {
  return DOC_TYPE_FIELD_RULES[docType] || EMPTY_FIELD_RULE_SET;
}

// ── 百货审核字段(P2,2026-07-06)──────────────────────────────────────────
// 百货小票的必填集与免税店不同:无团号/无出境日期,多真字段(金额/门店/品牌/上家)。
// 组装依据 = store_profiles 档案的 fields 声明(唯一真相源);这里只放字段定义,不放店名单。
// 身份字段(护照号/英文名):免税店小票不进必填闸(身份在护照任务上);百货档案声明时
// 按 passportFree 分流,见 buildDeptReceiptFieldRuleSet(断点②,2026-07-20)。
const DEPT_EXTRA_FIELD_DEFS = Object.freeze({
  receiptAmount: Object.freeze({
    label: '金额',
    draftKey: 'receiptAmountFinal',
    finalKey: 'receiptAmountFinal',
    autoKey: 'receiptAmountAuto',
    validation: Object.freeze({ type: 'dept_amount' }),
  }),
  branch: Object.freeze({
    label: '门店',
    draftKey: 'branchFinal',
    finalKey: 'branchFinal',
    autoKey: 'branchAuto',
    validation: Object.freeze({ type: 'dept_branch' }), // 票面4位码原样;码清单仅提示,校验只查格式
  }),
  brand: Object.freeze({
    label: '品牌',
    draftKey: 'brandFinal',
    finalKey: 'brandFinal',
    autoKey: 'brandAuto',
    validation: Object.freeze({ type: 'dept_brand' }), // 白名单=档案 rules.brand
  }),
  upstream: Object.freeze({
    label: '上家',
    draftKey: 'upstreamFinal',
    finalKey: 'upstreamFinal',
    autoKey: 'upstreamAuto',
    validation: Object.freeze({ type: 'dept_upstream' }), // 枚举=档案 rules.upstream
  }),
});

const RECEIPT_BASE_FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(DOC_TYPE_FIELD_RULES[DOC_TYPES.RECEIPT].fields.map((f) => [f.finalKey, f]))
);
// 身份字段定义复用护照档(english_name/passport_no 校验同一套,不造第二份定义)
const PASSPORT_FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(DOC_TYPE_FIELD_RULES[DOC_TYPES.PASSPORT].fields.map((f) => [f.finalKey, f]))
);

// 按百货档案组装该店的小票必填集:店家 + 小票号(乐天百货叫"交易编号") + 档案声明的真字段 + 购买日期。
// profileFields = store_profiles 档案的 fields 数组;combined 店(乐天百货)标签微调。
function buildDeptReceiptFieldRuleSet(profile) {
  const declared = new Set(profile?.fields || []);
  const fields = [];
  fields.push(RECEIPT_BASE_FIELD_BY_KEY.receiptStoreFinal);
  // 身份两键接线(断点②,2026-07-20 行为三合一):档案声明 extractedName/passportNo 时进必填集,
  // 但仅限**非免护照店**(乐天同框票——前端富定义一直必填,后端此前静默丢弃=配置台绿灯谎言)。
  // 免护照店(新世界/现代,passportFree=票面本无护照)勾了也不进:存量 v1 配置还带身份勾,
  // 变必填会整店卡审;它们的身份勾选只等于"面板显示选填格",配置台 UI 同步明示。
  if (!profile?.passportFree) {
    if (declared.has('extractedName')) fields.push(PASSPORT_FIELD_BY_KEY.extractedNameFinal);
    if (declared.has('passportNo')) fields.push(PASSPORT_FIELD_BY_KEY.passportNoFinal);
  }
  const receiptNoDef = RECEIPT_BASE_FIELD_BY_KEY.receiptNoFinal;
  // 百货票号走档案规则校验(dept_receipt_no:位数/带杠从 rules.receiptNo 读),
  // 不走免税店的 receipt_no(解禁口径)。
  //
  // ⚠️ 标签判据 2026-08-01 修正。原来是 `rules.receiptNo.dash === false → 叫「交易编号」`,
  // 依据是"乐天百货 8 位不打杠"。可 0727#13-4 之后三家百货**全部** dash:true —— 实跑确认
  // LOTTE_DEPT / SHINSEGAE_DEPT / HYUNDAI_DEPT 的 dash 都是 true,这个分支**永不成立**,
  // 后端契约(配置台/校验回执)里这个字段一律叫"小票号",而前端硬编码"交易编号",
  // 审核台看着对、后端那份口径已经漂了。
  // 0727#13-1 的口径是"百货就叫交易编号",与打不打杠无关 —— 判据改成"是不是百货"。
  const deptReceiptNoDef = Object.freeze({
    ...receiptNoDef,
    label: '交易编号',
    validation: Object.freeze({ type: 'dept_receipt_no' }),
  });
  fields.push(deptReceiptNoDef);
  for (const key of ['receiptAmount', 'branch', 'brand', 'upstream']) {
    if (declared.has(key)) fields.push(DEPT_EXTRA_FIELD_DEFS[key]);
  }
  if (declared.has('purchaseDate')) fields.push(RECEIPT_BASE_FIELD_BY_KEY.purchaseDateFinal);
  return Object.freeze({ fields: Object.freeze(fields), needsSignature: false });
}

function buildWorkflowMeta() {
  return {
    statusOptions: [...STATUS_OPTIONS],
    processResults: { ...PROCESS_RESULTS },
    workflowHeadings: { ...WORKFLOW_HEADINGS },
    queueGroupMeta: {
      priority: { ...QUEUE_GROUP_META.priority },
      review: { ...QUEUE_GROUP_META.review },
      done: { ...QUEUE_GROUP_META.done },
    },
    docTypeLabels: { ...DOC_TYPE_LABELS },
    docTypeFieldRules: Object.fromEntries(
      Object.entries(DOC_TYPE_FIELD_RULES).map(([docType, config]) => [
        docType,
        {
          needsSignature: config.needsSignature,
          fields: config.fields.map((field) => ({ ...field })),
        },
      ])
    ),
    signature: {
      defaultStyle: DEFAULT_SIGNATURE_STYLE,
      styleOptions: [...SIGNATURE_STYLE_OPTIONS],
      jobLabels: { ...SIGNATURE_JOB_LABELS },
      finalSourceLabels: { ...FINAL_SIGNATURE_SOURCE_LABELS },
    },
  };
}

module.exports = {
  DEFAULT_SIGNATURE_STYLE,
  DEPT_EXTRA_FIELD_DEFS,
  DOC_TYPE_FIELD_RULES,
  DOC_TYPE_LABELS,
  FINAL_SIGNATURE_SOURCE_LABELS,
  PROCESS_RESULTS,
  QUEUE_GROUP_META,
  SIGNATURE_JOB_LABELS,
  SIGNATURE_STYLE_OPTIONS,
  STATUS_OPTIONS,
  WORKFLOW_HEADINGS,
  buildDeptReceiptFieldRuleSet,
  buildWorkflowMeta,
  getDocTypeFieldRuleSet,
};
