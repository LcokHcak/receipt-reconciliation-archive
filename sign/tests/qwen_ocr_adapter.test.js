'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 本文件的既有用例按"锚点触发二遍"(anchor 模式)语义编写;二批(2026-07-21)默认改为
// always 全量双读后,这里钉住 anchor 模式保持原断言语义(always 行为在
// qwen_receipt_no_anchors.test.js 单独覆盖;node --test 每文件独立进程,不串场)。
process.env.QWEN_RECEIPT_NO_REPAIR_MODE = 'anchor';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { computeCheckDigit, parseTd3, resolvePassportNo, isPlausiblePassportNo } = require('../lib/qwen_ocr/mrz_parser');
const { collectPassportCandidates, pickPassportNo } = require('../lib/qwen_ocr/passport_resolver');
const {
  groupDigits, consensusGroupNo, normalizeDate, normalizeStoreFamily,
  normalizeDeptAmount, normalizeDeptBranch, normalizeDeptBrand,
} = require('../lib/qwen_ocr/field_normalizer');
const { createQwenOcrBackend } = require('../lib/qwen_ocr/qwen_ocr_adapter');
const { buildLayoutPrompt, QWEN_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
const { isSidecarReusable } = require('../lib/qwen_ocr/sidecar');

// sidecar 复用判定(2026-07-03 双根治):旧 prompt 缓存潜伏回放(71990 借尸还魂)+
// 故障期 qwen_failed 兜底被永久缓存(毒 sidecar 事故),都在这一个判定里堵死。
test('isSidecarReusable:版本不符/无版本戳/qwen_failed 一律作废;同版本 no_document 可复用', () => {
  const ok = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [] };
  assert.equal(isSidecarReusable(ok, QWEN_PROMPT_VERSION), true);
  // 改 prompt 前写的缓存(无版本戳)→ 作废重调
  assert.equal(isSidecarReusable({ reviewReasons: [] }, QWEN_PROMPT_VERSION), false);
  // 旧版本 → 作废
  assert.equal(isSidecarReusable({ promptVersion: QWEN_PROMPT_VERSION - 1 }, QWEN_PROMPT_VERSION), false);
  // API 故障兜底 → 永不复用(下次处理时真调)
  assert.equal(isSidecarReusable({ promptVersion: QWEN_PROMPT_VERSION, reviewReasons: ['qwen_failed'] }, QWEN_PROMPT_VERSION), false);
  // 真无证件(航班截图)是正常结论 → 同版本照常复用,省 API
  assert.equal(isSidecarReusable({ promptVersion: QWEN_PROMPT_VERSION, reviewReasons: ['qwen_no_document'] }, QWEN_PROMPT_VERSION), true);
  // 脏输入
  assert.equal(isSidecarReusable(null, QWEN_PROMPT_VERSION), false);
});

// ⭐模型/分辨率戳(2026-07-21 换 qwen3-vl-plus 部署审计):切模型/分辨率后旧 sidecar 必须作废,
// 否则模型/高清切换对存量预处理是静默 no-op(旧 max@1280 缓存 promptVersion 相同被当有效)。
test('isSidecarReusable:模型/分辨率戳不符或无戳 → 作废;一致 → 复用;不传 opts 保持旧行为', () => {
  const fresh = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], ocrModel: 'qwen3-vl-plus', ocrMaxEdge: 2400 };
  // 不传 opts:老行为(只认 promptVersion),照常复用
  assert.equal(isSidecarReusable(fresh, QWEN_PROMPT_VERSION), true);
  // 传当前 model/maxEdge 且一致 → 复用
  assert.equal(isSidecarReusable(fresh, QWEN_PROMPT_VERSION, { model: 'qwen3-vl-plus', maxEdge: 2400 }), true);
  // 换了模型 → 作废
  assert.equal(isSidecarReusable(fresh, QWEN_PROMPT_VERSION, { model: 'qwen-vl-max', maxEdge: 2400 }), false);
  // 换了分辨率 → 作废
  assert.equal(isSidecarReusable(fresh, QWEN_PROMPT_VERSION, { model: 'qwen3-vl-plus', maxEdge: 1280 }), false);
  // 旧缓存无戳(qwen-vl-max 时代)在切换后一律作废
  const old = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [] };
  assert.equal(isSidecarReusable(old, QWEN_PROMPT_VERSION, { model: 'qwen3-vl-plus', maxEdge: 2400 }), false);
  // 但不传 opts 时旧缓存照常复用(未切换的部署不受打扰)
  assert.equal(isSidecarReusable(old, QWEN_PROMPT_VERSION), true);
});

// L482:进程内 Map 缓存是 sidecar 之外的第二层缓存,存活过 sidecar 删除。extractAnalyses 默认
// useCache:true 供建档首建复用;但 useCache:false 必须真调 qwen 拿新结果——ensureQwenSidecar
// 走此路(换模型/purge-sidecar+requeue 重识别),否则回放旧 OCR。锁 useCache 两态语义。
test('adapter L482: useCache:true 命中进程内 Map(同引用回放);useCache:false 绕过缓存(新识别)', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_cache_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      { type: 'receipt', confidence: 0.9, bbox: [0, 0, 1, 1], fields: { storeFamily: 'THE SHILLA', receiptNo: '0326163500159', purchaseDate: '2026-01-16' } },
    ] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    // 用引用相等判缓存(不依赖内部二遍/补救的调用次数,稳定):命中 Map 返回同一数组引用。
    const r1 = await backend.extractAnalyses(tmp);              // useCache:true(默认)→ 真调 + 存 Map
    const r2 = await backend.extractAnalyses(tmp);              // useCache:true → 命中 Map,回放同一数组
    assert.strictEqual(r1, r2, 'useCache:true 第二次回放进程内缓存(同一数组引用)');
    const r3 = await backend.extractAnalyses(tmp, { useCache: false }); // 绕过 Map → 新识别、新数组
    assert.notStrictEqual(r1, r3, 'L482:useCache:false 不回放缓存,产出新的识别结果(ensureQwenSidecar 靠它重识别拿新 OCR)');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// 适配器给每条 analysis 打上 ocrModel/ocrMaxEdge 戳(供上面复用判定)
test('adapter: analysis 打模型/分辨率戳', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_stamp_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      { type: 'receipt', confidence: 0.9, bbox: [0, 0, 1, 1], fields: { storeFamily: 'THE SHILLA', receiptNo: '0326163500159', purchaseDate: '2026-01-16' } },
    ] }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 50 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen3-vl-plus', maxEdge: 2400, fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.ocrModel, 'qwen3-vl-plus');
    assert.equal(a.ocrMaxEdge, 2400);
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ⭐部署护栏(2026-07-21):内容审核拒绝标记 + 模型回退
test('client: DataInspectionFailed → err.contentRejected;403/404 → err.modelUnavailable', async () => {
  const { analyzeImage } = require('../lib/qwen_ocr/qwen_client');
  const mkFetch = (status, body) => async () => ({ ok: false, status, text: async () => body, headers: { get: () => null } });
  await assert.rejects(
    () => analyzeImage({ imageBase64Url: 'x', apiKey: 'k', baseUrl: 'http://x', model: 'm', fetchImpl: mkFetch(400, '{"code":"data_inspection_failed"}') }),
    (e) => { assert.equal(e.contentRejected, true); assert.ok(!e.modelUnavailable); return true; },
  );
  await assert.rejects(
    () => analyzeImage({ imageBase64Url: 'x', apiKey: 'k', baseUrl: 'http://x', model: 'm', fetchImpl: mkFetch(403, 'Access denied') }),
    (e) => { assert.equal(e.modelUnavailable, true); return true; },
  );
});

test('adapter: 主模型 modelUnavailable → 回退 QWEN_FALLBACK_MODEL 重试一次', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_fb_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const m = JSON.parse(opts.body).model;
    calls.push(m);
    if (m === 'qwen3-vl-plus') return { ok: false, status: 403, text: async () => 'Access denied', headers: { get: () => null } };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ documents: [{ type: 'receipt', confidence: 0.9, bbox: [0, 0, 1, 1], fields: { storeFamily: 'THE SHILLA', receiptNo: '0326163500159', purchaseDate: '2026-01-16' } }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen3-vl-plus', fallbackModel: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.ok(calls.includes('qwen3-vl-plus') && calls.includes('qwen-vl-max'), '先主后回退');
    assert.equal(a.docTypeFinal, 'receipt', '回退模型出结果');
    assert.equal(backend.getUsage().fallbacks, 1);
    // L487:回退结果的 ocrModel 戳必须是实际所用的回退模型,不是主模型——否则主模型恢复后
    // isSidecarReusable 判可复用,降级结果永不重识别。
    assert.equal(a.ocrModel, 'qwen-vl-max', 'L487:回退结果戳成实际所用回退模型(诚实戳→主模型恢复后重识别)');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// 2026-07-03 生产事故:prompt 里团号示例写了真值 "G : 71990",模型找不到团号时照抄示例,
// 38 个任务团号全成 71990(还命中团号表出了错模式)。锁死:标签后不得跟具体数字示例。
test('prompt 防泄漏:团号/小票号标签后不得包含可照抄的示例数字', () => {
  const p = buildLayoutPrompt();
  assert.ok(!/(?:GT|GROUP|G)\s*[:：]\s*\d{4,}/i.test(p), '团号标签后跟着数字示例会被模型照抄');
  assert.ok(!p.includes('71990'), '历史泄漏值必须绝迹');
  assert.ok(p.includes('SHINSEGAE'), '新世界要在店名白名单里');
  assert.ok(p.includes('HYUNDAI'), '现代要在店名白名单里');
});

const normAlnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ⭐派生式泄漏守卫(2026-07-13 架构体检):禁用码集从 store_profiles 现场收集,
// 不再手抄——往任何档案加新门店码,这里自动开始设防(0348 泄漏事故的根治版)。
function collectProfileBranchCodes() {
  const { PROFILES } = require('../lib/store_profiles');
  const codes = new Set();
  for (const profile of Object.values(PROFILES)) {
    const branch = profile.rules && Array.isArray(profile.rules.branch) ? profile.rules.branch : [];
    for (const code of branch) codes.add(String(code));
  }
  return [...codes];
}


// ── MRZ ──────────────────────────────────────────────
test('mrz: 校验位算法(标准向量 L898902C3 = 6)', () => {
  assert.equal(computeCheckDigit('L898902C3'), 6);
});

test('mrz: parseTd3 解析标准 TD3 向量', () => {
  const r = parseTd3('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10');
  assert.equal(r.passportNo, 'L898902C3');
  assert.equal(r.passportNoValid, true);
  assert.equal(r.nationality, 'UTO');
  assert.equal(r.sex, 'F');
});

test('mrz: resolvePassportNo 用校验通过的 MRZ 纠正直读误读(E0→EQ)', () => {
  const num = 'EQ9404549';
  const cd = computeCheckDigit(num);
  const mrz2 = `${num}${cd}CHN9404011M3001011<<<<<<<<<<00`;
  const r = resolvePassportNo('E09404549', 'P<CHNX<<Y', mrz2);
  assert.equal(r.passportNo, 'EQ9404549');
  assert.equal(r.mrzValid, true);
  assert.equal(r.needsReview, false);
});

// #3(2026-07-06):护照号 0↔Q 病例——直读和 MRZ 被同一模型"双双读错"(EQ0727948→E00727948),
// 走"两路一致"免审+三色灯认标准格式 → 错号拿绿灯。修:校验位引导单字符易混修复 + 一致不再当印证。
test('mrz: 校验位引导修复——双双读错 E0↔EQ 用校验位数学仲裁自动纠正', () => {
  const { repairPassportNoByChecksum } = require('../lib/qwen_ocr/mrz_parser');
  const trueNo = 'EQ0727948'; // 用户截图病例
  const cd = computeCheckDigit(trueNo);
  const misreadMrz2 = `E00727948${cd}CHN9110317F3508046<<<<<<<<<<00`;
  // 直读也读错成 E00727948(相关性误读)→ 修复分支把它纠回 EQ0727948
  const r = resolvePassportNo('E00727948', 'P<CHNZHANG<<XIN', misreadMrz2);
  assert.equal(r.passportNo, trueNo);
  assert.equal(r.source, 'mrz-checksum-repaired');
  assert.equal(r.needsReview, false);
  assert.equal(r.mrzValid, true);

  // 唯一性:同号段直接调修复函数也只给一个候选
  assert.equal(repairPassportNoByChecksum('E00727948', String(cd)), trueNo);

  // 校验位字符本身被读成字母(如 1→I):号段不动,反推数字后验原号段
  let numForCd1 = '';
  for (let d = 0; d <= 9 && !numForCd1; d += 1) {
    const cand = `EK537258${d}`;
    if (computeCheckDigit(cand) === 1) numForCd1 = cand;
  }
  if (numForCd1) {
    assert.equal(repairPassportNoByChecksum(numForCd1, 'I'), numForCd1);
  }

  // 修不出(校验位彻底不对)→ 不敢猜,返回空
  assert.equal(repairPassportNoByChecksum('E00727948', String((cd + 5) % 10)), '');
});

test('mrz: 两路一致但校验位没过且修不出 → 不再当印证,标未验证转人工', () => {
  const cd = computeCheckDigit('EQ0727948');
  const badCheck = String((cd + 5) % 10); // 校验位也读坏,修复无解
  const mrz2 = `E00727948${badCheck}CHN9110317F3508046<<<<<<<<<<00`;
  const r = resolvePassportNo('E00727948', 'P<CHNZHANG<<XIN', mrz2);
  assert.equal(r.passportNo, 'E00727948'); // 保值
  assert.equal(r.source, 'agree');
  assert.equal(r.needsReview, true, '同模型相关性误读,一致≠印证,必须转人工');
});

test('mrz: 校验没过且与直读不一致 → 保留直读 + 转人工', () => {
  const r = resolvePassportNo('E09404549', '', 'EQ9404549XCHN9404011M3001011<<<<<<<<<<00');
  assert.equal(r.needsReview, true);
  assert.equal(r.passportNo, 'E09404549'); // 不采纳未验证的 MRZ
});

test('mrz: isPlausiblePassportNo 格式闸', () => {
  assert.equal(isPlausiblePassportNo('EQ4032090'), true);
  assert.equal(isPlausiblePassportNo('E12345678'), true);
  assert.equal(isPlausiblePassportNo('CHN781807'), false); // 含国籍码
  assert.equal(isPlausiblePassportNo('6CHN02041'), false); // 数字开头+含CHN
  assert.equal(isPlausiblePassportNo('12345678'), false); // 数字开头
  assert.equal(isPlausiblePassportNo(''), false);
});

test('mrz: 合理性闸 — 校验位碰巧过但护照号含CHN → 不采信,退回直读(防假阳性弄坏对的)', () => {
  const bad = '6CHN02041'; // 实测假阳性:MRZ 把国籍行读串进护照号位
  const cd = computeCheckDigit(bad);
  const mrz2 = `${bad}${cd}CHN9404011M3001011<<<<<<<<<<00`;
  const r = resolvePassportNo('EM0674593', 'P<CHNX<<Y', mrz2);
  assert.equal(r.passportNo, 'EM0674593'); // 退回直读,不被假阳性弄坏
  assert.equal(r.source, 'mrz-implausible');
  assert.equal(r.needsReview, true);
});

// ── passport_resolver(跨源) ─────────────────────────
test('passport_resolver: MRZ 有效源优先于小票', () => {
  const num = 'EK5372586';
  const cd = computeCheckDigit(num);
  const docs = [
    { type: 'passport', fields: { passportNo: 'EK537258', mrz1: '', mrz2: `${num}${cd}CHN...` } },
    { type: 'receipt', fields: { passportNo: 'EK5372500' } },
  ];
  const r = pickPassportNo(collectPassportCandidates(docs));
  assert.equal(r.passportNo, num);
  assert.equal(r.mrzValid, true);
});

test('passport_resolver: 无MRZ时多源共识 + 单源转人工', () => {
  const agree = pickPassportNo([
    { no: 'EP3012345', mrzValid: false }, { no: 'EP3012345', mrzValid: false },
  ]);
  assert.equal(agree.passportNo, 'EP3012345');
  assert.equal(agree.needsReview, false);
  const single = pickPassportNo([{ no: 'EP3012345', mrzValid: false }]);
  assert.equal(single.needsReview, true); // 仅单一未验证源 → 人工
});

// ── field_normalizer ─────────────────────────────────
test('field_normalizer: groupDigits 取4-6位,滤柜台/品牌/小票号', () => {
  assert.equal(groupDigits('G : 71990'), '71990');
  assert.equal(groupDigits('045[LOEWE]'), '');     // 3位柜台码
  assert.equal(groupDigits('0326134000203'), '');  // 13位小票号不当团号
  assert.equal(groupDigits('CORNER 1234 G : 5678'), '5678'); // 整行含柜台号1234,优先取标签后的团号
  // 多店格式:乐天8位、多标签
  assert.equal(groupDigits('12345678', 8), '12345678');      // 乐天 8 位(按店期望长度)
  assert.equal(groupDigits('GROUP 12345678'), '12345678');   // 标签 GROUP
  assert.equal(groupDigits('단체 70012'), '70012');           // 标签 단체
  assert.equal(groupDigits('CORNER 045 G:71990', 5), '71990'); // 新罗5位,标签优先于柜台码045
  assert.equal(groupDigits('[GT:79611]'), '79611');             // 新世界 GT 标签(GT须排在G前,否则G先咬住T匹配失败)
  assert.equal(groupDigits('Group : 26906572', 8), '26906572'); // 乐天 Group 标签 8 位
  assert.equal(groupDigits('无'), '无');                         // 机场票团号"无"透传
  assert.equal(groupDigits(' 无团号 '), '无');
  assert.equal(consensusGroupNo(['G:71990', '71990', '045[LOEWE]']), '71990');
  assert.equal(normalizeDate('2026/01/24'), '2026-01-24');
  // store 映射到 sign 校验器认的规范值(THE SHILLA / LOTTE / SHILLA IPARK)
  assert.equal(normalizeStoreFamily('THE SHILLA duty free'), 'THE SHILLA');
  assert.equal(normalizeStoreFamily('新罗'), 'THE SHILLA');
  assert.equal(normalizeStoreFamily('LOTTE DUTY FREE'), 'LOTTE');
  assert.equal(normalizeStoreFamily('신라아이파크'), 'SHILLA IPARK');
});

// ⭐撞名防线全链路(2026-07-06 P1 洞):qwen 侧粗映射若被 /乐天|LOTTE/ 先咬住"乐天百货",
// 归一成 LOTTE 免税店 → isDeptStore=false → 百货短路(整图不切)永远不触发。
// 百货标记词必须在 qwen 侧原样透传,由 validation 层撞名防线分流到 *_DEPT。
test('field_normalizer: 百货标记词透传,不被免税店正则吃掉', () => {
  assert.equal(normalizeStoreFamily('乐天百货'), '乐天百货');
  assert.equal(normalizeStoreFamily('롯데백화점'), '롯데백화점');
  // DEPARTMENT 不含连续子串 DEPT(D-E-P-A-R-T),两个词都得能透传
  assert.equal(normalizeStoreFamily('LOTTE DEPARTMENT'), 'LOTTE DEPARTMENT');
  assert.equal(normalizeStoreFamily('LOTTE DEPT'), 'LOTTE DEPT');
  assert.equal(normalizeStoreFamily('신세계백화점'), '신세계백화점');
  // 免税店照旧,不受透传影响
  assert.equal(normalizeStoreFamily('乐天免税店'), 'LOTTE');
  assert.equal(normalizeStoreFamily('LOTTE DUTY FREE'), 'LOTTE');
});

// #5 垃圾值过滤(2026-07-06,实锤病例 task_0162:清晰图 conf0.95 输出全0小票号+12345团号+2023日期)
test('field_normalizer: isJunkNumericValue 全同数字/从头顺子=编造;真实值不误伤', () => {
  const { isJunkNumericValue } = require('../lib/qwen_ocr/field_normalizer');
  assert.equal(isJunkNumericValue('0000-0000-0000-0000'), true); // 病例原值
  assert.equal(isJunkNumericValue('0000000000000000'), true);
  assert.equal(isJunkNumericValue('12345'), true);               // 病例团号(还骗过5位长度规则)
  assert.equal(isJunkNumericValue('123456'), true);
  assert.equal(isJunkNumericValue('0123'), true);
  assert.equal(isJunkNumericValue('1111'), true);
  // 真实值零误伤
  assert.equal(isJunkNumericValue('0326438300043'), false); // 新罗真票号
  assert.equal(isJunkNumericValue('90G203-26-000309'), false); // 济州乐天带字母
  assert.equal(isJunkNumericValue('26907555'), false);      // 真团号
  assert.equal(isJunkNumericValue('71990'), false);
  assert.equal(isJunkNumericValue('无'), false);
  assert.equal(isJunkNumericValue(''), false);
  assert.equal(isJunkNumericValue('123'), false);           // <4位不判(柜台码等)
});

test('adapter: 编造值置空+标红(小票号全0/团号12345/日期2023),不带绿混过审', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_junk_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      { type: 'receipt', confidence: 0.95, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'THE SHILLA', receiptNo: '0000-0000-0000-0000', groupNo: '12345',
        purchaseDate: '2023-07-01', departureDate: '2023-07-03',
      } },
    ] }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 50 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.receiptNoAuto, '', '全0小票号必须置空');
    assert.equal(a.receiptNoRawAuto, '', 'raw 留底同清');
    assert.equal(a.groupNoAuto, '', '顺子团号必须置空');
    assert.ok(a.reviewReasons.includes('qwen_junk_receipt_no'));
    assert.ok(a.reviewReasons.includes('qwen_junk_group_no'));
    assert.ok(a.reviewReasons.includes('qwen_suspect_date_year'), '2023 vs 当前年偏移>1 → 标记核对');
    assert.equal(a.purchaseDateAuto, '2023-07-01', '日期只标记不清空(可能真是旧票)');
    assert.equal(a.needsReview, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: sanitizeReceiptJunk 幂等 + 只动 receipt', () => {
  const { sanitizeReceiptJunk } = require('../lib/qwen_ocr/qwen_ocr_adapter');
  // 缓存回放路径:过滤器上线前写的垃圾 sidecar,读取时兜同一道
  const cached = {
    docTypeFinal: 'receipt', receiptNoAuto: '0000-0000-0000-0000', receiptNoRawAuto: '0000-0000-0000-0000',
    groupNoAuto: '12345', purchaseDateAuto: '2023-07-01', reviewReasons: ['field_chinese_name_invalid'], needsReview: true,
  };
  const once = sanitizeReceiptJunk(cached);
  assert.equal(once.receiptNoAuto, '');
  assert.equal(once.groupNoAuto, '');
  assert.ok(once.reviewReasons.includes('qwen_junk_receipt_no'));
  assert.ok(once.reviewReasons.includes('field_chinese_name_invalid'), '原有 reason 保留');
  const twice = sanitizeReceiptJunk(once);
  assert.deepEqual(twice.reviewReasons, once.reviewReasons, '幂等:重复跑不膨胀');
  // 护照/正常小票不受影响
  const passport = { docTypeFinal: 'passport', passportNoAuto: '00000000', reviewReasons: [] };
  assert.equal(sanitizeReceiptJunk(passport).passportNoAuto, '00000000');
  const normal = { docTypeFinal: 'receipt', receiptNoAuto: '0326438300043', groupNoAuto: '68420', purchaseDateAuto: '2026-07-01', reviewReasons: [], needsReview: false };
  const out = sanitizeReceiptJunk(normal);
  assert.equal(out.receiptNoAuto, '0326438300043');
  assert.equal(out.needsReview, false);
});

test('field_normalizer: 百货真字段清洗(金额/门店/品牌)', () => {
  const { getStoreProfile } = require('../lib/store_profiles');
  const lotte = getStoreProfile('LOTTE_DEPT');
  // 金额只留数字,去前导零
  assert.equal(normalizeDeptAmount('3,500,000원'), '3500000');
  assert.equal(normalizeDeptAmount('₩1.234.500'), '1234500');
  assert.equal(normalizeDeptAmount(''), '');
  // 门店(2026-07-12 拍板):票面4位码原样;杂串提码;纯名字透传标红人工填码
  assert.equal(normalizeDeptBranch('0394', lotte.rules.branch), '0394');
  assert.equal(normalizeDeptBranch('0001', lotte.rules.branch), '0001'); // 前导零保住
  assert.equal(normalizeDeptBranch('0394 명동점', lotte.rules.branch), '0394'); // 杂串提码
  assert.equal(normalizeDeptBranch('0394-1', lotte.rules.branch), '0394'); // 连字符后缀提码
  assert.equal(normalizeDeptBranch('明洞', lotte.rules.branch), '明洞'); // 名字不可逆定码 → 透传
  assert.equal(normalizeDeptBranch('9999', lotte.rules.branch), '9999'); // 新码宽容(校验只查4位数字)
  assert.equal(normalizeDeptBranch('123456', lotte.rules.branch), '123456'); // 更长数字串不误截
  // 品牌:韩文白名单吸附(后缀忽略);对不上透传
  assert.equal(normalizeDeptBrand('루이비통 매장', lotte.rules.brand), '루이비통');
  assert.equal(normalizeDeptBrand('반클리프 아펠', lotte.rules.brand), '반클리프 아펠');
  assert.equal(normalizeDeptBrand('구찌', lotte.rules.brand), '구찌');
  // 品牌只要韩文(2026-07-12 拍板):英文别名折到韩文;白名单外英文透传
  assert.equal(normalizeDeptBrand('LOUIS VUITTON', lotte.rules.brand), '루이비통');
  assert.equal(normalizeDeptBrand('LV', lotte.rules.brand), '루이비통');
  assert.equal(normalizeDeptBrand('VAN CLEEF & ARPELS', lotte.rules.brand), '반클리프 아펠');
  assert.equal(normalizeDeptBrand('TIFFANY & CO', lotte.rules.brand), '티파니');
  assert.equal(normalizeDeptBrand('SILVER', lotte.rules.brand), 'SILVER'); // 含LV子串不误吸附
  assert.equal(normalizeDeptBrand('GUCCI', lotte.rules.brand), 'GUCCI');
});

// ── 适配器(mock fetch,核心结构对齐) ───────────────
test('adapter: 一图两文档 → 同构 analysis + MRZ纠正 + 低置信标记 + 跨源', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_ocr_test_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);

  const num = 'EQ1035708';
  const cd = computeCheckDigit(num);
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      { type: 'passport', confidence: 0.95, bbox: [0, 0, 0.5, 1], fields: { passportNo: 'E01035708', englishName: 'ZHANG SAN', chineseName: '张三', mrz1: 'P<CHNZHANG<<SAN<<<<', mrz2: `${num}${cd}CHN9001011M3001011<<<<<<<<<<00` } },
      { type: 'receipt', confidence: 0.4, bbox: [0.5, 0, 1, 1], fields: { storeFamily: 'SHILLA', receiptNo: '0326163500159', groupNo: 'G : 71990', purchaseDate: '2026-01-16', departureDate: '2026-01-18', passportNo: 'EQ1035708' } },
    ] }) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });

  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl, confidenceThreshold: 0.6 });
  try {
    const analyses = await backend.extractAnalyses(tmp);

    assert.equal(analyses.length, 2);
    // 结构对齐:每条都带这些 PaddleX 同名键
    for (const a of analyses) {
      for (const k of ['docTypeAuto', 'docTypeFinal', 'docTypeConfidence', 'needsReview', 'reviewReasons', 'passportNoAuto', 'extractedNameAuto', 'receiptNoAuto', 'groupNoAuto', 'classificationSource']) {
        assert.ok(k in a, `analysis 缺字段 ${k}`);
      }
      assert.equal(a.classificationSource, 'qwen');
    }

    const passport = analyses.find((a) => a.docTypeFinal === 'passport');
    const receipt = analyses.find((a) => a.docTypeFinal === 'receipt');

    // MRZ 纠正:直读 E01035708 → MRZ EQ1035708
    assert.equal(normAlnum(passport.passportNoAuto), 'EQ1035708');
    assert.equal(passport.modelMeta.mrzValid, true);
    assert.equal(passport.needsReview, false); // 高置信 + MRZ验证过 + 字段合法

    // 低置信小票(0.4 < 0.6)→ 标记转人工
    assert.equal(receipt.needsReview, true);
    assert.ok(receipt.reviewReasons.includes('qwen_low_confidence'));
    assert.equal(receipt.groupNoAuto, '71990'); // 团号清洗

    // usage 计数:护照+小票同框 → 百货补救信号命中(passport_receipt_combined)追加第二段;
    // mock 第二段回的是版面 JSON(无 isDept)→ 拒采纳,一段免税店结果保留(上面断言即证)。
    assert.equal(backend.getUsage().calls, 2);
    assert.equal(receipt.modelMeta.deptRescue.accepted, false);
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ⭐乐天百货全链路:qwen 吐"乐天百货"(护照+小票同框两文档)→ 适配器归一成 LOTTE_DEPT
// → 切分服务百货短路:整图不切、护照信息并入同一 sidecar。之前这条链在 qwen 侧粗映射
// 就断了(吃成 LOTTE 免税店),切分测试注入的是已归一值,没逮到 → 这里从 mock API 起全程走真码。
test('adapter+split: 乐天百货同框图 → LOTTE_DEPT → 整图不切、护照并入 sidecar', async () => {
  const { createQwenDocumentSplitService } = require('../lib/qwen_ocr/qwen_split_service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen_dept_chain_'));
  const tmp = path.join(dir, 'lotte_dept.png');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);

  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      // 诚实闸时代(四轮金标重放):票号=4-4带杠直读、店码只认条码推导 → mock 带条码整串
      { type: 'receipt', confidence: 0.92, bbox: [0.4, 0, 1, 1], fields: { storeFamily: '乐天百货', receiptNo: '9584-0025', amount: '3,500,000', barcodeDigits: '0394202607019584002503500000', brand: '루이비통', purchaseDate: '2026-07-01' } },
      { type: 'passport', confidence: 0.9, bbox: [0, 0, 0.4, 1], fields: { passportNo: 'EQ1035708', englishName: 'ZHANG SAN' } },
    ] }) } }],
    usage: { prompt_tokens: 800, completion_tokens: 80 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  const splitService = createQwenDocumentSplitService({ qwenBackend: backend });

  try {
    const result = await splitService.splitImage({
      sourcePath: tmp, imagesDir: path.join(dir, 'images'), originalFileName: 'lotte_dept.png',
      buildFileName: (i, name, suffix) => `${i}${suffix}_${name}`,
    });
    // 百货短路:不切(哪怕 qwen 给了两个 bbox)
    assert.equal(result.splitApplied, false);
    assert.equal(result.outputs.length, 0);
    // sidecar 落在原图旁,店=LOTTE_DEPT,同框护照号/英文名并入
    const sidecar = JSON.parse(fs.readFileSync(`${tmp}.qwen.json`, 'utf8'));
    assert.equal(sidecar.receiptStoreAuto, 'LOTTE_DEPT');
    assert.equal(normAlnum(sidecar.passportNoAuto), 'EQ1035708');
    assert.equal(sidecar.extractedNameAuto, 'ZHANG SAN');
    // 百货真字段:金额=条码推导交叉一致、票号4-4去杠、店码=条码前4位推导、品牌吸附韩文白名单
    assert.equal(sidecar.receiptAmountAuto, '3500000');
    assert.equal(sidecar.receiptNoAuto, '9584-0025'); // 0727#13-4:乐天 dash:true,按票面 4-4 带杠存
    assert.equal(sidecar.branchAuto, '0394');
    assert.equal(sidecar.brandAuto, '루이비통');
    assert.ok(!sidecar.reviewReasons.includes('dept_receipt_no_cross_mismatch'), '标签与条码一致不标红');
    // 百货无团号/无出境日期:不误报免税店口径的校验
    assert.ok(!sidecar.reviewReasons.includes('field_tour_no_invalid'));
    assert.ok(!sidecar.reviewReasons.includes('field_departure_date_invalid'));
    assert.equal(sidecar.groupNoAuto, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter: 千问没给置信度 → 标 qwen_confidence_unknown 转人工', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_ocr_test_noconf_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ documents: [
      { type: 'receipt', bbox: [0, 0, 1, 1], fields: { storeFamily: 'SHILLA', receiptNo: '0326163500159', groupNo: '71990', purchaseDate: '2026-01-16' } }, // 无 confidence
    ] }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 50 },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => mockResp });
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.needsReview, true);
    assert.ok(a.reviewReasons.includes('qwen_confidence_unknown'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ── 2026-07-12 乐天百货七连报障 + 金标重放修订:prompt 契约(纯增量不升版,d76bf51 先例)──
// 锁住关键指引不被后续 prompt 改动误删:百货判定线索(品牌专柜/Global Blue/거래번호标签)、
// 거래번호 真实形态(4位-4位,禁抄 승인번호/SKU/条码/GB 长号)、门店码条码前4位、品牌一律韩文。
test('prompt 契约:百货判定线索/交易编号/门店码/韩文品牌指引在位', () => {
  const { buildLayoutPrompt } = require('../lib/qwen_ocr/qwen_client');
  const prompt = buildLayoutPrompt();
  assert.ok(prompt.includes('Global Blue'), '缺 Global Blue 百货线索');
  assert.ok(prompt.includes('LOUIS VUITTON'), '缺品牌专柜小票线索');
  assert.ok(prompt.includes('거래번호'), '缺 거래번호 标签线索(百货 POS 指纹)');
  assert.ok(prompt.includes('4位数字-4位数字'), '缺交易编号 4-4 带杠形态指引');
  assert.ok(prompt.includes('승인번호'), '缺"별抄支付授权号"陷阱防线(8位纯数字陷阱)');
  assert.ok(prompt.includes('DOC ID'), '缺"别抄 Global Blue 长号"防线');
  assert.ok(prompt.includes('原样照抄含前导零'), '缺门店码原样指引');
  assert.ok(prompt.includes('一律写韩文'), '缺品牌韩文指引');
  // 2026-07-13 登机牌病例:实体登机牌被判成小票 → "其他"示例必须点名登机牌/机票
  assert.ok(prompt.includes('登机牌'), '缺登机牌归"其他"指引');
  // ⭐示例泄漏防线(金标重放实锤:prompt 里列了 0348 例码,明洞票被吐出 0348;
  // 同 2026-07-03 团号 71990 事故):版面 prompt 里绝不允许出现具体门店码数字。
  for (const leaked of collectProfileBranchCodes()) {
    assert.ok(!prompt.includes(leaked), `版面 prompt 泄漏示例门店码 ${leaked}`);
  }
  // 版本纪律:本轮为纯增量指引,不升版(升版=全量 sidecar 缓存作废重调);
  // 若后续实质改判定语义,必须升版并接受重调成本。
  const { QWEN_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
  assert.equal(QWEN_PROMPT_VERSION, 2);
});

// ── 百货两段式补救 prompt 契约:陷阱防线与字段指引在位,版本常量独立 ──
test('prompt 契约:百货补救第二段指引在位', () => {
  const { buildDeptRescuePrompt, DEPT_RESCUE_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
  const prompt = buildDeptRescuePrompt();
  assert.ok(prompt.includes('isDept'), '缺 isDept 判定契约');
  assert.ok(prompt.includes('거래번호'), '缺 거래번호 指引');
  assert.ok(prompt.includes('승인번호'), '缺支付授权号陷阱防线');
  assert.ok(prompt.includes('Global Blue'), '缺 GB 单指引');
  assert.ok(prompt.includes('barcodeDigits'), '缺条码整串照抄契约(代码日期锚推导的输入)');
  assert.ok(prompt.includes('HYUNDAI DEPARTMENT STORE'), '缺现代免税店同名陷阱防线');
  assert.ok(prompt.includes('DUTY FREE'), '缺免税店特征否决清单');
  assert.ok(prompt.includes('放大裁片'), '缺第二张裁片指引(字段以裁片为准)');
  assert.ok(prompt.includes('KOREA TAX FREE FORM'), '缺 GB 单自带字样豁免(防 TAX FREE 反咬,pos_008 病例)');
  assert.ok(prompt.includes('绝不默认某一个'), '缺品牌反默认防线(pos_006 病例:连续两轮默认루이비통)');
  assert.ok(prompt.includes('乐天百货'), '缺百货店枚举');
  for (const leaked of collectProfileBranchCodes()) {
    assert.ok(!prompt.includes(leaked), `补救 prompt 泄漏示例门店码 ${leaked}`);
  }
  assert.equal(DEPT_RESCUE_PROMPT_VERSION, 3);
});

// ── 百货两段式补救集成(金标重放立项):一段误判 → 信号触发第二段 → 整组字段替换 ──
function makeTwoPassFetch(responses) {
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const resp = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (resp instanceof Error) throw resp;
    return { ok: true, json: async () => resp };
  };
  return { fetchImpl, bodies, calls: () => call };
}

const layoutResp = (documents) => ({
  choices: [{ message: { content: JSON.stringify({ documents }) } }],
  usage: { prompt_tokens: 500, completion_tokens: 50 },
});
const rescueResp = (obj) => ({
  choices: [{ message: { content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 400, completion_tokens: 40 },
});

test('adapter两段式: 一段GB单+误判THE SHILLA → 第二段确认乐天百货,字段整组替换+带杠票号', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl, bodies } = makeTwoPassFetch([
    layoutResp([
      { type: 'passport', confidence: 0.9, bbox: [0, 0.5, 1, 1], fields: { passportNo: 'ER9696265', englishName: 'LIU HAO', mrz1: '', mrz2: '' } },
      { type: 'receipt', confidence: 0.8, bbox: [0.2, 0, 0.6, 0.5], fields: { storeFamily: 'THE SHILLA', receiptNo: 'N260423129829' } },
      { type: 'receipt', confidence: 0.7, bbox: [0.6, 0, 1, 0.5], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]),
    rescueResp({
      isDept: true, store: '乐天百货', receiptNo: '9584-0025', amount: '2,910,000',
      purchaseDate: '2026-07-10', barcodeDigits: '0394202607109584002502910000', brand: '루이비통',
      englishName: 'LIU HAO', passportNo: 'ER9696265', confidence: 0.93,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    assert.equal(bodies.length, 2, '信号命中必须追加第二段调用');
    assert.ok(String(bodies[1].messages[0].content).includes('isDept'), '第二段用补救 prompt');
    const receipts = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(receipts.length, 1, 'GB单/误判碎片必须并成 1 个百货小票');
    const [r] = receipts;
    assert.equal(r.receiptStoreAuto, 'LOTTE_DEPT');
    assert.equal(r.receiptNoAuto, '9584-0025', '乐天档案 dash:true(0727#13-4)→ 按票面 4-4 带杠存');
    assert.equal(r.receiptAmountAuto, '2910000');
    assert.equal(r.branchAuto, '0394', '店码来自条码日期锚推导(契约里已不让模型直读)');
    assert.equal(r.brandAuto, '루이비통');
    assert.ok(!r.reviewReasons.includes('dept_receipt_no_cross_mismatch'), '标签直读与条码推导一致不标红');
    assert.equal(r.groupNoAuto, '', '百货无团号');
    assert.equal(r.modelMeta.deptRescue.accepted, true);
    assert.ok(r.modelMeta.deptRescue.signals.includes('global_blue_doc'));
    const passport = analyses.find((a) => a.docTypeFinal === 'passport');
    assert.ok(passport, '护照文档保留(身份共识链路不动)');
    assert.equal(backend.getUsage().calls, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 新世界百货 dash:true 保杠 + 一段SHINSEGAE误判被翻正', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_ss_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'passport', confidence: 0.9, bbox: [0, 0.5, 1, 1], fields: { passportNo: 'EG0435161', englishName: 'CHEN HONGYE' } },
      { type: 'receipt', confidence: 0.85, bbox: [0.3, 0, 1, 0.5], fields: { storeFamily: 'SHINSEGAE', receiptNo: '2921-7193' } },
    ]),
    rescueResp({
      isDept: true, store: '新世界百货', receiptNo: '2921-7193', amount: '3800000',
      purchaseDate: '2026-07-09', barcodeDigits: '2607092921719303800000',
      branch: '', brand: '', englishName: 'CHEN HONGYE', passportNo: 'EG0435161', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptStoreAuto, 'SHINSEGAE_DEPT');
    assert.equal(r.receiptNoAuto, '2921-7193', '新世界档案 dash:true → 保杠');
    assert.equal(r.receiptAmountAuto, '3800000');
    assert.equal(r.branchAuto, '', '新世界档案未声明 branch → 恒空');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 第二段自答"不是百货" → 一段结果原样保留(免税店同框零伤害)', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_neg_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'passport', confidence: 0.9, bbox: [0, 0.5, 1, 1], fields: { passportNo: 'EA1234567' } },
      // 票号用干净新罗形态(03前缀13位):二批锚点上线后,带疵的号会触发二遍重读,
      // 这里只测"第二段自答不是百货"的保留语义,夹具保持锚点中性
      { type: 'receipt', confidence: 0.9, bbox: [0, 0, 1, 0.5], fields: { storeFamily: 'THE SHILLA', receiptNo: '0326163500159', groupNo: '71992' } },
    ]),
    rescueResp({ isDept: false }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptStoreAuto, 'THE SHILLA', '一段免税店判定保留');
    assert.equal(r.receiptNoAuto, '0326163500159');
    assert.equal(r.modelMeta.deptRescue.accepted, false, '补救痕迹记 rejected');
    assert.equal(backend.getUsage().calls, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 第二段调用失败(400不重试) → 一段结果兜底不阻断', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_err_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'passport', confidence: 0.9, bbox: [0, 0.5, 1, 1], fields: { passportNo: 'ER9696265' } },
      { type: 'receipt', confidence: 0.8, bbox: [0, 0, 1, 0.5], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]) };
    return { ok: false, status: 400, text: async () => 'data_inspection_failed', headers: { get: () => null } };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    assert.ok(analyses.length >= 1, '一段结果保留');
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.ok(r.modelMeta.deptRescue.error, '失败痕迹落 modelMeta');
    assert.equal(backend.getUsage().errors, 1);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 标签直读与条码推导不一致 → 条码值胜出 + 交叉标红转人工', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_mm_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'receipt', confidence: 0.8, bbox: [0, 0, 1, 1], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]),
    rescueResp({
      isDept: true, store: '乐天百货', receiptNo: '9584-0026', amount: '2910000', // 标签直读末位误读
      purchaseDate: '2026-07-10', barcodeDigits: '0394202607109584002502910000', brand: '루이비통', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptNoAuto, '9584-0025', '日期锚推导值胜出(锚后字段不受锚前误读传染)');
    assert.ok(r.reviewReasons.includes('dept_receipt_no_cross_mismatch'), '两源不一致必须标红');
    assert.equal(r.needsReview, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 票号单一来源(有标签无条码) → 保值+single_source标红,绝不裸绿', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_ss1_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'receipt', confidence: 0.8, bbox: [0, 0, 1, 1], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]),
    rescueResp({
      isDept: true, store: '乐天百货', receiptNo: '9584-0025', amount: '2910000',
      purchaseDate: '2026-07-10', barcodeDigits: '', brand: '루이비통', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptNoAuto, '9584-0025', '单源仍保值(预填省敲键)');
    assert.ok(r.reviewReasons.includes('dept_receipt_no_single_source'), '未互证必须标红');
    assert.ok(r.reviewReasons.includes('dept_amount_unverified'), '金额无条码交叉也标核对');
    assert.equal(r.branchAuto, '', '无条码 → 店码空(只信条码推导)');
    assert.equal(r.needsReview, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 票号形态劫(日期/授权号/同串重复) → 清空+unverified,错绿归零', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_junk_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  for (const badNo of ['2026-07-09', '05975213', '5321-5321']) {
    const { fetchImpl } = makeTwoPassFetch([
      layoutResp([
        { type: 'receipt', confidence: 0.8, bbox: [0, 0, 1, 1], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
      ]),
      rescueResp({
        isDept: true, store: '乐天百货', receiptNo: badNo, amount: '',
        purchaseDate: '2026-07-10', barcodeDigits: '', brand: '', confidence: 0.9,
      }),
    ]);
    const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptNoAuto, '', `${badNo} 必须被诚实闸清空`);
    assert.ok(r.reviewReasons.includes('dept_receipt_no_unverified'), `${badNo} 必须标红`);
  }
  fs.unlinkSync(tmp);
});

// ── 现代百货(2026-07-12 实票纠正):交易编号=8位 4-4 带杠(原"16位2-6-3-5"是现代
//    免税店 BILL NO 误借的口径)→ 与新世界同走 transNo44 诚实闸;金额补进档案;
//    上家默认"东方"(无卡=东方是规则本体)+ dept_upstream_confirm 红标人工看贴没贴卡 ──
test('adapter两段式: 现代百货 → 8位4-4保杠+金额+上家默认东方带确认红标', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_hd_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'passport', confidence: 0.9, bbox: [0, 0.5, 1, 1], fields: { passportNo: 'EA1234567' } },
      { type: 'receipt', confidence: 0.85, bbox: [0, 0, 1, 0.5], fields: { storeFamily: 'HYUNDAI', receiptNo: '' } },
    ]),
    rescueResp({
      isDept: true, store: '现代百货', receiptNo: '1622-0011', amount: '1,020,000',
      purchaseDate: '2026-07-09', barcodeDigits: '', brand: '', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptStoreAuto, 'HYUNDAI_DEPT');
    assert.equal(r.receiptNoAuto, '1622-0011', '8位 4-4 带杠原样存(dash:true)');
    assert.ok(r.reviewReasons.includes('dept_receipt_no_single_source'), '无条码互证 → 单源标红');
    assert.equal(r.receiptAmountAuto, '1020000', '金额补进档案后正常落 Auto');
    assert.ok(r.reviewReasons.includes('dept_amount_unverified'), '金额无条码交叉 → 标核对');
    assert.equal(r.upstreamAuto, '东方', '上家默认东方(无卡=东方是规则本体)');
    assert.ok(r.reviewReasons.includes('dept_upstream_confirm'), '默认后仍红标人工看贴没贴卡');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 现代百货读到免税店BILL NO形态长号 → 诚实闸清空标红(错口径绝迹)', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_hd2_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'receipt', confidence: 0.85, bbox: [0, 0, 1, 1], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]),
    rescueResp({
      isDept: true, store: '现代百货', receiptNo: '01-260628-121-01209', amount: '',
      purchaseDate: '2026-06-28', barcodeDigits: '', brand: '', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.equal(r.receiptNoAuto, '', '16位免税店形态不是百货交易编号,清空转人工');
    assert.ok(r.reviewReasons.includes('dept_receipt_no_unverified'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter两段式: 第二段失败 → dept_rescue_failed 进 reviewReasons,sidecar 判不可复用', async () => {
  const { isSidecarReusable } = require('../lib/qwen_ocr/sidecar');
  const tmp = path.join(os.tmpdir(), `qwen_rescue_fail2_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.8, bbox: [0, 0, 1, 1], fields: { storeFamily: 'GLOBAL BLUE', receiptNo: '' } },
    ]) };
    return { ok: false, status: 400, text: async () => 'boom', headers: { get: () => null } };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.ok(r.reviewReasons.includes('dept_rescue_failed'), '失败必须进 reviewReasons(缓存判定只认这里)');
    assert.equal(r.needsReview, true);
    assert.equal(isSidecarReusable(r, QWEN_PROMPT_VERSION), false, '补救失败态不许复用,下次真调');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('sidecar: 补救版本戳过期 → 不可复用(第二段 prompt 迭代不留潜伏回放)', () => {
  const { isSidecarReusable } = require('../lib/qwen_ocr/sidecar');
  const { DEPT_RESCUE_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
  const fresh = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], modelMeta: { deptRescue: { promptVersion: DEPT_RESCUE_PROMPT_VERSION } } };
  assert.equal(isSidecarReusable(fresh, QWEN_PROMPT_VERSION), true);
  const stale = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], modelMeta: { deptRescue: { promptVersion: DEPT_RESCUE_PROMPT_VERSION - 1 } } };
  assert.equal(isSidecarReusable(stale, QWEN_PROMPT_VERSION), false, '旧补救版本必须作废重调');
  const noRescue = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [] };
  assert.equal(isSidecarReusable(noRescue, QWEN_PROMPT_VERSION), true, '没走过补救的缓存不受影响');
});

test('adapter两段式: 同框两张不同票号的百货小票被并档 → dept_multi_receipt_suspect 预警', async () => {
  const tmp = path.join(os.tmpdir(), `qwen_rescue_multi_${Date.now()}.png`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  const { fetchImpl } = makeTwoPassFetch([
    layoutResp([
      { type: 'receipt', confidence: 0.9, bbox: [0, 0, 0.5, 1], fields: { storeFamily: 'LOUIS VUITTON', receiptNo: '9584-0025' } },
      { type: 'receipt', confidence: 0.9, bbox: [0.5, 0, 1, 1], fields: { storeFamily: 'LOUIS VUITTON', receiptNo: '9584-0031' } },
    ]),
    rescueResp({
      isDept: true, store: '乐天百货', receiptNo: '9584-0025', amount: '2910000',
      purchaseDate: '2026-07-10', barcodeDigits: '0394202607109584002502910000', brand: '루이비통', confidence: 0.9,
    }),
  ]);
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const analyses = await backend.extractAnalyses(tmp);
    const [r] = analyses.filter((a) => a.docTypeFinal === 'receipt');
    assert.ok(r.reviewReasons.includes('dept_multi_receipt_suspect'), '两个不同票号并档必须预警漏收');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('sidecar: 存量百货嫌疑缓存(无补救戳)一律作废——发布前落盘的旧百货 sidecar 不许绕过两段式(体检 HIGH#1)', () => {
  const { isSidecarReusable } = require('../lib/qwen_ocr/sidecar');
  const base = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], docTypeFinal: 'receipt', modelMeta: {} };
  // 旧适配器判成百货但没走过两段式 → 作废重调(诚实闸/新规格才有机会生效)
  for (const store of ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT', '乐天百货']) {
    assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: store }, QWEN_PROMPT_VERSION), false, `${store} 无补救戳必须作废`);
  }
  // GB单/品牌被当店名、条码长串当票号——同一套信号大脑接住
  assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: 'GLOBAL BLUE' }, QWEN_PROMPT_VERSION), false);
  assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: 'LOUIS VUITTON' }, QWEN_PROMPT_VERSION), false);
  assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: 'SHINSEGAE', receiptNoRawAuto: '2921-7193' }, QWEN_PROMPT_VERSION), false, '거래번호 4-4 形态=百货嫌疑');
  // 免税店常规缓存零打扰(海量,绝不能连坐)
  assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: 'THE SHILLA', receiptNoRawAuto: '2100109466359' }, QWEN_PROMPT_VERSION), true);
  assert.equal(isSidecarReusable({ ...base, receiptStoreAuto: 'LOTTE', receiptNoRawAuto: '26051910108001' }, QWEN_PROMPT_VERSION), true);
  // 走过两段式且版本当前 → 照常复用
  const { DEPT_RESCUE_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
  assert.equal(isSidecarReusable({
    ...base, receiptStoreAuto: 'LOTTE_DEPT',
    modelMeta: { deptRescue: { promptVersion: DEPT_RESCUE_PROMPT_VERSION } },
  }, QWEN_PROMPT_VERSION), true);
  // 护照缓存不受百货嫌疑检查影响
  assert.equal(isSidecarReusable({ promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], docTypeFinal: 'passport' }, QWEN_PROMPT_VERSION), true);
});

// ── 0727反馈#9+#12:护照姓名规范(姓␣名合并)+ MRZ 定序 ─────────────────────
test('mrz: parseMrzName 姓名标准形态——姓␣名段合并,MRZ 姓<<名结构定序(顺序不可能反)', () => {
  const { parseMrzName } = require('../lib/qwen_ocr/mrz_parser');
  const r = parseMrzName('P<VNMPHAM<<THI<THUY<LINH<<<<<<<<<<<<<<<<<<<<');
  assert.equal(r.surname, 'PHAM');
  assert.equal(r.given, 'THI THUY LINH');
  assert.equal(r.standard, 'PHAM THITHUYLINH', '用户拍板的审核标准形态');
  // 单姓无名(行残缺)→ given 空,standard 只剩姓;调用方要求两段俱全才接管
  const half = parseMrzName('P<CHNLI<<');
  assert.equal(half.given, '');
  assert.equal(half.standard, 'LI');
});

test('field_normalizer: 英文名标准化——首词=姓,其余名段合并;两词以内不动;POCHN 前缀照剥', () => {
  const { normalizePassportEnglishName } = require('../lib/workbench_field_normalizer');
  assert.equal(normalizePassportEnglishName('PHAM THI THUY LINH'), 'PHAM THITHUYLINH');
  assert.equal(normalizePassportEnglishName('pham thi thuy linh'), 'PHAM THITHUYLINH', '大小写归一在前');
  assert.equal(normalizePassportEnglishName('LI MING'), 'LI MING', '两词已是标准形态');
  assert.equal(normalizePassportEnglishName('ZHANG'), 'ZHANG', '单词不动');
  assert.equal(normalizePassportEnglishName('POCHN ZHANG WEI HUA'), 'ZHANG WEIHUA', '剥前缀后再并名段');
});

test('bill_match: 姓名键去全空格——账单全分写 vs 台账合并形态,P5/P6 仍命中(0727#9 配套)', () => {
  const { createBuildIndex } = require('../services/monthly/bill_match/common');
  const daily = {
    id: 1, receiptNo: 'R9', name: 'PHAM THITHUYLINH', passportNo: '',
    purchaseDate: '2026-07-20', shop: 'LOTTE',
  };
  const buildIndex = createBuildIndex({ _listAll: () => [daily] });
  // isMatchableLedgerRow 需要 posted+matched
  daily.ledger_status = 'posted';
  daily.tour_match_status = 'matched';
  const idx = buildIndex('ws-test');
  // P5:账单侧名字全分写 → 去空格后同键命中
  const hit = idx.findDailyByNameDateShop('PHAM THI THUY LINH', '2026-07-20', 'LOTTE');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 1);
  // P6 模糊:前缀+同日+姓名信号,姓名两侧排版不同仍算共享客户信号
  const fuzzy = idx.findDailyFuzzy({ receiptNo: 'R99', purchaseDate: '2026-07-20', name: 'PHAM THI THUY LINH' });
  assert.equal(fuzzy.length, 1, '姓名排版差异不得让 P6 客户信号失联');
});

// ── 0727反馈#8:OCR 锐化环境闸(QWEN_SHARPEN=1)─────────────────────────────
test('0727#8 锐化闸:ocrSharpen 戳翻转 → sidecar 作废重识别;同态复用;旧调用方不传不受影响', () => {
  const { isSidecarReusable } = require('../lib/qwen_ocr/sidecar');
  const { QWEN_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');
  const base = { promptVersion: QWEN_PROMPT_VERSION, reviewReasons: [], docTypeFinal: 'passport', ocrModel: 'm', ocrMaxEdge: 1280 };
  // 存量缓存(无 ocrSharpen 戳=0):关闸可复用;开闸作废(预处理变了,缓存不代表当前管线)
  assert.equal(isSidecarReusable(base, QWEN_PROMPT_VERSION, { model: 'm', maxEdge: 1280, sharpen: false }), true);
  assert.equal(isSidecarReusable(base, QWEN_PROMPT_VERSION, { model: 'm', maxEdge: 1280, sharpen: true }), false);
  // 开闸产物:开闸复用;关回去作废(开关翻转双向都失效)
  const sharpened = { ...base, ocrSharpen: 1 };
  assert.equal(isSidecarReusable(sharpened, QWEN_PROMPT_VERSION, { model: 'm', maxEdge: 1280, sharpen: true }), true);
  assert.equal(isSidecarReusable(sharpened, QWEN_PROMPT_VERSION, { model: 'm', maxEdge: 1280, sharpen: false }), false);
  // 不传 sharpen 的旧调用方:保持旧行为(不因新戳误伤)
  assert.equal(isSidecarReusable(sharpened, QWEN_PROMPT_VERSION, { model: 'm', maxEdge: 1280 }), true);
  // 接线:adapter 默认关(QWEN_SHARPEN 未设不锐化),batch service 戳同步
  const fs2 = require('node:fs');
  const adapterSrc = fs2.readFileSync(require.resolve('../lib/qwen_ocr/qwen_ocr_adapter.js'), 'utf8');
  assert.match(adapterSrc, /QWEN_SHARPEN.*=== '1'/, '环境闸默认关');
  assert.match(adapterSrc, /pipe\.sharpen\(\)/);
  const bpSrc = fs2.readFileSync(require.resolve('../services/batch_processing_service.js'), 'utf8');
  assert.match(bpSrc, /sharpen: String\(process\.env\.QWEN_SHARPEN/, '缓存复用判定与闸同步');
});
