'use strict';

/**
 * import_validation_service — 导入数据校验前置（Sprint 2 W4）。
 *
 * 在实际导入前对 Excel 文件进行预校验：
 *   1. 文件格式检查（是否为有效 xlsx）
 *   2. 必填列检查（根据导入类型）
 *   3. 数据类型检查（日期、数字格式）
 *   4. 重复数据检查（基于业务键）
 *   5. 外键引用检查（如 tour_no 是否存在于 group_code）
 *
 * 返回：
 *   - valid: boolean
 *   - errors: Array<{ row, column, message }>
 *   - warnings: Array<{ row, column, message }>
 *   - summary: { totalRows, validRows, errorRows, warningRows }
 */

const { streamRows } = require('../../lib/monthly_pipeline/xlsx_reader');

const VALIDATION_RULES = {
  group_code: {
    requiredColumns: ['tour_no', 'mode', 'apply_date', 'end_date'],
    dateColumns: ['apply_date', 'end_date'],
    uniqueKey: ['tour_no'],
  },
  store_bill: {
    requiredColumns: ['receipt_no', 'purchase_date'],
    dateColumns: ['purchase_date', 'departure_date'],
    uniqueKey: ['receipt_no', 'purchase_date', 'name'],
  },
  daily_receipt: {
    requiredColumns: ['receipt_no', 'tour_no', 'purchase_date'],
    dateColumns: ['purchase_date', 'departure_date'],
    uniqueKey: ['receipt_no', 'tour_no', 'name'],
    foreignKeys: {
      tour_no: 'group_code',
    },
  },
  missing_receipt: {
    requiredColumns: ['receipt_no'],
    dateColumns: [],
    uniqueKey: ['receipt_no'],
  },
};

function createImportValidationService({ groupCodeRepo }) {
  /**
   * 校验导入文件
   * @param {Object} params
   * @param {string} params.filePath - Excel 文件路径
   * @param {string} params.importType - 'group_code' | 'store_bill' | 'daily_receipt' | 'missing_receipt'
   * @param {string} params.workspaceKey
   * @returns {Promise<{valid: boolean, errors: Array, warnings: Array, summary: Object}>}
   */
  async function validateImport({ filePath, importType, workspaceKey }) {
    if (!filePath || !importType) {
      throw new Error('filePath and importType required');
    }

    const rules = VALIDATION_RULES[importType];
    if (!rules) {
      throw new Error(`Unknown import type: ${importType}`);
    }

    const errors = [];
    const warnings = [];
    const seenKeys = new Set();
    let totalRows = 0;
    let validRows = 0;
    let errorRows = 0;
    let warningRows = 0;

    // 外键缓存（如 tour_no → group_code）
    const foreignKeyCache = {};
    if (rules.foreignKeys && groupCodeRepo) {
      for (const [fkColumn, fkTable] of Object.entries(rules.foreignKeys)) {
        if (fkTable === 'group_code') {
          const allGroupCodes = groupCodeRepo.list({ workspaceKey, limit: 100000, offset: 0 });
          foreignKeyCache[fkColumn] = new Set(allGroupCodes.map((gc) => normalizeString(gc.tourNo)));
        }
      }
    }

    try {
      await streamRows(filePath, ({ rowNumber, asObject }) => {
        totalRows += 1;
        const row = asObject || {};
        const rowErrors = [];
        const rowWarnings = [];

        // 1. 必填列检查
        for (const col of rules.requiredColumns) {
          if (isEmptyValue(row[col])) {
            rowErrors.push({
              row: rowNumber || totalRows,
              column: col,
              message: `必填字段 ${col} 为空`,
            });
          }
        }

        // 2. 日期格式检查
        for (const col of rules.dateColumns) {
          if (!isEmptyValue(row[col]) && !isValidDate(row[col])) {
            rowErrors.push({
              row: rowNumber || totalRows,
              column: col,
              message: `日期格式无效: ${row[col]}`,
            });
          }
        }

        // 3. 重复数据检查
        const uniqueKey = rules.uniqueKey.map((k) => normalizeString(row[k])).join('|');
        if (uniqueKey && seenKeys.has(uniqueKey)) {
          rowWarnings.push({
            row: rowNumber || totalRows,
            column: rules.uniqueKey.join('+'),
            message: `重复记录: ${uniqueKey}`,
          });
        } else if (uniqueKey) {
          seenKeys.add(uniqueKey);
        }

        // 4. 外键引用检查
        if (rules.foreignKeys) {
          for (const [fkColumn, fkTable] of Object.entries(rules.foreignKeys)) {
            const fkValue = normalizeString(row[fkColumn]);
            if (fkValue && foreignKeyCache[fkColumn] && !foreignKeyCache[fkColumn].has(fkValue)) {
              rowWarnings.push({
                row: rowNumber || totalRows,
                column: fkColumn,
                message: `外键 ${fkColumn}=${fkValue} 在 ${fkTable} 表中不存在`,
              });
            }
          }
        }

        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          errorRows += 1;
        } else if (rowWarnings.length > 0) {
          warnings.push(...rowWarnings);
          warningRows += 1;
        } else {
          validRows += 1;
        }
      });
    } catch (error) {
      errors.push({
        row: 0,
        column: 'file',
        message: `文件读取失败: ${error?.message || String(error)}`,
      });
    }

    const valid = errors.length === 0;
    const summary = {
      totalRows,
      validRows,
      errorRows,
      warningRows,
    };

    return { valid, errors, warnings, summary };
  }

  return { validateImport };
}

function isEmptyValue(val) {
  return val == null || val === '' || (typeof val === 'string' && val.trim() === '');
}

function normalizeString(val) {
  if (val == null) return '';
  return String(val).trim().toLowerCase();
}

function isValidDate(val) {
  if (val instanceof Date) return !Number.isNaN(val.getTime());
  if (typeof val === 'string') {
    const d = new Date(val);
    return !Number.isNaN(d.getTime());
  }
  return false;
}

module.exports = { createImportValidationService };
