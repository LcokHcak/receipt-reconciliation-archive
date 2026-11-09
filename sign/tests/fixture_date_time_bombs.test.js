'use strict';

/**
 * 夹具里的"跨时间炸弹":写死的日期 + 代码里的滚动时间窗 = 到某一天自己变红。
 *
 * 2026-08-01 一天之内踩到三枚,形状完全一样:
 *   ① workbench_ledger_bridge:购买日期写死 '2026-01-29',而桥接校验「未来90天/历史±6个月」。
 *      7-31 还在窗口内、8-1 出界 → 3 条用例集体红,而代码一行没改;
 *   ② workbench_overview「P2 我的数据(本月)」:day1 写死 '-01',每月 1 号 day1===TODAY,
 *      reviewedByDate 两个键塌成一个,90 被 60 覆盖 —— 一年 12 次必红;
 *   ③ e2e row_history_open:事件时间写死 '2026-05-23',而行历史抽屉默认按**近 30 天**筛,
 *      到今天已 70 天 → 接口明明返回 1 条、页面渲染 0 条。
 *
 * 这类最坏的地方不是"红",是**红得毫无线索**:代码没动、提交没动,只有日历动了。
 * 排查的人第一反应是去翻最近的改动,而那里什么都没有。
 *
 * 这道闸只盯**真的会流进时间窗校验**的那一类,不去管仓库里另外一千多个纯数据日期
 * (实测:tests/ 与 frontend/e2e/ 共 179 个文件、1409 个日期字面量,绝大多数无害,
 *  全改成相对当天既没必要、也会把用例写得更难读)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DAY_MS = 86400000;
// 桥接的窗口是「历史 6 个月」。留 30 天余量:150 天以上就该提前改成相对当天,
// 别等真出界那天才发现(那时已经是一次莫名其妙的红)。
const STALE_DAYS = 150;

function listTestFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('⭐真的走 ±6个月窗口的用例,不许把购买日期写死成快过期的值', () => {
  const files = listTestFiles(path.join(ROOT, 'tests'));
  assert.ok(files.length > 100, `扫描面异常(${files.length} 个文件),闸可能失灵`);

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // 只认**真的加载了桥接服务**的用例:用 stub 的(如 workbench_batch_ledger_import_service)
    // 根本不跑窗口校验,写死日期无害,不该被误报。
    if (!src.includes("require('../services/workbench_ledger_bridge_service')")) continue;

    // ⚠️ 粒度必须到 **test 块**,不能按文件。同一个文件里既有走校验的 syncApprovedGroup,
    // 也有直调 _taskToLedgerRow 的用例 —— 后者不过窗口校验,而且它那个日期正是**被断言的值**
    // (assert.equal(row.purchaseDate, '2026-01-12')),改成相对当天反而把用例弄坏。
    // 第一版按文件扫,就把它误报成了炸弹。
    for (const block of src.split(/\ntest\(/).slice(1)) {
      if (!block.includes('syncApprovedGroup')) continue;
      for (const m of block.matchAll(/purchaseDateFinal:\s*'(20\d\d-\d\d-\d\d)'/g)) {
        const days = Math.round((Date.now() - Date.parse(m[1])) / DAY_MS);
        if (days > STALE_DAYS) {
          offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${m[1]}(${days} 天前)`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [],
    '这些购买日期快掉出「历史±6个月」窗口了,改成相对当天生成(参考 '
    + 'tests/workbench_ledger_bridge_service.test.js 的 monthsAgoISO):\n  '
    + offenders.join('\n  '));
});

test('⭐「本月」类用例不许把日期写死成月初(每月 1 号必红)', () => {
  const files = listTestFiles(path.join(ROOT, 'tests'));
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // 形状:同时用 TODAY 派生的月份前缀 和 写死的 -01,两者在 1 号会撞成同一天
    if (!/monthPrefix|TODAY\.slice\(0, 7\)/.test(src)) continue;
    if (/\$\{monthPrefix\}-01`/.test(src) && !/endsWith\('-01'\)/.test(src)) {
      offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(offenders, [],
    '这些用例把"本月内另一天"写成了固定的 -01,每月 1 号会和 TODAY 撞成同一天:\n  '
    + offenders.join('\n  '));
});

test('⭐前端 e2e:被「近30天」筛选消费的事件时间不许写死', () => {
  const e2eDir = path.join(ROOT, 'frontend', 'e2e');
  if (!fs.existsSync(e2eDir)) return;
  const offenders = [];
  for (const file of listTestFiles(e2eDir)) {
    const src = fs.readFileSync(file, 'utf8');
    // 只认真正喂行历史接口的 spec(抽屉默认 filters.range='30')
    if (!/daily\/\d+\/history/.test(src)) continue;
    for (const m of src.matchAll(/ts:\s*'(20\d\d-\d\d-\d\d)/g)) {
      const days = Math.round((Date.now() - Date.parse(m[1])) / DAY_MS);
      if (days > 20) {
        offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${m[1]}(${days} 天前)`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    '行历史抽屉默认只显示近 30 天,这些写死的事件时间会被静默滤掉(接口返回了、页面 0 条):\n  '
    + offenders.join('\n  '));
});

test('自检:三条闸的扫描面都不为空(SKIP 规则写错会让它们静默永绿)', () => {
  const testFiles = listTestFiles(path.join(ROOT, 'tests'));
  assert.ok(
    testFiles.some((f) => fs.readFileSync(f, 'utf8')
      .includes("require('../services/workbench_ledger_bridge_service')")),
    '没找到任何真加载桥接服务的用例 —— 第一条闸等于没跑',
  );
  const e2eDir = path.join(ROOT, 'frontend', 'e2e');
  assert.ok(
    listTestFiles(e2eDir).some((f) => /daily\/\d+\/history/.test(fs.readFileSync(f, 'utf8'))),
    '没找到任何喂行历史接口的 spec —— 第三条闸等于没跑',
  );
});
