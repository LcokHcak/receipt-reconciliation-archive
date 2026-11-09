'use strict';

// 离线重评分：加载已落盘的抽取记录(phase0-output/records.json)，
// 用不同归组策略重跑评分对比，不调用任何 API（免费迭代归组逻辑）。
// 运行：node scripts/rescore-offline.js

const fs = require('node:fs');
const path = require('node:path');

const { group } = require('../src/grouping/grouping-engine');
const { score } = require('../src/scoring/group-scorer');

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function evaluate(label, records, truthByRecord, opts) {
  const { clusters, unassigned } = group(records, opts);
  const m = score({ predicted: clusters, truthByRecord });
  console.log(
    [label.padEnd(28), `簇 ${String(clusters.length).padStart(2)}`, `待人工 ${unassigned.length}`,
      `P ${pct(m.precision)}`, `R ${pct(m.recall)}`, `F1 ${pct(m.f1)}`, `覆盖 ${pct(m.coverage)}`].join('  ')
  );
  return { clusters, m };
}

// 核心指标：只看 护照+小票（对账关键），剔除航班图/抽取失败（本就该留上下文/重试）
function evaluateCore(label, records, truthByRecord, opts) {
  const coreIds = new Set(records.filter((r) => r.type === 'passport' || r.type === 'receipt').map((r) => r.id));
  const { clusters } = group(records, opts);
  const corePredicted = clusters
    .map((c) => ({ ...c, recordIds: c.recordIds.filter((id) => coreIds.has(id)) }))
    .filter((c) => c.recordIds.length);
  const coreTruth = new Map([...truthByRecord].filter(([id]) => coreIds.has(id)));
  const m = score({ predicted: corePredicted, truthByRecord: coreTruth });
  console.log(
    [label.padEnd(28), `P ${pct(m.precision)}`, `R ${pct(m.recall)}`, `F1 ${pct(m.f1)}`, `覆盖 ${pct(m.coverage)}`,
      `核心图 ${m.totalRecords}`].join('  ')
  );
  return m;
}

// 航班图归组：归对=和本客户其他图同簇；归错=进了别的客户簇；留人工=未归
function evaluateFlights(label, records, truthByRecord, opts) {
  const flightIds = records.filter((r) => r.type === 'flight').map((r) => r.id);
  const { clusters } = group(records, opts);
  const clusterOf = new Map();
  clusters.forEach((c) => c.recordIds.forEach((id) => clusterOf.set(id, c)));
  let assigned = 0;
  let correct = 0;
  for (const fid of flightIds) {
    const c = clusterOf.get(fid);
    if (!c) continue;
    assigned += 1;
    const t = truthByRecord.get(fid);
    if (c.recordIds.some((id) => id !== fid && truthByRecord.get(id) === t)) correct += 1;
  }
  const wrong = assigned - correct;
  const rate = assigned ? (correct / assigned) * 100 : 0;
  console.log(
    `${label}  航班图 ${flightIds.length}  归组 ${assigned}  归对 ${correct}  归错 ${wrong}  留人工 ${flightIds.length - assigned}  归对率 ${rate.toFixed(1)}%`
  );
}

function main() {
  const file = path.join(__dirname, '..', 'phase0-output', 'records.json');
  if (!fs.existsSync(file)) {
    console.error('未找到 phase0-output/records.json，请先跑一次抽取落盘。');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = data.records;
  // 真值组 = id 的首段(完整文件夹名)，每客户唯一；不用会撞号的护照尾号
  const truthByRecord = new Map(records.map((r) => [r.id, String(r.id).split(/[\\/]/)[0]]));
  const tuned = { rejectInvalid: true, fuzzy: true, maxDistance: 2, bridgeFlights: true };

  console.log(`记录数 ${records.length}  真值组(客户)数 ${new Set([...truthByRecord.values()]).size}\n`);
  console.log('— 全量(含航班图/失败) —');
  evaluate('① 精确匹配(原)', records, truthByRecord, {});
  evaluate('② +格式校验弃打码', records, truthByRecord, { rejectInvalid: true });
  evaluate('③ 调优(模糊+佐证+航班留人工)', records, truthByRecord, tuned);
  console.log('\n— 核心(只看护照+小票，对账关键) —');
  evaluateCore('③ 核心', records, truthByRecord, tuned);
  console.log('\n— 航班图(用航班号+离境月日归组) —');
  evaluateFlights('③', records, truthByRecord, tuned);
}

main();
