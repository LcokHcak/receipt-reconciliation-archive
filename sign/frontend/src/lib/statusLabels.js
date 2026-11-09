// 全站状态/枚举中文标签字典 —— 一处定义,各页面统一引用。
// 目的:同一个后端值在所有页面显示同一个中文名,避免操作员困惑(以前"团号未找到/未命中/找不到"三页三名)。

// 团号匹配状态 daily_receipt_export.tour_match_status
export const TOUR_MATCH_STATUS = {
  pending: '待跑团号',
  matched: '已匹配',
  tour_not_found: '团号未命中',
  tour_ambiguous: '团号多候选',
  tour_store_mismatch: '团号店不符',
  agent_mismatch: '代理不一致',
  date_out_of_window: '日期超团期',
  mode_unresolved: '模式未归类',
  skipped_mode_not_required: '待归类',
  date_missing: '缺购买日期',
}

// 审核状态 source_image.process_result —— 注意:这里存的「就是中文值本身」,
// 镜像后端 SSOT lib/workbench_definition.js 的 PROCESS_RESULTS。前端各处比较/统计
// 必须引用此常量,不要再写裸串 '已通过' 等(后端改文案才不会静默失效)。
export const PROCESS_RESULT = {
  CLASSIFY: '待分类确认',
  FIELDS: '待补字段',
  SIGNATURE: '待签字',
  FINAL_REVIEW: '待终审',
  APPROVED: '已通过',
  REPHOTO: '需重拍',
  REJECTED: '已拒绝',
}

// 账单匹配状态 daily_receipt_export.bill_match_status
export const BILL_MATCH_STATUS = {
  unmatched: '未匹配',
  matched: '已匹配',
  pending_review: '待人工',
}

// 台账来源 daily_receipt_export.source_type
export const SOURCE_TYPE = {
  workbench: '审核台',
  imported: '导入',
  manual: '手工',
}

// 流水阶段 match_badcase.stage / pending_review 等
export const STAGE = {
  tour_match: '团号匹配',
  bill_match: '账单匹配',
  merge: '合并',
  manual: '手工',
}

// 坏例裁决 match_badcase.verdict
export const BADCASE_VERDICT = {
  pending: '未处理',
  wrong_match: '匹配错了',
  should_match: '应该匹配上',
  acceptable: '可接受',
}

// 团号匹配失败的人话解释(单一真相源,2026-07-18 从补救台收编):
// 补救台复查 Drawer 与审核台结算面板内联补救共用,禁第二副本。
export const TOUR_REMEDY_HINT = {
  tour_not_found: '这张小票的团号在团号表里查不到 —— 可能代理还没补发团号,或团号写错了。请核对团号。',
  tour_ambiguous: '同一团号在团号表里对应多个模式,系统无法确定归哪个店。请人工指定模式。',
  tour_store_mismatch: '团号在表里,但候选模式都属别家免税店(如票是新世界、表内只有现代模式)。请核对小票店家或团号,改对后重新匹配。',
  agent_mismatch: '小票上的代理(导游)和团号表里登记的代理对不上。请核对是不是同一个人。',
  date_out_of_window: '小票的购买日期不在团号的有效期内。',
  mode_unresolved: '团号匹配上了,但模式不在 7 个标准模式里,无法自动归店。请指定模式。',
  date_missing: '这张小票缺购买日期,无法做日期校验。',
}

// 待补救 / 坏例原因(团号匹配 + 账单匹配两阶段合集)
export const REMEDY_KIND = {
  tour_not_found: '团号未命中',
  tour_ambiguous: '团号多候选',
  tour_store_mismatch: '团号店不符',
  date_out_of_window: '日期超团期',
  agent_mismatch: '代理不一致',
  mode_unresolved: '模式未归类',
  field_conflict: '账单字段冲突',
  ambiguous_match: '账单多候选',
  fuzzy_match: '模糊匹配待确认',
  unmatched: '未匹配',
}

// 月度交付归类桶 daily_receipt_export.mode_folder
export const MODE_FOLDERS = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团']

// 取中文标签;无映射回退原值(不丢信息)
export function labelOf(map, value) {
  if (value == null || value === '') return '—'
  return map[value] || value
}
// 字典 → <select> 选项 [{ value, label }]
export function toOptions(map) {
  return Object.entries(map).map(([value, label]) => ({ value, label }))
}
