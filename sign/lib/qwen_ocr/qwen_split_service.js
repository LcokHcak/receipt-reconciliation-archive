'use strict';

// 千问切分服务 —— 与 services/document_split_service.js 的 splitImage 同签名,
// 装配根在 SIGN_OCR_BACKEND=qwen 时用它替换 PaddleX 版。
//
// 一次千问调用同时完成:切图(bbox)+分类+字段。每个产物写 sidecar(<图>.qwen.json),
// 批处理只读 sidecar、不再调 API。
//
// 切/不切策略(对齐已确认的边界设计 A):
//   0 个文档 → 不切,原图记录 + sidecar(other/needsReview)
//   1 个文档 → 不切,原图记录 + sidecar(该文档字段)
//   ≥2 文档  → 原图(reference)+ 按 bbox 裁子图,各写 sidecar;裁退化/失败→用原图+标记转人工
// 字段从整图抽取,裁图只影响"看",不影响数据。

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { buildCropRect } = require('../document_crop_geometry');
const { DOC_TYPES } = require('../package_constants');
const { QWEN_PROMPT_VERSION } = require('./qwen_client');
const { writeSidecar } = require('./sidecar');
const { isDeptStore } = require('../store_profiles');
const { normalizeStoreFamily } = require('../validation/field_rules');
// L597:票号数字投影委托单一真相源(字段清洗副本铁律),不在此内联复制剥非数字口径
const { normalizeReceiptNoDigits } = require('../workbench_field_normalizer');
const {
  COMPRESS_JPEG_QUALITY,
  COMPRESS_MAX_SIDE,
  COMPRESS_MIN_BYTES,
} = require('../heic_normalize');

const MIN_CROP_PX = 8;

// 切图产物统一 .jpg:产物一律 JPEG 编码(见下),扩展名跟内容走。
// buildFileName 沿用来源扩展名(可能 .png/.PNG),不改会出现"jpeg 内容顶着 .png 名"。
function forceJpgExt(fileName) {
  return String(fileName || '').replace(/\.[^.]*$/, '.jpg');
}

// 压缩拷贝(切图产物版入库压缩,参数同 heic_normalize 唯一真相源):
// 源图超限 → 转正+限长边+q82 JPEG 落盘;已经小的原样拷贝,压完反而更大也退回原样拷贝。
// 任何一步失败都退回原样拷贝——压缩是优化不是闸门,绝不因此丢图。
async function writeCompressedCopy(srcPath, destPath) {
  try {
    const before = await fs.promises.stat(srcPath);
    const meta = await sharp(srcPath).metadata();
    const maxSide = Math.max(Number(meta.width || 0), Number(meta.height || 0));
    const srcIsJpeg = /\.jpe?g$/i.test(srcPath);
    // 已经小且本来就是 jpeg → 原样拷贝(不重复劣化);非 jpeg 源(png 等)一律转码,
    // 否则 png 字节顶着 .jpg 名落盘。
    if (srcIsJpeg && before.size <= COMPRESS_MIN_BYTES && maxSide <= COMPRESS_MAX_SIDE) {
      fs.copyFileSync(srcPath, destPath);
      return;
    }
    await sharp(srcPath)
      .rotate()
      .resize({ width: COMPRESS_MAX_SIDE, height: COMPRESS_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: COMPRESS_JPEG_QUALITY, mozjpeg: true })
      .toFile(destPath);
    // 压完反而更大(极少见):jpeg 源退回原样拷贝;非 jpeg 源保留转码结果(格式正确优先)。
    if (srcIsJpeg) {
      const after = await fs.promises.stat(destPath);
      if (after.size >= before.size) fs.copyFileSync(srcPath, destPath);
    }
  } catch {
    fs.copyFileSync(srcPath, destPath); // 压缩是优化不是闸门,失败原样拷贝绝不丢图
  }
}

// 嫌疑漏切判定(2026-07-06 评测校准):长条竖票的 bbox 像素宽高比 ≤~0.47(43张真图实测),
// 明显更宽的 receipt 框 = 可能两张并排被框成一张(生产"整图不切"病例的形态)。
const SUSPECT_RECEIPT_ASPECT = 0.55;

function createQwenDocumentSplitService({ qwenBackend, paddingPct = 0.04 } = {}) {
  if (!qwenBackend || typeof qwenBackend.extractAnalyses !== 'function') {
    throw new Error('createQwenDocumentSplitService: 需要 qwenBackend.extractAnalyses');
  }

  // 二次调用(2026-07-06 漏切保险):嫌疑 receipt 框裁出来单独再喂一次 qwen——
  // 整图压到长边1280时两张贴着的票中间的缝可能只剩1-2像素,裁出局部等于放大,常能拆开。
  // 只对嫌疑框触发(评测43张真图零误触发),增量成本≈0;拆不开就保持原样(标记转人工)。
  // 返回替换后的 analyses(子结果 bbox 已映射回全图坐标),失败返回 null(不阻断主流程)。
  async function retrySuspectReceipt(sourcePath, analyses, suspectIndex, W, H) {
    const suspect = analyses[suspectIndex];
    const b = (suspect.modelMeta && suspect.modelMeta.bbox) || [0, 0, 1, 1];
    const pad = 0.04;
    const x1 = Math.max(0, b[0] - pad), y1 = Math.max(0, b[1] - pad);
    const x2 = Math.min(1, b[2] + pad), y2 = Math.min(1, b[3] + pad);
    const rect = {
      left: Math.round(x1 * W), top: Math.round(y1 * H),
      width: Math.max(MIN_CROP_PX, Math.round((x2 - x1) * W)),
      height: Math.max(MIN_CROP_PX, Math.round((y2 - y1) * H)),
    };
    const retryPath = `${sourcePath}.retry~.jpg`;
    try {
      await sharp(sourcePath).rotate().extract(rect).jpeg({ quality: 85 }).toFile(retryPath);
      const sub = await qwenBackend.extractAnalyses(retryPath, { sourceKey: retryPath, useCache: false });
      const subDocs = sub.filter(
        (a) => a.docTypeFinal === DOC_TYPES.PASSPORT || a.docTypeFinal === DOC_TYPES.RECEIPT
      );
      const subReceipts = subDocs.filter((a) => a.docTypeFinal === DOC_TYPES.RECEIPT);
      if (subReceipts.length < 2) return null; // 没拆开 → 保持原判
      // 子结果 bbox(相对裁片)映射回全图归一化坐标
      const remapped = subDocs.map((a) => {
        const sb = (a.modelMeta && a.modelMeta.bbox) || [0, 0, 1, 1];
        return {
          ...a,
          sourceOriginalPath: suspect.sourceOriginalPath || a.sourceOriginalPath,
          sourceFolderName: suspect.sourceFolderName || a.sourceFolderName,
          sourceFileName: suspect.sourceFileName || a.sourceFileName,
          sourceKey: suspect.sourceKey || a.sourceKey,
          modelMeta: {
            ...(a.modelMeta || {}),
            secondPassSplit: true,
            bbox: [
              x1 + sb[0] * (x2 - x1), y1 + sb[1] * (y2 - y1),
              x1 + sb[2] * (x2 - x1), y1 + sb[3] * (y2 - y1),
            ],
          },
        };
      });
      return [...analyses.slice(0, suspectIndex), ...remapped, ...analyses.slice(suspectIndex + 1)];
    } catch {
      return null; // 二次调用是保险不是闸门,失败照旧走原结果
    } finally {
      try { fs.rmSync(retryPath, { force: true }); } catch { /* ignore */ }
    }
  }

  async function splitImage({
    sourcePath, imagesDir, originalFileName, startIndex = 0, buildFileName,
    storeFamilyOverride = '', forceRefresh = false,
  } = {}) {
    // forceRefresh(P2d 重切):绕过进程内缓存强制重调 qwen——毒 sidecar 教训,重切绝不回放旧结果。
    let analyses = await qwenBackend.extractAnalyses(
      sourcePath,
      forceRefresh ? { sourceKey: sourcePath, useCache: false } : { sourceKey: sourcePath }
    );

    // ⭐人工店 override(P2d 改店重切):审核员改店后重切,人工判断优先于 qwen 自判。
    // 一处注入:把所有小票 analyses 的 receiptStoreAuto 替换成人工店,下游(百货整图短路/
    // 嫌疑重试跳过判定/各产物 sidecar)全部自动跟着走;sidecar 带 override 店,批处理读
    // sidecar 建任务时店家不会翻回 qwen 原判。
    // 已知局限:override=免税店但 qwen 按百货口径只回了 1 个整图文档时,重调后仍可能
    // 只有 1 文档(不切)→ 走 docs<=1 + suspect_uncut_wide 兜底转人工,配合"同图补小票"处理。
    // 自归一(fail-safe):不依赖调用方先 normalize——sidecar 的 receiptStoreAuto 必须恒为
    // STORE_FAMILIES 枚举或空串,防未来新调用点把自由文本写进 sidecar 被下游导出层误信。
    const overrideFamily = normalizeStoreFamily(String(storeFamilyOverride || '').trim());
    const applyStoreOverride = (list) => (overrideFamily
      ? list.map((a) => (a.docTypeFinal === DOC_TYPES.RECEIPT
        ? { ...a, receiptStoreAuto: overrideFamily, modelMeta: { ...(a.modelMeta || {}), storeOverride: true } }
        : a))
      : list);
    analyses = applyStoreOverride(analyses);

    // 漏切二次调用:**整图只认出一张小票**且其框形状可疑(过宽=可能两张并排框成一张,
    // 生产"整图不切"病例全是这形态)→ 裁出重调,拆开即采纳。已拆成多张的图不碰
    // (多框吞票的形状信号不可靠,评测实证 aspect 区分不了,交给人工按钮兜底)。
    try {
      const receiptIdxs = analyses
        .map((a, i) => (a.docTypeFinal === DOC_TYPES.RECEIPT && !isDeptStore(a.receiptStoreAuto) ? i : -1))
        .filter((i) => i >= 0);
      if (receiptIdxs.length === 1) {
        const i = receiptIdxs[0];
        const b = (analyses[i].modelMeta && analyses[i].modelMeta.bbox) || [0, 0, 1, 1];
        const meta = await sharp(sourcePath).metadata();
        let W = Number(meta.width || 0), H = Number(meta.height || 0);
        if (Number(meta.orientation) >= 5) [W, H] = [H, W];
        const aspect = W > 0 && H > 0
          ? ((b[2] - b[0]) * W) / Math.max(1, (b[3] - b[1]) * H)
          : 0;
        if (aspect > SUSPECT_RECEIPT_ASPECT) {
          const replaced = await retrySuspectReceipt(sourcePath, analyses, i, W, H);
          // 重试结果是全新 qwen 子调用,店家是子调用自判——override 必须重新套上,
          // 否则人工改店在"漏切重试拆开"这条路上被 qwen 翻案(如子结果又自判百货→误触发整图短路)。
          if (replaced) analyses = applyStoreOverride(replaced);
        }
      }
    } catch { /* 保险失败不阻断 */ }

    // ⭐百货整图不切(store_profiles.split='none'):乐天百货护照+小票同框"不可裁",
    // 新世界/现代百货也不切。qwen 就算把同框图误判成多文档,这里强制合并回整张一个文档。
    // 护照信息(乐天A图打码护照)并入同一 sidecar(A图护照也提取,用户拍板"保险起见提取")。
    const deptReceipt = analyses.find(
      (a) => a.docTypeFinal === DOC_TYPES.RECEIPT && isDeptStore(a.receiptStoreAuto)
    );
    if (deptReceipt) {
      const merged = {
        ...deptReceipt,
        modelMeta: { ...(deptReceipt.modelMeta || {}), bbox: [0, 0, 1, 1] },
      };
      const pp = analyses.find(
        (a) => a.docTypeFinal === DOC_TYPES.PASSPORT && (a.passportNoAuto || a.extractedNameAuto)
      );
      if (pp) {
        if (!merged.passportNoAuto) merged.passportNoAuto = pp.passportNoAuto || '';
        if (!merged.extractedNameAuto) merged.extractedNameAuto = pp.extractedNameAuto || '';
        // ⭐0729 打码数据链修复:这里原来只抄护照号和姓名,把 pp.modelMeta.bbox 扔了——
        // 而那个框(护照在整图里的位置)正是乐天百货交付包打码唯一需要的东西。
        // 合并后不再产生独立护照任务,导出侧只认独立护照任务的 bbox → 恒为空 → 打码静默不生效。
        // 0729 全库核验实锤:7 批 352 张同框票,**0 张有可用护照框**,等于打码功能从未跑过。
        // 小票自己的 bbox 必须是整图 [0,0,1,1](整图不切的契约,别动);护照框另开一个键存,
        // 放在 modelMeta 里是因为 batch_processing_service 整体透传 modelMeta → 零改管道。
        const ppBox = Array.isArray(pp.modelMeta?.bbox) ? pp.modelMeta.bbox : null;
        if (ppBox) merged.modelMeta.passportBbox = ppBox;
      }
      // 诊断标记:方案甲的命中率取决于"模型是否为同框图单独输出一个护照档"。
      // 这个问题在存量数据里测不出来——合并把证据抹了,所以只能从今天起自己记。
      // 下一个真实百货批次跑完,数一下这三种取值的占比,就知道要不要上方案乙(打包时补检测)。
      //   ok        = 拿到护照框,打码可用
      //   no_bbox   = 有护照档但没框(模型没给坐标)
      //   no_doc    = 压根没识别出独立护照档(passportNo 可能是从小票字段里带出来的)
      merged.modelMeta.passportBboxSource = merged.modelMeta.passportBbox
        ? 'ok' : (pp ? 'no_bbox' : 'no_doc');
      // L597:百货整图不切时,若同框其实有 ≥2 张「不同交易」的百货小票,合并成一档会静默丢第二张。
      // 安全网(Option 1,只打红标、不改「百货整图不切」交付/切图契约):数不同的百货店小票交易编号
      // (isDeptStore 过滤→GB/免税混入店名天然排除;编号取数字≥6 位去重),≥2 则标 needsReview +
      // dept_multi_receipt_suspect 转人工,操作员据此走「同图补小票/按此店重切」补齐漏收。
      const distinctDeptNos = new Set(
        analyses
          .filter((a) => a.docTypeFinal === DOC_TYPES.RECEIPT && isDeptStore(a.receiptStoreAuto))
          .map((a) => normalizeReceiptNoDigits(a.receiptNoAuto || ''))
          .filter((s) => s.length >= 6)
      );
      if (distinctDeptNos.size >= 2) {
        merged.needsReview = true;
        merged.reviewReasons = [...new Set([...(merged.reviewReasons || []), 'dept_multi_receipt_suspect'])];
      }
      writeSidecar(sourcePath, merged);
      return { splitApplied: false, outputs: [] };
    }

    const docs = analyses.filter(
      (a) => a.docTypeFinal === DOC_TYPES.PASSPORT || a.docTypeFinal === DOC_TYPES.RECEIPT
    );

    // 0 / 1 个文档 → 不切,sidecar 落在原图旁(批处理按原图路径读)
    if (docs.length <= 1) {
      const only = docs[0] || {
        docTypeAuto: DOC_TYPES.OTHER, docTypeFinal: DOC_TYPES.OTHER,
        needsReview: true, reviewReasons: ['qwen_no_document'], classificationSource: 'qwen',
        // 版本/模型/分辨率戳(2026-07-21 部署审计):0 文档兜底原缺 promptVersion 恒判不可复用→
        // 每轮重调;补齐三戳,无证件图首次识别后进缓存,不再反复重调 qwen。与 adapter/env 同源。
        promptVersion: QWEN_PROMPT_VERSION,
        ocrModel: process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
        ocrMaxEdge: Number(process.env.QWEN_MAX_EDGE) || 1280,
      };
      // 几何兜底:只识别出 1 个文档,但整图明显横宽(宽/高 > 1.8)→ 大概率是两个文档左右并排却没被切开,
      // 标记转人工复核(宁可人工看一眼,也不要把两张当一张漏掉)。
      if (docs.length === 1) {
        try {
          const meta = await sharp(sourcePath).metadata();
          let w = Number(meta.width || 0), h = Number(meta.height || 0);
          // EXIF 5-8 = 画面要旋转 90°:横宽判定按"转正后"的宽高算
          if (Number(meta.orientation) >= 5) [w, h] = [h, w];
          if (w > 0 && h > 0 && w / h > 1.8) {
            only.needsReview = true;
            only.reviewReasons = [...new Set([...(only.reviewReasons || []), 'suspect_uncut_wide'])];
          }
        } catch { /* metadata 读失败不阻断 */ }
      }
      writeSidecar(sourcePath, only);
      return { splitApplied: false, outputs: [] };
    }

    // ≥2 文档 → 裁子图
    fs.mkdirSync(imagesDir, { recursive: true });
    // ⭐先按 EXIF 转正再切(2026-07-03 蜜蜂批事故):手机竖拍照片带方向标记,
    // 千问看的是转正后的画面给 bbox;直接按原始像素切 = 坐标轴错位 →
    // 切片横躺/框住两张票/护照小票混切。转正后裁片也天然摆正,审核不用歪头看。
    const orientedBuffer = await sharp(sourcePath).rotate().toBuffer();
    const metadata = await sharp(orientedBuffer).metadata();
    const W = Math.max(1, Number(metadata.width || 1));
    const H = Math.max(1, Number(metadata.height || 1));
    const outputs = [];
    let outputIndex = Number.parseInt(String(startIndex || 0), 10) || 0;

    // 原图 reference(对齐 PaddleX 切分:首个 output 是原图)。
    // 压缩拷贝(2026-07-06 提速②):切图产物过去没走入库压缩,几 MB 大图拖慢审核台加载。
    const originalName = forceJpgExt(buildFileName(outputIndex, originalFileName, '_original'));
    await writeCompressedCopy(sourcePath, path.join(imagesDir, originalName));
    writeSidecar(path.join(imagesDir, originalName), {
      docTypeAuto: DOC_TYPES.OTHER, docTypeFinal: DOC_TYPES.OTHER,
      needsReview: false, reviewReasons: [], classificationSource: 'qwen', note: 'original_reference',
    });
    outputs.push({
      fileName: originalName, originalFileName, source: 'uploaded_original',
      autoSplit: true, autoSplitRole: 'original', docTypeHint: '', docTypeConfidence: 0,
      modelMeta: { backend: 'qwen' },
    });
    outputIndex += 1;

    // "其他"区也产切片(2026-07-14 审计#7):qwen 把真票误判成 other 时,以前该区在多文档
    // 切图里被静默丢弃——零任务零标红,少票只有客户对账才发现。现在 other 区一并裁出
    // (_other_N,needsReview 强制 true),操作员在审核台看得见,用「改成小票/百货」逃生口拉回。
    // 护栏:other 区 bbox 退化(过小)= 大概率噪声 → 跳过不产片(不做原图兜底,防垃圾片刷屏);
    // 护照/小票的兜底逻辑照旧(真票不能丢)。
    const otherDocs = analyses.filter(
      (a) => a.docTypeFinal !== DOC_TYPES.PASSPORT && a.docTypeFinal !== DOC_TYPES.RECEIPT
    );
    const cropDocs = [...docs, ...otherDocs];
    for (let i = 0; i < cropDocs.length; i += 1) {
      const a = cropDocs[i];
      const isOtherRegion = i >= docs.length;
      const bbox = (a.modelMeta && Array.isArray(a.modelMeta.bbox)) ? a.modelMeta.bbox : [0, 0, 1, 1];
      const [x1, y1, x2, y2] = bbox;
      const degenerate = (x2 - x1) * W < MIN_CROP_PX || (y2 - y1) * H < MIN_CROP_PX;
      if (isOtherRegion && degenerate) continue; // 噪声区:跳过,不建切片
      const suffix = isOtherRegion ? `_other_${i - docs.length + 1}` : `_${a.docTypeFinal || 'region'}_${i + 1}`;
      const fileName = forceJpgExt(buildFileName(outputIndex, originalFileName, suffix));
      const outPath = path.join(imagesDir, fileName);
      let fellBack = degenerate;

      try {
        if (fellBack) {
          await writeCompressedCopy(sourcePath, outPath); // bbox 退化 → 用原图(压缩拷贝)
        } else {
          // 小票常被千问框成偏窄的竖条 → 框明显偏窄时加大留白,尽量别切掉单据边缘。
          // (字段已从整图抽取,裁图只为操作员"看清",宁可多带背景也不要切残)
          const bboxW = x2 - x1;
          const isReceipt = a.docTypeFinal === DOC_TYPES.RECEIPT;
          const effectivePad = (isReceipt && bboxW < 0.5) ? Math.max(paddingPct, 0.1) : paddingPct;
          const rect = buildCropRect(
            { left: x1 * W, top: y1 * H, right: x2 * W, bottom: y2 * H, width: (x2 - x1) * W, height: (y2 - y1) * H },
            metadata, effectivePad
          );
          // 单遍编码即压缩(2026-07-06 提速②):限长边+q82,与入库压缩同参;
          // 识别不受影响——API 上传前本来就压到长边 1280(qwen_ocr_adapter.imageToBase64)。
          await sharp(orientedBuffer)
            .extract(rect)
            .resize({ width: COMPRESS_MAX_SIDE, height: COMPRESS_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: COMPRESS_JPEG_QUALITY, mozjpeg: true })
            .toFile(outPath);
        }
      } catch {
        try { await writeCompressedCopy(sourcePath, outPath); } catch { /* ignore */ } // 裁失败 → 原图兜底
        fellBack = true;
      }

      let analysisToWrite = fellBack
        ? { ...a, needsReview: true, reviewReasons: [...new Set([...(a.reviewReasons || []), 'qwen_crop_fallback'])] }
        : a;
      if (isOtherRegion) {
        // other 切片强制人工看一眼(它存在的意义就是"可能是被误判的真票")
        analysisToWrite = {
          ...analysisToWrite,
          docTypeAuto: DOC_TYPES.OTHER,
          docTypeFinal: DOC_TYPES.OTHER,
          needsReview: true,
          reviewReasons: [...new Set([...(analysisToWrite.reviewReasons || []), 'qwen_other_region'])],
        };
      }
      writeSidecar(outPath, analysisToWrite);
      outputs.push({
        fileName, originalFileName, source: 'uploaded_split',
        autoSplit: true, autoSplitRole: 'region',
        docTypeHint: a.docTypeFinal || '', docTypeConfidence: Number(a.docTypeConfidence || 0),
        detectionBox: bbox, modelMeta: { backend: 'qwen' },
      });
      outputIndex += 1;
    }

    return { splitApplied: true, outputs };
  }

  return { splitImage };
}

module.exports = { createQwenDocumentSplitService };
