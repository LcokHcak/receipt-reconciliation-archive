'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { mapGroupCodeRow } = require('../lib/monthly_pipeline/group_code_mapper');
const { streamRows } = require('../lib/monthly_pipeline/xlsx_reader');
const { extractMultisheetGroupCode, isMultisheetWorkbook } = require('../lib/monthly_pipeline/group_code_multisheet');

function createBatchGroupCodeImportService({
  batchGroupCodeRepo,
  logger = console,
}) {
  if (!batchGroupCodeRepo) throw new Error('batchGroupCodeRepo required');

  async function importFile({
    batchId,
    sourceWorkspaceKey,
    filePath,
    sourceFileName = null,
    operator = null,
    mode = 'replace',
  }) {
    if (!batchId) throw new Error('batchId required');
    if (!filePath || !fs.existsSync(filePath)) throw new Error('group code file not found');

    const importedAt = new Date().toISOString();
    const sourceFile = sourceFileName || path.basename(filePath);

    // 多-sheet 新格式(2/3 月起):一次 readFile 判格式 + 抽团号(显式列,模式/代理留空,
    // 模式由收票的 店铺·分店·返点模式 组合 + 操作员归桶决定)。老单表格式走下面 streamRows。
    const ms = await extractMultisheetGroupCode({ filePath, workspaceKey: sourceWorkspaceKey, importedAt });
    if (isMultisheetWorkbook(ms.sheetNames) && ms.rows.length) {
      const batchRows = ms.rows.map((r) => ({
        ...r, batchId, sourceWorkspaceKey, sourceFile, sourceSheet: 'multisheet', sourceRow: null,
        rawPayload: null, importedBy: operator,
      }));
      const result = mode === 'replace'
        ? batchGroupCodeRepo.replaceBatch({ batchId, rows: batchRows })
        : batchGroupCodeRepo.insertMany(batchRows);
      logger?.log?.(`[batch_group_code] batch=${batchId} multisheet inserted=${result.inserted || 0}`);
      return {
        batchId, sourceWorkspaceKey, sourceFile, importedAt, multisheet: true,
        rowsTotal: ms.rows.length, rowsInserted: Number(result.inserted || 0), rowsSkipped: 0,
        sheets: ms.sheetNames.map((name) => ({ name })),
      };
    }

    let rowsTotal = 0;
    let rowsInserted = 0;
    let rowsSkipped = 0;
    const batch = [];
    const replaceRows = [];

    async function flush() {
      if (batch.length === 0) return;
      if (mode === 'replace') {
        replaceRows.push(...batch.splice(0, batch.length));
        return;
      }
      const result = batchGroupCodeRepo.insertMany(batch.splice(0, batch.length));
      rowsInserted += Number(result.inserted || 0);
      rowsSkipped += Number(result.skipped || 0);
    }

    const sheetSummary = await streamRows(
      filePath,
      async ({ sheetName, rowNumber, asObject, values, headers }) => {
        rowsTotal += 1;
        const mapped = mapGroupCodeRow({
          asObject,
          rawValues: values,
          headers,
          workspaceKey: sourceWorkspaceKey,
          sheetName,
          sourceFile,
          sourceRow: rowNumber,
          importedAt,
          importJobId: null,
        });
        if (!mapped) {
          rowsSkipped += 1;
          return;
        }
        batch.push({
          ...mapped,
          batchId,
          sourceWorkspaceKey,
          sourceFile,
          sourceSheet: sheetName,
          sourceRow: rowNumber,
          rawPayload: asObject,
          importedBy: operator,
        });
        if (batch.length >= 1000) await flush();
      },
      { sheetFilter: () => true }
    );
    await flush();
    if (mode === 'replace') {
      const result = batchGroupCodeRepo.replaceBatch({ batchId, rows: replaceRows });
      rowsInserted += Number(result.inserted || 0);
      rowsSkipped += Number(result.skipped || 0);
    }
    logger?.log?.(`[batch_group_code] batch=${batchId} inserted=${rowsInserted} skipped=${rowsSkipped}`);
    return {
      batchId,
      sourceWorkspaceKey,
      sourceFile,
      importedAt,
      rowsTotal,
      rowsInserted,
      rowsSkipped,
      sheets: sheetSummary.sheets || [],
    };
  }

  return { importFile };
}

module.exports = { createBatchGroupCodeImportService };
