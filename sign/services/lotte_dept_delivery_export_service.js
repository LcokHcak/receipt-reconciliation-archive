'use strict';

/**
 * 乐天百货交付包导出(P4,2026-07-08;规范=docs/百货规范/lt.txt;
 * 2026-07-20 用户拍板重构=docs/plans/2026-07-20-百货交付重构-设计.md §1):
 *   总文件夹《{收票日期M.D}乐天百货小票》
 *     └ 门店夹(店名:明洞/蚕室/釜山/仁川;一店两码并一夹,未识别码原样)
 *         └ 客户夹《{购买日期M.D} {英文名}》(例 7.1 QIN SHIHUANG;姓名=组级身份选取器)
 *             ├ {交易编号}.jpg   ← 百货小票整图(combined 不切);0727#13-3:护照与小票
 *             │                    同框时,打包瞬间涂黑护照区(passport_mask,bbox 不可信
 *             │                    则回退原样并进 maskFallback 名单,绝不静默)
 *             └ 护照.jpg         ← 独立护照任务的完整护照图(不打码,供上家核身份);
 *                                  ⭐无独立护照任务 → 同框整图兜底充当护照图(拍板a),不再阻断
 *
 * 边界(沿用现代交付包五边界的口径):整组已审才交付(未审列 skipped);
 * 缺交易编号/缺门店 → 阻断名单一次性全列(绝不静默出残包);无独立护照不阻断,
 * 进 passportFallback 信息名单(2026-07-20 根因:乐天是同框店,合法客户常无独立护照任务,
 * 旧阻断把整批交付堵死=护照口径冲突);混店客户只取乐天百货票;同客户多张百货票各按
 * 交易编号命名,护照每客户夹一份;重名 uniqueExportFileName 加序号;单文件复制失败不致命。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseCustomerRefFromTask } = require('../lib/customer_ref');
const { normalizeStoreFamily, STORE_FAMILIES } = require('../lib/validation/field_rules');
const { deptBranchName } = require('../lib/store_profiles');
const { selectGroupIdentity } = require('./mode_delivery_export_service');
const { logger } = require('../lib/logger');
const { formatDateParts, formatReceiptNoByMode } = require('../lib/workbench_receipt_export');
const { maskPassportRegion, plausibleBbox } = require('../lib/passport_mask');
const { readPassportNationality } = require('../lib/qwen_ocr/nationality_probe');
const {
  createDeliveryImagePlanner, describeBlock, renderCroppedDelivery, remapBboxIntoCrop,
} = require('../lib/delivery_render');
const sharp = require('sharp');
const {
  archiveZip, sanitize, uniqueExportFileName, cleanupDir,
} = require('./batch_customer_data_export_service');

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

function textOf(value) {
  return String(value || '').trim();
}

function docTypeOf(task) {
  return textOf(task?.docTypeFinal || task?.docTypeAuto).toLowerCase();
}

// '2026-07-01' → '7.1'(规范例:7.1QIN SHIHUANG / 7.1乐天百货小票)
function formatMonthDay(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(textOf(isoDate));
  if (!m) return '';
  return `${Number(m[2])}.${Number(m[3])}`;
}

// 导出说明.txt 内容(0728 静默缺口):打码/国籍/缺图回执原本只在 exportZip 返回值里,
// handler 直接流 zip 全被丢弃——包里这张纸是审核员发包前唯一能看到回执的地方。
// 干净包返回 null 不写(不给收件人塞噪音)。纯函数,直测。
function buildLotteDeliveryNotes({
  maskFallback = [], nationalityMissing = [], copyFailed = [], missingSource = [], unmaskable = [],
  imageBlocked = [],
  skippedUnreviewed = [],
} = {}) {
  const lines = [];
  const listOut = (arr, cap = 20) => {
    for (const f of arr.slice(0, cap)) lines.push(`  - ${f}`);
    if (arr.length > cap) lines.push(`  …等共 ${arr.length} 张`);
  };
  // 未审完整组不进包(既有边界):此前只在被丢弃的返回值里,包里不提 → 少发了谁看不见
  if (skippedUnreviewed.length) {
    lines.push(`【未进包·还没审完】${skippedUnreviewed.length} 个客户组整组未审完,按规则没进本包:`);
    listOut(skippedUnreviewed);
    lines.push('  审完后重新导出即可收进来。');
  }
  // ⚠️最重要的一条置顶:护照没遮住就出包 = 合规风险,发包前必须有人看见
  if (unmaskable.length) {
    lines.push(`【⚠️护照未遮盖】${unmaskable.length} 张同框图**定位不到护照区,原样出包(护照信息可见)**。`);
    lines.push('  乐天百货票面是护照+小票同框;这些图未能自动打码,发给上家前请人工处理或确认可发:');
    listOut(unmaskable);
  }
  if (maskFallback.length) {
    lines.push(`【护照未打码】${maskFallback.length} 张同框图打码失败、按原样出包,发给上家前请人工确认:`);
    listOut(maskFallback);
  }
  if (nationalityMissing.length) {
    lines.push(`【国籍未印出】${nationalityMissing.length} 张遮罩上没印出国籍(机读区读不出,已整区全遮不泄露):`);
    listOut(nationalityMissing);
  }
  if (copyFailed.length) {
    lines.push(`【文件缺失】${copyFailed.length} 张图复制失败没进包,交付前请核对:`);
    listOut(copyFailed);
  }
  if (imageBlocked.length) {
    lines.push(`【图片没进包·一票一图不成立】${imageBlocked.length} 张小票:`);
    listOut(imageBlocked);
    // ⚠️ 同 mode_delivery 那份(2026-08-01 一起修):不能统一说「点『查看原图』框出范围」。
    // duplicate_crop_file 这类的图是切片,manual_doc_box 直接 400 拒绝;
    // 而且审核台没有叫「查看原图」的按钮(是「回原图」/「看切片」)。
    // 逐条原因里已经带了各自可行的做法,这句一网打尽的尾巴会把它们全推翻。
    lines.push('  → 这些票的账已经在表里,只是图没进包。');
    lines.push('    每条后面的括号里写了它自己的原因和可行做法,请按那条做 ——');
    lines.push('    不同原因的处理方式不一样,没有统一的一步。处理完重新导出即可。');
  }
  if (missingSource.length) {
    lines.push(`【源图缺失】${missingSource.length} 张小票在服务器上找不到源图:`);
    listOut(missingSource);
  }
  return lines.length ? ['交付包导出说明(系统自动生成)', ''].concat(lines) : null;
}

function createLotteDeptDeliveryExportService({ resolveBatchRelativePath }) {
  if (typeof resolveBatchRelativePath !== 'function') {
    throw new Error('lotte_dept_delivery_export_service: resolveBatchRelativePath required');
  }

  function resolveTaskFile(batchId, task) {
    const rel = textOf(task?.sourceImagePath);
    if (!rel) return '';
    let abs;
    try { abs = resolveBatchRelativePath(batchId, rel); } catch { return ''; }
    try { return abs && fs.statSync(abs).isFile() ? abs : ''; } catch { return ''; }
  }

  // 计划(只读):entries=[{branch, customerDir, baseName, sourcePath}] + 阻断/跳过名单
  function planDelivery(batch) {
    const byCustomer = new Map();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ref = parseCustomerRefFromTask(task);
      if (!ref.workspaceKey || !ref.customerId) continue;
      const key = `${ref.workspaceKey}/${ref.customerId}`;
      if (!byCustomer.has(key)) byCustomer.set(key, { ref, tasks: [] });
      byCustomer.get(key).tasks.push(task);
    }

    const entries = [];
    const skippedUnreviewed = [];
    const missingReceiptNo = [];
    const missingBranch = [];
    // 源图在磁盘缺失的百货小票:resolve 阶段不静默丢,记下让出包前可见(对齐 hyundai/export_plan)。
    const missingSource = [];
    // 一票一图护栏(0729 第3期):同一个图片文件挂在多条小票记录上时,
    // 照旧出图会把同一张照片当成多笔交易发出去。宁可不进包,也不能发错。
    const imageBlocked = [];
    const planImage = createDeliveryImagePlanner(batch);
    const passportFallback = []; // 无独立护照任务、用同框整图充当护照图的客户(信息名单,不阻断)
    // 未能定位护照区 → 该同框图**原样出包(护照没遮)**。2026-07-29 生产核验实锤:
    // 乐天百货 split='none' 整图直通,合并时护照 bbox 被丢(qwen_split_service:191 强制
    // bbox=[0,0,1,1] 整图),打码的面积闸正确拒绝整图 → 结构性永不触发,且此前**完全静默**
    // (只有"有 bbox 但打码失败"才进 maskFallback)。这里如实记名单,写进导出说明让人发包前看见。
    const unmaskable = [];
    let customers = 0;

    // ⭐审计M6:客户夹名=月日+英文名,两个同名+同门店+同购买日的客户会撞成同一夹→第二人护照被
    // 去重跳过、小票并进他人夹交付给上家(串包+护照丢失,且不进阻断名单)。这里按客户唯一化夹名:
    // 撞名不同客户时加护照后4/客户号后缀区分;同客户重复解析恒返回同一夹(幂等)。
    const dirOwners = new Map(); // `${branch} ${dir}` → 人的身份键(护照号优先,见 ownerKeyOf)
    // 夹的「主人」按**人**认,不按客户组认(0727#13-2,0731 修)。
    //
    // 原来 owner 存的是 customerId。同一个人被建成两个客户组(分两次上传、
    // 或跨批次)时,第二个组会被当成"撞名的另一个人"而加后缀 ——
    // 用户截图里的 `7.22 VU DIEPKHANHHUYEN` / `7.22 VU DIEPKHANHHUYEN_5196`、
    // `7.26 ZHANG JIAJING` / `7.26 ZHANG JIAJING_3845` 就是这么来的:
    // 同一个人同一天,却出了两个夹。而他的诉求原话是
    // 「一个人多张小票,但是购买日期相同的,应该放在一个文件夹里」。
    //
    // 改成:有护照号就用护照号当主人(同一本护照 = 同一个人,跨组也合并),
    // 没有护照号才退回 customerId(退回后行为与改动前一致,不会更差)。
    // ⚠️ 治不了的一种:同一个人两次 OCR 把护照号读得不一样 —— 那在数据层就是两个人,
    // 这里合不了,得靠 0727#9 那条姓名/护照规范去收。
    function ownerKeyOf(customerId, passportNo) {
      const pp = textOf(passportNo).toUpperCase().replace(/[^A-Z0-9]/g, '');
      return pp || `cid:${customerId}`;
    }

    function resolveCustomerDir(branch, baseDir, customerId, passportNo) {
      const keyOf = (d) => `${branch} ${d}`;
      const me = ownerKeyOf(customerId, passportNo);
      const owner = dirOwners.get(keyOf(baseDir));
      let dir = baseDir;
      if (owner !== undefined && owner !== me) {
        const disc = textOf(passportNo).slice(-4) || String(customerId).slice(-4) || 'x';
        let cand = `${baseDir}_${disc}`;
        let n = 2;
        while (dirOwners.has(keyOf(cand)) && dirOwners.get(keyOf(cand)) !== me) {
          cand = `${baseDir}_${disc}_${n++}`;
        }
        dir = cand;
      }
      dirOwners.set(keyOf(dir), me);
      return dir;
    }

    for (const { ref, tasks } of byCustomer.values()) {
      const deptReceipts = tasks.filter((t) => docTypeOf(t) === 'receipt'
        && normalizeStoreFamily(t.receiptStoreFinal || t.receiptStoreAuto) === STORE_FAMILIES.LOTTE_DEPT);
      if (!deptReceipts.length) continue; // 没有乐天百货票的客户不进本包

      if (!tasks.every((t) => t.reviewed)) {
        skippedUnreviewed.push(ref.customerId);
        continue;
      }

      // 组级身份=selectGroupIdentity 单一真相(2026-07-20 重构F3):护照任务优先→乐天同框票,
      // 绝不取免税店小票 OCR 残串当夹名(旧"全组第一个非空"同病已在 c081270 收口,这里对齐)。
      const identity = selectGroupIdentity(tasks, ref.customerId);
      const englishName = identity.name;
      const passportNo = identity.passportNo; // M6 撞名判别同源

      // 护照图:同客户独立护照任务(完整护照,不打码);⭐无独立护照 → 同框整图兜底(拍板a)
      const passportTasks = tasks.filter((t) => docTypeOf(t) === 'passport');
      const passportFile = passportTasks.length ? resolveTaskFile(batch.id, passportTasks[0]) : '';
      // 打码依据(0727反馈#13-3):护照任务与小票**同一源文件**(同框)且 bbox 可信 →
      // 该交易编号图打包时涂黑护照区。bbox 来自识别落盘 modelMeta(qwen 切图坐标,归一化);
      // 同客户多张同框票各自带各自的护照区 → 按文件建映射,不是只看第一个护照任务。
      const passportBboxByFile = new Map();
      for (const p of passportTasks) {
        const pf = resolveTaskFile(batch.id, p);
        const bb = p?.modelMeta?.bbox;
        if (pf && plausibleBbox(bb) && !passportBboxByFile.has(pf)) passportBboxByFile.set(pf, bb);
      }
      // ⭐0729 打码数据链修复(第二源):乐天百货 split='none' 整图不切,识别侧把护照分析
      // **并进了小票**,于是同框图根本不产生独立护照任务 → 上面这个循环永远空手而归。
      // 0729 全库核验:7 批 352 张同框票 0 张拿到过护照框,打码功能等于从未真正运行。
      // 护照位置现在留在小票自己的 modelMeta.passportBbox(见 qwen_split_service 合并处)。
      // 放在独立护照任务之后:真有独立护照任务时以它为准(那是完整护照图,框更准),
      // 同框兜底只填补空缺,不覆盖。
      for (const t of deptReceipts) {
        const tf = resolveTaskFile(batch.id, t);
        const bb = t?.modelMeta?.passportBbox;
        if (tf && plausibleBbox(bb) && !passportBboxByFile.has(tf)) passportBboxByFile.set(tf, bb);
      }

      let added = false;
      for (const t of deptReceipts) {
        const file = resolveTaskFile(batch.id, t);
        if (!file) {
          const rn = textOf(formatReceiptNoByMode(t, '乐天百货'));
          missingSource.push(`${ref.customerId}/${t.id}(小票${rn || '?'})`);
          continue;
        }
        // 交易编号按票面 4-4 带杠命名(0727反馈#13-4):旧去杠 8 位的前 4 位常与门店编号
        // 同形,用户在导出实件里认成"以门店编号命名了"。与 Excel 同走 dash44 形态单源
        // (formatReceiptNoByMode),存量去杠 8 位补杠、带杠原样。
        const imagePlan = planImage(t);
        if (imagePlan.action === 'block') {
          const rn0 = textOf(formatReceiptNoByMode(t, '乐天百货'));
          imageBlocked.push(`${ref.customerId}/${t.id}(小票${rn0 || '?'}):${describeBlock(imagePlan.reason)}`);
          continue;
        }
        const receiptNo = textOf(formatReceiptNoByMode(t, '乐天百货'));
        const branchCode = textOf(t.branchFinal || t.branchAuto);
        if (!receiptNo) missingReceiptNo.push(`${ref.customerId}/${t.id}`);
        if (!branchCode) missingBranch.push(`${ref.customerId}/${t.id}`);
        if (!receiptNo || !branchCode) continue;
        // 门店大夹=店名(2026-07-20 重构F2,规范 lt.txt「4个免税店要分开」):一店两码
        // (明洞0394/0001)并进同一店名夹;未识别码查不到店名 → 码原样成夹,不丢票。
        const branch = deptBranchName(STORE_FAMILIES.LOTTE_DEPT, branchCode) || branchCode;
        // 客户夹《{购买日期M.D} {英文名}》(2026-07-20 拍板:日期与姓名之间加空格)
        const baseDir = `${formatMonthDay(t.purchaseDateFinal || t.purchaseDateAuto)} ${englishName}`.trim() || englishName;
        // 审计M6:撞名不同客户 → 唯一化夹名(同客户恒返回同一夹)
        const customerDir = resolveCustomerDir(branch, baseDir, ref.customerId, passportNo);
        // 打码(0727#13-3):护照与本张小票同框 → 交易编号图携带护照 bbox,打包时涂黑。
        // 护照在别的文件里(独立护照照片)→ 本图没有护照,无需打码。
        const maskBbox = passportBboxByFile.get(file) || null;
        // 乐天百货 combined=true:票面本来就护照+小票同框。定位不到护照区 = 这张原样出包、
        // 护照没遮 —— 必须记名单(此前是完全静默的盲区,见 unmaskable 声明处的根因)。
        if (!maskBbox) unmaskable.push(`${branch}/${customerDir}/${receiptNo}`);
        // cropRect 有值 = 这条要按框现裁(不是直接用整图)。出图在 exportZip 里做。
        entries.push({
          branch, customerDir, baseName: receiptNo, sourcePath: file, maskBbox,
          cropRect: imagePlan.action === 'crop' ? imagePlan.rect : null,
        });
        // 护照每个"门店/客户夹"各一份(双图契约:小票在哪个夹,护照就陪到哪个夹);
        // 无独立护照任务时用该夹首张同框整图充当(票面自带打码护照,拍板a)。
        if (!entries.some((e) => e.branch === branch && e.customerDir === customerDir && e.baseName === '护照')) {
          entries.push({ branch, customerDir, baseName: '护照', sourcePath: passportFile || file });
        }
        added = true;
      }
      if (added) {
        customers += 1;
        if (!passportFile) passportFallback.push(ref.customerId);
      }
    }

    return {
      customers,
      entries,
      skippedUnreviewed,
      missingReceiptNo,
      missingBranch,
      missingSource,
      imageBlocked,
      passportFallback,
      unmaskable,
      fileCount: entries.length,
    };
  }

  async function exportZip(batch) {
    const plan = planDelivery(batch);
    // 无独立护照不再阻断(2026-07-20 拍板a:同框整图兜底);只有命名依据缺失才拦。
    const blocked = [
      ...plan.missingReceiptNo.map((s) => `缺交易编号:${s}`),
      ...plan.missingBranch.map((s) => `缺门店:${s}`),
    ];
    if (blocked.length) {
      const err = new Error(`乐天百货交付包有缺项,补全后再导出: ${blocked.slice(0, 8).join('、')}${blocked.length > 8 ? ' 等' : ''}`);
      err.code = 'LOTTE_DEPT_DELIVERY_BLOCKED';
      err.blocked = blocked;
      throw err;
    }
    if (!plan.entries.length) {
      const err = new Error('本批次没有已审核完成的乐天百货小票(整组审完才会进交付包)');
      err.code = 'NO_LOTTE_DEPT_RECEIPTS';
      err.skippedUnreviewed = plan.skippedUnreviewed;
      throw err;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte-dept-delivery-'));
    // 顶层夹「{M.D}乐天百货小票」的日期取 Asia/Seoul(韩国 UTC+9)当天:此前 toISOString 恒 UTC,
    // KST 凌晨 00:00-09:00 导出会写成前一天(审计MEDIUM)。复用 formatDateParts(KST 唯一真源,禁 UTC 副本)。
    // 注:该值语义=「导出当天」;若日后拍板改用「批次收票日」,在此换 formatDateParts(收票日) 即可。
    // 顶层夹日期=**收票日期**(0728 红批注核对:规范原文《收票日期+乐天百货小票》,
    // 生产包实锤出的是导出当天 7.27 而批次收票是 7.21——按批次建档日(KST)修正;
    // createdAt 缺失/坏值回退导出当天(宁可出旧行为也不炸导出)。
    const batchCreated = new Date(batch?.createdAt || '');
    const dayLabel = formatMonthDay(formatDateParts(
      Number.isNaN(batchCreated.getTime()) ? new Date() : batchCreated,
    ));
    const stagingName = sanitize(`${dayLabel}乐天百货小票`);
    const staging = path.join(work, stagingName);
    const usedByDir = new Map();
    const copyFailed = []; // 复制失败留痕(2026-07-14 审计#10):曾裸吞→交付包静默少图无从追查
    let maskedCount = 0;
    let croppedCount = 0; // 按框现裁出来的张数(0730 第3期)
    const imageBlocked = []; // 裁图失败 → 不进包,进导出说明(绝不回退整图)
    const maskFallback = []; // 打码失败回退原样复制的清单(0727#13-3:可见,不静默出未打码图)
    // 国籍露出(0728 拍板):遮罩上印「국적/Nationality: XXX」。读不出→照常全遮+进名单
    // (可见不阻断);读取带 <图>.nat.json 缓存,重复导出零 API 成本。
    let nationalityShown = 0;
    const nationalityMissing = [];
    for (const entry of plan.entries) {
      const dirRel = path.join(sanitize(entry.branch), sanitize(entry.customerDir));
      const destDir = path.join(staging, dirRel);
      fs.mkdirSync(destDir, { recursive: true });
      if (!usedByDir.has(dirRel)) usedByDir.set(dirRel, new Set());
      const ext = (path.extname(entry.sourcePath).match(IMAGE_EXT) ? path.extname(entry.sourcePath) : '.jpg');
      const name = uniqueExportFileName(`${sanitize(entry.baseName)}${ext}`, usedByDir.get(dirRel));
      const destPath = path.join(destDir, name);
      try {
        // ⭐0731 修的一个静默重复报账:这两段原来是**并列的 if,而打码那段成功就 continue**,
        // 于是「既要打码、又要按框裁」的 entry 永远走不到裁剪 —— 一张照片上两张票、
        // 审核员各画了一个框,两条 entry 带同一个 maskBbox、各带不同 cropRect,
        // 结果**写出两份一模一样的打码整图**,只是文件名是两个不同的交易编号。
        // 上家看到的就是同一张照片报了两笔账 —— 正是「一图一票」护栏要防的那件事,
        // 而且 imageBlocked 一条不记、导出说明里一个字没有,全静默。
        // 今天没走火只是因为存量数据取不到护照框(maskBbox 恒 null),数据链一通就活。
        //
        // 顺序按 0730 拍板:**先按框裁、再打码,顺序不能反**。
        // 裁完之后护照框要重映射进裁片坐标系(remapBboxIntoCrop),
        // 返回 null = 护照不在这张票的框里(两票各一框、护照只压着其中一张,是常态)。
        if (entry.cropRect && entry.maskBbox) {
          const tmpPath = `${destPath}.crop.tmp.jpg`;
          const cr = await renderCroppedDelivery({
            sourcePath: entry.sourcePath, destPath: tmpPath, rect: entry.cropRect, sharp,
          });
          if (!cr.cropped) {
            imageBlocked.push(`${path.join(dirRel, name)}:按框裁图失败(${cr.reason}),没进包`);
            logger.warn({ event: 'delivery_crop_failed', pkg: 'lotte_dept', src: entry.sourcePath, reason: cr.reason }, 'delivery crop failed');
            await fsp.unlink(tmpPath).catch(() => {});
            continue;
          }
          const innerBbox = remapBboxIntoCrop(entry.maskBbox, entry.cropRect);
          if (!innerBbox) {
            // 护照不在这张票的框里 → 这张裁片本来就没有护照,不需要涂
            await fsp.rename(tmpPath, destPath);
            croppedCount += 1;
            continue;
          }
          // 国籍仍从**原图**读:裁片可能把 MRZ 切掉一半,而国籍探针要的就是那两行
          const nat = await readPassportNationality(entry.sourcePath, { bbox: entry.maskBbox });
          if (nat.nationality) nationalityShown += 1;
          else nationalityMissing.push(path.join(dirRel, name));
          const res = await maskPassportRegion({
            sourcePath: tmpPath,
            destPath,
            bbox: innerBbox,
            nationalityText: nat.nationality ? `국적/Nationality: ${nat.nationality}` : '',
          });
          await fsp.unlink(tmpPath).catch(() => {});
          croppedCount += 1;
          if (res.masked) { maskedCount += 1; continue; }
          // 打码失败:出**裁片**(而不是回退整图)—— 整图会重演上面说的重复报账。
          // 裁片没打上码仍是泄漏,所以照旧进 maskFallback 名单。
          if (!fs.existsSync(destPath)) {
            imageBlocked.push(`${path.join(dirRel, name)}:裁出来了但打码失败(${res.reason}),没进包`);
            logger.warn({ event: 'delivery_mask_failed_after_crop', pkg: 'lotte_dept', src: entry.sourcePath, reason: res.reason }, 'mask failed after crop');
            continue;
          }
          maskFallback.push(path.join(dirRel, name));
          logger.warn({ event: 'delivery_mask_fallback', pkg: 'lotte_dept', src: entry.sourcePath, reason: res.reason }, 'passport mask fallback after crop');
          continue;
        }
        // 只要打码、不用裁(整图就是这一张票)
        if (entry.maskBbox) {
          const nat = await readPassportNationality(entry.sourcePath, { bbox: entry.maskBbox });
          if (nat.nationality) nationalityShown += 1;
          else nationalityMissing.push(path.join(dirRel, name));
          const res = await maskPassportRegion({
            sourcePath: entry.sourcePath,
            destPath,
            bbox: entry.maskBbox,
            nationalityText: nat.nationality ? `국적/Nationality: ${nat.nationality}` : '',
          });
          if (res.masked) { maskedCount += 1; continue; }
          maskFallback.push(path.join(dirRel, name));
          logger.warn({ event: 'delivery_mask_fallback', pkg: 'lotte_dept', src: entry.sourcePath, reason: res.reason }, 'passport mask fallback to raw copy');
        }
        // 按框现裁(0730):crop 这个 action 原来算出来了却没人执行,会掉到原样复制
        // = 整图进包 = 同一张照片当成多笔交易,正是护栏要防的那件事。
        // 裁失败**绝不回退整图**,进 imageBlocked 名单让人看见。
        if (entry.cropRect) {
          const cr = await renderCroppedDelivery({
            sourcePath: entry.sourcePath, destPath, rect: entry.cropRect, sharp,
          });
          if (cr.cropped) { croppedCount += 1; continue; }
          imageBlocked.push(`${path.join(dirRel, name)}:按框裁图失败(${cr.reason}),没进包`);
          logger.warn({ event: 'delivery_crop_failed', pkg: 'lotte_dept', src: entry.sourcePath, reason: cr.reason }, 'delivery crop failed');
          continue;
        }
        await fsp.copyFile(entry.sourcePath, destPath);
      } catch (copyErr) { // 单文件失败仍不致命,但必须留痕+计数回报
        copyFailed.push(path.join(dirRel, name));
        logger.warn({ event: 'delivery_copy_failed', pkg: 'lotte_dept', src: entry.sourcePath, dest: path.join(dirRel, name), err: copyErr?.message }, 'delivery copy failed');
      }
    }

    if (plan.missingSource.length) {
      logger.warn({ event: 'delivery_missing_source', pkg: 'lotte_dept', count: plan.missingSource.length, samples: plan.missingSource.slice(0, 5) }, 'delivery source image missing');
    }

    // 导出说明.txt(0728 静默缺口修复):打码回退/国籍缺失等回执原本只在返回值里,
    // handler 直接流 zip 全被丢弃——审核员看不到哪张护照没遮成。写进包根;干净包不写。
    const notes = buildLotteDeliveryNotes({
      maskFallback, nationalityMissing, copyFailed, missingSource: plan.missingSource,
      imageBlocked: [...(plan.imageBlocked || []), ...imageBlocked],
      unmaskable: plan.unmaskable,
      skippedUnreviewed: plan.skippedUnreviewed,
    });
    if (notes) {
      fs.mkdirSync(staging, { recursive: true });
      // UTF-8 BOM(\ufeff):收件方多为 Windows 记事本/WPS,带 BOM 保证中文不乱码
      fs.writeFileSync(path.join(staging, '导出说明.txt'), '\ufeff' + notes.join('\r\n') + '\r\n');
    }

    // 运维留痕:出包时的关键计数。事后有人问「这包里的图是按框裁的还是整张」,
    // 这是唯一查得到的地方(handler 直接流 zip,返回值到不了日志)。
    logger.info({
      event: 'delivery_export_done',
      pkg: 'lotte_dept',
      files: plan.fileCount,
      cropped: croppedCount,
      masked: maskedCount,
      blocked: (plan.imageBlocked || []).length + imageBlocked.length,
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
      customers: plan.customers,
      fileCount: plan.fileCount,
      // 护照打码回执(0727#13-3):打了几张/几张回退原样(回退必须可见,不静默出未打码图)
      maskedCount,
      maskFallback: maskFallback.length,
      maskFallbackSamples: maskFallback.slice(0, 8),
      // 国籍露出回执(0728 拍板):印上国籍几张/读不出几张(读不出=全遮,不阻断)
      nationalityShown,
      nationalityMissing: nationalityMissing.length,
      nationalityMissingSamples: nationalityMissing.slice(0, 8),
      copyFailed: copyFailed.length,
      copyFailedSamples: copyFailed.slice(0, 8),
      missingSource: plan.missingSource.length,
      // 未能定位护照区=原样出包(合规风险),回执与说明同源
      unmaskable: (plan.unmaskable || []).length,
      unmaskableSamples: (plan.unmaskable || []).slice(0, 8),
      missingSourceSamples: plan.missingSource.slice(0, 8),
      skippedUnreviewed: plan.skippedUnreviewed,
      passportFallback: plan.passportFallback,
      // 按框现裁张数(0730 第3期)。原来只加不读 —— eslint no-unused-vars 抓到的。
      // 它回答的是「我画的框到底生效了没」:框没传到导出层时,代码会静默掉到整图复制,
      // 既不失败也不进 imageBlocked,和"框生效了"长得一模一样。有了这个数才分得开。
      // 不写进「导出说明.txt」:那张纸给收件方看,只登异常;干净包不写是刻意的设计。
      croppedCount,
      cleanup: () => cleanupDir(work),
    };
  }

  return { planDelivery, exportZip };
}

module.exports = { createLotteDeptDeliveryExportService, buildLotteDeliveryNotes };
