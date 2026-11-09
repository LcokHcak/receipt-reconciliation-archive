-- 0019_unreceived_resolution: 未收清单「已处理」状态持久化 (B3)
--
-- 未收项 = 账单有、台账无,逐张小票。操作员对其执行 link / 延期(delay) / 作废(void)
-- 后必须落库,否则刷新即复活(原实现只 console.log + 本地消项)。
-- item_key 与 customer_reconciliation_service.unreceivedItemKey 同口径:
--   normalize(passport_no) | normalize(name) | normalize(receipt_no)
-- 据此把已处理项从 listUnreceived 结果中过滤掉(页面与导出同源)。

CREATE TABLE IF NOT EXISTS unreceived_resolution (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  item_key      TEXT NOT NULL,
  passport_no   TEXT,
  name          TEXT,
  receipt_no    TEXT,
  action        TEXT NOT NULL,        -- 'link' | 'delay' | 'void' | 'waive'(2026-07-17 代理视图「无需补」,同表复用)
  linked_ref    TEXT,                 -- link 动作:关联到的候选标识
  reason        TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT NOT NULL,
  UNIQUE (workspace_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_unreceived_resolution_ws
  ON unreceived_resolution (workspace_key);
