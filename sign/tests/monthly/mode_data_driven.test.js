'use strict';
/**
 * 缺口A+B 行为锁定测试（模式数据驱动 / 明确不参与态）。
 *
 * 缺口A：团号找到就进台账，模式不在 7 枚举内也不丢弃；
 *        映射表里有的非 7 模式 → matched + 桶；没有的 → skipped_mode_not_required(停台账)。
 * 缺口B：listUnmapped 只把"无映射行"的模式算未归类；
 *        显式存 folder=null(不参与) 算已决定，不再算未归类、不卡 merge。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createGroupCodeRepository } = require('../../repositories/group_code_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../../repositories/error_record_repository');
const { createModeFolderMappingRepository } = require('../../repositories/monthly/mode_folder_mapping_repo');
const { createTourMatchService } = require('../../services/monthly/tour_match_service');

const WS = '2026-01';

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `mode-dd-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try { return await fn(db); } finally {
    try { db.close?.(); } catch { /* best effort */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(`${tmp}${s}`, { force: true }); } catch { /* */ } }
  }
}

function seedGroup(groupCodeRepo, mode, tourNo) {
  groupCodeRepo.insertMany([{
    workspaceKey: WS, tourNo, mode, modeNormalized: null, agent: '梓陌',
    applyDate: '2026-01-01', endDate: '2026-01-31', rowHash: 'gc-' + tourNo, importedAt: 't',
  }]);
}
function seedDaily(dailyReceiptRepo, tourNo, modeRaw, rowHash) {
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-' + rowHash, name: 'A', passportNo: 'P-' + rowHash,
    tourNo, agent: '梓陌', modeRaw, shop: '现代免税店', branch: '本店',
    purchaseDate: '2026-01-14', rowHash, importedAt: 't',
  }]);
}

test('缺口A: 非7模式但已映射 → 团号匹配后 matched + 进桶(不丢弃)', async () => {
  await withDb(async (db) => {
    const groupCodeRepo = createGroupCodeRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const modeFolderMappingRepo = createModeFolderMappingRepository({ db });

    // 非 7 枚举的真实模式
    const MODE = '现代76-鲍旭';
    seedGroup(groupCodeRepo, MODE, '76001');
    seedDaily(dailyReceiptRepo, '76001', MODE, 'd-mapped');

    // 操作员把它映射到"乐天首尔"桶（模拟账单管理勾选）
    modeFolderMappingRepo.upsertRows({
      workspaceKey: WS, rows: [{ modeRaw: MODE, modeFolder: '乐天首尔' }], updatedAt: 't',
    });

    const svc = createTourMatchService({
      dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo, modeFolderMappingRepo,
    });
    const result = await svc.run({ workspaceKey: WS });

    assert.equal(result.matched, 1, '映射过的非7模式应 matched');
    assert.equal(result.skippedModeNotRequired, 0, '不应被当作 not_required 丢弃');
    const byMode = dailyReceiptRepo.countByMode(WS);
    assert.equal(byMode[0].folder, '乐天首尔', '应归到映射的桶');
    assert.equal(pendingReviewRepo.countOpen(WS), 0, '不进待补救');
  });
});

test('缺口A: 非7模式且未映射 → 停台账(skipped_mode_not_required), 不进待补救、不报错', async () => {
  await withDb(async (db) => {
    const groupCodeRepo = createGroupCodeRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });
    const modeFolderMappingRepo = createModeFolderMappingRepository({ db });

    const MODE = '新世界SG-荣晨国际';
    seedGroup(groupCodeRepo, MODE, '88001');
    seedDaily(dailyReceiptRepo, '88001', MODE, 'd-parked');

    const svc = createTourMatchService({
      dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo, modeFolderMappingRepo,
    });
    const result = await svc.run({ workspaceKey: WS });

    assert.equal(result.matched, 0, '未映射不算 matched');
    assert.equal(result.skippedModeNotRequired, 1, '应停台账=未选择');
    assert.equal(result.tourNotFound, 0, '团号是找到的,不是 tour_not_found');
    assert.equal(pendingReviewRepo.countOpen(WS), 0, '不进待补救');
    // 行仍在台账（mode_raw 保留），可被后续映射救回
    const used = dailyReceiptRepo.listUsedGroupCodes({ workspaceKey: WS });
    assert.equal(used.length, 1);
    assert.equal(used[0].modeRaw, MODE, '模式原样保留在台账');
  });
});

test('缺口B: 显式"不参与"(folder=null) 算已决定，不再算未归类', async () => {
  await withDb(async (db) => {
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const modeFolderMappingRepo = createModeFolderMappingRepository({ db });

    const MODE_UNDECIDED = '现代-JEOCU';
    const MODE_EXCLUDED = '新世界PKG-宋总';
    seedDaily(dailyReceiptRepo, '90001', MODE_UNDECIDED, 'd-undecided');
    seedDaily(dailyReceiptRepo, '90002', MODE_EXCLUDED, 'd-excluded');

    // 只对 EXCLUDED 存一行 folder=null(不参与)
    modeFolderMappingRepo.upsertRows({
      workspaceKey: WS, rows: [{ modeRaw: MODE_EXCLUDED, modeFolder: null }], updatedAt: 't',
    });

    const unmapped = modeFolderMappingRepo.listUnmapped(WS);
    assert.ok(unmapped.includes(MODE_UNDECIDED), '无映射行的模式 → 未归类(卡merge)');
    assert.ok(!unmapped.includes(MODE_EXCLUDED), '显式不参与 → 已决定,不算未归类');
    assert.equal(unmapped.length, 1);
  });
});
