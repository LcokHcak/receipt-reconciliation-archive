const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// P1 主态翻转:原图为默认视图 + 自动对到当前任务的框。
//
// 为什么这两个函数是纯的、且吃「量出来的 canvasRect」而不是自己算 fit/zoom:
// 视图那边 zoom=1 的含义是**适应窗口**(baseImageSize 已经按 stage 缩过),
// 再叠 CSS transform(scale + rotate)。要在这儿复现那套数学,等于把同一份
// 几何逻辑写两遍 —— 迟早漂。量外接矩形则天然包含缩放和旋转,不会漂。

async function load() {
  return import(pathToFileURL(path.join(
    __dirname, '../frontend/src/lib/imageViewerControls.js'
  )).href);
}

// 对框逻辑 0731 起拆成两段:focusCurrentDocRegion(关/开过渡)+ runBoxFocus(收敛)。
// 断言要覆盖两段,否则挪个函数就漏检。
function focusRoutine(source) {
  // ⚠️ 先归一化换行:这个文件在 Windows 上被 git checkout 后是 CRLF,
  // 而函数结尾在 CRLF 下是 `}\r\n`,用 '\n}\n' 找会**一路吃到文件尾**,
  // 于是断言"函数体里不含 X"必然误判(X 在文件别处)。
  const vue = String(source).split('\r\n').join('\n');
  const grab = (name) => {
    const i = vue.indexOf(`async function ${name}(`);
    if (i < 0) return '';
    const end = vue.indexOf('\n}\n', i);
    return vue.slice(i, end < 0 ? vue.length : end);
  };
  return `${grab('focusCurrentDocRegion')}\n${grab('runBoxFocus')}`;
}

function readViewer() {
  return fs.readFileSync(path.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
}

// ── rotateNormalizedBox ───────────────────────────────────────────────
// 框的坐标是**原图**归一化的;图可能被审核员转过 90/180/270。
// 不转框就会把框画到别处 —— 竖拍小票转正后是常态,不是边角情况。

test('0° 不动', async () => {
  const { rotateNormalizedBox } = await load();
  const b = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(rotateNormalizedBox(b, 0), b);
});

test('90° 顺时针:点 (x,y) → (1-y, x)', async () => {
  const { rotateNormalizedBox } = await load();
  const r = rotateNormalizedBox({ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }, 90);
  // 新 left = 1 - top - height = 0.4;新 top = left = 0.1;宽高互换
  assert.deepEqual(r, { left: 0.4, top: 0.1, width: 0.4, height: 0.3 });
});

test('180° 是两次 90°', async () => {
  const { rotateNormalizedBox } = await load();
  const b = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(rotateNormalizedBox(b, 180), rotateNormalizedBox(rotateNormalizedBox(b, 90), 90));
});

test('270° 是三次 90°,且 360° 回到原点', async () => {
  const { rotateNormalizedBox } = await load();
  const b = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
  let acc = b;
  for (let i = 0; i < 3; i += 1) acc = rotateNormalizedBox(acc, 90);
  assert.deepEqual(rotateNormalizedBox(b, 270), acc);
  assert.deepEqual(rotateNormalizedBox(b, 360), b);
});

test('负角度和非 90 倍数不炸(-90 = 270,归一化)', async () => {
  const { rotateNormalizedBox } = await load();
  const b = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(rotateNormalizedBox(b, -90), rotateNormalizedBox(b, 270));
});

test('⭐整图框在任何旋转下都还是整图(不变量:转框不能凭空造出偏移)', async () => {
  const { rotateNormalizedBox } = await load();
  const full = { left: 0, top: 0, width: 1, height: 1 };
  for (const deg of [0, 90, 180, 270]) {
    assert.deepEqual(rotateNormalizedBox(full, deg), full, `${deg}° 把整图转歪了`);
  }
});

// ── computeBoxFit ─────────────────────────────────────────────────────

const RECT = { left: 100, top: 50, width: 1000, height: 800 };

test('框占一半 → 需要放大一倍(fill=1 时)', async () => {
  const { computeBoxFit } = await load();
  const fit = computeBoxFit({
    box: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 },
    rotation: 0,
    canvasRect: RECT,
    stageWidth: 500, stageHeight: 400, fill: 1,
  });
  // 框现在视觉上 500x400,视口正好 500x400 → 已经满了,倍数 1
  assert.equal(fit.factor, 1);
  // 框心 = canvas 左上 + 0.5*宽高
  assert.equal(fit.centerX, 100 + 500);
  assert.equal(fit.centerY, 50 + 400);
});

test('⭐取两轴里更紧的那个 —— 只满足一轴会把框顶出视口', async () => {
  const { computeBoxFit } = await load();
  // 细高框:宽 10% 高 80%。宽度方向能放 5 倍,高度方向只能放 0.625 倍。
  const fit = computeBoxFit({
    box: { left: 0.1, top: 0.1, width: 0.1, height: 0.8 },
    rotation: 0,
    canvasRect: RECT,
    stageWidth: 500, stageHeight: 400, fill: 1,
  });
  // 宽:500/(0.1*1000)=5   高:400/(0.8*800)=0.625  → 取 0.625
  assert.equal(fit.factor, 0.625);
});

test('fill 留边:0.9 就是九成视口', async () => {
  const { computeBoxFit } = await load();
  const fit = computeBoxFit({
    box: { left: 0, top: 0, width: 0.5, height: 0.5 },
    rotation: 0,
    canvasRect: RECT,
    stageWidth: 500, stageHeight: 400, fill: 0.9,
  });
  assert.equal(fit.factor, 0.9);
});

test('⭐旋转 90° 后框心跟着走(不跟着走 = 转正竖拍小票就对错地方)', async () => {
  const { computeBoxFit } = await load();
  // 左上角的小框,转 90° 后应该跑到右上角
  const box = { left: 0, top: 0, width: 0.2, height: 0.2 };
  const flat = computeBoxFit({
    box, rotation: 0, canvasRect: RECT, stageWidth: 500, stageHeight: 400, fill: 1,
  });
  const turned = computeBoxFit({
    box, rotation: 90, canvasRect: RECT, stageWidth: 500, stageHeight: 400, fill: 1,
  });
  assert.equal(flat.centerX, 100 + 0.1 * 1000);          // 左边
  assert.equal(turned.centerX, 100 + 0.9 * 1000);        // 右边
  assert.equal(turned.centerY, 50 + 0.1 * 800);          // 还在上边
});

test('退化输入返回 null,不返回 Infinity/NaN', async () => {
  const { computeBoxFit } = await load();
  const base = { rotation: 0, canvasRect: RECT, stageWidth: 500, stageHeight: 400 };
  assert.equal(computeBoxFit({ ...base, box: { left: 0, top: 0, width: 0, height: 0.5 } }), null);
  assert.equal(computeBoxFit({ ...base, box: null }), null);
  assert.equal(computeBoxFit({ ...base, canvasRect: { left: 0, top: 0, width: 0, height: 0 }, box: { left: 0, top: 0, width: 0.5, height: 0.5 } }), null);
  assert.equal(computeBoxFit({ ...base, stageWidth: 0, box: { left: 0, top: 0, width: 0.5, height: 0.5 } }), null);
});

// ── 视图接线 ───────────────────────────────────────────────────────────

test('⭐默认主态是原图(用户:「都是原图,我直接定位到我的这个任务」)', () => {
  const vue = readViewer();
  assert.ok(/showOriginal\s*=\s*ref\(true\)/.test(vue), '初始值要是 true');

  // 真正的不变量是「**换任务时**不复位成切片」,不是「代码里不许出现 false」——
  // 用户主动点「看切片」当然要能置 false。所以只卡换任务那个 watcher 的函数体。
  const i = vue.indexOf('watch(() => props.task?.id');
  assert.notEqual(i, -1, '找不到换任务的 watcher');
  const body = vue.slice(i, vue.indexOf('\n})', i));
  assert.ok(body.includes('showOriginal.value = true'), '换任务要回到主态');
  assert.ok(!body.includes('showOriginal.value = false'),
    '换任务把主态复位成切片了 —— 那主态永远翻不过来');
});

test('⭐换任务后自动对到当前框上', () => {
  const vue = readViewer();
  assert.ok(vue.includes('focusCurrentDocRegion'), '要有对框动作');
  assert.ok(vue.includes('computeBoxFit'), '对框要用纯函数算,不在组件里另写一套几何');
});

test('⭐对框不受「框选」开关影响 —— 关掉框线不该连带关掉自动对位', () => {
  const vue = readViewer();
  const body = focusRoutine(vue);
  assert.ok(body.includes('computeBoxFit'), '找不到对框逻辑');

  assert.ok(!body.includes('showDocRegions'),
    '对框逻辑读了 showDocRegions —— 用户关掉框线后就再也不自动对位了,而这两件事无关');
  assert.ok(!body.includes('displayDocRegions'),
    '对框不能读 displayDocRegions(它受开关控制),要读 currentDocRegion');
});

test('切片视图降为兜底按钮,但必须还在(原图缺失/字段框定位都要靠它)', () => {
  const vue = readViewer();
  assert.ok(vue.includes('看切片'), '兜底按钮不能删');
});

// ── 画框在旋转下会存歪(0730 读代码发现,P1 让这条路更常走)──────────────
// canvasPointFromEvent 用的是 canvas.getBoundingClientRect(),那是**旋转后**的外接矩形。
// 拿到的比例是**屏幕坐标系**的,却被当成原图坐标直接 emit 出去存进 manualBox。
// 图被 ↺↻ 转过之后,画的框和存的框对不上 —— 而且不报错,交付时按错框裁。

test('⭐反旋转:屏幕上点的位置要还原成原图上的位置', async () => {
  const { unrotateNormalizedPoint } = await load();
  // 原图上 (0.1, 0.2) 这个点,图顺时针转 90° 后出现在屏幕 (1-0.2, 0.1) = (0.8, 0.1)
  // ⚠️ 用容差不用 deepEqual:1-0.8 = 0.19999999999999996(IEEE754)。
  // 这是 1e-16 量级,对像素坐标毫无影响;卡死等值只会逼着实现去做无意义的凑整。
  const near = (got, wantX, wantY) => {
    assert.ok(Math.abs(got.x - wantX) < 1e-9 && Math.abs(got.y - wantY) < 1e-9,
      `期望 ≈(${wantX}, ${wantY}),实得 ${JSON.stringify(got)}`);
  };
  near(unrotateNormalizedPoint({ x: 0.8, y: 0.1 }, 90), 0.1, 0.2);
  near(unrotateNormalizedPoint({ x: 0.3, y: 0.7 }, 0), 0.3, 0.7);   // 0° 不动
  near(unrotateNormalizedPoint({ x: 0.9, y: 0.8 }, 180), 0.1, 0.2); // 180° 是中心对称
});

test('⭐往返不变:转过去再转回来必须回到原点(四个角度都要)', async () => {
  const { unrotateNormalizedPoint, rotateNormalizedBox } = await load();
  for (const deg of [0, 90, 180, 270]) {
    // 用一个退化成点的框借 rotateNormalizedBox 算出正向映射,再用反函数还原
    const p = { x: 0.23, y: 0.61 };
    const r = rotateNormalizedBox({ left: p.x, top: p.y, width: 0, height: 0 }, deg);
    const back = unrotateNormalizedPoint({ x: r.left, y: r.top }, deg);
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9,
      `${deg}° 往返没回到原点: ${JSON.stringify(back)}`);
  }
});

test('⭐画框必须做反旋转 —— 不做的话转过的图存出来的框是歪的', () => {
  const vue = readViewer();
  const i = vue.indexOf('function canvasPointFromEvent');
  assert.notEqual(i, -1);
  const body = vue.slice(i, vue.indexOf('\n}', i));
  assert.ok(body.includes('unrotateNormalizedPoint'),
    'canvasPointFromEvent 没做反旋转:量的是旋转后外接矩形的比例,存的却当成原图坐标');
});

test('⭐对框要迭代到收敛 —— 只滚一次实机差 ~200px', () => {
  const vue = readViewer();
  const body = focusRoutine(vue);

  assert.ok(/for \(let i = 0; i < \d+; i \+= 1\)/.test(body),
    '对框只滚了一次:缩放改了 shell 尺寸和滚动上限,第一次量到的是旧布局(实机实测差 -197/+180)');
  assert.ok(body.includes('Math.abs(dx) <= 2'), '要有收敛判据,不能死循环也不能白滚');
  // Browser pane 里标签页 hidden 时 rAF 被节流 —— 对框不能等 rAF,否则永远不执行
  assert.ok(!body.includes('requestAnimationFrame'), '对框不能依赖 rAF(hidden 标签页会被节流)');
});

test('⭐对框结果不能被 resetStageScroll 冲掉(实机抓到的抢滚动)', () => {
  const vue = readViewer();
  // 特征很明确:换任务 watcher 在 rAF 里复位滚动,而缓存过的图 @load 会先于那个 rAF 触发,
  // 于是对框先算完、再被复位冲掉 —— 实测 scrollLeft 正好 =(scrollWidth-clientWidth)/2、
  // scrollTop 正好 =0,就是 resetStageScroll 的结果。
  const i = vue.indexOf('function resetStageScroll');
  const body = vue.slice(i, vue.indexOf('\n}', i));
  assert.ok(body.includes('focusedForCurrentImage'),
    'resetStageScroll 没让路 —— 它会把已经对好的框拉回图片中间');

  const w = vue.indexOf('watch(() => props.task?.id');
  const wbody = vue.slice(w, vue.indexOf('\n})', w));
  assert.ok(wbody.includes('focusedForCurrentImage = false'),
    '换任务要清标记,否则上一张的标记会永久挡住复位');

  const f = vue.indexOf('async function focusCurrentDocRegion');
  const fbody = vue.slice(f, vue.indexOf('\n}\n', f));
  assert.ok(fbody.includes('focusedForCurrentImage = true'), '对框成功要立标记');
});

// ── 对框期间必须关掉 CSS 过渡(0731 实测定位的根因)────────────────────────
// .image-canvas 上有 `transition: transform 0.12s ease`。
// 对框的流程是「改缩放 → nextTick → 量 getBoundingClientRect()」,而那 120ms 里
// canvas 正在动画中 —— **量到的是插值中间态,不是目标态**。
// 证据:实测 @load 时读到的 scale 是 3.65895 / 0.601158 这种值,
// 而 setImageViewerZoom 是 .toFixed(2) 的,根本产不出来。
// 后果:单次缩放一直偏小;加了收敛循环反而每轮都在动画中量、误差逐轮放大 →
// 实测框占视口 1.88x1.63 / 1.42x2.30(比视口还大 = 比不对框还糟)。
//
// 自动对框本来就该是"瞬移到位",不该有动画;用户手动缩放那条路的动画保留。

test('⭐对框期间要关掉 transform 过渡,否则量到的是动画中间态', () => {
  const vue = readViewer();
  assert.ok(/\.image-canvas\.is-focusing\s*\{[^}]*transition:\s*none/.test(vue),
    '没有"对框中"这个免过渡样式 —— 量 rect 会量到插值');
  const body = focusRoutine(vue);

  assert.ok(body.includes('focusing.value = true'), '对框开始时没关过渡');
  assert.ok(body.includes('focusing.value = false'), '对框结束没把过渡还回去');
  // 关过渡必须**先于**改缩放生效,否则第一次改动照样走动画。
  // ⚠️ 先剥注释:上面那段说明里就写着 setImageViewerZoom(解释它为什么 .toFixed(2)),
  // 不剥的话顺序会拿注释里的位置去比,必然误判。
  const code = body.replace(new RegExp('//[^\\n]*', 'g'), '');
  const onIdx = code.indexOf('focusing.value = true');
  const zoomIdx = code.indexOf('setImageViewerZoom');
  assert.ok(onIdx >= 0 && zoomIdx > onIdx, '关过渡要排在改缩放之前');
  assert.ok(/focusing\.value = true[\s\S]{0,120}await nextTick\(\)/.test(body),
    '关过渡后要 await nextTick 让 class 落到 DOM,否则第一次缩放仍在动画里');
});
