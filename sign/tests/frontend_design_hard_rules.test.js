const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');

/**
 * 0728 设计对齐硬规则里最容易反复的一条:**绿色整套删掉**。
 *
 * 语义收敛后全站只剩三种颜色语义:
 *   蓝   = 仅「可点击」
 *   红橙 = 「要处理」
 *   灰阶 = 其余(含"已通过/已结算/成功/一眼过"这些**正常态**)
 * 绿色的问题正在于它天然表达"成功",会把不需要人管的东西喊得和待办一样响。
 *
 * 为什么必须做成扫描而不是逐条断言:0728 手工清过一轮之后,0729 又在
 * 三个地方翻出漏网的绿(档位圆点 / 导出成功框 / 全通过横幅)——按颜色清单
 * grep 会漏掉没进清单的色值,靠截图看更会漏掉不常出现的状态。这里按**色相**判定,
 * 任何新写进来的绿都会被抓住,不管它是哪个具体色号。
 */
/**
 * 关于紫(0731 拍板:**刻意保留,不是漏网**)。
 *
 * 三色语义之外全站还有一个紫:资料库「配置台计划」标签 #3c3489、
 * status-badge 的 test 档。它标的**不是状态**,而是「这行东西的出处」——
 * 非生产数据 / 非本系统来源。跟蓝红灰三条语义不在同一个维度上,所以不冲突。
 *
 * 写在这儿是因为:下一个来扫配色的人(包括我自己)会把它当成漏网去收。
 * 收了之后 demo 数据和真实数据就一眼分不出来了 —— 那是比"多一个色相"更贵的代价。
 */
function hexToHsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (mx === r) hue = 60 * ((((g - b) / d) % 6) + 6) % 360;
    else if (mx === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  return { h: hue, s, l };
}

// 绿的判定区间:色相 85°(黄绿)~175°(青绿)。
// 下界避开琥珀/黄(<85°,「要处理」要留),上界避开青蓝(>175°,「可点击」的蓝要留)。
// 再要求有实际饱和度、且不是接近纯黑/纯白的噪声。
function isGreen({ h, s, l }) {
  return h >= 85 && h <= 175 && s > 0.15 && l > 0.08 && l < 0.98;
}

// 注释里写「原绿 #147a4b」是**有用的历史说明**(告诉后人这里改过什么、别改回去),
// 不该被自己的护栏判违规——否则会逼着后人把交代删掉。只看代码位置上的颜色。
function strippedOfComments(line) {
  const cut = [line.indexOf('//'), line.indexOf('/*'), line.indexOf('<!--')]
    .filter((i) => i >= 0);
  return cut.length ? line.slice(0, Math.min(...cut)) : line;
}

// 一行里所有"能表达颜色"的写法 → 统一成 {text, hsl}。
// 0731 补洞的核心:原扫描只认 #xxxxxx,于是 rgb()/命名色是免检的。
// 硬规则只对一种写法生效 = 换个写法就绕开,和同日发现的 b/strong 是同一类漏洞。
const NAMED_COLORS = Object.freeze({
  green: '#008000', lime: '#00ff00', olive: '#808000', teal: '#008080',
  seagreen: '#2e8b57', forestgreen: '#228b22', mediumseagreen: '#3cb371',
  springgreen: '#00ff7f', lightgreen: '#90ee90', darkgreen: '#006400',
  limegreen: '#32cd32', yellowgreen: '#9acd32', darkseagreen: '#8fbc8f',
  palegreen: '#98fb98', greenyellow: '#adff2f', chartreuse: '#7fff00',
  aquamarine: '#7fffd4', mediumspringgreen: '#00fa9a', darkolivegreen: '#556b2f',
});
// 注意:这张表只负责 名字→hex,**判不判绿由 isGreen 的色相带说了算**。
// 所以表里有几个名字天生落在带外、写了也不会被拦,这是设计而非漏网:
//   teal #008080 = 180°(青,归「可点击」那侧) / olive #808000 = 60°(琥珀,归「要处理」)
//   darkolivegreen = 82°、greenyellow = 84°,压着 85° 下界外侧。
// 想连这些一起管,那是把规则从「删绿」扩成「只准三色」——是另一条规则,不在这里偷偷加。

function colorTokens(line) {
  const out = [];
  for (const m of line.matchAll(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g)) {
    out.push({ text: m[0], hsl: hexToHsl(m[0]) });
  }
  // rgb()/rgba():只取纯数字三元组,带 var() 的算不出来也就无从判绿,跳过
  for (const m of line.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)/g)) {
    const hex = '#' + [m[1], m[2], m[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
    out.push({ text: m[0], hsl: hexToHsl(hex) });
  }
  // 命名色:只认**值位置**。两侧都要卡:
  //   前面必须是 : 或空格或( —— 否则 'sig-green' 这种连字符类名会中招;
  //   后面不能是 :   —— 否则 `green: { label: '通过' }` 这种**键名**会中招。
  //   (fieldSignal.js 的档位就叫 green,而 .sig-green 实渲染是 #475569 灰阶,
  //    名字带绿≠颜色是绿。第一版没卡后半边,正是被它假红了一次。)
  for (const m of line.matchAll(/(?:^|[:\s(])([a-z]{3,20})\b(?!\s*:)/gi)) {
    const hex = NAMED_COLORS[m[1].toLowerCase()];
    if (hex) out.push({ text: m[1], hsl: hexToHsl(hex) });
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(vue|js|css)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

test('硬规则「绿色整套删掉」:全站源码不得再出现绿色系色值', () => {
  // tailwind.config.js 必须一起扫:0731 在里面翻出 success: '#10b981'。
  // 它不在 src/ 下,于是 0728 那轮清绿完全没照到 —— 而在那儿改一个字,
  // 一句 text-success 就能把绿放回全站。调色板配置是**颜色的源头**,不是外围文件。
  const files = [...walk(SRC), path.join(SRC, '..', 'tailwind.config.js')].filter((p) => fs.existsSync(p));
  assert.ok(files.length > 100, `应扫到全部前端源码,实际只有 ${files.length} 个文件`);

  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = strippedOfComments(raw);
      // 0731 补洞:原来只认 #xxxxxx。`rgb()/rgba()` 和 `green/lime/teal` 这类命名色
      // 从旁边大摇大摆走过去 —— 和同日发现的 b/strong 是同一类漏洞:
      // 规则对**一种写法**生效,换个写法就绕开了。今天扫全站+六个渲染页都是 0 处绿,
      // 所以这不是修违规,是**堵住下次**。
      for (const m of colorTokens(line)) {
        const hsl = m.hsl;
        if (!isGreen(hsl)) continue;
        hits.push(
          `${path.relative(SRC, file)}:${i + 1}  ${m.text}  `
          + `(hue ${hsl.h.toFixed(0)}° sat ${hsl.s.toFixed(2)})  ${raw.trim().slice(0, 80)}`,
        );
      }
    });
  }

  assert.deepEqual(hits, [], `发现绿色残留 ${hits.length} 处,按硬规则应改灰阶(正常态)`
    + `或琥珀/红(要处理):\n  ${hits.join('\n  ')}`);
});

// ── 扫构建产物:源码扫描天生看不见的那一类绿 ────────────────────────────
// 0731 实测抓到 `.bg-emerald-500{...rgb(16 185 129...)}` 在**已服务的产物**里。
// 源码里它长什么样?`ok: 'bg-emerald-500'` —— 一个**类名**。颜色不在源码里,
// 在 Tailwind 的调色板里,源码只写了个引用。上面那条按色值扫,再严也扫不到。
//
// 产物扫描是唯一能同时覆盖三种写法的口子:色值、类名、调色板配置,
// 到了 CSS 产物里全都变回色值。所以这条不是重复,是**另一个观察点**。
const DIST = path.join(
  __dirname, '..', 'passport_review_workbench', 'app', 'dist', 'assets',
);

test('硬规则「绿色整套删掉」:已构建的 CSS 产物里也不得有绿(覆盖 Tailwind 类名/调色板)', (t) => {
  if (!fs.existsSync(DIST)) {
    // 没构建就跳过,但要**响亮地**跳:静默跳过和假绿是一回事。
    t.skip(`未找到构建产物 ${path.relative(process.cwd(), DIST)},先 npm run build 再跑这条`);
    return;
  }
  const cssFiles = fs.readdirSync(DIST).filter((n) => n.endsWith('.css'));
  assert.ok(cssFiles.length > 0, `${DIST} 下没有 CSS 产物,构建可能失败了`);

  const hits = [];
  for (const name of cssFiles) {
    const css = fs.readFileSync(path.join(DIST, name), 'utf8');
    // 产物是压缩过的、且 Tailwind 出的是 `rgb(16 185 129/var(...))` 这种**空格分隔**写法,
    // 逗号版正则在这儿一个都抓不到 —— 0731 我用 grep 找 10b981 报 0,就是栽在这。
    for (const m of css.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const hsl = hexToHsl(m[0]);
      if (isGreen(hsl)) hits.push(`${name}  ${m[0]}  (hue ${hsl.h.toFixed(0)}°)`);
    }
    for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g)) {
      const hex = '#' + [m[1], m[2], m[3]]
        .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
      const hsl = hexToHsl(hex);
      if (isGreen(hsl)) hits.push(`${name}  ${m[0]})  (hue ${hsl.h.toFixed(0)}°)`);
    }
  }
  assert.deepEqual(hits, [], `构建产物里还有绿 ${hits.length} 处(源码扫描看不见这类):\n  ${hits.join('\n  ')}`);
});

test('硬规则:--success 语义变量本身是灰阶(它被十几处复用,是绿删的总闸)', () => {
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  const m = css.match(/--success:\s*(#[0-9a-fA-F]{3,6})/);
  assert.ok(m, 'style.css 必须定义 --success');
  const hsl = hexToHsl(m[1]);
  assert.ok(!isGreen(hsl), `--success 仍是绿色 ${m[1]}(hue ${hsl.h.toFixed(0)}°)`);
  assert.ok(hsl.s < 0.25, `--success 应是低饱和灰阶,实际饱和度 ${hsl.s.toFixed(2)}`);
});

// ── 设计令牌不许被"同名不同类"覆盖 ────────────────────────────────────────
// 0731 实机撞到的::root 上 `--accent: #1863c6` 是**颜色**,而 `.v2-layout`
// 把同名令牌重定义成 shadcn 的 HSL 三元组 `243 75% 95%` —— 那不是合法颜色值。
// 后果:任何老组件在 v2 页面里写 `color: var(--accent)`,var() 解析失败、
// 静默回退到 currentColor。同一个组件在两类页面下颜色不一样,**没有任何报错**。
// 当时量到:49 条规则拿这类令牌当颜色用,恰好没有一条落在 v2 页面里,
// 所以是个还没炸的雷 —— 我加审核中心页签时差点成为第一个踩中的。
// 已加 sh- 前缀拆掉。这条防止有人再把它装回来。
test('⭐设计令牌不许"同名不同类"::root 是颜色的,别处就不能改成非颜色值', () => {
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  // ⚠️ 选择器那一段会把**上一个 } 之后的所有东西**都吃进来(文件顶部的
  // `@tailwind base;` 那几行就会挂在 `:root` 前面)。今天在 b/strong 那条上
  // 已经栽过一次同样的坑,这里再栽一次 —— 所以统一切到最后一个 ; 或换行之后。
  const selNames = (sel) => sel.split(',')
    .map((x) => x.replace(/[\s\S]*;/, '').trim())
    .filter(Boolean);
  // 颜色值判定:不能用 /^(...|rgba?\(|...)$/ —— 那个 $ 要求整串**等于**「rgb(」,
  // 完整值 rgb(1,2,3) 永远匹配不到,于是所有颜色都被判成"不是颜色"。同上,今天第二次。
  const isColorValue = (raw) => {
    const v = String(raw).trim();
    if (/^-?[\d.]/.test(v)) return false; // 以数字开头 = HSL 三元组这类裸值,不是颜色
    return /^#[0-9a-fA-F]{3,8}$/.test(v)
      || /^(rgb|rgba|hsl|hsla|color|var|linear-gradient)\(/i.test(v)
      || /^[a-z][a-z-]*$/i.test(v); // 命名色 / inherit / transparent
  };

  const rootColors = new Map();
  for (const [, sel, body] of blocks) {
    if (!selNames(sel).includes(':root')) continue;
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      if (isColorValue(m[2])) rootColors.set(m[1], m[2].trim());
    }
  }
  assert.ok(rootColors.size >= 5, `:root 上应能解析出若干颜色令牌,实际 ${rootColors.size} 个`);

  const clashes = [];
  for (const [, sel, body] of blocks) {
    const names = selNames(sel);
    if (names.includes(':root')) continue;
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      if (!rootColors.has(m[1])) continue;
      if (isColorValue(m[2])) continue; // 覆盖成另一个颜色是正常的换肤
      clashes.push(`${names[0]} 把 ${m[1]}(:root=${rootColors.get(m[1])})改成了「${m[2].trim()}」`);
    }
  }
  assert.deepEqual(clashes, [],
    `令牌被同名不同类覆盖 ${clashes.length} 处 —— var() 会静默失效、回退到 currentColor,`
    + `没有任何报错:\n  ${clashes.join('\n  ')}\n换个名字(如 --sh-xxx)即可,`
    + 'Tailwind 工具类引用的是颜色名不是变量名,不受影响。');
});

// ── 硬规则「蓝只给可点击」──────────────────────────────────────────────
// 这条**没法做成全站扫描**:静态代码判不出一个元素点不点得动(要看 DOM 层级、
// cursor、有没有 @click)。真正的检查是浏览器里跑的那个探针——按色相挑出强调蓝,
// 再用 closest(可交互选择器)+ cursor:pointer 排除可点的。0731 实测:
// 八个页面(/ /intake /agents /library /admin/config /daily/remedy /review /settlement)
// 修前 6 处命中、修后 0 处。
//
// 下面这条是**回归钉,不是覆盖**:只钉住已经改过的这几处,防止被静默改回蓝。
// 新写的蓝抓不到 —— 那要靠上面说的浏览器探针,别把这条当护栏用。
const ACCENT_BLUE_PINS = [
  ['style.css', '.dropzone p strong', 'color'],
  ['style.css', '.preprocess-progress-fill', 'background'],
  ['views/AgentWorkspaceView.vue', '.aw-search-top-icon', 'color'],
  ['components/agent-workspace/AgentList.vue', '.al-head-count', 'color'],
  ['components/agent-workspace/WorkspaceSummary.vue', '.ws-card--accent .ws-card-num strong', 'color'],
  ['views/ConfigConsoleView.vue', '.li-badge.db', 'color'],
];

function isAccentBlue({ h, s, l }) {
  return h >= 200 && h <= 265 && s > 0.45 && l > 0.30 && l < 0.72;
}

test('回归钉:这六处「不可点却染蓝」已改灰,别改回去', () => {
  for (const [file, selector, prop] of ACCENT_BLUE_PINS) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // 选择器要**整段相等**地匹配(逗号分组里逐个 trim),不能用 includes:
    // '.li-badge' 会把 '.li-badge.db' 也吃进来,钉到错的规则上还一直是绿的。
    const rule = [...src.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel, body]) => (
      sel.split(',').map((x) => x.trim().replace(/\[data-v-[^\]]+\]/g, '')).includes(selector)
      && new RegExp(`(^|;)\\s*${prop}:`).test(body)
    ));
    assert.ok(rule, `${file} 里找不到 ${selector} 的 ${prop} 声明 —— 选择器被改名了?钉子要跟着改`);
    const hex = rule[2].match(new RegExp(`${prop}:[^;]*?(#[0-9a-fA-F]{3,6})`));
    // 值写成 var(--x) 时钉不住具体色,但那本身就说明它跟着 token 走,不是硬写的蓝
    if (!hex) continue;
    const hsl = hexToHsl(hex[1]);
    assert.ok(!isAccentBlue(hsl),
      `${file} ${selector} 的 ${prop} 又变回强调蓝了(${hex[1]},hue ${hsl.h.toFixed(0)}°)`
      + ' —— 硬规则:蓝只给可点击的东西');
  }
});

// frontend/src 是 ESM 且用无扩展名相对导入,node:test(CJS)require 不进来;
// 与其余前端契约测试一样,读源码断言。
function tierDots() {
  const src = fs.readFileSync(path.join(SRC, 'lib', 'reviewTier.js'), 'utf8');
  const out = {};
  for (const key of ['high', 'medium', 'low']) {
    const m = src.match(new RegExp(`${key}:\\s*\\{[^}]*dot:\\s*'(#[0-9a-fA-F]{3,6})'`));
    assert.ok(m, `reviewTier.js 里应有 ${key} 档的 dot 色`);
    out[key] = m[1];
  }
  return out;
}

test('硬规则:三档复核里「高·一眼过」走灰阶,中/低(要处理)保留琥珀/红', () => {
  const dots = tierDots();
  const high = hexToHsl(dots.high);
  assert.ok(!isGreen(high), '「一眼过」不是待办,不该用绿');
  assert.ok(high.s < 0.25, '「一眼过」应低饱和,不抢注意力');

  // 中/低是真待办,颜色必须留住,否则三档退化成一片灰、等于没分档
  const medium = hexToHsl(dots.medium);
  const low = hexToHsl(dots.low);
  assert.ok(medium.s > 0.4, '「重点看」要保持琥珀的醒目度');
  assert.ok(low.s > 0.4, '「建议重拍」要保持红的醒目度');
  assert.ok(medium.h >= 20 && medium.h <= 60, `「重点看」应在琥珀区间,实际 ${medium.h.toFixed(0)}°`);
  assert.ok(low.h <= 20 || low.h >= 340, `「建议重拍」应在红区间,实际 ${low.h.toFixed(0)}°`);
});

// ── 两级制漏了语义标签(0724-I 拍板「改一下」)────────────────────────────
// 硬规则是「两级制:400 常规 / 500 强调,不用 700」。全站 CSS 里 font-weight:700
// 出现 **0 次** —— 看起来是执行到位了。但 <b>/<strong> 全站 121 处,
// 而**浏览器默认给它们 700**,全局又没有压制规则。
// 实机实测(审核台一页):32 个 b/strong 里 **31 个是 700**。
// 这就是"按选择器逐个压"这种做法的盲区:压得住自己写的类,压不住语义标签的默认值。

test('⭐b/strong 要跟两级制走 500,不能吃浏览器默认的 700', () => {
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  // ⚠️ 不能用 /(b|strong)/ 这种正则:它会匹配到任何含字母 b 的选择器
  //(.qs-bar / .brand strong 都会误中),第一版就是这么假绿的。
  // 真解析:剥掉注释 → 切出规则块 → 看**选择器逐个 trim 后**是否恰好等于 b 或 strong。
  // 注释必须先剥:它会被算进"选择器"那一段,让 'b' 前面挂着一整段说明文字。
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(([, sel, body]) => {
    const names = sel.split(',').map((x) => x.trim());
    return names.some((n) => n === 'b' || n === 'strong') && /font-weight:\s*500/.test(body);
  });
  assert.ok(hit,
    '全局没有把 b/strong 压到 500 —— 121 处语义标签会吃浏览器默认 700,硬规则形同虚设');
});

// 0731 补洞:下面那条只看 style.css、只认 700/bold。可全站 121 处 b/strong 是
// **.vue 的 scoped 样式**在管,而 `font-weight: 600` 一样违反两级制却完全免检 ——
// 又是「规则只覆盖一个文件、一种取值」。今天实测:源码非 400/500 的写法 0 处
//(唯一一个 700 在注释里),八个渲染页计算值也 0 处。所以这条同样是**堵下次**。
test('⭐两级制要盖住全部前端源码,不只是 style.css(600 也不许)', () => {
  const ALLOWED = new Set(['400', '500', 'normal', 'inherit', 'initial', 'unset', 'revert']);
  const hits = [];
  for (const file of walk(SRC)) {
    // 注释必须先剥:上面几条规则的说明里就写着「font-weight:700 出现 0 次」,
    // 不剥会被自己的交代绊倒 —— 那等于逼后人删掉说明来换绿灯,正好是反的。
    const bare = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split(/\r?\n/)
      .map((l) => strippedOfComments(l))
      .join('\n');
    for (const m of bare.matchAll(/font-weight:\s*([a-z0-9-]+|var\([^)]*\))/gi)) {
      const v = m[1].toLowerCase();
      if (v.startsWith('var(') || ALLOWED.has(v)) continue;
      const line = bare.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(SRC, file)}:${line}  font-weight: ${m[1]}`);
    }
  }
  assert.deepEqual(hits, [], `两级制只有 400(常规)和 500(强调),发现 ${hits.length} 处越级:\n  ${hits.join('\n  ')}`
    + '\n想更醒目请换颜色或字号,不要加粗档 —— 加了第三档,两级制就名存实亡。');
});

test('两级制不许出现 700/bold(既有口径,别被上面那条带坏)', () => {
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  // 用正则**字面量**,不用 new RegExp('...'):字符串里的 \s \b 会被吃掉,
  // 断言变成永远匹配不到 → 假绿。这一条今天已经栽过一次。
  //
  // 而且必须先剥注释:上面那条兜底规则的说明里就写着「font-weight:700 出现 0 次」,
  // 不剥就会被自己的交代绊倒 —— 那会逼着后人删掉说明来让测试变绿,正好是反的。
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/font-weight:\s*(700|bold)\b/.test(bare), 'CSS 里不该出现 700/bold');
});
