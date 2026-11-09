/**
 * RULE_VERSION — 每次改匹配规则时递增这个字符串。落进 stage_jobs 和
 * match_badcase 每行，方便事后 SQL 按版本筛问题样本。
 *
 * 命名约定：YYYY-MM-DD-<slug>
 *
 * 历史：
 *   2026-05-11-baseline         Sprint 2 W4 收尾，badcase + advisory lock 落地
 *   2026-05-11-rule-set-v2      引入 "-本司" 过滤 + 免税店 3 枚举 + 小票/团号按
 *                               店铺位数校验 + 日期范围校验（规则表 v2）
 */

const RULE_VERSION = '2026-05-11-rule-set-v2';

module.exports = { RULE_VERSION };
