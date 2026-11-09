'use strict';

/**
 * build_rec_dataset.js - OCR recognition dataset builder for passport/receipt crops.
 *
 * Purpose:
 *   Build PP-OCR rec fine-tuning samples from reviewed production batches without
 *   hand-drawing labels.
 *
 * Sources:
 *   - OCR text lines: batch <batchDir>/raw_json/<task>.json lines[{text,score,box}]
 *   - Reviewed values: batch.json task *Final fields
 *   - Source image: task.sourceImagePath relative to batchDir
 *
 * Label rule:
 *   Recognition labels must be the literal text printed in the image, not the
 *   normalized business value. Example: if OCR line is "ZHOU,JIAHUI" and Final is
 *   "ZHOU JIAHUI", the comma may be the true printed separator. Only samples where
 *   OCR and Final agree after field-specific normalization enter train/val.
 *   Disagreements go to _corrections_review.tsv for manual review.
 *
 * Output format follows MSTextRecLMSSLDataset:
 *   <out>/images/item_XXXX.png
 *   <out>/train.txt            "images/item_XXXX.png\t<label>"
 *   <out>/val.txt
 *   <out>/train_unlabeled.txt  empty for v1
 *   <out>/dict.txt
 *   <out>/README.md
 *   <out>/_corrections_review.tsv
 *   <out>/_unmatched.tsv
 *
 * Usage:
 *   node scripts/build_rec_dataset.js --doc passport --out tmp/rec_passport
 *   node scripts/build_rec_dataset.js --doc receipt --batches <batchesRoot> --out tmp/rec_receipt --val 0.15
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const NORMALIZERS = {
  alnum: (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  latin: (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, ''),
  digits: (s) => String(s || '').replace(/[^0-9]/g, ''),
  cjk: (s) => (String(s || '').match(/\p{Script=Han}/gu) || []).join(''),
};

const FIELD_SPECS = {
  passport: [
    { label: 'passport_no_region', finals: ['passportNoFinal', 'passportNoAuto'], norm: 'alnum', minKey: 5 },
    { label: 'english_name_region', finals: ['extractedNameFinal', 'extractedNameAuto'], norm: 'latin', minKey: 3 },
    { label: 'chinese_name_region', finals: ['chineseNameFinal', 'chineseNameAuto'], norm: 'cjk', minKey: 2 },
  ],
  receipt: [
    { label: 'store_family_region', finals: ['receiptStoreFinal', 'receiptStoreAuto'], norm: 'latin', minKey: 3 },
    { label: 'receipt_no_region', finals: ['receiptNoFinal', 'receiptNoAuto'], norm: 'digits', minKey: 6 },
    { label: 'group_no_region', finals: ['groupNoFinal', 'groupNoAuto'], norm: 'digits', minKey: 4 },
    { label: 'purchase_date_region', finals: ['purchaseDateFinal', 'purchaseDateAuto'], norm: 'digits', minKey: 6 },
    { label: 'departure_date_region', finals: ['departureDateFinal', 'departureDateAuto'], norm: 'digits', minKey: 6 },
  ],
};

function parseArgs(argv) {
  const args = { doc: '', batches: '', out: '', val: 0.15, pad: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--doc') args.doc = next();
    else if (a === '--batches') args.batches = next();
    else if (a === '--out') args.out = next();
    else if (a === '--val') args.val = Number(next());
    else if (a === '--pad') args.pad = Number(next());
  }
  return args;
}

function firstFinal(task, keys) {
  for (const k of keys) {
    const v = task[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Keep a source folder/customer together in train or val to avoid leakage.
function stableHash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function matchLine(value, lines, normName, minKey) {
  const norm = NORMALIZERS[normName];
  const vKey = norm(value);
  if (vKey.length < minKey) return null;
  let best = null;
  let bestScore = 0;
  for (const line of lines) {
    const lKey = norm(line.text);
    if (lKey.length < minKey) continue;
    let score = 0;
    if (lKey === vKey) score = 100 + lKey.length;
    else if (lKey.includes(vKey)) score = 60 + vKey.length - (lKey.length - vKey.length);
    else if (vKey.includes(lKey)) score = 50 + lKey.length;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (!best) return null;
  const agree = norm(best.text) === vKey;
  return { line: best, agree };
}

async function cropLine(imagePath, box, outPath, pad, dims) {
  const left = Math.max(0, Math.round(box.left) - pad);
  const top = Math.max(0, Math.round(box.top) - pad);
  const right = Math.min(dims.width, Math.round(box.right) + pad);
  const bottom = Math.min(dims.height, Math.round(box.bottom) + pad);
  const width = right - left;
  const height = bottom - top;
  if (width <= 1 || height <= 1) return false;
  await sharp(imagePath)
    .extract({ left, top, width, height })
    .png()
    .toFile(outPath);
  return true;
}

function defaultBatchesRoot() {
  return path.join(
    __dirname,
    '..',
    'passport_review_workbench',
    'storage',
    'batches'
  );
}

async function buildRecDataset(args) {
  if (!FIELD_SPECS[args.doc]) {
    throw new Error('doc must be passport|receipt');
  }
  const batchesRoot = args.batches || defaultBatchesRoot();
  const outDir = args.out || path.join(__dirname, '..', 'tmp', `rec_${args.doc}`);
  const imagesDir = path.join(outDir, 'images');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });

  const valRatio = Number.isFinite(Number(args.val)) ? Number(args.val) : 0.15;
  const pad = Number.isFinite(Number(args.pad)) ? Number(args.pad) : 3;
  const specs = FIELD_SPECS[args.doc];
  const trainLines = [];
  const valLines = [];
  const corrections = [];
  const unmatched = [];
  // 字段定位弱标注源:匹配成功的 OCR 行框 = 该字段在原图上的位置(文本读对了说明行就在那)
  const boxes = [];
  const dict = new Set();
  let sampleIdx = 0;
  let taskSeen = 0;
  let taskUsable = 0;

  const batchDirs = fs.existsSync(batchesRoot)
    ? fs.readdirSync(batchesRoot).filter((b) => fs.existsSync(path.join(batchesRoot, b, 'batch.json')))
    : [];

  for (const b of batchDirs) {
    const bd = path.join(batchesRoot, b);
    let batch;
    try {
      batch = JSON.parse(fs.readFileSync(path.join(bd, 'batch.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const task of batch.tasks || []) {
      const docType = String(task.docTypeFinal || task.docTypeAuto || '').toLowerCase();
      if (!docType.includes(args.doc)) continue;
      taskSeen += 1;

      const rawRel = String(task.rawJsonPath || '').split('\\').join('/');
      const imgRel = String(task.sourceImagePath || '').split('\\').join('/');
      const imgPath = path.join(bd, imgRel);
      if (!rawRel || !imgRel || !fs.existsSync(imgPath)) continue;

      let lines;
      try {
        lines = JSON.parse(fs.readFileSync(path.join(bd, rawRel), 'utf8')).lines || [];
      } catch {
        lines = [];
      }
      if (lines.length === 0) continue;

      let dims;
      try {
        const meta = await sharp(imgPath).metadata();
        dims = { width: meta.width, height: meta.height };
      } catch {
        continue;
      }

      const toVal = stableHash(task.sourceFolderPath || task.sourceGroupKey || task.id) % 100 < Math.round(valRatio * 100);
      let usedThisTask = false;

      for (const spec of specs) {
        const value = firstFinal(task, spec.finals);
        if (!value) continue;
        const m = matchLine(value, lines, spec.norm, spec.minKey);
        if (!m) {
          unmatched.push([b, task.id, spec.label, value].join('\t'));
          continue;
        }
        const literal = String(m.line.text).trim();
        if (!m.agree) {
          corrections.push([b, task.id, spec.label, literal, value].join('\t'));
          continue;
        }
        if (!literal) continue;
        sampleIdx += 1;
        const itemName = `item_${String(sampleIdx).padStart(4, '0')}.png`;
        const ok = await cropLine(imgPath, m.line.box, path.join(imagesDir, itemName), pad, dims);
        if (!ok) {
          sampleIdx -= 1;
          continue;
        }
        boxes.push({
          imageAbs: path.resolve(imgPath),
          width: dims.width,
          height: dims.height,
          label: spec.label,
          box: m.line.box,
          split: toVal ? 'val' : 'train',
          batch: b,
          taskId: task.id,
        });
        for (const ch of literal) {
          if (!/\s/.test(ch)) dict.add(ch);
        }
        const row = `images/${itemName}\t${literal}`;
        if (toVal) valLines.push(row);
        else trainLines.push(row);
        usedThisTask = true;
      }
      if (usedThisTask) taskUsable += 1;
    }
  }

  const nl = (arr) => arr.join('\n') + (arr.length ? '\n' : '');
  fs.writeFileSync(path.join(outDir, 'train.txt'), nl(trainLines), 'utf8');
  fs.writeFileSync(path.join(outDir, 'val.txt'), nl(valLines), 'utf8');
  fs.writeFileSync(path.join(outDir, 'train_unlabeled.txt'), '', 'utf8');
  fs.writeFileSync(path.join(outDir, 'dict.txt'), nl([...dict].sort()), 'utf8');
  fs.writeFileSync(
    path.join(outDir, '_corrections_review.tsv'),
    nl(['batch\ttaskId\tfield\tocr_text\tfinal_value', ...corrections]),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, '_unmatched.tsv'),
    nl(['batch\ttaskId\tfield\tfinal_value', ...unmatched]),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, '_boxes.jsonl'),
    nl(boxes.map((bx) => JSON.stringify(bx))),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, 'README.md'),
    [
      `# rec_${args.doc} (MSTextRecLMSSLDataset)`,
      '',
      `- doc type: ${args.doc}`,
      `- train images: ${trainLines.length}`,
      `- val images: ${valLines.length}`,
      `- unlabeled images: 0`,
      `- fields: ${specs.map((s) => s.label).join(', ')}`,
      `- corrections pending review (OCR != Final): ${corrections.length}`,
      `- unmatched (has Final, no OCR line): ${unmatched.length}`,
      '- Label = literal OCR line text. Only samples where OCR and Final agree after normalization are included.',
      '- Review _corrections_review.tsv before adding corrected samples.',
      '- upload this folder directly to AI Studio (skip the _*.tsv helper files)',
    ].join('\n') + '\n',
    'utf8'
  );

  return {
    doc: args.doc,
    batchesRoot,
    outDir,
    taskSeen,
    taskUsable,
    train: trainLines.length,
    val: valLines.length,
    corrections: corrections.length,
    unmatched: unmatched.length,
    dictSize: dict.size,
    boxes: boxes.length,
  };
}

module.exports = { buildRecDataset, FIELD_SPECS, stableHash };

if (require.main === module) {
  buildRecDataset(parseArgs(process.argv))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((err) => {
      console.error('build_rec_dataset failed:', err);
      process.exit(1);
    });
}
