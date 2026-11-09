'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 0729 结算链静默排查:三处"算出来了但没人看得见"。
// 判据沿用导出链那轮:logger.warn/console.warn 不算告知;返回值没人接等于没算。

test('resolveAgent 失败不得再空 catch —— 台账行会没有代理归属', () => {
  const src = read('services/workbench_ledger_bridge_service.js');
  // 空 catch 把「查不到这个人」(合法态)和「用户服务挂了」(故障)压成同一个返回值。
  // 后者下游只体现为收票汇总里「未分配行数」变多,没人知道那是一次服务故障。
  assert.doesNotMatch(src, /catch \(_e\) \{\s*\r?\n\s*return \{ agentId: null, agentCode: null \};/,
    '空 catch 已下线');
  assert.match(src, /resolveAgent\(\$\{operator\}\) failed/, '要留下可追的痕迹');
  assert.match(src, /台账行将没有代理归属/, '说清后果,不只是报个错');
});

test('团号匹配取不到整行:要计数 + 留痕,不能纯 continue', () => {
  const src = read('services/monthly/tour_match_service.js');
  assert.match(src, /fetchFailed: 0,/, 'stats 要有这个桶');
  assert.match(src, /stats\.fetchFailed \+= 1;/);
  assert.match(src, /tour_match_fetch_full_failed/, '结构化日志带 workspaceKey + id');
  // 纯 continue 的旧写法必须消失:那条行会永远停在 pending,且不在任何异常态里,
  // 人工补救界面也捞不出来 —— 彻底消失。
  assert.doesNotMatch(src, /if \(!fullRow\) continue;/);
});

test('合并阶段的丢弃计数:服务返回值要有人接,并一路到界面', () => {
  // ① ensureFresh 必须接住 mergeService.run() 的返回值(原来 await 完就扔)
  const rec = read('services/monthly/derivation_recompute_service.js');
  assert.match(rec, /mergeStats = await mergeService\.run\(\{ workspaceKey \}\)/);
  assert.match(rec, /return \{ ran, dirtyFrom, mergeStats \}/);
  assert.doesNotMatch(rec, /^\s*await mergeService\.run\(\{ workspaceKey \}\);\s*$/m,
    '旧的"调完就扔"写法已下线');

  // ② 最终核对页要显示(那是发现"数据少了"的最后一道关口)
  const view = read('frontend/src/views/v2/DeliveryCheckView.vue');
  assert.match(view, /const mergeDroppedNotice = ref\(0\)/);
  assert.match(view, /skippedNoFolder[\s\S]{0,200}skippedBillNoFolder[\s\S]{0,200}skippedBrandNoFolder/,
    '三个计数都要算进去,别只接一个');
  assert.match(view, /归不到交付桶/, '横幅文案');
  assert.match(view, /v-if="mergeDroppedNotice > 0"/, '0 时不显示,不制造噪音');
  // 用「提示」不用「阻断」:多数情况这些渠道本就不走四桶交付
  assert.match(view, /status-warn/);
  assert.doesNotMatch(view, /mergeDroppedNotice[^\n]*status-error/);

  // ③ 操作日志摘要也带上(字段早就在注释里躺着,却没人渲染)
  const logs = read('frontend/src/views/v2/LogsView.vue');
  assert.match(logs, /未归桶丢弃/);
  assert.match(logs, /取行失败/);
});

// ── 0729 生产量化后的修正:提醒必须只报"真需要人管的",否则就是噪音 ──────────
// 实测 2026-08:账单侧归不了类的 2883 行里 **2823 行是百货**(新世界明洞 2466、
// 现代江南 327…)。而四个交付桶(乐天首尔/乐天釜山/爱宝客/济州新罗V团)全是**免税店**桶,
// 百货走自己的上家专链与乐天百货独立包 —— 本来就不该进四桶合并。
// 若把这 98% 的正常越界也算进提醒,横幅会天天显示"2823 行被丢弃",
// 操作员三天就学会无视它 —— 提醒等于没做,而且真出问题时被淹掉。
test('合并丢弃分两类:百货等越界不报警,只有真归不出来的才提醒', () => {
  const src = read('services/monthly/merge_streaming_service.js');
  assert.match(src, /function isOutOfFourFolderScope\(bill\)/);
  assert.match(src, /function bumpNoFolder\(stats, kind, bill\)/);
  assert.match(src, /skipped\$\{kind\}OutOfScope/, '越界走独立计数');
  assert.match(src, /skippedBillOutOfScope: 0,/);
  assert.match(src, /skippedBrandOutOfScope: 0,/);
  // 三处丢弃点都要走分流,不能再直接 += 到 NoFolder
  assert.doesNotMatch(src, /if \(!folder\) \{ stats\.skippedBillNoFolder \+= 1; continue; \}/);
  assert.doesNotMatch(src, /stats\.skippedBrandNoFolder = \(stats\.skippedBrandNoFolder \|\| 0\) \+ 1;/);

  // 最终核对页的横幅**不得**把越界数算进去(否则每次都亮,等于没有)
  const view = read('frontend/src/views/v2/DeliveryCheckView.vue');
  assert.doesNotMatch(view, /mergeDroppedNotice[\s\S]{0,300}OutOfScope/,
    '横幅只报真归不出来的那部分');
  assert.match(view, /skippedNoFolder[\s\S]{0,160}skippedBillNoFolder[\s\S]{0,160}skippedBrandNoFolder/);

  // 日志备查里两类都要有,且标明越界是正常的
  const logs = read('frontend/src/views/v2/LogsView.vue');
  // 别在断言里写半角括号:它是正则分组符,会静默失配(今天第三次撞这个坑,
  // 前两次是「客户账单缺失(用了空壳表)」和 CRLF 行尾)。用 includes 或转义。
  assert.ok(logs.includes('越界跳过 ${outOfScope}'), '日志摘要要显示越界数');
  assert.ok(logs.includes('百货等,正常'), '并标明它是正常的,别让人以为出了问题');
});

// ── 行为测试(不是源码断言)──────────────────────────────────────────────
// 教训:上一版把常量 DEPT_HINT 改名成 OUT_OF_SCOPE_HINT 时漏了使用点,
// 而当时的测试**全是源码字符串断言、从没真正调用过函数** —— ReferenceError 会一路
// 带到生产,把整个合并阶段打崩。规则类逻辑必须有一条真的执行它的测试。
test('越界判定:现代/新世界/百货都算越界;乐天/爱宝客/新罗不算', () => {
  const { isOutOfFourFolderScope } = require('../services/monthly/merge_streaming_service');

  // 四桶 = 乐天首尔/乐天釜山/爱宝客/济州新罗V团,全是免税店桶。
  // 现代无论免税还是百货都不在其中:免税走三池交付,百货走上家专链。
  // 生产实测:第一版漏了**中文**「现代」(只写了韩文 현대 与 HYUNDAI),
  // 导致 331 行(现代江南 330 + 现代仁川机场 1)被误判成"真归不出来"而误报警。
  const outOfScope = [
    { mode: 'SG', storeFamily: '现代', storeBranch: '现代江南' },
    { mode: 'SG', storeFamily: '现代', storeBranch: '现代仁川机场' },
    { mode: '百货', storeFamily: '新世界', storeBranch: '新世界明洞店' },
    { mode: 'SG', storeFamily: '新世界', storeBranch: '新世界明洞' },
    { mode: '百货', storeFamily: '现代', storeBranch: '金浦奥莱' },
    { storeFamily: 'HYUNDAI_DEPT' },
    { storeFamily: 'SHINSEGAE_DEPT' },
  ];
  for (const b of outOfScope) {
    assert.equal(isOutOfFourFolderScope(b), true, `应判为越界: ${JSON.stringify(b)}`);
  }

  const inScope = [
    { mode: '乐天SG-本司', storeFamily: 'LOTTE', storeBranch: '明洞' },
    { mode: '爱宝客SG-本司', storeFamily: 'HDC', storeBranch: '龙山' },
    { mode: '济州新罗SG-道辉', storeFamily: 'THE SHILLA', storeBranch: '济州' },
    { mode: '', storeFamily: '', storeBranch: '' },
  ];
  for (const b of inScope) {
    assert.equal(isOutOfFourFolderScope(b), false, `不该判为越界: ${JSON.stringify(b)}`);
  }

  assert.equal(isOutOfFourFolderScope(null), false, '空值不该崩,也不该算越界');
});

test('bumpNoFolder 分流:越界与真归不出来记到不同的桶', () => {
  const { bumpNoFolder } = require('../services/monthly/merge_streaming_service');
  const stats = {};
  bumpNoFolder(stats, 'Bill', { storeFamily: '现代', storeBranch: '现代江南' });
  bumpNoFolder(stats, 'Bill', { storeFamily: '某个没见过的渠道', storeBranch: '' });
  bumpNoFolder(stats, 'Brand', { storeFamily: '新世界' });
  assert.equal(stats.skippedBillOutOfScope, 1);
  assert.equal(stats.skippedBillNoFolder, 1, '真归不出来的才该进告警桶');
  assert.equal(stats.skippedBrandOutOfScope, 1);
  assert.equal(stats.skippedBrandNoFolder, undefined, '没有就不该凭空造 0 以外的值');
});
