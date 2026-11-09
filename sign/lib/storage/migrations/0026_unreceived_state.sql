-- 0026: 未收 first_seen 锚表(代理视图 B 页,2026-07-16)。
-- 未收清单本体=派生可重算(customer_reconciliation_service.listUnreceived,账单 sale ⟂ 台账在场);
-- 唯一不可派生的锚是 first_seen_at:该未收项第一次被对账发现的时刻(超7天红的起算点,拍板③)。
-- item_key 与 unreceived_resolution 完全同口径(unreceivedItemKey:归一护照|姓名|票号),
-- 不发明第三种投影。「无需补」人工豁免不在此表——P3 决策它与 unreceived_resolution(link/
-- delay/void)怎么合流,避免两套人工标记裂脑。
CREATE TABLE IF NOT EXISTS unreceived_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE (workspace_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_unreceived_state_ws
  ON unreceived_state (workspace_key);
