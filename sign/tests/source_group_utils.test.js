const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROOT_SOURCE_GROUP_KEY,
  ROOT_SOURCE_GROUP_LABEL,
  buildSourceGroupLabel,
  deriveSourceGroupFolderPath,
  detectImportRootFolder,
  normalizeUploadManifestEntries,
  normalizeUploadRelativePath,
  resolveUploadedRelativePath,
  splitUploadRelativePath,
  upsertSourceGroup,
} = require('../lib/source_group_utils');

test('normalizeUploadRelativePath keeps nested folder structure and drops unsafe segments', () => {
  assert.equal(
    normalizeUploadRelativePath('BIG\\AN YUMENG EQ91\\passport\\a.jpg'),
    'BIG/AN YUMENG EQ91/passport/a.jpg'
  );
  assert.equal(normalizeUploadRelativePath('./A/../B/test.xlsx'), 'A/B/test.xlsx');
});

test('splitUploadRelativePath extracts folder and file name', () => {
  assert.deepEqual(splitUploadRelativePath('BIG/AN YUMENG EQ91/a.jpg'), {
    normalizedPath: 'BIG/AN YUMENG EQ91/a.jpg',
    folderPath: 'BIG/AN YUMENG EQ91',
    fileName: 'a.jpg',
  });
});

test('detectImportRootFolder identifies the outer folder only when there are nested child groups', () => {
  assert.equal(
    detectImportRootFolder([
      'BIG/AN YUMENG EQ91/a.jpg',
      'BIG/BAO HONGMEI/b.jpg',
    ]),
    'BIG'
  );
  assert.equal(
    detectImportRootFolder([
      'AN YUMENG EQ91/a.jpg',
      'AN YUMENG EQ91/b.jpg',
    ]),
    ''
  );
});

test('normalizeUploadManifestEntries accepts JSON strings and normalizes relative paths', () => {
  const result = normalizeUploadManifestEntries(JSON.stringify([
    { relativePath: '222\\AN YUMENG EQ91\\passport\\a.jpg', name: 'a.jpg' },
    { relativePath: '222/AN ZIYANG EG69/b.jpg', fileName: 'b.jpg' },
  ]));

  assert.deepEqual(result, [
    { relativePath: '222/AN YUMENG EQ91/passport/a.jpg', fileName: 'a.jpg' },
    { relativePath: '222/AN ZIYANG EG69/b.jpg', fileName: 'b.jpg' },
  ]);
});

test('resolveUploadedRelativePath prefers manifest entries over browser-trimmed original names', () => {
  const manifest = normalizeUploadManifestEntries([
    { relativePath: '222/AN YUMENG EQ91/passport/a.jpg', fileName: 'a.jpg' },
  ]);

  assert.equal(
    resolveUploadedRelativePath({ originalname: 'a.jpg' }, manifest, 0),
    '222/AN YUMENG EQ91/passport/a.jpg'
  );
  assert.equal(resolveUploadedRelativePath({ originalname: 'a.jpg' }, manifest, 1), 'a.jpg');
});

test('deriveSourceGroupFolderPath keeps the immediate child folder as the source group', () => {
  assert.equal(
    deriveSourceGroupFolderPath('BIG/AN YUMENG EQ91/passport/a.jpg', 'BIG'),
    'AN YUMENG EQ91'
  );
  assert.equal(
    deriveSourceGroupFolderPath('AN YUMENG EQ91/passport/a.jpg', ''),
    'AN YUMENG EQ91'
  );
  assert.equal(deriveSourceGroupFolderPath('a.jpg', ''), '');
});

test('source group label uses final folder segment and falls back to root label', () => {
  assert.equal(buildSourceGroupLabel('BIG/AN YUMENG EQ91'), 'AN YUMENG EQ91');
  assert.equal(buildSourceGroupLabel(''), ROOT_SOURCE_GROUP_LABEL);
});

test('upsertSourceGroup keeps stable group ordering and does not duplicate folders', () => {
  const batch = { sourceGroups: [] };
  const first = upsertSourceGroup(batch, 'AN YUMENG EQ91');
  const second = upsertSourceGroup(batch, 'AN YUMENG EQ91');
  const root = upsertSourceGroup(batch, '');

  assert.equal(batch.sourceGroups.length, 2);
  assert.equal(first.key, second.key);
  assert.equal(root.key, ROOT_SOURCE_GROUP_KEY);
});

// ── 组级结算状态(P2):白名单保留 + 盖章 ──────────────────────────────────
const {
  createSourceGroup: createSG,
  normalizeSourceGroups: normalizeSG,
  stampGroupSettlement,
} = require('../lib/source_group_utils');

test('createSourceGroup/normalize 保留 settledAt+settlementStatus(白名单铁律)', () => {
  const g = createSG({ folderPath: 'CL20260708-001', settledAt: '2026-07-08T00:00:00.000Z', settlementStatus: 'settled' });
  assert.equal(g.settlementStatus, 'settled');
  assert.equal(g.settledAt, '2026-07-08T00:00:00.000Z');
  // 存盘再读(normalize)不得抹掉——owner 隐形 bug 同款回归
  const round = normalizeSG([g]);
  assert.equal(round[0].settlementStatus, 'settled');
  assert.equal(round[0].settledAt, '2026-07-08T00:00:00.000Z');
  // 默认空
  const fresh = createSG({ folderPath: 'CL20260708-002' });
  assert.equal(fresh.settlementStatus, '');
  assert.equal(fresh.settledAt, '');
});

test('stampGroupSettlement 命中组盖章;未命中静默返回 false', () => {
  const batch = { sourceGroups: [createSG({ folderPath: 'CL20260708-003' })] };
  const key = batch.sourceGroups[0].key;
  assert.equal(stampGroupSettlement(batch, key, { settlementStatus: 'needs_confirm' }), true);
  assert.equal(batch.sourceGroups[0].settlementStatus, 'needs_confirm');
  assert.ok(batch.sourceGroups[0].settledAt, '默认盖当前时间戳');
  // 未命中/无 sourceGroups
  assert.equal(stampGroupSettlement(batch, 'group_nonexist', {}), false);
  assert.equal(stampGroupSettlement({}, key, {}), false);
});

// ── 组级团号确认(确认站,2026-07-10):白名单保留 + 盖章 + 修订史 ──────────
const { stampGroupTourConfirm, normalizeTourConfirm } = require('../lib/source_group_utils');

test('createSourceGroup/normalize 保留 tourConfirm(白名单铁律),缺省 null', () => {
  const confirm = {
    status: 'confirmed', tourNo: '71203', mode: '乐天SG-本司', source: 'majority',
    basis: { votes: 5, total: 6 }, confirmedBy: '后勤09', confirmedAt: '2026-07-10T01:00:00.000Z',
  };
  const g = createSG({ folderPath: 'CL20260710-001', tourConfirm: confirm });
  assert.equal(g.tourConfirm.status, 'confirmed');
  assert.equal(g.tourConfirm.tourNo, '71203');
  assert.equal(g.tourConfirm.mode, '乐天SG-本司');
  assert.deepEqual(g.tourConfirm.basis, { votes: 5, total: 6 });
  // 存盘再读不抹(owner 事故同款回归)
  const round = normalizeSG([g]);
  assert.equal(round[0].tourConfirm.tourNo, '71203');
  assert.equal(round[0].tourConfirm.confirmedBy, '后勤09');
  // 无确认 = null,不造空对象
  assert.equal(createSG({ folderPath: 'CL20260710-002' }).tourConfirm, null);
  assert.equal(normalizeTourConfirm('garbage'), null);
});

test('stampGroupTourConfirm 盖章并把旧确认推进 revisions(撤销/更正留痕)', () => {
  const batch = { sourceGroups: [createSG({ folderPath: 'CL20260710-003' })] };
  const key = batch.sourceGroups[0].key;

  assert.equal(stampGroupTourConfirm(batch, key, {
    status: 'confirmed', tourNo: '71203', mode: '乐天SG-本司', source: 'majority', confirmedBy: 'a',
  }), true);
  assert.equal(batch.sourceGroups[0].tourConfirm.tourNo, '71203');
  assert.deepEqual(batch.sourceGroups[0].tourConfirm.revisions, []);

  // 二次盖章(更正):旧确认进修订史
  stampGroupTourConfirm(batch, key, {
    status: 'confirmed', tourNo: '71988', mode: '乐天PKG-新琪', source: 'manual', confirmedBy: 'b',
  });
  const tc = batch.sourceGroups[0].tourConfirm;
  assert.equal(tc.tourNo, '71988');
  assert.equal(tc.revisions.length, 1);
  assert.equal(tc.revisions[0].tourNo, '71203');

  // 未命中组 → false
  assert.equal(stampGroupTourConfirm(batch, 'group_nonexist', { status: 'confirmed' }), false);
});
