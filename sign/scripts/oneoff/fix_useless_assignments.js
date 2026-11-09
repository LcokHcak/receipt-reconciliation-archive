'use strict';
// 一次性:清理 eslint no-useless-assignment 存量(33 错清零专项)。
// 全部站点同一形态:`let x = 初值;` 的初值在所有读取路径上都被覆盖
// (try 赋值;catch 要么重赋同值、要么 continue/return)。修法=去初值保留声明
// (`let x;`),行为逐字节等价;逐行白名单精确替换,绝不通配。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SITES = [
  ['jobs/workbench_scheduler.js', 74],
  ['lib/agent_workspace/projection_refresh.js', 19],
  ['repositories/mode_config_repository.js', 93],
  ['routes/config_console_routes.js', 315],
  ['routes/config_console_routes.js', 324],
  ['routes/config_console_routes.js', 615],
  ['routes/config_console_routes.js', 616],
  ['routes/config_console_routes.js', 617],
  ['routes/library_delivery_routes.js', 186],
  ['scripts/migrate_sendback_queue.js', 57],
  ['scripts/oneoff/backfill_dept_upstream_agent.js', 48],
  ['scripts/oneoff/backfill_dept_upstream_agent.js', 63],
  ['scripts/oneoff/backfill_receipt_no_letters.js', 57],
  ['scripts/oneoff/scan_lotte_dept_identity_gap.js', 37],
  ['scripts/recognition_quality_report.js', 170],
  ['scripts/recognition_quality_report.js', 171],
  ['services/customer_batch_bridge_service.js', 154],
  ['services/customer_batch_bridge_service.js', 300],
  ['services/customer_batch_bridge_service.js', 618],
  ['services/customer_document_preprocess_service.js', 394],
  ['services/mode_config_resolver.js', 71],
  ['services/monthly/library_mode_export_service.js', 128],
  ['services/review_config_resolver.js', 136],
  ['services/review_config_resolver.js', 154],
  ['services/workflow_task_coordinator.js', 31],
  ['tests/api_error_middleware.test.js', 32],
  ['tests/config_console_routes.test.js', 60],
  ['tests/config_console_routes.test.js', 285],
  ['tests/delivery_boundary_gaps.test.js', 187],
  ['tests/library_delivery_routes.test.js', 142],
  ['tests/mode_alias_chain_boundary.test.js', 287],
];

const byFile = new Map();
for (const [f, l] of SITES) {
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(l);
}

let fixed = 0;
for (const [rel, lineNos] of byFile) {
  const p = path.join(ROOT, rel);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const n of lineNos) {
    const raw = lines[n - 1];
    // CRLF 文件 split('\n') 后行尾留 \r,而 JS 正则 `.` 不匹配 \r → 先剥再拼回
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const m = line.match(/^(\s*)(let\s+[A-Za-z_$][\w$]*)\s*=\s*[^;]*;(.*)$/);
    if (!m) { console.error(`SKIP(形态不符): ${rel}:${n} → ${line.trim()}`); continue; }
    lines[n - 1] = `${m[1]}${m[2]};${m[3]}${cr}`;
    fixed += 1;
  }
  fs.writeFileSync(p, lines.join('\n'));
}
console.log(`fixed ${fixed}/${SITES.length} sites`);
