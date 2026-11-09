'use strict';

// 票号结构锚点 + 乐天二遍重读 + 日期年份互斥(2026-07-20 识别错误矩阵 P1-P3)。
// 病例值全部来自生产 auto/final 实录(tmp/errcase_mine.json),不是编的。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  ANCHOR_REASONS, checkReceiptNoAnchors, decideReceiptNoRepair, isAnchorReason,
} = require('../lib/qwen_ocr/receipt_no_anchors');
const { createQwenOcrBackend, sanitizeReceiptJunk } = require('../lib/qwen_ocr/qwen_ocr_adapter');
const { buildLayoutPrompt, buildReceiptNoRepairPrompt, RECEIPT_NO_REPAIR_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client');

// ── 锚点:新世界/现代(16 位 2-6-3-5,第 3-8 位=购买日期)──
test('anchors: 新世界/现代 16位+嵌入日期自检(生产病例实录)', () => {
  // 病例 snErr task_0059:嵌入日期年份 8↔6(280712↔260712)→ DATE 旗
  let r = checkReceiptNoAnchors({ storeFamily: 'SHINSEGAE', receiptNo: '05-280712-354-00028', purchaseDate: '2026-07-12' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.DATE]);
  // 真值同票 → 干净
  r = checkReceiptNoAnchors({ storeFamily: 'SHINSEGAE', receiptNo: '05-260712-354-00028', purchaseDate: '2026-07-12' });
  assert.deepEqual(r.reasons, []);
  // 病例 task_0009:截断只抄末段 → SHAPE
  r = checkReceiptNoAnchors({ storeFamily: 'SHINSEGAE', receiptNo: '0182', purchaseDate: '2026-07-08' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 病例 hyErr task_0288:抄了底部支付授权号(4200 开头 28 位)→ SHAPE
  r = checkReceiptNoAnchors({ storeFamily: 'HYUNDAI', receiptNo: '4200003160202607016640851985', purchaseDate: '2026-07-01' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 病例 hyErr task_0291:丢前导零(15 位)→ SHAPE
  r = checkReceiptNoAnchors({ storeFamily: 'HYUNDAI', receiptNo: '126070135600005', purchaseDate: '2026-07-01' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 现代真值(带杠形态)→ 干净
  r = checkReceiptNoAnchors({ storeFamily: 'HYUNDAI', receiptNo: '01-260710-117-00140', purchaseDate: '2026-07-10' });
  assert.deepEqual(r.reasons, []);
  // 重放病例 hyErr_014:结构/嵌入日期全对但首段 04≠01(现代恒 01)→ SHAPE
  r = checkReceiptNoAnchors({ storeFamily: 'HYUNDAI', receiptNo: '04-260604-121-00226', purchaseDate: '2026-06-04' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 新世界首段恒 05:别家前缀 → SHAPE
  r = checkReceiptNoAnchors({ storeFamily: 'SHINSEGAE', receiptNo: '01-260712-354-00028', purchaseDate: '2026-07-12' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 购买日期缺失/非 ISO → 只做长度检,不误报嵌入日期
  r = checkReceiptNoAnchors({ storeFamily: 'HYUNDAI', receiptNo: '01-260710-117-00140', purchaseDate: '' });
  assert.deepEqual(r.reasons, []);
});

// ── 锚点:乐天(14 位、9 开头、第 7-8 位=年份、济州 90G)──
test('anchors: 乐天 14位/9开头/年份段/906=G误读嫌疑(生产病例实录)', () => {
  // 病例 task_0061:首位 5↔9 → SHAPE
  let r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '50186826002938', purchaseDate: '2026-06-19' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 病例 task_0022:年份段 28↔26 → DATE
  r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '90184228011919', purchaseDate: '2026-06-19' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.DATE]);
  // 济州病例 task_0201:G→6 误读产出合法 14 位——靠 906 前缀抓(首尔真 906 仅 0.25%)
  r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '906138-26-002197', purchaseDate: '2026-07-08' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 济州真值:字母 G 占位,14 位字母数字混合 → 干净
  r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '90G138-26-002197', purchaseDate: '2026-07-08' });
  assert.deepEqual(r.reasons, []);
  // 首尔真值 → 干净
  r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '901028-26-000682', purchaseDate: '2026-07-02' });
  assert.deepEqual(r.reasons, []);
  // 13 位(掉一位)→ SHAPE;长度不对时不再叠位置检(一码引导人工足够)
  r = checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '90119-26-005862', purchaseDate: '2026-06-19' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
});

test('anchors: 新罗系 13位/01-03-21前缀/第3-4位=年份(二批,挖矿实测99%成立)', () => {
  // 新罗真值(neg_018 实票带杠形态)→ 干净
  let r = checkReceiptNoAnchors({ storeFamily: 'THE SHILLA', receiptNo: '01-263-007-0158-1', purchaseDate: '2026-06-26' });
  assert.deepEqual(r.reasons, []);
  r = checkReceiptNoAnchors({ storeFamily: 'THE SHILLA', receiptNo: '0326347101427', purchaseDate: '2026-07-01' });
  assert.deepEqual(r.reasons, []);
  // 爱宝客真值 21 前缀 → 干净
  r = checkReceiptNoAnchors({ storeFamily: 'SHILLA IPARK', receiptNo: '21-264-032-0101-5', purchaseDate: '2026-07-12' });
  assert.deepEqual(r.reasons, []);
  // 重放回归病例 ctrl_THE SHILLA_088:掉一位(13→12)→ SHAPE(以前裸绿,现在能抓)
  r = checkReceiptNoAnchors({ storeFamily: 'THE SHILLA', receiptNo: '032643670001', purchaseDate: '2026-07-05' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.SHAPE]);
  // 90 前缀混进新罗(乐天票认错店的形态)→ SHAPE+DATE 双信号(前缀错+年份段错)
  r = checkReceiptNoAnchors({ storeFamily: 'THE SHILLA', receiptNo: '9032726008389', purchaseDate: '2026-07-01' });
  assert.deepEqual([...r.reasons].sort(), [ANCHOR_REASONS.DATE, ANCHOR_REASONS.SHAPE].sort());
  // 年份段与购买年份不符 → DATE
  r = checkReceiptNoAnchors({ storeFamily: 'THE SHILLA', receiptNo: '0323347101427', purchaseDate: '2026-07-01' });
  assert.deepEqual(r.reasons, [ANCHOR_REASONS.DATE]);
});

test('anchors: 无规格店/空值/编造值不出旗(职责边界)', () => {
  assert.deepEqual(checkReceiptNoAnchors({ storeFamily: 'LOTTE_DEPT', receiptNo: '9584-0025', purchaseDate: '2026-07-01' }).reasons, []);
  assert.deepEqual(checkReceiptNoAnchors({ storeFamily: '', receiptNo: '123', purchaseDate: '' }).reasons, []);
  assert.deepEqual(checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '', purchaseDate: '2026-07-01' }).reasons, []);
  // 编造形态归 sanitizeReceiptJunk 清空+标红,锚点不重复叫
  assert.deepEqual(checkReceiptNoAnchors({ storeFamily: 'LOTTE', receiptNo: '0000-0000-0000-00', purchaseDate: '2026-07-01' }).reasons, []);
});

// ── 二遍重读采纳决策 ──
test('decideReceiptNoRepair: 二遍过锚点且不同才换值;一致/垃圾/仍不过 → 保一遍', () => {
  const ctx = { storeFamily: 'LOTTE', purchaseDate: '2026-07-08' };
  // 济州 G 修复:一遍 906(G误读),二遍 90G → 采纳
  let d = decideReceiptNoRepair({ ...ctx, firstPass: '906138-26-002197', secondPass: '90G138-26-002197' });
  assert.equal(d.adopt, true);
  assert.equal(d.value, '90G138-26-002197');
  // 两遍一致 → 不换(同错不能自证清白,锚点旗留给人工)
  d = decideReceiptNoRepair({ ...ctx, firstPass: '906138-26-002197', secondPass: '906138-26-002197' });
  assert.equal(d.adopt, false);
  assert.equal(d.agreed, true);
  // 二遍也不过锚点 → 不换
  d = decideReceiptNoRepair({ ...ctx, firstPass: '906138-26-002197', secondPass: '306138-26-002197' });
  assert.equal(d.adopt, false);
  // 二遍空/编造 → 不换
  assert.equal(decideReceiptNoRepair({ ...ctx, firstPass: '906138-26-002197', secondPass: '' }).adopt, false);
  assert.equal(decideReceiptNoRepair({ ...ctx, firstPass: '906138-26-002197', secondPass: '11111111111111' }).adopt, false);
  // 一遍漏识别(空),二遍读出合法值 → 采纳
  d = decideReceiptNoRepair({ ...ctx, firstPass: '', secondPass: '90G275-26-000842' });
  assert.equal(d.adopt, true);
});

// ── 适配器集成:锚点旗 + 乐天二遍 ──
const layoutResp = (documents) => ({
  choices: [{ message: { content: JSON.stringify({ documents }) } }],
  usage: { prompt_tokens: 500, completion_tokens: 50 },
});
const repairResp = (receiptNo) => ({
  choices: [{ message: { content: JSON.stringify({ receiptNo, confidence: 0.95 }) } }],
  usage: { prompt_tokens: 300, completion_tokens: 20 },
});

async function makeTicketPng(name) {
  const p = path.join(os.tmpdir(), `${name}_${Date.now()}.png`);
  await sharp({ create: { width: 60, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(p);
  return p;
}

test('adapter: 乐天906嫌疑 → 触发裁片二遍,采纳90G修复值+fixed旗,锚点旗撤除', async () => {
  const tmp = await makeTicketPng('qwen_repair_g6');
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'LOTTE', receiptNo: '906138-26-002197', groupNo: 'Group : 26907878',
        purchaseDate: '2026-07-08', departureDate: '2026-07-09',
      } },
    ]) };
    return { ok: true, json: async () => repairResp('90G138-26-002197') };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(bodies.length, 2, '锚点未过必须追加二遍调用');
    assert.ok(String(bodies[1].messages[0].content).includes('放大图'), '二遍用票号重读 prompt');
    assert.equal(a.receiptNoAuto, '90G138-26-002197', '采纳二遍值,字母 G/横线经中央归一保留');
    assert.equal(a.receiptNoRawAuto, '90G138-26-002197');
    assert.ok(a.reviewReasons.includes('receipt_no_second_pass_fixed'), '换值必须标 fixed 旗转人工确认');
    assert.ok(!a.reviewReasons.some(isAnchorReason), '修复后锚点旗撤除');
    assert.equal(a.needsReview, true);
    assert.equal(a.modelMeta.receiptNoRepair.adopted, true);
    assert.equal(a.modelMeta.receiptNoRepair.promptVersion, RECEIPT_NO_REPAIR_PROMPT_VERSION);
    assert.equal(backend.getUsage().calls, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: anchor 模式下乐天锚点全过 → 不花二遍调用(成本闸,env 降级档)', async () => {
  const tmp = await makeTicketPng('qwen_repair_clean');
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'LOTTE', receiptNo: '901028-26-000682', groupNo: 'Group : 26149661',
        purchaseDate: '2026-07-02', departureDate: '2026-07-04',
      } },
    ]) };
  };
  process.env.QWEN_RECEIPT_NO_REPAIR_MODE = 'anchor';
  try {
    const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 1, 'anchor 模式锚点全过绝不追加调用');
    assert.equal(a.receiptNoAuto, '901028-26-000682');
    assert.ok(!a.reviewReasons.some(isAnchorReason));
    assert.ok(!a.modelMeta.receiptNoRepair, '没走二遍不留痕');
  } finally {
    delete process.env.QWEN_RECEIPT_NO_REPAIR_MODE;
    fs.unlinkSync(tmp);
  }
});

test('adapter: 二遍与一遍一致 → 保值,锚点旗保留转人工(两遍同错不自证)', async () => {
  const tmp = await makeTicketPng('qwen_repair_agree');
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'LOTTE', receiptNo: '50186826002938', purchaseDate: '2026-06-19', departureDate: '2026-06-21', groupNo: '',
      } },
    ]) };
    return { ok: true, json: async () => repairResp('50186826002938') };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.receiptNoAuto, '50186826002938', '两遍一致保原值');
    assert.ok(a.reviewReasons.includes(ANCHOR_REASONS.SHAPE), '锚点旗保留(5开头嫌疑,人工核)');
    assert.equal(a.modelMeta.receiptNoRepair.agreed, true);
    assert.equal(a.modelMeta.receiptNoRepair.adopted, false);
    assert.equal(a.needsReview, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: 二遍调用失败 → 保一遍值+锚点旗,不阻断(保险不是闸门)', async () => {
  const tmp = await makeTicketPng('qwen_repair_fail');
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'LOTTE', receiptNo: '906138-26-002197', purchaseDate: '2026-07-08', departureDate: '2026-07-09', groupNo: '',
      } },
    ]) };
    return { ok: false, status: 400, text: async () => 'boom', headers: { get: () => null } };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.receiptNoAuto, '906138-26-002197', '失败保一遍值');
    assert.ok(a.reviewReasons.includes(ANCHOR_REASONS.SHAPE), '锚点旗在,人工兜底');
    assert.equal(backend.getUsage().errors, 1);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: 新世界锚点未过 → 触发店专属二遍(默认扩五店),修对嵌入日期', async () => {
  const tmp = await makeTicketPng('qwen_sn_repair');
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    call += 1;
    if (call === 1) return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'SHINSEGAE', receiptNo: '05-280712-354-00028', groupNo: '[GT:70299]',
        purchaseDate: '2026-07-12', departureDate: '2026-07-13',
      } },
    ]) };
    return { ok: true, json: async () => repairResp('05-260712-354-00028') };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 2, '新世界锚点未过触发二遍(二批扩店)');
    assert.ok(String(bodies[1].messages[0].content).includes('BILL NO'), '二遍用新世界专属文案');
    assert.equal(a.receiptNoAuto, '05-260712-354-00028', '二遍修对嵌入日期年份 28→26');
    assert.ok(a.reviewReasons.includes('receipt_no_second_pass_fixed'));
    assert.ok(!a.reviewReasons.some(isAnchorReason), '修复后锚点旗撤除');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: 店集合可 env 收缩 → 非启用店只标红不追加调用', async () => {
  const tmp = await makeTicketPng('qwen_sn_flagonly');
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return { ok: true, json: async () => layoutResp([
      { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
        storeFamily: 'SHINSEGAE', receiptNo: '05-280712-354-00028', groupNo: '[GT:70299]',
        purchaseDate: '2026-07-12', departureDate: '2026-07-13',
      } },
    ]) };
  };
  process.env.QWEN_RECEIPT_NO_REPAIR_STORES = 'LOTTE';
  try {
    const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 1, '店集合收缩到乐天,新世界不触发二遍');
    assert.ok(a.reviewReasons.includes(ANCHOR_REASONS.DATE), '锚点旗仍在(只标红)');
    assert.equal(a.receiptNoAuto, '05-280712-354-00028', '值不动,人工照票面改');
  } finally {
    delete process.env.QWEN_RECEIPT_NO_REPAIR_STORES;
    fs.unlinkSync(tmp);
  }
});

test('adapter: always 全量双读——一致=互证不出旗;都合法却不同=保一遍值+mismatch红标不夺权', async () => {
  const tmp = await makeTicketPng('qwen_always');
  process.env.QWEN_RECEIPT_NO_REPAIR_MODE = 'always';
  try {
    // 场景1:两遍一致 → 互证通过,零打扰
    let call = 0;
    let fetchImpl = async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => layoutResp([
        { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
          storeFamily: 'LOTTE', receiptNo: '901028-26-000682', groupNo: '', purchaseDate: '2026-07-02', departureDate: '2026-07-04',
        } },
      ]) };
      return { ok: true, json: async () => repairResp('901028-26-000682') };
    };
    let backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
    let [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 2, 'always 模式强值也双读');
    assert.equal(a.modelMeta.receiptNoRepair.agreed, true);
    assert.ok(!a.reviewReasons.includes('receipt_no_second_pass_mismatch'), '一致不打扰');
    assert.equal(a.receiptNoAuto, '901028-26-000682');

    // 场景2:两遍都过锚点但串尾不同(个位混淆形态)→ 保一遍值 + mismatch 红标,绝不静默换值
    call = 0;
    fetchImpl = async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => layoutResp([
        { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
          storeFamily: 'LOTTE', receiptNo: '901368-26-030407', groupNo: '', purchaseDate: '2026-07-02', departureDate: '2026-07-04',
        } },
      ]) };
      return { ok: true, json: async () => repairResp('901368-26-030497') };
    };
    backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
    [a] = await backend.extractAnalyses(tmp);
    assert.equal(a.receiptNoAuto, '901368-26-030407', '强值不被二遍翻案');
    assert.ok(a.reviewReasons.includes('receipt_no_second_pass_mismatch'), '互证失败必须红标');
    assert.equal(a.modelMeta.receiptNoRepair.adopted, false);
    assert.equal(a.needsReview, true);
  } finally {
    delete process.env.QWEN_RECEIPT_NO_REPAIR_MODE;
    fs.unlinkSync(tmp);
  }
});

// ── P3:购买/出境年份互斥 ──
test('sanitizeReceiptJunk: 购买/出境年份冲突标旗;跨年元旦豁免;幂等', () => {
  // 单侧年份漂移(病例 yearErr task_0011:dd 2025 vs pd 2026,±1 宽容带里旧逻辑抓不住)
  const drift = sanitizeReceiptJunk({
    docTypeFinal: 'receipt', receiptNoAuto: '901028-26-000682',
    purchaseDateAuto: '2026-06-10', departureDateAuto: '2025-06-12', reviewReasons: [], needsReview: false,
  });
  assert.ok(drift.reviewReasons.includes('qwen_date_year_conflict'));
  assert.equal(drift.needsReview, true);
  assert.equal(drift.purchaseDateAuto, '2026-06-10', '只标旗不改值');
  // 跨年元旦(购买 12 月→出境次年 1 月)是合法组合
  const newyear = sanitizeReceiptJunk({
    docTypeFinal: 'receipt', receiptNoAuto: '901028-26-000682',
    purchaseDateAuto: '2026-12-30', departureDateAuto: '2027-01-02', reviewReasons: [], needsReview: false,
  });
  assert.ok(!newyear.reviewReasons.includes('qwen_date_year_conflict'));
  // 同年正常 → 不出旗
  const same = sanitizeReceiptJunk({
    docTypeFinal: 'receipt', receiptNoAuto: '901028-26-000682',
    purchaseDateAuto: '2026-07-02', departureDateAuto: '2026-07-04', reviewReasons: [], needsReview: false,
  });
  assert.ok(!same.reviewReasons.includes('qwen_date_year_conflict'));
  // 幂等
  const twice = sanitizeReceiptJunk(drift);
  assert.deepEqual(twice.reviewReasons, drift.reviewReasons);
});

// ── prompt 契约:P1-P3 新增指引在位(纯增量,不升版在既有测试锁)──
test('prompt 契约: 票号定长/位置/陷阱/济州90G/日期标签行/年份锚指引在位', () => {
  const p = buildLayoutPrompt(new Date('2026-07-20T00:00:00Z'));
  assert.ok(p.includes('票号定长自检'), '缺定长自检指引');
  assert.ok(p.includes('票号位置'), '缺票号位置指引');
  assert.ok(p.includes('90G') === false || p.includes('字母 G'), '济州 90G 指引措辞');
  assert.ok(p.includes('济州乐天'), '缺济州乐天专项指引');
  assert.ok(p.includes('APROVAL'), '缺乐天票 APROVAL 拼写陷阱(票面就这么印的)');
  assert.ok(p.includes('4200 开头'), '缺支付授权号 4200 特征');
  assert.ok(p.includes('前导 0'), '缺前导零指引');
  assert.ok(p.includes('当前年份 2026'), '年份锚必须注入当前年份');
  assert.ok(p.includes('SaleDT'), '缺乐天购买日期标签行');
  assert.ok(p.includes('DAY/TIME'), '缺新世界购买日期标签行');
  // 年份锚跟系统时钟走(2027 年自动翻),不升版不换缓存
  const p27 = buildLayoutPrompt(new Date('2027-01-05T00:00:00Z'));
  assert.ok(p27.includes('当前年份 2027'));
});

test('prompt 契约: 票号二遍重读 prompt 按店分文案,版本常量独立', () => {
  const lotte = buildReceiptNoRepairPrompt('LOTTE');
  assert.ok(lotte.includes('LOTTE DUTY FREE'));
  assert.ok(lotte.includes('14 位'));
  assert.ok(lotte.includes('字母 G'));
  assert.ok(lotte.includes('receiptNo'));
  assert.ok(lotte.includes('绝不编造'));
  const sn = buildReceiptNoRepairPrompt('SHINSEGAE');
  assert.ok(sn.includes('BILL NO'));
  assert.ok(sn.includes('16 位'));
  assert.ok(sn.includes('GT'), '新世界同行 [GT:] 团号防混指引');
  const hy = buildReceiptNoRepairPrompt('HYUNDAI');
  assert.ok(hy.includes('Bill No'));
  assert.ok(hy.includes('16 位'));
  const sh = buildReceiptNoRepairPrompt('THE SHILLA');
  assert.ok(sh.includes('NO.'));
  assert.ok(sh.includes('13 位'));
  const ip = buildReceiptNoRepairPrompt('SHILLA IPARK');
  assert.ok(ip.includes('13 位'));
  // 未知店回退乐天文案(店集合本就限制启用店,回退只是兜底)
  assert.ok(buildReceiptNoRepairPrompt('').includes('LOTTE DUTY FREE'));
  assert.equal(RECEIPT_NO_REPAIR_PROMPT_VERSION, 2);
});
