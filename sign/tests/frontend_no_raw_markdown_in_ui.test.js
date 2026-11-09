'use strict';

/**
 * 界面文案里不许写 markdown 的 `**强调**`(2026-08-01)。
 *
 * Vue 模板、HTML 属性、JS 字符串**都不渲染 markdown** ——
 * 写了就会把星号原样显示给用户,像这样:
 *   「登录尝试过多…这段时间里**即使密码正确也会被拦下**,换密码没有用。」
 *   「以上返点合计为**本月全量**(640 行)…」
 *
 * 怎么发现的:出交付报告、给改动点截图时看见的。**光看代码看不出来** ——
 * 星号在源码里是"强调"的意思,在浏览器里是四个字符。
 * 我自己当天写的三处新文案全中,另有一处是更早留下的。
 *
 * 要强调就用 <strong> 标签(模板里)或中文引号「」(属性/JS 字符串里)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');

// 剥掉不会显示给用户的部分:HTML 注释、<style> 段、块注释、行注释
function userVisible(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

function scan(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p, out); continue; }
    if (!/\.(vue|js)$/.test(p)) continue;
    const cleaned = userVisible(fs.readFileSync(p, 'utf8'));
    for (const m of cleaned.matchAll(/\*\*[^*\n<>]{1,40}\*\*/g)) {
      const line = cleaned.slice(0, m.index).split('\n').length;
      out.push(`${path.relative(SRC, p).replace(/\\/g, '/')}:${line}  ${m[0]}`);
    }
  }
  return out;
}

test('⭐界面文案里不许出现裸的 markdown 强调(用户会看到星号)', () => {
  const hits = scan(SRC);
  assert.deepEqual(hits, [],
    '这些文案会把星号原样显示给用户。模板里用 <strong>,属性/JS 字符串里用「」:\n  '
    + hits.join('\n  '));
});

test('自检:剥离逻辑没把整份源码剥空,且注释里的 ** 确实不算', () => {
  // 正:注释里的 ** 不该被算成违规
  assert.equal(userVisible('// 这里**不能**写\nconst a = 1').includes('**'), false);
  assert.equal(userVisible('/* 说明:**必须** */\nconst a = 1').includes('**'), false);
  assert.equal(userVisible('<style>/* **不给底色** */</style><p>x</p>').includes('**'), false);
  // 负:真会显示的必须留下来被抓到
  assert.ok(userVisible('<p>合计为**全量**</p>').includes('**'), '模板正文里的必须保留');
  assert.ok(userVisible("const msg = '这**不等于**没有冲突'").includes('**'), 'JS 字符串里的必须保留');
  // 扫描范围本身别失灵
  const all = scan(SRC, []);
  assert.ok(Array.isArray(all), '扫描要能跑完');
  assert.ok(fs.readdirSync(SRC).length > 3, '源码目录读得到');
});
