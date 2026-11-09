'use strict';

/**
 * 出厂配置快照守卫(配置台 P0/T3):
 *   seed 落库后,resolver 对**全部 29 个模式**的输出必须与出厂矩阵逐字段一致
 *   (含尾巴动作/不用记/别名拼写)——seed 漂移=红。
 *   这是"行为零变化"承诺的机器证明:生产跑不跑 seed,台账列都一样。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createModeConfigResolver } = require('../services/mode_config_resolver');
const { seedFactoryConfig } = require('../scripts/seed_factory_config');
const {
  lookupModeRecordRule,
  setModeRuleResolver,
  MATRIX,
} = require('../lib/mode_record_matrix');
const { PROFILES, FAMILY } = require('../lib/store_profiles');

function stripVersion(rule) {
  const { configVersion: _configVersion, ...rest } = rule; // omit 解构,_=有意丢弃
  return rest;
}

function makeSeededResolver(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-snapshot-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const result = seedFactoryConfig({ repository });
  const resolver = createModeConfigResolver({
    modeConfigRepository: repository,
    logger: { info: () => {}, warn: () => {} },
  });
  t.after(() => {
    setModeRuleResolver(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository, resolver, seedResult: result };
}

test('seed 幂等:首跑全写入,二跑全跳过', (t) => {
  const { repository, seedResult } = makeSeededResolver(t);
  const deptCount = Object.values(PROFILES).filter((p) => p.family === FAMILY.DEPT).length;
  assert.equal(seedResult.entries, MATRIX.length + deptCount + 5); // +3 导出计划(P2) +2 审核基线(P3a)
  assert.equal(seedResult.written, MATRIX.length + deptCount + 5);
  const second = seedFactoryConfig({ repository });
  assert.equal(second.written, 0);
  assert.equal(second.skipped, MATRIX.length + deptCount + 5);
});

test('⭐快照:seed 后 resolver ≡ 出厂矩阵——全部模式逐字段一致(行为零变化的机器证明)', (t) => {
  const { resolver } = makeSeededResolver(t);

  for (const row of MATRIX) {
    const factory = lookupModeRecordRule(row.mode); // 未挂钩=出厂
    const fromConfig = resolver.getModeRecordRule(row.mode);
    assert.ok(fromConfig, `${row.mode} 应命中配置`);
    assert.ok(fromConfig.configVersion >= 1, `${row.mode} 应带版本戳`);
    assert.deepEqual(stripVersion(fromConfig), factory, `${row.mode} 配置输出漂移`);
  }
});

test('快照:尾巴/别名/未知模式在挂钩状态下与出厂一致', (t) => {
  const { resolver } = makeSeededResolver(t);

  const cases = [
    '乐天SG-本司（发小票17）',        // 手写尾巴动作
    '济州乐天SG-道辉不用记',          // 不用记尾巴
    '爱宝客pkg-本司',                 // 小写拼写(归一化折叠)
    '乐天H团-本司（原乐天V-本司）',   // 表侧别名(MODE_ALIASES 桥)
    '新世界机场-振华',                // groupNoLiteral='无'
  ];
  for (const raw of cases) {
    const factory = lookupModeRecordRule(raw);
    setModeRuleResolver(resolver.getModeRecordRule);
    const hooked = lookupModeRecordRule(raw);
    setModeRuleResolver(null);
    assert.deepEqual(stripVersion(hooked), factory, `${raw} 挂钩后漂移`);
    // 复核MEDIUM:必须证明是"命中 DB 输出一致",不是"回落出厂碰巧一致"(别名桥假绿病史)
    assert.ok(hooked.configVersion >= 1, `${raw} 应真命中配置(带版本戳)而非静默回落`);
  }

  // 未知模式:配置无此名 → resolver null → 出厂默认全记(挂钩前后同)
  const unknownFactory = lookupModeRecordRule('完全未知模式X');
  setModeRuleResolver(resolver.getModeRecordRule);
  assert.deepEqual(lookupModeRecordRule('完全未知模式X'), unknownFactory);
  setModeRuleResolver(null);
});

test('店家档案 seed:百货三家入库(P0 只存不用,P3 接),passportFree 只标新世界/现代', (t) => {
  const { repository } = makeSeededResolver(t);
  const stores = repository.getAllActive('store');
  assert.equal(stores.length, 3);
  const byName = new Map(stores.map((row) => [row.name, row.payload]));
  assert.equal(byName.get('SHINSEGAE_DEPT').passportFree, true);
  assert.equal(byName.get('HYUNDAI_DEPT').passportFree, true);
  assert.equal(byName.get('LOTTE_DEPT').passportFree, false); // 同框票不免(2026-07-14 复核细化)
  assert.equal(byName.get('LOTTE_DEPT').combined, true);
  assert.deepEqual(byName.get('LOTTE_DEPT').rules.brand, ['루이비통', '반클리프 아펠', '티파니']);
});
