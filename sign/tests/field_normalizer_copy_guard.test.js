'use strict';

/**
 * 字段清洗副本巡逻(2026-07-10,同病三犯后的永久防线)。
 *
 * 病史:票号回弹(07-06 前端副本剥字母横线)→ 字母团号(07-10 台账桥副本剥字母)→
 * 全库审计又挖出 OCR 抽取/表侧导入/定位模型等 20 处同族漂移。
 * 病理恒定:中央真相源(lib/workbench_field_normalizer)保真实信息,散落副本各写各的数字化投影。
 *
 * 本测试全库扫描"团号/票号上下文里的数字化投影代码",与下面的冻结清单精确比对:
 *   - 新增一处 → 测试失败,逼你回答:这是存储路径(禁止,委托中央)还是比较投影(允许,
 *     把站点加进清单并注明"比较投影")。
 *   - 少了一处(修掉了副本)→ 同样失败,更新清单=有意识的决定。
 * 铁律:存储路径(落盘/写台账/导出/回写任务字段)禁止数字化投影;匹配/查重/日志随意。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'services', 'routes', 'repositories', path.join('frontend', 'src')];
const FIELD_CONTEXT = /tourNo|tour_no|groupNo|group_no|receiptNo|receipt_no|团号|票号/i;
const STRIP_PATTERNS = [/replace\(\s*\/\\D\/g?/, /replace\(\s*\/\[\^0-9\]\/g?/];

// ── 冻结清单:file → 允许的命中次数。每条必须注明类别。──────────────────────
const ALLOWLIST = new Map(Object.entries({
  // 前端镜像:normalizeDigits 定义本体(与后端中央逐字镜像,一致性测试锁死)
  'frontend/src/lib/reviewFieldConfig.js': 1,
  // 比较/过滤投影(A类合法,不落盘):
  //   multisheet:行过滤 digitCore + 号段前缀 pfx(团号本体已走中央保字母,2026-07-10 修)
  'lib/monthly_pipeline/group_code_multisheet.js': 2,
  //   qwen isJunkNumericValue:编造值形态检测投影(全同/顺子判定,不改值)
  'lib/qwen_ocr/field_normalizer.js': 1,
  //   qwen 百货两段式(2026-07-12 金标重放):
  //   dept_rescue ①条码长串被当票号的形态检测(比较投影)②条码整串数字清洗
  //   (条码本体即纯数字,日期锚推导的输入,不是票号落盘路径)
  'lib/qwen_ocr/dept_rescue.js': 2,
  //   adapter 百货块 ①4-4"同串重复劫"比较投影 ②百货存储口径合同:票面 거래번호
  //   印 4位-4位 带杠,三家档案 dash:true 补杠存(0727#13-4 拍板,乐天旧 dash:false 作废)
  //   ——同 receipt_export"按模式投影"家族,非剥语义
  //   ③多票坍缩预警的"不同票号判重"比较投影(复审 MEDIUM,不落盘)
  'lib/qwen_ocr/qwen_ocr_adapter.js': 3,
  //   receipt_no_barcode(2026-07-21 三批):条码载荷与一遍读数的匹配判定(比较投影,
  //   不落盘;采纳值走 alnum 保字母 → adapter 经 normalizeOcrFieldsForDocType 中央归一)
  'lib/qwen_ocr/receipt_no_barcode.js': 1,
  //   receipt_field_model:仅注释提及旧写法(cleanReceiptNo/cleanGroupNo 已委托中央)
  'lib/receipt_field_model.js': 1,
  //   receipt_export formatReceiptNoForMode:digits13/14 模式的交付格式合同(有意的按模式投影)
  'lib/workbench_receipt_export.js': 2,
  //   格式预检(0727#15)listFormatIssues:票号位数核对的**比较投影**(只读不落存储,
  //   预检是眼睛不是闸);形态合同本体在 receipt_export/mode_record_matrix,这里只数位数
  'services/monthly/library_mode_export_service.js': 1,
  //   ledger bridge:警示注释 1 处 + 金额数字化 1 处(金额无字母语义)
  'services/workbench_ledger_bridge_service.js': 2,
  //   前端 FieldEditor:票号长度校验的显示投影(不改值)
  'frontend/src/components/FieldEditor.vue': 1,
  // ⚠️BACKLOG(paddle 引擎 extractGroupNo,非默认后端,审计 MEDIUM 立案待修——修掉时把计数改小):
  'lib/paddle_receipt_parser.js': 1,
}));

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|vue)$/.test(e.name)) out.push(full);
  }
  return out;
}

function scanFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!STRIP_PATTERNS.some((re) => re.test(lines[i]))) continue;
    const ctx = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
    if (FIELD_CONTEXT.test(ctx)) hits += 1;
  }
  return hits;
}

test('团号/票号上下文的数字化投影站点与冻结清单精确一致(防副本口径漂移三犯)', () => {
  const found = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const hits = scanFile(file);
      if (hits > 0) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        found.set(rel, hits);
      }
    }
  }

  const problems = [];
  for (const [file, hits] of found) {
    const allowed = ALLOWLIST.get(file) || 0;
    if (hits > allowed) {
      problems.push(`新增数字化投影:${file}(${hits} 处,清单允许 ${allowed})——存储路径请委托 lib/workbench_field_normalizer;确属比较投影则更新清单并注明`);
    }
  }
  for (const [file, allowed] of ALLOWLIST) {
    const hits = found.get(file) || 0;
    if (hits < allowed) {
      problems.push(`清单过期:${file} 现有 ${hits} 处(清单记 ${allowed})——修掉了副本?更新清单计数`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('本地 normalizeTourNo 副本必须委托中央 normalizeGroupNo 或属于匹配投影白名单', () => {
  // 07-10 事故点名:凡自定义 normalizeTourNo 的文件,要么委托中央,要么在匹配投影白名单
  // (prematch/tour_match 的"剥前导字母"是查表兜底比较,合法)。
  const MATCH_PROJECTION_FILES = new Set([
    'services/group_code_prematch_service.js',
    'services/monthly/tour_match_service.js',
  ]);
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/function normalizeTourNo|normalizeTourNo\s*=/.test(text)) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (MATCH_PROJECTION_FILES.has(rel)) continue;
      assert.match(
        text, /normalizeGroupNo/,
        `${rel} 自定义了 normalizeTourNo 却没委托中央 normalizeGroupNo(07-10 台账剥字母事故同款)`
      );
    }
  }
});
