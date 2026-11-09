'use strict';

/**
 * 多模式交付包导出(2026-07-07 上家需求,用户拍板三点:每模式一个顶层文件夹/
 * 跨模式客户各区一份/S活动小票双份)。四条整理规则:
 *
 *   1) 济州乐天SG-道辉(模式名前缀匹配,表内写法带「(单独整理)」后缀):
 *        济州乐天SG-道辉/{团号}/{团号}—{姓名} {护照前4}/{同前缀}_护照N|_小票N|_机票N.ext
 *   2) 现代免税店(按店判定,非按模式):复用现代交付包三池(护照/机票/小票,小票按票号带横线),
 *        整体落在 现代免税店/ 之下 —— 与既有单独导出的包内容一致。
 *   3) 其他模式:{模式}/{姓名} {护照前4}/{同前缀}_护照N|_小票N|_机票N.ext
 *      (2026-07-20 用户拍板:姓名与护照前4之间加空格,如「WANG YI EB23」;
 *       身份=组级选取器 selectGroupIdentity,护照任务优先,绝不用免税店小票的 OCR 名)
 *   4) S活动(模式名含「S活动」**或票级 sActivityFlag 红标签人工标记**):先按规则3进
 *        自己的模式文件夹,小票**另复制一份**到
 *        S活动/{模式}/{小票号}.ext(以小票号命名,缺票号阻断导出并列出问题任务)。
 *        ⭐2026-07-20 修:S活动是票面属性(红标签,查团号查不出),原判定只认模式名,
 *        普通模式+红标签的票永不触发双份 → 补票级 sActivityFlag 判定源。
 *   5) 新世界/现代百货(按店判定,2026-07-20 用户拍板,设计=docs/plans/2026-07-20-百货交付重构-设计.md §3):
 *        {上家}/{代理}/{交易编号}/{交易编号}.ext + 护照.ext
 *        上家=任务 upstreamFinal||Auto||档案默认(新世界=梁总;现代=东方/金浦奥莱);
 *        ⭐一票一夹(2026-07-31 拍板 14-3):夹名=该票交易编号,夹里就那一张票 + 护照。
 *          旧口径「一客户一夹、夹名取桶内最小交易编码、无独立护照叫 姓名待补_{客户号}」(0720 拍板a)
 *          已作废——主场新世界百货 passportFree(票面本就无护照),那条兜底反而成了常态,
 *          与需求正面冲突;缺护照改由 zip 根「导出说明.txt」按交易编号点名。
 *        缺交易编码阻断(按上家区归因);
 *        机票不进本链(百货无离境校验)。这些店的票**不再**落规则3的通用模式夹(防一票两包)。
 *
 * 兜底与护栏(沿用现代包边界):整组未审核跳过并列名单;模式为空的客户进 未归类/;
 * 重名自动 _2 后缀;单文件拷贝失败不致命。范围=一个审核批次。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { parseCustomerRefFromTask } = require('../lib/customer_ref');
const { normalizeStoreFamily, STORE_FAMILIES } = require('../lib/validation/field_rules');
const { findDeptPassportDonor } = require('../lib/validation/group_passport_rule');
const { resolveDeptUpstream } = require('../lib/store_profiles');
const { createDeliveryImagePlanner, describeBlock, renderCroppedDelivery } = require('../lib/delivery_render');
const { formatReceiptNoByMode, isNoRecordMode, resolveTaskModeRule } = require('../lib/workbench_receipt_export');
const { logger } = require('../lib/logger');
const {
  archiveZip, sanitize, uniqueExportFileName, cleanupDir,
} = require('./batch_customer_data_export_service');

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const JEJU_DOHUI_PREFIX = '济州乐天SG-道辉';
const S_ACTIVITY_MARK = 'S活动';
const UNCLASSIFIED_ZONE = '未归类';
const HYUNDAI_ZONE = '现代免税店';
// 规则5(2026-07-20):走「上家/代理/交易编码客户夹」专链的百货店(乐天百货有独立交付包,不在此列)
const DEPT_UPSTREAM_FAMILIES = Object.freeze(new Set([STORE_FAMILIES.SHINSEGAE_DEPT, STORE_FAMILIES.HYUNDAI_DEPT]));
const UNKNOWN_UPSTREAM = '未知上家';
const UNKNOWN_AGENT = '未知代理';

// ── 渠道区(zone)=交付包顶层文件夹 ────────────────────────────────────
// 2026-07-16 资料库P0"单渠道切片":同一份 planModeDelivery 产物按顶层文件夹切一块打包。
// 这里是渠道归属的**唯一**判定(资料库子卡列表/切片过滤共用,别在路由层重写)。
function zoneOfMode(modeRaw) {
  const mode = textOf(modeRaw);
  if (!mode) return UNCLASSIFIED_ZONE;
  if (mode.startsWith(JEJU_DOHUI_PREFIX)) return JEJU_DOHUI_PREFIX; // 济州各团号模式并一个区
  return mode;
}

// 计划条目是否属于某渠道区:顶层段=区名;S活动副本夹(顶层=S活动/{模式})连带回它的模式区
function entryInZone(entry, zone, sanitizeFn) {
  const segs = String(entry.dir || '').split('/');
  const zoneTop = sanitizeFn(zone);
  if (segs[0] === zoneTop) return true;
  return segs[0] === sanitizeFn(S_ACTIVITY_MARK) && segs[1] === zoneTop;
}

// 渠道区 → 整理方式(2026-07-27 需求F①:模式名旁用灰色括号标一句"这个区是怎么理的",
// 用户原话「乐天SG-本司(普通) / 现代免税店(3类整理) / 济州乐天SG-道辉(按团号整理)」)。
// 口径与本文件的分桶规则一一对应,不是另起的说法:
//   ① JEJU_DOHUI_PREFIX  → 模式+团号分桶            → 按团号整理
//   ② HYUNDAI_ZONE       → 护照池/机票池/小票池三池 → 3类整理
//   ⑤ 百货上家区          → 上家/代理/客户夹         → 按上家整理
//   ③ 其余模式(兜底)     → 模式/客户夹              → 普通
// 未归类不给整理方式(它还没进任何规则,标"普通"会骗人)。
// ⑤ 的标签**不靠猜**:打包时规则⑤在自己产出的条目上写 layout(见 files.push),这里直接读。
// 上家取自审核员可手填的 upstreamFinal,靠名单反推永远追不全(出现「王总」就会标成「普通」)。
const LAYOUT_BY_UPSTREAM = '按上家整理';

function zoneLayoutLabel(zone, entryLayout = '') {
  const hinted = textOf(entryLayout);
  if (hinted) return hinted; // 打包方自报的最权威
  const z = textOf(zone);
  if (!z || z === UNCLASSIFIED_ZONE) return '';
  if (z === HYUNDAI_ZONE) return '3类整理';
  if (z.startsWith(JEJU_DOHUI_PREFIX)) return '按团号整理';
  return '普通';
}

// 计划 → 渠道区汇总(资料库子卡数据源):[{ zone, layout, files, customerDirs }]。
// customerDirs=该区客户夹数(现代三池没有客户夹,回 null 由前端显示张数)。
function summarizeZones(plan) {
  const byZone = new Map();
  for (const entry of plan.files || []) {
    const segs = String(entry.dir || '').split('/');
    let zone = segs[0];
    if (zone === S_ACTIVITY_MARK) zone = segs[1] || zone; // 副本夹归回模式区
    if (!byZone.has(zone)) byZone.set(zone, { zone, files: 0, dirs: new Set(), layout: '' });
    const slot = byZone.get(zone);
    slot.files += 1;
    if (!slot.layout && entry.layout) slot.layout = String(entry.layout); // 打包方自报的整理方式
    if (segs[0] !== S_ACTIVITY_MARK) slot.dirs.add(entry.dir);
  }
  return [...byZone.values()].map(({ zone, files, dirs, layout }) => ({
    zone,
    layout: zoneLayoutLabel(zone, layout),
    files,
    customerDirs: zone === HYUNDAI_ZONE ? null : dirs.size,
  }));
}

function textOf(value) {
  return String(value || '').trim();
}

function docTypeOf(task) {
  return textOf(task?.docTypeFinal || task?.docTypeAuto).toLowerCase();
}

function modeOf(task) {
  // 任务级模式单源 resolveTaskModeRule(2026-07-20 行为三合一):人选(modeManualPick)>
  // matched 快照(modeRawPre)> 机场推断——已审未结算的人选票此前跌回过时快照,
  // "我审核了该模式但导出里没进去"的病根。⭐分桶时它仍只是**回落值**:
  // 台账 mode_raw(终匹配/人工补救后的真相)优先,见 planModeDelivery 内 resolveTaskMode。
  return textOf(resolveTaskModeRule(task).mode);
}

// ── 组级身份选取(2026-07-20 交付包五问题#1;旧 :89/:159 两处同病一并收口,禁两套)──
// 客户夹命名只认可信身份源,优先级:
//   ① 独立护照任务(docType=passport)的 extractedName/passportNo(Final 优先)
//   ② 无护照任务 → 百货同框票(乐天百货等,护照+小票一图)的小票身份字段
//      (字段清洗层只允许百货小票携带身份字段;判定复用 findDeptPassportDonor,与台账桥同源)
//   ③ 都没有 → 姓名回落 customerId(调用方传入),护照号空
// ⭐绝不用免税店小票的 OCR 名/护照残串:旧逻辑取"全组第一个非空值"不分文档类型,
//   小票 OCR 残串 CHN-ERIGCHNE 当过客户夹姓名、passportNoAuto 粘串 CHNE 当过护照前4。
function selectGroupIdentity(tasks, fallbackName = '') {
  const list = Array.isArray(tasks) ? tasks : [];
  const passports = list.filter((t) => docTypeOf(t) === 'passport');
  const firstOf = (items, finalKey, autoKey) => textOf(
    items.map((t) => t?.[finalKey] || t?.[autoKey]).find(Boolean)
  );
  let name = firstOf(passports, 'extractedNameFinal', 'extractedNameAuto');
  let passportNo = firstOf(passports, 'passportNoFinal', 'passportNoAuto');
  if (!name || !passportNo) {
    const donor = findDeptPassportDonor(list, null);
    if (donor) {
      name = name || textOf(donor.extractedNameFinal || donor.extractedNameAuto);
      passportNo = passportNo || textOf(donor.passportNoFinal || donor.passportNoAuto);
    }
  }
  return { name: name || textOf(fallbackName), passportNo };
}

// 护照前4(客户夹后缀):先剥非字母数字,再验护照形态(1-2位字母+7-8位数字)才取前4;
// MRZ 国籍码 CHN 粘进护照号(CHNE1234567)时剥掉 CHN 再验。不成形(小票残串/空)→ 无后缀。
const PASSPORT_SHAPE = /^[A-Z]{1,2}\d{7,8}$/;
function passportPrefix4(passportNo) {
  let no = textOf(passportNo).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (no.startsWith('CHN') && PASSPORT_SHAPE.test(no.slice(3))) no = no.slice(3);
  return PASSPORT_SHAPE.test(no) ? no.slice(0, 4) : '';
}

function extOf(sourcePath) {
  const ext = path.extname(sourcePath);
  return IMAGE_EXT.test(ext) ? ext : '.jpg';
}

// 导出说明.txt 内容(0728 截图驱动,image64 实锤):缺护照的夹散落在包里全靠人翻才
// 发现;回执数据原本只在 exportZip 返回值里,handler 直接流 zip 全被丢弃=事实静默。
// 写进包根,审核员/收件上家都看得见。没有可说的返回 null 不写(不给收件人塞噪音)。纯函数,直测。
// 段间空行(0729 真实数据核验发现):各段是逐步 push 出来的,谁也没负责段尾留白,
// 于是「…不用回来核对。」后面直接顶着「【未进包·还没审完】」,糊成一片没法扫读。
// 统一在这里补,而不是让每个段落自己 push('') —— 段落会一直加,靠人记必漏。
function spaceSections(lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith('【') && out.length && out[out.length - 1] !== '') out.push('');
    out.push(line);
  }
  return out;
}

// 回执条目里的夹名列表(14-3 之后一个客户可能有多个交易编号夹)。
// 兼容老形状 {folder:'…'}:这函数是导出的纯函数,外部调用方(测试/未来的复用)传老形状时
// 宁可退化成一行,也不能静默变成空字符串——那会让说明里出现「  - (上家:…)」这种断头行。
function folderListOf(entry) {
  const list = Array.isArray(entry?.folders) ? entry.folders.filter(Boolean) : [];
  if (list.length) return list;
  return entry?.folder ? [entry.folder] : ['(夹名未知)'];
}

function buildDeliveryNotes({
  namePending = [], copyFailed = [], skippedUnreviewed = [], noRecordReceipts = 0, noRecordModes = [],
  missingSource = [], passportSourceLost = [], imageBlocked = [],
} = {}) {
  const lines = [];
  // 「不用记」= 代理在团号表里明说这票不进台账。0724 拍板:这些行不进任何导出账单,
  // 但**图片照进交付包**(收图交付本身仍是要交的活)。于是包里的票数会比账单行数多,
  // 对账的人翻遍两边也对不上,只能来问——这是纯信息缺口,不是数据错。写进说明即可解释。
  // 生产实测(0729):全库台账 14653 行里 3774 行是「不用记」= 25.8%,不是边角情况。
  if (noRecordReceipts > 0) {
    lines.push(`【图在包里·账不在单上】本包含 ${noRecordReceipts} 张「不用记」小票的图。`);
    if (noRecordModes.length) lines.push(`  涉及模式:${noRecordModes.slice(0, 8).join('、')}${noRecordModes.length > 8 ? ` 等 ${noRecordModes.length} 个` : ''}`);
    lines.push('  代理在团号表里把这些模式标了「不用记」,按规则它们不出现在任何导出账单里,');
    lines.push('  但图仍要交付。所以包里的图会比账单行多,这是正常的,不用回来核对。');
  }
  // 未审完 → 整组不进包(既有边界)。但此前只活在被丢弃的返回值里,包里和界面都不提
  // (0729 生产核验:0722 批 3 个客户组就这么静默少了)→ 写进说明,少发了谁一目了然。
  if (skippedUnreviewed.length) {
    lines.push(`【未进包·还没审完】${skippedUnreviewed.length} 个客户组整组未审完,按规则没进本包:`);
    for (const c of skippedUnreviewed.slice(0, 20)) lines.push(`  - ${c}`);
    if (skippedUnreviewed.length > 20) lines.push(`  …等共 ${skippedUnreviewed.length} 个`);
    lines.push('  审完后重新导出即可收进来。');
  }
  // 0731 拍板 14-3 之后夹名一律是交易编号,不再夹带「姓名待补」——这段是它腾出来的信息位:
  // 谁没有护照图,按交易编号点名(上家就是按交易编号对账的,给客户号他还得再翻一层)。
  if (namePending.length) {
    const totalFolders = namePending.reduce((n, p) => n + folderListOf(p).length, 0);
    lines.push(`【没有护照图·夹里只有小票】${totalFolders} 个交易编号夹没有护照(客户没交,或票面本就无护照):`);
    for (const p of namePending.slice(0, 20)) {
      lines.push(`  - ${folderListOf(p).join('、')}(上家:${p.zone};客户号 ${p.customerId})`);
    }
    if (namePending.length > 20) lines.push(`  …等共 ${namePending.length} 个客户`);
    lines.push('  按交易编号对账不受影响。需要客人姓名请按交易编号回报,我们补上后重新导出。');
  }
  // 源图在磁盘上取不到 → 那张图就是没进包。兄弟服务(乐天百货/现代)早有名单,本文件此前
  // 是裸 continue,包里少一张谁也不知道,只能等收件人自己数出来。
  if (imageBlocked.length) {
    lines.push(`【图片没进包·一票一图不成立】${imageBlocked.length} 张小票:`);
    for (const m of imageBlocked.slice(0, 20)) lines.push(`  - ${m}`);
    if (imageBlocked.length > 20) lines.push(`  …等共 ${imageBlocked.length} 张`);
    // ⚠️ 这里**不能**统一说「点『查看原图』框出各自的范围」(2026-08-01 修)。
    // 三处错:
    //   ① 上面每一条都自带 lib/delivery_render.describeBlock 给出的**逐条**做法,
    //      而这句一网打尽的尾巴把它们全推翻了;
    //   ② duplicate_crop_file 这类的图是**切片**,lib/manual_doc_box.canAcceptManualBox
    //      对切片任务直接返回 ok:false 并 400 拒绝,前端按钮画的就是禁用的
    //      「画框(这条不行)」—— 照这句去做必然撞墙;
    //   ③ 审核台里根本没有叫「查看原图」的控件,按钮是「回原图」/「看切片」,
    //      而且 0730 主态翻转后原图已经是默认视图。
    // delivery_render.js 里两处注释白纸黑字写过「那等于第三次给操作员指一个做不到的动作」,
    // 这个兄弟文件里那句话却原封没动 —— 同一条规矩没有单一出口的后果。
    // 这张纸是发给上家/结算对方的,写错=对方按它做、做不成、认为系统坏了。
    lines.push('  → 这些票的账已经在表里,只是图没进包。');
    lines.push('    每条后面的括号里写了它自己的原因和可行做法,请按那条做 ——');
    lines.push('    不同原因的处理方式不一样,没有统一的一步。处理完重新导出即可。');
  }
  if (missingSource.length) {
    lines.push(`【源图取不到·没进包】${missingSource.length} 张图在系统里找不到源文件:`);
    for (const m of missingSource.slice(0, 20)) lines.push(`  - ${m}`);
    if (missingSource.length > 20) lines.push(`  …等共 ${missingSource.length} 张`);
    lines.push('  这是我们这边的文件问题,不用找客户;排查回原图后重新导出即可补齐。');
  }
  // 与【没有护照图】必须分开报:那条是"客户没交护照,请回报姓名";这条是"客户交了,
  // 图在我们这儿丢了"。混在一起会让上家白跑一趟——他手上根本没有能补的东西。
  if (passportSourceLost.length) {
    lines.push(`【护照图丢失·非客户问题】${passportSourceLost.length} 个客户缺护照图,但客户**是交过**的:`);
    for (const p of passportSourceLost.slice(0, 20)) {
      lines.push(`  - ${folderListOf(p).join('、')}(上家:${p.zone};客户号 ${p.customerId})`);
    }
    if (passportSourceLost.length > 20) lines.push(`  …等共 ${passportSourceLost.length} 个客户`);
    lines.push('  原因不是客户没交——是护照图在我们系统里取不到。');
    lines.push('  请勿向客户索要;内部找回原图后重新导出即可补齐。');
  }
  if (copyFailed.length) {
    lines.push(`【文件缺失】${copyFailed.length} 张图复制失败没进包,交付前请核对:`);
    for (const f of copyFailed.slice(0, 20)) lines.push(`  - ${f}`);
    if (copyFailed.length > 20) lines.push(`  …等共 ${copyFailed.length} 张`);
  }
  return lines.length ? ['交付包导出说明(系统自动生成)', ''].concat(spaceSections(lines)) : null;
}

function createModeDeliveryExportService({ resolveBatchRelativePath, hyundaiDeliveryExportService = null, dailyReceiptRepo = null }) {
  if (typeof resolveBatchRelativePath !== 'function') {
    throw new Error('mode_delivery_export_service: resolveBatchRelativePath required');
  }
  // monthlyDb 构造晚于本服务(workbench_server 顶层 vs async main),setter 晚绑定注入
  // (同 setLedgerBridgeService 模式);未注入=回落 modeRawPre,行为与旧版一致。
  let ledgerRepo = dailyReceiptRepo;

  // ── 分桶两源优先级(2026-07-20 交付包五问题#2):**台账 mode_raw > 任务 modeRawPre** ──
  // modeRawPre 是预匹配快照;结算后的终匹配/人工补救只改台账 mode_raw。客户数据表
  // (library_mode_export)按台账行出,分桶若还认快照,同一客户会"表在PKG、夹在SG"两源分家。
  // 台账行 mode_raw 为空(终匹配没跑完/待补救)不覆盖,仍回落快照——别把已命中的桶清掉。
  function loadLedgerModeMap(batchId) {
    if (!ledgerRepo?.listModeRawBySourceBatch || !textOf(batchId)) return new Map();
    try {
      const map = new Map();
      for (const row of ledgerRepo.listModeRawBySourceBatch({ sourceBatchId: batchId }) || []) {
        const taskId = textOf(row?.sourceTaskId);
        const mode = textOf(row?.modeRaw);
        if (taskId && mode) map.set(taskId, mode);
      }
      return map;
    } catch (err) { // 台账查询故障不拦交付:回落快照口径并留痕
      logger.warn({ event: 'mode_delivery_ledger_mode_map_failed', batchId, err: err?.message }, 'ledger mode map failed, fallback modeRawPre');
      return new Map();
    }
  }

  function resolveTaskFile(batchId, task) {
    const rel = textOf(task?.sourceImagePath);
    if (!rel) return '';
    let abs;
    try { abs = resolveBatchRelativePath(batchId, rel); } catch { return ''; }
    try { return abs && fs.statSync(abs).isFile() ? abs : ''; } catch { return ''; }
  }

  // 计划(只读):产出扁平文件清单 [{ zone 相对目录, fileName 期望名, sourcePath }] + 护栏名单。
  function planModeDelivery(batch) {
    // 五问题#2:台账优先分桶(sourceTaskId → 台账 mode_raw;无行回落 modeRawPre)
    const ledgerModes = loadLedgerModeMap(batch?.id);
    const resolveTaskMode = (t) => textOf(ledgerModes.get(textOf(t?.id))) || modeOf(t);
    const byCustomer = new Map();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ref = parseCustomerRefFromTask(task);
      if (!ref.workspaceKey || !ref.customerId) continue;
      const key = `${ref.workspaceKey}/${ref.customerId}`;
      if (!byCustomer.has(key)) byCustomer.set(key, { ref, tasks: [] });
      byCustomer.get(key).tasks.push(task);
    }

    const files = []; // { dir(相对staging,POSIX), baseName(不带扩展名), sourcePath }
    const skippedUnreviewed = [];
    const missingSActivityReceiptNo = [];
    const missingSActivityDetails = []; // 与上面平行,多带 mode(切片时按渠道区过滤阻断;字符串数组形状不动)
    const missingDeptTransNo = []; // 规则5:新世界/现代百货缺交易编码(图/夹都按它命名,缺=阻断)
    const missingDeptTransNoDetails = []; // 平行明细,多带 zone=上家区(切片阻断按区过滤)
    const namePendingCustomers = []; // 规则5 缺护照名单(不阻断;夹名不再标记,靠导出说明按交易编号点名)
    let noRecordReceiptCount = 0;    // 「不用记」小票张数(只统计不过滤,见下方循环注释)
    // 0729 静默排查:源图在磁盘上取不到时,四处 continue 都是裸跳过——包里就少这张图,
    // 谁也不知道。兄弟服务(乐天百货/现代)早就有 missingSource 名单,唯独本文件漏了。
    const missingSource = [];
    // 一票一图护栏(0729 第3期):同一个图片文件挂在多条小票记录上时,
    // 照旧出图会把同一张照片当成多笔交易发出去 —— 上家会认为我们重复报账。
    const imageBlocked = [];
    const planImage = createDeliveryImagePlanner(batch);
    // 「交了护照但图丢了」必须与「压根没交护照」分开:后者要上家回报姓名,前者是我们自己
    // 的图没了,去找客户要姓名等于把我们的故障说成客户的问题。
    const passportSourceLost = [];
    const noRecordModeSet = new Set();
    const countedCustomers = new Set(); // 跨模式/现代混搭客户只计一次(审查MEDIUM意见)

    // ⭐审计M7:folderBase=英文名+护照前4,同名+同前4的两客户会撞成同一夹→资料合并交付给上家。
    // 按客户唯一化叶子夹(顶层模式/团号段不变,不影响切片汇总):撞名不同客户加护照后4/客户号后缀,
    // 同客户恒返回同夹(幂等)。folderBase 也随之改,文件名前缀同步一致。
    const folderOwners = new Map(); // dir → customerId
    function resolveUniqueFolder(scopeSegs, baseFolderBase, customerId, passportNo) {
      const dirOf = (fb) => path.posix.join(...scopeSegs.map(sanitize), sanitize(fb));
      let fb = baseFolderBase;
      const owner = folderOwners.get(dirOf(fb));
      if (owner !== undefined && owner !== customerId) {
        const disc = textOf(passportNo).slice(-4) || String(customerId).slice(-4) || 'x';
        let cand = `${baseFolderBase}_${disc}`;
        let n = 2;
        while (folderOwners.has(dirOf(cand)) && folderOwners.get(dirOf(cand)) !== customerId) cand = `${baseFolderBase}_${disc}_${n++}`;
        fb = cand;
      }
      folderOwners.set(dirOf(fb), customerId);
      return { dir: dirOf(fb), folderBase: fb };
    }

    for (const { ref, tasks } of byCustomer.values()) {
      const allReceipts = tasks.filter((t) => docTypeOf(t) === 'receipt');
      // 统计「不用记」小票(只数不滤):它们的账单行按 0724 拍板不进任何导出表,图却照进包,
      // 于是包里图数 > 账单行数。差额本身合规,但此前无人告知收件人 → 写进导出说明。
      // 用 resolveTaskMode 而非任务快照:分桶都以台账 mode_raw 为准,统计口径必须一致,
      // 否则说明里的数字和包里实际内容对不上,反而制造新的对不上。
      for (const t of allReceipts) {
        const mode = resolveTaskMode(t);
        if (mode && isNoRecordMode(mode)) { noRecordReceiptCount += 1; noRecordModeSet.add(mode); }
      }
      const familyOf = (t) => normalizeStoreFamily(t.receiptStoreFinal || t.receiptStoreAuto);
      // 分流三路:现代免税店→三池(规则2,下方复用 planDelivery);新世界/现代百货→上家专链
      // (规则5,不再进模式夹防一票两包);其余进"按模式整理"的桶(规则1/3/4)。
      const upstreamDeptReceipts = allReceipts.filter((t) => DEPT_UPSTREAM_FAMILIES.has(familyOf(t)));
      // 乐天百货(LOTTE_DEPT)有独立《乐天百货交付包》(lotte_dept_delivery_export),不进"按模式整理"
      // 的通用桶——否则同票两包/串给错误上家(审计 HIGH::24/:50 注释本已声明"不在此列",但此前过滤器
      // 只兑现了新世界/现代百货、漏了乐天)。它不走上家专链,故仅从 modeReceipts 排除即可。
      const modeReceipts = allReceipts.filter((t) => familyOf(t) !== STORE_FAMILIES.HYUNDAI
        && familyOf(t) !== STORE_FAMILIES.LOTTE_DEPT
        && !DEPT_UPSTREAM_FAMILIES.has(familyOf(t)));
      if (!modeReceipts.length && !upstreamDeptReceipts.length) continue;

      if (!tasks.every((t) => t.reviewed)) {
        skippedUnreviewed.push(ref.customerId);
        continue;
      }

      // 五问题#1:组级身份统一走 selectGroupIdentity(护照任务优先;免税店小票 OCR 名绝不入选)
      const identity = selectGroupIdentity(tasks, ref.customerId);
      const englishName = identity.name;
      const p4 = passportPrefix4(identity.passportNo);
      // 用户拍板:姓名与护照前4之间加空格(WANG YI EB23);前4不成形则只留姓名
      const personKey = p4 ? `${englishName} ${p4}` : englishName;
      const passportNo = identity.passportNo; // 审计M7:撞名判别用(同一选取器,禁两套)

      // 小票分桶 → 每个涉及的桶各建一个客户文件夹(用户拍板:上家各自独立交付)。
      // 济州道辉按「模式+团号」分桶(审查HIGH意见):同客户两个团号的小票绝不能混进
      // 第一个团号的文件夹;其他模式团号不进路径,按模式分桶即可。
      const buckets = new Map(); // key → { mode, groupNo, receipts }
      for (const t of modeReceipts) {
        const mode = resolveTaskMode(t) || UNCLASSIFIED_ZONE; // 台账优先(五问题#2)
        const isJeju = mode.startsWith(JEJU_DOHUI_PREFIX);
        const groupNo = isJeju ? (textOf(t.groupNoFinal || t.groupNoAuto) || '无团号') : '';
        const key = `${mode}\u0000${groupNo}`;
        if (!buckets.has(key)) buckets.set(key, { mode, groupNo, receipts: [] });
        buckets.get(key).receipts.push(t);
      }

      const passports = tasks.filter((t) => docTypeOf(t) === 'passport');
      const flights = tasks.filter((t) => ['other', 'ticket'].includes(docTypeOf(t)));

      let hasFile = false;
      for (const { mode, groupNo, receipts } of buckets.values()) {
        const isJeju = mode.startsWith(JEJU_DOHUI_PREFIX);
        // 规则1:济州道辉客户文件夹前缀带团号;规则3:姓名+护照前4
        const baseFolderBase = isJeju ? `${groupNo}—${personKey}` : personKey;
        // 审计M7:撞名不同客户 → 唯一化叶子夹(顶层模式/团号段不变;同客户恒同夹)
        const scopeSegs = isJeju ? [JEJU_DOHUI_PREFIX, groupNo] : [mode];
        const { dir, folderBase } = resolveUniqueFolder(scopeSegs, baseFolderBase, ref.customerId, passportNo);

        let idx = 0;
        for (const t of receipts) {
          const file = resolveTaskFile(batch.id, t);
          if (!file) { missingSource.push(`${ref.customerId}/${t.id}(小票)`); continue; }
          const imagePlan = planImage(t);
          if (imagePlan.action === 'block') {
            imageBlocked.push(`${ref.customerId}/${t.id}(小票):${describeBlock(imagePlan.reason)}`);
            continue;
          }
          idx += 1;
          files.push({
            dir, baseName: `${folderBase}_小票${idx}`, sourcePath: file,
            cropRect: imagePlan.action === 'crop' ? imagePlan.rect : null,
          });
          hasFile = true;

          // 规则4:S活动小票另复制一份,以小票号命名(按模式格式化:乐天S活动=digits14 纯数字去杠)。
          // 判定=模式名含S活动 或 票级红标签 sActivityFlag(2026-07-20 修:S活动是票面属性,
          // 普通模式的红标签票此前永不触发;flag 票落 S活动/{它自己的桶模式}/,未归类也成立)。
          if (mode.includes(S_ACTIVITY_MARK) || t.sActivityFlag === true) {
            const receiptNo = textOf(formatReceiptNoByMode(t, mode));
            if (!receiptNo) {
              missingSActivityReceiptNo.push(`S活动:${ref.customerId}/${t.id}`);
              missingSActivityDetails.push({ label: `S活动:${ref.customerId}/${t.id}`, mode });
            } else {
              files.push({
                dir: path.posix.join(sanitize(S_ACTIVITY_MARK), sanitize(mode)),
                baseName: receiptNo,
                sourcePath: file,
              });
            }
          }
        }
        // 护照/机票每个涉及模式区各放一份
        let pIdx = 0;
        for (const t of passports) {
          const file = resolveTaskFile(batch.id, t);
          if (!file) { missingSource.push(`${ref.customerId}/${t.id}(护照)`); continue; }
          pIdx += 1;
          files.push({ dir, baseName: `${folderBase}_护照${pIdx > 1 ? pIdx : ''}`, sourcePath: file });
          hasFile = true;
        }
        let fIdx = 0;
        for (const t of flights) {
          const file = resolveTaskFile(batch.id, t);
          if (!file) { missingSource.push(`${ref.customerId}/${t.id}(机票)`); continue; }
          fIdx += 1;
          files.push({ dir, baseName: `${folderBase}_机票${fIdx > 1 ? fIdx : ''}`, sourcePath: file });
          hasFile = true;
        }
      }

      // ── 规则5:新世界/现代百货上家专链(2026-07-20)────────────────────────
      // {上家}/{代理}/{交易编码客户夹}/{交易编码}.ext + 护照.ext;上家名=顶层段即渠道区
      // (summarizeZones/entryInZone/单渠道切片/预检按既有顶层段机制零改自动工作)。
      if (upstreamDeptReceipts.length) {
        // 代理夹:与台账桥 agent 列同一取值链(customerAgentName 建档桥注入;旧任务被
        // normalizeTask 白名单事故抹空时退组标签链)——夹名与客户数据 Excel 代理列对得上。
        const agentFolder = textOf(tasks.map((t) => t.customerAgentName).find(Boolean))
          || textOf(tasks.map((t) => t.sourceGroupLabel).find(Boolean))
          || textOf(tasks.map((t) => t.sourceFolderName).find(Boolean))
          || textOf(tasks.map((t) => t.sourceFolderPath).find(Boolean))
          || UNKNOWN_AGENT;
        // 0729 归因修正:原来是 passports.map(resolve).filter(Boolean),于是「客户压根没交护照」
        // 和「交了但图在磁盘上取不到」压成同一个空数组 → 后者也被报成「客户没交护照」,
        // 交付说明还叫上家「按客户号回报姓名」。那是把我们自己的图丢了说成客户的问题,
        // 上家照做也补不出东西来。两种情况必须分开报,行动指引完全不同。
        const passportFiles = [];
        for (const t of passports) {
          const pf = resolveTaskFile(batch.id, t);
          if (pf) passportFiles.push(pf);
          else missingSource.push(`${ref.customerId}/${t.id}(护照·上家链)`);
        }
        const passportLost = passports.length > 0 && passportFiles.length === 0;
        // 同客户小票可跨上家(现代:贴金浦奥莱积分卡=金浦奥莱,其余=东方)→ 按上家分桶各自成夹,
        // 护照随各上家夹各一份(跨区各一份先例)。上家=票值||档案默认,恒有值不进未归类。
        const byUpstream = new Map();
        for (const t of upstreamDeptReceipts) {
          // 上家=票值||档案默认(resolveDeptUpstream 单一真相,存量回填脚本同源)
          const upstream = resolveDeptUpstream(familyOf(t), t) || UNKNOWN_UPSTREAM;
          if (!byUpstream.has(upstream)) byUpstream.set(upstream, []);
          byUpstream.get(upstream).push(t);
        }
        for (const [upstream, bucketReceipts] of byUpstream) {
          const deliverable = [];
          for (const t of bucketReceipts) {
            const file = resolveTaskFile(batch.id, t);
            if (!file) { missingSource.push(`${ref.customerId}/${t.id}(百货小票)`); continue; }
            // 交易编码按**票面形态**出(dash44:带杠原样,存量 8 位裸值补成 4-4)。
            // 0731 收口:这里原来直接取存储裸值,而客户数据 Excel 那列走 formatReceiptNoByMode
            // → 同一张票,夹名叫 39442108、账单写 3944-2108,上家两边对不上号(核账报告 idx42 边界②)。
            // 现在两边同一个函数、同一个模式规则,是同一个计算,不是"看起来一样"。
            const transNo = textOf(formatReceiptNoByMode(t, resolveTaskMode(t)));
            if (!transNo) {
              missingDeptTransNo.push(`百货:${ref.customerId}/${t.id}`);
              missingDeptTransNoDetails.push({ label: `百货:${ref.customerId}/${t.id}`, zone: upstream });
              continue;
            }
            // ⭐一图一票护栏(0729 第3期):这条链此前**没接**,而规则1/3 接了。
            // 一张照片上两张新世界票、各自一个交易编号 → 照旧出图会把同一张照片
            // 当成两笔交易发给上家(重复报账)。14-3 改成一票一夹之后更刺眼:
            // 两个交易编号夹,里面躺着一模一样的图。与乐天百货 0731 那处同一个原型。
            const imagePlan = planImage(t);
            if (imagePlan.action === 'block') {
              imageBlocked.push(`${ref.customerId}/${t.id}(百货小票):${describeBlock(imagePlan.reason)}`);
              continue;
            }
            deliverable.push({
              transNo, file, cropRect: imagePlan.action === 'crop' ? imagePlan.rect : null,
            });
          }
          if (!deliverable.length) continue;
          // ⭐14-3(0731 拍板):**一票一夹,夹名=该票交易编号**,夹里就那一张票 + 护照。
          //
          // 原来是"一个客户一个夹,夹名取桶内最小交易编码;没有独立护照就叫 姓名待补_{客户号}"
          // (0720 拍板 a)。而 14-3 的原话是「文件夹要以交易编码命名」,主场是**新世界百货**,
          // 偏偏新世界标了 passportFree(票面本就无护照)→「没有独立护照」是常态不是例外,
          // 于是大多数夹叫 `姓名待补_CL20260727-054`,与需求正面冲突(用户截图 image64 圈的就是它)。
          //
          // 0731 用户拍板:有几张票就几个夹,上家按交易编号对账时一找就到。
          // 「这个客户没交护照」不再靠夹名喊,改由导出说明.txt 点名(信息不丢,且本来就在报)。
          // 撞夹唯一化仍在(不同客户撞同一个交易编号时加后缀),同客户恒同夹(幂等)。
          const myFolders = [];
          for (const e of deliverable) {
            const { dir } = resolveUniqueFolder([upstream, agentFolder], e.transNo, ref.customerId, passportNo);
            myFolders.push(e.transNo);
            // layout 标记(2026-07-27):打包时这里**确定知道**自己走的是规则⑤按上家整理,
            // 直接写在条目上;summarizeZones 读它,不必再拿上家名单去反推。
            // 上家来自审核员可手填的 upstreamFinal,名单永远追不全(出现「王总」就标错)。
            files.push({
              dir, baseName: e.transNo, sourcePath: e.file, cropRect: e.cropRect, layout: LAYOUT_BY_UPSTREAM,
            });
            hasFile = true;
            let pIdx = 0;
            for (const pf of passportFiles) {
              pIdx += 1;
              files.push({ dir, baseName: `护照${pIdx > 1 ? pIdx : ''}`, sourcePath: pf, layout: LAYOUT_BY_UPSTREAM });
            }
          }
          // 缺护照回执(0728 截图驱动,image64 实锤:全靠人翻夹子才发现)→ 记名单,
          // 导出时写进 zip 根部「导出说明.txt」。夹名已不再承担这个信息,说明里必须点到交易编号。
          if (passportLost) {
            // 交了护照但图丢了:这是我们内部的事,别写进「客户没交护照」去麻烦上家
            passportSourceLost.push({ customerId: ref.customerId, zone: upstream, folders: myFolders });
          } else if (!passportFiles.length) {
            namePendingCustomers.push({ customerId: ref.customerId, zone: upstream, folders: myFolders });
          }
        }
      }
      if (hasFile) countedCustomers.add(ref.customerId);
    }

    // 规则2:现代三池复用现代交付包的 planDelivery,整体挂在 现代免税店/ 下
    let hyundaiPlan = null;
    if (hyundaiDeliveryExportService?.planDelivery) {
      hyundaiPlan = hyundaiDeliveryExportService.planDelivery(batch);
      const poolDirs = { passport: '护照', flight: '机票', receipt: '小票' };
      for (const [pool, entries] of Object.entries(hyundaiPlan.pools || {})) {
        for (const entry of entries) {
          files.push({
            dir: path.posix.join(HYUNDAI_ZONE, poolDirs[pool]),
            baseName: entry.baseName,
            sourcePath: entry.sourcePath,
          });
        }
      }
      for (const cid of hyundaiPlan.skippedUnreviewed || []) {
        if (!skippedUnreviewed.includes(cid)) skippedUnreviewed.push(cid);
      }
      // 现代客户计数并入去重集合:纯现代客户按现代计划补计;混搭客户(模式区已计)不重复。
      // planDelivery 不回客户ID,这里按同口径(有现代小票+整组已审)自行归因。
      for (const { ref, tasks } of byCustomer.values()) {
        const hasHyundai = tasks.some((t) => docTypeOf(t) === 'receipt'
          && normalizeStoreFamily(t.receiptStoreFinal || t.receiptStoreAuto) === STORE_FAMILIES.HYUNDAI);
        if (hasHyundai && tasks.every((t) => t.reviewed)) countedCustomers.add(ref.customerId);
      }
    }

    return {
      customers: countedCustomers.size,
      files,
      skippedUnreviewed,
      missingSActivityReceiptNo,
      missingSActivityDetails,
      missingDeptTransNo,
      missingDeptTransNoDetails,
      namePendingCustomers,
      // 现代三池是 hyundaiDeliveryExportService 并进来的,它自己算了 missingSource,
      // 但这一层原来只捞 pools / missingReceiptNo / skippedUnreviewed,把它原地扔了 ——
      // 下游服务把数据算好了,上游又丢掉,是今天反复出现的同一个形状。
      missingSource: [...missingSource, ...((hyundaiPlan?.missingSource || []).map((x) => '现代:' + x))],
      imageBlocked: [...imageBlocked, ...((hyundaiPlan?.imageBlocked || []).map((x) => '现代:' + x))],
      passportSourceLost,
      noRecordReceiptCount,
      noRecordModes: [...noRecordModeSet].sort(),
      missingHyundaiReceiptNo: (hyundaiPlan?.missingReceiptNo || []).map((id) => `现代:${id}`),
      fileCount: files.length,
    };
  }

  // opts.zone(2026-07-16 单渠道切片)/ opts.zones(2026-07-28 多选导出,F4 参考图落地):
  // 只打包选中的渠道区(顶层文件夹)。多选=同一套过滤对多个区取并集,一个 zip 出全部选中区。
  // ⭐红线:切片=对同一份 plan 产物做输出过滤,分拣规则零改动;不传=逐字节旧行为(整包)。
  async function exportZip(batch, opts = {}) {
    const zones = [
      ...new Set(
        (Array.isArray(opts.zones) ? opts.zones : [opts.zone])
          .map((z) => textOf(z)).filter(Boolean),
      ),
    ];
    const zoneSet = new Set(zones.map((z) => sanitize(z)));
    const inSelected = (zoneName) => !zones.length || zoneSet.has(sanitize(zoneName));
    const plan = planModeDelivery(batch);

    // 阻断口径:全量=全部;切片=只算选中渠道区的(别的区缺票号不该拦住这些区的交付)
    const sMissing = !zones.length
      ? plan.missingSActivityReceiptNo
      : (plan.missingSActivityDetails || [])
        .filter((d) => inSelected(zoneOfMode(d.mode)))
        .map((d) => d.label);
    const hMissing = inSelected(HYUNDAI_ZONE) ? plan.missingHyundaiReceiptNo : [];
    // 规则5 缺交易编码:切片时只算选中上家区的(别的上家缺号不拦这些上家的交付)
    const dMissing = !zones.length
      ? plan.missingDeptTransNo
      : (plan.missingDeptTransNoDetails || [])
        .filter((d) => inSelected(d.zone))
        .map((d) => d.label);
    const missing = [...sMissing, ...hMissing, ...dMissing];
    if (missing.length) {
      const err = new Error(`有小票缺小票号(S活动/现代池/百货上家链按票号命名),补全后再导出: ${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}`);
      err.code = 'MODE_DELIVERY_RECEIPT_NO_MISSING';
      err.missing = missing;
      throw err;
    }
    const entries = zones.length
      ? plan.files.filter((e) => zones.some((z) => entryInZone(e, z, sanitize)))
      : plan.files;
    if (!entries.length) {
      const err = new Error(zones.length
        ? `渠道「${zones.join('、')}」在本批次没有可交付的已审核小票(整组审完才会进交付包)`
        : '本批次没有可交付的已审核小票(整组审完才会进交付包)');
      err.code = 'MODE_DELIVERY_EMPTY';
      err.skippedUnreviewed = plan.skippedUnreviewed;
      throw err;
    }
    // 沿用单区命名;多区后缀「选中N渠道」(zip 内各区仍是各自顶层夹,收件人一眼分清)
    const zone = zones.length === 1 ? zones[0] : (zones.length ? `选中${zones.length}渠道` : '');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-delivery-'));
    const stagingName = sanitize(`${batch?.name || batch?.id || 'batch'}_交付包${zone ? `_${zone}` : ''}`);
    const staging = path.join(work, stagingName);
    const usedByDir = new Map();
    const copyFailed = []; // 复制失败留痕(2026-07-14 审计#10):曾裸吞→交付包静默少图无从追查
    let croppedCount = 0; // 按框现裁出来的张数(0730 第3期)
    const exportImageBlocked = []; // 裁图失败 → 不进包,进导出说明(绝不回退整图)
    for (const entry of entries) {
      const absDir = path.join(staging, ...entry.dir.split('/'));
      fs.mkdirSync(absDir, { recursive: true });
      if (!usedByDir.has(entry.dir)) usedByDir.set(entry.dir, new Set());
      const name = uniqueExportFileName(
        `${sanitize(entry.baseName)}${extOf(entry.sourcePath)}`,
        usedByDir.get(entry.dir)
      );
      try {
        // 按框现裁(0730):crop 这个 action 原来算出来了却没人执行,会掉到原样复制
        // = 整图进包 = 同一张照片当成多笔交易。裁失败**绝不回退整图**。
        if (entry.cropRect) {
          const cr = await renderCroppedDelivery({
            sourcePath: entry.sourcePath, destPath: path.join(absDir, name), rect: entry.cropRect, sharp,
          });
          if (cr.cropped) { croppedCount += 1; continue; }
          exportImageBlocked.push(`${entry.dir}/${name}:按框裁图失败(${cr.reason}),没进包`);
          logger.warn({ event: 'delivery_crop_failed', pkg: 'mode_delivery', src: entry.sourcePath, reason: cr.reason }, 'delivery crop failed');
          continue;
        }
        await fsp.copyFile(entry.sourcePath, path.join(absDir, name));
      }
      catch (copyErr) { // 单文件失败仍不致命,但必须留痕+计数回报
        copyFailed.push(`${entry.dir}/${name}`);
        logger.warn({ event: 'delivery_copy_failed', pkg: 'mode_delivery', src: entry.sourcePath, dest: `${entry.dir}/${name}`, err: copyErr?.message }, 'delivery copy failed');
      }
    }

    // 导出说明.txt(包根):缺护照名单按选中渠道过滤(别的区的不该出现在这包里)
    const namePending = (plan.namePendingCustomers || []).filter((d) => inSelected(d.zone));
    const notes = buildDeliveryNotes({
      namePending, copyFailed, skippedUnreviewed: plan.skippedUnreviewed,
      noRecordReceipts: plan.noRecordReceiptCount || 0, noRecordModes: plan.noRecordModes || [],
      missingSource: plan.missingSource || [],
      imageBlocked: [...(plan.imageBlocked || []), ...exportImageBlocked],
      passportSourceLost: (plan.passportSourceLost || []).filter((d) => inSelected(d.zone)),
    });
    if (notes) {
      fs.mkdirSync(staging, { recursive: true });
      // UTF-8 BOM(\ufeff):收件方多为 Windows 记事本/WPS,带 BOM 保证中文不乱码
      fs.writeFileSync(path.join(staging, '导出说明.txt'), '\ufeff' + notes.join('\r\n') + '\r\n');
    }

    // 运维留痕:出包时的关键计数(handler 直接流 zip,返回值到不了日志)。
    logger.info({
      event: 'delivery_export_done',
      pkg: 'mode_delivery',
      files: entries.length,
      cropped: croppedCount,
      blocked: (plan.imageBlocked || []).length + exportImageBlocked.length,
    }, 'delivery export done');

    const zipPath = path.join(work, `${stagingName}.zip`);
    const res = await archiveZip(zipPath, stagingName, work);
    if (res.code === 'ZIP_UNAVAILABLE') {
      cleanupDir(work);
      const err = new Error('服务器缺少 zip / python3,无法打包导出');
      err.code = 'ZIP_UNAVAILABLE';
      throw err;
    }
    if (!res.ok || !fs.existsSync(zipPath)) {
      cleanupDir(work);
      const err = new Error(`打包失败: ${res.detail || '未知错误'}`);
      err.code = 'ZIP_FAILED';
      throw err;
    }
    return {
      zipPath,
      downloadName: `${stagingName}.zip`,
      zone: zone || null,
      customers: plan.customers,
      fileCount: entries.length,
      copyFailed: copyFailed.length,
      copyFailedSamples: copyFailed.slice(0, 8),
      namePending: namePending.length,
      namePendingSamples: namePending.slice(0, 8),
      skippedUnreviewed: plan.skippedUnreviewed,
      // 按框现裁张数(0730 第3期)。同乐天那份:原来只加不读。
      // 「框没传到导出层」时代码静默掉到整图复制,不失败也不进 blocked 名单 ——
      // 这个数是唯一能把"框生效了"和"框根本没到"分开的东西。
      croppedCount,
      cleanup: () => cleanupDir(work),
    };
  }

  return {
    planModeDelivery,
    exportZip,
    summarizeZones,
    zoneOfMode,
    // 台账仓库晚绑定(monthlyDb 构造晚于本服务;见 workbench_server 接线处)
    setDailyReceiptRepo(repo) { ledgerRepo = repo || null; },
  };
}

module.exports = {
  createModeDeliveryExportService,
  summarizeZones,
  zoneOfMode,
  entryInZone,
  buildDeliveryNotes,
  // 组级身份选取/护照前4(交付夹命名单一真相,回归测试直测)
  selectGroupIdentity,
  passportPrefix4,
};
