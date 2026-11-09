-- 台账按客户组(source_batch_id, source_customer_id)查缺复合索引(深度审计 MEDIUM/HIGH,2026-07-22)。
-- listWorkspaceKeysForSourceGroupStmt(queries.js)WHERE source_batch_id=? AND source_customer_id=?
-- (SELECT DISTINCT workspace_key,故意不带 workspace_key)——既有索引全以 workspace_key/passport_no 前导,
-- 无一可用 → 对整张台账(单库跨全工作区/全月份)全表扫描。该查询在结算/确认/订正/交付热路径上高频调:
-- cleanOldUnmatchedRows(每次结算)、readGroupAcrossWorkspaces(confirmGroupModes×2/correctGroupLedger/
-- getGroupSettlement)、交付计划按组循环;node:sqlite 同步执行,台账随月累积→扫描成本无界增长、抬高
-- confirmGroupModes 超时概率。
-- 前两列匹配 WHERE,尾列 workspace_key 覆盖 DISTINCT → 索引内即可去重(index-only scan),全表扫转索引查。
CREATE INDEX IF NOT EXISTS idx_daily_receipt_source_group
  ON daily_receipt_export (source_batch_id, source_customer_id, workspace_key);
