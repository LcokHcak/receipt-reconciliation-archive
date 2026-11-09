const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 「这条任务对应的整张原图在盘上哪儿」—— 原来只长在 HTTP handler 里(供图给前端看)。
// P2 引导式补票要在**写路径**上用同一个答案(新任务要指向原图,否则画不了框),
// 所以抽成共用函数。**不复制** —— 两份路径解析迟早漂,而且漂了是静默的:
// 供图那边好好的,补票这边指到别处,谁也不报错。

const { resolveTaskOriginalImagePath } = require('../lib/task_original_image');

const SEP = path.sep;
const IMAGES = path.join('/lib', 'ws1', 'cust7', 'images');
const customerDir = (ws, cid) => path.join('/lib', ws, cid);

function fakeFs(files) {
  return {
    readdirSync: (dir) => {
      if (path.resolve(dir) !== path.resolve(IMAGES)) throw new Error('ENOENT');
      return files;
    },
    existsSync: (p) => files.includes(path.basename(p))
      && path.resolve(p).startsWith(path.resolve(IMAGES) + SEP),
  };
}

test('切片任务 → 回溯到同家族的 _original', () => {
  const fs = fakeFs(['01-abc_receipt_1.jpg', '01-abc_receipt_2.jpg', '01-abc_original.jpg']);
  const r = resolveTaskOriginalImagePath(
    { sourceOriginalPath: 'ws1/cust7/01-abc_receipt_2.jpg' }, customerDir, fs);
  assert.equal(r.error, '');
  assert.equal(path.basename(r.path), '01-abc_original.jpg');
});

test('⭐护照切片也要能回溯 —— 别只认小票', () => {
  // 这一类"只认 receipt"的疏漏在这个仓库里一天之内犯过三次(护照+小票同框)
  const fs = fakeFs(['01-abc_passport_1.jpg', '01-abc_original.jpg']);
  const r = resolveTaskOriginalImagePath(
    { sourceOriginalPath: 'ws1/cust7/01-abc_passport_1.jpg' }, customerDir, fs);
  assert.equal(r.error, '');
  assert.equal(path.basename(r.path), '01-abc_original.jpg');
});

test('没切过的整图 → 就是它自己', () => {
  const fs = fakeFs(['photo.jpg']);
  const r = resolveTaskOriginalImagePath(
    { sourceOriginalPath: 'ws1/cust7/photo.jpg' }, customerDir, fs);
  assert.equal(r.error, '');
  assert.equal(path.basename(r.path), 'photo.jpg');
});

test('原图被清理掉了 → 给人话理由,不给半个路径', () => {
  const fs = fakeFs(['01-abc_receipt_1.jpg']); // _original 没了
  const r = resolveTaskOriginalImagePath(
    { sourceOriginalPath: 'ws1/cust7/01-abc_receipt_1.jpg' }, customerDir, fs);
  // 回溯不到就退回切片自身;切片自身在 → 认它。这里切片在,所以应成功但**不是** original
  assert.equal(r.error, '');
  assert.equal(path.basename(r.path), '01-abc_receipt_1.jpg');
  assert.equal(r.isOriginal, false, '要如实说明这不是整张原图');
});

test('连切片都没了 → 报错', () => {
  const fs = fakeFs([]);
  const r = resolveTaskOriginalImagePath(
    { sourceOriginalPath: 'ws1/cust7/01-abc_receipt_1.jpg' }, customerDir, fs);
  assert.equal(r.path, '');
  assert.ok(r.error.includes('原图'), `理由要是人话:${r.error}`);
});

test('没有客户库引用 → 报错(不是所有任务都来自客户库)', () => {
  const fs = fakeFs(['x.jpg']);
  for (const src of ['', 'ws1/cust7', 'a/b/c/d']) {
    const r = resolveTaskOriginalImagePath({ sourceOriginalPath: src }, customerDir, fs);
    assert.equal(r.path, '', `${JSON.stringify(src)} 不该解析出路径`);
    assert.ok(r.error);
  }
});

test('⭐路径逃逸一律拒 —— 这个值最终会被 sendFile / 拷贝使用', () => {
  const fs = fakeFs(['x.jpg']);
  const bad = [
    'ws1/cust7/../../../etc/passwd',
    '../ws1/cust7/x.jpg',
    'ws1/cust7/sub/x.jpg',
    'ws1/cust7/..',
    'ws1/cust7/a\\b.jpg',
  ];
  for (const src of bad) {
    const r = resolveTaskOriginalImagePath({ sourceOriginalPath: src }, customerDir, fs);
    assert.equal(r.path, '', `逃逸没拦住: ${src}`);
  }
});

test('⭐handler 必须用这个共用函数,不许自己再写一遍', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '../services/handlers/workbench/task_handlers.js'), 'utf8');
  assert.ok(src.includes('resolveTaskOriginalImagePath'), 'handler 没接共用函数');
  // 原来那段回溯正则不该再出现在 handler 里(留着就是第二份真相)
  assert.ok(!src.includes('_original.`'), 'handler 里还留着自己的回溯实现');
});
