-- 配置台P1覆盖率查询(SELECT DISTINCT mode FROM group_code):
-- 团号表 338 万行历史堆积(129 份导入,有案),无 mode 索引=同步全表扫卡主线程。
-- 单列索引让 DISTINCT 走索引扫描;IF NOT EXISTS 幂等。
CREATE INDEX IF NOT EXISTS idx_group_code_mode ON group_code (mode);
