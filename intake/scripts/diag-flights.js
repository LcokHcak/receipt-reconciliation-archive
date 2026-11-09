'use strict';

// 诊断航班图为何没归组：分类未归原因，并对"有航班号+离境日却没配上"的，
// 打印本客户小票的航班+离境月日，判断是"小票侧没抽到"还是"真歧义"。

const fs = require('node:fs');
const path = require('node:path');
const { group } = require('../src/grouping/grouping-engine');

const folderOf = (id) => String(id).split(/[\\/]/)[0];
const md = (d) => {
  const m = String(d || '').match(/(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phase0-output', 'records.json'), 'utf8'));
const { clusters } = group(d.records, { rejectInvalid: true, fuzzy: true, maxDistance: 2, bridgeFlights: true });
const assigned = new Set();
clusters.forEach((c) => c.recordIds.forEach((id) => assigned.add(id)));

const flights = d.records.filter((r) => r.type === 'flight');
let grouped = 0;
let noFlightNo = 0;
let noDep = 0;
let receiptNoDep = 0; // 小票侧没离境日
let dayMismatch = 0; // 双方都有但月日对不上
let ambiguous = 0; // 月日航班都对得上但多客户共享
const samples = [];

for (const f of flights) {
  if (assigned.has(f.id)) { grouped++; continue; }
  if (!f.flightNo) { noFlightNo++; continue; }
  if (!md(f.departureDate)) { noDep++; continue; }
  const fo = folderOf(f.id);
  const receipts = d.records.filter((r) => r.type === 'receipt' && folderOf(r.id) === fo);
  const recDeps = receipts.map((r) => `${r.flightNo || '-'}/${md(r.departureDate) || '-'}`);
  const recHasDep = receipts.some((r) => md(r.departureDate));
  if (!recHasDep) {
    receiptNoDep++;
    if (samples.length < 8) samples.push({ fo, f: `${f.flightNo}/${md(f.departureDate)}`, rec: recDeps });
  } else {
    const fday = md(f.departureDate);
    const match = receipts.some((r) => md(r.departureDate) === fday);
    if (!match) dayMismatch++;
    else ambiguous++;
  }
}

console.log('航班图', flights.length, '| 已归', grouped, '| 无航班号', noFlightNo, '| 无离境日', noDep);
console.log('未归且双方应可配的细分:');
console.log('  小票侧没抽到离境日:', receiptNoDep);
console.log('  双方都有但月日对不上:', dayMismatch);
console.log('  月日航班都对得上(疑共享/歧义):', ambiguous);
console.log('\n样例(航班图 vs 本客户小票):');
for (const s of samples) console.log('  ', s.fo, '| 航班图', s.f, '| 小票', s.rec.join(', '));
