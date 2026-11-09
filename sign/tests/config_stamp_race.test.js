'use strict';

/**
 * 点5:多人同时改配置的 stamp 竞态(配置台并发边界,docs/边界测试设计.md 支撑域)。
 *
 * 机制(repositories/mode_config_repository.js):
 *   - stamp=config_meta 显式计数器,每个写事务(saveNewVersion/activateVersion/deactivate)
 *     内 +1(:154/:176/:191)——不能用 MAX(id):activate 只翻位不产新行(:36 注释)。
 *   - 乐观锁 per (kind,name):expectBaseVersion ≠ 当前 max version → CONFIG_STALE(:140,路由层映射 409)。
 *   - resolver 缓存失效(services/review_config_resolver.js:116 ensureFresh):先读 maxStamp,
 *     变了整表清缓存再按需重读——stamp 读在行读**之前**,读窗口内落库的写只会让
 *     cachedStamp 偏旧(下次必失效重读),永远不会把旧行钉在新水位下(不可能错过中间版本)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createReviewConfigResolver } = require('../services/review_config_resolver');
const { createModeConfigResolver } = require('../services/mode_config_resolver');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});
const SILENT = { warn: () => {}, info: () => {} };
const MODE = '乐天SG-本司';
const STORE = 'HYUNDAI_DEPT';

function makeHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-stamp-race-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository };
}

function modePayload(relaxKey) {
  return { columns: { ...ALL_COLUMNS }, review: { relax: [relaxKey] } };
}

// ── 跨实体交错写:stamp 单调 + resolver 逐次拿最新 ─────────────────────────────

test('跨实体(A改模式/B改店档案)交错 saveNewVersion:互不 409;stamp 每写+1;resolver 逐次解析均最新', (t) => {
  const { repository } = makeHarness(t);
  const resolver = createReviewConfigResolver({ modeConfigRepository: repository, logger: SILENT });
  const stamp0 = repository.maxStamp();

  // A 存模式 v1(基于空链 expectBaseVersion=0)——B 的店档案链完全不受影响
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('departureDateFinal'), expectBaseVersion: 0 });
  assert.equal(repository.maxStamp(), stamp0 + 1, 'stamp 单调:第1写+1');
  assert.deepEqual([...resolver.getModeReviewOverlay(MODE).relax], ['departureDateFinal']);

  // B 存店档案 v1(同样 expectBaseVersion=0:各 (kind,name) 链独立,跨实体无假冲突)
  repository.saveNewVersion({ kind: 'store', name: STORE, payload: { fields: ['receiptNo', 'receiptAmount'] }, expectBaseVersion: 0 });
  assert.equal(repository.maxStamp(), stamp0 + 2, 'stamp 单调:第2写+1');
  assert.deepEqual([...resolver.getDeptFields(STORE)], ['receiptNo', 'receiptAmount']);
  assert.deepEqual([...resolver.getModeReviewOverlay(MODE).relax], ['departureDateFinal'], 'B 的写不搅 A 的解析');

  // A 存 v2、B 存 v2:resolver 每次都拿到各自最新
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('purchaseDateFinal'), expectBaseVersion: 1 });
  assert.deepEqual([...resolver.getModeReviewOverlay(MODE).relax], ['purchaseDateFinal'], 'A v2 即时可见');
  repository.saveNewVersion({ kind: 'store', name: STORE, payload: { fields: ['receiptNo', 'upstream'] }, expectBaseVersion: 1 });
  assert.deepEqual([...resolver.getDeptFields(STORE)], ['receiptNo', 'upstream'], 'B v2 即时可见');
  assert.equal(repository.maxStamp(), stamp0 + 4, '4 写=+4,无跳号无并号');

  // 版本链各自独立:模式 2 版、店 2 版
  assert.equal(repository.listVersions('mode', MODE).length, 2);
  assert.equal(repository.listVersions('store', STORE).length, 2);
});

// ── 读窗口竞态:A 解析进行中 B 落库,中间版本不可错过 ──────────────────────────

test('读窗口竞态:resolver 读 A 期间(stamp 已读、行未读)B 落新版 → 下一次解析必见 B 新版,无陈旧缓存', (t) => {
  const { repository } = makeHarness(t);
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('departureDateFinal') });
  repository.saveNewVersion({ kind: 'store', name: STORE, payload: { fields: ['receiptNo'] } }); // B v1

  // 包一层仓储:在 resolver 读 mode 行的瞬间(maxStamp 已读进 cachedStamp 之后)插入 B v2——
  // 精确复现"A bump 后 resolver 读到,B bump 在读窗口内"的时序
  let fireOnce = null;
  const wrapped = {
    maxStamp: () => repository.maxStamp(),
    getActive: (kind, name) => {
      if (fireOnce) { const fn = fireOnce; fireOnce = null; fn(); }
      return repository.getActive(kind, name);
    },
  };
  const resolver = createReviewConfigResolver({ modeConfigRepository: wrapped, logger: SILENT });

  fireOnce = () => repository.saveNewVersion({ kind: 'store', name: STORE, payload: { fields: ['receiptNo', 'upstream'] } }); // B v2 落在读窗口内
  const overlay = resolver.getModeReviewOverlay(MODE);
  assert.deepEqual([...overlay.relax], ['departureDateFinal'], 'A 解析不受窗口内写影响');

  // 关键断言:B v2 的 bump 发生在 resolver cachedStamp 采样之后——若失效机制有洞,
  // 这里会吃到 B v1 的陈旧缓存;实际 ensureFresh 每次先比水位,必清缓存重读。
  assert.deepEqual([...resolver.getDeptFields(STORE)], ['receiptNo', 'upstream'], '读窗口内落库的中间版本不被错过');
  assert.deepEqual([...resolver.getModeReviewOverlay(MODE).relax], ['departureDateFinal'], 'A 重算后仍正确');

  // 反向窗口:A 的行读甚至可能读到"比 cachedStamp 新"的数据(stamp 先读)——只会多失效一次,
  // 永不陈旧。补一发:窗口内改 A 自己,首次解析即已见新值(行读晚于写),后续解析稳定同值。
  fireOnce = () => repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('receiptNoFinal') }); // A v2
  const resolver2 = createReviewConfigResolver({ modeConfigRepository: wrapped, logger: SILENT });
  const first = resolver2.getModeReviewOverlay(MODE);
  assert.deepEqual([...first.relax], ['receiptNoFinal'], '行读在写之后:直接读到 A v2');
  assert.deepEqual([...resolver2.getModeReviewOverlay(MODE).relax], ['receiptNoFinal'], '下一轮失效重读后同值(新数据配旧水位只多失效,不陈旧)');
});

// ── 同名并发:乐观锁 409 ──────────────────────────────────────────────────────

test('同名并发编辑:后到者 expectBaseVersion 旧值 → CONFIG_STALE(409语义),不落新版不动 active', (t) => {
  const { repository } = makeHarness(t);
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('departureDateFinal'), expectBaseVersion: 0 }); // v1
  // 管理员甲、乙同时打开编辑器(都看到 v1);甲先存
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('purchaseDateFinal'), expectBaseVersion: 1 }); // v2
  const stampAfterA = repository.maxStamp();

  // 乙基于 v1 保存 → 撞乐观锁(config_console_routes.js:218 据 code 映射 409 + currentVersion)
  let error = null;
  try {
    repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('receiptNoFinal'), expectBaseVersion: 1 });
  } catch (e) { error = e; }
  assert.ok(error, '必须抛错');
  assert.equal(error.code, 'CONFIG_STALE');
  assert.equal(error.currentVersion, 2, '带当前真实版本号供前端刷新');
  assert.match(error.message, /他人修改/);

  // 撞锁的写必须零副作用:无新版本、active 不动、stamp 不动(事务 ROLLBACK)
  assert.equal(repository.listVersions('mode', MODE).length, 2, '不落 v3');
  assert.deepEqual([...repository.getActive('mode', MODE).payload.review.relax], ['purchaseDateFinal'], 'active 仍是甲的 v2');
  assert.equal(repository.maxStamp(), stampAfterA, '失败写不 bump stamp(否则全网缓存白失效)');

  // 乙刷新后基于 v2 重存 → 通过
  repository.saveNewVersion({ kind: 'mode', name: MODE, payload: modePayload('receiptNoFinal'), expectBaseVersion: 2 });
  assert.equal(repository.getActive('mode', MODE).version, 3);
});

// ── activate/deactivate 也走水位:回滚不吃陈旧缓存(双 resolver 同源验证)────────

test('activate 只翻位不产新行也 bump stamp:review/mode 双 resolver 都即时换版,deactivate 即时回落', (t) => {
  const { repository } = makeHarness(t);
  const reviewResolver = createReviewConfigResolver({ modeConfigRepository: repository, logger: SILENT });
  const ruleResolver = createModeConfigResolver({ modeConfigRepository: repository, logger: SILENT });

  repository.saveNewVersion({
    kind: 'mode', name: MODE,
    payload: { columns: { ...ALL_COLUMNS, agent: false }, review: { relax: ['departureDateFinal'] } },
  }); // v1
  repository.saveNewVersion({
    kind: 'mode', name: MODE,
    payload: { columns: { ...ALL_COLUMNS }, review: { relax: ['purchaseDateFinal'] } },
  }); // v2
  // 两个 resolver 都缓存住 v2
  assert.deepEqual([...reviewResolver.getModeReviewOverlay(MODE).relax], ['purchaseDateFinal']);
  assert.equal(ruleResolver.getModeRecordRule(MODE).configVersion, 2);
  assert.equal(ruleResolver.getModeRecordRule(MODE).columns.agent, true);

  // 一键回滚 v1:不产生新行(listVersions 仍 2 条),但 stamp 必须动 → 两侧缓存同步失效
  const stampBefore = repository.maxStamp();
  repository.activateVersion('mode', MODE, 1);
  assert.equal(repository.maxStamp(), stampBefore + 1);
  assert.equal(repository.listVersions('mode', MODE).length, 2, 'activate 不产新行');
  assert.deepEqual([...reviewResolver.getModeReviewOverlay(MODE).relax], ['departureDateFinal'], 'review resolver 即时回 v1');
  assert.equal(ruleResolver.getModeRecordRule(MODE).configVersion, 1, 'mode resolver 即时回 v1');
  assert.equal(ruleResolver.getModeRecordRule(MODE).columns.agent, false, 'v1 列集生效(若用 MAX(id) 做水位这里就是陈旧缓存)');

  // 跨 kind 写只多失效不出错:动一条 review_base,mode 规则重算后仍是 v1 真值
  repository.saveNewVersion({
    kind: 'review_base', name: 'receipt',
    payload: { fields: ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal', 'departureDateFinal'] },
  });
  assert.equal(ruleResolver.getModeRecordRule(MODE).configVersion, 1, '无关 kind 的写不改本模式结果');

  // deactivate:同样只翻位,双 resolver 即时回落(null=出厂)
  repository.deactivate('mode', MODE);
  assert.equal(reviewResolver.getModeReviewOverlay(MODE), null, '回落出厂(resolver 层=null)');
  assert.equal(ruleResolver.getModeRecordRule(MODE), null, '回落出厂(矩阵内部接管)');
});
