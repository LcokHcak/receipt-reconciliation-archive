'use strict';

// 用真实抽取数据(records.json) + 合成发送时间线，演示"有发送上下文"后完整率的提升。
// 假设(明确写出，便于判断真实性)：
//   - 代理按客户依次处理(轮流分给 N 个代理)，每个客户的图在 ~90 秒窗口内连发，
//     不同客户间隔 ~8 分钟。这模拟"代理一个客户一个客户地发"。
//   - 真实值取决于真实发送节奏(交错/闲聊多则更难)，此处仅证明机制+量级。
// 运行：node scripts/simulate-stream.js

const fs = require('node:fs');
const path = require('node:path');
const { createGroupAssembler } = require('../src/assembly/group-assembler');

const folderOf = (id) => String(id).split(/[\\/]/)[0];
const REQUIRED = ['passport', 'receipt', 'flight'];

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phase0-output', 'records.json'), 'utf8'));

// 按客户(文件夹)分桶，赋予合成 sender + ts
const byFolder = new Map();
for (const r of data.records) {
  const f = folderOf(r.id);
  if (!byFolder.has(f)) byFolder.set(f, []);
  byFolder.get(f).push(r);
}
const folders = [...byFolder.keys()];
const AGENTS = 5;
const events = [];
folders.forEach((f, i) => {
  const sender = `agent${i % AGENTS}`;
  const base = i * 8 * 60 * 1000; // 客户间隔 8 分钟
  byFolder.get(f).forEach((r, j) => {
    events.push({ ...r, sender, ts: base + j * 20 * 1000 }); // 同客户图间隔 20 秒
  });
});

// 真值：每个文件夹源头三类是否齐全(上限)
const have3 = folders.filter((f) => {
  const types = new Set(byFolder.get(f).map((r) => r.type));
  return REQUIRED.every((t) => types.has(t));
});

const { groups, complete, incomplete, unassigned } = createGroupAssembler().assemble(events);

// 完整且正确 = 组内全是同一客户(纯净) 且 三类齐全
let completeCorrect = 0;
for (const g of complete) {
  const fset = new Set(g.recordIds.map(folderOf));
  if (fset.size === 1) completeCorrect += 1;
}

console.log('===== 发送上下文模拟(合成时间线) =====');
console.log(`客户数 ${folders.length} | 三类齐全(上限) ${have3.length} | 事件 ${events.length}`);
console.log('');
console.log(`装配出的组 ${groups.length} | 收全 ${complete.length} | 缺件 ${incomplete.length} | 留人工图 ${unassigned.length}`);
console.log(`✅ 完整且正确(护照+小票+航班全齐且纯净): ${completeCorrect}`);
console.log(`   占三类齐全客户: ${((completeCorrect / have3.length) * 100).toFixed(1)}%   (内容归组天花板≈45%)`);
console.log('');
console.log('缺件示例(系统知道缺啥、催谁):');
for (const g of incomplete.slice(0, 5)) {
  console.log(`  ${g.name || g.key}  缺 ${g.missing.join('/')}  → 催 ${g.sender}`);
}
