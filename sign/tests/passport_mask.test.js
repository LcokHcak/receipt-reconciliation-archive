'use strict';

// 护照区打码(0727反馈#13-3)单元:涂黑区域真黑、小票区真没动、
// bbox 不可信/图坏时明确拒绝(调用方回退原样复制并留痕,绝不静默错遮)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');

const { maskPassportRegion, plausibleBbox } = require('../lib/passport_mask');

test('plausibleBbox:面积 3%~75% 的归一化框才可信;越界/倒置/巨幅全拒', () => {
  assert.equal(plausibleBbox([0.5, 0, 1, 1]), true);          // 右半 50%
  assert.equal(plausibleBbox([0, 0, 1, 1]), false);           // 全图 100%:错遮=盖掉小票
  assert.equal(plausibleBbox([0.9, 0.9, 0.95, 0.95]), false); // 0.25%:太小不像护照
  assert.equal(plausibleBbox([0.8, 0, 0.2, 1]), false);       // x2<x1 倒置
  assert.equal(plausibleBbox([0, 0, 1.2, 0.5]), false);       // 越界
  assert.equal(plausibleBbox(null), false);
  assert.equal(plausibleBbox([0.1, 0.1]), false);
});

test('maskPassportRegion:护照区变黑、小票区原样;输出可解码', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-mask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'combined.jpg');
  const dest = path.join(dir, 'masked.jpg');
  // 纯白 1600x1200 同框图,右半当护照区
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 250, g: 250, b: 250 } } })
    .jpeg({ quality: 92 }).toFile(src);

  const res = await maskPassportRegion({ sourcePath: src, destPath: dest, bbox: [0.5, 0, 1, 1] });
  assert.equal(res.masked, true);

  const { data, info } = await sharp(dest).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // 右侧中心(护照区)≈ 黑;左侧中心(小票区)≈ 白
  const [pr] = px(Math.round(info.width * 0.75), Math.round(info.height * 0.5));
  const [pl] = px(Math.round(info.width * 0.25), Math.round(info.height * 0.5));
  assert.ok(pr < 40, `护照区应涂黑(实测 ${pr})`);
  assert.ok(pl > 200, `小票区不得被波及(实测 ${pl})`);
});

test('拒绝路径:bbox 不可信 → masked:false 且不产出文件;图坏 → sharp_failed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-mask-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'x.jpg');
  fs.writeFileSync(src, 'not a jpeg');
  const dest = path.join(dir, 'out.jpg');

  const bad = await maskPassportRegion({ sourcePath: src, destPath: dest, bbox: [0, 0, 1, 1] });
  assert.equal(bad.masked, false);
  assert.equal(bad.reason, 'bbox_implausible');
  assert.ok(!fs.existsSync(dest), '拒绝时不得产出半成品');

  const broken = await maskPassportRegion({ sourcePath: src, destPath: dest, bbox: [0.5, 0, 1, 1] });
  assert.equal(broken.masked, false);
  assert.match(String(broken.reason), /^sharp_failed:/);
});
