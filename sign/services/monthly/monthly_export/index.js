'use strict';

const path = require('node:path');

const { FOLDER, allFolders } = require('../../../lib/monthly_pipeline/mode_folder_classifier');
const { ensureDir } = require('../../../lib/workbench_utils');
const {
  DATA_COLUMNS,
  PENDING_COLUMNS,
  TRACE_COLUMNS,
  buildExportFilename,
} = require('./builders');
const {
  iterateMatchedRowsFor,
  iterateUnmatchedRows,
  iterateUnmatchedRowsFor,
} = require('./aggregators');
const { writeRowsStreaming } = require('./writers');
const { writeCustomerEvidencePackage } = require('./customer_evidence');

function createMonthlyExportService({
  monthlyDataRepo,
  pendingReviewRepo,
  db,
  customerLibraryRepository = null,
  batchRepository = null,
}) {
  if (!monthlyDataRepo || !db) {
    throw new Error('monthly_export_service: missing deps');
  }

  async function run({ workspaceKey, outputDir, operator = '' }) {
    if (!workspaceKey || !outputDir) {
      throw new Error('workspaceKey and outputDir required');
    }
    ensureDir(outputDir);
    const files = [];

    // Per-folder matched data files
    for (const folder of allFolders()) {
      const { rows, count } = iterateMatchedRowsFor(db, workspaceKey, folder);
      if (count === 0) continue;
      const fp = path.join(outputDir, buildExportFilename(workspaceKey, folder, '月度数据'));
      await writeRowsStreaming(fp, '数据', [...DATA_COLUMNS, ...TRACE_COLUMNS], rows, {
        workspaceKey,
        title: `${folder} 月度数据`,
        description: '账单匹配成功并合并后的正式月度数据。',
        operator,
        rowCount: count,
      });
      files.push({ folder, path: fp, rows: count, kind: 'matched' });
    }

    // Unmatched file
    const unmatched = iterateUnmatchedRows(db, workspaceKey);
    if (unmatched.count > 0) {
      const fp = path.join(outputDir, buildExportFilename(workspaceKey, null, '未收小票账单'));
      await writeRowsStreaming(fp, '未收', [...DATA_COLUMNS, ...TRACE_COLUMNS], unmatched.rows, {
        workspaceKey,
        title: '未收小票账单',
        description: '店铺账单有记录，但本月收票台账中没有匹配到对应小票。',
        operator,
        rowCount: unmatched.count,
      });
      files.push({ path: fp, rows: unmatched.count, kind: 'missing' });
    }

    for (const folder of allFolders()) {
      const folderMissing = iterateUnmatchedRowsFor(db, workspaceKey, folder);
      if (folderMissing.count === 0) continue;
      const fp = path.join(outputDir, buildExportFilename(workspaceKey, folder, '未收账单'));
      await writeRowsStreaming(fp, '未收', [...DATA_COLUMNS, ...TRACE_COLUMNS], folderMissing.rows, {
        workspaceKey,
        title: `${folder} 未收账单`,
        description: '该业务分类下，店铺账单有记录但台账未收到的小票。',
        operator,
        rowCount: folderMissing.count,
      });
      files.push({ folder, path: fp, rows: folderMissing.count, kind: 'missing_folder' });
    }

    // Pending review file (if repo injected)
    if (pendingReviewRepo) {
      const pendingCount = countPendingOpen(pendingReviewRepo, workspaceKey);
      if (pendingCount > 0) {
        const fp = path.join(outputDir, buildExportFilename(workspaceKey, null, '人工确认表'));
        const rows = iteratePendingReviewRows({
          pendingReviewRepo,
          workspaceKey,
          totalCount: pendingCount,
        });
        await writeRowsStreaming(fp, '人工确认', PENDING_COLUMNS, rows, {
          workspaceKey,
          title: '人工确认表',
          description: '账单匹配或规则判断无法自动决定，需要人工处理的记录快照。',
          operator,
          rowCount: pendingCount,
        });
        files.push({ path: fp, rows: pendingCount, kind: 'pending' });
      }
    }

    const customerEvidence = customerLibraryRepository
      ? await writeCustomerEvidencePackage({
        db,
        workspaceKey,
        outputDir,
        customerLibraryRepository,
        batchRepository,
      })
      : null;

    return {
      workspaceKey,
      outputDir,
      files,
      customerEvidence,
      producedAt: new Date().toISOString(),
    };
  }

  return { run, DATA_COLUMNS, FOLDER };
}

function countPendingOpen(pendingReviewRepo, workspaceKey) {
  if (typeof pendingReviewRepo.countOpen === 'function') {
    return Number(pendingReviewRepo.countOpen(workspaceKey) || 0);
  }
  return pendingReviewRepo.list({ workspaceKey, status: 'open', limit: 1 }).length > 0 ? 1 : 0;
}

function* iteratePendingReviewRows({
  pendingReviewRepo,
  workspaceKey,
  pageSize = 5000,
  totalCount = null,
}) {
  let offset = 0;
  while (true) {
    const page = pendingReviewRepo.list({
      workspaceKey,
      status: 'open',
      limit: pageSize,
      offset,
    });
    if (!page.length) break;
    for (const p of page) {
      yield {
        id: p.id,
        source_table: p.sourceTable,
        source_id: p.sourceId,
        reason_type: p.reasonType,
        status: p.status,
        created_at: p.createdAt,
        detail: p.detail ? JSON.stringify(p.detail) : null,
      };
    }
    offset += page.length;
    if (Number.isFinite(Number(totalCount))) {
      if (offset >= Number(totalCount)) break;
    } else if (page.length < pageSize) {
      break;
    }
  }
}

module.exports = { createMonthlyExportService, DATA_COLUMNS, PENDING_COLUMNS };
