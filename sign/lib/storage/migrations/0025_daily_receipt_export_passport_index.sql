-- 重复建档查重(settledReceiptLookup)改为按护照拉全量后两侧数字投影比对(2026-07-14):
-- 查询是裸 passport_no,既有 (workspace_key, passport_no) 复合索引用不上=全表扫。
-- 二次收票(百货日常)每次归档撞名都查一回,补单列索引。
CREATE INDEX IF NOT EXISTS idx_daily_receipt_export_passport ON daily_receipt_export (passport_no);
