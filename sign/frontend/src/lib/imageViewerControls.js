const MIN_ZOOM = 0.25
const MAX_ZOOM = 6
const ZOOM_STEP = 0.25

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeRotation(value) {
  return ((Number(value || 0) % 360) + 360) % 360
}

export function createImageViewerState() {
  return { zoom: 1, rotation: 0 }
}

export function zoomImageViewer(state = createImageViewerState(), direction = 1) {
  return setImageViewerZoom(
    state,
    Number(state.zoom || 1) + (Number(direction || 0) * ZOOM_STEP)
  )
}

export function setImageViewerZoom(state = createImageViewerState(), zoom = 1) {
  const numericZoom = Number(zoom)
  return {
    ...state,
    zoom: Number(clamp(Number.isFinite(numericZoom) ? numericZoom : 1, MIN_ZOOM, MAX_ZOOM).toFixed(2)),
  }
}

export function rotateImageViewer(state = createImageViewerState(), degrees = 90) {
  return {
    ...state,
    rotation: normalizeRotation(Number(state.rotation || 0) + Number(degrees || 0)),
  }
}

export function resetImageViewer() {
  return createImageViewerState()
}

export function buildImageTransform(state = createImageViewerState()) {
  return `scale(${Number(state.zoom || 1)}) rotate(${normalizeRotation(state.rotation)}deg)`
}

// ── 自动对框(P1 主态翻转)────────────────────────────────────────────
// 用户要的是:「都是原图,我直接定位到我的这个任务」。
// 实现上等于——显示整张原图,但把视口缩放/平移到当前任务那个框上。
//
// 为什么这里吃「量出来的 canvasRect」而不是自己算:
// 组件里 zoom=1 的含义是**适应窗口**(baseImageSize 已按 stage 缩过一轮),
// 上面再叠 CSS transform(scale + rotate)。在这儿复现那套数学 = 同一份几何写两遍,
// 迟早漂。量图片元素的外接矩形,缩放和旋转天然都在里面。

/**
 * 把原图归一化框转到**屏幕方向**。
 * 框存的是原图坐标,而审核员会把竖拍小票转正 —— 不转框就画到别处去了。
 * @param {{left:number,top:number,width:number,height:number}} box
 * @param {number} rotation 角度,任意值(内部归一到 0/90/180/270)
 */
export function rotateNormalizedBox(box, rotation = 0) {
  const steps = ((Math.round(Number(rotation || 0) / 90) % 4) + 4) % 4
  let { left, top, width, height } = box || {}
  for (let i = 0; i < steps; i += 1) {
    // 顺时针 90°:点 (x,y) → (1-y, x)
    const nextLeft = 1 - Number(top) - Number(height)
    const nextTop = Number(left)
    const nextWidth = Number(height)
    const nextHeight = Number(width)
    left = nextLeft
    top = nextTop
    width = nextWidth
    height = nextHeight
  }
  return { left: Number(left), top: Number(top), width: Number(width), height: Number(height) }
}

/**
 * rotateNormalizedBox 的**反函数**(作用在点上)。
 *
 * 为什么需要:画框时量的是 canvas 的 getBoundingClientRect(),那是**旋转后**的外接矩形,
 * 于是算出来的比例是屏幕坐标系的。直接当原图坐标存下去,图被 ↺↻ 转过之后框就是歪的——
 * 而且不报错:界面上框跑到别处、交付时按错框裁。
 * @param {{x:number,y:number}} point 屏幕坐标系下的 0~1 比例
 * @param {number} rotation 图当前的旋转角
 */
export function unrotateNormalizedPoint(point, rotation = 0) {
  const steps = ((Math.round(Number(rotation || 0) / 90) % 4) + 4) % 4
  let x = Number(point?.x)
  let y = Number(point?.y)
  for (let i = 0; i < steps; i += 1) {
    // 正向是 (x,y) → (1-y, x);反过来就是 (X,Y) → (Y, 1-X)
    const nextX = y
    const nextY = 1 - x
    x = nextX
    y = nextY
  }
  return { x, y }
}

/**
 * 算「把这个框放满视口」需要的缩放倍数,以及框心的屏幕坐标。
 * @returns {{factor:number,centerX:number,centerY:number}|null} 退化输入返回 null,
 *   **不返回 Infinity/NaN** —— 那种值传进 scrollLeft 会把图打飞,而且不报错。
 */
export function computeBoxFit({ box, rotation = 0, canvasRect, stageWidth, stageHeight, fill = 0.92 } = {}) {
  if (!box || !canvasRect) return null
  const rect = { width: Number(canvasRect.width), height: Number(canvasRect.height) }
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  if (!(Number(stageWidth) > 0) || !(Number(stageHeight) > 0)) return null

  const r = rotateNormalizedBox(box, rotation)
  const boxWidth = r.width * rect.width
  const boxHeight = r.height * rect.height
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null

  // 两轴取更紧的那个:只满足一轴会把框顶出视口
  const factor = Math.min(
    (Number(stageWidth) * fill) / boxWidth,
    (Number(stageHeight) * fill) / boxHeight,
  )
  return {
    factor,
    centerX: Number(canvasRect.left) + (r.left + r.width / 2) * rect.width,
    centerY: Number(canvasRect.top) + (r.top + r.height / 2) * rect.height,
  }
}
