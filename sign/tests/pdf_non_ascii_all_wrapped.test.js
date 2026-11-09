'use strict';

/**
 * 客户 PDF 里的非 ASCII 文本必须全部经过 label()/txt() 包装(2026-08-01)。
 *
 * 背景:这份 PDF 有两条渲染路径,由「机器上有没有 CJK 字体」决定:
 *   有字体 → useCjk=true  → label(zh,en) 出中韩文
 *   没字体 → useCjk=false → label 出英文、txt 走 safePdfText 把非 ASCII 换成 '?'
 *
 * 问题在于这两条路**各跑各的、从不交叉**:
 *   - 本机 Windows:8 个字体候选里 C:/Windows/Fonts 那三个必命中 → 永远走中文路径;
 *   - Linux / CI:仓库里**一个字体文件都没有**(git ls-files 查 ttf/otf/ttc = 0),
 *     assets/fonts/* 目录不存在、vendor 那份被 .gitignore 忽略、/opt/sign-data/fonts
 *     是服务器专有 → 永远走降级路径。
 * 于是任何"漏在包装外面"的非 ASCII 字符,在本机看永远是好的,只在 Linux 上坏。
 *
 * 实际抓到的:第 1 页标题 `${yy}.${mm}월 ${label('수수료 수령증','Fee Receipt')}` ——
 * 「월」在 label() 外面。降级时整行别的字都变英文了,只剩这一个韩文字符被丢给
 * pdfkit 默认的 Helvetica(WinAnsi),渲染成 .notdef。
 *
 * 这条闸扫源码而不是跑 PDF,是因为跑不出来:本机造不出"没有字体"的环境
 * (候选里有系统字体),而真去删系统字体显然不合适。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = path.join(
  __dirname, '..', 'services', 'monthly', 'final_delivery_export_service.js',
);

// 取出 buildCustomerPdf 里所有 doc.text(...) / cell(...) 的**第一个参数**片段,
// 找里面裸露的非 ASCII(不在 label( / txt( 的调用里)。
function findUnwrappedNonAscii(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  const hits = [];
  // 只看模板字符串:裸中韩文最容易藏在 `${...}文字${...}` 的字面段里
  for (const m of code.matchAll(/`([^`]*)`/g)) {
    const literal = m[1];
    // 去掉 ${...} 插值,只留字面部分
    const literalOnly = literal.replace(/\$\{[^}]*\}/g, '');
    if (!/[\u3000-\u9fff\uac00-\ud7af]/.test(literalOnly)) continue;
    // 这个模板串整体是不是被 label()/txt() 包着?粗略看它前面 12 个字符
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/(label|txt|logger|event|Error|require|join|resolve)\s*\(\s*$/.test(before)) continue;
    hits.push(literalOnly.trim());
  }
  return hits;
}

test('⭐PDF 模板串里不许有裸露的中韩文(降级路径下会渲染成乱码)', () => {
  const src = fs.readFileSync(SERVICE, 'utf8');
  // 只查 buildCustomerPdf 那一段;文件其余部分(日志/错误话术)不进 PDF
  const start = src.indexOf('const label = (zh, en)');
  assert.ok(start > 0, '找不到 label 定义,这条闸的取段方式失效了');
  const end = src.indexOf('\nfunction ', start);
  const section = src.slice(start, end > start ? end : src.length);

  const hits = findUnwrappedNonAscii(section);
  assert.deepEqual(hits, [],
    '这些中韩文没经过 label()/txt(),没有 CJK 字体时会变成 .notdef:\n  '
    + hits.map((h) => JSON.stringify(h)).join('\n  '));
});

test('自检:探针确实能抓到裸露的韩文(否则上一条是假绿)', () => {
  const bad = 'const label=(zh,en)=>0;\ndoc.text(`${yy}.${mm}월 ${label(\'가\',\'a\')}`);';
  assert.deepEqual(findUnwrappedNonAscii(bad), ['.월'], '裸「월」必须被抓到');
  const good = 'const label=(zh,en)=>0;\ndoc.text(`${yy}.${mm}${label(\'월\',\'/\')}`);';
  assert.deepEqual(findUnwrappedNonAscii(good), [], '包进 label() 的不该误报');
});

test('仓库里确实没有 CJK 字体——所以降级路径在 Linux 上是常态,不是边缘情况', () => {
  const root = path.join(__dirname, '..');
  // 只查代码库自带的 assets(vendor / node_modules 不算,它们不随部署走)
  const assetsFonts = path.join(root, 'assets', 'fonts');
  assert.ok(!fs.existsSync(assetsFonts),
    'assets/fonts 出现了 —— 如果是特意加的字体,请把这条断言改掉并说明部署怎么带上它');
});
