'use strict';

// P3c 复核 CRITICAL 回归(真执行,非字符串契约):一键保存的快照必须在循环前定格——
// 病根=第一家保存后的刷新会把第二家未提交草稿冲回旧值(静默 no-op 还打✓)。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  return import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'configConsoleSaveAll.js')));
}

test('快照定格:计划后再改/清 storeDraft,快照里的 fields 纹丝不动(CRITICAL 病根锁死)', async () => {
  const { planStoreSaveSnapshots } = await loadModule();
  const storeDraft = {
    LOTTE_DEPT: new Set(['passportNo', 'receiptNo', 'brand']),
    HYUNDAI_DEPT: new Set(['receiptNo', 'receiptAmount', 'purchaseDate']),
  };
  const storeProfiles = [
    { family: 'LOTTE_DEPT', label: '乐天百货', config: { version: 3 } },
    { family: 'HYUNDAI_DEPT', label: '现代百货', config: null },
  ];
  const snapshots = planStoreSaveSnapshots(['LOTTE_DEPT', 'HYUNDAI_DEPT'], storeDraft, storeProfiles);

  // 模拟"第一家保存后的 loadReviewConfigData 整体重建 storeDraft"(把第二家冲回旧值)
  storeDraft.HYUNDAI_DEPT = new Set(['passportNo', 'extractedName', 'receiptNo', 'receiptAmount', 'upstream', 'purchaseDate']);
  storeDraft.LOTTE_DEPT.clear();

  assert.deepEqual(snapshots[0], { family: 'LOTTE_DEPT', label: '乐天百货', fields: ['passportNo', 'receiptNo', 'brand'], expectBaseVersion: 3 });
  assert.deepEqual(snapshots[1].fields, ['receiptNo', 'receiptAmount', 'purchaseDate'], '第二家快照必须是计划时刻的草稿,不受刷新影响');
  assert.equal(snapshots[1].expectBaseVersion, 0, '无自定义配置=乐观锁基于出厂 0');
});

test('边界:未知家/空草稿不炸,fields 空数组;label 回落 family', async () => {
  const { planStoreSaveSnapshots } = await loadModule();
  const snapshots = planStoreSaveSnapshots(['GHOST_DEPT'], {}, []);
  assert.deepEqual(snapshots, [{ family: 'GHOST_DEPT', label: 'GHOST_DEPT', fields: [], expectBaseVersion: 0 }]);
  assert.deepEqual(planStoreSaveSnapshots(null, null, null), []);
});
