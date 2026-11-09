'use strict';
/**
 * 一次性:生成《收票对账系统 — 项目报告》.docx(正式版)。
 *
 * 与 build_report_docx.js(0801 交付报告 = 一次迭代的问题清单)不同,这份是**项目报告**:
 * 项目背景 → 总体架构 → 主要功能与输入输出(配界面截图)→ 技术指标 → 质量保障 →
 * 部署运维 → 后续规划,面向对外汇报。
 *
 * 图片来源 tmp_report_shots/,由 capture_project_report_shots.mjs 采集(每张过内容自检)。
 * 报告里所有数字都能追到仓库里的实测文档(见文末「数据出处」),不写没核过的数。
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak,
  Table, TableRow, TableCell, WidthType, ImageRun, BorderStyle, ShadingType, VerticalAlign,
} = require('docx');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'tmp_report_shots');
const OUT_DIR = path.join(ROOT, '..', '系统交付修改');
const OUT = path.join(OUT_DIR, '收票对账系统-项目报告.docx');

const FONT = '微软雅黑';
const GRAY = 'F2F2F2';
const NAVY = '1F3864';
const MUTED = '595959';
const OK = '1E7B34';
const WARN = 'B26B00';

// A4 纵向、上下左右 1 英寸 → 正文可用宽度 = 11906 - 1440*2 = 9026 DXA
const CONTENT_DXA = 9026;

// ── 必须存在的截图。少一张就退出,绝不悄悄出一份缺图的报告 ─────────────
const SHOT_LIST = [
  '01_登录_系统入口', '02_首页_运营概览', '03_收票建档_上传入口', '04_审核台_识别与确认',
  '05_收票台账_结算产出', '06_月度导入_外部数据', '07_账单匹配_四桶控制台',
  '08_未收清单_催收产出', '09_交付核对_返点合计', '10_配置台_渠道模式',
  '11_审计日志_操作留痕', '12_用户与权限',
];
{
  const missing = SHOT_LIST.filter((n) => !fs.existsSync(path.join(SHOTS, `${n}.png`)));
  const docsMissing = ['receipt_lotte.png', 'passport_huang.png']
    .filter((f) => !fs.existsSync(path.join(SHOTS, 'docs', f)));
  if (missing.length || docsMissing.length) {
    console.error(`缺图 ${missing.length + docsMissing.length} 张:`);
    [...missing.map((m) => `${m}.png`), ...docsMissing].forEach((m) => console.error(`  · ${m}`));
    console.error('\n先跑(需 vite preview 在 5177):');
    console.error('  node scripts/oneoff/make_demo_docs.mjs');
    console.error('  node scripts/oneoff/capture_project_report_shots.mjs');
    process.exit(1);
  }
}

const kids = [];

const P = (text, o = {}) => new Paragraph({
  spacing: { after: o.after ?? 130, before: o.before ?? 0, line: o.line ?? 300 },
  alignment: o.align,
  indent: o.indent,
  children: [new TextRun({
    text, bold: o.bold, italics: o.italics, size: o.size ?? 21, color: o.color, font: FONT,
  })],
});

// ⚠️ 分页一律用标题自带的 pageBreakBefore,不要单独插一段 PageBreak。
// 单插分页符时,若上一段内容恰好已排到页底,Word 会再翻一页 → 整页空白。
// 实测踩过:27 页里第 12、23 页全白。pageBreakBefore 是"从这里另起一页",
// 已经在页首时不会重复翻页,天然免疫这个问题。
const H1 = (text, o = {}) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  pageBreakBefore: Boolean(o.page),
  spacing: { before: o.page ? 0 : 360, after: 180 },
  children: [new TextRun({ text, font: FONT, bold: true, size: 30, color: NAVY })],
});
const H2 = (text, o = {}) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  pageBreakBefore: Boolean(o.page),
  spacing: { before: o.page ? 0 : 260, after: 130 },
  children: [new TextRun({ text, font: FONT, bold: true, size: 24, color: NAVY })],
});

/** 项目符号 */
const LI = (text, o = {}) => new Paragraph({
  spacing: { after: 90, line: 300 },
  bullet: { level: o.level ?? 0 },
  children: [new TextRun({ text, size: 21, font: FONT, color: o.color })],
});

/** 富文本行(局部加粗/着色) */
const rich = (runs, o = {}) => new Paragraph({
  spacing: { after: o.after ?? 130, line: 300 },
  alignment: o.align,
  children: runs.map((r) => new TextRun({
    text: r.t, bold: r.b, color: r.c, italics: r.i, size: r.s ?? 21, font: FONT,
  })),
});

function cell(text, o = {}) {
  const lines = String(text).split('\n');
  return new TableCell({
    width: { size: o.w, type: WidthType.DXA },
    shading: o.head ? { type: ShadingType.CLEAR, fill: GRAY } : (o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined),
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: lines.map((line) => new Paragraph({
      spacing: { after: lines.length > 1 ? 40 : 0, line: 280 },
      alignment: o.align,
      children: [new TextRun({
        text: line, bold: o.head || o.bold, size: o.size ?? 19, color: o.color, font: FONT,
      })],
    })),
  });
}

/** widths: 各列占比(和为 1) */
function table(rows, widths, opts = {}) {
  const cols = widths.map((w) => Math.round(CONTENT_DXA * w));
  return new Table({
    width: { size: CONTENT_DXA, type: WidthType.DXA },
    columnWidths: cols,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'A6A6A6' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'A6A6A6' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D9D9D9' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D9D9D9' },
    },
    rows: rows.map((r, i) => new TableRow({
      tableHeader: i === 0,
      children: r.map((c, j) => {
        const spec = (typeof c === 'object' && c !== null) ? c : { t: c };
        return cell(spec.t, {
          head: i === 0, w: cols[j], align: opts.align?.[j],
          bold: spec.b, color: spec.c, fill: spec.fill,
        });
      }),
    })),
  });
}

function spacer(after = 200) {
  kids.push(new Paragraph({ spacing: { after }, children: [] }));
}

/** 界面截图:1560×950 → 等比缩到正文宽度 */
function shot(name, caption, o = {}) {
  const p = path.join(SHOTS, `${name}.png`);
  const w = o.width ?? 600;
  const h = o.height ?? Math.round(w * (950 / 1560));
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 60 },
    children: [new ImageRun({ data: fs.readFileSync(p), transformation: { width: w, height: h }, type: 'png' })],
  }));
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 220 },
    children: [new TextRun({ text: caption, size: 17, color: MUTED, font: FONT })],
  }));
}

/** 演示单据图(尺寸各异,单独给宽高) */
function docShot(file, caption, w, h) {
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 60 },
    children: [new ImageRun({
      data: fs.readFileSync(path.join(SHOTS, 'docs', file)),
      transformation: { width: w, height: h }, type: 'png',
    })],
  }));
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: caption, size: 17, color: MUTED, font: FONT })],
  }));
}

// ═══════════════════════ 封面 ═══════════════════════
kids.push(new Paragraph({ spacing: { before: 1400, after: 0 }, children: [] }));
kids.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 160 },
  children: [new TextRun({ text: '收票对账系统', size: 26, color: MUTED, font: FONT, characterSpacing: 60 })],
}));
kids.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 100 },
  children: [new TextRun({ text: '项 目 报 告', size: 56, bold: true, font: FONT, color: NAVY })],
}));
kids.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 700 },
  children: [new TextRun({
    text: '免税购物小票收集 · 智能识别 · 审核结算 · 账单对账 · 月度交付',
    size: 20, color: MUTED, font: FONT,
  })],
}));
kids.push(table([
  ['项目名称', '收票对账系统(Sign Workbench)'],
  ['系统定位', '面向韩国免税店/百货购物返点业务的收票—识别—对账—交付一体化作业平台'],
  ['报告版本', 'v1.0'],
  ['报告日期', '2026 年 8 月 2 日'],
  ['对应代码', `工作分支 refactor-2026-05-vue3 · 提交 ${'0547807'}`],
  ['运行环境', '腾讯云 CVM(4 核 8G)· Node.js 22 · PM2 常驻'],
], [0.22, 0.78]));

// ═══════════════════════ 目录 ═══════════════════════
kids.push(H1('目 录', { page: true }));
kids.push(table([
  ['章节', '主要内容'],
  ['一、项目概述', '业务背景、要解决的问题、建设目标、使用角色'],
  ['二、总体架构', '技术架构、端到端业务流程、核心数据链路'],
  ['三、功能模块与输入输出', '十一个功能模块的作用、输入、输出与界面截图'],
  ['四、关键技术指标', '识别准确率、性能与并发、运行成本'],
  ['五、质量保障体系', '自动化测试、数据一致性防线、安全与权限'],
  ['六、部署与运维', '部署方式、备份策略、监控与回滚'],
  ['七、项目状态与后续规划', '当前进展、已知短板、下一步计划'],
  ['附录', '演示数据说明、数据出处'],
], [0.3, 0.7]));

// ═══════════════════════ 一、项目概述 ═══════════════════════
kids.push(H1('一、项目概述', { page: true }));

kids.push(H2('1.1 业务背景'));
kids.push(P('公司从事韩国免税店与百货的购物返点业务:导游/代理带团在乐天、新罗、新罗爱宝客、新世界、现代等门店消费,'
  + '公司凭客户的购物小票与护照,向门店结算返点。业务链条上有三方数据必须对得上——'));
kids.push(LI('客户侧:每位客户的护照 + 若干张购物小票(手机拍照);'));
kids.push(LI('门店侧:门店每月出具的账单(Excel),记录实际成交与返点金额;'));
kids.push(LI('公司侧:按团号、代理、渠道模式归集的内部台账。'));
kids.push(P('三方一旦对不上,就意味着钱收不回来或者多付出去。'));

kids.push(H2('1.2 原有作业方式的问题'));
kids.push(table([
  ['环节', '原有方式', '主要问题'],
  ['收票录入', '人工看照片,手敲票号、护照号、团号、日期到 Excel', '票号 13~16 位纯数字,手敲极易错;量大时录入成为瓶颈'],
  ['团号归属', '人工查团号表,判断这张票属于哪个团、哪个渠道模式', '规则分散在人脑与多份 Excel 里,换人就出错'],
  ['账单对账', '月底拿门店账单与内部台账人工比对', '数万行逐行比对不现实,漏收难以发现'],
  ['未收催收', '凭印象与零散记录追票', '"账单里有、票没收到"的差集算不清楚,钱漏收'],
  ['交付', '人工整理图片文件夹 + 汇总表发给上家', '格式因人而异,返工多,且无留痕'],
], [0.16, 0.4, 0.44]));

kids.push(H2('1.3 建设目标'));
kids.push(LI('把"看照片敲字"变成"机器识别 + 人工确认",把人从录入中解放出来,只做判断;'));
kids.push(LI('把分散在人脑和 Excel 里的业务规则沉淀成系统配置,规则可查、可改、可追溯;'));
kids.push(LI('打通"收票 → 台账 → 门店账单 → 未收 → 交付"的完整数据链,任何一张票都能查到它现在在哪一步;'));
kids.push(LI('全链路留痕,关键动作(结算、删除、导出)可审计、可回溯。'));

kids.push(H2('1.4 使用角色'));
kids.push(table([
  ['角色', '职责', '数据可见范围'],
  ['收票员 / 审核员\n(reviewer)', '上传客户照片建档、在审核台逐张核对识别结果并确认', '只能看到自己上传的批次'],
  ['管理员\n(admin)', '全流程操作,含结算、导入账单、导出交付包、配置业务规则、管理账号', '全部数据'],
  ['财务\n(finance)', '查看台账、对账结果与交付数据', '全部数据(只读为主)'],
], [0.2, 0.5, 0.3]));

// ═══════════════════════ 二、总体架构 ═══════════════════════
kids.push(H1('二、总体架构', { page: true }));

kids.push(H2('2.1 技术架构'));
kids.push(table([
  ['层次', '技术选型', '说明'],
  ['前端', 'Vue 3 + Vite + Pinia + Vue Router', '单页应用,35 个功能页面;构建产物由后端直接托管'],
  ['后端', 'Node.js 22 + Express 5', '30 个路由模块 / 87 个服务模块,按业务域分层'],
  ['存储', 'SQLite(node:sqlite 原生驱动)+ 文件系统', '账号与客户库、月度对账库分库;客户原图与批次数据落盘'],
  ['识别', '阿里云百炼 qwen3-vl-plus(视觉大模型)', '单据分类、切图、字段抽取;高清 2400px 输入 + 票号二次校读'],
  ['文档处理', 'ExcelJS(流式)、sharp(图像)、JSZip', '数十万行账单流式导入;交付包打包'],
  ['部署运维', 'PM2 + 推送式发布 + 腾讯云 COS', '本地构建→上传→原子软链切换→健康检查;数据库与图片异地备份'],
], [0.13, 0.34, 0.53]));

kids.push(H2('2.2 端到端业务流程'));
kids.push(P('系统把业务拆成六个阶段,每个阶段都有明确的输入与产出,上一阶段的产出即下一阶段的输入:'));
kids.push(table([
  ['阶段', '输入', '处理', '产出'],
  ['① 收票建档', '客户护照与小票照片', '按客户建档,自动排队送识别', '客户档案 + 待审任务'],
  ['② 智能识别', '单据图片', '分类 → 切图 → 字段抽取', '结构化字段(票号/团号/日期/护照号等)'],
  ['③ 人工审核', '识别结果 + 原图', '逐张核对、纠错、确认', '审核通过的客户组'],
  ['④ 结算入账', '审核通过的客户组', '写台账 + 团号匹配', '收票台账行(带匹配状态)'],
  ['⑤ 账单对账', '门店账单 Excel + 台账', '按票号/日期/团号/护照多级匹配', '已匹配 / 未收清单 / 待核对冲突'],
  ['⑥ 交付导出', '已结算且匹配的数据', '按渠道模式组织图片与报表', '交付包(图片 + Excel + PDF)'],
], [0.14, 0.24, 0.28, 0.34]));

kids.push(H2('2.3 核心数据链路'));
kids.push(P('一张小票在系统内的完整生命周期:'));
kids.push(rich([
  { t: '照片 ', b: true }, { t: '→ ' }, { t: '识别任务 ', b: true }, { t: '→ ' },
  { t: '审核确认 ', b: true }, { t: '→ ' }, { t: '台账行 ', b: true }, { t: '→ ' },
  { t: '团号匹配 ', b: true }, { t: '→ ' }, { t: '账单匹配 ', b: true }, { t: '→ ' },
  { t: '月度合并 ', b: true }, { t: '→ ' }, { t: '交付包', b: true },
], { align: AlignmentType.CENTER }));
kids.push(P('其中「团号匹配」决定这张票属于哪个团、走哪个渠道模式(直接影响返点口径),'
  + '「账单匹配」决定这张票门店认不认、钱能不能收回来。两道匹配都不通过的票会分别进入'
  + '「异常补救」与「未收清单」,不会静默消失。', { color: MUTED }));

// ═══════════════════════ 三、功能模块 ═══════════════════════
kids.push(H1('三、功能模块与输入输出', { page: true }));
kids.push(P('本章按业务流程顺序介绍各功能模块。每个模块给出「做什么 / 输入什么 / 产出什么」,并配实际界面截图。', { color: MUTED }));
kids.push(P('说明:为保护客户隐私,截图中的姓名、护照号、票号、团号均为演示数据,单据图为合成样张并带 DEMO 水印,'
  + '不含任何真实客户信息;界面本身为系统真实构建产物,未做任何美化处理。', { color: WARN, size: 19 }));

kids.push(H2('3.1 功能与输入输出总表'));
kids.push(table([
  ['模块', '输入', '输出'],
  ['收票建档', '手机拍摄的护照/小票照片(jpg/png/webp/heic)', '客户档案、识别任务、审核批次'],
  ['智能识别', '单据图片', '单据类型 + 结构化字段 + 置信度 + 异常红标'],
  ['审核台', '识别结果 + 原图', '确认后的客户组(可结算)'],
  ['结算入账', '审核通过的客户组', '收票台账行(含团号匹配状态)'],
  ['月度数据导入', '团号汇总表、日度台账 xlsx(灾备/迁移用)', '团号库、台账行'],
  ['账单匹配', '门店账单 xlsx(按渠道分四桶)', '匹配结果、扣点计算、冲突待核对'],
  ['未收清单', '门店账单与台账的差集', '催收清单(可导出 Excel)'],
  ['交付核对', '已结算数据', '四桶返点合计、交付前阻断项检查'],
  ['交付导出', '核对通过的数据', '交付包 zip(分渠道图片 + 汇总表 + 客户 PDF)'],
  ['配置台', '业务规则设定', '渠道模式的记账列、审核必填项、交付格式'],
  ['审计日志', '系统运行中的关键动作', '可检索的操作留痕'],
  ['用户与权限', '账号与角色设定', '登录凭据与数据可见范围'],
], [0.18, 0.42, 0.4]));

// ── 3.2 登录 ──
kids.push(H2('3.2 系统入口与权限', { page: true }));
kids.push(P('系统为内网 Web 应用,浏览器访问,账号密码登录。登录后按角色分发不同的工作台:'
  + '管理员看全局运营概览,审核员看自己的收票任务。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '用户名 + 密码　　' }, { t: '输出:', b: true }, { t: '带角色的登录会话(JWT,24 小时有效)' }]));
// 登录页用的是 900×560 紧凑视口,比例与其它页不同,单独给尺寸
shot('01_登录_系统入口', '图 3-1　登录页。登录失败有防暴力破解限流,被锁定时明确提示剩余等待时间',
  { width: 470, height: 292 });

// ── 3.3 首页 ──
kids.push(H2('3.3 管理员工作台(运营概览)'));
kids.push(P('管理员首页回答三个问题:今天干了多少、谁在干、哪里卡住了。'));
kids.push(LI('运营概览:今日上传/审核/导出张数、未清异常存量、今日完成率;'));
kids.push(LI('收票员工作看板:每位收票员的收图数、已审数、待审数与完成率,便于调配人力;'));
kids.push(LI('已完成批次:完成时间、收图/已审/待审/异常张数、耗时、导出状态;'));
kids.push(LI('待管理事项:超时未完成客户组、未收清单条数、待导出与导出失败批次,点击可展开到具体批次。'));
shot('02_首页_运营概览', '图 3-2　管理员工作台。KPI、收票员看板、已完成批次三段式布局');


// ── 3.4 建档 ──
kids.push(H2('3.4 收票建档(系统输入端)', { page: true }));
kids.push(P('这是全系统的数据入口。收票员把一位客户的整包照片(护照 + 若干小票)拖进上传区,'
  + '系统按客户建档并自动送入识别队列,识别完成后自动进入当前审核批次,无需再手工导入。'));
kids.push(rich([{ t: '输入:', b: true }, { t: 'jpg / png / webp / heic 照片,可多选整包上传' }]));
kids.push(rich([{ t: '输出:', b: true }, { t: '客户档案(含原图留存)+ 识别任务 + 批次归属' }]));
kids.push(P('客户看板按「异常 / 处理中 / 已完成」三档分类,每行显示收图→识别→就绪→审核的进度,'
  + '识别失败的图会标红并给出「重识别 / 补图 / 删除」三个动作。'));
shot('03_收票建档_上传入口', '图 3-3　收票建档页。上方为上传区与识别进度,下方为客户看板;'
  + '图中黄色提示是系统护栏——未选定审核批次时会拦住建档并给出指引');


// ── 3.5 识别 + 审核 ──
kids.push(H2('3.5 智能识别与人工审核(系统核心)', { page: true }));
kids.push(P('这是系统投入最大、也最能体现价值的环节。'));

kids.push(rich([{ t: '（1）识别侧', b: true, s: 22 }], { after: 100 }));
kids.push(P('一张照片进来后依次经过:'));
kids.push(LI('单据分类:判断这张是护照、免税店小票、百货小票,还是机票/包装等参考件;'));
kids.push(LI('切图:一张照片里常拍了多张单据(如护照与小票同框),系统切分成独立任务;'));
kids.push(LI('字段抽取:按单据类型抽取对应字段——小票取店家/票号/团号/购买日期/出境日期,护照取英文名/护照号;'));
kids.push(LI('校验与二次校读:票号按门店规则校验位数(乐天 14 位、新罗 13 位等),'
  + '可疑时裁出票号区域再读一次;仍不确定的宁可留空并标红转人工,不猜。'));
kids.push(P('下面两张是本报告使用的演示单据样张(合成,非真实客户单据):', { color: MUTED, size: 19 }));
docShot('receipt_lotte.png', '图 3-4　免税店小票样张(合成演示数据)', 250, 230);
docShot('passport_huang.png', '图 3-5　护照资料页样张(合成演示数据,含 MRZ 机读区)', 330, 232);

kids.push(new Paragraph({ pageBreakBefore: true, spacing: { after: 100 }, children: [new TextRun({ text: '（2）审核侧', bold: true, size: 22, font: FONT })] }));
kids.push(P('审核台是三栏结构:左侧客户组队列、中间单据原图、右侧识别字段与确认操作。'
  + '审核员的工作是「看图核对字段」,而不是录入。'));
kids.push(LI('队列按代理分组、默认只看待办,支持 FIFO / 待审优先 / 异常优先等多种排序;'));
kids.push(LI('每张小票先做团号表态(匹配到团号 / 确认票上无团号),再解锁字段审核,避免团号张冠李戴;'));
kids.push(LI('字段逐项标注「通过 / 必改」,快检全通过的可一键确认;'));
kids.push(LI('图片可缩放、看整张原图、按字段高亮定位;识别错类型可一键改判(小票 / 护照 / 百货 三类互改);'));
kids.push(LI('拍糊、缺页的可标记「重拍」,自动进入异常补救流程,不会混进正常结算。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '识别结果 + 单据原图　　' }, { t: '输出:', b: true }, { t: '确认无误的客户组,可直接「通过并结算」' }]));
shot('04_审核台_识别与确认', '图 3-6　审核台。右侧字段与中间票面逐项对应:票号 3120451160872、团号 58021、'
  + '购买日期 2026-07-11 均与票面一致,系统已标注「通过」');


// ── 3.6 台账 ──
kids.push(H2('3.6 结算与收票台账(核心产出)', { page: true }));
kids.push(P('客户组审核通过后执行「通过并结算」,系统把该客户的每张小票写入收票台账,'
  + '并立即执行团号匹配。台账是后续所有对账与交付的唯一数据源。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '审核通过的客户组　　' }, { t: '输出:', b: true }, { t: '台账行(日期/姓名/护照/团号/渠道模式/金额/双匹配状态)' }]));
kids.push(P('每行台账带两个状态:'));
kids.push(LI('团号匹配:团号是否命中团号表、购买日是否落在该团的起止窗口内。不通过的进入「异常补救」;'));
kids.push(LI('账单匹配:门店账单里是否有对应的这一笔。不通过的进入「未收清单」催收。'));
shot('05_收票台账_结算产出', '图 3-7　收票台账。右侧两列即团号匹配与账单匹配状态,顶部实时统计未匹配数量');


// ── 3.7 导入 ──
kids.push(H2('3.7 外部数据导入', { page: true }));
kids.push(P('系统需要接入两类外部数据:团号汇总表(决定团号归属与渠道模式)与门店账单(对账基准)。'));
kids.push(LI('团号汇总表:通常在建立审核批次时绑定,也可在本页直接导入;'));
kids.push(LI('门店账单:在账单匹配页按渠道桶导入(见 3.8);'));
kids.push(LI('日度台账直接导入:仅用于历史数据迁移或识别服务不可用时的灾备补录,正常流程台账由审核台自动写入。'));
kids.push(P('所有导入都有完整留痕:文件名、操作人、总行数、导入行数、跳过行数、耗时与状态。'
  + '大文件走流式解析——实测 28 万行、98MB 的总账可正常导入,不会把整个文件读进内存。'));
shot('06_月度导入_外部数据', '图 3-8　月度数据导入页与导入历史。每次导入的行数与结果均可追溯');


// ── 3.8 账单匹配 ──
kids.push(H2('3.8 账单匹配对账', { page: true }));
kids.push(P('门店账单按渠道分成四个业务桶导入,每个桶独立配置扣点率与参与匹配的渠道模式,'
  + '然后逐桶执行匹配。匹配采用多级策略:优先按小票号精确匹配,'
  + '再依次按购买日期 + 团号、护照号、姓名等组合匹配,匹配不上或存在歧义的进入人工核对。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '门店账单 xlsx(按桶)+ 收票台账' }]));
kids.push(rich([{ t: '输出:', b: true }, { t: '匹配结果与匹配率、扣点后金额、字段冲突待核对清单、未收清单' }]));
shot('07_账单匹配_四桶控制台', '图 3-9　账单匹配控制台。顶部为全局匹配率,下方每桶显示账单文件、扣点率、'
  + '参与模式与匹配统计');


// ── 3.9 未收 ──
kids.push(H2('3.9 未收清单(漏收兜底)', { page: true }));
kids.push(P('未收清单回答一个很具体的问题:'
  + '门店账单里有这笔交易、但客户的小票我们没收到——这笔钱正在漏掉,得去追。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '门店账单与台账的差集　　' }, { t: '输出:', b: true }, { t: '按渠道/代理/日期可筛的催收清单,支持导出 Excel' }]));
kids.push(P('每条未收记录锚定「护照号 + 姓名 + 票号」,即使账单重导也不会丢失首次发现时间,'
  + '便于按逾期天数分级催收。已确认收不回来的可标记作废,避免清单越滚越长。'));
shot('08_未收清单_催收产出', '图 3-10　未收清单。可批量延期、批量作废,或反向补录入台账');


// ── 3.10 交付 ──
kids.push(H2('3.10 交付核对与导出', { page: true }));
kids.push(P('交付前先核对:四个渠道桶的返点合计、总行数、以及交付阻断项(如仍有未匹配行)。'
  + '合计取全量真值计算,与页面列表是否分页无关——这一点在财务口径上尤其重要。'));
kids.push(rich([{ t: '输入:', b: true }, { t: '已结算且完成对账的数据' }]));
kids.push(rich([{ t: '输出:', b: true }, { t: '交付包 zip:按渠道模式分文件夹的小票/护照图片 + 汇总 Excel + 客户资料 PDF' }]));
shot('09_交付核对_返点合计', '图 3-11　交付核对页。四桶返点合计与总行数取全量统计,并明确标注列表为截断显示');


// ── 3.11 配置台 ──
kids.push(H2('3.11 配置台(业务规则可配置)', { page: true }));
kids.push(P('不同渠道模式的记账口径不同:有的要记出境日期,有的不要;票号形态有 13 位、14 位之分;'
  + '交付给不同上家的文件夹与表格格式也不一样。这些规则过去靠人记,现在沉淀进配置台。'));
kids.push(LI('渠道模式:台账记哪些列、审核必审哪些字段、票号导出形态、特殊任务标记;'));
kids.push(LI('百货店:乐天/新世界/现代三家各自的必填字段与上家归属规则;'));
kids.push(LI('交付导出:给上家的文件夹结构与表格列;'));
kids.push(LI('字段字典:系统认识哪些字段(只读,供核对)。'));
kids.push(P('配置保存即生效,带版本号与改动历史,改坏了可以随时回到系统默认。', { color: MUTED }));
shot('10_配置台_渠道模式', '图 3-12　配置台。左侧模式列表,右侧为该模式的记账列开关、审核要求与票号形态');


// ── 3.12 审计 ──
kids.push(H2('3.12 审计日志', { page: true }));
kids.push(P('涉及钱与数据安全的动作全部留痕:导入、审核通过、结算、台账订正、导出、删除拦截等,'
  + '记录操作人、时间、路由、耗时与结果,可按类型与时间检索。'));
shot('11_审计日志_操作留痕', '图 3-13　审计日志。含被守卫拦截的动作(如删除含已结算数据的批次)');

kids.push(H2('3.13 用户与权限', { page: true }));
kids.push(P('账号按角色授予权限,审核员只能看到自己上传的批次,避免多人协作时互相干扰或误操作他人数据。'
  + '员工编号用于收票汇总表按人分组统计。离职人员停用即可,历史数据完整保留。'));
shot('12_用户与权限', '图 3-14　员工账号管理');


// ═══════════════════════ 四、技术指标 ═══════════════════════
kids.push(H1('四、关键技术指标', { page: true }));

kids.push(H2('4.1 识别准确率'));
kids.push(P('以 2000 张真实生产图片建立金标数据集(人工审核后的最终值为标准答案),对识别结果逐字段比对:'));
kids.push(table([
  ['识别项', '准确率', '说明'],
  [{ t: '小票号(加权)' }, { t: '89.1%', b: true, c: OK }, '按各渠道生产实际占比加权;架构升级前为 70.6%'],
  ['购买日期', '95.9%', '小票'],
  ['出境日期', '98.3%', '小票'],
  ['护照号', '96.8%', '护照资料页'],
  ['英文姓名', '97.8%', '护照资料页'],
  [{ t: '单据类型识别' }, { t: '99.3%', b: true, c: OK }, '护照/小票/百货/其他四类分类'],
], [0.24, 0.16, 0.6]));
kids.push(P('说明:识别环节定位为「减轻人工负担」,不是「替代人工」。'
  + '所有字段最终都经审核员确认后才入账,识别错误由审核环节兜住;'
  + '系统对拿不准的字段主动留空并标红转人工,宁可空着也不猜错。', { color: MUTED, size: 19 }));

kids.push(H2('4.2 性能与并发'));
kids.push(table([
  ['指标', '实测结果'],
  ['识别并发能力', '并发 64、有效 TPM 100 万,全程无限流拒绝;持续 250 张连续处理同样稳定'],
  ['日处理能力', '按日均 1 万张估算,约 2 小时内可完成识别'],
  ['大文件导入', '28.7 万行 / 98MB 账单流式导入,内存峰值约 281MB'],
  ['并发作业', '30 人同时在线作业压测通过,结算成功率 100%,无死锁'],
], [0.24, 0.76]));

kids.push(H2('4.3 运行成本'));
kids.push(P('识别按调用量计费。经模型与分辨率组合实测选型后,当前配置为 qwen3-vl-plus + 2400px 高清输入:'));
kids.push(table([
  ['方案', '每图成本', '票号准确率'],
  ['升级前(qwen-vl-max @1280)', '1.54 分', '70.6%'],
  [{ t: '当前(qwen3-vl-plus @2400)', b: true }, { t: '0.76 分', b: true, c: OK }, { t: '89.1%', b: true, c: OK }],
], [0.44, 0.28, 0.28]));
kids.push(P('结果是准确率大幅提升的同时单图成本降低约一半——按日均 1 万张计,识别成本约 76 元/天。', { color: MUTED }));


// ═══════════════════════ 五、质量保障 ═══════════════════════
kids.push(H1('五、质量保障体系', { page: true }));

kids.push(H2('5.1 自动化测试'));
kids.push(table([
  ['项目', '现状'],
  ['测试用例', '2013 个自动化测试,当前全部通过'],
  ['测试文件', '387 个测试文件,覆盖服务层、路由层、前端契约与端到端流程'],
  ['持续集成', '每次提交自动执行 代码规范检查 + 全量测试 + 前端构建'],
  ['发布前置', '部署脚本内置端到端门禁,不通过不允许发布'],
], [0.22, 0.78]));

kids.push(H2('5.2 数据一致性防线'));
kids.push(P('金融属性的数据最怕"看起来成功了、其实丢了"。系统针对性建立了若干防线:'));
kids.push(LI('批次写锁:所有批次数据写入必须持锁,杜绝多人同时操作时互相覆盖;'));
kids.push(LI('已结算保护:已结算的客户组不能删除、不能改字段,只能走留痕的台账订正通道;'));
kids.push(LI('乐观锁:配置类数据带版本号,并发编辑会明确报冲突而不是静默覆盖;'));
kids.push(LI('导入失败必留痕:导入过程出错会明确置为失败状态并记录原因,不会卡在"进行中"挡住后续重导;'));
kids.push(LI('大文件保护:超出安全阈值的文件拒绝整本载入,明确报错而不是拖垮整个服务;'));
kids.push(LI('导出完整性:交付包内缺图、源文件丢失等情况会明确报出,不静默少给。'));

kids.push(H2('5.3 安全与权限'));
kids.push(LI('密码加密存储(bcrypt),登录失败限流防暴力破解;'));
kids.push(LI('接口级角色校验,审核员数据范围在服务端强制隔离,不依赖前端隐藏按钮;'));
kids.push(LI('关键动作审计留痕,可回溯到人;'));
kids.push(LI('敏感配置与密钥不入代码库;交付物中的护照号按需打码。'));


// ═══════════════════════ 六、部署与运维 ═══════════════════════
kids.push(H1('六、部署与运维', { page: true }));

kids.push(H2('6.1 部署方式'));
kids.push(P('采用推送式发布:本地构建前端产物 → 打包上传服务器 → 原子软链切换版本 → 重启进程 → 健康检查。'
  + '发布过程不触碰服务器上的业务数据与环境配置,保留最近三个版本,异常时可秒级回滚。'));

kids.push(H2('6.2 备份策略'));
kids.push(table([
  ['备份对象', '频率', '去向', '保留'],
  ['数据库', '每天凌晨', '服务器本地 + 腾讯云 COS 异地', '本地 7 份 / COS 30 份'],
  ['客户原图', '每天增量镜像', '腾讯云 COS', '滚动 90 天'],
  ['月度交付包', '每次导出后同步', '腾讯云 COS', '长期归档'],
], [0.24, 0.2, 0.34, 0.22]));
kids.push(P('备份脚本会校验实际上传结果而不是只看退出码——曾经踩过"命令返回成功、其实一个文件都没传上去"的坑,'
  + '现已改为扫描输出中的错误标记判定真实成败,图片镜像失败时跳过本地清理以防丢失。', { color: MUTED, size: 19 }));

kids.push(H2('6.3 监控与应急'));
kids.push(LI('进程健康检查接口,发布后自动验证;'));
kids.push(LI('识别服务故障有降级模型兜底,并在恢复后自动重新识别降级期间的数据;'));
kids.push(LI('长时间无进展的批次有看门狗自动恢复,不会永久卡住;'));
kids.push(LI('稳定版本打标签,重大变更前可一键回退。'));


// ═══════════════════════ 七、状态与规划 ═══════════════════════
kids.push(H1('七、项目状态与后续规划', { page: true }));

kids.push(H2('7.1 当前状态'));
kids.push(table([
  ['维度', '状态'],
  ['系统状态', { t: '已上线并投入日常生产使用', b: true, c: OK }],
  ['功能完整度', '收票 → 识别 → 审核 → 结算 → 对账 → 未收 → 交付 全链路打通'],
  ['识别能力', '票号加权准确率 89.1%,单据分类 99.3%'],
  ['自动化测试', '2013 个用例全部通过'],
  ['并发承载', '30 人同时作业压测通过'],
], [0.22, 0.78]));

kids.push(H2('7.2 已知短板'));
kids.push(table([
  ['问题', '现状与影响', '计划'],
  ['新世界百货票号识别偏低', '票面为 16 位小字,切片后分辨率触及极限,准确率明显低于其他门店', '改用原图区域定位方案再读,预计可显著改善'],
  ['现代百货样本不足', '样本量仅个位数,分类准确率统计意义有限', '积累样本后重新评估并针对性优化'],
  ['跨月票据归属', '购买月与账单出账月不同的票据,在未收判定上口径待统一', '已完成方案设计,待业务口径拍板后实施'],
  ['台账侧订正通道', '台账行发现错误时,订正入口不够直观', '规划中'],
], [0.22, 0.44, 0.34]));

kids.push(H2('7.3 后续规划'));
kids.push(LI('识别准确率:推进原图区域定位方案,目标票号整体准确率稳超 92%;'));
kids.push(LI('作业效率:继续优化审核台操作路径,减少每张票的确认点击次数;'));
kids.push(LI('对账自动化:提升账单匹配的自动命中率,压缩人工核对量;'));
kids.push(LI('可观测性:关键指标看板化,异常主动告警而非被动发现;'));
kids.push(LI('规则治理:继续把散落的业务规则收敛进配置台,减少改代码的场景。'));


// ═══════════════════════ 附录 ═══════════════════════
kids.push(H1('附录', { page: true }));

kids.push(H2('附录 A　演示数据说明'));
kids.push(P('本报告全部截图均使用演示数据采集,具体做法:'));
kids.push(LI('界面为系统真实构建产物,直接运行、直接截图,未做任何图片修饰或设计稿替代;'));
kids.push(LI('页面数据由测试替身注入,所有姓名、护照号、票号、团号、金额均为虚构;'));
kids.push(LI('单据图片为程序合成的样张,版面参照真实单据结构,内容全部虚构,并印有 DEMO 水印;'));
kids.push(LI('采集过程不接触生产数据库,不读取任何真实客户信息。'));

kids.push(H2('附录 B　数据出处'));
kids.push(table([
  ['数据', '出处'],
  ['识别准确率(2000 金标)', '《2000 金标定论:全字段 + 分类准确率》(2026-07-21)'],
  ['成本与选型对比', '《识别 90 冲刺:模型与分辨率突破》(2026-07-21)'],
  ['并发与吞吐', '《qwen3 压力测试报告》(2026-07-21)'],
  ['测试用例数', '本地全量测试执行结果(2026-08-02)'],
  ['代码规模', '按仓库路由/服务/页面/测试文件实际统计'],
], [0.32, 0.68]));

kids.push(spacer(300) || new Paragraph({ children: [] }));
kids.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 400 },
  children: [new TextRun({ text: '— 报告结束 —', size: 19, color: MUTED, font: FONT })],
}));

// ═══════════════════════ 输出 ═══════════════════════
const doc = new Document({
  creator: '收票对账系统',
  title: '收票对账系统 — 项目报告',
  description: '项目报告 v1.0',
  styles: {
    default: {
      document: { run: { font: FONT, size: 21 } },
    },
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },       // A4 纵向
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: kids.filter(Boolean),
  }],
});

fs.mkdirSync(OUT_DIR, { recursive: true });
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log(`已生成:${OUT}`);
  console.log(`大小:${(buf.length / 1024 / 1024).toFixed(2)} MB · 内嵌截图 ${SHOT_LIST.length + 2} 张`);
});
