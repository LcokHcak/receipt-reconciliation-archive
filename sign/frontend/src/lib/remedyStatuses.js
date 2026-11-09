// 「异常补救」的口径:哪些团号匹配状态算待补救。
//
// 抽出来是因为 0731 加审核台承接角标时会出现第二份 —— 而**两份各自维护必然漂**:
// 有人往补救页加一个状态、忘了改角标,角标就开始显示 3、点进去看见 7。
// 数字对不上在界面上没有任何报错,只会让人觉得系统在瞎报,然后连对的那些也不信了。
//
// 语义:团号没命中 / 团号有歧义 / 门店对不上 / 代理对不上 / 日期越界 /
//       模式无法归类 / 缺日期。都是「系统尽力了,只能人来定」。
export const REMEDY_TOUR_STATUSES = Object.freeze([
  'tour_not_found',
  'tour_ambiguous',
  'tour_store_mismatch',
  'agent_mismatch',
  'date_out_of_window',
  'mode_unresolved',
  'date_missing',
])
