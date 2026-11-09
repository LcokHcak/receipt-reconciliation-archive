'use strict';

/**
 * business_time — 业务时区("今日"从几点切天)的单一真相源。
 *
 * 免税业务在韩国,默认 Asia/Seoul(UTC+9);SIGN_BUSINESS_TZ 可覆盖。
 * 原先只有 workbench_overview_service 私有实现;工作台首页分离(2026-07-18)
 * 需要在批次摘要(summarizeBatch → reviewStats.reviewedByDate)里用同一口径
 * 折算审核动作日期,故上提到 lib 共享——两处口径漂移会导致"今日审核"数字
 * 首页与看板对不上。
 */

const BUSINESS_TZ = process.env.SIGN_BUSINESS_TZ || 'Asia/Seoul';

// 把 ISO 时间戳折算到业务时区的日期串 YYYY-MM-DD(en-CA 正好给这个格式)。
function businessDate(value, tz = BUSINESS_TZ) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return String(value).slice(0, 10);
  }
}

module.exports = { BUSINESS_TZ, businessDate };
