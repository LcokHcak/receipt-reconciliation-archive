'use strict';

/**
 * 现代免税店交付包导出(2026-07-05 上家需求,用户拍板 5 边界):
 *   按类型三池打包(不是按客户文件夹):
 *     护照/  当天全部护照图,文件名 = 客人英文名        (边界①)
 *     机票/  当天全部航班截图(docType=其他),文件名 = 客人英文名(边界①)
 *     小票/  当天全部现代小票图,文件名 = 小票号(带横线) (边界②)
 *   一票多图全交(_2 后缀)(边界③);混店客户的护照/机票也进包(边界④);
 *   只导"整组已审核"的客户,没审完的列在 skipped 里(边界⑤)。
 *
 * 范围 = 一个审核批次(操作员按天建批,正好=当天);纯导出层,审核/结算零改动。
 * 这是店家档案 delivery 配置的第一个实例,以后百货等交付花样照此扩。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseCustomerRefFromTask } = require('../lib/customer_ref');
const { normalizeStoreFamily, STORE_FAMILIES } = require('../lib/validation/field_rules');
const { formatReceiptNoByMode } = require('../lib/workbench_receipt_export');
const { selectGroupIdentity } = require('./mode_delivery_export_service');
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

// 导出说明.txt(0729 静默排查 A3)。与多模式包/乐天百货包同规矩:
// 有可说的才写,干净包返回 null 不写(不给收件人塞噪音)。纯函数,直测。
// 现代包是三池结构(护照/机票/小票),收件人按池数张数对账 —— 少了图不解释,
// 他只能自己数出来再回来问。
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

function buildHyundaiDeliveryNotes({ missingSource = [], copyFailed = [], skippedUnreviewed = [] } = {}) {
  const lines = [];
  if (skippedUnreviewed.length) {
    lines.push(`【未进包·还没审完】${skippedUnreviewed.length} 个客户组整组未审完,按规则没进本包:`);
    for (const c of skippedUnreviewed.slice(0, 20)) lines.push(`  - ${c}`);
    if (skippedUnreviewed.length > 20) lines.push(`  …等共 ${skippedUnreviewed.length} 个`);
    lines.push('  审完后重新导出即可收进来。');
  }
  if (missingSource.length) {
    lines.push(`【源图取不到·没进包】${missingSource.length} 张图在系统里找不到源文件:`);
    for (const m of missingSource.slice(0, 20)) lines.push(`  - ${m}`);
    if (missingSource.length > 20) lines.push(`  …等共 ${missingSource.length} 张`);
    lines.push('  这是我们这边的文件问题,不用找客户;排查回原图后重新导出即可补齐。');
  }
  if (copyFailed.length) {
    lines.push(`【文件缺失】${copyFailed.length} 张图复制失败没进包,交付前请核对:`);
    for (const f of copyFailed.slice(0, 20)) lines.push(`  - ${f}`);
    if (copyFailed.length > 20) lines.push(`  …等共 ${copyFailed.length} 张`);
  }
  return lines.length ? ['现代免税店交付包 · 导出说明(系统自动生成)', ''].concat(spaceSections(lines)) : null;
}

function createHyundaiDeliveryExportService({ resolveBatchRelativePath }) {
  if (typeof resolveBatchRelativePath !== 'function') {
    throw new Error('hyundai_delivery_export_service: resolveBatchRelativePath required');
  }

  function resolveTaskFile(batchId, task) {
    const rel = textOf(task?.sourceImagePath);
    if (!rel) return '';
    let abs;
    try { abs = resolveBatchRelativePath(batchId, rel); } catch { return ''; }
    try { return abs && fs.statSync(abs).isFile() ? abs : ''; } catch { return ''; }
  }

  // 计划(只读):三池文件清单 + 未审完跳过名单 + 缺票号问题名单
  function planDelivery(batch) {
    const byCustomer = new Map();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ref = parseCustomerRefFromTask(task);
      if (!ref.workspaceKey || !ref.customerId) continue;
      const key = `${ref.workspaceKey}/${ref.customerId}`;
      if (!byCustomer.has(key)) byCustomer.set(key, { ref, tasks: [] });
      byCustomer.get(key).tasks.push(task);
    }

    const pools = { passport: [], flight: [], receipt: [] };
    const skippedUnreviewed = [];
    const missingReceiptNo = [];
    // 源图在磁盘缺失(被清理/盘错/迁移)的任务:resolve 阶段不静默丢,记下让出包前可见
    // (对齐 export_plan_engine 的 missingSource;此前裸 continue→交付包静默少图 ZIP 照常成功)。
    const missingSource = [];
    let customers = 0;

    for (const { ref, tasks } of byCustomer.values()) {
      const hyundaiReceipts = tasks.filter((t) => docTypeOf(t) === 'receipt'
        && normalizeStoreFamily(t.receiptStoreFinal || t.receiptStoreAuto) === STORE_FAMILIES.HYUNDAI);
      if (!hyundaiReceipts.length) continue; // 没有现代小票的客户不进本包

      // 边界⑤:整组已审核才交付(组里任何任务没审完都跳过,列出来给操作员看)
      if (!tasks.every((t) => t.reviewed)) {
        skippedUnreviewed.push(ref.customerId);
        continue;
      }

      // 组级身份=selectGroupIdentity 单一真相(8模块审计 HIGH 收口):护照任务优先→百货同框票,
      // 绝不用免税店小票的 OCR 名——旧"全组第一个非空"不分文档类型,小票残串当过客户夹姓名。
      const englishName = selectGroupIdentity(tasks, ref.customerId).name || ref.customerId;

      let hasFile = false;
      for (const t of hyundaiReceipts) {
        // 现代=dashed19,按 2-6-3-5 结构带杠输出(与台账同口径 formatReceiptNoByMode)
        const receiptNo = textOf(formatReceiptNoByMode(t, '现代-JEOCU'));
        const file = resolveTaskFile(batch.id, t);
        if (!file) {
          missingSource.push(`${ref.customerId}/${t.id}(小票${receiptNo || '?'})`);
          continue;
        }
        if (!receiptNo) {
          missingReceiptNo.push(`${ref.customerId}/${t.id}`);
          continue;
        }
        pools.receipt.push({ sourcePath: file, baseName: receiptNo });
        hasFile = true;
      }
      for (const t of tasks) {
        const dt = docTypeOf(t);
        if (dt !== 'passport' && dt !== 'other' && dt !== 'ticket') continue;
        const file = resolveTaskFile(batch.id, t);
        if (!file) {
          missingSource.push(`${ref.customerId}/${t.id}(${dt})`);
          continue;
        }
        (dt === 'passport' ? pools.passport : pools.flight)
          .push({ sourcePath: file, baseName: englishName }); // 边界①:英文名
        hasFile = true;
      }
      if (hasFile) customers += 1;
    }

    return {
      customers,
      pools,
      skippedUnreviewed,
      missingReceiptNo,
      missingSource,
      fileCount: pools.passport.length + pools.flight.length + pools.receipt.length,
    };
  }

  async function exportZip(batch) {
    const plan = planDelivery(batch);
    if (plan.missingReceiptNo.length) {
      const err = new Error(`有小票缺小票号,补全后再导出: ${plan.missingReceiptNo.slice(0, 8).join('、')}${plan.missingReceiptNo.length > 8 ? ' 等' : ''}`);
      err.code = 'HYUNDAI_RECEIPT_NO_MISSING';
      err.missing = plan.missingReceiptNo;
      throw err;
    }
    if (!plan.pools.receipt.length) {
      const err = new Error('本批次没有已审核完成的现代小票(整组审完才会进交付包)');
      err.code = 'NO_HYUNDAI_RECEIPTS';
      err.skippedUnreviewed = plan.skippedUnreviewed;
      throw err;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hyundai-delivery-'));
    const stagingName = sanitize(`${batch?.name || batch?.id || 'batch'}_现代交付包`);
    const staging = path.join(work, stagingName);
    const poolDirs = { passport: '护照', flight: '机票', receipt: '小票' };
    for (const dir of Object.values(poolDirs)) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true });
    }
    // 复制失败留痕(2026-07-21 全链路排查 A1,与 mode_delivery 审计#10 同款收口):
    // 曾裸吞 → 源图缺失/权限错时交付包静默少图,ZIP 照常成功零提示。计数+样本回传可追查。
    const copyFailed = [];
    for (const [pool, entries] of Object.entries(plan.pools)) {
      const used = new Set();
      for (const entry of entries) {
        const ext = (path.extname(entry.sourcePath).match(IMAGE_EXT) ? path.extname(entry.sourcePath) : '.jpg');
        const name = uniqueExportFileName(`${sanitize(entry.baseName)}${ext}`, used);
        try { await fsp.copyFile(entry.sourcePath, path.join(staging, poolDirs[pool], name)); }
        catch { copyFailed.push(`${poolDirs[pool]}/${name}`); }
      }
    }
    if (copyFailed.length) {

      console.warn(`[hyundai_delivery] 复制失败 ${copyFailed.length} 张(交付包少图):${copyFailed.slice(0, 5).join('、')}`);
    }
    if (plan.missingSource.length) {

      console.warn(`[hyundai_delivery] 源图缺失 ${plan.missingSource.length} 张(交付包少图,需补图/重识别):${plan.missingSource.slice(0, 5).join('、')}`);
    }

    // 0729 静默排查 A3:上面三份名单此前只有 console.warn 和被丢弃的返回值——
    // 服务器日志操作员看不到,handler 拿到 result 后只用 zipPath/downloadName/cleanup
    // 就直接 res.download,其余字段原地丢。收件人拿到的包可能缺图,谁都不知道。
    // 与多模式包/乐天百货包同规矩:写进包根「导出说明.txt」,打开包就看得见。
    const notes = buildHyundaiDeliveryNotes({
      missingSource: plan.missingSource, copyFailed, skippedUnreviewed: plan.skippedUnreviewed,
    });
    if (notes) {
      // BOM 防中文在 Windows 记事本里乱码(与其它交付包一致)
      fs.writeFileSync(path.join(staging, '导出说明.txt'), `\uFEFF${notes.join('\n')}`, 'utf8');
    }

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
      skippedUnreviewed: plan.skippedUnreviewed,
      copyFailed: copyFailed.length,
      copyFailedSamples: copyFailed.slice(0, 8),
      missingSource: plan.missingSource.length,
      missingSourceSamples: plan.missingSource.slice(0, 8),
      cleanup: () => cleanupDir(work),
    };
  }

  return { planDelivery, exportZip };
}

module.exports = { createHyundaiDeliveryExportService, buildHyundaiDeliveryNotes };
