'use strict';

/**
 * 0020 — 派生新鲜度脏标记。
 *
 * monthly_data / 交付包是「已核对台账 + 最新账单 + 最新配置」的纯派生结果。
 * derivation_dirty_from 记录「最浅需要重跑的阶段」(tour_match < bill_match < merge),
 * NULL = 新鲜。改台账/团号/模式 → 'tour_match';改账单 → 'bill_match';改扣点 → 'merge'。
 * 进最终核对页 / 出包前若非 NULL 就从该阶段往下重跑到 merge,跑完置 NULL。
 *
 * 存量工作区默认 NULL(视为新鲜,部署后不强制全量重跑;有真实变更才会被标脏)。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function addDerivationDirty(db) {
  const columns = new Set(getColumnNames(db, 'monthly_workspace'));
  if (!columns.has('derivation_dirty_from')) {
    db.exec("ALTER TABLE monthly_workspace ADD COLUMN derivation_dirty_from TEXT");
  }
};
