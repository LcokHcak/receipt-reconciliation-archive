-- 流式逐客户结算:审核员手动确认"命中的渠道模式"留痕。
-- 现状是 mapping 自动落桶就算 matched,无人工背书层;新流程加一层人工确认。
-- mode_confirmed_at IS NULL = 待确认;非空 = 已确认(该客户该小票渠道模式已人工背书)。
ALTER TABLE daily_receipt_export ADD COLUMN mode_confirmed_at TEXT;
ALTER TABLE daily_receipt_export ADD COLUMN mode_confirmed_by TEXT;
