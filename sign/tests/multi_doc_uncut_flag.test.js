'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { markMultiDocUncut } = require('../services/batch_processing_service');

// 审计L142:「追加图片」路径完全绕过切图预处理(splitImage)——一张护照+小票同框/两票并排的
// 未切原图进 ensureQwenSidecar,extractAnalyses 即使返回 ≥2 张护照/小票,也只留 1 张写 sidecar、
// 其余静默丢,且第 2 张既不产任务也无任何红标(审核台误以为客户只交了这一张)。
// 修:markMultiDocUncut——同图 ≥2 张护照/小票时把选中张标 needsReview + multi_doc_uncut 转人工,
// 操作员据此走「同图补小票/按此店重切」补齐。此处锁:①纯函数行为 ②ensureQwenSidecar 调用点契约。

test('markMultiDocUncut:同图 2 张小票 → 选中张标 needsReview + multi_doc_uncut', () => {
  const analysis = { docTypeFinal: 'receipt', receiptNoAuto: 'A', reviewReasons: [] };
  const list = [
    { docTypeFinal: 'receipt', receiptNoAuto: 'A' },
    { docTypeFinal: 'receipt', receiptNoAuto: 'B' },
  ];
  const out = markMultiDocUncut(analysis, list);
  assert.equal(out.needsReview, true, '多单据必须转人工,不得静默丢第二张');
  assert.ok(out.reviewReasons.includes('multi_doc_uncut'), '标 multi_doc_uncut 供审核台红条提示');
});

test('markMultiDocUncut:护照+小票同框(各 1)也算 ≥2 → 转人工', () => {
  const analysis = { docTypeFinal: 'passport', passportNoAuto: 'E1', reviewReasons: [] };
  const list = [
    { docTypeFinal: 'passport', passportNoAuto: 'E1' },
    { docTypeFinal: 'receipt', receiptNoAuto: 'A' },
  ];
  const out = markMultiDocUncut(analysis, list);
  assert.equal(out.needsReview, true);
  assert.ok(out.reviewReasons.includes('multi_doc_uncut'));
});

test('markMultiDocUncut:单张小票 → 不误报(needsReview 不被置真)', () => {
  const analysis = { docTypeFinal: 'receipt', receiptNoAuto: 'A', reviewReasons: [] };
  const out = markMultiDocUncut(analysis, [{ docTypeFinal: 'receipt', receiptNoAuto: 'A' }]);
  assert.ok(!out.needsReview, '正常单单据不得被误标转人工');
  assert.ok(!out.reviewReasons.includes('multi_doc_uncut'));
});

test('markMultiDocUncut:1 张小票 + N 个 other 区(包装/航班截图) → 不算多单据', () => {
  const analysis = { docTypeFinal: 'receipt', receiptNoAuto: 'A', reviewReasons: [] };
  const list = [
    { docTypeFinal: 'receipt', receiptNoAuto: 'A' },
    { docTypeFinal: 'other' },
    { docTypeFinal: 'other' },
  ];
  const out = markMultiDocUncut(analysis, list);
  assert.ok(!out.needsReview, 'other 区不算护照/小票,单张真单据不误报');
});

test('markMultiDocUncut:保留既有 reviewReasons(去重叠加,不覆盖)', () => {
  const analysis = { docTypeFinal: 'receipt', reviewReasons: ['qwen_low_confidence'] };
  const list = [{ docTypeFinal: 'receipt' }, { docTypeFinal: 'receipt' }];
  const out = markMultiDocUncut(analysis, list);
  assert.ok(out.reviewReasons.includes('qwen_low_confidence'), '既有红标不得被抹');
  assert.ok(out.reviewReasons.includes('multi_doc_uncut'));
  // 幂等:重复调用不产生重复项
  const again = markMultiDocUncut(out, list);
  assert.equal(again.reviewReasons.filter((r) => r === 'multi_doc_uncut').length, 1, 'reviewReasons 去重');
});

test('markMultiDocUncut:入参健壮(analysis 空 / analyses 非数组 → 不炸)', () => {
  assert.equal(markMultiDocUncut(null, [{ docTypeFinal: 'receipt' }, { docTypeFinal: 'receipt' }]), null);
  const analysis = { docTypeFinal: 'receipt', reviewReasons: [] };
  const out = markMultiDocUncut(analysis, undefined);
  assert.ok(!out.needsReview, 'analyses 非数组按 0 计,不误报');
});

// 契约:ensureQwenSidecar(append 路径的 sidecar 兜底生成)必须调用 markMultiDocUncut,
// 防日后有人把这层去掉重新打开「同框第二张静默丢」的窗口。
test('契约:ensureQwenSidecar 调用 markMultiDocUncut', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/batch_processing_service.js'), 'utf8');
  const fnStart = src.indexOf('async function ensureQwenSidecar');
  assert.ok(fnStart > 0, '应存在 ensureQwenSidecar');
  const fnBody = src.slice(fnStart, fnStart + 2400);
  assert.ok(/markMultiDocUncut\s*\(/.test(fnBody), 'ensureQwenSidecar 必须调 markMultiDocUncut(L142)');
  assert.ok(/extractAnalyses/.test(fnBody), 'append 路径靠 extractAnalyses 全量列表判多单据');
  // L482:ensureQwenSidecar 调 extractAnalyses 必须 useCache:false——已先读 sidecar,到这里就是要真调
  // qwen(重识别/换模型/append),绝不能命中进程内 Map 回放旧 OCR。
  assert.ok(/extractAnalyses\([^)]*useCache:\s*false/.test(fnBody), 'L482:ensureQwenSidecar 必须传 useCache:false 绕过进程内缓存');
});
