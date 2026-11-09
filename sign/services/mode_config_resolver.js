'use strict';

/**
 * mode_config_resolver — 配置台 P0/T4:DB 配置 → 模式记录规则。
 *
 * 挂进 lib/mode_record_matrix.setModeRuleResolver 后,lookupModeRecordRule 的所有消费方
 * (台账桥/台账导出)自动改走这里;本函数返回 null 即回落出厂矩阵——
 * **未配置/坏配置/校验不过,系统行为与今天逐字节一致,永不因配置挂**。
 *
 * 缓存:按 config_entries 全表水位(MAX(id))失效;命中在缓存填充时打一条
 * config_hit 日志(带版本号),坏配置打 config_fallback——版本戳可查(T6)。
 */

// resolveCanonicalModeName:别名→正名共享归一(读写同源,复核HIGH#1 影子配置根绝)
const { composeModeRule, resolveCanonicalModeName } = require('../lib/mode_record_matrix');

const COLUMN_KEYS = Object.freeze([
  'recordDate', 'agent', 'purchaseDate', 'receiptNo',
  'groupNo', 'name', 'passportNo', 'departureDate',
]);
const RECEIPT_NO_FORMS = new Set(['', 'digits13', 'digits14', 'dashed19', 'letters14', 'dash44']);

/** 手写 schema 校验:形状不对=坏配置,一票否决整条回落(绝不半信半疑地用)。 */
function validateModeConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload 不是对象' };
  }
  const columns = payload.columns;
  if (!columns || typeof columns !== 'object' || Array.isArray(columns)) {
    return { ok: false, reason: 'columns 缺失' };
  }
  for (const key of COLUMN_KEYS) {
    if (typeof columns[key] !== 'boolean') {
      return { ok: false, reason: `columns.${key} 必须是布尔` };
    }
  }
  for (const key of Object.keys(columns)) {
    if (!COLUMN_KEYS.includes(key)) {
      return { ok: false, reason: `columns 出现未知列 ${key}` };
    }
  }
  if (payload.receiptNoForm !== undefined && !RECEIPT_NO_FORMS.has(payload.receiptNoForm)) {
    return { ok: false, reason: `receiptNoForm 非法:${payload.receiptNoForm}` };
  }
  if (payload.actions !== undefined
    && (!Array.isArray(payload.actions) || payload.actions.some((a) => typeof a !== 'string'))) {
    return { ok: false, reason: 'actions 必须是字符串数组' };
  }
  for (const key of ['note', 'groupNoLiteral', 'modeLabel']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'string') {
      return { ok: false, reason: `${key} 必须是字符串` };
    }
  }
  // P3a:模式微调段(审核 relax/require/slim/sActivityMark)——延迟 require 防环
  if (payload.review !== undefined) {
    const { validateModeReviewOverlay } = require('./review_config_resolver');
    const verdict = validateModeReviewOverlay(payload.review);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function createModeConfigResolver({ modeConfigRepository, logger = console }) {
  if (!modeConfigRepository) throw new Error('mode_config_resolver: modeConfigRepository required');

  // base 名 → hit(可直接喂 composeModeRule 的矩阵行形状)| null(明确无配置/坏配置)
  const cache = new Map();
  let cachedStamp = -1;

  function ensureFresh() {
    let stamp;
    try {
      stamp = modeConfigRepository.maxStamp();
    } catch (error) {
      // 库不可用=当作无配置:清缓存回落出厂,绝不让台账导出因配置库炸掉
      logger.warn?.('[config] config_store_unavailable, falling back to factory', { error: error?.message });
      cache.clear();
      cachedStamp = -1;
      return false;
    }
    if (stamp !== cachedStamp) {
      cache.clear();
      cachedStamp = stamp;
    }
    return true;
  }

  function hitFor(base) {
    if (cache.has(base)) return cache.get(base);
    let hit = null;
    try {
      const row = modeConfigRepository.getActive('mode', base);
      if (row) {
        const verdict = row.payload ? validateModeConfig(row.payload) : { ok: false, reason: 'payload JSON 解析失败' };
        if (verdict.ok) {
          hit = {
            mode: row.payload.modeLabel || base,
            columns: Object.freeze({ ...row.payload.columns }),
            receiptNoForm: row.payload.receiptNoForm || '',
            actions: Object.freeze([...(row.payload.actions || [])]),
            note: row.payload.note || '',
            groupNoLiteral: row.payload.groupNoLiteral || '',
            configVersion: row.version,
          };
          logger.info?.('config_hit', { name: base, version: row.version });
        } else {
          logger.warn?.('config_fallback', { name: base, version: row.version, reason: verdict.reason });
        }
      }
    } catch (error) {
      logger.warn?.('config_fallback', { name: base, reason: error?.message });
      hit = null;
    }
    cache.set(base, hit);
    return hit;
  }

  /**
   * 与 lookupModeRecordRule 同参:团号表模式原串(可带尾巴)。
   * 返回规则对象=配置命中;返回 null=回落出厂(矩阵内部处理)。
   */
  function getModeRecordRule(modeRaw) {
    const raw = String(modeRaw || '').trim();
    if (!raw) return null; // 空串语义(DEFAULT_RULE)交出厂,别抢
    if (!ensureFresh()) return null;
    const hit = hitFor(resolveCanonicalModeName(raw));
    if (!hit) return null;
    // 尾巴动作/不用记按**原串**现算,与出厂同一套 composeModeRule——绝不抄第二份
    const rule = composeModeRule(hit, raw);
    rule.configVersion = hit.configVersion; // T6 版本戳(导出日志可查"按哪版结的")
    return rule;
  }

  function invalidate() {
    cache.clear();
    cachedStamp = -1;
  }

  return { getModeRecordRule, validateModeConfig, invalidate };
}

module.exports = { createModeConfigResolver, validateModeConfig };
