<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  buildImageTransform,
  computeBoxFit,
  createImageViewerState,
  resetImageViewer,
  rotateImageViewer,
  setImageViewerZoom,
  unrotateNormalizedPoint,
} from '../lib/imageViewerControls'
import { isDeptStoreValue } from '../lib/reviewDisplay'
import { toPreviewUrl, toOriginalViewUrl } from '../lib/imageUrls'

const props = defineProps({
  task: {
    type: Object,
    default: null,
  },
  fieldRegions: {
    type: Array,
    default: () => [],
  },
  activeFieldKey: {
    type: String,
    default: '',
  },
  originalImageUrl: {
    type: String,
    default: '',
  },
  // 这条任务**本身就是整张照片**(没被切开)。
  // 它的 originalImageUrl 是空的(没有"另一张原图"要看),但它恰恰是后端唯一允许
  // 画框的那一类 —— 只认 originalImageUrl 的话就是「能画的地方没按钮,
  // 有按钮的地方后端拒绝」,画框功能一次也通不过(0730 实测)。
  isOriginalImage: {
    type: Boolean,
    default: false,
  },
  // 文档框(切图改框选·第1期):同一张原图上兄弟单据的框,**只在看原图时**画。
  // 字段框是切片坐标系、这个是原图坐标系,两者天然互斥,不会同屏打架。
  docRegions: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['on-field-region-select', 'on-doc-region-select', 'on-doc-box-draw'])

// 缩放档位精简到 4 档(2026-07-26 用户需求:工具栏太高,合并成一行)。
// 9 档必然换行,而中间档(25/150/300/500)靠 ±/滑条几下就到,留着只是占位。
const zoomPresets = [
  { value: 0.5, label: '50%' },
  { value: 1, label: '100%' },
  { value: 2, label: '200%' },
  { value: 4, label: '400%' },
]
const shellPadding = 96
// 小票切片进审核台默认放大倍数(生产反馈:小票字小,一进来就要放大+居中才看得清)。350% 落在 25%~600% 内。
const DEFAULT_RECEIPT_ZOOM = 3.5
const fieldRegionVisibilityStorageKey = 'sign.imageViewer.showFieldRegions'
const fieldRegionSizeStorageKey = 'sign.imageViewer.fieldRegionSize'
const docRegionVisibilityStorageKey = 'sign.imageViewer.showDocRegions'
const docRegionAllStorageKey = 'sign.imageViewer.showAllDocRegions'
const locatorCollapsedStorageKey = 'sign.imageViewer.locatorCollapsed'
const fieldRegionSizeOptions = [
  {
    value: 'compact',
    label: '小',
    borderWidth: 1,
    radius: 3,
    fillOpacity: 0.07,
  },
  {
    value: 'normal',
    label: '中',
    borderWidth: 1.5,
    radius: 4,
    fillOpacity: 0.1,
  },
  {
    value: 'large',
    label: '大',
    borderWidth: 2,
    radius: 4,
    fillOpacity: 0.13,
  },
]

const stageRef = ref(null)
const shellRef = ref(null)
// 量它的外接矩形来对框:缩放和旋转天然都在 rect 里,不用在组件里另写一套几何
const canvasRef = ref(null)
const viewerState = ref(createImageViewerState())
const naturalSize = ref({ width: 900, height: 640 })
const stageSize = ref({ width: 0, height: 0 })
const showFieldRegions = ref(readStoredBoolean(fieldRegionVisibilityStorageKey, true))
// 文档框(框选)独立开关,默认开。和字段框分开:两层是两个坐标系、两个用途,
// 共用一个开关时「关掉字段框」会把框选一起关掉,不是用户想要的。
const showDocRegions = ref(readStoredBoolean(docRegionVisibilityStorageKey, true))
// 默认只框当前那张;要查「哪块没被框住」时才打开全部
const showAllDocRegions = ref(readStoredBoolean(docRegionAllStorageKey, false))
// 定位器折叠态(0730 实测:竖照片下它 146x281px、自身 100% 面积压在票面上,
// 在 350% 放大的小票上挡掉的正是字段区)。折叠后只留一行字,想看再展开。
const locatorCollapsed = ref(readStoredBoolean(locatorCollapsedStorageKey, false))
const showOnlyActiveRegion = ref(false)
// 对框进行中:期间关掉 canvas 的 transform 过渡,否则量 rect 量到的是动画插值中间态
const focusing = ref(false)
const fieldRegionSize = ref(readStoredFieldRegionSize())
let resizeObserver = null

// **原图是主态**(P1 主态翻转,0730)。用户原话:
// 「都是原图,我直接定位到我的这个任务,护照也好小票也好;这样我发现这个框没框住哪个信息,
//   或者框少了一个小票或者护照任务,我可以立刻方便我人工处理。」
//
// 为什么以前默认切片、以及那个理由为什么不成立:
// 以为「切片更清晰」。实测推翻了 —— 原图长边中位 1920 / 切片中位 1280 / preview 上限 1600。
// 切片在像素上根本不占优,常常更差。感觉清晰是因为切片**占满屏幕**:取景问题,不是分辨率问题。
// 所以只要打开原图时自动缩放平移到框上(focusCurrentDocRegion),原图在每个维度都不输切片,
// 还多给了"这张票在整张照片的哪儿""隔壁有没有漏的"。
const showOriginal = ref(true)
const taskImageUrl = computed(() => props.task?.imageUrl || props.task?.sourceImageUrl || '')
// 预览优先(0727反馈#11「图片缓冲不出来」):/storage 直出原图 5-12MB,窄线路半分钟起步;
// 默认换 /storage-preview(服务端 1600px 缩放缓存,~20倍提速)。预览端点失败(旧后端/
// 格式怪)→ @error 回退原图直出;「查看原图」路径不动,永远全清晰度。
const previewFailed = ref(false)
// 图彻底裂了(原图也挂/资源404)的占位态(2026-07-28 用户截图:裂图只剩浏览器默认破图标,
// 中栏整片白板,审核员不知道是"没图"还是"没加载出来"还是"系统坏了")。
const brokenImage = ref(false)
watch(taskImageUrl, () => { previewFailed.value = false; brokenImage.value = false })
// URL 规则在 lib/imageUrls.js(单一真相源:查看器加载 + ReviewView 预取都从那里取,
// 禁止各写各的 replace —— P1 主态翻转就是这么让两半同时失效的,见那个文件的注释)。
const imageUrl = computed(() => {
  if (showOriginal.value && props.originalImageUrl) {
    return previewFailed.value ? props.originalImageUrl : toOriginalViewUrl(props.originalImageUrl)
  }
  const url = taskImageUrl.value
  if (!url || previewFailed.value) return url
  return toPreviewUrl(url)
})
// 当前显示的是不是"回退后的裸 URL"(两档共用一个判断,别再按 showOriginal 分叉——
// 分叉正是上一版把原图档漏在护栏外面的写法)
const rawUrlNow = computed(() => (
  showOriginal.value && props.originalImageUrl ? props.originalImageUrl : taskImageUrl.value
))
function handleImageError() {
  // 预览档挂了就回退裸 URL(切片档、原图档都适用);裸 URL 再挂说明是网络/文件问题,
  // 别死循环换 URL,直接亮占位
  if (!previewFailed.value && imageUrl.value !== rawUrlNow.value) {
    previewFailed.value = true
    return
  }
  brokenImage.value = true // 回退后仍挂(或无可回退)→ 亮占位,不留破图标
}
function retryBrokenImage() {
  // 重试从预览端点重新走一遍(网络抖动最常见);仍挂会再次回到占位
  brokenImage.value = false
  previewFailed.value = false
}
const zoomPercent = computed(() => Math.round(viewerState.value.zoom * 100))
const validFieldRegions = computed(() => (props.fieldRegions || []).filter((region) => {
  const box = region?.box || {}
  return Number.isFinite(Number(box.left))
    && Number.isFinite(Number(box.top))
    && Number(box.width) > 0
    && Number(box.height) > 0
}))
const displayFieldRegions = computed(() => {
  // 字段框坐标基于裁切图;看整页原图时坐标系不同,隐藏以免错位
  if (showOriginal.value && props.originalImageUrl) return []
  if (showOnlyActiveRegion.value && props.activeFieldKey) {
    return validFieldRegions.value.filter((region) => region.key === props.activeFieldKey)
  }
  return validFieldRegions.value
})
const fieldRegionCount = computed(() => validFieldRegions.value.length)
// 「现在看的是整张原图」—— 两种来源都算:①切换到了那张原图 ②这条任务本身就是整图。
// 做成单一入口,是因为原来全站只认 ①,于是整图任务既画不出框、也没有画框按钮,
// 而它恰恰是后端唯一允许画框的那一类 ——「能画的地方没按钮,有按钮的地方后端拒绝」。
const onOriginalView = computed(() => (
  showOriginal.value && Boolean(props.originalImageUrl || props.isOriginalImage)
))
// 文档框只在**看原图**时出现:切片视图上原图坐标对不上,画出来必然错位。
// 正好和字段框互补——上面 displayFieldRegions 在 showOriginal 时返回 []。
//
// 0729 反馈修正:原来这里用的是 showFieldRegions,于是「字段框」一个开关同时管两层,
// 关掉字段框连文档框一起没了。改成各自独立的开关(showDocRegions,默认开)。
const validDocRegions = computed(() => (props.docRegions || []).filter((region) => {
  const box = region?.box || {}
  return Number(box.width) > 0 && Number(box.height) > 0
}))
const currentDocRegion = computed(() => validDocRegions.value.find((r) => r.isCurrent) || null)
// **默认只框当前这一张**(0729 反馈:「当前任务是哪个票哪个护照我就框选哪个,而不是全都框选」)。
// 全框是审计视角(找漏识别),干活视角只需要「我是哪一块」——多余的框是噪音。
// 兄弟框收到「显示全部」开关后面,要查漏时再打开。
const displayDocRegions = computed(() => {
  if (!showDocRegions.value) return []
  if (!onOriginalView.value) return []
  if (showAllDocRegions.value) return validDocRegions.value
  return currentDocRegion.value ? [currentDocRegion.value] : []
})
// 切片视图上有没有可看的框 —— 用来在工具栏挂一个一键入口。
// 不做成自动切原图:字段框是切片坐标系的,自动切过去会让 28% 的任务失去字段定位。
const docRegionHintCount = computed(() => (
  showOriginal.value || !props.originalImageUrl ? 0 : validDocRegions.value.length
))
// 这条任务能不能手画框 —— **后端算的**(lib/manual_doc_box.canAcceptManualBox),
// 前端只消费,不复制规则(复制就会漂)。
// 没下发时保守当"能"(旧后端兼容,行为和改动前一致)。
const canDrawBox = computed(() => {
  const v = props.task?.canDrawBox
  if (!v || typeof v !== 'object') return { ok: true, error: '' }
  return { ok: v.ok !== false, error: String(v.error || '') }
})
// P2-c(0731):让父组件在「补小票」之后把人直接放进画框态。
// 后端说不能画就不进:宁可什么都不发生,也不要进一个画了会被拒的态。
function enterDrawMode() {
  if (!canDrawBox.value.ok) return false;
  drawMode.value = true;
  return true;
}
// P4(0731):Esc 退画框态。
// 上一版这里写着"只暴露进、不暴露退,退出是操作员自己的决定" —— 理由没错,
// 但结论下过头了:Esc **就是**操作员自己按的,和点「取消画框」按钮是同一个意思。
// 真正不该有的是"父组件在他没要求时替他退",而不是"父组件不能转达他的要求"。
// 返回是否真的退了 —— 调用方据此决定 Esc 要不要继续往下走(比如清队列搜索)。
function exitDrawMode() {
  if (!drawMode.value) return false;
  cancelDraw();
  return true;
}
defineExpose({ enterDrawMode, exitDrawMode });

const drawBoxTitle = computed(() => {
  if (!canDrawBox.value.ok) return canDrawBox.value.error || '这条任务不能手动框选'
  return drawMode.value
    ? '退出画框(Esc)'
    : '在原图上拖一个框,框出这条任务对应的那张单据 —— 交付时按它裁(快捷键 B)'
})

// 缩略图定位器(0729 反馈:「我进去一下子就能看到我现在是哪个票」)。
// 为什么不是在切片上画框:切片本身就是那个框,画了等于画个边框,没信息量。
// 真正缺的是**空间关系** —— 这张切片在整张照片的哪个位置。缩略图零点击回答这个。
// 只在确实是多单据同图时出现(单张图没有"哪一块"可言),不制造噪音。
//
// 0730 主态翻转后**必须**在原图态也显示:自动对框后视口被这张票占满,
// 恰恰看不见整张照片 —— 「我是第几张」这个问题在主态下反而更答不出来。
// 原来的条件是 !showOriginal,翻转后等于这个定位器再也不出现(等于悄悄删了它)。
const showLocator = computed(() => (
  onOriginalView.value
  && validDocRegions.value.length > 1 && Boolean(currentDocRegion.value)
))
// 「第 2 张 / 共 4 张」:序号按框在原图上的先后(上→下、左→右),和肉眼看图顺序一致
const locatorOrdinal = computed(() => {
  const list = [...validDocRegions.value].sort((a, b) => (
    Math.abs(a.box.top - b.box.top) > 0.08 ? a.box.top - b.box.top : a.box.left - b.box.left
  ))
  const i = list.findIndex((r) => r.isCurrent)
  return { index: i + 1, total: list.length }
})
// ⚠️ 这两个数的口径是「这张原图上一共有什么」,不是「现在画了几个框」。
// 默认改成只框当前之后,若还数 displayDocRegions 就会显示「识别出 1 张单据」
// 而入口按钮说「同图 2 张」—— 生产实拍抓到的正是这个自相矛盾。
const suspectDocRegionCount = computed(() => validDocRegions.value.filter((r) => r.suspect).length)
const fieldRegionSizeOption = computed(() => {
  return fieldRegionSizeOptions.find((option) => option.value === fieldRegionSize.value) || fieldRegionSizeOptions[0]
})
const fieldRegionLayerStyle = computed(() => ({
  '--field-region-border-width': `${fieldRegionSizeOption.value.borderWidth}px`,
  '--field-region-radius': `${fieldRegionSizeOption.value.radius}px`,
  '--field-region-fill-opacity': fieldRegionSizeOption.value.fillOpacity,
}))

const baseImageSize = computed(() => {
  const naturalWidth = Math.max(1, naturalSize.value.width)
  const naturalHeight = Math.max(1, naturalSize.value.height)
  const availableWidth = Math.max(260, stageSize.value.width - 72)
  const availableHeight = Math.max(320, stageSize.value.height - 72)
  const fitScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight, 1)

  return {
    width: Math.max(120, Math.round(naturalWidth * fitScale)),
    height: Math.max(120, Math.round(naturalHeight * fitScale)),
  }
})

const shellStyle = computed(() => {
  const rotation = Math.abs(Number(viewerState.value.rotation || 0) / 90) % 2
  const sideways = rotation === 1
  const visualWidth = (sideways ? baseImageSize.value.height : baseImageSize.value.width) * viewerState.value.zoom
  const visualHeight = (sideways ? baseImageSize.value.width : baseImageSize.value.height) * viewerState.value.zoom

  return {
    width: `${Math.max(stageSize.value.width, visualWidth + shellPadding * 2)}px`,
    minHeight: `${Math.max(stageSize.value.height, visualHeight + shellPadding * 2)}px`,
  }
})

const canvasStyle = computed(() => ({
  width: `${baseImageSize.value.width}px`,
  height: `${baseImageSize.value.height}px`,
  transform: buildImageTransform(viewerState.value),
}))

watch(() => props.task?.id, async () => {
  viewerState.value = resetImageViewer()
  showOnlyActiveRegion.value = false
  focusedForCurrentImage = false // 新任务重新算,别拿上一张的标记挡住复位
  // 换任务回到主态=原图。以前这里复位成切片,主态就永远翻不过来。
  showOriginal.value = true
  await nextTick()
  updateStageSize()
  resetStageScroll()
})

watch(showDocRegions, (value) => {
  writeStoredValue(docRegionVisibilityStorageKey, value ? '1' : '0')
})
watch(showAllDocRegions, (value) => {
  writeStoredValue(docRegionAllStorageKey, value ? '1' : '0')
})
watch(locatorCollapsed, (value) => {
  writeStoredValue(locatorCollapsedStorageKey, value ? '1' : '0')
})
watch(showFieldRegions, (value) => {
  writeStoredValue(fieldRegionVisibilityStorageKey, value ? '1' : '0')
})

function updateStageSize() {
  if (!stageRef.value) return
  stageSize.value = {
    width: stageRef.value.clientWidth,
    height: stageRef.value.clientHeight,
  }
}

// 「这张图已经对到框上了」——用来挡住 resetStageScroll 把对框结果冲掉。
// 0730 实机实测抓到的:换任务 watcher 在 rAF 里复位滚动,而缓存过的图 @load 会
// **先于**那个 rAF 触发,于是对框先算完、再被复位冲掉。
// 实测特征很明确:scrollLeft 正好等于 (scrollWidth-clientWidth)/2、scrollTop 正好 0,
// 就是 resetStageScroll 的结果。两个动作抢同一个滚动位置,谁后跑谁赢。
let focusedForCurrentImage = false

function resetStageScroll() {
  requestAnimationFrame(() => {
    if (!stageRef.value) return
    if (focusedForCurrentImage) return // 已经对到框上了,别再拉回中间
    stageRef.value.scrollTop = 0
    stageRef.value.scrollLeft = Math.max(0, (stageRef.value.scrollWidth - stageRef.value.clientWidth) / 2)
  })
}

// 把视口对到当前任务的框上 —— 主态翻转的核心动作。
// 效果 = 满像素原图 + 切片一样的取景;顺带还能看见框外面(隔壁票漏没漏)。
//
// ⚠️ 这里**刻意不读 showDocRegions / displayDocRegions**:
// 那是「画不画框线」的开关,和「对不对位」是两件事。读了的话,用户一关框线
// 就再也不自动对位了,而且没有任何提示 —— 这种耦合出了问题没人查得到。
async function focusCurrentDocRegion() {
  const stage = stageRef.value
  const canvas = canvasRef.value
  const region = currentDocRegion.value
  if (!stage || !canvas || !region?.box) return false

  // ⚠️ 先关掉 transform 过渡,再动缩放(0731 实测定位的根因)。
  // .image-canvas 上有 `transition: transform .12s ease`,而对框是「改缩放 → 量 rect」,
  // 那 120ms 里量到的是**动画插值中间态**,不是目标态。
  // 证据:@load 时读到的 scale 是 3.65895 / 0.601158 这种值,而 setImageViewerZoom
  // 是 .toFixed(2) 的,根本产不出来。后果:单次缩放一直偏小;加收敛循环反而每轮都在
  // 动画中量、误差逐轮放大(实测框占到视口 1.88x1.63,比不对框还糟)。
  // 自动对框本来就该是"瞬移到位";用户手动缩放那条路的动画不受影响。
  focusing.value = true
  await nextTick() // 让 is-focusing 落到 DOM,否则第一次缩放照样走动画
  try {
    await runBoxFocus(stage, canvas, region)
  } finally {
    focusing.value = false
  }
  focusedForCurrentImage = true
  return true
}

async function runBoxFocus(stage, canvas, region) {
  const measure = () => computeBoxFit({
    box: region.box,
    rotation: viewerState.value.rotation,
    canvasRect: canvas.getBoundingClientRect(),
    stageWidth: stage.clientWidth,
    stageHeight: stage.clientHeight,
  })

  // ① 缩放迭代到收敛。判据用倍数本身:factor≈1 就说明框已正好占满目标比例。
  // 过渡关掉之后每轮量到的都是目标态,所以这个循环才收敛得了。
  for (let i = 0; i < 4; i += 1) {
    const fit = measure()
    if (!fit) return
    if (Math.abs(fit.factor - 1) <= 0.02) break
    viewerState.value = setImageViewerZoom(
      viewerState.value,
      Number(viewerState.value.zoom || 1) * fit.factor,
    )
    await nextTick()
    // 被 MIN/MAX_ZOOM 钳住时 factor 永远回不到 1,再迭代是空转
    const z = Number(viewerState.value.zoom)
    if (z >= 6 || z <= 0.25) break
  }

  // ② 缩放定了再对位,同样迭代到收敛。
  // 0730 实机实测:只滚一次会差 ~200px(横向 -197 / 纵向 +180),再滚一次精确归零。
  // 原因是缩放改了 shell 尺寸和滚动上限,第一次量到的还是旧布局下的值;
  // nextTick 只保证 Vue 把 DOM 改完,不保证浏览器把滚动几何算完。
  // 不用 rAF 等:Browser pane 里标签页 hidden 时 rAF 会被节流,等不到。
  // 读 getBoundingClientRect 本身就会强制布局,所以同步再来一轮就是新值。
  for (let i = 0; i < 3; i += 1) {
    const after = measure()
    if (!after) return
    const stageRect = stage.getBoundingClientRect()
    const dx = after.centerX - stageRect.left - stage.clientWidth / 2
    const dy = after.centerY - stageRect.top - stage.clientHeight / 2
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) break
    // 越界赋值浏览器自己钳位(框贴边时本来就居不了中),滚不出去也拖得回来
    stage.scrollLeft += dx
    stage.scrollTop += dy
  }
}

function handleImageLoad(event) {
  const image = event.target
  naturalSize.value = {
    width: image.naturalWidth || 900,
    height: image.naturalHeight || 640,
  }
  updateStageSize()
  // 主态:原图 + 自动对到当前框。对不上(没框/没量到)就回落到适应窗口,不留半吊子状态。
  if (onOriginalView.value && currentDocRegion.value) {
    nextTick().then(async () => {
      const ok = await focusCurrentDocRegion()
      if (!ok) resetStageScroll()
    })
    return
  }
  // 小票切片默认放大 350% 并居中(护照/百货/其它/查看原图 保持适应窗口)。
  // ⚠️百货底层 docType 也是 'receipt'(一等档设计),必须再按店家排除(0727反馈#4):
  // 百货是整图不是切片,350% 一进来就怼脸,操作员每张都得先缩小 —— 百货走适应窗口。
  const docType = String(props.task?.docTypeFinal || props.task?.docTypeAuto || '').trim()
  const isDept = isDeptStoreValue(props.task?.receiptStoreFinal || props.task?.receiptStoreAuto)
  if (docType === 'receipt' && !isDept && !showOriginal.value) {
    viewerState.value = setImageViewerZoom(viewerState.value, DEFAULT_RECEIPT_ZOOM)
    recenterAfterRotate() // 复用双轴居中:scrollLeft+scrollTop 到中点,把小票放视图正中
  } else {
    resetStageScroll()
  }
}

function setZoom(zoom) {
  applyZoomAnchored(zoom)
}

// 变焦滚动锚定(2026-07-14 报障根治"放大就看不见/拖不回来"):
// shell 随视觉尺寸对称长大、图心=壳几何中心,旧实现变焦后滚动位置不动,
// 图心右移+下移直接跑出视口。这里把"变焦前视口锚点对准的图上点"在变焦后
// 重新对回视口同一位置——放大到哪看到哪。锚点缺省=视口中心,Ctrl+滚轮=光标。
async function applyZoomAnchored(nextZoom, anchorClientX = null, anchorClientY = null) {
  const stage = stageRef.value
  const shell = shellRef.value
  if (!stage || !shell) {
    viewerState.value = setImageViewerZoom(viewerState.value, nextZoom)
    return
  }
  const prevZoom = Number(viewerState.value.zoom || 1)
  const stageRect = stage.getBoundingClientRect()
  const ax = anchorClientX == null ? stage.clientWidth / 2 : (anchorClientX - stageRect.left)
  const ay = anchorClientY == null ? stage.clientHeight / 2 : (anchorClientY - stageRect.top)
  // 图心在滚动内容坐标系的位置(rect 差已含当前 scroll,量出来即真值)
  const shellRect = shell.getBoundingClientRect()
  const centerX = stage.scrollLeft + (shellRect.left - stageRect.left) + shellRect.width / 2
  const centerY = stage.scrollTop + (shellRect.top - stageRect.top) + shellRect.height / 2
  // 锚点相对图心的位移,折算回 1x 图坐标(旋转已含在视觉框里,线性缩放不受影响)
  const dx = (stage.scrollLeft + ax - centerX) / prevZoom
  const dy = (stage.scrollTop + ay - centerY) / prevZoom
  viewerState.value = setImageViewerZoom(viewerState.value, nextZoom)
  const applied = Number(viewerState.value.zoom || 1)
  await nextTick()
  const stageRect2 = stage.getBoundingClientRect()
  const shellRect2 = shell.getBoundingClientRect()
  const centerX2 = stage.scrollLeft + (shellRect2.left - stageRect2.left) + shellRect2.width / 2
  const centerY2 = stage.scrollTop + (shellRect2.top - stageRect2.top) + shellRect2.height / 2
  // 同一图上点回到视口同一位置;越界赋值浏览器自动钳位,永远拖得回来
  stage.scrollLeft = centerX2 + dx * applied - ax
  stage.scrollTop = centerY2 + dy * applied - ay
}

// 快速拖动一帧可触发多次 input:rAF 合并只按最后值锚定一次(复核:连发时 prevZoom
// 已是新值而 DOM 未重排,dx/dy 除数错位会短暂跳动;合并后逻辑态与渲染态同步)。
let sliderZoomPending = null
function handleSlider(event) {
  const next = Number(event.target.value) / 100
  if (sliderZoomPending !== null) {
    sliderZoomPending = next
    return
  }
  sliderZoomPending = next
  requestAnimationFrame(() => {
    const target = sliderZoomPending
    sliderZoomPending = null
    applyZoomAnchored(target)
  })
}

// 拖拽平移:按住图片直接拖(等价拖滚动条)。字段框等按钮不劫持,点按钮照常。
const isPanning = ref(false)
const dragPan = { startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 }

function startDragPan(event) {
  if (drawMode.value) return // 画框态由 startDraw 接管,别被平移抢走
  if (event.button !== 0 || !stageRef.value) return
  if (event.target.closest('button')) return
  isPanning.value = true
  dragPan.startX = event.clientX
  dragPan.startY = event.clientY
  dragPan.scrollLeft = stageRef.value.scrollLeft
  dragPan.scrollTop = stageRef.value.scrollTop
  stageRef.value.setPointerCapture?.(event.pointerId)
}

function moveDragPan(event) {
  if (!isPanning.value || !stageRef.value) return
  event.preventDefault()
  stageRef.value.scrollLeft = dragPan.scrollLeft - (event.clientX - dragPan.startX)
  stageRef.value.scrollTop = dragPan.scrollTop - (event.clientY - dragPan.startY)
}

function endDragPan(event) {
  if (!isPanning.value) return
  isPanning.value = false
  stageRef.value?.releasePointerCapture?.(event.pointerId)
}

function handleWheelZoom(event) {
  // 业界惯例:Ctrl+滚轮=缩放;普通滚轮不拦截,走容器原生滚动(看长图/大图)。
  // 之前 @wheel.prevent 全劫持去缩放,导致滚轮无法滚动图片、滚动条也不出现。
  if (!event.ctrlKey) return
  event.preventDefault()
  const delta = event.deltaY < 0 ? 0.1 : -0.1
  // 缩到哪指到哪:光标位置为锚
  applyZoomAnchored(Number(viewerState.value.zoom || 1) + delta, event.clientX, event.clientY)
}

function zoomIn() {
  applyZoomAnchored(Number(viewerState.value.zoom || 1) + 0.25)
}

function zoomOut() {
  applyZoomAnchored(Number(viewerState.value.zoom || 1) - 0.25)
}

// 旋转后长短边互换,旧滚动位置全失效 → 双轴回中(旋转多在适应档做,回中最可预期)
async function recenterAfterRotate() {
  await nextTick()
  const stage = stageRef.value
  if (!stage) return
  stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
  stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)
}

function rotateLeft() {
  viewerState.value = rotateImageViewer(viewerState.value, -90)
  recenterAfterRotate()
}

function rotateRight() {
  viewerState.value = rotateImageViewer(viewerState.value, 90)
  recenterAfterRotate()
}

function resetView() {
  viewerState.value = resetImageViewer()
  resetStageScroll()
}

function readStoredBoolean(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage?.getItem(key)
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // Ignore private-mode or locked storage; toolbar controls still work for this session.
  }
  return fallback
}

function readStoredFieldRegionSize() {
  if (typeof window === 'undefined') return 'compact'
  try {
    const stored = window.localStorage?.getItem(fieldRegionSizeStorageKey)
    if (fieldRegionSizeOptions.some((option) => option.value === stored)) return stored
  } catch {
    // Ignore private-mode or locked storage; default compact boxes avoid covering receipts.
  }
  return 'compact'
}

function writeStoredValue(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // Best-effort persistence only.
  }
}

function setFieldRegionSize(size) {
  if (!fieldRegionSizeOptions.some((option) => option.value === size)) return
  fieldRegionSize.value = size
  writeStoredValue(fieldRegionSizeStorageKey, size)
}

// 字段框的坐标系是**切片**,原图态画不出来(displayFieldRegions 在原图态返回 [])。
// 主态翻转后这就成了新的死路:按钮亮着、有计数、点了什么都不发生 ——
// 和今天刚修掉的「画框(这条不行)」是同一种病。
// 所以在原图态点它 = 直接切到切片视图,那儿它真的能用。一次点击到位,不是空点。
function toggleFieldRegions() {
  if (showOriginal.value && fieldRegionCount.value) {
    showOriginal.value = false
    showFieldRegions.value = true
    return
  }
  showFieldRegions.value = !showFieldRegions.value
}
const fieldRegionTitle = computed(() => (
  showOriginal.value && fieldRegionCount.value
    ? '字段框是按切片坐标画的,原图上对不上位置 —— 点这里切到切片视图看'
    : '显示或隐藏字段定位框'
))

// 0729:字段框改成和文档框同一口径(归一化 0~1)。
// 原来字段框是**自然像素**坐标(PaddleX 时代),文档框是归一化,两套坐标系并存 ——
// 谁哪天想统一这两个函数就会静默画歪。现在 qwen 供的字段框本来就是比例,
// 借这次补数据一次性并成一套,那个坑直接消失。
function regionStyle(region) {
  const box = region?.box || {}
  return {
    left: `${Number(box.left) * 100}%`,
    top: `${Number(box.top) * 100}%`,
    width: `${Number(box.width) * 100}%`,
    height: `${Number(box.height) * 100}%`,
  }
}

function regionClass(region) {
  return {
    active: region?.key === props.activeFieldKey,
    'low-confidence': Number(region?.confidence || 0) > 0 && Number(region.confidence) < 0.7,
  }
}

function regionTitle(region) {
  const confidence = Number(region?.confidence || 0)
  const score = confidence ? ` - ${Math.round(confidence * 100)}%` : ''
  const value = region?.value ? ` - ${region.value}` : ''
  return `${region?.label || '字段'}${score}${value}`
}

function selectRegion(region) {
  emit('on-field-region-select', region?.key || '')
}

// ⚠️ 文档框和字段框的坐标口径**不一样**,不能共用 regionStyle:
//   字段框 box = 自然像素坐标(所以上面要除 naturalWidth/Height)
//   文档框 box = 归一化 0~1(后端 review_doc_regions 直接给比例)
// 混用不会报错,只会把框画到错误的位置 —— 所以分开写并各自有测试。
function docRegionStyle(region) {
  const box = region?.box || {}
  return {
    left: `${Number(box.left) * 100}%`,
    top: `${Number(box.top) * 100}%`,
    width: `${Number(box.width) * 100}%`,
    height: `${Number(box.height) * 100}%`,
  }
}

function docRegionClass(region) {
  return {
    current: Boolean(region?.isCurrent),
    suspect: Boolean(region?.suspect),
  }
}

function docRegionTitle(region) {
  if (region?.suspect) {
    // 口径 v3(两轮生产实测后定的):suspect 现在专指「和另一条任务票号相同」
    // = 同一张票出了两条记录。纯几何重叠已经不报了 —— 实测 94.5% 是两张真的不同的票
    // (字段从整图抽,框重叠不影响字段正确性)。亮 4.47% 的提醒等于没提醒。
    return `${region.label} - 和另一条任务票号相同,很可能是同一张票被框了两次、出了重复记录。请核对后删掉多余的那条`
  }
  return region?.isCurrent ? `${region.label} - 当前这张` : `${region?.label || '单据'} - 点击跳到这张`
}

function selectDocRegion(region) {
  if (!region || region.isCurrent) return
  emit('on-doc-region-select', region.taskId)
}

// ── 手画文档框(0730 第2期)────────────────────────────────────────────
// 只在**看原图**时能画:框是原图坐标系的,在切片上画出来的坐标对不上。
// 拖拽期间不让 startDragPan 抢事件(它靠 drawMode 判定跳过)。
const drawMode = ref(false)
const drawing = ref(false)
const drawRect = ref(null) // { left, top, width, height } 都是 0~1
let drawStart = null

function canvasPointFromEvent(event) {
  const canvas = event.currentTarget?.closest?.('.image-canvas') || event.currentTarget
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  if (!(r.width > 0) || !(r.height > 0)) return null
  // ⚠️ rect 是**旋转后**的外接矩形,所以这个比例是屏幕坐标系的。
  // 必须反旋转回原图坐标系:框存的是原图归一化坐标,预览框也是画在(会被 CSS 转回去的)
  // canvas 内部的百分比。不反转的话,图一旦被 ↺↻ 转过,拖出来的框会显示在别处、
  // 存下去也是歪的,而且全程不报错 —— 交付时按错框裁。
  const screen = {
    x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)),
  }
  return unrotateNormalizedPoint(screen, viewerState.value.rotation)
}

function startDraw(event) {
  if (!drawMode.value || event.button !== 0) return
  const p = canvasPointFromEvent(event)
  if (!p) return
  event.preventDefault()
  event.stopPropagation()
  drawing.value = true
  drawStart = p
  drawRect.value = { left: p.x, top: p.y, width: 0, height: 0 }
}

function moveDraw(event) {
  if (!drawing.value || !drawStart) return
  const p = canvasPointFromEvent(event)
  if (!p) return
  event.preventDefault()
  drawRect.value = {
    left: Math.min(drawStart.x, p.x),
    top: Math.min(drawStart.y, p.y),
    width: Math.abs(p.x - drawStart.x),
    height: Math.abs(p.y - drawStart.y),
  }
}

function endDraw() {
  if (!drawing.value) return
  drawing.value = false
  const r = drawRect.value
  drawStart = null
  // 太小的当误触丢掉(后端也有闸,这里先省一次往返)
  if (!r || r.width < 0.02 || r.height < 0.02) { drawRect.value = null; return }
  emit('on-doc-box-draw', [r.left, r.top, r.left + r.width, r.top + r.height])
}

function cancelDraw() {
  drawing.value = false
  drawStart = null
  drawRect.value = null
  drawMode.value = false
}
// 换任务/切回切片图时退出画框态,避免留一个悬着的半透明框
watch(() => props.task?.id, cancelDraw)
watch(showOriginal, (v) => { if (!v) cancelDraw() })

const drawRectStyle = computed(() => {
  const r = drawRect.value
  if (!r) return null
  return {
    left: `${r.left * 100}%`,
    top: `${r.top * 100}%`,
    width: `${r.width * 100}%`,
    height: `${r.height * 100}%`,
  }
})

onMounted(() => {
  updateStageSize()
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(updateStageSize)
    if (stageRef.value) resizeObserver.observe(stageRef.value)
  } else {
    window.addEventListener('resize', updateStageSize)
  }
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
  } else {
    window.removeEventListener('resize', updateStageSize)
  }
})
</script>

<template>
  <div class="image-viewer">
    <div v-if="imageUrl" class="viewer-toolbar" aria-label="图片查看工具">
      <button type="button" title="适应窗口" @click="resetView">适应</button>
      <button type="button" title="缩小" @click="zoomOut">-</button>
      <button
        v-for="preset in zoomPresets"
        :key="preset.value"
        type="button"
        :class="{ active: Math.round(preset.value * 100) === zoomPercent }"
        :title="preset.label"
        @click="setZoom(preset.value)"
      >
        {{ preset.label }}
      </button>
      <button type="button" title="放大" @click="zoomIn">+</button>
      <span>{{ zoomPercent }}%</span>
      <input
        class="zoom-slider"
        type="range"
        min="25"
        max="600"
        step="5"
        :value="zoomPercent"
        aria-label="缩放比例"
        @input="handleSlider"
      >
      <!-- 旋转:突出(有边框),与缩放条同为"要点得准"的控件 -->
      <button type="button" class="tb-solid" title="左旋转" @click="rotateLeft">↺</button>
      <button type="button" class="tb-solid" title="右旋转" @click="rotateRight">↻</button>
      <!-- 「重置」已删:它和「适应」绑的是同一个 resetView,两个按钮一个功能 -->
      <button
        type="button"
        :title="fieldRegionTitle"
        :class="{ active: showFieldRegions && !showOriginal }"
        :disabled="!fieldRegionCount"
        @click="toggleFieldRegions"
      >
        字段框 {{ fieldRegionCount || '' }}
      </button>
      <div
        v-if="fieldRegionCount && showFieldRegions"
        class="field-region-size-control"
        aria-label="字段框大小"
      >
        <button
          v-for="option in fieldRegionSizeOptions"
          :key="option.value"
          type="button"
          :title="`字段框${option.label}号`"
          :class="{ active: fieldRegionSize === option.value }"
          @click="setFieldRegionSize(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <button
        type="button"
        title="只显示当前正在审核的字段框"
        :class="{ active: showOnlyActiveRegion }"
        :disabled="!fieldRegionCount || !activeFieldKey"
        @click="showOnlyActiveRegion = !showOnlyActiveRegion"
      >
        当前字段
      </button>
      <!-- 框选(文档框)开关:和「字段框」各管各的。只在原图上有意义,所以看裁切图时不显示。 -->
      <button
        v-if="onOriginalView && validDocRegions.length"
        type="button"
        title="显示或隐藏这张原图上的单据框"
        :class="{ active: showDocRegions }"
        @click="showDocRegions = !showDocRegions"
      >
        框选
      </button>
      <button
        v-if="onOriginalView && showDocRegions && validDocRegions.length > 1"
        type="button"
        title="把这张原图上其它单据的框也画出来——用来查「哪块没被框住 = 漏识别」"
        :class="{ active: showAllDocRegions }"
        @click="showAllDocRegions = !showAllDocRegions"
      >
        显示全部 {{ validDocRegions.length }}
      </button>
      <!-- 手画文档框(0730 第2期):导出说明里那句「框出各自的范围后重新导出」
           在这之前是做不到的 —— 等于让人去做一件不存在的操作。 -->
      <!-- ⚠️ 做不到的时候必须置灰,并把**后端给的原因**放在悬停上。
           0730 用户实测踩到死路:他在一条指向切片文件的任务上点「画框」,
           后端 400 拒绝,而按钮一直可点 —— 点了、失败了、提示没变,以为系统坏了。
           能不能画由后端 canDrawBox 说(单一真相源),前端不复制那套判断。 -->
      <button
        v-if="onOriginalView"
        type="button"
        class="draw-box-toggle"
        :class="{ active: drawMode, 'is-blocked': !canDrawBox.ok }"
        :disabled="!canDrawBox.ok"
        :title="drawBoxTitle"
        @click="drawMode ? cancelDraw() : (drawMode = true)"
      >
        {{ drawMode ? '取消画框' : (canDrawBox.ok ? '画框' : '画框(这条不行)') }}
      </button>
      <button
        v-if="onOriginalView && task?.docBoxSource === 'manual'"
        type="button"
        class="draw-box-clear"
        title="清掉这条任务上人工画的框,回到没有框的状态"
        @click="emit('on-doc-box-draw', null)"
      >
        清除框
      </button>
      <button
        v-if="originalImageUrl"
        type="button"
        class="original-toggle"
        :title="showOriginal
          ? '切到系统裁好的那张切片(兜底用:原图缺失、或要看字段定位框时)'
          : '回到主态:整页原图,自动对到这条任务的框上'"
        :class="{ active: !showOriginal }"
        @click="showOriginal = !showOriginal"
      >
        {{ showOriginal ? '看切片' : '回原图' }}
      </button>
      <!-- 一键入口:切片视图上看不到框,不给个提示就等于这功能不存在(0729 反馈)。
           标红橙是因为「这张图上还有别的票」本身就是要留意的信号。 -->
      <button
        v-if="docRegionHintCount > 1"
        type="button"
        class="doc-region-entry"
        title="这张切片是从一张多单据的照片上裁出来的。框画在原图上(切片本身就是那个框,在它上面画框没有信息);点这里看原图和框 —— 没被框住的部分就是漏识别的"
        @click="showOriginal = true"
      >
        同图 {{ docRegionHintCount }} 张单据 · 到原图看框
      </button>
    </div>
    <div
      v-if="imageUrl"
      ref="stageRef"
      class="image-stage"
      :class="{ 'is-panning': isPanning }"
      @wheel="handleWheelZoom"
      @pointerdown="startDragPan"
      @pointermove="moveDragPan"
      @pointerup="endDragPan"
      @pointercancel="endDragPan"
    >
      <div ref="shellRef" class="image-shell" :style="shellStyle">
        <div
          ref="canvasRef"
          class="image-canvas"
          :class="{ 'is-drawing': drawMode, 'is-focusing': focusing }"
          :style="canvasStyle"
          @pointerdown="startDraw"
          @pointermove="moveDraw"
          @pointerup="endDraw"
          @pointercancel="cancelDraw"
        >
          <img :src="imageUrl" alt="" decoding="async" draggable="false" @load="handleImageLoad" @error="handleImageError">
          <div
            v-if="showFieldRegions && displayFieldRegions.length"
            class="field-region-layer"
            :style="fieldRegionLayerStyle"
            aria-label="字段定位框"
          >
            <button
              v-for="region in displayFieldRegions"
              :key="`${region.key}:${region.modelLabel}`"
              type="button"
              class="field-region-box"
              :class="regionClass(region)"
              :style="regionStyle(region)"
              :title="regionTitle(region)"
              @click.stop="selectRegion(region)"
            />
          </div>
          <!-- 正在拖的那个框(松手即提交) -->
          <div v-if="drawRectStyle" class="draw-box-preview" :style="drawRectStyle" aria-hidden="true" />
          <!-- 文档框(第1期):看原图时画出「这张图上识别出了哪几张单据」。
               只描边不填充、标签悬停才出 —— 小票文字密集,任何填充都降低可读性。 -->
          <div
            v-if="displayDocRegions.length"
            class="doc-region-layer"
            aria-label="这张原图上识别出的单据框"
          >
            <button
              v-for="region in displayDocRegions"
              :key="region.taskId"
              type="button"
              class="doc-region-box"
              :class="docRegionClass(region)"
              :style="docRegionStyle(region)"
              :title="docRegionTitle(region)"
              @click.stop="selectDocRegion(region)"
            >
              <span class="doc-region-label">{{ region.label }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-if="drawMode" class="draw-box-tip">
        <span>在图上拖一个框,把「这条任务对应的那张单据」整个框进去,松手即保存</span>
        <!-- P4:键位要写在人正在看的地方。写进帮助文档等于没写 —— 正在画框的人
             不会去翻文档,他就盯着这块提示。 -->
        <span class="draw-box-tip-hint">框太小或框住几乎整张图都会被拒 · Esc 退出 · Backspace 清掉已存的框</span>
      </div>
      <!-- 没被框住的那块只能靠人眼看出来,所以要把「一共框出几张」摆在明面上 -->
      <div v-if="onOriginalView && validDocRegions.length" class="doc-region-hint">
        <span>这张原图识别出 {{ validDocRegions.length }} 张单据</span>
        <strong v-if="suspectDocRegionCount">· {{ suspectDocRegionCount }} 条票号重复(同一张票框了两次)</strong>
        <span class="doc-region-hint-tip">没被框住的部分 = 漏识别</span>
      </div>
      <!-- 裂图覆盖层(2026-07-28):原图也挂/资源404 时盖住破图标,给出原因+重试 -->
      <div v-if="brokenImage" class="viewer-empty-state viewer-broken-overlay">
        <span class="ves-icon" aria-hidden="true">⚠</span>
        <strong>图片加载失败</strong>
        <p>可能是网络波动或文件已被移动。</p>
        <button type="button" class="ves-retry" @click="retryBrokenImage">重新加载</button>
      </div>
    </div>
    <!-- 缩略图定位器(0730 修位):**必须挂在 .image-viewer 上,不能放 .image-stage 里** ——
         那个容器既是定位锚又 overflow:auto,absolute 会相对「整块可滚动内容」定位,
         放大 350% 后内容巨大,定位器就跑到画面中间挡住票面(生产截图实证)。 -->
    <div v-if="showLocator" class="doc-locator">
      <button
        type="button"
        class="doc-locator-head"
        :title="locatorCollapsed ? '展开缩略图' : '收起缩略图(它会挡住票面)'"
        @click="locatorCollapsed = !locatorCollapsed"
      >
        <span class="doc-locator-title">整张照片</span>
        <span class="doc-locator-sub">第 {{ locatorOrdinal.index }}/{{ locatorOrdinal.total }} 张</span>
        <span class="doc-locator-fold" aria-hidden="true">{{ locatorCollapsed ? '▸' : '▾' }}</span>
      </button>
      <button
        v-if="!locatorCollapsed"
        type="button"
        class="doc-locator-thumb"
        :title="`这张照片上共 ${locatorOrdinal.total} 张单据,当前是第 ${locatorOrdinal.index} 张 —— 点开看原图和框`"
        @click="showOriginal = true"
      >
        <img :src="originalImageUrl" alt="" decoding="async" draggable="false">
        <span
          v-for="region in validDocRegions"
          :key="`loc-${region.taskId}`"
          class="doc-locator-box"
          :class="{ current: region.isCurrent }"
          :style="docRegionStyle(region)"
        />
      </button>
      <span v-if="!locatorCollapsed" class="doc-locator-cap">红框=当前这条 · 点开看框</span>
    </div>
    <!-- 空态占位(2026-07-28):「有任务但没图」与「没选任务」各说各话,不再白板 -->
    <div v-else-if="task && !imageUrl" class="viewer-empty-state">
      <span class="ves-icon" aria-hidden="true">🖼</span>
      <strong>该任务没有可显示的图片</strong>
      <p>需重拍/异常件可能没有切图 —— 可在右侧「更多」里追加图片或标记重拍。</p>
    </div>
    <div v-else class="empty">选择一张图片后预览</div>
  </div>
</template>

<style scoped>
.image-viewer {
  position: relative; /* 缩略图定位器的锚 —— 不能锚在会滚动的 .image-stage 上 */
  display: grid;
  grid-template-rows: auto minmax(360px, 1fr);
  min-height: 420px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f5f7fa;
  overflow: hidden;
}

/* 单行工具栏(2026-07-26 用户需求:太高,合并成一行)。
   nowrap + 溢出横向滚动:窄屏也不再换行把图片区往下挤。 */
.viewer-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  scrollbar-width: thin;
}

/* 默认=无框文字按钮(数字/文字档位不必用框来突出),hover 才给浅底 */
.viewer-toolbar button {
  min-width: 26px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 0 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}
.viewer-toolbar button:hover:not(:disabled) { background: var(--surface-soft, #f1f5f9); color: var(--text); }

/* 选中的档位:只加重字色,不画框 */
.viewer-toolbar button.active {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: transparent;
}

/* 需要"点得准"的两类给实边框突出:旋转按钮 + 缩放条(见 .zoom-slider) */
.viewer-toolbar button.tb-solid {
  border-color: var(--line);
  background: #fff;
  color: var(--text);
}
.viewer-toolbar button.tb-solid:hover:not(:disabled) { border-color: var(--line-strong, #cbd5e1); background: #fff; }

.viewer-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.field-region-size-control {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--line);
}

.viewer-toolbar .original-toggle {
  margin-left: auto;
}

.viewer-toolbar .field-region-size-control button {
  min-width: 26px;
  padding: 0 6px;
}

.viewer-toolbar span {
  min-width: 40px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex: none;
}

/* 缩放条:与旋转键同为"要点得准"的控件 → 给浅底+边框托一下,从一排文字里凸出来 */
.zoom-slider {
  flex: 0 0 auto;
  width: 96px;
  min-width: 96px;
  accent-color: var(--accent);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 6px;
  margin: 0 2px;
}

.image-stage {
  position: relative; /* 裂图覆盖层(.viewer-broken-overlay)的定位锚 */
  display: flex;
  align-items: flex-start;
  /* 不能用 justify-content:center:内容超宽时左侧溢出区无法滚动到(scrollLeft 下限 0),
     放大 300%+ 左半张图永远看不到。改由 .image-shell 的 margin:auto 居中——
     小图居中效果一样,超宽时 auto 边距归零,左右两侧都能滚到。 */
  justify-content: flex-start;
  min-height: 0;
  overflow: auto;
  padding: 0;
  /* 滚动条常显:Windows overlay 滚动条默认隐藏,审核员不知道图片可以滚 */
  scrollbar-width: thin;
  scrollbar-color: #94a3b8 #e2e8f0;
}

.image-stage {
  cursor: grab;
}

.image-stage.is-panning {
  cursor: grabbing;
  user-select: none;
}

.image-stage::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.image-stage::-webkit-scrollbar-track {
  background: #e2e8f0;
  border-radius: 5px;
}

.image-stage::-webkit-scrollbar-thumb {
  background: #94a3b8;
  border-radius: 5px;
}

.image-stage::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}

.image-shell {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  margin: auto; /* 与 stage 的 flex-start 配套:小图居中,大图可滚满全图 */
  padding: 96px;
  box-sizing: border-box;
}

.image-canvas {
  display: grid;
  place-items: center;
  position: relative;
  transform-origin: center center;
  transition: transform 0.12s ease;
}
/* 自动对框期间不走动画:对框是「改缩放→量 rect」,动画中量到的是插值,
   会让缩放倍数算错(0731 实测:框占到视口 1.88x1.63)。手动缩放的动画不受影响。 */
.image-canvas.is-focusing {
  transition: none;
  filter: drop-shadow(0 12px 22px rgba(17, 32, 56, 0.18));
}

.image-canvas img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
}

.field-region-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 文档框(第1期)。设计约束:**框不能遮盖信息**,所以和字段框的做法刻意不同——
   字段框有半透明填充(字段区就那么点大,盖一下无妨),文档框罩的是整张单据,
   任何填充都会让整张小票变灰、字更难认。这里只描边、不填充。 */
.doc-region-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.doc-region-box {
  position: absolute;
  padding: 0;
  border: 2px dashed #94a3b8; /* 兄弟框:灰阶(硬规则——灰=其余) */
  border-radius: 2px;
  background: transparent; /* 绝不填充 */
  cursor: pointer;
  pointer-events: auto;
}

/* 当前这张:蓝(硬规则——蓝=可点击/当前焦点)。实线区分于兄弟框的虚线,
   即使色觉障碍也能靠线型分辨,不只靠颜色。 */
/* 当前这张改红(0730 用户反馈:黑/蓝太不明显)。切图核对本来就是「要处理」语义,
   而且这是这个功能的主职 —— 必须一眼看见。仍然只描边不填充,不遮票面。 */
.doc-region-box.current {
  border-style: solid;
  border-width: 3px;
  border-color: #e11d48;
  cursor: default;
}

/* 框重叠可疑:红橙(硬规则——红橙=要处理)。这是「两张票被框成一张」的信号,
   生产实测 11.4% 的多票图会命中,不是零星情况。 */
.doc-region-box.suspect {
  border-color: #dc2626;
  border-style: solid;
}

/* 标签默认不显示,悬停才出,且贴在框**外侧上方** —— 压在框里就挡住票面文字了。
   框贴顶时 CSS 兜不住会跑出画布,所以给了 top:100% 的兜底见下。 */
.doc-region-label {
  position: absolute;
  left: -2px;
  bottom: calc(100% + 3px);
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.86);
  color: #fff;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.12s ease;
  pointer-events: none;
}

.doc-region-box:hover .doc-region-label,
.doc-region-box:focus-visible .doc-region-label,
.doc-region-box.suspect .doc-region-label {
  opacity: 1;
}

/* 框顶在图片上沿时,标签翻到框内下方,不会被画布裁掉 */
.doc-region-box[style*="top: 0%"] .doc-region-label {
  bottom: auto;
  top: calc(100% + 3px);
}

.doc-region-box.current .doc-region-label { background: #e11d48; }
.doc-region-box.suspect .doc-region-label { background: #dc2626; }

.doc-region-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  background: #f8fafc;
  color: #475467;
  font-size: 12px;
}

/* 画框态:光标改十字,告诉人现在是画框不是拖动 */
.image-canvas.is-drawing { cursor: crosshair; }

/* 正在拖的框:虚线 + 极浅填充。这里**允许**一点填充 —— 它是短暂的操作反馈,
   不是长期覆盖在票面上的东西(和文档框"绝不填充"那条不冲突)。 */
.draw-box-preview {
  position: absolute;
  border: 2px dashed #e11d48;
  background: rgba(225, 29, 72, 0.1);
  pointer-events: none;
}

.viewer-toolbar .draw-box-toggle {
  border-color: #fecdd3;
  background: #fff1f2;
  color: #be123c;
  font-weight: 500;
}
.viewer-toolbar .draw-box-toggle.active { background: #e11d48; border-color: #e11d48; color: #fff; }
/* 做不到的时候置灰(不是红) —— 红色会让人以为点这里能解决,而它恰恰不能 */
.viewer-toolbar .draw-box-toggle.is-blocked {
  border-color: #e4e7ec;
  background: #f9fafb;
  color: #98a2b3;
  cursor: not-allowed;
  font-weight: 400;
}
/* 清除框:灰阶(硬规则——灰=其余)。它是撤销口,不该和「画框」抢注意力。 */
.viewer-toolbar .draw-box-clear { color: #667085; }

.draw-box-tip {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  background: #fff1f2;
  border: 0.5px solid #fecdd3;
  color: #9f1239;
  font-size: 12px;
}
.draw-box-tip-hint { color: #be123c; opacity: 0.75; }

/* 缩略图定位器。贴右下角、绝不压票面正中;不用 position:fixed(会被 stage 滚动带跑)。
   小到只回答一个问题:「我是这张照片上的哪一块」。 */
.doc-locator {
  position: absolute;
  right: 14px;
  bottom: 18px; /* 躲开常显的横向滚动条 */
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  padding: 5px 6px 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  border: 0.5px solid #d0d5dd;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.14);
}

/* 不解释自己是什么的小图 = 看不懂的干扰物(0730 用户反馈「这个缩略图什么意思」) */
.doc-locator-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}
.doc-locator-fold { margin-left: auto; font-size: 10px; color: #98a2b3; }
.doc-locator-title { font-size: 11px; font-weight: 500; color: #344054; }
.doc-locator-sub { font-size: 10px; color: #e11d48; }

.doc-locator-thumb {
  position: relative;
  display: block;
  /* 限高优先:竖照片按宽度算会拉到 230px+,挡掉一大片票面(0730 实测)。
     用 max-height 卡住,宽度自适应 —— 宁可小一点,也不能挡字。 */
  width: auto;
  max-width: 132px;
  max-height: 150px;
  padding: 0;
  border: 0.5px solid #d0d5dd;
  border-radius: 6px;
  background: #fff;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.16);
}

.doc-locator-thumb img { display: block; max-width: 132px; max-height: 150px; width: auto; height: auto; }
.doc-locator-thumb:hover { border-color: #e11d48; }

/* 缩略图里的兄弟框只给最淡的存在感——它们的作用是让"当前那块"有参照,不是让人去读 */
.doc-locator-box {
  position: absolute;
  border: 1px solid rgba(148, 163, 184, 0.75);
  border-radius: 1px;
  pointer-events: none;
}

.doc-locator-box.current {
  border: 2px solid #e11d48;
  background: rgba(225, 29, 72, 0.18);
}

.doc-locator-cap {
  font-size: 10px;
  color: #667085;
  text-align: center;
}

/* 切片视图上的一键入口。红橙(硬规则:红橙=要处理)——「这张图上还有别的票」
   本身就是要留意的信号,而且它是这个功能唯一的可见入口,不能做成灰按钮埋掉。 */
.viewer-toolbar .doc-region-entry {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
  font-weight: 500;
}
.viewer-toolbar .doc-region-entry:hover { background: #fee2e2; border-color: #fca5a5; }

.doc-region-hint strong { color: #b91c1c; font-weight: 500; }
.doc-region-hint-tip { color: #98a2b3; }

.field-region-box {
  position: absolute;
  min-width: 18px;
  min-height: 14px;
  border: var(--field-region-border-width, 1px) solid #f59e0b;
  border-radius: var(--field-region-radius, 3px);
  background: rgba(245, 158, 11, var(--field-region-fill-opacity, 0.07));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6), 0 3px 9px rgba(15, 23, 42, 0.14);
  cursor: pointer;
  pointer-events: auto;
}

.field-region-box.active {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.18);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.16), 0 5px 12px rgba(37, 99, 235, 0.2);
}

.field-region-box.low-confidence {
  border-color: #ef4444;
  background: rgba(239, 68, 68, 0.14);
}

/* 空/裂态占位(2026-07-28):居中卡片,图标+一句原因+一步动作 */
.viewer-empty-state {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  padding: 32px 16px;
  text-align: center;
  color: var(--muted);
}
.viewer-empty-state strong { color: var(--text); font-size: 14px; }
.viewer-empty-state p { margin: 0; font-size: 12px; max-width: 320px; line-height: 1.6; }
.ves-icon { font-size: 26px; opacity: 0.5; }
.ves-retry {
  margin-top: 6px; border: 1px solid var(--line-strong); border-radius: 6px;
  background: #fff; color: var(--text); font-size: 12px; padding: 5px 14px; cursor: pointer;
}
.ves-retry:hover { border-color: var(--accent); color: var(--accent); }
.viewer-broken-overlay {
  position: absolute; inset: 0; z-index: 3;
  background: rgba(245, 247, 250, 0.96);
}
</style>