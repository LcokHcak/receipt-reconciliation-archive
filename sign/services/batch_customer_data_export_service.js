'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// 只导出图片(护照/小票/机票等),排除 customer.json 与账单 xlsx。
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

// 客户引用解析收敛到 lib/customer_ref(原同款逻辑散在 4 处)。
const { parseCustomerRefFromTask: parseCustomerReferenceFromTask } = require('../lib/customer_ref');
const { logger } = require('../lib/logger');

function basenameFromReference(value) {
  const parts = String(value || '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// 导出说明.txt(0729 静默排查 A4)。纯函数,直测;没有可说的返回 null 不写。
// 两类缺图必须分开报,因为**发现时机**不同:
//   missingSource = 列清单时就取不到(客户档案里登记了,磁盘上没有)→ 图从没进过包
//   copyFailed    = 清单里有、复制那一步失败(权限/磁盘满/并发清理)→ 更像临时故障,重导常能解决
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

function buildCustomerDataNotes({ missingSource = [], copyFailed = [] } = {}) {
  const lines = [];
  if (missingSource.length) {
    lines.push(`【源图取不到·没进包】${missingSource.length} 张图在系统里找不到源文件:`);
    for (const m of missingSource.slice(0, 20)) lines.push(`  - ${m}`);
    if (missingSource.length > 20) lines.push(`  …等共 ${missingSource.length} 张`);
    lines.push('  客户档案里登记了这些图,但磁盘上取不到。这是我们这边的文件问题,不用找客户。');
  }
  if (copyFailed.length) {
    lines.push(`【复制失败】${copyFailed.length} 张图没能复制进包:`);
    for (const f of copyFailed.slice(0, 20)) lines.push(`  - ${f}`);
    if (copyFailed.length > 20) lines.push(`  …等共 ${copyFailed.length} 张`);
    lines.push('  图在系统里是有的,复制那一步失败了。重新导出通常能解决;仍失败请报运维。');
  }
  return lines.length ? ['客户数据包 · 导出说明(系统自动生成)', ''].concat(spaceSections(lines)) : null;
}

function createBatchCustomerDataExportService({ customerLibraryRepository, resolveBatchRelativePath = null }) {
  if (!customerLibraryRepository) {
    throw new Error('batch_customer_data_export_service: customerLibraryRepository required');
  }

  // 批次里所有去重后的客户引用(只保留能解析出 workspaceKey+customerId 的)。
  function resolveBatchCustomers(batch) {
    const byKey = new Map();
    for (const task of Array.isArray(batch?.tasks) ? batch.tasks : []) {
      const ref = parseCustomerReferenceFromTask(task);
      if (!ref.workspaceKey || !ref.customerId) continue;
      const key = `${ref.workspaceKey}/${ref.customerId}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          ...ref,
          taskFileNames: new Set(),
          taskImages: [],
          taskImageKeys: new Set(),
        });
      }
      const item = byKey.get(key);
      const taskFileName = basenameFromReference(task.sourceOriginalPath)
        || basenameFromReference(task.originalFileName)
        || basenameFromReference(task.fileName);
      if (IMAGE_EXT.test(taskFileName)) {
        item.taskFileNames.add(taskFileName);
      }
      const sourceImagePath = String(task.sourceImagePath || '').trim();
      const sourceImageName = basenameFromReference(sourceImagePath);
      const exportName = basenameFromReference(task.sourceFileName)
        || taskFileName
        || basenameFromReference(task.originalFileName)
        || sourceImageName;
      if (sourceImagePath && (IMAGE_EXT.test(exportName) || IMAGE_EXT.test(sourceImageName))) {
        const imageKey = `${sourceImagePath}\n${exportName}`;
        if (!item.taskImageKeys.has(imageKey)) {
          item.taskImageKeys.add(imageKey);
          item.taskImages.push({ sourceImagePath, exportName });
        }
      }
    }
    return [...byKey.values()].map((ref) => ({
      ...ref,
      taskFileNames: [...ref.taskFileNames],
      taskImages: ref.taskImages,
      taskImageKeys: undefined,
    }));
  }

  function resolveCustomerFolderName({ workspaceKey, customerId }) {
    try {
      const dir = customerLibraryRepository.customerDir(workspaceKey, customerId);
      if (dir) return path.basename(dir);
    } catch {
      // Fall through to the stable customer id.
    }
    return customerId;
  }

  function listBatchTaskImages(batch, ref) {
    if (!resolveBatchRelativePath || !batch?.id || !Array.isArray(ref.taskImages)) {
      return { folderName: null, dir: null, files: [], fileEntries: [] };
    }
    const fileEntries = [];
    for (const image of ref.taskImages) {
      let sourcePath;
      try { sourcePath = resolveBatchRelativePath(batch.id, image.sourceImagePath); }
      catch { continue; }
      try {
        if (!sourcePath || !fs.statSync(sourcePath).isFile()) continue;
      } catch {
        continue;
      }
      const exportName = basenameFromReference(image.exportName)
        || basenameFromReference(image.sourceImagePath)
        || path.basename(sourcePath);
      if (!IMAGE_EXT.test(exportName) && !IMAGE_EXT.test(sourcePath)) continue;
      fileEntries.push({ sourcePath, exportName });
    }
    return {
      folderName: fileEntries.length ? resolveCustomerFolderName(ref) : null,
      dir: null,
      files: fileEntries.map((entry) => entry.sourcePath),
      fileEntries,
    };
  }

  // 一个客户目录下的图片文件(绝对路径);目录基名就是审核回写后的「客户名 护照」文件夹名。
  function listCustomerImages({ workspaceKey, customerId, taskFileNames = [] }) {
    let dir;
    try { dir = customerLibraryRepository.customerDir(workspaceKey, customerId); }
    catch { return { folderName: null, dir: null, files: [] }; }
    if (!dir || !fs.existsSync(dir)) return { folderName: null, dir: null, files: [] };
    const wantedFileNames = new Set(
      taskFileNames
        .map((name) => basenameFromReference(name))
        .filter((name) => IMAGE_EXT.test(name))
    );
    const missing = [];
    const filesFromRecord = listCustomerRecordImages(dir, wantedFileNames, missing);
    if (filesFromRecord !== null) {
      return { folderName: path.basename(dir), dir, files: filesFromRecord, missingImages: missing };
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return { folderName: path.basename(dir), dir, files: [] }; }
    const files = entries
      .filter((e) => e.isFile() && IMAGE_EXT.test(e.name))
      .map((e) => path.join(dir, e.name));
    return { folderName: path.basename(dir), dir, files };
  }

  // 计划:每个客户一个文件夹 + 图片清单(只读,不落盘)。供 UI 预览数量,也供 zip 用。
  function planExport(batch) {
    const items = [];
    // 0729 A4:客户档案里登记了、但磁盘上取不到的图。它们连 items 都进不去,
    // 下游 copyFailed 数不到 —— 客户文件夹就是少几张图,此前零痕迹。
    const missingSource = [];
    for (const ref of resolveBatchCustomers(batch)) {
      const batchImages = listBatchTaskImages(batch, ref);
      const picked = batchImages.files.length ? batchImages : listCustomerImages(ref);
      const { folderName, dir, files, fileEntries } = picked;
      for (const rel of picked.missingImages || []) missingSource.push(`${ref.customerId}/${rel}`);
      if (folderName && files.length) {
        items.push({ ...ref, folderName, dir, files, fileEntries });
      }
    }
    return {
      customerCount: items.length,
      imageCount: items.reduce((sum, it) => sum + it.files.length, 0),
      missingSource,
      items,
    };
  }

  // 把计划里的图片按「客户文件夹」复制到临时目录再打包成 .zip,返回 { zipPath, cleanup, ... }。
  // 不引第三方依赖:优先系统 zip;无 zip 时用 python3 -m zipfile(生产服务器有 python3)。
  // 异步:大批次(上千张图)下复制 + 打包都让出事件循环,避免冻结整个单进程服务。
  async function exportZip(batch) {
    const plan = planExport(batch);
    if (plan.imageCount === 0) {
      const err = new Error('本批次没有可导出的客户图片');
      err.code = 'NO_CUSTOMER_IMAGES';
      throw err;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-cust-export-'));
    const staging = path.join(work, sanitize(`${batch?.name || batch?.id || 'batch'}_客户数据`));
    fs.mkdirSync(staging, { recursive: true });

    const usedNames = new Set();
    const copyFailed = []; // 复制失败留痕(2026-07-14 审计#10):曾裸吞→导出包静默少图无从追查
    for (const item of plan.items) {
      let folder = sanitize(item.folderName);
      // 防重名覆盖
      let unique = folder; let n = 2;
      while (usedNames.has(unique)) unique = `${folder} (${n++})`;
      usedNames.add(unique);
      const destDir = path.join(staging, unique);
      fs.mkdirSync(destDir, { recursive: true });
      const usedFileNames = new Set();
      const fileEntries = Array.isArray(item.fileEntries) && item.fileEntries.length
        ? item.fileEntries
        : item.files.map((src) => ({ sourcePath: src, exportName: path.basename(src) }));
      for (const entry of fileEntries) {
        const exportName = uniqueExportFileName(entry.exportName || path.basename(entry.sourcePath), usedFileNames);
        try { await fsp.copyFile(entry.sourcePath, path.join(destDir, exportName)); }
        catch (copyErr) { // 单文件失败仍不致命,但必须留痕+计数回报
          copyFailed.push(`${unique}/${exportName}`);
          logger.warn({ event: 'delivery_copy_failed', pkg: 'batch_customer_data', src: entry.sourcePath, dest: `${unique}/${exportName}`, err: copyErr?.message }, 'delivery copy failed');
        }
      }
    }

    // 0729 静默排查 A4:copyFailed 与 missingSource 此前只回在返回值里,而 handler 拿到
    // result 后只用 zipPath/downloadName/cleanup 就 res.download —— 全被原地丢掉。
    // 这是四个交付入口里唯一连自己算出的名单都没有任何用户可见出口的一个。
    // 与其它交付包同规矩:写进包根「导出说明.txt」,打开包就看得见。
    const notes = buildCustomerDataNotes({ missingSource: plan.missingSource, copyFailed });
    if (notes) {
      fs.writeFileSync(path.join(staging, '导出说明.txt'), `\uFEFF${notes.join('\n')}`, 'utf8');
    }

    const zipPath = path.join(work, `${sanitize(batch?.name || batch?.id || 'batch')}_客户数据.zip`);
    const stagingBase = path.basename(staging);
    const res = await archiveZip(zipPath, stagingBase, work);
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
      downloadName: `${sanitize(batch?.name || batch?.id || 'batch')}_客户数据.zip`,
      customerCount: plan.customerCount,
      imageCount: plan.imageCount,
      copyFailed: copyFailed.length,
      copyFailedSamples: copyFailed.slice(0, 8),
      cleanup: () => cleanupDir(work),
    };
  }

  return { resolveBatchCustomers, listCustomerImages, planExport, exportZip };
}

function listCustomerRecordImages(customerDir, wantedFileNames = new Set(), missingOut = []) {
  const recordPath = path.join(customerDir, 'customer.json');
  if (!fs.existsSync(recordPath)) return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
  catch { return null; }
  if (!Array.isArray(record?.images)) return null;
  const images = record.images;
  const out = [];
  const seen = new Set();
  for (const image of images) {
    const relativePath = String(image?.relativePath || '').trim();
    const fileName = basenameFromReference(relativePath);
    if (!relativePath || !IMAGE_EXT.test(fileName)) continue;
    if (wantedFileNames.size && !wantedFileNames.has(fileName)) continue;
    if (!wantedFileNames.size && image?.autoSplitRole === 'original') continue;
    if (image?.kind === 'signature' || relativePath.split(/[\\/]+/)[0] === 'generated') continue;
    const filePath = resolveInsideCustomerDir(customerDir, relativePath);
    if (!filePath || seen.has(filePath)) continue;
    try {
      if (fs.statSync(filePath).isFile()) {
        out.push(filePath);
        seen.add(filePath);
      } else {
        missingOut.push(relativePath); // 路径存在但不是文件(目录/坏链)
      }
    } catch {
      // 0729 静默排查 A4:原注释是「Missing images are ignored; the rest of the batch
      // can still export」——"其余照常导出"没错,但**被忽略的那些从此无影无踪**:
      // 它们连 plan.items 都进不去,下游的 copyFailed 自然也数不到,
      // 客户文件夹里就是少几张图,零痕迹。继续不阻断,但必须记下来。
      missingOut.push(relativePath);
    }
  }
  return out;
}

function resolveInsideCustomerDir(customerDir, relativePath) {
  const root = path.resolve(customerDir);
  const resolved = path.resolve(root, relativePath);
  return resolved === root || !resolved.startsWith(root + path.sep) ? '' : resolved;
}

// 异步跑子进程。返回 { ran:false }(命令不存在/ENOENT)或 { ran:true, status, stderr }。
// 2026-08-01 挪进 lib/run_process:原地这份只监听 stderr、不消费 stdout,
// 子进程写满 64KB 管道就永久阻塞(实测 1MB stdout 必挂)。详见那个文件的抬头。
const { runProcess } = require('../lib/run_process');

// 打包成 zip:优先系统 zip,缺失则回退 python3 -m zipfile(异步,不阻塞事件循环)。
// 返回 { ok, code?, detail? };两者都缺返回 code: 'ZIP_UNAVAILABLE'。
// 打包这一步在 Windows 开发机上**永远跑不到**(本机既没 zip 也没真 python3,
// 每次都在 ENOENT 上立刻回退),所以出问题只可能在 Linux 上被发现,
// 而那时候你手里只有一份日志。因此每个工具的「开始/结果」都留一行:
// 卡住时最后一行 attempt 就直接点名是谁,不用靠猜。
// 0801 教训:上一次 CI 挂死时这里一个字都没有,只能靠上游一条无关日志倒推挂点。
async function archiveZip(zipPath, srcRelDir, cwd) {
  // 1) 系统 zip
  logger.info({ event: 'archive_attempt', tool: 'zip', cwd, src: srcRelDir }, 'archive attempt');
  const zipRes = await runProcess('zip', ['-r', '-q', zipPath, srcRelDir], { cwd });
  logger.info({
    event: 'archive_result', tool: 'zip', ran: zipRes.ran, status: zipRes.status ?? null,
    timedOut: Boolean(zipRes.timedOut),
  }, 'archive result');
  if (zipRes.ran) {
    return zipRes.status === 0
      ? { ok: true }
      : { ok: false, detail: zipRes.stderr || `zip exit ${zipRes.status}` };
  }
  // 2) python3 -m zipfile -c <zip> <src>(zip 不存在时回退)
  logger.info({ event: 'archive_attempt', tool: 'python3', cwd, src: srcRelDir }, 'archive attempt');
  const pyRes = await runProcess('python3', ['-m', 'zipfile', '-c', zipPath, srcRelDir], { cwd });
  logger.info({
    event: 'archive_result', tool: 'python3', ran: pyRes.ran, status: pyRes.status ?? null,
    timedOut: Boolean(pyRes.timedOut),
  }, 'archive result');
  if (!pyRes.ran) return { ok: false, code: 'ZIP_UNAVAILABLE' };
  return pyRes.status === 0
    ? { ok: true }
    : { ok: false, detail: pyRes.stderr || `python3 zipfile exit ${pyRes.status}` };
}

function sanitize(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^_+|_+$/g, '') || 'export';
}

function uniqueExportFileName(value, usedNames) {
  const initial = sanitize(path.basename(String(value || 'image')));
  const ext = path.extname(initial);
  const stem = ext ? initial.slice(0, -ext.length) : initial;
  let candidate = initial;
  let n = 2;
  while (usedNames.has(candidate)) {
    candidate = `${stem || 'image'} (${n++})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

module.exports = {
  createBatchCustomerDataExportService,
  parseCustomerReferenceFromTask,
  // 打包底座共享给其他交付导出(现代交付包等):zip优先/python3回退、防重名、清理
  archiveZip,
  sanitize,
  uniqueExportFileName,
  cleanupDir,
  // 0729 A4:导出说明生成(纯函数,直测)
  buildCustomerDataNotes,
};
