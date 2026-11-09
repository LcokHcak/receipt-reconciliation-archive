-- 0021_pending_fingerprint_index: pending_review.conflict_fingerprint 索引
--
-- bill_match 每遇到一个冲突就 queuePending → findByFingerprint 去重(查同指纹的
-- open/resolved/rejected 行,避免重复立待审)。conflict_fingerprint 原先无索引,
-- 大月份 5万+冲突 × 全表扫不断增长的 pending_review = O(n²),实测是 matchLoop 主要慢因。
-- 加 (workspace_key, conflict_fingerprint, id) 索引,把全表扫变成索引查。
CREATE INDEX IF NOT EXISTS idx_pending_review_fingerprint
  ON pending_review (workspace_key, conflict_fingerprint, id);
