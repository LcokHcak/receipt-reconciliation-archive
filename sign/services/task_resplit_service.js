'use strict';

/**
 * task_resplit_service — P2d 改店重切补救(2026-07-08)。
 *
 * 审核员改店/点「按此店重切」→ 用客户库**原图**按(新)店档案强制重调 qwen 重切 →
 * 旧派生任务删除(批次侧文件清理)→ 新切片归回同批次同客户。通吃两类线上病例:
 *   ① 多票并排 qwen 漏切(不改店,纯强制重试);
 *   ② 百货/免税店误判导致切错(改店后人工店 override,qwen 不得翻案)。
 *
 * 安全铁律:
 *   - 已审保护(MVP):该原图派生的任务任一已审/已要求重拍 → 409,零改动。
 *   - 先切后删:qwen 调用失败时客户/批次数据分毫不动(切图是补救不是闸门)。
 *   - 墓碑剔除:旧切片路径从 batch.deletedSourcePaths 移除,否则新切片被墓碑挡回
 *     (getBatchSourceOriginalPathSet 把墓碑并入"已存在"集合)。
 *   - 家族歧义(同 base 多个 _original,撞名)→ 409 拒绝,绝不猜(防误删别的原图)。
 *   - 写序:客户记录 → 批次 → 磁盘清理(best-effort),磁盘清理失败只留孤儿不丢数据。
 */

const fs = require('node:fs');
const path = require('node:path');

const { AppError } = require('../lib/errors');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
const { normalizeStoreFamily } = require('../lib/validation/field_rules');
const { SIDECAR_SUFFIX } = require('../lib/qwen_ocr/sidecar');
const { buildFileName, buildImageRecord } = require('./customer_document_preprocess_service');

// 与建档并行切图同款:每块 1000 个文件名序号,重切用"现有最大前缀的下一块",绝不撞名。
const FILENAME_INDEX_BLOCK = 1000;

function basenameOf(record) {
  return path.posix.basename(String(record?.relativePath || ''));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 从切片文件名反推家族 base:切图产物形如 <NN>-<base>_receipt_1.jpg / <NN>-<base>_original.jpg。
// 反推不出(普通未切图)→ null,家族=图自身。
function parseSliceBase(fileName) {
  const stripped = String(fileName || '').replace(/^\d+-/, '');
  // other:2026-07-14 起 qwen 多文档切图对"其他"区也产切片(_other_N),家族解析必须认它
  const m = stripped.match(/^(.+?)_(?:receipt|passport|region|other)_\d+\.\w+$/)
    || stripped.match(/^(.+?)_original\.\w+$/);
  return m ? m[1] : null;
}

function createTaskResplitService({
  customerLibraryRepository,
  batchRepository,
  customerBatchBridgeService,
  documentSplitService,
  removeTaskArtifacts,
  enabled = true,
} = {}) {
  if (!customerLibraryRepository || !batchRepository) {
    throw new Error('createTaskResplitService: 需要 customerLibraryRepository/batchRepository');
  }

  // 家族解析:该任务的来源原图 + 同一原图切出的所有兄弟记录。
  function resolveFamily(images, fileName) {
    const base = parseSliceBase(fileName);
    if (!base) {
      // 未切过的整图:家族=自身,重切输入=自身
      const idx = images.findIndex((r) => basenameOf(r) === fileName);
      if (idx < 0) throw new AppError('客户库里找不到该任务的来源图', { status: 404, code: 'resplit_image_missing' });
      return { records: [images[idx]], sourceRecord: images[idx], base: null };
    }
    // other 必须在家族里(2026-07-14 复审 HIGH):切图现在会产 _other_N 切片,家族扫描漏它
    // = 重切后旧 other 任务/文件永久残留(不删不换,盘面和批次双泄漏)。与 parseSliceBase 同口径。
    const familyRe = new RegExp(
      `^\\d+-${escapeRegExp(base)}_(?:original\\.\\w+|(?:receipt|passport|region|other)_\\d+\\.\\w+)$`
    );
    const records = images.filter((r) => familyRe.test(basenameOf(r)));
    const originals = records.filter((r) => r.autoSplitRole === 'original');
    if (originals.length > 1) {
      throw new AppError(
        '同名原图存在多份,无法确定重切哪一张(撞名歧义),请联系管理员处理',
        { status: 409, code: 'resplit_ambiguous_original' }
      );
    }
    if (originals.length === 0) {
      throw new AppError(
        '客户库里找不到该切片的原图(_original),无法重切——绝不拿切片当原图,防止二次裁切丢内容',
        { status: 409, code: 'resplit_original_missing' }
      );
    }
    return { records, sourceRecord: originals[0], base };
  }

  async function resplitTask({ batchId, taskId, storeFamily = '' } = {}) {
    if (!enabled || !documentSplitService) {
      throw new AppError('当前识别后端不支持重切(仅 qwen 模式可用)', { status: 501, code: 'resplit_unsupported' });
    }
    const batch = batchRepository.loadBatch(batchId);
    const task = (Array.isArray(batch.tasks) ? batch.tasks : []).find((t) => t.id === taskId);
    if (!task) throw new AppError('任务不存在', { status: 404, code: 'task_not_found' });

    // sourceOriginalPath 三段式 + 纵深防御(同「查看原图」端点口径):任何一段异常即拒。
    const src = String(task.sourceOriginalPath || '').trim();
    const parts = src.split('/');
    if (parts.length !== 3 || parts.some((p) => !p || p === '..' || p !== path.basename(p) || p.includes('\\'))) {
      throw new AppError('该任务没有客户库原图引用,无法重切', { status: 404, code: 'resplit_no_library_ref' });
    }
    const [workspaceKey, customerId, fileName] = parts;
    const overrideFamily = normalizeStoreFamily(storeFamily);

    return withCustomerWriteLock(customerLockKey(workspaceKey, customerId), async () => {
      const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
      const images = Array.isArray(customer.images) ? customer.images : [];
      const { records: familyRecords, sourceRecord } = resolveFamily(images, fileName);
      const familyBasenames = new Set(familyRecords.map((r) => basenameOf(r)));

      // 派生任务 = 本批次里指向该家族任何文件的任务
      const prefix = `${workspaceKey}/${customerId}/`;
      const isDerived = (t) => {
        const s = String(t?.sourceOriginalPath || '').trim();
        return s.startsWith(prefix) && familyBasenames.has(path.posix.basename(s));
      };
      const derived = batch.tasks.filter(isDerived);

      // 已审保护(MVP 铁律):家族任一任务已审/已要求重拍 → 拒绝,重切会摧毁审核结果
      const blocked = derived.find((t) => t.reviewed || t.rephotoRequested);
      if (blocked) {
        throw new AppError(
          `该原图切出的任务 ${blocked.id} 已审核/已要求重拍,重切会摧毁审核结果,已阻止(如确需重切请先撤销审核)`,
          { status: 409, code: 'resplit_blocked_reviewed' }
        );
      }

      // ① 先切(qwen 失败 → 这里抛错,下面所有改动都还没发生,数据零变化)
      const customerPath = customerLibraryRepository.customerDir(workspaceKey, customerId);
      const imagesDir = path.join(customerPath, 'images');
      const maxPrefix = images.reduce((max, r) => {
        const m = /^(\d+)-/.exec(basenameOf(r));
        return m ? Math.max(max, Number.parseInt(m[1], 10) || 0) : max;
      }, 0);
      const startIndex = (Math.floor(maxPrefix / FILENAME_INDEX_BLOCK) + 1) * FILENAME_INDEX_BLOCK;
      const sourceAbsPath = path.join(customerPath, String(sourceRecord.relativePath || '').replaceAll('/', path.sep));
      if (!fs.existsSync(sourceAbsPath)) {
        throw new AppError('原图文件已不在磁盘上,无法重切', { status: 409, code: 'resplit_source_file_missing' });
      }
      const originalFileName = sourceRecord.originalFileName || basenameOf(sourceRecord);
      const splitResult = await documentSplitService.splitImage({
        sourcePath: sourceAbsPath,
        imagesDir,
        originalFileName,
        startIndex,
        buildFileName,
        storeFamilyOverride: overrideFamily,
        forceRefresh: true, // 毒缓存教训:重切绝不回放旧结果
      });

      // ①½ 长跑后重取批次真相(2026-07-12 审计 HIGH):qwen 可能跑过 withBatchWrite 的
      // 90s 超时窗——超时只是放行队列,底层动作照跑;抱着 t=0 旧快照落盘会把超时窗内
      // 别人已保存的写入整批吞掉。这里重载 fresh 并在动任何数据前复检已审保护;
      // 从 fresh 加载到 saveBatchAsync 之间无 await 间隙,残余竞争窗只剩毫秒级。
      // 复检发现被审核 → 此时只有磁盘上多了几个新切片文件(库清理页可兜),客户库/批次零改动。
      const freshBatch = batchRepository.loadBatch(batchId);
      const freshTasks = Array.isArray(freshBatch.tasks) ? freshBatch.tasks : [];
      const freshBlocked = freshTasks.filter(isDerived).find((t) => t.reviewed || t.rephotoRequested);
      if (freshBlocked) {
        throw new AppError(
          `重切期间任务 ${freshBlocked.id} 被审核/被要求重拍,已中止以保护审核结果(新切片文件留在客户库,未生效)`,
          { status: 409, code: 'resplit_blocked_reviewed' }
        );
      }

      // ② 重建 customer.images:家族记录替换为新产物(位置保持在原家族首位),全表顺序重排
      let newRecords;
      if (splitResult?.splitApplied && Array.isArray(splitResult.outputs) && splitResult.outputs.length) {
        newRecords = splitResult.outputs.map((output, i) => buildImageRecord(i + 1, output, originalFileName));
      } else {
        // 重切后仍是单文档(如改判百货整图直通):家族坍缩为原图单记录。
        // 必须清 autoSplitRole——'original' 角色被批次导入排除,不清则这张图永远进不了批次。
        const collapsed = { ...sourceRecord, preprocessStatus: 'processed', preprocessMessage: 'resplit_no_split' };
        delete collapsed.autoSplitRole;
        delete collapsed.autoSplit;
        newRecords = [collapsed];
      }
      const firstFamilyIdx = images.findIndex((r) => familyBasenames.has(basenameOf(r)));
      const nextImages = [];
      for (let i = 0; i < images.length; i += 1) {
        if (i === firstFamilyIdx) nextImages.push(...newRecords);
        if (!familyBasenames.has(basenameOf(images[i]))) nextImages.push(images[i]);
      }
      const resequenced = nextImages.map((r, i) => ({
        ...r,
        imageId: `img_${String(i + 1).padStart(3, '0')}`,
        sortOrder: i + 1,
      }));
      customerLibraryRepository.saveCustomer({ ...customer, images: resequenced });

      // ③ 批次:删旧派生任务(批次侧文件清理)+ 剔家族墓碑(否则新切片被挡回)。
      // 一律操作 fresh 快照——旧 batch 只用于长跑前的预检,禁止再落盘(审计 HIGH)。
      const keep = freshTasks.filter((t) => !isDerived(t));
      const removedTasks = freshTasks.filter(isDerived);
      for (const t of removedTasks) {
        try { removeTaskArtifacts?.(batchId, t, keep); } catch { /* 批次侧文件清理失败不阻断 */ }
      }
      freshBatch.tasks = keep;
      freshBatch.deletedSourcePaths = (Array.isArray(freshBatch.deletedSourcePaths) ? freshBatch.deletedSourcePaths : [])
        .filter((p) => {
          const s = String(p || '').trim();
          return !(s.startsWith(prefix) && familyBasenames.has(path.posix.basename(s)));
        });
      await batchRepository.saveBatchAsync(freshBatch);

      // ④ 新切片归回同批次同客户(operatorUser=null=系统上下文:handler 已做批次访问校验,
      //    审核员本就不是客户 owner,按 owner 过滤会误拒)。
      //    归队失败(瞬时盘错等)→ 数据无损(新切片+客户记录都在),抛带恢复指引的业务错误,
      //    审核员点「追加图片」或重试即自愈,不留无提示的孤儿窗口。
      let appended;
      try {
        appended = await customerBatchBridgeService.appendCustomerToBatch({
          workspaceKey,
          customerId,
          batchId,
          operatorUser: null,
          // 本函数全程持同客户写锁(withCustomerWriteLock);锁是同键 Promise 链,
          // append 内部再取同键会排在自己后面=死锁,持锁方必须声明旁路。
          customerLockHeld: true,
        });
      } catch (cause) {
        throw new AppError(
          '重切已完成但新切片归队失败(数据无损):给该客户「追加图片」任意一张即会连同新切片一并归队,或联系管理员',
          { status: 500, code: 'resplit_append_failed', cause }
        );
      }

      // ⑤ 磁盘清理(best-effort,最后做):旧家族文件+sidecar,只删「不再被引用」的;
      //    无 autoSplitRole 的原始上传件保留为孤儿(与建档切图同口径,库清理页兜底)。
      const referenced = new Set(resequenced.map((r) => basenameOf(r)));
      const imagesDirResolved = path.resolve(imagesDir);
      for (const record of familyRecords) {
        const name = basenameOf(record);
        if (referenced.has(name)) continue;
        if (!record.autoSplitRole) continue; // 原始上传件不删(唯一全量来源,留作孤儿)
        const abs = path.resolve(path.join(imagesDir, name));
        // 删除前收口(与「查看原图」端点同款约定):目标必须仍在该客户 images 目录内。
        // 输入全是服务端落盘值,这里是纵深防御——删除的爆炸半径比只读大,多锁一道。
        if (!abs.startsWith(`${imagesDirResolved}${path.sep}`)) continue;
        try { fs.rmSync(abs, { force: true }); } catch { /* 留孤儿不丢数据 */ }
        try { fs.rmSync(abs + SIDECAR_SUFFIX, { force: true }); } catch { /* 同上 */ }
      }

      return {
        ok: true,
        removedTaskIds: removedTasks.map((t) => t.id),
        appendedTasks: Number(appended?.appendedTasks || 0),
        batch: appended?.batch || freshBatch,
      };
    });
  }

  return { resplitTask };
}

module.exports = { createTaskResplitService };
