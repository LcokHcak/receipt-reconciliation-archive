'use strict';

// 待补救「一键补救」:把已内联选好模式的所有行一次性提交。结构断言(本仓库前端测试风格)。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const view = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'views', 'DailyRemedyView.vue'),
  'utf8',
);

test('待补救页有「一键补救」按钮 + submitAllModes 批量逻辑', () => {
  // 按钮 + 计数
  assert.match(view, /一键补救/);
  assert.match(view, /modePickedCount/);
  assert.match(view, /@click="submitAllModes"/);
  // 批量函数:筛已选模式的行、逐行提交、带 manualRemedyConfirm、失败不中断
  assert.match(view, /async function submitAllModes/);
  // 选了批次后「一键补救」只作用于当前批次 → 用 filteredRows 而非全量 rows
  assert.match(view, /filteredRows\.value\.filter\(\(r\) => modeEdit\[r\.id\]\)/);
  assert.match(view, /manualRemedyConfirm: true/);
  assert.match(view, /failed\.push/);
});

test('一键补救按钮在没有选中模式时不可用', () => {
  // 2026-07-27 设计整改:从"禁用的实心蓝按钮"改为**选中数>0 才渲染** ——
  // 禁用的主按钮长得像主角却不能按,是最浪费注意力的控件(且它是全页唯一实心蓝)。
  // 语义不变:没选中就没法提交。
  assert.match(view, /modePickedCount > 0/);
  assert.match(view, /groupPickedCount > 0/);
  assert.ok(!/groupPickedCount === 0/.test(view), '不再用 disabled 占位');
});

test('待补救页支持按团号+代理分组、组级批量补救', () => {
  assert.match(view, /viewMode/); // 分组/平铺切换
  assert.match(view, /groupKeyOf/); // 按 (月+团号+代理) 分组
  assert.match(view, /async function submitGroup/); // 补救本组
  assert.match(view, /async function submitAllGroups/); // 一键补救已选组
  assert.match(view, /rowByRowOnly/); // 日期类逐行、不并入组级
  assert.match(view, /multiAgent/); // 同团号多代理提示
  // 组级补救复用同一后端接口(逐行 updateLedgerFields + manualRemedyConfirm)
  assert.match(view, /updateLedgerFields\(row\._workspaceKey, row\.id, \{ modeRaw: mode, manualRemedyConfirm: true \}\)/);
});

// ── 0724 image46 备注:团号表列表可一键全部收起/按月收起 ────────────────────
test('团号表列表:月头可点折叠 + 全部收起/展开一键切换,收起时月头带汇总', () => {
  const view = fs.readFileSync(path.join(__dirname, '../frontend/src/views/DailyRemedyView.vue'), 'utf8');
  assert.match(view, /collapsedMonths/, '按月折叠状态集');
  assert.match(view, /toggleMonth\(grp\.workspaceKey\)/, '月头可点折叠');
  assert.match(view, /toggleAllMonths/, '一键全部收起/展开');
  assert.match(view, /allMonthsCollapsed \? '全部展开' : '全部收起'/, '按钮文案随状态翻转');
  assert.match(view, /grp\.items\.length \}\} 张表 · 待补救 \{\{ grp\.remedyTotal/, '收起后月头保留汇总(不点开也知道量)');
  assert.match(view, /v-show="!collapsedMonths\.has\(grp\.workspaceKey\)"/, '收起=隐藏该月列表');
});

// ── 0728 image42 设计稿定稿:分组行两行式无框 ───────────────────────────────
test('image42:分组行=两行式,客户数无框、原因纯文字琥珀、定位审核台链接式、组间细分隔线', () => {
  const view = fs.readFileSync(path.join(__dirname, '../frontend/src/views/DailyRemedyView.vue'), 'utf8');
  // 组容器:细分隔线列表,不再一组一张圆角卡(image98「这老些框先给取消了」)
  assert.match(view, /divide-y divide-border rounded-lg border border-border bg-card/);
  // 行1:代理·N 客户 = 纯文字(旧「N 个客户」带框断言反向锁死)
  assert.match(view, /\{\{ g\.agent \|\| '—' \}\} · \{\{ g\.count \}\} 客户/);
  assert.ok(!view.includes('rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{{ g.count }} 个客户'), '客户数不再套框');
  // 行2:原因纯文字(组头不再用 StatusBadge 胶囊;逐行表格里的照旧)
  const groupHeader = view.slice(view.indexOf("viewMode === 'group'"), view.indexOf('<table v-if="expandedGroups'));
  assert.ok(!groupHeader.includes('<StatusBadge'), '组头原因去胶囊');
  assert.match(groupHeader, /text-status-warn"><\/span>|text-status-warn">\{\{ \[\.\.\.g\.reasons\]/, '原因=琥珀纯文字');
  // 定位审核台:链接式(text-primary + hover:underline),不再描边按钮
  assert.match(groupHeader, /text-primary underline-offset-2 hover:underline/);
});
