const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadImageViewerControlsModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/imageViewerControls.js'
  )).href);
}

test('image viewer controls zoom within readable bounds and reset', async () => {
  const { createImageViewerState, zoomImageViewer, resetImageViewer, setImageViewerZoom } = await loadImageViewerControlsModule();

  const state = createImageViewerState();
  assert.deepEqual(state, { zoom: 1, rotation: 0 });
  assert.equal(zoomImageViewer(state, 20).zoom, 6);
  assert.equal(zoomImageViewer(state, -10).zoom, 0.25);
  assert.equal(setImageViewerZoom(state, 1.5).zoom, 1.5);
  assert.equal(setImageViewerZoom(state, 99).zoom, 6);
  assert.equal(setImageViewerZoom(state, 0).zoom, 0.25);
  assert.deepEqual(resetImageViewer(state), { zoom: 1, rotation: 0 });
});

test('image viewer controls rotate in quarter turns', async () => {
  const { createImageViewerState, rotateImageViewer } = await loadImageViewerControlsModule();

  let state = createImageViewerState();
  state = rotateImageViewer(state, 90);
  state = rotateImageViewer(state, 90);
  assert.equal(state.rotation, 180);
  assert.equal(rotateImageViewer(state, 270).rotation, 90);
});

test('小票切片默认放大350%+居中,其它类型/查看原图保持适应窗口(生产反馈#5)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
  assert.match(src, /DEFAULT_RECEIPT_ZOOM = 3\.5/);
  // 仅对**免税店小票切片**、非查看原图时默认放大并居中。
  // 0727反馈#4:百货底层 docType 也是 'receipt' 但它是整图,350% 一进来怼脸——按店家排除,百货走适应。
  assert.match(src, /docType === 'receipt' && !isDept && !showOriginal\.value/);

  // ⚠️ 2026-08-01 更正这条断言的**含义**:上面那行字面量确实还在文件里,
  // 但它在默认视图下**根本执行不到**,所以"断言它存在"并不等于"百货走适应窗口"。
  //
  // 两道短路,任一成立就到不了:
  //   ① 同函数上方 `if (onOriginalView.value && currentDocRegion.value) { … return }`
  //      —— 有框(人工框,或同图 ≥2 个检测框)时直接对框放大并 return;
  //      而"护照压着小票"正是乐天百货整个业务的常态形态,所以百货**普遍有框**。
  //   ② `!showOriginal.value` —— showOriginal 默认 true(0730 主态翻转:原图成了默认视图),
  //      所以即使没框,这个条件也不成立。
  //
  // 也就是说:这行代码今天是**死的**,而这条测试一直绿着 ——
  // 和今天修掉的另外两处(交付说明里"查看原图"那句、重拍分键 1/2/3)是同一个形状:
  // **断言"源码里有这行字",不等于断言"这件事会发生"**。
  //
  // 行为到底该是"对框"还是"适应+上限夹取",是待拍板项(见
  // ../系统交付修改/0801-你二十分钟能清掉的拍板清单.md 的 B5)。
  // 在拍板之前,这里如实钉住**当前真实行为**,免得下一个人照着上面那句注释判断错。
  assert.match(src, /if \(onOriginalView\.value && currentDocRegion\.value\)/,
    '有框时先对框并 return —— 这才是百货默认走的那条路');
  assert.match(src, /const showOriginal = ref\(true\)|showOriginal = ref\(true\)/,
    'showOriginal 默认 true(0730 主态翻转);'
    + '它一旦改回 false,上面那行百货分支会突然复活,行为静默翻转,这里要有人看见');
  assert.match(src, /isDeptStoreValue\(props\.task\?\.receiptStoreFinal \|\| props\.task\?\.receiptStoreAuto\)/);
  assert.match(src, /setImageViewerZoom\(viewerState\.value, DEFAULT_RECEIPT_ZOOM\)/);
  assert.match(src, /recenterAfterRotate\(\)/);
});

// ── 0727反馈#11 图片缓冲不出来:预览端点接线 ─────────────────────────────────
//
// ⚠️ 这条测试 0731 重写过。原来它断言的是
//   `showOriginal.value && props.originalImageUrl) return props.originalImageUrl`
// ——那正是 0730 P1 主态翻转带出的**回归本身**:默认视图翻成"整张原图"之后,这一行让
// 默认路径绕开了预览端点的上限与缓存;而 ReviewView 预取热的还是切片 URL,和实际加载的
// 第三个 URL 对不上,窄带宽白烧一遍。两半修法同时失效,测试却在保护它。
// 现在改成测**行为**:URL 规则抽成纯函数直测,两个消费方必须从同一个模块取。
test('预览优先:两档都走 /storage-preview(整张原图档=edge2400),失败回退裸图;预取热的就是要加载的那个 URL', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');

  // ① URL 规则本身(纯函数,直测)
  const lib = fs2.readFileSync(path2.join(__dirname, '../frontend/src/lib/imageUrls.js'), 'utf8');
  // 前端是 ESM,这里只是把 `export ` 去掉后当普通函数体跑——比复制一份实现安全:
  // 复制就又成了"两个读者",而这条测试正是为了钉死"只能有一个读者"。
   
  const { toPreviewUrl, toOriginalViewUrl } = new Function(
    `${lib.replace(/^export /gm, '')}\nreturn { toPreviewUrl, toOriginalViewUrl };`,
  )();
  assert.equal(toPreviewUrl('/storage/b1/a.jpg'), '/storage-preview/b1/a.jpg');
  assert.equal(toOriginalViewUrl('/storage/b1/a.jpg'), '/storage-preview/b1/a.jpg?edge=2400',
    '看整张原图那档要 2400:1600 下一张票只占 ~530px,自动放大到框上会糊');
  assert.equal(toOriginalViewUrl('https://cdn.example/x.jpg'), 'https://cdn.example/x.jpg',
    '非 /storage 的 URL 原样返回,不硬套');
  assert.equal(toOriginalViewUrl(''), '', '空值不产生 "?edge=2400" 这种垃圾 URL');

  // ② 查看器:两档都走端点,且回退护栏不再按 showOriginal 分叉(分叉正是漏掉原图档的写法)
  const iv = fs2.readFileSync(path2.join(__dirname, '../frontend/src/components/ImageViewer.vue'), 'utf8');
  assert.match(iv, /from '\.\.\/lib\/imageUrls'/, 'URL 规则必须从单一真相源取');
  assert.match(iv, /toOriginalViewUrl\(props\.originalImageUrl\)/, '整张原图档也要过端点');
  assert.match(iv, /previewFailed\.value \? props\.originalImageUrl : toOriginalViewUrl/,
    '端点挂了要能回退裸原图,不是黑屏');
  assert.match(iv, /@error="handleImageError"/);
  assert.doesNotMatch(iv, /\.replace\(\/\^\\\/storage\\\/\/,/, '组件里不许再自己写一份 replace');

  // ③ 预取:热的必须是查看器真正加载的那个 URL,而且同源函数
  const rv = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  assert.match(rv, /from '\.\.\/lib\/imageUrls'/);
  assert.match(rv, /toOriginalViewUrl\(task\.originalImageUrl\)/,
    '默认视图是整张原图,预取不热它就等于没预取');
  assert.doesNotMatch(rv, /rawUrl\.replace\(\/\^\\\/storage/, '预取里不许再自己写一份 replace');
});
