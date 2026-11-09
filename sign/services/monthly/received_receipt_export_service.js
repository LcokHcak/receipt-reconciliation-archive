'use strict';

/**
 * received_receipt_export_service — 生成"{月份}_收票汇总.xlsx"，按员工分 sheet。
 *
 * 输入：daily_receipt_export（月度库内每日收票表，agent 字段是代理 / 员工标识）
 * 输出：单个 xlsx，每个员工一个 sheet，命名 "N号 中文姓名"。
 *
 * 列头（12 列，参考 lib/monthly_pipeline/receipt_mapper.js 解析逻辑反向写）：
 *   收票日期 | 代理 | 购买日期 | 小票号 | 团号 | 姓名 | 护照号 |
 *   出境日期 | 模式 | 负责人 | 新世界机场14开头 | 新罗机场05开头 |
 *   系统台账ID | 来源文件 | 来源工作表 | 来源行号 | 来源批次
 *
 * 员工 sheet 名规则：
 *   - 员工表的 username/displayName 对应到 daily.agent
 *   - sheet 名 = `${agent_code} ${display_name}`（例 "9号 侯丹妮"）
 *   - 找不到员工：所有未匹配的行放进"未分配"sheet
 */

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const { ensureDir } = require('../../lib/workbench_utils');
const {
  FONT,
  SIZE_BODY,
  SIZE_HEADER,
  HEIGHT_BODY,
  HEIGHT_HEADER,
  styledColumnDefs,
  styleHeaderRowInPlace,
  styleBodyRowInPlace,
  resolveColumnTypes,
} = require('../../lib/excel_style');
const {
  isNoRecordMode,
  resolveCollectedDateFromLedgerRow,
} = require('../../lib/workbench_receipt_export');

const COLUMNS = Object.freeze([
  { header: '收票日期', key: 'receipt_date',  width: 12 },
  { header: '代理',     key: 'agent',         width: 14 },
  { header: '购买日期', key: 'purchase_date', width: 12 },
  { header: '小票号',   key: 'receipt_no',    width: 18 },
  { header: '团号',     key: 'tour_no',       width: 14 },
  { header: '姓名',     key: 'name',          width: 14 },
  { header: '护照号',   key: 'passport_no',   width: 14 },
  { header: '出境日期', key: 'departure_date',width: 12 },
  { header: '模式',     key: 'mode_raw',      width: 12 },
  { header: '负责人',   key: 'owner',         width: 12 },
  { header: '新世界机场14开头', key: 'shinsegae_airport', width: 18 },
  { header: '新罗机场05开头',   key: 'shilla_airport',    width: 18 },
  { header: '系统台账ID', key: 'ledger_id', width: 12 },
  { header: '来源文件', key: 'source_file', width: 24 },
  { header: '来源工作表', key: 'source_sheet', width: 14 },
  { header: '来源行号', key: 'source_row', width: 10 },
  { header: '来源批次', key: 'source_batch_id', width: 20 },
]);

// 每列字段类型(与 lib/excel_style 同口径),供流式逐行上样式复用。
const COLUMN_TYPES = resolveColumnTypes(COLUMNS);

// 统一表格样式的 sheet 级设置(流式版须在建 sheet 时传入:
// 冻结表头 views 是 getter-only,提交前才写的 autoFilter/pageSetup 一并传入)。
function dataSheetOptions(columnCount) {
  return {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }], // 需求 8:仅冻结首行(首列非身份定位列)
    autoFilter: { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } }, // 需求 9
    pageSetup: {
      orientation: 'landscape', // 需求 15:横向 + 水平居中 + 窄边距
      horizontalCentered: true,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  };
}

// 建"表格型数据 sheet":冻结/筛选/打印 + 列级样式(保留列宽/numFmt) + 表头行就地上样式。
function addStyledSheet(workbook, name, columns) {
  const sheet = workbook.addWorksheet(name, dataSheetOptions(columns.length));
  sheet.columns = styledColumnDefs(columns.map((c) => ({ ...c })));
  styleHeaderRowInPlace(sheet.getRow(1), columns.length);
  return sheet;
}

// 收票行 → 单元格值对象(员工 sheet 与"未分配"sheet 共用,保证列序/列数/取值完全一致)。
function buildReceiptRowValues(r, owner) {
  return {
    // 收票日期 = 我们收到并上传小票那天(客户建档日 CLyyyymmdd,KST)。
    // 兜底链在 resolveCollectedDateFromLedgerRow 内部(0801 收口:三个调用点原来各写各的兜底,
    // 同一个"收票日期"三种结果)。这里最后那道 receipt_date 是**最后的最后**——它语义上是
    // 审核通过日,只在 imported_at 也空时才拿来占位,总比整列空白强。
    receipt_date:      resolveCollectedDateFromLedgerRow(r) || fmtDate(r.receipt_date),
    agent:             r.agent || '',
    purchase_date:     fmtDate(r.purchase_date),
    receipt_no:        r.receipt_no || '',
    tour_no:           r.tour_no || '',
    name:              r.name || '',
    passport_no:       r.passport_no || '',
    departure_date:    fmtDate(r.departure_date),
    mode_raw:          r.mode_raw || '',
    owner,
    shinsegae_airport: '',
    shilla_airport:    '',
    ledger_id:         r.id,
    source_file:       r.source_file || '',
    source_sheet:      r.source_sheet || '',
    source_row:        r.source_row || '',
    source_batch_id:   r.source_batch_id || '',
  };
}

// 说明/元数据 sheet:仅上一致字体(全表观感统一),不改任何单元格值。
function addInfoRow(sheet, values, { title = false } = {}) {
  const row = sheet.addRow(values);
  row.height = title ? HEIGHT_HEADER : HEIGHT_BODY;
  row.eachCell((cell) => {
    cell.font = { name: FONT, size: title ? SIZE_HEADER : SIZE_BODY, bold: title };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  row.commit();
  return row;
}

function createReceivedReceiptExportService({ db, userService }) {
  if (!db) throw new Error('received_receipt_export_service: db required');

  async function run({ workspaceKey, outputDir, operator = '' }) {
    if (!workspaceKey || !outputDir) {
      throw new Error('workspaceKey and outputDir required');
    }
    ensureDir(outputDir);

    // 1. 拉取月度库所有 daily_receipt_export 行
    // 加上 receipt_date / agent_id / agent_code（阶段 1 新字段，审核台桥接会填）
    // source_customer_id：收票日期(=上传那天,CLyyyymmdd) 唯一口径 helper 需要它。
    const allRows = db.prepare(`
      SELECT id, agent, purchase_date, receipt_no, tour_no, name, passport_no,
             departure_date, mode_raw, imported_at, remark,
             receipt_date, agent_id, agent_code, source_type, modified_by,
             source_customer_id,
             source_file, source_sheet, source_row, source_batch_id
      FROM daily_receipt_export
      WHERE workspace_key = ?
      ORDER BY agent_id, agent_code, agent, imported_at, id
    `).all(workspaceKey);
    // 「不用记」行不进任何导出账单(2026-07-24 用户拍板):在导出出口按共享 predicate 过滤;
    // 台账里仍保留这些行(避免被未收对账误催),故只在这里剔除写进 sheet 的行集。
    const rows = allRows.filter((r) => !isNoRecordMode(r.mode_raw));
    const generatedAt = new Date().toISOString();

    // 2. 拉取员工列表，构建 agent → 员工映射
    const users = userService ? await userService.listUsers() : [];
    const userByCode = new Map();
    const userByName = new Map();
    const userByUsername = new Map();
    const userById = new Map();
    for (const u of users) {
      if (u.agent_code) userByCode.set(String(u.agent_code).trim(), u);
      if (u.display_name) userByName.set(String(u.display_name).trim(), u);
      if (u.username) userByUsername.set(String(u.username).trim(), u);
      if (u.id != null) userById.set(Number(u.id), u);
    }

    function userDisplayName(user) {
      if (!user) return '';
      return String(user.display_name || user.displayName || user.username || '').trim();
    }

    function resolveOwner(row, fallbackUser = null) {
      const modifiedBy = String(row.modified_by || '').trim();
      if (modifiedBy) {
        const matched = userByUsername.get(modifiedBy) || userByName.get(modifiedBy) || null;
        return userDisplayName(matched) || modifiedBy;
      }
      return userDisplayName(fallbackUser);
    }

    // 3. 按员工分组
    //    优先：daily.agent_id（审核台桥接已经写入）
    //    回退：daily.agent_code（旧 import 填的代理编号）
    //    再回退：daily.agent 字段尝试匹配编号 / 中文名 / 用户名
    const buckets = new Map(); // sheetKey → { user, rows[] }
    const unassigned = [];

    for (const row of rows) {
      let matchedUser = null;

      if (row.agent_id != null) {
        matchedUser = userById.get(Number(row.agent_id)) || null;
      }
      if (!matchedUser && row.agent_code) {
        matchedUser = userByCode.get(String(row.agent_code).trim()) || null;
      }
      if (!matchedUser) {
        const agentValue = String(row.agent || '').trim();
        if (agentValue) {
          matchedUser = userByCode.get(agentValue)
            || userByName.get(agentValue)
            || userByUsername.get(agentValue)
            || null;
        }
      }

      if (matchedUser && matchedUser.is_active === 1) {
        const code = String(matchedUser.agent_code || '').trim();
        const name = String(matchedUser.display_name || matchedUser.username || '').trim();
        const sheetKey = code ? `${code} ${name}`.trim() : name || matchedUser.username;
        if (!buckets.has(sheetKey)) {
          buckets.set(sheetKey, { sheetKey, user: matchedUser, rows: [] });
        }
        buckets.get(sheetKey).rows.push(row);
      } else {
        unassigned.push(row);
      }
    }

    // 4. 写 xlsx
    const fp = path.join(outputDir, `${sanitizeFileName(workspaceKey)}_收票汇总.xlsx`);
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: fp,
      useStyles: true, // 统一表格样式必须开启;否则流式写盘会丢弃所有单元格样式
      useSharedStrings: true,
    });

    // 4a. 每个员工一个 sheet（按 agent_code 数字排序，方便阅读）
    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
      const numA = Number((a.match(/^(\d+)/) || [])[1] || 9999);
      const numB = Number((b.match(/^(\d+)/) || [])[1] || 9999);
      return numA - numB;
    });

    const info = workbook.addWorksheet('生成说明');
    info.getColumn(1).width = 18;
    info.getColumn(2).width = 64;
    addInfoRow(info, ['生成说明'], { title: true });
    addInfoRow(info, ['文件用途', '收票汇总']);
    addInfoRow(info, ['工作月份', workspaceKey]);
    addInfoRow(info, ['生成时间', generatedAt]);
    addInfoRow(info, ['生成人', operator || '系统']);
    addInfoRow(info, ['数据行数', rows.length]);
    addInfoRow(info, ['员工 sheet 数', sortedKeys.length]);
    addInfoRow(info, ['未分配行数', unassigned.length]);
    addInfoRow(info, ['数据口径', '本月收票台账 daily_receipt_export，按负责人/员工拆分 sheet。']);
    addInfoRow(info, ['字段口径说明'], { title: true });
    for (const column of COLUMNS) {
      addInfoRow(info, [column.header, columnDescription(column.key)]);
    }
    info.commit();

    for (const sheetKey of sortedKeys) {
      const { user, rows: bucketRows } = buckets.get(sheetKey);
      const sheet = addStyledSheet(workbook, sheetKey, COLUMNS);
      let dataIndex = 0;
      for (const r of bucketRows) {
        dataIndex += 1;
        const row = sheet.addRow(buildReceiptRowValues(r, resolveOwner(r, user)));
        styleBodyRowInPlace(row, { types: COLUMN_TYPES, dataIndex, columnCount: COLUMNS.length });
        row.commit();
      }
    }

    // 4b. 未分配的行
    if (unassigned.length > 0) {
      const sheet = addStyledSheet(workbook, '未分配', COLUMNS);
      let dataIndex = 0;
      for (const r of unassigned) {
        dataIndex += 1;
        const row = sheet.addRow(buildReceiptRowValues(r, resolveOwner(r)));
        styleBodyRowInPlace(row, { types: COLUMN_TYPES, dataIndex, columnCount: COLUMNS.length });
        row.commit();
      }
    }

    // 4c. 概览 sheet（每个员工多少条）
    const summaryColumns = [
      { header: '员工', key: 'name', width: 24 },
      { header: '收票数', key: 'count', width: 10 },
    ];
    const summary = addStyledSheet(workbook, '收票数统计', summaryColumns);
    const summaryTypes = resolveColumnTypes(summaryColumns);
    let summaryIndex = 0;
    for (const sheetKey of sortedKeys) {
      summaryIndex += 1;
      const row = summary.addRow({ name: sheetKey, count: buckets.get(sheetKey).rows.length });
      styleBodyRowInPlace(row, { types: summaryTypes, dataIndex: summaryIndex, columnCount: summaryColumns.length });
      row.commit();
    }
    if (unassigned.length > 0) {
      summaryIndex += 1;
      const row = summary.addRow({ name: '未分配', count: unassigned.length });
      styleBodyRowInPlace(row, { types: summaryTypes, dataIndex: summaryIndex, columnCount: summaryColumns.length });
      row.commit();
    }
    summaryIndex += 1;
    const totalRow = summary.addRow({ name: '合计', count: rows.length });
    styleBodyRowInPlace(totalRow, { types: summaryTypes, dataIndex: summaryIndex, columnCount: summaryColumns.length });
    totalRow.commit();

    await workbook.commit();

    return {
      workspaceKey,
      outputPath: fp,
      totalRows: rows.length,
      employeeCount: sortedKeys.length,
      unassignedCount: unassigned.length,
      producedAt: generatedAt,
    };
  }

  return { run, COLUMNS };
}

function fmtDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return '';
  // ISO 字符串只保留日期部分
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function columnDescription(key) {
  return {
    receipt_date: '台账收票日期，用来确认本月收到小票的日期。',
    agent: '建客户目录时填写的代理/客户标识。',
    purchase_date: '小票购买日期。',
    receipt_no: '小票号，来自审核台识别或人工修正。',
    tour_no: '团号，来自审核台识别、团号表匹配或人工修正。',
    name: '客户姓名，优先使用审核确认后的姓名。',
    passport_no: '护照号，优先使用审核确认后的护照号。',
    departure_date: '出境日期，小票类凭证使用。',
    mode_raw: '业务模式原始值。',
    owner: '负责人，即处理/审核导入这条台账的操作员。',
    shinsegae_airport: '新世界机场补充列，导出时预留给人工或下游填写。',
    shilla_airport: '新罗机场补充列，导出时预留给人工或下游填写。',
    ledger_id: '系统台账ID，可回到系统收票台账中追溯原始记录。',
    source_file: '这条台账最早导入系统时的来源文件。',
    source_sheet: '这条台账最早导入系统时的来源工作表。',
    source_row: '这条台账最早导入系统时的来源 Excel 行号。',
    source_batch_id: '这条台账来自的审核批次或导入批次。',
  }[key] || '系统导出字段。';
}

function sanitizeFileName(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'workspace';
}

module.exports = { createReceivedReceiptExportService };
