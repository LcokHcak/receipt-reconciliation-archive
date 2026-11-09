'use strict';

/**
 * builtin_export_plan_specs — 内置导出计划的**只读规则说明**(2026-07-15,用户:内置是黑盒看不见配置)。
 *
 * 定位:内置计划由在产 planner/导出服务承载,**不改写成可编辑 DSL**
 * (架构裁决:防第二真相源,副本失步病史)。但"看不见里面是什么"是真痛点——
 * 本文件是与 planner 代码**并列维护**的声明式说明,把黑盒拆成人话规则展示给配置台/资料库。
 * 2026-07-16 资料库P0:现代三池/客户文件夹/客户数据Excel 三个老出口收编入册
 * (一处清单管全部出口;执行仍走各自老端点,这里只是"它存在+规则是什么"的注册)。
 *
 * ⚠️ 这是"描述",不是执行真相:planner 代码才是执行真相。改了 planner 逻辑必须同步这里的文案
 * (和 EXCEL_COLUMN_DEFS need 之类的声明同性质)。字段/条件均对照 services/*_delivery_export_service.js 头注。
 */

const BUILTIN_PLAN_SPECS = Object.freeze({
  // services/mode_delivery_export_service.js
  mode_delivery: Object.freeze({
    summary: '上家交付包:按渠道模式各建一个顶层文件夹;跨多个模式的客户,在每个区各留一份。范围=一个审核批次。',
    rules: Object.freeze([
      Object.freeze({
        title: '规则① 济州乐天SG-道辉',
        when: '模式名以「济州乐天SG-道辉」开头(团号表里写法带"(单独整理)")',
        folder: '济州乐天SG-道辉 / {团号} / {团号}—{英文名}{护照号前4位}',
        files: '{同名前缀}_护照N / _小票N / _机票N（.jpg）',
        note: '按「模式+团号」分桶——同一客户两个团号的小票绝不混进同一文件夹',
      }),
      Object.freeze({
        title: '规则② 现代免税店',
        when: '店家 = 现代免税店(按店判定,不看模式)',
        folder: '现代免税店 /（复用现代交付包三池:护照池 / 机票池 / 小票池)',
        files: '小票按票号带横线命名',
        note: '内容与「现代交付包」单独导出完全一致',
      }),
      Object.freeze({
        title: '规则③ 其他所有模式（兜底）',
        when: '⭐以上都不命中的普通模式,全走这条',
        folder: '{模式名} / {英文名}{护照号前4位}',
        files: '{同名前缀}_护照N / _小票N / _机票N（.jpg）',
        note: '你团号表里没有专门导出计划的普通模式,交付时就落这条规则——这就是"没配置的模式去哪了"的答案',
      }),
      Object.freeze({
        title: '规则④ S活动（叠加在③之上）',
        when: '模式名含「S活动」,或审核台勾了票级「S活动标记」(红标签,2026-07-20 补:S活动是票面属性,查团号查不出)',
        folder: '先按规则③进自己的模式文件夹;小票再复制一份到 S活动 / {模式} / {小票号}',
        files: '第二份以小票号命名(乐天 S活动=14位纯数字、去横线;红标签票按它自己的桶模式格式化)',
        note: '缺小票号 → 阻断导出并列出问题任务(绝不出残包)',
      }),
      Object.freeze({
        title: '规则⑤ 新世界/现代百货上家链（2026-07-20）',
        when: '店家 = 新世界百货 / 现代百货(按店判定;这些票不再进规则③的模式夹)',
        folder: '{上家:梁总|东方|金浦奥莱} / {代理} / {交易编号} —— 一票一夹,夹名就是那张票的交易编号(2026-07-31 拍板)',
        files: '夹里=该票图(以交易编号命名,票面形态 4位-4位)+ 护照.jpg(有独立护照就每夹各放一份)',
        note: '上家=审核的上家字段(空则按档案默认:新世界=梁总/现代=东方);缺交易编码 → 阻断并按上家区归因;'
          + '客户没交护照 → 夹名照旧是交易编号,缺护照在 zip 根「导出说明.txt」按交易编号点名;'
          + '一张照片上两张票且没框出各自范围 → 两张都不出包(防同一张图当两笔账发出去)',
      }),
    ]),
    fallback: '模式为空的客户 → 未归类/;整组未审核 → 跳过并在预览里列名;重名自动加 _2;单张图拷贝失败不致命、留痕。',
  }),

  // services/lotte_dept_delivery_export_service.js
  lotte_dept: Object.freeze({
    summary: '乐天百货交付包(规范 lt.txt;2026-07-20 重构):四门店店名分夹,每个客户夹放小票整图 + 护照。范围=一个审核批次。',
    rules: Object.freeze([
      Object.freeze({
        title: '文件夹层级',
        when: '店家 = 乐天百货',
        folder: '《{收票日期M.D}乐天百货小票》/ {门店店名:明洞|蚕室|釜山|仁川,一店两码并一夹} / 《{购买日期M.D} {英文名}》',
        files: '{交易编号}.jpg(百货小票整图,不切割,票面自带打码护照) + 护照.jpg(独立护照任务图,不打码;无独立护照 → 同框整图兜底)',
        note: '姓名=组级身份选取器(护照任务优先);门店取自审核的门店字段,未识别码原样成夹',
      }),
    ]),
    fallback: '整组已审才交付(未审列 skipped);缺交易编号/门店 → 阻断名单一次全列(绝不出残包);无独立护照不阻断(2026-07-20 拍板:同框票自带打码护照,整图充当护照图并在预检里报数);混店客户只取乐天百货票;同客户多张百货票各按交易编号命名,护照每夹一份。',
  }),

  // services/hyundai_delivery_export_service.js(2026-07-16 收编进注册表:一处清单管全部出口)
  hyundai_delivery: Object.freeze({
    summary: '现代免税店交付格式:按类型三池打包(不是按客户文件夹)。范围=一个审核批次。与「内置·多模式四规则」规则②内容完全一致,这是它的单独出口。',
    rules: Object.freeze([
      Object.freeze({
        title: '三池',
        when: '店家 = 现代免税店(混店客户的护照/机票也进包)',
        folder: '护照 / 机票 / 小票 三个顶层文件夹',
        files: '护照、机票以客人英文名命名;小票以小票号(带横线)命名;一票多图全交(_2 后缀)',
        note: '只导整组已审核的客户,没审完的列 skipped;缺小票号阻断',
      }),
    ]),
    fallback: '整组未审核 → 跳过并列名单;缺小票号 → 阻断导出并列问题任务(绝不出残包)。',
  }),

  // services/batch_customer_data_export_service.js(收编)
  customer_folders: Object.freeze({
    summary: '客户文件夹:批次里每个客户一个文件夹,装该客户的全部原图,打包 zip。范围=一个审核批次。',
    rules: Object.freeze([
      Object.freeze({
        title: '文件夹结构',
        when: '批次内所有客户(不筛模式、不看审核状态)',
        folder: '{客户建档文件夹名} /',
        files: '客户的全部图片原样(重名自动加后缀)',
        note: '最朴素的"按人装箱",不做任何分拣;要按渠道分拣用「内置·多模式四规则」',
      }),
    ]),
    fallback: '没有可导图片的客户不建夹;单张图拷贝失败不致命、留痕。',
  }),

  // services/monthly/library_mode_export_service.js buildWorkbook(收编)
  library_excel: Object.freeze({
    summary: '客户数据 Excel:已结算客户按渠道模式分 sheet,附「需重拍·去回收」sheet。范围=当前筛选(批次/工作区)。',
    rules: Object.freeze([
      Object.freeze({
        title: '表结构',
        when: '已结算进台账的客户(第一页汇总,之后每模式一个 sheet)',
        folder: 'sheet1 汇总(全部模式合在一起)+ 每模式一页 + 末页需重拍',
        // ⚠️ 2026-08-01 按真表重写。旧版这一行是**手抄**的,已经漂出三处:
        // 漏了第 2 列「收票日期」(0724 拍板新增)、没提汇总页、也没说百货页会换叫法。
        // 操作员点开"查看规则"照着核对,核不上只能猜哪个是对的。
        files: '列(共 17,顺序即表内顺序):购买日期/收票日期/团号/姓名/护照号/小票号/代理/上家/'
          + '返点模式/免税店/门店编号/品牌/数量/总卖出(￦)/纯卖出(￦)/客人返点金额/出境日期',
        note: '数据源=月度台账;还没结算的客户不在表里;免税店+门店编号由台账"明洞(0394)"出口拆列,存储不动。'
          + '整页都是百货行的模式页,表头换「交易编号/交易金额(￦)」(0727#13-1);'
          + '汇总页永远用通用叫法(0801 拍板),不随当天数据变。'
          + '收票日期=我们收到并上传那天(客户编号 CLyyyymmdd 优先,取不到回落入库时间),不是审核/结算当天。',
      }),
    ]),
    fallback: '空筛选出「(无已结算数据)」空表;需重拍 sheet 始终附带。',
  }),
});

// 内置计划键的唯一清单(export_plan_engine 校验白名单 / 注册表 lib 共用,别在别处再抄一份)
const BUILTIN_PLAN_KEYS = Object.freeze(Object.keys(BUILTIN_PLAN_SPECS));

function getBuiltinPlanSpec(builtinKey) {
  return BUILTIN_PLAN_SPECS[String(builtinKey || '')] || null;
}

module.exports = { BUILTIN_PLAN_SPECS, BUILTIN_PLAN_KEYS, getBuiltinPlanSpec };
