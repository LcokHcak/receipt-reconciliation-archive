// 上传后台队列核心(T6-B,2026-07-21 拍板):点「建档」即入队、立刻可录下一个客户。
// 管道再慢(实测跨境上行 ~0.1-0.8Mbps,p90 上传 93s)人不等——录入吞吐与网络解耦。
//
// 设计红线(上传全链路审计 docs/T6 后定):
//   保序:上传严格单飞串行(串图前科,绝不并行写多客户);单客户内文件顺序在单个
//        multipart 里天然保持;识别(preprocess)不占上行,后置并行不破序。
//   重试语义与 api 层 uploadRetry 对齐:瞬断(ERR_NETWORK/502-504)api 层已自动重试;
//        走到本层的失败分两类——超时 ECONNABORTED=服务端可能已处理(重发=重复建档!),
//        标 ambiguous 要求先核看板;其余(4xx/500/重试穷尽)可直接手动重试。
//   可见性(用户拍板"失败/进度必须看得到"):每客户一行进度签(排队/上传中%/识别中/
//        完成/失败+原因),失败不自动消失,重试/移除由人点。
//   文件持有:失败项保留 File 引用供重试;成功/移除即释放(内存)。
//
// 纯模块零框架依赖:deps 注入 api,Vue 侧用 subscribe 桥接响应式;node:test 可直测。

let seq = 0

const DONE_KEEP_MAX = 30 // 完成项只留最近 N 条,防一整天建档把列表堆爆(失败项永不自动清)

export function createUploadQueueCore({ uploadApi, preprocessApi, onCustomersPayload = null, onPreprocessSettled = null }) {
  if (typeof uploadApi !== 'function') throw new Error('uploadQueueCore: uploadApi required')
  const state = { items: [] }
  const filesById = new Map() // 非响应式持有 File[],成功/移除时释放
  const listeners = new Set()
  let pumping = false

  function notify() { for (const fn of listeners) { try { fn() } catch { /* listener 自理 */ } } }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
  function findItem(id) { return state.items.find((it) => it.id === id) || null }

  function counts() {
    let queued = 0; let active = 0; let failed = 0
    for (const it of state.items) {
      if (it.status === 'queued') queued += 1
      else if (it.status === 'uploading' || it.status === 'recognizing') active += 1
      else if (it.status === 'failed') failed += 1
    }
    return { queued, active, failed, pending: queued + active }
  }

  function enqueue({ agentName, files, workspaceKey, batchId, autoPreprocess = true }) {
    const id = `uq_${Date.now()}_${(seq += 1)}`
    filesById.set(id, Array.isArray(files) ? [...files] : [])
    state.items.push({
      id,
      agentName: String(agentName || '').trim(),
      fileCount: Array.isArray(files) ? files.length : 0,
      workspaceKey: String(workspaceKey || ''),
      batchId: String(batchId || ''),
      autoPreprocess: autoPreprocess !== false,
      status: 'queued', // queued | uploading | recognizing | done | failed
      progress: 0,
      error: '',
      ambiguous: false, // 超时类失败:服务端可能已建档,重试前先核看板
      note: '',
      customerId: '',
    })
    notify()
    pump()
    return id
  }

  // 失败项重试:文件仍在手,重排回队首(先修先传);ambiguous 项由 UI 提示核对后仍允许重试。
  function retry(id) {
    const it = findItem(id)
    if (!it || it.status !== 'failed' || !filesById.has(id)) return false
    it.status = 'queued'
    it.progress = 0
    it.error = ''
    // 移到第一个非进行中位置,保持"先修先传"直觉
    const idx = state.items.indexOf(it)
    state.items.splice(idx, 1)
    const firstQueued = state.items.findIndex((x) => x.status === 'queued')
    state.items.splice(firstQueued === -1 ? state.items.length : firstQueued, 0, it)
    notify()
    pump()
    return true
  }

  function remove(id) {
    const it = findItem(id)
    if (!it || it.status === 'uploading' || it.status === 'recognizing') return false // 在飞不许删
    filesById.delete(id)
    state.items.splice(state.items.indexOf(it), 1)
    notify()
    return true
  }

  // 查看原图(0727反馈#1):失败/排队/在传项仍持有 File,交 UI 做 objectURL 预览——
  // 上传失败时操作员能立刻看到"丢的是哪几张",不用回相册翻。返回副本防外部改动内部数组;
  // done 项已释放(内存红线),预览走看板里的已建档客户,不从这里拿。
  function filesOf(id) {
    const files = filesById.get(id)
    return files ? [...files] : []
  }

  function clearFinished() {
    for (const it of [...state.items]) {
      if (it.status === 'done') { filesById.delete(it.id); state.items.splice(state.items.indexOf(it), 1) }
    }
    notify()
  }

  // 完成项自动瘦身:超过 DONE_KEEP_MAX 从最老的裁(带识别失败 note 的除外——那是给人看的;失败项永不裁)
  function pruneDone() {
    const prunable = state.items.filter((it) => it.status === 'done' && !it.note)
    const excess = prunable.length - DONE_KEEP_MAX
    if (excess <= 0) return
    const drop = new Set(prunable.slice(0, excess).map((it) => it.id))
    for (const id of drop) filesById.delete(id)
    state.items = state.items.filter((it) => !drop.has(it.id))
  }

  function classifyError(error) {
    if (error?.code === 'ECONNABORTED') {
      return { ambiguous: true, text: '上传超时:服务端可能已建档——请先刷新下方客户看板确认,再决定重试(盲目重试会建重复客户)' }
    }
    const text = error?.response?.data?.error || error?.message || '上传失败'
    return { ambiguous: false, text: String(text) }
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        const it = state.items.find((x) => x.status === 'queued')
        if (!it) break
        const files = filesById.get(it.id) || []
        it.status = 'uploading'
        it.progress = 0
        notify()
        try {
          const payload = await uploadApi({
            workspaceKey: it.workspaceKey,
            agentName: it.agentName,
            files,
            batchId: it.batchId,
            onUploadProgress: (event) => {
              const total = Number(event?.total || 0)
              if (total > 0) {
                it.progress = Math.min(100, Math.round((Number(event.loaded || 0) / total) * 100))
                notify()
              }
            },
          })
          it.customerId = payload?.customer?.customerId || payload?.customer?.id || ''
          filesById.delete(it.id) // 成功即释放内存
          if (onCustomersPayload) { try { onCustomersPayload(payload, it) } catch { /* 看板刷新失败不影响队列 */ } }
          if (it.autoPreprocess && it.customerId && typeof preprocessApi === 'function') {
            it.status = 'recognizing'
            notify()
            // 识别不占上行且服务端并发(=10)兜底 → 不阻塞下一个上传,fire-and-track。
            // Promise.resolve() 打底:preprocessApi 同步抛也只流向识别自己的 catch,
            // 绝不能污染外层上传 try——否则"已建档成功"会被误标 failed 且文件已释放无法重试。
            Promise.resolve()
              .then(() => preprocessApi(it.workspaceKey, it.customerId))
              .then(() => { it.status = 'done' })
              .catch(() => { it.status = 'done'; it.note = '识别失败——可在客户看板对该客户重新识别' })
              .then(() => {
                // 识别落定回调:store 用它刷新客户看板——看板不刷新,识别态/低置信度
                // 不可见,且"可同步自动追进当前批次"的 watch 永远等不到 ready(复核 H1)。
                if (onPreprocessSettled) { try { onPreprocessSettled(it) } catch { /* 回调自理 */ } }
                pruneDone()
                notify()
              })
          } else {
            // 没跑识别就不触发 onPreprocessSettled(上传成功那一刻 onCustomersPayload 已刷过看板)
            it.status = 'done'
            pruneDone()
            notify()
          }
        } catch (error) {
          const { ambiguous, text } = classifyError(error)
          it.status = 'failed'
          it.ambiguous = ambiguous
          it.error = text
          notify()
          // 单个失败不堵队列:标红留给人处理,继续传下一个(顺序=完成顺序,失败项重试后靠后属预期)
        }
      }
    } finally {
      pumping = false
    }
    // 收尾竞态:循环退出瞬间若有新入队(enqueue 已调 pump 但被 pumping 挡),补一脚
    if (state.items.some((x) => x.status === 'queued')) pump()
  }

  return { state, enqueue, retry, remove, clearFinished, counts, subscribe, filesOf }
}
