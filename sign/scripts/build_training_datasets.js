'use strict';

/**
 * build_training_datasets.js - 训练数据回流编排器(飞桨数据集 1~6)
 *
 * 从已审核的生产数据自动构建 6 个飞桨格式数据集(对应 AI Studio repo JINHAIMIN/1~6):
 *   1 = mix 切图检测     COCO   来源:客户库 customer.json images[] 的 autoSplit
 *                               detectionBox(模型框,人工流程隐式确认) + 对应 task
 *                               docTypeFinal 映射类别(人工改分类=纠正框类别)
 *   2 = 文档分类         cls    来源:已审核 task sourceImagePath + docTypeFinal 金标
 *   3 = 护照字段定位     COCO   来源:rec 构建器匹配成功的 OCR 行框(弱标注:文本读对
 *                               了说明行框就是字段位置)
 *   4 = 护照 rec         mstextrec  来源:build_rec_dataset(--doc passport)
 *   5 = 小票字段定位     COCO   同 3,doc=receipt
 *   6 = 小票 rec         mstextrec  来源:build_rec_dataset(--doc receipt)
 *
 * 输出: <out>/<stamp>/{1_mix_det,2_cls,3_passport_det,4_passport_rec,5_receipt_det,6_receipt_rec}/
 *        + summary.json(各数据集样本量统计,前端训练页展示用)
 *
 * 只读旁路:读批次/客户库,写独立导出目录,不碰业务数据。
 *
 * 用法:
 *   node scripts/build_training_datasets.js [--batches <root>] [--customers <root>] [--out <dir>] [--val 0.15]
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { buildRecDataset, stableHash } = require('./build_rec_dataset');

const DOC_CATEGORIES = [
  { id: 1, name: 'passport_region', docType: 'passport' },
  { id: 2, name: 'receipt_region', docType: 'receipt' },
  { id: 3, name: 'other_region', docType: 'other' },
];
const CLS_LABELS = [
  { id: 0, name: 'passport' },
  { id: 1, name: 'receipt' },
  { id: 2, name: 'other' },
];
const PASSPORT_DET_CATEGORIES = [
  'passport_no_region', 'english_name_region', 'chinese_name_region',
].map((name, i) => ({ id: i + 1, name }));
const RECEIPT_DET_CATEGORIES = [
  'store_family_region', 'receipt_no_region', 'group_no_region',
  'purchase_date_region', 'departure_date_region',
].map((name, i) => ({ id: i + 1, name }));

function parseArgs(argv) {
  const args = { batches: '', customers: '', out: '', val: 0.15 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--batches') args.batches = next();
    else if (a === '--customers') args.customers = next();
    else if (a === '--out') args.out = next();
    else if (a === '--val') args.val = Number(next());
  }
  return args;
}

function storageRoot() {
  return path.join(__dirname, '..', 'passport_review_workbench', 'storage');
}

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function nl(arr) {
  return arr.join('\n') + (arr.length ? '\n' : '');
}

function normalizeDocType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'passport' || v === 'receipt') return v;
  return 'other';
}

function* iterateBatchTasks(batchesRoot) {
  if (!fs.existsSync(batchesRoot)) return;
  for (const b of fs.readdirSync(batchesRoot)) {
    const bd = path.join(batchesRoot, b);
    const bj = path.join(bd, 'batch.json');
    if (!fs.existsSync(bj)) continue;
    let batch;
    try {
      batch = JSON.parse(fs.readFileSync(bj, 'utf8'));
    } catch {
      continue;
    }
    for (const task of batch.tasks || []) yield { batchId: b, batchDir: bd, task };
  }
}

// ── 数据集 2:文档分类(cls_lmssl) ─────────────────────────────────
// 金标 = docTypeFinal(业务内人工确认/纠正)。纠错样本全收,一致样本抽样防遗忘。
async function buildClsDataset({ batchesRoot, outDir, valRatio, keepAgreeRatio = 0.2 }) {
  ensureCleanDir(path.join(outDir, 'images'));
  const train = [];
  const val = [];
  let idx = 0;
  let corrected = 0;
  for (const { batchDir, task } of iterateBatchTasks(batchesRoot)) {
    if (!task.reviewed && !task.docTypeFinal) continue;
    const finalType = normalizeDocType(task.docTypeFinal || task.docTypeAuto);
    const autoType = normalizeDocType(task.docTypeAuto);
    const isCorrection = task.docTypeFinal && finalType !== autoType;
    // 纠错样本(人工改过分类)全收;一致样本抽 keepAgreeRatio 防分布偏移
    if (!isCorrection && stableHash(`${task.id}cls`) % 100 >= Math.round(keepAgreeRatio * 100)) continue;
    const imgRel = String(task.sourceImagePath || '').split('\\').join('/');
    const imgPath = path.join(batchDir, imgRel);
    if (!imgRel || !fs.existsSync(imgPath)) continue;
    idx += 1;
    if (isCorrection) corrected += 1;
    const ext = path.extname(imgPath) || '.jpg';
    const name = `cls_${String(idx).padStart(5, '0')}${ext}`;
    fs.copyFileSync(imgPath, path.join(outDir, 'images', name));
    const labelId = CLS_LABELS.find((l) => l.name === finalType).id;
    const row = `images/${name} ${labelId}`;
    const toVal = stableHash(task.sourceFolderPath || task.id) % 100 < Math.round(valRatio * 100);
    (toVal ? val : train).push(row);
  }
  fs.writeFileSync(path.join(outDir, 'train.txt'), nl(train), 'utf8');
  fs.writeFileSync(path.join(outDir, 'val.txt'), nl(val), 'utf8');
  fs.writeFileSync(path.join(outDir, 'label.txt'), nl(CLS_LABELS.map((l) => `${l.id} ${l.name}`)), 'utf8');
  return { train: train.length, val: val.length, corrected };
}

// ── COCO 工具:boxes 列表 → cocodet 目录 ──────────────────────────
async function writeCocoDataset({ outDir, categories, samples }) {
  // samples: [{ imageAbs, width, height, anns: [{categoryName, bbox:[x,y,w,h]}], split }]
  ensureCleanDir(path.join(outDir, 'images'));
  fs.mkdirSync(path.join(outDir, 'annotations'), { recursive: true });
  const catId = new Map(categories.map((c) => [c.name, c.id]));
  const splits = { train: { images: [], annotations: [], categories }, val: { images: [], annotations: [], categories } };
  let imgId = 0;
  let annId = 0;
  for (const s of samples) {
    const bucket = splits[s.split] || splits.train;
    imgId += 1;
    const ext = path.extname(s.imageAbs) || '.jpg';
    const fileName = `img_${String(imgId).padStart(5, '0')}${ext}`;
    fs.copyFileSync(s.imageAbs, path.join(outDir, 'images', fileName));
    bucket.images.push({ id: imgId, file_name: fileName, width: s.width, height: s.height });
    for (const a of s.anns) {
      const cid = catId.get(a.categoryName);
      if (!cid) continue;
      annId += 1;
      const [x, y, w, h] = a.bbox;
      bucket.annotations.push({
        id: annId, image_id: imgId, category_id: cid,
        bbox: [x, y, w, h], area: w * h, iscrowd: 0,
        segmentation: [[x, y, x + w, y, x + w, y + h, x, y + h]],
      });
    }
  }
  fs.writeFileSync(path.join(outDir, 'annotations', 'instance_train.json'), JSON.stringify(splits.train), 'utf8');
  fs.writeFileSync(path.join(outDir, 'annotations', 'instance_val.json'), JSON.stringify(splits.val), 'utf8');
  return {
    train: splits.train.images.length, val: splits.val.images.length,
    annTrain: splits.train.annotations.length, annVal: splits.val.annotations.length,
  };
}

// ── 数据集 1:mix 切图检测 ────────────────────────────────────────
// 客户库 customer.json images[](autoSplit 子图带 detectionBox/原图名) + task docTypeFinal。
// 同一父图的所有子图框聚成一张 COCO 样本;子图 docTypeFinal 来自批次 task(按文件名关联)。
async function buildMixDataset({ customersRoot, batchesRoot, outDir, valRatio }) {
  // 文件名 → docTypeFinal 索引(批次任务的人工金标)
  const typeByFile = new Map();
  for (const { task } of iterateBatchTasks(batchesRoot)) {
    const fn = path.basename(String(task.sourceImagePath || '').split('\\').join('/'));
    if (fn && (task.docTypeFinal || task.reviewed)) {
      typeByFile.set(fn, normalizeDocType(task.docTypeFinal || task.docTypeAuto));
    }
  }
  const samples = [];
  let skippedNoParent = 0;
  if (fs.existsSync(customersRoot)) {
    for (const ws of fs.readdirSync(customersRoot)) {
      const wsDir = path.join(customersRoot, ws);
      if (!fs.statSync(wsDir).isDirectory()) continue;
      for (const cust of fs.readdirSync(wsDir)) {
        const cj = path.join(wsDir, cust, 'customer.json');
        if (!fs.existsSync(cj)) continue;
        let doc;
        try {
          doc = JSON.parse(fs.readFileSync(cj, 'utf8'));
        } catch {
          continue;
        }
        // 按父图聚合 autoSplit 子图
        const byParent = new Map();
        for (const img of doc.images || []) {
          if (!img.autoSplit || img.autoSplitRole !== 'region' || !img.detectionBox) continue;
          const parent = String(img.originalFileName || '').trim();
          if (!parent) continue;
          if (!byParent.has(parent)) byParent.set(parent, []);
          byParent.get(parent).push(img);
        }
        for (const [parent, regions] of byParent) {
          const parentPath = path.join(wsDir, cust, 'images', parent);
          const parentAlt = path.join(wsDir, cust, parent);
          const pp = fs.existsSync(parentPath) ? parentPath : (fs.existsSync(parentAlt) ? parentAlt : null);
          if (!pp) { skippedNoParent += 1; continue; }
          let dims;
          try {
            const meta = await sharp(pp).metadata();
            dims = { width: meta.width, height: meta.height };
          } catch { continue; }
          const anns = [];
          for (const region of regions) {
            const b = region.detectionBox;
            if (!b || !(b.right > b.left) || !(b.bottom > b.top)) continue;
            const childName = path.basename(String(region.relativePath || ''));
            const docType = typeByFile.get(childName) || normalizeDocType(region.docTypeHint);
            const cat = DOC_CATEGORIES.find((c) => c.docType === docType) || DOC_CATEGORIES[2];
            anns.push({ categoryName: cat.name, bbox: [b.left, b.top, b.right - b.left, b.bottom - b.top] });
          }
          if (!anns.length) continue;
          samples.push({
            imageAbs: pp, width: dims.width, height: dims.height, anns,
            split: stableHash(`${cust}|${parent}`) % 100 < Math.round(valRatio * 100) ? 'val' : 'train',
          });
        }
      }
    }
  }
  const stats = await writeCocoDataset({ outDir, categories: DOC_CATEGORIES.map(({ id, name }) => ({ id, name })), samples });
  return { ...stats, skippedNoParent };
}

// ── 数据集 3/5:字段定位弱标注(rec 匹配行框 → COCO) ─────────────────
async function buildFieldDetFromBoxes({ boxesPath, outDir, categories }) {
  const samples = new Map(); // imageAbs → sample
  if (fs.existsSync(boxesPath)) {
    for (const line of fs.readFileSync(boxesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!samples.has(r.imageAbs)) {
        samples.set(r.imageAbs, { imageAbs: r.imageAbs, width: r.width, height: r.height, anns: [], split: r.split });
      }
      const b = r.box;
      samples.get(r.imageAbs).anns.push({
        categoryName: r.label,
        bbox: [b.left, b.top, b.right - b.left, b.bottom - b.top],
      });
    }
  }
  return writeCocoDataset({ outDir, categories, samples: [...samples.values()] });
}

async function buildAll(args) {
  const batchesRoot = args.batches || path.join(storageRoot(), 'batches');
  const customersRoot = args.customers || path.join(storageRoot(), 'customer_library');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const outRoot = args.out || path.join(storageRoot(), 'train_exports', `feijiang_${stamp}`);
  const valRatio = Number.isFinite(Number(args.val)) ? Number(args.val) : 0.15;
  fs.mkdirSync(outRoot, { recursive: true });

  const summary = { stamp, outRoot, datasets: {} };

  // 4/6 rec(顺便产出 _boxes.jsonl 给 3/5 用)
  const recPassportDir = path.join(outRoot, '4_passport_rec');
  const recReceiptDir = path.join(outRoot, '6_receipt_rec');
  summary.datasets['4_passport_rec'] = await buildRecDataset({ doc: 'passport', batches: batchesRoot, out: recPassportDir, val: valRatio });
  summary.datasets['6_receipt_rec'] = await buildRecDataset({ doc: 'receipt', batches: batchesRoot, out: recReceiptDir, val: valRatio });

  // 2 分类
  summary.datasets['2_cls'] = await buildClsDataset({ batchesRoot, outDir: path.join(outRoot, '2_cls'), valRatio });

  // 1 mix 切图
  summary.datasets['1_mix_det'] = await buildMixDataset({ customersRoot, batchesRoot, outDir: path.join(outRoot, '1_mix_det'), valRatio });

  // 3/5 字段定位弱标注
  summary.datasets['3_passport_det'] = await buildFieldDetFromBoxes({
    boxesPath: path.join(recPassportDir, '_boxes.jsonl'),
    outDir: path.join(outRoot, '3_passport_det'),
    categories: PASSPORT_DET_CATEGORIES,
  });
  summary.datasets['5_receipt_det'] = await buildFieldDetFromBoxes({
    boxesPath: path.join(recReceiptDir, '_boxes.jsonl'),
    outDir: path.join(outRoot, '5_receipt_det'),
    categories: RECEIPT_DET_CATEGORIES,
  });

  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

module.exports = { buildAll };

if (require.main === module) {
  buildAll(parseArgs(process.argv))
    .then((s) => console.log(JSON.stringify(s, null, 2)))
    .catch((err) => {
      console.error('build_training_datasets failed:', err);
      process.exit(1);
    });
}
