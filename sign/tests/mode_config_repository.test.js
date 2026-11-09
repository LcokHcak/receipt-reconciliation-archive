'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-config-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return createModeConfigRepository({ db });
}

test('版本流水:保存即新版本,active 指针只有一条,历史全保留', (t) => {
  const repo = makeRepo(t);
  const v1 = repo.saveNewVersion({ kind: 'mode', name: 'X模式', payload: { a: 1 }, createdBy: 'op1' });
  assert.equal(v1.version, 1);
  const v2 = repo.saveNewVersion({ kind: 'mode', name: 'X模式', payload: { a: 2 }, createdBy: 'op2', note: '改了a' });
  assert.equal(v2.version, 2);

  const active = repo.getActive('mode', 'X模式');
  assert.equal(active.version, 2);
  assert.deepEqual(active.payload, { a: 2 });

  const versions = repo.listVersions('mode', 'X模式');
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((row) => row.active).length, 1); // active 唯一
  assert.equal(versions[0].version, 2); // 倒序
  assert.equal(versions[1].createdBy, 'op1'); // 历史保留含操作人(修改日志=版本流水)
});

test('乐观锁:expectBaseVersion 不匹配抛 CONFIG_STALE,库不留半截', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'Y模式', payload: { a: 1 } });
  // 编辑者基于 v1 保存,但中间有人存了 v2
  repo.saveNewVersion({ kind: 'mode', name: 'Y模式', payload: { a: 2 } });
  assert.throws(
    () => repo.saveNewVersion({ kind: 'mode', name: 'Y模式', payload: { a: 3 }, expectBaseVersion: 1 }),
    (error) => error.code === 'CONFIG_STALE' && error.currentVersion === 2
  );
  assert.equal(repo.listVersions('mode', 'Y模式').length, 2); // 回滚干净
  assert.deepEqual(repo.getActive('mode', 'Y模式').payload, { a: 2 });
});

// 8模块审计 CRITICAL 级:回滚/停用后 active<max,前端发生效版本,只比 max=该实体永久409
// (0720「配置台无法保存」头号真凶)。双基准:生效版本/链尾 max 都是合法编辑起点。
test('乐观锁双基准:回滚后基于生效版本保存不再永久409', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'R模式', payload: { a: 1 } });
  repo.saveNewVersion({ kind: 'mode', name: 'R模式', payload: { a: 2 } });
  repo.activateVersion('mode', 'R模式', 1); // 回滚:active=1,max=2
  // 前端刷新看到生效 v1,基于它编辑保存 → 必须放行(旧语义这里永久 CONFIG_STALE)
  const v3 = repo.saveNewVersion({ kind: 'mode', name: 'R模式', payload: { a: 3 }, expectBaseVersion: 1 });
  assert.equal(v3.version, 3); // 版本号仍接链尾,历史不打洞
  assert.deepEqual(repo.getActive('mode', 'R模式').payload, { a: 3 });
  // 真并发仍拦:另一编辑者停留在被回滚顶掉的旧基准(v1/v2 都已不是合法起点)
  assert.throws(
    () => repo.saveNewVersion({ kind: 'mode', name: 'R模式', payload: { a: 9 }, expectBaseVersion: 2 }),
    (error) => error.code === 'CONFIG_STALE' && error.currentVersion === 3
  );
});

test('乐观锁双基准:停用(回落出厂)后基于 v0 保存放行;草稿续存基于 max 放行', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'D模式', payload: { a: 1 } });
  repo.saveNewVersion({ kind: 'mode', name: 'D模式', payload: { a: 2 } });
  repo.deactivate('mode', 'D模式'); // active=无,max=2;前端读到 config=null → expect=0
  const v3 = repo.saveNewVersion({ kind: 'mode', name: 'D模式', payload: { a: 3 }, expectBaseVersion: 0 });
  assert.equal(v3.version, 3);
  assert.equal(repo.getActive('mode', 'D模式').version, 3);
  // 导出计划草稿流:存 v4 不激活(active=3,max=4),继续编辑草稿基于 4 保存 → 放行
  repo.saveNewVersion({ kind: 'mode', name: 'D模式', payload: { a: 4 }, expectBaseVersion: 3, activate: false });
  const v5 = repo.saveNewVersion({ kind: 'mode', name: 'D模式', payload: { a: 5 }, expectBaseVersion: 4, activate: false });
  assert.equal(v5.version, 5);
  assert.equal(repo.getActive('mode', 'D模式').version, 3); // 草稿不动 active
});

// L532:回滚孤儿——回滚(activateVersion)后 active<max,陈旧编辑者持 expect=旧max(曾激活过)保存
// 必须 409,不能静默覆盖回滚(修前:expect===max 放行→悄悄产 v3 撤销管理员回滚,无 CONFIG_STALE)。
// 靠 ever_active 区分:旧 max 曾激活=回滚孤儿(拦);从未激活=草稿顶点(放行,见下条)。
test('乐观锁L532:回滚后陈旧 expect=旧max(曾激活)保存报 CONFIG_STALE,不静默覆盖回滚', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'RO模式', payload: { a: 1 } }); // v1 active(曾激活)
  repo.saveNewVersion({ kind: 'mode', name: 'RO模式', payload: { a: 2 } }); // v2 active(曾激活)
  repo.activateVersion('mode', 'RO模式', 1); // 管理员一键回滚:active=1,max=2(v2 曾激活=回滚孤儿)
  // 陈旧编辑者仍持 expect=2(=max),修前会放行覆盖回滚 → 修后必须 409
  assert.throws(
    () => repo.saveNewVersion({ kind: 'mode', name: 'RO模式', payload: { a: 99 }, expectBaseVersion: 2 }),
    (error) => error.code === 'CONFIG_STALE',
    '回滚孤儿 expect=旧max 不放行(修前静默覆盖回滚)',
  );
  // 回滚未被撤销:active 仍 v1,max 仍 2(没产 v3)
  assert.equal(repo.getActive('mode', 'RO模式').version, 1, '回滚保住,active 仍 v1');
  assert.equal(repo.currentMaxVersion('mode', 'RO模式'), 2, '未产新版本');
  // 陈旧编辑者刷新后基于生效 v1 再存 → 放行(expect===active 永远合法)
  const v3 = repo.saveNewVersion({ kind: 'mode', name: 'RO模式', payload: { a: 3 }, expectBaseVersion: 1 });
  assert.equal(v3.version, 3);
});

// L532 反面不误伤:草稿顶点(max 行从未激活)的 expect=max 仍放行(草稿续存不被新守卫误拦)。
test('乐观锁L532:草稿顶点(从未激活)expect=max 仍放行(不误伤草稿续存)', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'DR模式', payload: { a: 1 } }); // v1 active
  // 存草稿 v2(不激活,active 仍 1,max=2,v2 从未激活)
  repo.saveNewVersion({ kind: 'mode', name: 'DR模式', payload: { a: 2 }, expectBaseVersion: 1, activate: false });
  // 基于草稿 max=2 续存 → 放行(v2 ever_active=0,是草稿顶点非回滚孤儿)
  const v3 = repo.saveNewVersion({ kind: 'mode', name: 'DR模式', payload: { a: 3 }, expectBaseVersion: 2, activate: false });
  assert.equal(v3.version, 3);
  assert.equal(repo.getActive('mode', 'DR模式').version, 1, '草稿不动 active');
});

test('activateVersion=一键回滚;deactivate=回落出厂(历史不删)', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: 'Z模式', payload: { a: 1 } });
  repo.saveNewVersion({ kind: 'mode', name: 'Z模式', payload: { a: 2 } });

  repo.activateVersion('mode', 'Z模式', 1);
  assert.equal(repo.getActive('mode', 'Z模式').version, 1);

  assert.throws(
    () => repo.activateVersion('mode', 'Z模式', 99),
    (error) => error.code === 'CONFIG_VERSION_NOT_FOUND'
  );
  // 失败=事务整体回滚,原 active(v1)原封不动——激活失败绝不把配置打下线
  assert.equal(repo.getActive('mode', 'Z模式').version, 1);
  repo.activateVersion('mode', 'Z模式', 2);

  repo.deactivate('mode', 'Z模式');
  assert.equal(repo.getActive('mode', 'Z模式'), null);
  assert.equal(repo.listVersions('mode', 'Z模式').length, 2);
});

test('坏 JSON payload 不炸:payload=null 由消费方按坏配置回落', (t) => {
  const repo = makeRepo(t);
  repo.saveNewVersion({ kind: 'mode', name: '坏模式', payload: '{oops' }); // 直接塞坏串
  const row = repo.getActive('mode', '坏模式');
  assert.equal(row.payload, null);
  assert.equal(row.payloadRaw, '{oops');
});

test('maxStamp 随任何写入变化(resolver 缓存失效水位)', (t) => {
  const repo = makeRepo(t);
  const s0 = repo.maxStamp();
  repo.saveNewVersion({ kind: 'mode', name: 'W模式', payload: { a: 1 } });
  const s1 = repo.maxStamp();
  assert.ok(s1 > s0);
});
