'use strict';

/**
 * 点4 · relax 与百货互斥边界锁定(2026-07-21 配置台↔审核↔导出链路排查)。
 *
 * 源码事实(本测试逐条锁死):
 *   - API POST /api/admin/config/modes/:name(routes/config_console_routes.js:193-223)
 *     **没有**百货模式拦截:validateModeConfig(services/mode_config_resolver.js:24)→
 *     validateModeReviewOverlay(services/review_config_resolver.js:90)只查 OVERLAY_VOCAB
 *     (=免税店小票基线 finalKey ∖ receiptStoreFinal,:37-39)——给「乐天百货」配 review.relax
 *     照收不误,且软警告(buildModeConfigWarnings :67)对 review 段零提示 → 静默收下的半截配置。
 *   - 消费侧天然免疫**靠分支顺序**:lib/workbench_task_flow.js getRequiredFieldRules(:328)
 *     百货分支(:335-349,按 receiptStoreFinal 查档案 family=DEPT)**提前返回**店档案必填集,
 *     SLIM 车道(:351)与模式微调 overlay(:356,仅 groupNoMatchStatus='matched' 叠加)对百货
 *     任务不可达——即便伪造 matched/modeRawPre 也不生效(双保险:百货免团号恒无 matched)。
 *   - 半生效路径(泄漏面):relax 配置存在「乐天百货」名下后,任何**非百货店**任务只要
 *     modeRawPre 归一后=「乐天百货」且 matched,overlay 照样叠加(getModeReviewOverlay 只看
 *     模式串,不看店家)——配置名下的 relax 不是死配置,是"对百货票无效、对携带同名模式串的
 *     免税店票有效"的错位配置 → [非对称留档]。
 *
 * 只锁现行为,不改源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createReviewConfigResolver } = require('../services/review_config_resolver');
const { createConfigConsoleRoutes } = require('../routes/config_console_routes');
const {
  getTaskRequiredFieldChecks,
  isSlimLaneTask,
  setReviewConfigResolver,
} = require('../lib/workbench_task_flow');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

// 三家百货任务(店家=档案 canonical 键;字段值不影响必填集判定,只为形状真实)
const DEPT_TASKS = Object.freeze({
  乐天百货: Object.freeze({
    docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678',
    extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EA1234567',
    receiptAmountFinal: '100', branchFinal: '0394', brandFinal: 'CHANEL', purchaseDateFinal: '2026-07-01',
  }),
  新世界百货: Object.freeze({
    docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'SHINSEGAE_DEPT', receiptNoFinal: '2921-7193',
    receiptAmountFinal: '100', upstreamFinal: '梁总', purchaseDateFinal: '2026-07-01',
  }),
  现代百货: Object.freeze({
    docTypeFinal: 'receipt', classificationConfirmed: true,
    receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1622-0011',
    receiptAmountFinal: '100', upstreamFinal: '东方', purchaseDateFinal: '2026-07-01',
  }),
});

// 免税店小票任务(泄漏路径用)
const DUTY_FREE_TASK = Object.freeze({
  docTypeFinal: 'receipt', classificationConfirmed: true,
  receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '0325652400439',
  groupNoFinal: '71992', purchaseDateFinal: '2026-07-01', departureDateFinal: '2026-07-05',
});

function fieldKeys(task) {
  return getTaskRequiredFieldChecks(task).checks.map((c) => c.finalKey);
}

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-relax-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const resolver = createReviewConfigResolver({
    modeConfigRepository: repository,
    logger: { warn: () => {}, info: () => {} },
  });
  t.after(() => {
    setReviewConfigResolver(null); // 全局钩子必复位
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository, resolver };
}

// ── T1 · API 面:百货模式名下的 review.relax 照收(无百货拦截,软警告零提示)──────────

test('T1 [非对称留档] POST /api/admin/config/modes/乐天百货 配 review.relax → 200 静默收下;百货字段 relax 400(词汇闸)', async (t) => {
  const { repository } = makeHarness(t);
  const app = express();
  app.use(express.json());
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
  }).register(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  // ①relax 免税店基线字段:API 收下(200)——UI 只给百货卡跳店档案,API 却没有对应拦截
  const saved = await post('/api/admin/config/modes/乐天百货', {
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['purchaseDateFinal'] } },
  });
  assert.equal(saved.status, 200, '现行为:百货模式配 relax 不拦(无百货互斥闸)');
  assert.equal(saved.body.version, 1);
  // 软警告知道这是百货(列语义),对 review.relax 却零提示 → 静默半截配置
  assert.ok(saved.body.warnings.some((w) => w.includes('百货模式无团号')), '路由认得它是百货(列警告在)');
  assert.ok(saved.body.warnings.every((w) => !/relax|微调|review/i.test(w)), '[非对称留档] review 段无任何警告');
  assert.deepEqual(repository.getActive('mode', '乐天百货').payload.review.relax, ['purchaseDateFinal']);

  // ②想 relax 百货自己的字段(receiptAmountFinal)反而 400:OVERLAY_VOCAB 只有免税店小票基线词汇
  // ——"放宽百货必填"在模式微调通道根本无法表达,唯一入口是店档案 fields(设计如此,这里锁死)
  const deptField = await post('/api/admin/config/modes/乐天百货', {
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['receiptAmountFinal'] } },
  });
  assert.equal(deptField.status, 400, '百货字段不在微调词汇 → 400(validateModeReviewOverlay :98)');
});

// ── T2 · 消费面:relax 对百货任务必填集零影响(三家全锁)──────────────────────────

test('T2 百货模式配 relax:三家百货任务必填集零影响(伪造 matched/modeRawPre 也不生效)', (t) => {
  // 先取出厂快照(未挂钩=出厂),relax 目标字段必须真在集合里,否则"零影响"是空话
  const factory = {};
  for (const [modeName, deptTask] of Object.entries(DEPT_TASKS)) {
    factory[modeName] = fieldKeys(deptTask);
    assert.ok(factory[modeName].includes('purchaseDateFinal'),
      `${modeName} 出厂必填集须含 purchaseDateFinal(relax 若生效必有可见差异)`);
  }

  const { repository, resolver } = makeHarness(t);
  for (const modeName of Object.keys(DEPT_TASKS)) {
    repository.saveNewVersion({
      kind: 'mode', name: modeName,
      payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['purchaseDateFinal'] } },
    });
  }
  setReviewConfigResolver(resolver);

  for (const [modeName, deptTask] of Object.entries(DEPT_TASKS)) {
    // 配置确实可解析(防"配置根本没被读到"的假绿)
    const overlay = resolver.getModeReviewOverlay(modeName);
    assert.deepEqual(overlay.relax, ['purchaseDateFinal'], `${modeName} 的 relax 配置在 DB 里活着`);

    // ①素百货任务(现实态:免团号,groupNoMatchStatus 恒空)→ 零影响
    assert.deepEqual(fieldKeys(deptTask), factory[modeName],
      `${modeName}:relax 对百货任务必填集零影响(百货分支 :335 提前返回)`);

    // ②伪造 matched + modeRawPre=百货模式名(overlay 的两个入场条件全给足)→ 仍零影响
    const forged = { ...deptTask, modeRawPre: modeName, groupNoMatchStatus: 'matched' };
    assert.deepEqual(fieldKeys(forged), factory[modeName],
      `${modeName}:即便伪造 matched,店家分支优先级仍挡住 overlay(:356 不可达)`);
  }
});

// ── T3 · slim=true 同理:资格谓词会点头,消费方靠分支顺序免疫 ────────────────────

test('T3 [非对称留档] 百货模式配 slim=true:isSlimLaneTask 谓词返回 true,必填集却不受影响(免疫靠 :335 分支顺序,不靠资格谓词)', (t) => {
  const { repository, resolver } = makeHarness(t);
  repository.saveNewVersion({
    kind: 'mode', name: '乐天百货',
    payload: { columns: { ...ALL_COLUMNS }, review: { slim: true } },
  });
  const factoryKeys = fieldKeys(DEPT_TASKS['乐天百货']);
  setReviewConfigResolver(resolver);

  // SLIM 三条件齐活的百货任务:小票✓ 表态 matched✓ groupNoMatchStatus matched✓ + 配置 slim=true
  const slimForged = {
    ...DEPT_TASKS['乐天百货'],
    modeRawPre: '乐天百货',
    tourStance: 'matched',
    groupNoMatchStatus: 'matched',
  };
  // 谓词层:isSlimLaneTask 不查店家 → 对伪造百货任务返回 true(:311-326 无 DEPT 检查)
  assert.equal(isSlimLaneTask(slimForged), true,
    '[非对称留档] 资格谓词本身会放行百货任务(它不看店家)');
  // 消费层:getRequiredFieldRules 百货分支先行,SLIM 空集永远轮不到 → 必填集仍是店档案全集
  const keys = fieldKeys(slimForged);
  assert.ok(keys.length > 0, '百货任务不得被 SLIM 清空必填集');
  assert.deepEqual(keys, factoryKeys, '免疫仅由 :335→:351 的分支顺序保证(重排分支即破防,此测试是哨兵)');
});

// ── T4 · 泄漏面:百货模式名下的 relax 会作用于携带同名模式串的免税店票 ─────────────

test('T4 [非对称留档] 半生效路径:免税店任务 modeRawPre=「乐天百货」+matched → relax 照样叠加(overlay 只看模式串不看店)', (t) => {
  const { repository, resolver } = makeHarness(t);
  repository.saveNewVersion({
    kind: 'mode', name: '乐天百货',
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['purchaseDateFinal'] } },
  });
  const factoryKeys = fieldKeys(DUTY_FREE_TASK);
  assert.ok(factoryKeys.includes('purchaseDateFinal'), '免税店基线含购买日期(前提)');
  setReviewConfigResolver(resolver);

  // 团号表若真出现 mode=「乐天百货」的行,免税店票命中它即成立:modeRawPre 原串+matched
  const leaked = { ...DUTY_FREE_TASK, modeRawPre: '乐天百货', groupNoMatchStatus: 'matched' };
  const leakedKeys = fieldKeys(leaked);
  assert.ok(!leakedKeys.includes('purchaseDateFinal'),
    '[非对称留档] 百货模式名下的 relax 对携带该模式串的免税店票**生效**——不是死配置,是错位配置');

  // 时序墙仍在:未 matched 不叠加
  const notMatched = { ...DUTY_FREE_TASK, modeRawPre: '乐天百货', groupNoMatchStatus: 'not_found' };
  assert.deepEqual(fieldKeys(notMatched), factoryKeys, '未命中团号表=纯基线全查(:356 时序墙)');
});
