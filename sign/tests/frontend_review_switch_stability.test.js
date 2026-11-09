'use strict';

// 换票稳定性契约(2026-07-14 视频报障:每张票面板闪一跳,点「匹配」落到「护照」上):
// ①换票自动聚焦不滚动 ②滚回顶部同步执行 ③换票后300ms点击护罩 ④改类型取消回滚一等档意图。
// 这四件拆掉任何一件,移动靶误点就会复发——源码契约锁死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('FieldEditor:换票自动聚焦 scroll:false;focusField 支持关滚动;暴露 resetTypeIntent', () => {
  const source = read('frontend/src/components/FieldEditor.vue');
  assert.match(source, /function focusField\(key, \{ scroll = true \} = \{\}\)/);
  assert.match(source, /focusField\(firstNonGreenKey\.value, \{ scroll: false \}\)/);
  assert.match(source, /if \(scroll\) target\?\.scrollIntoView/);
  assert.match(source, /function resetTypeIntent\(\)/);
  // 复核HIGH:回滚只还原 selectTier1 动过的三样,绝不整体重建 draft(会抹手改未保存字段)
  assert.match(source, /typeIntentBackup/);
  assert.ok(!/REVIEW_FIELD_KEYS\.forEach[\s\S]{0,120}resetTypeIntent|function resetTypeIntent\(\)[\s\S]{0,400}REVIEW_FIELD_KEYS/.test(source), 'resetTypeIntent 不许整体回填 REVIEW_FIELD_KEYS');
  assert.match(source, /defineExpose\(\{\n  resetTypeIntent,/);
});

test('ReviewView:滚回顶部同步(不在 nextTick 里)+ 300ms settling 护罩 + 取消/失败回滚意图', () => {
  const source = read('frontend/src/views/ReviewView.vue');
  // 同步归顶:watch 体内直接 scrollTo,不许包 nextTick(包了=绘制后才滚=肉眼跳一下)
  assert.ok(!/nextTick\(\(\) => \{ fieldScrollRef\.value\?\.scrollTo/.test(source), '滚回顶部退回了 nextTick(会闪)');
  assert.match(source, /fieldScrollRef\.value\?\.scrollTo\?\.\(\{ top: 0 \}\)/);
  // 护罩三件:状态位/300ms/CSS pointer-events
  assert.match(source, /inspectorSettling\.value = true/);
  assert.match(source, /setTimeout\(\(\) => \{ inspectorSettling\.value = false \}, 300\)/);
  assert.match(source, /\.review-inspector\.settling \{ pointer-events: none; \}/);
  assert.match(source, /:class="\{ settling: inspectorSettling \}"/);
  // 改类型确认取消与落盘失败都回滚面板一等档意图
  const cancelBlock = source.split('确定要改吗');
  assert.equal(cancelBlock.length, 2, '改类型确认文案应恰好一处');
  assert.match(source, /resetTypeIntent\?\.\(\)/);
  assert.ok(source.split('resetTypeIntent?.()').length >= 3, '取消与失败两条路径都要回滚');
});
