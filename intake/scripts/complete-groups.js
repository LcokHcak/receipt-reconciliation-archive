'use strict';

// 完整客户组率：一个客户必须 护照+小票+航班截图 三类全部正确归到同一簇才算"完整且正确"。
// 这是业务真正要的指标(缺一不可)。基于已落盘 records.json,不调用 API。
// 运行：node scripts/complete-groups.js

const fs = require('node:fs');
const path = require('node:path');

const { group } = require('../src/grouping/grouping-engine');

const TUNED = { rejectInvalid: true, fuzzy: true, maxDistance: 2, bridgeFlights: true };

function folderOf(id) {
  return String(id).split(/[\\/]/)[0];
}

function main() {
  const file = path.join(__dirname, '..', 'phase0-output', 'records.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = data.records;
  const recById = new Map(records.map((r) => [r.id, r]));

  // 每个客户(文件夹)源头有哪些类型
  const srcTypes = new Map();
  for (const r of records) {
    const f = folderOf(r.id);
    if (!srcTypes.has(f)) srcTypes.set(f, new Set());
    if (r.type === 'passport' || r.type === 'receipt' || r.type === 'flight') srcTypes.get(f).add(r.type);
  }
  const allFolders = [...srcTypes.keys()];
  const have3 = allFolders.filter((f) => {
    const s = srcTypes.get(f);
    return s.has('passport') && s.has('receipt') && s.has('flight');
  });

  // 归组
  const { clusters } = group(records, TUNED);

  // 每个簇：成员文件夹组成 + 该簇内类型(限本文件夹)
  const completeFolders = new Set();
  for (const c of clusters) {
    const folders = new Set(c.recordIds.map(folderOf));
    if (folders.size !== 1) continue; // 不纯(混了多个客户)→ 不算完整正确
    const f = [...folders][0];
    const types = new Set(c.recordIds.map((id) => recById.get(id).type));
    if (types.has('passport') && types.has('receipt') && types.has('flight')) {
      completeFolders.add(f);
    }
  }

  const total = allFolders.length;
  const ceiling = have3.length;
  const complete = completeFolders.size;
  const missingDoc = total - ceiling;

  console.log('===== 完整客户组率(护照+小票+航班 缺一不可) =====');
  console.log(`客户(文件夹)总数:        ${total}`);
  console.log(`源头就缺某类单据的客户:    ${missingDoc}  (无法完整,非归组问题)`);
  console.log(`源头三类齐全(可完整上限): ${ceiling}`);
  console.log('');
  console.log(`✅ 完整且正确归组的客户:   ${complete}`);
  console.log(`   占全部客户:             ${((complete / total) * 100).toFixed(1)}%`);
  console.log(`   占三类齐全客户:         ${((complete / ceiling) * 100).toFixed(1)}%`);
}

main();
