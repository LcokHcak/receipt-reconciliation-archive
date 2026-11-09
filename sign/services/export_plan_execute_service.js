'use strict';

/**
 * export_plan_execute_service — 配置台 P2.1/P3b:导出计划**真落盘**执行器。
 *
 * 两种计划:
 *   - DSL 文件夹计划:引擎解析路径 → 拷贝进临时 staging → zip(系统 zip/python3,同资料库导出);
 *     ⭐硬闸:blocked(空值阻断,拍板默认)或**跨客户撞名**(collisions)存在 → 拒绝执行并列清单,
 *     绝不带病落盘——预览页先改到 0 阻断再导。
 *   - Excel 明细表计划:从台账 42 列(daily_receipt_export)按勾选列出 xlsx(exceljs);
 *     行来源=已结算落库的台账行,按 workspaceKey(+scope 模式)筛。
 *
 * builtin 计划不在这里执行(老导出按钮承载,防第二真相源)。
 *
 * 返回契约:{ zipPath, downloadName, stats, cleanup }——cleanup 由**调用方在下载完成回调里**执行
 * (照 batch_customer_data 等四先例;不清=每单在 tmp 留整批图副本,复核HIGH-1)。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  resolveExportPlan,
  buildCustomerGroups,
  validateExportPlan,
  EXCEL_COLUMN_DEFS,
} = require('../lib/export_plan_engine');
const { archiveZip, cleanupDir } = require('./batch_customer_data_export_service');
const { formatReceiptNoCell } = require('./monthly/library_mode_export_service');
const { applyExcelStyle } = require('../lib/excel_style');
const { isNoRecordMode } = require('../lib/workbench_receipt_export');

function stampName(prefix) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// 导出说明.txt(0729 静默排查 A5)。纯函数,直测;没有可说的返回 null 不写。
// skipped 是 [{ customerId, reason }](引擎产出:「模式不在计划范围」「整组未审核完」等),
// **按 reason 分组**而不是平铺列客户号 —— 一堆客户号糊在一起看不出该做什么,
// 而「整组未审核完」和「模式不在计划范围」的处置完全不同:前者审完重导,后者是计划写窄了。
// 段间空行(0729 真实数据核验发现):各段是逐步 push 出来的,谁也没负责段尾留白,
// 于是「…不用回来核对。」后面直接顶着「【未进包·还没审完】」,糊成一片没法扫读。
// 统一在这里补,而不是让每个段落自己 push('') —— 段落会一直加,靠人记必漏。
function spaceSections(lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith('【') && out.length && out[out.length - 1] !== '') out.push('');
    out.push(line);
  }
  return out;
}

function buildExportPlanNotes({ skipped = [], copyFailed = [] } = {}) {
  const lines = [];
  if (skipped.length) {
    const byReason = new Map();
    for (const s of skipped) {
      const reason = String(s?.reason || '未说明原因');
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(String(s?.customerId || '(无客户号)'));
    }
    lines.push(`【没进包的客户组】共 ${skipped.length} 个,按原因分:`);
    for (const [reason, ids] of byReason) {
      lines.push(`  · ${reason} —— ${ids.length} 个`);
      for (const id of ids.slice(0, 15)) lines.push(`      ${id}`);
      if (ids.length > 15) lines.push(`      …等共 ${ids.length} 个`);
    }
    lines.push('  「整组未审核完」= 审完后重新导出即可收进来;');
    lines.push('  「模式不在计划范围」= 计划本身没圈到这些模式,要收就去配置台改计划。');
  }
  if (copyFailed.length) {
    lines.push(`【文件缺失】${copyFailed.length} 个文件没能复制进包:`);
    for (const f of copyFailed.slice(0, 20)) lines.push(`  - ${f}`);
    if (copyFailed.length > 20) lines.push(`  …等共 ${copyFailed.length} 个`);
    lines.push('  重新导出通常能解决;仍失败请报运维。');
  }
  return lines.length ? ['自定义交付计划 · 导出说明(系统自动生成)', ''].concat(spaceSections(lines)) : null;
}

function createExportPlanExecuteService({ resolveBatchRelativePath, queryLedgerRows = null, zipFn = archiveZip, ExcelJS = null, copyFileFn = fsp.copyFile }) {
  if (typeof resolveBatchRelativePath !== 'function') {
    throw new Error('export_plan_execute_service: resolveBatchRelativePath required');
  }

  function resolveTaskFile(batchId, task) {
    const rel = String(task?.sourceImagePath || '').trim();
    if (!rel) return '';
    try {
      const abs = resolveBatchRelativePath(batchId, rel);
      return abs && fs.statSync(abs).isFile() ? abs : '';
    } catch { return ''; }
  }

  /** DSL 计划落盘:staging 拷贝 + zip。硬闸=blocked/collisions 非空即拒。 */
  async function executeDslPlan({ plan, batch }) {
    const verdict = validateExportPlan(plan);
    if (!verdict.ok || verdict.kind !== 'dsl') {
      const err = new Error(`不是可执行的 DSL 计划:${verdict.reason || verdict.kind}`);
      err.code = 'EXPORT_PLAN_INVALID';
      throw err;
    }
    const groups = buildCustomerGroups(batch, (task) => resolveTaskFile(batch.id, task));
    const resolved = resolveExportPlan(plan, groups);
    if (resolved.blocked.length) {
      const err = new Error(`有 ${resolved.blocked.length} 项被空值护栏阻断,先在预览里清零再导出`);
      err.code = 'EXPORT_PLAN_BLOCKED';
      err.blocked = resolved.blocked.slice(0, 50);
      throw err;
    }
    if (resolved.collisions.length) {
      const err = new Error(`有 ${resolved.collisions.length} 处跨客户重名(不同客户落进同一路径),改模板区分开再导出`);
      err.code = 'EXPORT_PLAN_COLLISION';
      err.collisions = resolved.collisions.slice(0, 50);
      throw err;
    }
    if (!resolved.entries.length) {
      const err = new Error('该计划在此批次没有可导出的文件(范围不命中或整组未审)');
      err.code = 'EXPORT_PLAN_EMPTY';
      err.skipped = resolved.skipped.slice(0, 50);
      throw err;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'export-plan-'));
    const stagingName = stampName(`交付-${String(plan.planLabel || '计划').slice(0, 24)}`).replace(/[\\/:*?"<>|]/g, '_');
    const stagingRoot = path.join(work, stagingName);
    // 单文件拷失败不整单作废、也绝不裸吞(审计#10教训):计数+留痕,包内少图有账可查
    const copyFailed = [];
    for (const entry of resolved.entries) {
      const dest = path.join(stagingRoot, ...entry.destPath.split('/'));
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await copyFileFn(entry.srcPath, dest);
      } catch (copyErr) {
        copyFailed.push(`${entry.destPath}(${copyErr?.message || 'copy failed'})`);
      }
    }
    if (copyFailed.length >= resolved.entries.length) {
      cleanupDir(work);
      const err = new Error('全部文件拷贝失败(源图不可读?),导出中止');
      err.code = 'EXPORT_PLAN_COPY_ALL_FAILED';
      err.copyFailed = copyFailed.slice(0, 50);
      throw err;
    }
    // 0729 静默排查 A5:skipped / copyFailed 在**成功**路径上被丢得最干净——
    // 整单失败时反而会随 422 回给前端,而"部分跳过/部分拷贝失败但 zip 照常生成"
    // 这个真正需要提醒的情形,响应是 res.download 流二进制,塞不进 JSON 字段。
    // 于是操作员拿到一个看起来正常的 zip,里面少了几个客户组,零提示。
    // 与其它五个交付入口同规矩:写进包根「导出说明.txt」。
    // 这条通道是配置台给运营开的自定义交付规则,以后会承载越来越多定制形态 —— 越早统一越好。
    const notes = buildExportPlanNotes({ skipped: resolved.skipped, copyFailed });
    if (notes) {
      try {
        await fsp.mkdir(stagingRoot, { recursive: true });
        fs.writeFileSync(path.join(stagingRoot, '导出说明.txt'), `\uFEFF${notes.join('\n')}`, 'utf8');
      } catch { /* 说明写不进不该拖垮导出本身 */ }
    }

    const zipPath = path.join(work, `${stagingName}.zip`);
    const zipRes = await zipFn(zipPath, stagingName, work);
    if (!zipRes.ok || !fs.existsSync(zipPath)) {
      cleanupDir(work); // 失败路径同样不留 staging(四先例口径)
      const err = new Error(zipRes.code === 'ZIP_UNAVAILABLE' ? '服务器缺少 zip / python3,无法打包导出' : `打包失败:${zipRes.detail || '未知'}`);
      err.code = 'EXPORT_PLAN_ZIP_FAILED';
      throw err;
    }
    return {
      zipPath,
      downloadName: `${stagingName}.zip`,
      stats: { ...resolved.stats, files: resolved.entries.length - copyFailed.length, copyFailed: copyFailed.length },
      skipped: resolved.skipped.slice(0, 50),
      copyFailed: copyFailed.slice(0, 50),
      cleanup: () => cleanupDir(work), // 调用方在下载完成回调里清(四先例同款契约)
    };
  }

  /** Excel 明细表计划:台账行选列出 xlsx。 */
  async function executeExcelPlan({ plan, workspaceKey }) {
    const verdict = validateExportPlan(plan);
    if (!verdict.ok || verdict.kind !== 'excel') {
      const err = new Error(`不是可执行的明细表计划:${verdict.reason || verdict.kind}`);
      err.code = 'EXPORT_PLAN_INVALID';
      throw err;
    }
    if (typeof queryLedgerRows !== 'function') {
      const err = new Error('明细表导出依赖未装配(queryLedgerRows)');
      err.code = 'EXPORT_PLAN_DEPS_MISSING';
      throw err;
    }
    const ws = String(workspaceKey || '').trim();
    if (!ws) {
      const err = new Error('明细表导出需要 workspaceKey(台账按月工作区存)');
      err.code = 'EXPORT_PLAN_WORKSPACE_REQUIRED';
      throw err;
    }
    const columns = plan.excel.columns;
    // 「不用记」行(2026-07-24 拍板):代理标注不用记的票不进任何导出账单表;
    // 台账仍保留该行(避免未收对账误催),故在**导出出口**按共享 predicate 过滤 mode_raw。
    const rows = queryLedgerRows({ workspaceKey: ws, modes: plan.scope?.modes || [] })
      .filter((row) => !isNoRecordMode(row.mode_raw));

    const Excel = ExcelJS || require('exceljs');
    const workbook = new Excel.Workbook();
    const sheet = workbook.addWorksheet('明细');
    sheet.columns = columns.map((key) => ({
      header: EXCEL_COLUMN_DEFS[key].header,
      key,
      width: EXCEL_COLUMN_DEFS[key].width || 16,
    }));
    for (const row of rows) {
      // receipt_no 走与「客户数据Excel」同一 formatReceiptNoCell(按行 mode_raw 重排:letters14 保 G/
      // dashed19 补杠/digits 剥杠),否则两个 Excel 出口对同一台账行产出不同票号(副本失步,审计MEDIUM)。
      sheet.addRow(Object.fromEntries(columns.map((key) => [
        key,
        key === 'receipt_no' ? formatReceiptNoCell(row) : (row[key] ?? ''),
      ])));
    }
    // 统一表格样式(视觉层):列序/列数/值/表头/numFmt 均由 applyExcelStyle 保留,只补美化。
    // freezeCols=0:明细列由 plan.excel.columns 配置驱动,左侧非「序号/客户组/客户编号」定位列。
    applyExcelStyle(sheet, { headerRow: 1, freezeCols: 0 });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'export-plan-xlsx-'));
    const fileBase = stampName(`明细-${String(plan.planLabel || '计划').slice(0, 24)}`).replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(work, `${fileBase}.xlsx`);
    try {
      await workbook.xlsx.writeFile(filePath);
    } catch (writeErr) {
      cleanupDir(work);
      throw writeErr;
    }
    return {
      zipPath: filePath,
      downloadName: `${fileBase}.xlsx`,
      stats: { rows: rows.length, columns: columns.length },
      cleanup: () => cleanupDir(work),
    };
  }

  return { executeDslPlan, executeExcelPlan };
}

module.exports = { createExportPlanExecuteService, buildExportPlanNotes };
