// ══ 配置台「一键保存」快照(P3c 复核 CRITICAL 根治)══
//
// 病根回放:一键保存循环里,第一家店档案存完会刷新 storeDraft(loadReviewConfigData 整体重建),
// 把第二家**还没提交**的勾选草稿冲回服务器旧值——第二家随后保存的是旧值(静默 no-op),UI 还打✓。
//
// 根治:循环开始前把每家的 fields + 乐观锁水位定格成快照,保存循环只消费快照、
// 绝不回读会被刷新的 storeDraft;全部提交完才统一刷新一次。
// 本文件保持纯模块(零 vue/axios 依赖)——node 测试直接 import 真执行,快照语义有行为级断言锁死。

export function planStoreSaveSnapshots(families, storeDraft, storeProfiles) {
  return (families || []).map((family) => {
    const profile = (storeProfiles || []).find((store) => store.family === family) || null
    return {
      family,
      label: profile?.label || family,
      fields: [...(storeDraft?.[family] || [])],
      expectBaseVersion: profile?.config?.version ?? 0,
    }
  })
}
