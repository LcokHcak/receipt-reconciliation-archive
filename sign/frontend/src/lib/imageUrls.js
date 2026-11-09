// 审核台图片 URL 的单一真相源(2026-07-31)。
//
// 为什么要单独一份:0727#11「图片缓冲不出来」的修法有两半 —— ①查看器默认走缩放端点
// ②预取下两组时也走同一个 URL(不然预热的是另一份,既没命中缓存又白抢窄带宽)。
// 这两半原来各写各的 replace,靠注释约定"URL 一致缓存必命中"。0730 的 P1 主态翻转
// 把默认视图换成了**第三个 URL**(task.originalImageUrl 裸出),两半同时失效而没人报错:
// 查看器不过端点、预取热的还是切片。典型的"同一个事实两个读者"。
//
// 现在规则只在这里:
//   切片/缩略档 → /storage-preview/...            (服务端 1600px)
//   看整张原图档 → /storage-preview/...?edge=2400  (服务端 2400px 上限;入库上限也是 2400,
//                                                 所以对入库之后的图等于不缩,只是给存量大图兜底)
// 非 /storage 开头的 URL(外链/data:/空)原样返回,不硬套。

const STORAGE_PREFIX = /^\/storage\//;

export function toPreviewUrl(url) {
  return String(url || '').replace(STORAGE_PREFIX, '/storage-preview/');
}

// 「看整张原图」那一档:1600 不够用——一张票常只占照片 1/3 宽,1600 档下那块只有 ~530px,
// 自动放大到框上会糊;2400 档下 ~800px,够。
export function toOriginalViewUrl(url) {
  const raw = String(url || '');
  const preview = toPreviewUrl(raw);
  return preview === raw ? raw : `${preview}?edge=2400`;
}
