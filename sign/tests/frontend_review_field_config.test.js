const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadReviewFieldConfigModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/reviewFieldConfig.js'
  )).href);
}

test('review field config shows departure date for receipts but not passports', async () => {
  const { getReviewFieldConfig } = await loadReviewFieldConfigModule();

  const receipt = getReviewFieldConfig('receipt');
  const passport = getReviewFieldConfig('passport');

  assert.deepEqual(receipt.fields.map((field) => field.key), [
    'receiptStoreFinal',
    'receiptNoFinal',
    'groupNoFinal',
    'purchaseDateFinal',
    'departureDateFinal',
  ]);
  assert.equal(receipt.needsSignaturePanel, false);
  assert.deepEqual(passport.fields.map((field) => field.key), [
    'extractedNameFinal',
    'passportNoFinal',
  ]); // 2026-06-30 中文名下线,护照只审英文名 + 护照号
  assert.equal(passport.needsSignaturePanel, false); // 2026-06-12 签字面板下线
});

test('免税小票店家选择器只含 5 家免税店(百货已提为一等档,不再混入)', async () => {
  const { getReviewFieldConfig } = await loadReviewFieldConfigModule();

  const receiptStoreField = getReviewFieldConfig('receipt').fields.find((field) => field.key === 'receiptStoreFinal');

  assert.equal(receiptStoreField.inputType, 'choice');
  assert.deepEqual(receiptStoreField.options.map((option) => option.value), [
    'LOTTE',
    'THE SHILLA',
    'SHILLA IPARK',
    'SHINSEGAE',
    'HYUNDAI',
  ]);
  // 百货 3 家绝不出现在免税小票店家选择器里
  const values = receiptStoreField.options.map((o) => o.value);
  assert.ok(!values.some((v) => /_DEPT$/.test(v)), '免税店选择器不得含百货店');
});

test('百货面板店家选择器只含 3 家百货(不混免税店)', async () => {
  const { getReviewFieldConfig, DEPT_STORE_PICK_CONFIG } = await loadReviewFieldConfigModule();

  for (const store of ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT']) {
    const storeField = getReviewFieldConfig('receipt', store).fields.find((f) => f.key === 'receiptStoreFinal');
    assert.deepEqual(storeField.options.map((o) => o.value), ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT'], `${store} 店家选择器应只含百货 3 家`);
  }
  // 选店中伪面板:只暴露百货店家选择,标记 pendingDeptStore
  assert.equal(DEPT_STORE_PICK_CONFIG.pendingDeptStore, true);
  assert.deepEqual(DEPT_STORE_PICK_CONFIG.fields.map((f) => f.key), ['receiptStoreFinal']);
  assert.deepEqual(DEPT_STORE_PICK_CONFIG.fields[0].options.map((o) => o.value), ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT']);
});

test('门店码→免税店名:前后端映射逐字一致(防副本漂移)+ deptBranchName 行为', async () => {
  const { deptBranchName, LOTTE_DEPT_BRANCH_NAMES } = await loadReviewFieldConfigModule();
  const { PROFILES, deptBranchName: backendBranchName, formatDeptBranch } = require('../lib/store_profiles');
  // 前后端映射逐字一致(唯一真相源在 store_profiles)
  assert.deepEqual({ ...LOTTE_DEPT_BRANCH_NAMES }, { ...PROFILES.LOTTE_DEPT.rules.branchNames });
  // 码→店名(前端)
  assert.equal(deptBranchName('0001'), '明洞');
  assert.equal(deptBranchName('0394'), '明洞');
  assert.equal(deptBranchName('0348'), '蚕室');
  assert.equal(deptBranchName('0005'), '釜山');
  assert.equal(deptBranchName('0344'), '仁川');
  assert.equal(deptBranchName(' 0002 '), '蚕室'); // 收空格
  assert.equal(deptBranchName('9999'), '');       // 新码不识别→空(码照收)
  assert.equal(deptBranchName(''), '');
  // 后端 deptBranchName 同口径
  assert.equal(backendBranchName('LOTTE_DEPT', '0001'), '明洞');
  assert.equal(backendBranchName('LOTTE_DEPT', '9999'), '');
  // 后端 formatDeptBranch="明洞(0001)";未识别码只留码;空→空
  assert.equal(formatDeptBranch('LOTTE_DEPT', '0001'), '明洞(0001)');
  assert.equal(formatDeptBranch('LOTTE_DEPT', '9999'), '9999');
  assert.equal(formatDeptBranch('LOTTE_DEPT', ''), '');
  assert.equal(formatDeptBranch('SHINSEGAE_DEPT', ''), ''); // 新世界无门店字段
});

test('uiTypeOf:护照/其他/免税小票/百货 归到正确的一等档', async () => {
  const { uiTypeOf } = await loadReviewFieldConfigModule();
  assert.equal(uiTypeOf('passport'), 'passport');
  assert.equal(uiTypeOf('other'), 'other');
  assert.equal(uiTypeOf('receipt', 'LOTTE'), 'receipt');       // 免税小票
  assert.equal(uiTypeOf('receipt', ''), 'receipt');            // 无店:默认免税小票档
  assert.equal(uiTypeOf('receipt', 'LOTTE_DEPT'), 'dept');     // 百货
  assert.equal(uiTypeOf('receipt', 'SHINSEGAE_DEPT'), 'dept');
  assert.equal(uiTypeOf('receipt', '乐天百货'), 'dept');        // 原始识别文字也认
});

test('REVIEW_TIER1_TYPES=护照/小票/百货 三档(其他不占一等档)', async () => {
  const { REVIEW_TIER1_TYPES } = await loadReviewFieldConfigModule();
  assert.deepEqual(REVIEW_TIER1_TYPES.map((t) => t.value), ['passport', 'receipt', 'dept']);
});

// 防副本漂移(2026-07-13):前端 DEPT_FIELD_CONFIGS 是后端 lib/store_profiles.js 的手抄镜像。
// 锁死:每家百货面板声明的字段键 = 该店档案 profile.fields(+ 店家/购买日期 UI 固定项)。
// 任一侧改档案字段而漏改另一侧 → 此测试红,防重演"改规则漏副本"事故。
test('百货字段面板与后端 store_profiles 档案字段一致(防副本漂移)', async () => {
  const { getReviewFieldConfig } = await loadReviewFieldConfigModule();
  const { PROFILES } = require('../lib/store_profiles');

  for (const store of ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT']) {
    const panelKeys = new Set(getReviewFieldConfig('receipt', store).fields.map((f) => f.key));
    // 档案 fields 里的每个真字段(passportNo→passportNoFinal 等)都必须在面板里出现
    for (const f of PROFILES[store].fields) {
      const key = `${f}Final`;
      assert.ok(panelKeys.has(key), `${store} 面板缺少档案字段 ${key}(store_profiles 有但面板漏了)`);
    }
    // 面板固定含店家选择;绝不含免税店专属的团号/出境日期
    assert.ok(panelKeys.has('receiptStoreFinal'));
    assert.ok(!panelKeys.has('groupNoFinal'), `${store} 百货面板不得有团号`);
    assert.ok(!panelKeys.has('departureDateFinal'), `${store} 百货面板不得有出境日期`);
  }
});

// 防副本漂移(2026-07-17 复核 MEDIUM):配置台 DEPT_MODE_TO_FAMILY(模式名→店家族)是
// 后端 store_profiles PROFILES[*].mode 的手抄镜像——新增第4家百货/改模式文案漏改这里,
// 渠道模式板块的"去百货店板块配置"跳转卡会静默失效,误导性勾选面板原样复发。
test('配置台百货模式跳转映射与后端档案 mode 一致(防副本漂移)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(
    __dirname, '..', 'frontend', 'src', 'views', 'ConfigConsoleView.vue'
  ), 'utf8');
  const match = src.match(/DEPT_MODE_TO_FAMILY = Object\.freeze\((\{[^}]+\})\)/);
  assert.ok(match, 'ConfigConsoleView 必须保留 DEPT_MODE_TO_FAMILY 映射');
  const { PROFILES } = require('../lib/store_profiles');
  const backend = Object.entries(PROFILES)
    .filter(([, p]) => p.family === 'dept')
    .map(([family, p]) => [p.mode, family]);
  for (const [mode, family] of backend) {
    assert.ok(
      new RegExp(`${mode}:\\s*'${family}'`).test(match[1]),
      `前端映射缺/错「${mode}: '${family}'」(后端 store_profiles 有,前端漏了)`,
    );
  }
  assert.equal((match[1].match(/_DEPT'/g) || []).length, backend.length, '前端映射不得多出后端没有的店');
});

test('百货字段面板(P2):按店切换,无团号/出境日期;切回免税店清残留', async () => {
  const { getReviewFieldConfig, buildReviewFieldPayload } = await loadReviewFieldConfigModule();

  // 乐天百货:店家/英文名/护照号(2026-07-12 报障#2)/交易编号/金额/门店码/品牌/购买日期,无团号/出境日期
  const lotte = getReviewFieldConfig('receipt', 'LOTTE_DEPT');
  assert.deepEqual(lotte.fields.map((f) => f.key), [
    'receiptStoreFinal', 'extractedNameFinal', 'passportNoFinal',
    'receiptNoFinal', 'receiptAmountFinal', 'branchFinal', 'brandFinal', 'purchaseDateFinal',
  ]);
  // 门店改抄票面4位码(2026-07-12 拍板):text 输入,不再是门店名下拉
  assert.equal(lotte.fields.find((f) => f.key === 'branchFinal').inputType, 'text');
  // 撞名防线镜像:任务上的店值是"乐天百货/롯데백화점"也要进百货面板,不能吞进 LOTTE 免税店
  assert.deepEqual(getReviewFieldConfig('receipt', '乐天百货').fields.map((f) => f.key), lotte.fields.map((f) => f.key));

  // 新世界百货:金额+上家(梁总);现代百货:金额(2026-07-12 实票纠正补上)+上家二选一
  const shinsegae = getReviewFieldConfig('receipt', 'SHINSEGAE_DEPT');
  assert.ok(shinsegae.fields.some((f) => f.key === 'receiptAmountFinal'));
  assert.ok(shinsegae.fields.some((f) => f.key === 'upstreamFinal'));
  const hyundai = getReviewFieldConfig('receipt', 'HYUNDAI_DEPT');
  assert.ok(hyundai.fields.some((f) => f.key === 'receiptAmountFinal'));
  assert.ok(hyundai.fields.some((f) => f.key === 'upstreamFinal'));

  // 免税店照旧(不传店/传免税店 → 原字段集,含团号/出境日期)
  assert.ok(getReviewFieldConfig('receipt', 'LOTTE').fields.some((f) => f.key === 'groupNoFinal'));

  // payload:百货店 → 金额留数字、团号/出境日期置空;隐藏字段残值被清
  const deptPayload = buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'LOTTE_DEPT',
    receiptNoFinal: '12345678',
    receiptAmountFinal: '3,500,000원',
    branchFinal: ' 0394 ',
    brandFinal: '루이비통',
    purchaseDateFinal: '2026-07-01',
    groupNoFinal: '99999', // 切店前的残值
    departureDateFinal: '2026-07-03',
    extractedNameFinal: ' hoang ngoc bao ',
    passportNoFinal: ' ej9626615 ',
  });
  assert.equal(deptPayload.receiptAmountFinal, '3500000');
  assert.equal(deptPayload.branchFinal, '0394');
  // 身份字段随面板进 payload,归一与护照口径一致(大写/收空格);
  // 0727反馈#9 起姓名标准=姓␣名段合并(HOANG NGOC BAO → HOANG NGOCBAO)
  assert.equal(deptPayload.extractedNameFinal, 'HOANG NGOCBAO');
  assert.equal(deptPayload.passportNoFinal, 'EJ9626615');
  assert.equal(deptPayload.groupNoFinal, '');
  assert.equal(deptPayload.departureDateFinal, '');

  // 切回免税店 → 百货字段置空
  const dutyPayload = buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '12345678901234',
    groupNoFinal: '12345678',
    purchaseDateFinal: '2026-07-01',
    departureDateFinal: '2026-07-03',
    receiptAmountFinal: '3500000', // 切店前的残值
    branchFinal: '明洞',
  });
  assert.equal(dutyPayload.receiptAmountFinal, '');
  assert.equal(dutyPayload.branchFinal, '');
  assert.equal(dutyPayload.groupNoFinal, '12345678');
});

test('review doc type normalization keeps legacy values mapped', async () => {
  const { normalizeReviewDocType } = await loadReviewFieldConfigModule();

  assert.equal(normalizeReviewDocType('ticket'), 'other');
  assert.equal(normalizeReviewDocType('bad-value'), 'other');
});

test('review field payload normalizes manual receipt and passport edits before save', async () => {
  const { buildReviewFieldPayload } = await loadReviewFieldConfigModule();

  assert.deepEqual(buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'THE SHILLA',
    receiptNoFinal: '0.03-261-540-0008-0',
    groupNoFinal: 'G-12345',
    purchaseDateFinal: '26/04/20',
    departureDateFinal: '2026.04.22',
  }), {
    docTypeFinal: 'receipt',
    extractedNameFinal: '',
    passportNoFinal: '',
    receiptStoreFinal: 'THE SHILLA',
    // 2026-07-06 回弹bug修复:前端对齐后端解禁口径,小票号保留横线(过去被剥成纯数字)
    receiptNoFinal: '03-261-540-0008-0',
    groupNoFinal: '12345',
    purchaseDateFinal: '2026-04-20',
    departureDateFinal: '2026-04-22',
    // 百货字段(P2):免税店恒空
    receiptAmountFinal: '',
    branchFinal: '',
    brandFinal: '',
    upstreamFinal: '',
  });

  assert.equal(buildReviewFieldPayload('passport', {
    extractedNameFinal: 'MSL1 POCHN XUE YUCHEN',
    passportNoFinal: ' eg 8761171 ',
  }).extractedNameFinal, 'XUE YUCHEN');

  assert.equal(buildReviewFieldPayload('passport', {
    extractedNameFinal: 'MLZ1 POCHN XUE YUCHEN',
  }).extractedNameFinal, 'XUE YUCHEN');
});

test('review field config normalizes loaded receipt values before display', async () => {
  const { normalizeReviewFieldsForTask } = await loadReviewFieldConfigModule();

  assert.deepEqual(normalizeReviewFieldsForTask({
    docTypeFinal: 'receipt',
    receiptStoreFinal: 'THE SHILLA',
    receiptNoFinal: '0.03-261-635-0019-5',
    groupNoFinal: 'G-12345',
    purchaseDateFinal: '26/05/11',
    departureDateFinal: '2026.05.12',
  }), {
    docTypeFinal: 'receipt',
    extractedNameFinal: '',
    passportNoFinal: '',
    receiptStoreFinal: 'THE SHILLA',
    // 回弹bug修复:显示层同口径保留横线(后端存了带杠值,界面必须原样显示)
    receiptNoFinal: '03-261-635-0019-5',
    groupNoFinal: '12345',
    purchaseDateFinal: '2026-05-11',
    departureDateFinal: '2026-05-12',
    // 百货字段(P2):免税店恒空
    receiptAmountFinal: '',
    branchFinal: '',
    brandFinal: '',
    upstreamFinal: '',
  });
});

// ⭐2026-07-06 回弹bug(用户实锤:手补 90G203-26-000309 点确认被剥成 9020326000309):
// 前端归一化曾是 normalizeDigits,与后端 2026-07 解禁口径(保字母+横线)不同步。
// 此测试锁死:前端 normalizeReceiptNo/normalizeGroupNo 必须与后端逐字同口径。
test('回弹bug回归:小票号/团号前后端归一化口径逐字一致(字母+横线不再被剥)', async () => {
  const { buildReviewFieldPayload } = await loadReviewFieldConfigModule();
  const backend = require('../lib/workbench_field_normalizer');

  const receiptNoSamples = [
    '90G203-26-000309',      // 济州乐天带字母带杠(用户报障那张)
    '05-260703-093-00075',   // 新世界 BILL NO 四段带杠
    '0326163500043',         // 新罗纯数字
    'NO. 03-264-383-0004-3', // 带标签前缀
    '0.03-261-540-0008-0',   // OCR 把 03 误带 0. 前缀
    ' 90g331--777 ',         // 小写/连杠/首尾空白
  ];
  for (const s of receiptNoSamples) {
    const frontend = buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE', receiptNoFinal: s }).receiptNoFinal;
    const expected = backend.normalizeEditableFieldsForDocType('receipt', { receiptNoFinal: s }).receiptNoFinal;
    assert.equal(frontend, expected, `小票号口径分叉: "${s}" 前端=${frontend} 后端=${expected}`);
  }
  // 用户报障场景:字母和横线原样保留,不再"确认后弹回"
  assert.equal(
    buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE', receiptNoFinal: '90G203-26-000309' }).receiptNoFinal,
    '90G203-26-000309',
  );

  const groupNoSamples = [
    'R2299001',   // 乐天R团带字母
    'G-12345',    // 标签前缀剥掉
    'G : 71990',  // 标签+空格
    '26907555',   // 纯数字
    '无',         // 机场票合法值
    '无团号',
  ];
  for (const s of groupNoSamples) {
    const frontend = buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE', groupNoFinal: s }).groupNoFinal;
    const expected = backend.normalizeEditableFieldsForDocType('receipt', { groupNoFinal: s }).groupNoFinal;
    assert.equal(frontend, expected, `团号口径分叉: "${s}" 前端=${frontend} 后端=${expected}`);
  }
  assert.equal(buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE', groupNoFinal: 'R2299001' }).groupNoFinal, 'R2299001');
  assert.equal(buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE', groupNoFinal: '无' }).groupNoFinal, '无');
});

test('百货身份字段前后端口径逐字一致(2026-07-12 复审:双份实现必须交叉锁定)', async () => {
  const { buildReviewFieldPayload } = await loadReviewFieldConfigModule();
  const backend = require('../lib/workbench_field_normalizer');

  const samples = [
    { extractedNameFinal: ' hoang ngoc bao ', passportNoFinal: ' ej 9626615 ' },
    { extractedNameFinal: 'ZHANG  LIYA', passportNoFinal: 'e-g8761171' },
    { extractedNameFinal: '', passportNoFinal: '' },
  ];
  for (const s of samples) {
    const fe = buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE_DEPT', ...s });
    const be = backend.normalizeEditableFieldsForDocType('receipt', { receiptStoreFinal: 'LOTTE_DEPT', ...s });
    assert.equal(fe.extractedNameFinal, be.extractedNameFinal,
      `英文名口径分叉: ${JSON.stringify(s.extractedNameFinal)} 前端=${fe.extractedNameFinal} 后端=${be.extractedNameFinal}`);
    assert.equal(fe.passportNoFinal, be.passportNoFinal,
      `护照号口径分叉: ${JSON.stringify(s.passportNoFinal)} 前端=${fe.passportNoFinal} 后端=${be.passportNoFinal}`);
  }
});

test('免护照店旗标三处锁平:store_profiles.passportFree ↔ 前端无票级身份格 ↔ groupHasPassport', async () => {
  const { getStoreProfile } = require('../lib/store_profiles');
  const { getReviewFieldConfig } = await loadReviewFieldConfigModule();
  const { groupHasPassport } = await import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/reviewDisplay.js'
  )).href);

  for (const store of ['SHINSEGAE_DEPT', 'HYUNDAI_DEPT']) {
    assert.equal(getStoreProfile(store).passportFree, true, `${store} 档案应标 passportFree`);
    // 2026-07-17 用户拍板:票面无护照,票级身份格整体下线(原 2026-07-14 为选填)——
    // 出厂档案 fields 与前端面板都不再含 passportNo/extractedName
    assert.ok(!getStoreProfile(store).fields.includes('passportNo'), `${store} 出厂档案不含票级护照`);
    assert.ok(!getStoreProfile(store).fields.includes('extractedName'), `${store} 出厂档案不含票级姓名`);
    const keys = getReviewFieldConfig('receipt', store).fields.map((item) => item.key);
    assert.ok(!keys.includes('passportNoFinal'), `${store} 前端不再渲染护照号格`);
    assert.ok(!keys.includes('extractedNameFinal'), `${store} 前端不再渲染姓名格`);
    assert.equal(groupHasPassport([{ docTypeFinal: 'receipt', receiptStoreFinal: store }]), true, `${store} 纯组应算护照齐`);
  }
  // 乐天百货=同框票:档案不标 passportFree、前端必填、纯组无身份不算齐
  assert.ok(!getStoreProfile('LOTTE_DEPT').passportFree);
  const lotteField = getReviewFieldConfig('receipt', 'LOTTE_DEPT').fields.find((item) => item.key === 'passportNoFinal');
  assert.ok(lotteField, '乐天百货保留护照号格');
  assert.ok(!lotteField.optional);
  assert.equal(groupHasPassport([{ docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT' }]), false);
});

test('断点⑥根修:extraAllowedKeys 并集白名单——配置新增字段的值不再被保存置空', async () => {
  const { buildReviewFieldPayload } = await loadReviewFieldConfigModule();
  // 乐天配置勾了富定义没有的「上家」:extras 注入 upstreamFinal → 值保留(此前恒置空=
  // 填了就清、后端必填又打回的死循环)
  const withExtra = buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', upstreamFinal: ' 梁总 ',
  }, ['upstreamFinal']);
  assert.equal(withExtra.upstreamFinal, '梁总');
  // 不传 extras(旧调用形态)→ 行为逐字节不变:富定义外字段仍置空(切店清残留语义不动)
  const withoutExtra = buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', upstreamFinal: '梁总',
  });
  assert.equal(withoutExtra.upstreamFinal, '');
  // 并集只增不减:extras 空数组时出厂字段照常保留(配置"放宽"绝不清已填值——丢数据红线)
  const relax = buildReviewFieldPayload('receipt', {
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', brandFinal: '루이비통',
  }, []);
  assert.equal(relax.brandFinal, '루이비통');
  // 垃圾键防注入:不在 REVIEW_FIELD_KEYS 的 extras 一律忽略
  const junk = buildReviewFieldPayload('receipt', { receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '1' }, ['__proto__', 'docTypeFinal', 'nope']);
  assert.equal(junk.docTypeFinal, 'receipt');
});

// ── 0727反馈#6:门店码点选(审核台 chips + 配置台增减)接线契约 ─────────────────
test('门店码点选接线:FieldEditor chips 走 runtime 清单(回落出厂镜像),配置台有编辑器+如实边界', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../frontend/src/components/FieldEditor.vue'), 'utf8');
  assert.match(fe, /runtimeBranchOptions/, '清单来自 /review-config 运行时');
  assert.match(fe, /LOTTE_DEPT_BRANCH_NAMES/, '拉不到回落前端出厂镜像');
  assert.match(fe, /branch-chip-row/, '门店码渲染成可点 chips');
  assert.match(fe, /pickBranchChip/, '点码即填');
  const rt = fs2.readFileSync(path2.join(__dirname, '../frontend/src/lib/runtimeReviewConfig.js'), 'utf8');
  assert.match(rt, /export function runtimeBranchOptions/);
  const cc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/ConfigConsoleView.vue'), 'utf8');
  assert.match(cc, /门店码点选清单/, '配置台有清单编辑块');
  assert.match(cc, /saveStoreBranchOptions/, '保存走专用端点');
  assert.match(cc, /生效边界/, '断点①同款如实口径:清单只喂审核台,台账/交付映射走出厂表');
});

// ── 0728 红批注核对:「00394」前导零异常码归对店(生产包实锤:码自成一夹与明洞并列) ──
test('deptBranchName 前导零容错:00394→明洞(前后端同口径);仍未识别照旧回空', async () => {
  const { deptBranchName } = await loadReviewFieldConfigModule();
  const { deptBranchName: backendBranchName } = require('../lib/store_profiles');
  assert.equal(deptBranchName('00394'), '明洞');
  assert.equal(backendBranchName('LOTTE_DEPT', '00394'), '明洞');
  assert.equal(deptBranchName('000001'), '明洞', '多个前导零也归对');
  assert.equal(backendBranchName('LOTTE_DEPT', '000001'), '明洞');
  assert.equal(deptBranchName('09999'), '', '压零后仍不在表 → 空(码照收)');
  assert.equal(backendBranchName('LOTTE_DEPT', '09999'), '');
  assert.equal(deptBranchName('0394'), '明洞', '正常码行为不变');
});
