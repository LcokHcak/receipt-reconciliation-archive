'use strict';
/**
 * 团号多店消歧(2026-07-07,70299 生产病例)行为锁定。
 *
 * 病例:同一个团在新世界、现代各有消费,团号表 70299 两行两模式
 * (新世界SG-振华 不用记 / 现代-JEOCU)。旧行为:唯一约束把新世界行覆盖掉,
 * 新世界小票结算命中"现代-JEOCU"=错桶,且两行记账语义相反(不用记 vs 要记)。
 * 新行为:多行时按小票店家(shop)选行;票店与候选全不符 → tour_store_mismatch 待补救。
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

const WS = '2026-07';

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `tour-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try { return await fn(db); } finally {
    try { db.close?.(); } catch { /* best effort */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(`${tmp}${s}`, { force: true }); } catch { /* */ } }
  }
}

function makeRepos(db) {
  return {
    groupCodeRepo: createGroupCodeRepository({ db }),
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    pendingReviewRepo: createPendingReviewRepository({ db }),
    errorRecordRepo: createErrorRecordRepository({ db }),
    modeFolderMappingRepo: createModeFolderMappingRepository({ db }),
  };
}

function seed70299(groupCodeRepo) {
  groupCodeRepo.insertMany([
    {
      workspaceKey: WS, tourNo: '70299', mode: '新世界SG-振华 不用记', modeNormalized: null,
      agent: '梓陌', applyDate: '2026-07-01', endDate: '2026-07-31', rowHash: 'gc-ss', importedAt: 't',
    },
    {
      workspaceKey: WS, tourNo: '70299', mode: '现代-JEOCU', modeNormalized: null,
      agent: '梓陌', applyDate: '2026-07-01', endDate: '2026-07-31', rowHash: 'gc-hd', importedAt: 't',
    },
  ]);
}

function seedDaily(dailyReceiptRepo, { shop, rowHash }) {
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-' + rowHash, name: 'A', passportNo: 'P-' + rowHash,
    tourNo: '70299', agent: '梓陌', modeRaw: '', shop, branch: '本店',
    purchaseDate: '2026-07-03', rowHash, importedAt: 't',
  }]);
}

test('70299病例:新世界票→振华行(不用记停台账);现代票→JEOCU行(进映射桶);互不串', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seed70299(repos.groupCodeRepo);
    // 现代-JEOCU 已被操作员映射到桶(模拟账单管理勾选)
    repos.modeFolderMappingRepo.upsertRows({
      workspaceKey: WS, rows: [{ modeRaw: '现代-JEOCU', modeFolder: '现代' }], updatedAt: 't',
    });
    seedDaily(repos.dailyReceiptRepo, { shop: 'SHINSEGAE', rowHash: 'd-ss' });
    seedDaily(repos.dailyReceiptRepo, { shop: 'HYUNDAI', rowHash: 'd-hd' });

    const svc = createTourMatchService(repos);
    const result = await svc.run({ workspaceKey: WS });

    const rows = repos.dailyReceiptRepo._listAll({ workspaceKey: WS });
    const ss = rows.find((r) => (r.rowHash ?? r.row_hash) === 'd-ss');
    const hd = rows.find((r) => (r.rowHash ?? r.row_hash) === 'd-hd');

    // 新世界票:选中振华行(不用记→停台账),绝不能命中现代-JEOCU
    const ssMode = String(ss.modeRaw ?? ss.mode_raw ?? '');
    assert.ok(!ssMode.includes('现代-JEOCU'), `新世界票不得命中现代模式,实际:${ssMode}`);
    const ssStatus = String(ss.tourMatchStatus ?? ss.tour_match_status);
    assert.notEqual(ssStatus, 'tour_store_mismatch', '本店行存在,不该报店不符');
    assert.notEqual(ssStatus, 'tour_ambiguous', '店家消歧后单行,不该报歧义');

    // 现代票:命中 JEOCU 行进映射桶
    const hdStatus = String(hd.tourMatchStatus ?? hd.tour_match_status);
    assert.equal(hdStatus, 'matched');
    assert.ok(String(hd.modeRaw ?? hd.mode_raw).includes('现代-JEOCU'));
    assert.equal(result.tourStoreMismatch, 0);
    assert.equal(result.tourAmbiguous, 0);
  });
});

test('70299病例:乐天票+此团号 → tour_store_mismatch 进待补救(不猜桶)', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    seed70299(repos.groupCodeRepo);
    seedDaily(repos.dailyReceiptRepo, { shop: 'LOTTE', rowHash: 'd-lt' });

    const svc = createTourMatchService(repos);
    const result = await svc.run({ workspaceKey: WS });

    assert.equal(result.tourStoreMismatch, 1);
    const rows = repos.dailyReceiptRepo._listAll({ workspaceKey: WS });
    const lt = rows.find((r) => (r.rowHash ?? r.row_hash) === 'd-lt');
    assert.equal(String(lt.tourMatchStatus ?? lt.tour_match_status), 'tour_store_mismatch');
    // 待补救里有记录(reasonType=tour_store_mismatch 已由状态断言+stats 锁定)
    assert.ok(repos.pendingReviewRepo.countOpen(WS) >= 1, '应产生待补救记录');
  });
});

test('单行命中不消歧(既有行为不翻案):现代票+仅新世界单行 → 照旧按该行走', async () => {
  await withDb(async (db) => {
    const repos = makeRepos(db);
    repos.groupCodeRepo.insertMany([{
      workspaceKey: WS, tourNo: '80001', mode: '新世界SG-振华 不用记', modeNormalized: null,
      agent: '梓陌', applyDate: '2026-07-01', endDate: '2026-07-31', rowHash: 'gc-1', importedAt: 't',
    }]);
    repos.dailyReceiptRepo.insertMany([{
      workspaceKey: WS, receiptNo: 'R-x', name: 'A', passportNo: 'P-x',
      tourNo: '80001', agent: '梓陌', modeRaw: '', shop: 'HYUNDAI', branch: '本店',
      purchaseDate: '2026-07-03', rowHash: 'd-x', importedAt: 't',
    }]);
    const svc = createTourMatchService(repos);
    const result = await svc.run({ workspaceKey: WS });
    assert.equal(result.tourStoreMismatch, 0, '单行不触发店不符');
  });
});
