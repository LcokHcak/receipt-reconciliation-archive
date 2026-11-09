'use strict';

/**
 * mode_config_repository — 配置台版本化存储(P0/T2,2026-07-14)。
 *
 * 设计(docs/配置台架构设计_2026-07-14.md):
 *   - 同 kind+name 多版本,**永不 UPDATE 覆盖**:每次保存=INSERT 新版本;
 *   - active 指针(部分唯一索引保证同名至多一条 active);修改日志=版本流水本身;
 *   - 乐观锁:saveNewVersion 带 expectBaseVersion,不匹配=有人先改了,抛 CONFIG_STALE;
 *   - deactivate=全部下线 → 消费方(resolver)自动回落出厂配置,这就是"一键回滚到出厂"。
 *
 * kind:'mode'=渠道模式(P0 起用) | 'store'=店家档案(P0 只存不用,P3 接) |
 *      'export_plan'=文件夹导出计划(P2)。
 * payload 存 JSON 文本;解析失败不炸——payload 返回 null 由消费方按"坏配置"回落。
 */

function createModeConfigRepository({ db }) {
  if (!db) throw new Error('mode_config_repository: db required');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      version    INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 0,
      -- L532:曾被激活过(单调,只置不清)——区分「草稿顶点」(从未激活)与「回滚孤儿」(曾激活后被
      -- 回滚),二者在版本号层同形(active<max),乐观锁靠它才能对回滚孤儿的陈旧 expect=max 报 409。
      ever_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_config_kind_name_ver
      ON config_entries(kind, name, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_config_active
      ON config_entries(kind, name) WHERE active = 1;
    -- 变更水位:resolver 缓存失效依据。不能用 MAX(id)——activate/deactivate 只翻 active 位
    -- 不产生新行,回滚旧版本会吃到陈旧缓存;显式计数器在每个写事务内自增,滴水不漏。
    CREATE TABLE IF NOT EXISTS config_meta (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO config_meta (key, value) VALUES ('stamp', 0);
  `);

  // L532:兼容存量库补 ever_active 列(CREATE TABLE IF NOT EXISTS 对旧库不加列)。宽松回填:当前
  // 生效行标 ever_active=1(永不误伤草稿顶点;唯一缺口=部署前已回滚的孤儿实体,记档为已知非回归缺口)。
  const configCols = db.prepare("PRAGMA table_info(config_entries)").all().map((c) => c.name);
  if (!configCols.includes('ever_active')) {
    db.exec('ALTER TABLE config_entries ADD COLUMN ever_active INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('UPDATE config_entries SET ever_active = 1 WHERE active = 1 AND ever_active = 0');

  const stmtGetActive = db.prepare(
    'SELECT * FROM config_entries WHERE kind = ? AND name = ? AND active = 1'
  );
  const stmtGetAllActive = db.prepare(
    'SELECT * FROM config_entries WHERE kind = ? AND active = 1 ORDER BY name'
  );
  const stmtListVersions = db.prepare(
    'SELECT * FROM config_entries WHERE kind = ? AND name = ? ORDER BY version DESC'
  );
  const stmtMaxVersion = db.prepare(
    'SELECT MAX(version) AS max_version FROM config_entries WHERE kind = ? AND name = ?'
  );
  const stmtInsert = db.prepare(
    `INSERT INTO config_entries (kind, name, version, payload, active, ever_active, created_at, created_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const stmtClearActive = db.prepare(
    'UPDATE config_entries SET active = 0 WHERE kind = ? AND name = ? AND active = 1'
  );
  // L532:激活=版本变生效,一并置 ever_active=1(单调,只置不清)。
  const stmtActivate = db.prepare(
    'UPDATE config_entries SET active = 1, ever_active = 1 WHERE kind = ? AND name = ? AND version = ?'
  );
  // L532:取某版本是否「曾被激活」——乐观锁区分草稿顶点(0)与回滚孤儿(1)。
  const stmtVersionEverActive = db.prepare(
    'SELECT ever_active FROM config_entries WHERE kind = ? AND name = ? AND version = ?'
  );
  const stmtMaxStamp = db.prepare("SELECT value AS stamp FROM config_meta WHERE key = 'stamp'");
  const stmtBumpStamp = db.prepare("UPDATE config_meta SET value = value + 1 WHERE key = 'stamp'");
  // P3c 配置日志页:全 kind 版本流水(倒序分页;active 位标生效中)
  const stmtChangelog = db.prepare(
    'SELECT kind, name, version, active, created_at, created_by, note FROM config_entries ORDER BY id DESC LIMIT ? OFFSET ?'
  );
  const stmtChangelogCount = db.prepare('SELECT COUNT(*) AS n FROM config_entries');

  function parseRow(row) {
    if (!row) return null;
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null; // 坏 JSON 不炸:消费方按"坏配置"回落出厂并留痕
    }
    return {
      kind: row.kind,
      name: row.name,
      version: Number(row.version),
      payload,
      payloadRaw: row.payload,
      active: Number(row.active) === 1,
      createdAt: row.created_at,
      createdBy: row.created_by,
      note: row.note,
    };
  }

  function getActive(kind, name) {
    return parseRow(stmtGetActive.get(String(kind), String(name)));
  }

  function getAllActive(kind) {
    return stmtGetAllActive.all(String(kind)).map(parseRow);
  }

  function listVersions(kind, name) {
    return stmtListVersions.all(String(kind), String(name)).map(parseRow);
  }

  /** P3c:配置日志聚合(跨 kind 全量流水,新→旧)。limit 夹在 1~200。 */
  function listChangelog({ offset = 0, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = stmtChangelog.all(safeLimit, safeOffset).map((row) => ({
      kind: row.kind,
      name: row.name,
      version: row.version,
      active: Boolean(row.active),
      createdAt: row.created_at,
      createdBy: row.created_by,
      note: row.note,
    }));
    return { total: Number(stmtChangelogCount.get()?.n || 0), rows };
  }

  function currentMaxVersion(kind, name) {
    const row = stmtMaxVersion.get(String(kind), String(name));
    return Number(row?.max_version || 0);
  }

  /**
   * 保存新版本(默认随手 activate——配置台"保存即生效"的语义)。
   * expectBaseVersion:乐观锁——调用方编辑时基于的版本号;传 null=不检查(seed 脚本用)。
   * 双基准:expect 等于「生效版本」或「链尾 max」任一即放行——
   *   前端各保存路径发的是生效版本,回滚/停用后 active<max,只比 max 会把该实体
   *   打成永久 409(0720「无法保存」真凶);而导出计划草稿流(存新版不激活)基于 max 续存,
   *   只比 active 又会打死草稿续存。两个基准都是合法编辑起点,都不是=真并发,抛 CONFIG_STALE。
   */
  function saveNewVersion({ kind, name, payload, createdBy = '', note = '', expectBaseVersion = null, activate = true }) {
    const k = String(kind);
    const n = String(name);
    db.exec('BEGIN IMMEDIATE');
    try {
      const base = currentMaxVersion(k, n);
      if (expectBaseVersion !== null) {
        const activeVersion = Number(stmtGetActive.get(k, n)?.version || 0);
        const expect = Number(expectBaseVersion);
        // L532:expect===active 永远放行(基于生效版本编辑)。expect===max 仅当 max 行**从未激活**
        // (草稿顶点)才放行;max 行**曾激活**(回滚孤儿,active<max 但旧 max 被回滚)则视为陈旧,落
        // CONFIG_STALE——修「陈旧 expect=max 静默覆盖回滚」洞,同时不误伤草稿续存(草稿 ever_active=0)。
        const maxRowEverActive = Number(stmtVersionEverActive.get(k, n, base)?.ever_active || 0) === 1;
        const accept = expect === activeVersion || (expect === base && !maxRowEverActive);
        if (!accept) {
          const error = new Error(`配置已被他人修改(当前生效 v${activeVersion},最新 v${base},你基于 v${expect}),请刷新后重试`);
          error.code = 'CONFIG_STALE';
          error.currentVersion = activeVersion || base;
          throw error;
        }
      }
      const version = base + 1;
      if (activate) stmtClearActive.run(k, n);
      stmtInsert.run(
        k, n, version,
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        activate ? 1 : 0,
        activate ? 1 : 0, // ever_active:随手激活的版本即刻标「曾激活」;草稿(activate:false)为 0
        new Date().toISOString(), String(createdBy || ''), String(note || '')
      );
      stmtBumpStamp.run();
      db.exec('COMMIT');
      return { kind: k, name: n, version, active: Boolean(activate) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 激活历史版本=一键回滚。 */
  function activateVersion(kind, name, version) {
    const k = String(kind);
    const n = String(name);
    db.exec('BEGIN IMMEDIATE');
    try {
      stmtClearActive.run(k, n);
      const res = stmtActivate.run(k, n, Number(version));
      if (Number(res.changes) !== 1) {
        const error = new Error(`版本不存在:${k}/${n} v${version}`);
        error.code = 'CONFIG_VERSION_NOT_FOUND';
        throw error;
      }
      stmtBumpStamp.run();
      db.exec('COMMIT');
      return { kind: k, name: n, version: Number(version) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 全部下线(=回落出厂,不删任何历史版本)。 */
  function deactivate(kind, name) {
    db.exec('BEGIN IMMEDIATE');
    try {
      stmtClearActive.run(String(kind), String(name));
      stmtBumpStamp.run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 全表变更水位(resolver 缓存失效用;显式计数器,activate/deactivate 也会动)。 */
  function maxStamp() {
    const row = stmtMaxStamp.get();
    return Number(row?.stamp || 0);
  }

  return {
    getActive,
    getAllActive,
    listVersions,
    listChangelog,
    currentMaxVersion,
    saveNewVersion,
    activateVersion,
    deactivate,
    maxStamp,
  };
}

module.exports = { createModeConfigRepository };
