'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHyundaiDeliveryExportService } = require('../services/hyundai_delivery_export_service');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyundai-exp-'));
  const files = {};
  const mk = (name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, name);
    files[name] = p;
    return name;
  };
  const svc = createHyundaiDeliveryExportService({
    resolveBatchRelativePath: (_batchId, rel) => path.join(dir, rel),
  });
  return { dir, mk, svc, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const task = (over) => ({
  reviewed: true, docTypeFinal: 'receipt',
  receiptStoreFinal: 'HYUNDAI', receiptNoFinal: '05-2607-0001',
  extractedNameFinal: 'ZHANG SAN',
  sourceOriginalPath: 'ws/CL20260705-001/01.jpg', sourceImagePath: '',
  ...over,
});

test('现代交付包计划:三池归位/英文名命名/票号命名带杠/一票多图_2/混店客户护照机票也进包', () => {
  const { mk, svc, cleanup } = makeFixture();
  try {
    const batch = {
      id: 'b1',
      tasks: [
        // 客户A:现代小票x2(同票号,一票多图全交)+ 乐天小票(混店)+ 护照 + 航班截图
        task({ sourceImagePath: mk('a_r1.jpg') }),
        task({ sourceImagePath: mk('a_r2.jpg') }),
        task({ sourceImagePath: mk('a_lotte.jpg'), receiptStoreFinal: 'LOTTE', receiptNoFinal: '12345678901234' }),
        task({ sourceImagePath: mk('a_pp.jpg'), docTypeFinal: 'passport' }),
        task({ sourceImagePath: mk('a_fly.jpg'), docTypeFinal: 'other' }),
        // 客户B:只有乐天小票 → 不进现代包
        task({
          sourceImagePath: mk('b_lotte.jpg'), receiptStoreFinal: 'LOTTE',
          sourceOriginalPath: 'ws/CL20260705-002/01.jpg', extractedNameFinal: 'LI SI',
        }),
        // 客户C:有现代小票但组里有未审任务 → 整组跳过(边界⑤)
        task({ sourceImagePath: mk('c_r.jpg'), sourceOriginalPath: 'ws/CL20260705-003/01.jpg', extractedNameFinal: 'WANG WU' }),
        task({
          sourceImagePath: mk('c_pp.jpg'), docTypeFinal: 'passport', reviewed: false,
          sourceOriginalPath: 'ws/CL20260705-003/02.jpg', extractedNameFinal: 'WANG WU',
        }),
      ],
    };
    const plan = svc.planDelivery(batch);
    assert.equal(plan.customers, 1, '只有客户A整组审完且有现代小票');
    assert.deepEqual(plan.skippedUnreviewed, ['CL20260705-003'], '客户C整组未审完被跳过');
    assert.equal(plan.missingReceiptNo.length, 0);
    // 小票池:2张(同票号一票多图),命名带杠;乐天票不进
    assert.equal(plan.pools.receipt.length, 2);
    assert.ok(plan.pools.receipt.every((e) => e.baseName === '05-2607-0001'));
    // 护照/机票池:英文名命名(混店客户照样进,边界④)
    assert.equal(plan.pools.passport.length, 1);
    assert.equal(plan.pools.passport[0].baseName, 'ZHANG SAN');
    assert.equal(plan.pools.flight.length, 1);
    assert.equal(plan.pools.flight[0].baseName, 'ZHANG SAN');
  } finally {
    cleanup();
  }
});

test('身份收口:免税店小票OCR残串不入选英文名——护照优先;无护照回落customerId(8模块审计HIGH)', () => {
  const { mk, svc, cleanup } = makeFixture();
  try {
    const batch = {
      id: 'b4',
      tasks: [
        // 客户A:小票残串排最前(旧"全组第一个非空"必中招),护照在后 → 必须取护照名
        task({ sourceImagePath: mk('a_r.jpg'), extractedNameFinal: 'CHN-ERIGCHNE' }),
        task({ sourceImagePath: mk('a_pp.jpg'), docTypeFinal: 'passport', extractedNameFinal: 'ZHAO LIU' }),
        // 客户B:只有小票(OCR残串)+航班截图,组里无护照 → 残串仍不入选,回落 customerId
        task({
          sourceImagePath: mk('b_r.jpg'), extractedNameFinal: 'CHNE1234',
          sourceOriginalPath: 'ws/CL20260705-009/01.jpg',
        }),
        task({
          sourceImagePath: mk('b_fly.jpg'), docTypeFinal: 'other', extractedNameFinal: '',
          sourceOriginalPath: 'ws/CL20260705-009/02.jpg',
        }),
      ],
    };
    const plan = svc.planDelivery(batch);
    assert.equal(plan.pools.passport.length, 1);
    assert.equal(plan.pools.passport[0].baseName, 'ZHAO LIU', '护照任务名优先,小票残串不入选');
    const flightNames = plan.pools.flight.map((e) => e.baseName).sort();
    assert.deepEqual(flightNames, ['CL20260705-009'], '无护照组回落customerId,绝不取小票OCR名');
  } finally {
    cleanup();
  }
});

test('缺票号 → exportZip 拒绝并列出问题任务(HYUNDAI_RECEIPT_NO_MISSING)', async () => {
  const { mk, svc, cleanup } = makeFixture();
  try {
    const batch = {
      id: 'b2',
      tasks: [task({ sourceImagePath: mk('r.jpg'), receiptNoFinal: '', receiptNoAuto: '' })],
    };
    await assert.rejects(() => svc.exportZip(batch), (err) => {
      assert.equal(err.code, 'HYUNDAI_RECEIPT_NO_MISSING');
      assert.ok(err.missing.length === 1);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('没有已审完的现代小票 → NO_HYUNDAI_RECEIPTS(带跳过名单)', async () => {
  const { mk, svc, cleanup } = makeFixture();
  try {
    const batch = {
      id: 'b3',
      tasks: [
        task({ sourceImagePath: mk('x.jpg'), reviewed: false }),
      ],
    };
    await assert.rejects(() => svc.exportZip(batch), (err) => {
      assert.equal(err.code, 'NO_HYUNDAI_RECEIPTS');
      assert.deepEqual(err.skippedUnreviewed, ['CL20260705-001']);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('现代交付包:源图磁盘缺失的小票不静默丢,记入 missingSource(交付前可见)', () => {
  const { mk, svc, cleanup } = makeFixture();
  try {
    const batch = {
      id: 'b1',
      tasks: [
        // 客户A:一张现代小票源图在,另一张源图磁盘缺失(ghost 未创建文件),再加护照
        task({ id: 'ok', sourceImagePath: mk('a_ok.jpg'), receiptNoFinal: '05-2607-0001' }),
        task({ id: 'ghost', sourceImagePath: 'a_ghost.jpg', receiptNoFinal: '05-2607-9999' }),
        task({ id: 'pp', sourceImagePath: mk('a_pp.jpg'), docTypeFinal: 'passport' }),
      ],
    };
    const plan = svc.planDelivery(batch);
    assert.equal(plan.pools.receipt.length, 1, '只有源图在的那张进小票池');
    assert.equal(plan.missingReceiptNo.length, 0, '缺的是源图不是票号');
    assert.equal(plan.missingSource.length, 1, '源图缺失的小票记入 missingSource,不再静默丢');
    assert.match(plan.missingSource[0], /ghost/, 'missingSource 含任务定位');
    assert.equal(plan.customers, 1, '客户仍进包(有另一张有效票),但缺图已可见');
  } finally {
    cleanup();
  }
});
