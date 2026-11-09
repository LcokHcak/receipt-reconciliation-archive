'use strict';

// 把已抽取的图片（phase0-output/records.json）当成"一堆混在一起的图"，
// 用归组引擎物理分拣进 phase0-output/sorted/<客户>/ 文件夹，并验证准确率。
// 不调用 API（复用已落盘抽取）。运行：node --env-file=.env scripts/sort-into-folders.js
//
// 拣出的文件名前缀 = 真值组(文件夹护照尾号)，所以打开某个客户文件夹时，
// 若所有文件前缀一致 → 分类纯净；若混入别的前缀 → 一眼看出错并。

const fs = require('node:fs');
const path = require('node:path');

const { group } = require('../src/grouping/grouping-engine');

function sanitize(name) {
  return String(name || 'unknown').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').replace(/_+/g, '_').slice(0, 40) || 'unknown';
}

function main() {
  const sampleDir = process.env.PHASE0_SAMPLE_DIR;
  if (!sampleDir) throw new Error('需要 PHASE0_SAMPLE_DIR（用 --env-file=.env 运行）');

  const recPath = path.join(__dirname, '..', 'phase0-output', 'records.json');
  const data = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const truth = new Map(data.truth);
  const records = data.records;

  const { clusters, unassigned } = group(records, { rejectInvalid: true, fuzzy: true, maxDistance: 2 });

  const outRoot = path.join(__dirname, '..', 'phase0-output', 'sorted');
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const used = new Set();
  let copied = 0;
  let pure = 0;
  let mixed = 0;
  const mixedDetail = [];

  for (const c of clusters) {
    const truthSet = new Set(c.recordIds.map((id) => truth.get(id)));
    const isPure = truthSet.size === 1;
    if (isPure) pure++;
    else {
      mixed++;
      mixedDetail.push({ key: c.key, truths: [...truthSet], n: c.recordIds.length });
    }

    let folderName = sanitize(c.name || c.key);
    while (used.has(folderName)) folderName += '_' + c.key.slice(-3);
    used.add(folderName);
    const dir = path.join(outRoot, folderName);
    fs.mkdirSync(dir, { recursive: true });

    for (const id of c.recordIds) {
      copyImage(sampleDir, id, dir, truth);
      copied++;
    }
  }

  // 未归组
  const unDir = path.join(outRoot, '_unassigned');
  fs.mkdirSync(unDir, { recursive: true });
  for (const id of unassigned) copyImage(sampleDir, id, unDir, truth);

  const grouped = copied;
  const purity = clusters.length ? (pure / clusters.length) * 100 : 0;

  console.log('===== 物理分拣报告 =====');
  console.log(`总图片 ${records.length}  已归组 ${grouped}(${clusters.length}簇)  未归组 ${unassigned.length}`);
  console.log(`纯净簇 ${pure}  错并簇 ${mixed}  → 簇纯净率 ${purity.toFixed(1)}%`);
  if (mixedDetail.length) {
    console.log('\n错并簇明细:');
    for (const m of mixedDetail) console.log(`  [${m.key}] 混了真值组 ${m.truths.join('+')}  共${m.n}条`);
  }
  console.log(`\n分拣结果已写入: ${outRoot}`);
  console.log('打开任一客户文件夹：文件名前缀同 = 分对；混入别的前缀 = 错并。');
}

function copyImage(sampleDir, id, destDir, truth) {
  try {
    const src = path.join(sampleDir, id);
    const tag = truth.get(id) || '???';
    const dest = path.join(destDir, `${sanitize(tag)}__${path.basename(id)}`);
    fs.copyFileSync(src, dest);
  } catch {
    /* 跳过缺失/无法复制的文件 */
  }
}

main();
