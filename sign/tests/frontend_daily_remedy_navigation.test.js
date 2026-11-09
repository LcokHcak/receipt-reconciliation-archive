'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('daily remedy is exposed from the reviewer workflow instead of monthly-only navigation', () => {
  const routerSource = read('frontend/src/router/index.js');
  const appSource = read('frontend/src/App.vue');
  const sidebarSource = read('frontend/src/layouts/AppSidebar.vue');
  const dailyRemedySource = read('frontend/src/views/DailyRemedyView.vue');
  const reviewSource = read('frontend/src/views/ReviewView.vue');

  assert.match(routerSource, /path:\s*'\/daily\/remedy'/);
  assert.match(routerSource, /DailyRemedyView\.vue/);
  assert.match(appSource, /label:\s*'异常补救'[\s\S]*name:\s*'daily-remedy'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'待补救'[\s\S]*to:\s*'\/daily\/remedy'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'待补救'[\s\S]*to:\s*v2\('remedy'\)/);
  assert.doesNotMatch(dailyRemedySource, /AppLayout/);
  assert.match(
    routerSource,
    /path:\s*'\/monthly\/v2\/:workspaceKey\/remedy'[\s\S]*redirect:\s*\(to\)\s*=>\s*`\/daily\/remedy\/\$\{to\.params\.workspaceKey\}`/
  );
  // 波2 承接(0728#2):确认框打断 → 常驻琥珀提示行(image96 三类提示统一写法)
  assert.match(reviewSource, /remedyNotice > 0/);
  assert.match(reviewSource, /rv-notice is-warn/);
  assert.match(reviewSource, /去异常补救处理/);
  assert.doesNotMatch(reviewSource, /现在去处理吗/);
  assert.match(reviewSource, /router\.push\('\/daily\/remedy'\)/);
});

// ── 0731:不许静默截断 ────────────────────────────────────────────────────
// 补救页每个状态各拉一页就完事,而抬头那句「共 N 条」写的是 **rows.length**
// (已加载条数)。服务端一直在返 total(listing_routes.js:35),页面从来没接。
// 结果:一旦超过每页上限,「共」字就在说假话 —— 操作员处理完屏幕上这些
// 就以为清空了,实际还压着一批看不见的。
//
// 这跟 0730 修的「代理视图下一步任务 LIMIT 50」是同一族:
// 少数据本身不致命,**少了还装作没少**才致命,因为"看不见"会被读成"没有"。
test('⭐日度待补救:接服务端 total,并在截断时明说(别把"看不见"变成"没有")', () => {
  const src = read('frontend/src/views/DailyRemedyView.vue');
  // 注释里写着 total/截断的来龙去脉,不剥的话下面几条会被自己的交代喂成绿灯
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(bare, /payload\?\.total/,
    '必须接服务端返的 total —— 不接就只能拿已加载条数冒充总数');
  assert.match(bare, /serverTotalRows/, '真实总数要单独存,不能和 rows.length 混为一谈');
  assert.match(bare, /isTruncated/, '要有截断标志');
  // 抬头的「共 N 条」必须用服务端总数,不能再用 rows.length
  assert.match(bare, /共 <TabularNumber :value="serverTotalRows \|\| rows\.length"/,
    '「共 N 条」要显示服务端总数;继续写 rows.length 就是截断时说假话');
  // 截断时必须有可见提示,且带琥珀(硬规则:要处理=红橙)
  assert.match(bare, /v-if="isTruncated"[\s\S]{0,200}text-amber-700/,
    '截断提示要存在且用琥珀 —— 悄悄少给数据是这条要修的病本身');
});

// ── P2-c:补票 → 自动进画框态(0731)────────────────────────────────────
// P2-a 让切片任务上的补票产出一条指向整张原图、能画框的任务;
// P2-b 让画完框自动重读。中间还差一步:补完之后人得**自己**找到画框按钮。
// 这条钉住那一步,以及**话术必须跟着行为改** —— 旧话术说"补一条空白记录、
// 请照图填写字段",按那个说明书办事的人会去手填一遍本来能读出来的东西。
test('⭐补小票之后要自动进画框态,且提示语要说的是现在真发生的事', () => {
  const view = read('frontend/src/views/ReviewView.vue');
  const viewer = read('frontend/src/components/ImageViewer.vue');
  const bare = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // 钉"暴露了 enterDrawMode",不钉 defineExpose 的**完整列表** ——
  // 第一版写成 /defineExpose\(\{\s*enterDrawMode\s*\}\)/,后来多暴露一个
  // exitDrawMode(P4 的 Esc 要用)就红了。钉过头的断言会拦住正当的扩展。
  assert.match(viewer, /defineExpose\(\{[^}]*\benterDrawMode\b[^}]*\}\)/,
    'ImageViewer 要把"进画框态"暴露给父组件');
  // ⚠️ 不能写成 /function enterDrawMode\(\)[\s\S]{0,160}canDrawBox\.value\.ok/ ——
  // 那个 [\s\S]{0,160} 会**越过函数边界**,匹到紧邻的 drawBoxTitle 里同名的表达式,
  // 于是把守卫删掉它照样绿。验红时才暴露的(四条里就这条没咬住)。
  // 只取函数体本身来断言。
  const drawFnBody = (viewer.match(/function enterDrawMode\(\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.ok(drawFnBody, '没定位到 enterDrawMode 函数体');
  assert.match(drawFnBody, /canDrawBox\.value\.ok/,
    '后端说不能画就不该进 —— 宁可什么都不发生,也别进一个画了会被拒的态');
  assert.match(bare, /imageViewerRef\.value\?\.enterDrawMode/,
    '补完票要把人直接放进画框态');
  // 2026-08-01:原来这里要求 nextTick() 与 enterDrawMode **紧邻同行**。
  // 而这次要接住返回值(`const entered = ...`),中间多了赋值,断言就凭空挂了 ——
  // 代码是对的。钉"紧邻"太脆:真正要保证的只是**顺序**(先等渲染,再进)。
  // ⚠️ 不能用全局 indexOf 找这两个词:文件里别处也有 nextTick / enterDrawMode,
  // 取到的会是不相干的一对(我第一版就是这么写的,断言凭空挂)。
  // 要的是"它们成对紧挨着出现",用有界间隔的正则表达。
  assert.match(bare, /await nextTick\(\)[\s\S]{0,120}enterDrawMode/,
    '要等新任务的图渲染完再进(且中间不塞别的逻辑),'
    + '否则开关翻了图还没换,看着像没反应');
  // 进不去时不许静默:那个确认框承诺了"自动进入画框态 + 按框重读字段",
  // 承诺过的事没发生却一个字不说,人会以为自己点错了,然后手填一遍本可自动读的东西。
  assert.match(bare, /if \(entered === false\)/,
    '要看 enterDrawMode 的返回值 —— 它返回 false 表示"后端说这条不能画"');

  // 话术:不能再说"空白记录/照图填写",要说清会画框 + 会自动重读。
  // ⚠️ 不能拿文件里**第一个** window.confirm —— 那是别的操作(重切等)的确认框,
  // 抓错了就会一直红/一直绿,都跟这条要管的事无关。按补票那句独有的话锚定。
  const confirmText = (bare.match(/还有一张票没有生成记录[\s\S]*?\)\) return/) || [])[0] || '';
  assert.ok(confirmText, '没定位到补票的确认框 —— 锚点句被改了?断言要跟着改');
  assert.ok(confirmText.includes('画框'), '提示语要说会进画框态');
  assert.ok(confirmText.includes('重读'), '提示语要说会按框重读字段');
  assert.ok(!/空白小票记录/.test(confirmText),
    '旧话术"补一条空白记录、请照图填写"已经不成立 —— 说明书和实际不符,人就会按旧说明书办事');
});

// ── P4:框选键盘可达(0731)────────────────────────────────────────────────
// 审核台整套是键盘驱动的(Enter / R+1/2/3 / ←→),而画框只能用鼠标 ——
// 每纠一次切错的框就得把手从键盘挪开一趟。B 进 / Esc 退 / Backspace 清框。
test('⭐画框要能用键盘:B 进 / Esc 退 / Backspace 清,且 Esc 优先于清搜索', () => {
  const view = read('frontend/src/views/ReviewView.vue');
  const viewer = read('frontend/src/components/ImageViewer.vue');
  const bare = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(viewer, /defineExpose\(\{\s*enterDrawMode,\s*exitDrawMode\s*\}\)/,
    'Esc 要能退画框态,得把 exitDrawMode 暴露出去');
  // 只在函数体内断言,别越过边界匹到别处的同名表达式(0731 已栽过一次)
  const exitBody = (viewer.match(/function exitDrawMode\(\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.ok(exitBody, '没定位到 exitDrawMode 函数体');
  assert.match(exitBody, /if \(!drawMode\.value\) return false/,
    '没在画框态时要返回 false,好让 Esc 继续往下走(清队列搜索)');

  assert.match(bare, /e\.key === 'b' \|\| e\.key === 'B'/, 'B 要能进画框态');
  assert.match(bare, /e\.key === 'Backspace'/, 'Backspace 要能清框');

  // ⭐Esc 的顺序:画框态必须排在 clearSearch **前面**。
  // 正在画框的人按 Esc 想的是"别画了",顺手把队列搜索也清了最招人烦。
  const escBlock = (bare.match(/if \(e\.key === 'Escape'\)[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(escBlock, '没定位到 Escape 分支');
  assert.ok(escBlock.indexOf('exitDrawMode') > -1
    && escBlock.indexOf('exitDrawMode') < escBlock.indexOf('clearSearch'),
    'Esc 必须先退画框态,再考虑清搜索');

  // Backspace 只能清**人画的**框,不能顺手删掉模型给的 detectionBox(删了没法恢复)
  const backBlock = (bare.match(/e\.key === 'Backspace'[\s\S]*?handleDocBoxDraw\(null\)/) || [])[0] || '';
  assert.match(backBlock, /docBoxSource[\s\S]*?manual/,
    'Backspace 只在有人工框时才动,别把模型框也删了');

  // 键位要写在人正在看的地方
  assert.match(viewer, /Esc 退出[\s\S]{0,40}Backspace/, '画框提示里要写清键位');
});

// ── P3 收控件(0731,拍板「画框 / 补小票 / 重拍」)──────────────────────────
// 切图出问题时的三条主路要一眼看全:①框切错了→画框(图上,B);②漏了一张→补小票;
// ③图本身不行→重拍。其余(重切/追加图片/删除/恢复/结算类)留在「更多」。
//
// 量过现状再动的:审核台上跟"机器切错/漏了"有关的控件正好 7 个,其中
// 恢复审核/删除这张图/追加图片/按店重切**早就在「更多」里**了(我第一遍探针
// 判断"在不在菜单里"用了粗糙的位置比较,报错成"直接摆着",查模板才纠正)。
// 所以真正要动的只有一件:把补小票提到明面。
test('⭐补救主路收成三条:补小票要在明面,重切留在「更多」且名字是人话', () => {
  const src = read('frontend/src/views/ReviewView.vue');
  const tpl = src.slice(src.indexOf('\n<template>')).replace(/<!--[\s\S]*?-->/g, '');

  const moreStart = tpl.indexOf('<MoreMenu placement="top">');
  const moreEnd = tpl.indexOf('</MoreMenu>', moreStart);
  assert.ok(moreStart > 0 && moreEnd > moreStart, '没定位到任务级「更多」菜单');
  const inMore = tpl.slice(moreStart, moreEnd);
  const outsideMore = tpl.slice(0, moreStart) + tpl.slice(moreEnd);

  // 补小票:明面有、菜单里不再重复(重复摆两处会让人以为是两件事)
  assert.match(outsideMore, /@click="addReceiptOnSameImage"/,
    '补小票要提到明面 —— 切图出问题时它是主路之一,藏菜单里等于多一次点击');
  assert.ok(!inMore.includes('addReceiptOnSameImage'),
    '同一个动作不要在明面和菜单里各放一份');

  // 重拍:明面(既有肌肉记忆 + 快捷键 R)
  assert.match(outsideMore, /@click="markRephotoAndNext\(\)"/, '重拍留在明面');

  // 重切:留在菜单,且改掉内部说法「按此店重切」
  assert.ok(inMore.includes('resplitCurrentTask'), '重切降级留在「更多」里');
  assert.ok(!/按此店重切/.test(tpl),
    '「按此店重切」是内部说法(按店档案切);操作员关心的是"让系统再切一次"');
  assert.match(inMore, /让系统重新切这张图/, '重切要用人话');

  // 破坏性动作继续留在菜单里,别被这次调整带出来
  for (const fn of ['deleteSelectedTask', 'restoreTask', 'triggerAppendImages']) {
    assert.ok(inMore.includes(fn), `${fn} 应留在「更多」里`);
    assert.ok(!outsideMore.includes(`@click="${fn}"`), `${fn} 不该被提到明面`);
  }
});

// ── 队列红标:可疑重复要在**点开之前**看得见(#38,0731)────────────────────
// 判据(框重叠 + 票号相同 = 同一张票出了两条记录)0730 就修对了,
// 但它只在**点开那张图**之后才显示。而可疑的后果是同一张票报两笔账 ——
// 审核员没有理由去点开一条"看起来正常"的任务,于是这个信号在最需要它的时候是隐身的。
test('⭐可疑重复要标在队列上,且单图组也要能看见', () => {
  const src = read('frontend/src/components/GroupedTaskList.vue');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // 只消费后端判据,不在前端重算 —— 重算就是第二套口径,两套必漂
  assert.match(bare, /function isSuspectTask\(task\)[\s\S]{0,320}docRegions/,
    '可疑与否要从后端下发的 docRegions 里取');
  assert.ok(!/containmentRatio|receiptNoKey/.test(bare),
    '前端不许自己重算可疑判据 —— 那会变成第二套口径');

  // 子行要标
  assert.match(bare, /isSuspectTask\(item\.task\)/, '任务行要标可疑');

  // ⭐组头也要报:单图组根本不渲染子行(v-if="group.total > 1"),
  // 只挂子行 = 单图组里的可疑永远看不见,又一次"看不见=没有"
  assert.match(bare, /suspectCountOfGroup\(group\)/, '组头要报可疑数');
  const tpl = bare.slice(bare.indexOf('<template>'));
  const headerEnd = tpl.indexOf('</header>');
  // ⚠️ 不能只断言"组头里出现了 suspectCountOfGroup" —— title 和插值里都有这个名字,
  // 把 v-if 改成 false 它照样通过(验红时就这条没咬住,今天第四次栽在过宽匹配上)。
  // 要钉的是**渲染条件真的挂在这个数上**。
  assert.ok(headerEnd > 0
    && /v-if="suspectCountOfGroup\(group\)"/.test(tpl.slice(0, headerEnd)),
    '可疑数必须在 <header> 里按数量条件渲染(组折叠/单图组时那是唯一可见的地方)');

  // 硬规则:要处理=琥珀;数量不许套胶囊
  assert.match(src, /\.task-suspect\s*\{[^}]*var\(--warning\)/, '可疑用琥珀(要处理)');
  const groupSuspectCss = (src.match(/\.group-suspect\s*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(groupSuspectCss, '没找到 .group-suspect 样式');
  assert.ok(!/border-radius|background/.test(groupSuspectCss),
    '组头那个带数字,套胶囊就踩了「胶囊只作状态」');
});
