'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const imageViewerPath = path.join(__dirname, '../frontend/src/components/ImageViewer.vue');
const reviewViewPath = path.join(__dirname, '../frontend/src/views/ReviewView.vue');

// 0729 切图改框选·第1期。这些是**源码断言**,按判据 7 它们锁不住"还能不能跑" ——
// 所以真正的行为兜底在 tests/review_doc_regions.test.js(12 条,已验红)。
// 这里只锁三个**决定**,每一个错了都不会报错、只会悄悄画歪:
//   ① 文档框和字段框的坐标口径不同(归一化 vs 像素)
//   ② 文档框只在看原图时出现
//   ③ 文档框不填充(填充会让整张小票变灰,违反"框不遮盖信息")

function readViewer() {
  return fs.readFileSync(imageViewerPath, 'utf8');
}

// 抽出某个函数的函数体,避免断言被文件里别处的同名字符串蒙混过关
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到函数 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`函数 ${name} 没闭合`);
}

test('⭐文档框用归一化坐标,绝不能除 naturalWidth/Height', () => {
  // 字段框的 box 是自然像素坐标,所以 regionStyle 要除 naturalWidth;
  // 文档框的 box 是 0~1 比例,再除一次会把框缩到左上角一个点 ——
  // **不会报错,只会画错位置**,操作员还以为模型框歪了。
  const body = functionBody(readViewer(), 'docRegionStyle');
  assert.doesNotMatch(body, /naturalWidth/, '文档框已经是比例,不能再除自然宽');
  assert.doesNotMatch(body, /naturalHeight/, '文档框已经是比例,不能再除自然高');
  assert.match(body, /Number\(box\.left\) \* 100/, '直接乘 100 转成百分比');

  // 0729 补数据时把两套坐标系并成了一套(都归一化):qwen 供的字段框本来就是比例,
  // 再留着像素口径纯属给自己挖坑。两个函数现在应该都不出现 naturalWidth。
  const fieldBody = functionBody(readViewer(), 'regionStyle');
  assert.doesNotMatch(fieldBody, /naturalWidth/, '字段框已并入归一化口径');
});

test('⭐文档框只在看原图时显示(切片上原图坐标对不上)', () => {
  const source = readViewer();
  const start = source.indexOf('const displayDocRegions');
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 420);
  assert.match(block, /showOriginal/, '必须由 showOriginal 把闸');
  // 这条原来断言的是「沿用字段框那个开关」—— 0729 用户反馈把它否掉了:
  // 一个开关管两层,关字段框会把框选一起关掉。现在各管各的,见下面独立开关那条。
});

test('⭐文档框不填充:小票文字密集,任何底色都降低可读性', () => {
  const source = readViewer();
  const start = source.indexOf('.doc-region-box {');
  assert.notEqual(start, -1, '找不到 .doc-region-box 样式');
  const block = source.slice(start, source.indexOf('}', start));
  assert.match(block, /background:\s*transparent/, '只描边,绝不填充');
  assert.doesNotMatch(block, /background:\s*rgba/, '半透明填充也不行');
});

test('文档框:当前=红、兄弟=灰、可疑=红橙', () => {
  // 0730 用户反馈「这个框黑色很不明显,不遮挡视线前提颜色为红色」→ 当前框从蓝改红。
  // 这条原来断言 '#2563eb'(蓝),改红之后它靠文件里别处的蓝色蒙混过关了 —— 现在按框自己的
  // 样式块断言,不再拿全文 includes 糊。
  const source = readViewer();
  const start = source.indexOf('.doc-region-box.current {');
  assert.notEqual(start, -1, '当前框要有独立样式');
  const curBlock = source.slice(start, source.indexOf('}', start));
  assert.match(curBlock, /#e11d48/, '当前框=红(反馈:黑/蓝太不明显)');
  assert.match(curBlock, /border-width:\s*3px/, '而且要加粗,这是主职功能的可见性所在');
  assert.ok(source.includes('.doc-region-box.suspect'), '重叠可疑框要有独立样式');
  assert.ok(source.includes('#dc2626'), '可疑=红橙');
  // 不只靠颜色区分:兄弟框虚线、当前/可疑实线,色觉障碍也能分辨
  assert.ok(source.includes('border: 2px dashed'), '兄弟框用虚线');
  assert.ok(source.includes('border-style: solid'), '当前/可疑用实线');
});

test('标签贴框外侧、悬停才出 —— 压在框里就挡住票面了', () => {
  const source = readViewer();
  const start = source.indexOf('.doc-region-label {');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('}', start));
  assert.match(block, /bottom:\s*calc\(100% \+/, '贴在框外上方,不占框内像素');
  assert.match(block, /opacity:\s*0/, '默认不显示');
  assert.ok(source.includes('.doc-region-box:hover .doc-region-label'), '悬停才出');
});

test('ReviewView 接线:传 docRegions + 点兄弟框能跳任务', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  assert.ok(source.includes(':doc-regions="selectedTaskDocRegions"'));
  assert.ok(source.includes('@on-doc-region-select="handleDocRegionSelect"'));
  assert.ok(source.includes('function handleDocRegionSelect'));
  // 跳转前必须确认目标在当前队列里,否则会选到空
  const body = functionBody(source, 'handleDocRegionSelect');
  assert.match(body, /workbench\.tasks/, '要在队列里找,不能盲跳');

  // 2026-08-01:这条原本断言的是 /if \(target\)/,而当时的真实代码是
  //   `if (target) selectTask(target)`  —— selectTask 这个函数**全项目不存在**。
  // 也就是说:框选跳任务点下去必然 ReferenceError,而这条测试一直是绿的。
  // 它守住了"有没有判空"这个形状,却没守住"调的东西存不存在"。抓到它的是 eslint no-undef。
  // 所以现在改成:它调的每个函数,都必须在同一个文件里定义得出来。
  const called = [...body.matchAll(/(?:^|[^.\w])([a-zA-Z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((n) => !['if', 'for', 'while', 'switch', 'catch', 'return', 'find', 'filter'].includes(n));
  assert.ok(called.length > 0, '解析失败的话这条闸等于没有');
  for (const fn of called) {
    const defined = new RegExp(`(function\\s+${fn}\\b|const\\s+${fn}\\s*=|let\\s+${fn}\\s*=)`).test(source);
    assert.ok(defined, `handleDocRegionSelect 调了 ${fn}(),但 ReviewView.vue 里没有它的定义`);
  }
  // 判空搬进了公共的 focusTaskInQueue(三处跳转共用),行为不变:找不到就不动
  assert.match(functionBody(source, 'focusTaskInQueue'), /if \(!task\) return/, '找不到就不动');
});

test('识别出几张单据要摆在明面上(没被框住的那块只能靠人眼看)', () => {
  const source = readViewer();
  assert.ok(source.includes('doc-region-hint'), '要有计数提示条');
  assert.ok(source.includes('这张原图识别出'), '说清一共框出几张');
  assert.ok(source.includes('没被框住的部分 = 漏识别'), '直接点破怎么用它');
});

// ── 0729 用户反馈:「我实际没看到框选」 ────────────────────────────────
// 根因:文档框藏在「查看原图」后面,而且和字段框共用一个开关。
// 下面三条锁住修正后的行为。

test('⭐框选独立开关:displayDocRegions 只看 showDocRegions,不看 showFieldRegions', () => {
  const source = readViewer()
  const start = source.indexOf('const displayDocRegions')
  const block = source.slice(start, start + 260)
  assert.match(block, /showDocRegions/, '由自己的开关控制')
  assert.doesNotMatch(block, /showFieldRegions/, '不能再被字段框开关连坐 —— 用户明确要求分开')
  assert.ok(source.includes("readStoredBoolean(docRegionVisibilityStorageKey, true)"), '默认必须是开')
})

test('⭐切片视图上要有可见入口,否则等于这功能不存在', () => {
  const source = readViewer()
  assert.ok(source.includes('doc-region-entry'), '要有一键入口按钮')
  assert.ok(source.includes('同图 {{ docRegionHintCount }} 张单据'), '按钮上要写清有几张')
  assert.ok(source.includes('docRegionHintCount > 1'), '只有确实多单据时才出现,不制造噪音')
})

test('框选开关只在看原图且确实有框时出现(裁切图上按了也没用)', () => {
  const source = readViewer()
  // 按钮上不再带数字:默认只框当前那一张,写个总数会让人以为画了那么多个框
  // 0730:条件收敛成 onOriginalView(= showOriginal && (有原图URL || 这条任务本身就是整图))。
  // 原来只认 originalImageUrl,而整图任务的那个值是空的 —— 于是整图任务既没有框
  // 也没有画框按钮,偏偏它才是后端唯一允许画框的那一类。
  const start = source.indexOf('v-if="onOriginalView && validDocRegions.length"')
  assert.notEqual(start, -1, '框选开关要有这个显示条件')
  const block = source.slice(start, start + 320)
  assert.ok(block.includes('框选'), '按钮文案是「框选」')
  assert.ok(source.includes('显示全部 {{ validDocRegions.length }}'), '总数写在「显示全部」上才对')
})

// ── 0729 反馈二轮:「我进去一下子就能看到我现在是哪个票」+「只框当前那个,不要全框」 ──

test('⭐默认只框当前任务,全框收到开关后面', () => {
  const source = readViewer()
  const start = source.indexOf('const displayDocRegions')
  const block = source.slice(start, start + 400)
  assert.match(block, /showAllDocRegions/, '全框要由独立开关控制')
  assert.match(block, /currentDocRegion\.value \? \[currentDocRegion\.value\] : \[\]/, '默认只返回当前那一个')
  assert.ok(source.includes('readStoredBoolean(docRegionAllStorageKey, false)'),
    '全框**默认关** —— 干活视角只需要「我是哪一块」,多余的框是噪音')
})

test('⭐缩略图定位器:切片视图上零点击就知道自己是哪一块', () => {
  const source = readViewer()
  assert.ok(source.includes('doc-locator'), '要有定位器')
  // 宽松匹配:别把空格排版锁死,只要序号真的渲染出来
  // 用 includes 不用正则:文案里有 {{ }} 和 /,正则转义反复出错(判据 10 的同类坑)。
  // 只要序号真的渲染出来,空格排版随意。
  assert.ok(
    source.includes('locatorOrdinal.index }}/{{ locatorOrdinal.total')
    || source.includes('locatorOrdinal.index }} / {{ locatorOrdinal.total'),
    '要给序号',
  )
  const start = source.indexOf('const showLocator')
  const block = source.slice(start, start + 400)
  // 0730 主态翻转后**条件反过来了**,而且是有理由的反:
  // 原来写 !showOriginal,理由是「看原图时已经有框了,不用定位器」。
  // 翻转后原图成了主态并自动对到框上 —— 视口被这张票占满,恰恰看不见整张照片,
  // 「我是第几张」在主态下反而更答不出来。若还留着 !showOriginal,
  // 等于这个定位器再也不出现 = 悄悄删掉了它。
  assert.ok(!/!showOriginal\.value/.test(block),
    '定位器还挂着 !showOriginal —— 主态翻转后它就永远不出现了')
  assert.match(block, /validDocRegions\.value\.length > 1/, '单张图没有「哪一块」可言,不出现')
  assert.match(block, /currentDocRegion\.value/, '不知道自己是哪一块时不出现')
})

test('定位器序号按图上位置排(上→下、左→右),不按任务 id', () => {
  const source = readViewer()
  const start = source.indexOf('const locatorOrdinal')
  const block = source.slice(start, start + 320)
  assert.match(block, /a\.box\.top - b\.box\.top/, '先按上下')
  assert.match(block, /a\.box\.left - b\.box\.left/, '同一行再按左右')
})

test('定位器贴右下角,不压票面', () => {
  // 这条原来的注释写的是我**当初错误的诊断**:「fixed 会被 stage 滚动带跑」。
  // 真因是 absolute 挂在了既 relative 又 overflow:auto 的 .image-stage 里 ——
  // absolute 相对「整块可滚动内容」定位,放大后就跑到画面中间。生产截图实证。
  // 锚点已改挂 .image-viewer,见上面那条更强的断言。
  const source = readViewer()
  const start = source.indexOf('.doc-locator {')
  const block = source.slice(start, source.indexOf('}', start))
  assert.match(block, /position:\s*absolute/)
  assert.doesNotMatch(block, /position:\s*fixed/)
  assert.match(block, /right:\s*\d+px/, '贴右侧')
  assert.match(block, /bottom:\s*\d+px/, '贴底部')
  // 底部要躲开常显的横向滚动条,否则半个定位器压在滚动条上
  const bottom = Number((block.match(/bottom:\s*(\d+)px/) || [])[1] || 0)
  assert.ok(bottom >= 16, `bottom 要 ≥16px 躲开滚动条,实为 ${bottom}`)
})

test('⭐提示条数的是「原图上一共几张」,不是「现在画了几个框」', () => {
  // 生产实拍抓到的自相矛盾:改成默认只框当前之后,提示条显示「识别出 1 张单据」,
  // 而入口按钮和开关都说 2。口径必须是 validDocRegions(全部),不是 displayDocRegions(在画的)。
  const source = readViewer()
  const start = source.indexOf('class="doc-region-hint"')
  assert.notEqual(start, -1)
  const block = source.slice(Math.max(0, start - 120), start + 320)
  assert.ok(block.includes('这张原图识别出 {{ validDocRegions.length }} 张单据'), '要用全部框数')
  assert.ok(!block.includes('{{ displayDocRegions.length }}'), '不能用在画的框数')
  const sus = source.slice(source.indexOf('const suspectDocRegionCount'), source.indexOf('const suspectDocRegionCount') + 160)
  assert.match(sus, /validDocRegions/, '可疑计数同理')
})

// ── 第 2 期:手画文档框(0730)────────────────────────────────────────
// 导出说明里那句「点查看原图框出各自的范围后重新导出」在这之前是做不到的,
// 等于让操作员去做一件不存在的操作。这几条锁住这个能力真的在。

test('⭐画框只在看原图时可用(切片上画出来的坐标对不上)', () => {
  const source = readViewer()
  const start = source.indexOf('class="draw-box-toggle"')
  assert.notEqual(start, -1, '要有画框按钮')
  const block = source.slice(Math.max(0, start - 260), start)
  assert.ok(block.includes('v-if="onOriginalView"'), '必须由「在看原图」把闸')
  // onOriginalView 自己必须真的含 showOriginal,否则只是换了个名字、闸门没了
  const decl = source.slice(source.indexOf('const onOriginalView'), source.indexOf('const validDocRegions'))
  assert.ok(decl.includes('showOriginal.value'), 'onOriginalView 没把 showOriginal 算进去')
})

test('⭐画框时拖拽平移要让位,否则一拖就是平移画不出框', () => {
  const body = functionBody(readViewer(), 'startDragPan')
  assert.match(body, /if \(drawMode\.value\) return/, '画框态直接返回')
})

test('⭐坐标按 image-canvas 的实际盒子算,不是按视口', () => {
  // 图会缩放/旋转/滚动,按视口算必然错位
  const body = functionBody(readViewer(), 'canvasPointFromEvent')
  assert.match(body, /image-canvas/, '要取 canvas 的 rect')
  assert.match(body, /getBoundingClientRect/)
  assert.match(body, /Math\.min\(1, Math\.max\(0,/, '要钳在 0~1')
})

test('换任务 / 切回切片图都要退出画框态,不留悬着的半框', () => {
  const source = readViewer()
  assert.ok(source.includes('watch(() => props.task?.id, cancelDraw)'))
  assert.ok(source.includes('watch(showOriginal, (v) => { if (!v) cancelDraw() })'))
})

test('ReviewView 接线:拖完框调后端并刷新;后端的人话理由要透出给操作员', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8')
  assert.ok(source.includes('@on-doc-box-draw="handleDocBoxDraw"'))
  const body = functionBody(source, 'handleDocBoxDraw')
  assert.match(body, /setTaskDocBox\(batchId, task\.id, box\)/)
  assert.match(body, /workbench\.fetchBatch\(batchId\)/, '存完要刷新,否则框不出现在界面上')
  assert.match(body, /err\?\.response\?\.data\?\.error/, '后端拒绝理由是写给人看的,别用通用文案盖掉')
})

// ── 0730 用户反馈:「这个缩略图什么意思」+「我怎么没实际看到这个框」──────────
// 生产截图实证:定位器浮在票面中间挡着字,而且不解释自己是什么。

test('⭐⭐定位器必须挂在 .image-viewer 上,不能放进会滚动的 .image-stage', () => {
  // 根因:.image-stage 既是 position:relative 又是 overflow:auto,
  // absolute 于是相对「整块可滚动内容」定位 —— 放大 350% 后内容巨大,
  // 定位器就跑到画面中间挡住票面。这是生产截图抓到的。
  const source = readViewer()
  const locAt = source.indexOf('v-if="showLocator"')
  const stageAt = source.indexOf('ref="stageRef"')
  const stageEndHint = source.indexOf('空态占位')
  assert.notEqual(locAt, -1)
  assert.ok(locAt > stageEndHint - 2000 && locAt < stageEndHint,
    '定位器要在 stage 之外、空态占位之前 —— 放 stage 里会随内容滚走')
  assert.ok(locAt > stageAt, '顺序上在 stage 之后')

  const vs = source.indexOf('.image-viewer {')
  const vsBlock = source.slice(vs, source.indexOf('}', vs))
  assert.match(vsBlock, /position:\s*relative/, '.image-viewer 要当定位锚')
})

test('⭐定位器要自我解释:不说自己是什么就是个看不懂的干扰物', () => {
  const source = readViewer()
  assert.ok(source.includes('整张照片'), '要说清这是整张照片的缩小版')
  assert.ok(
    source.includes('红框 = 当前这条') || source.includes('红框=当前这条'),
    '要说清红框代表什么',
  )
  assert.ok(source.includes('点开看框'), '要说清点它干什么')
})

test('⭐入口按钮要交代「框在原图上」—— 用户两次问「怎么没看到框」', () => {
  const source = readViewer()
  assert.ok(source.includes('到原图看框'), '按钮文案要指明去哪看')
  const start = source.indexOf('class="doc-region-entry"')
  const block = source.slice(Math.max(0, start - 700), start + 200)
  assert.ok(block.includes('切片本身就是那个框'), 'title 要解释为什么切片上不画框')
})

test('⭐定位器要限高且可折叠 —— 竖照片下它会挡掉一大片票面', () => {
  // 0730 实测:132px 宽的竖照片缩略图会拉到 233px 高,整个 146x281px 面板
  // 自身 100% 面积压在票面上,在 350% 放大的小票上挡掉的正是字段区。
  const source = readViewer()
  const start = source.indexOf('.doc-locator-thumb {')
  const block = source.slice(start, source.indexOf('}', start))
  assert.match(block, /max-height:\s*150px/, '要限高,不能只限宽')
  assert.ok(source.includes('v-if="!locatorCollapsed"'), '要能折叠')
  assert.ok(source.includes('doc-locator-fold'), '折叠指示器')
  assert.ok(source.includes("readStoredBoolean(locatorCollapsedStorageKey, false)"), '折叠状态要记住')
  // 折叠后头部仍要带序号,否则收起来就完全没信息了
  assert.ok(source.includes('第 {{ locatorOrdinal.index }}/{{ locatorOrdinal.total }} 张'),
    '折叠态也要看得到「第几张」')
})

test('⭐可疑框的说明要说清是「票号重复」,不是「框重叠」', () => {
  // 口径 v3:纯几何重叠不报了(实测 94.5% 是两张真的不同的票)。
  // 文案必须说清真问题 + 下一步,不能只说"框重叠"让人猜。
  const source = readViewer()
  const body = functionBody(source, 'docRegionTitle')
  assert.ok(body.includes('票号相同'), '要说清真问题')
  assert.ok(body.includes('删掉多余的那条'), '要给下一步动作')
  assert.ok(!body.includes('可能是两张票被框成了一张'), '旧的猜测式文案要去掉')
  assert.ok(source.includes('条票号重复'), '提示条也要改口径')
})

// ── 人工框在单单据图上也要画出来(0730 金标实跑闭环测试抓到)────────────────
// buildTaskDocRegions 里 `group.length < 2 → 返回 []` 的理由是
// 「单张图没有『哪一块』可言,多余的框是噪音」——对**模型框**成立。
// 但对**人工框**不成立:那是操作员特意拖出来、交付要按它裁的东西(实测
// deliveryImagePlan 当场变成 crop/cropped_by_box)。看不见就又是一次
// 「我画了框,然后呢?还是显示这个」——框生效了,界面零反馈。
const { buildTaskDocRegions: buildRegions } = require('../lib/review_doc_regions')

test('⭐单单据图上的人工框也要画出来(模型框仍然不画)', () => {
  const base = {
    id: 't1', sourceOriginalPath: 'ws/c1/photo.jpg',
    docTypeFinal: 'receipt', receiptNoFinal: '03-261-635-0022-9',
  }
  // 模型给的框:单张图不画,维持既有降噪口径
  const auto = buildRegions({ ...base, detectionBox: [0.2, 0.15, 0.75, 0.85] })
  assert.equal(auto.length, 0, '模型框在单单据图上仍然不画(降噪口径不变)')

  // 人工画的框:必须画出来
  const manual = buildRegions({
    ...base, detectionBox: [0.2, 0.15, 0.75, 0.85],
    manualBox: [0.2, 0.15, 0.75, 0.85], docBoxSource: 'manual',
  })
  assert.equal(manual.length, 1, '人工框没画出来 —— 操作员看不到自己刚画的东西')
  assert.equal(manual[0].isCurrent, true, '它就是当前这条任务')
  assert.deepEqual(manual[0].box, { left: 0.2, top: 0.15, width: 0.55, height: 0.7 })
})
