'use strict';

/**
 * manual_entry_service — 手动无图录入 (Sprint E E0a)
 *
 * POST /api/monthly/workspaces/:workspaceKey/manual-entries
 *
 * 跳过 OCR，直接写入 daily_receipt_export（source_type='manual',
 * ledger_status='posted'），并通过 workspace_resolver 支持跨月落账。
 */

const crypto = require('node:crypto');
const workspaceResolver = require('../../lib/monthly/workspace_resolver');
const { computeDailyRowHash } = require('../../lib/monthly/daily_row_hash');

function createManualEntryService({
  db,
  workspaceService,
  dailyReceiptRepo,
  resolver = workspaceResolver,
  _computeHash = computeDailyRowHash,  // injectable for testing
}) {
  if (!db) throw new Error('manual_entry_service: db is required');
  if (!workspaceService) throw new Error('manual_entry_service: workspaceService is required');
  if (!dailyReceiptRepo) throw new Error('manual_entry_service: dailyReceiptRepo is required');

  const findByHashStmt = db.prepare(
    'SELECT id FROM daily_receipt_export WHERE row_hash = ? LIMIT 1'
  );

  function createEntry({
    workspaceKey,
    mode,
    customerNo,
    customerName,
    passportNo = null,
    purchaseDate,
    grossKrw,
    deductKrw = 0,
    exchangeRate,
    remark = null,
    operator = 'system',
  }) {
    // ── 1. 必填字段校验 ──────────────────────────────────────────────
    const errors = [];
    if (!mode) errors.push('mode is required');
    if (!customerNo) errors.push('customerNo is required');
    if (!customerName) errors.push('customerName is required');
    if (!purchaseDate) errors.push('purchaseDate is required');
    if (grossKrw == null) errors.push('grossKrw is required');
    if (errors.length > 0) {
      const err = new Error(`validation_failed: ${errors.join('; ')}`);
      err.code = 'validation_failed';
      err.statusCode = 400;
      err.errors = errors;
      throw err;
    }

    // ── 2. 汇率校验 ──────────────────────────────────────────────────
    const rate = Number(exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      const err = new Error('exchange_rate_missing: exchangeRate must be a positive number');
      err.code = 'exchange_rate_missing';
      err.statusCode = 422;
      throw err;
    }

    // ── 3. 跨月工作区解析 ────────────────────────────────────────────
    const resolved = resolver.resolveWorkspaceForPurchaseDate({
      purchaseDate,
      currentWorkspaceKey: workspaceKey,
    });
    const actualWorkspaceKey = resolved.targetWorkspaceKey;

    // ── 4. 工作区锁定检查（不存在时自动 open）────────────────────────
    let workspace;
    try {
      workspace = workspaceService.getOrThrow(actualWorkspaceKey);
    } catch {
      workspace = workspaceService.open({ workspaceKey: actualWorkspaceKey, operator });
    }
    if (workspace.status === 'locked' || workspace.lockedAt) {
      const err = new Error('月份已锁定，不能继续写入');
      err.code = 'WORKSPACE_LOCKED';
      err.statusCode = 423;
      throw err;
    }

    // ── 5. 计算金额 ──────────────────────────────────────────────────
    const grossKrwNum = Number(grossKrw);
    const deductKrwNum = Number(deductKrw) || 0;
    const netKrw = Math.round(grossKrwNum - deductKrwNum);
    const netUsd = Math.round((netKrw / rate) * 100) / 100;
    const dcKrw = deductKrwNum;
    const dcUsd = Math.round((grossKrwNum / rate - netUsd) * 100) / 100;

    // ── 6. 生成唯一 receiptNo + row_hash ─────────────────────────────
    const receiptNo = `MAN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const rowHash = _computeHash({
      workspaceKey: actualWorkspaceKey,
      receiptNo,
      purchaseDate: resolved.purchaseDate,
      shop: null,
    });

    // ── 7. 碰撞检测 ──────────────────────────────────────────────────
    const collision = findByHashStmt.get(rowHash);
    if (collision) {
      const err = new Error('target_row_hash_collision');
      err.code = 'target_row_hash_collision';
      err.statusCode = 409;
      throw err;
    }

    // ── 8. 写入 ──────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const row = {
      workspaceKey: actualWorkspaceKey,
      modeRaw: mode,
      name: customerName,
      passportNo: passportNo || null,
      purchaseDate: resolved.purchaseDate,
      receiptNo,
      refNo: customerNo,
      grossKrw: grossKrwNum,
      netKrw,
      netUsd,
      dcKrw,
      dcUsd,
      remark: remark || null,
      rowHash,
      importedAt: now,
      sourceType: 'manual',
      ledgerStatus: 'posted',
      postedAt: now,
      postedBy: operator,
      modifiedBy: operator,
    };

    dailyReceiptRepo.insertMany([row]);

    // 查回插入 id（hash 唯一）
    const inserted = findByHashStmt.get(rowHash);
    const id = inserted ? Number(inserted.id) : null;

    return {
      id,
      workspaceKey,
      actualWorkspaceKey,
      rowHash,
      ledgerStatus: 'posted',
      sourceType: 'manual',
    };
  }

  return { createEntry };
}

module.exports = { createManualEntryService };
