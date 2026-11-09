'use strict';

// 多模型对比：同一批客户文件夹，分别用不同 Qwen-VL 模型跑 Phase 0，
// 输出每个模型的分组准确率 + token 用量，便于选型。
// 运行：node --env-file=.env scripts/compare-models.js

const { runPhase0 } = require('./run-phase0-validation');
const { createQwenExtractor } = require('../src/understanding/extractor');

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const sampleDir = process.env.PHASE0_SAMPLE_DIR;
  const maxFolders = Number(process.env.PHASE0_MAX_FOLDERS || 8);
  const models = (process.env.PHASE0_MODELS || 'qwen-vl-max,qwen-vl-plus')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if (!process.env.DASHSCOPE_API_KEY) {
    console.error('未配置 DASHSCOPE_API_KEY。');
    process.exit(1);
  }

  console.log(`样本目录: ${sampleDir}`);
  console.log(`文件夹数: ${maxFolders}  对比模型: ${models.join(', ')}\n`);

  const rows = [];
  for (const model of models) {
    process.stdout.write(`\n>>> 模型 ${model}\n`);
    const extractor = createQwenExtractor({ model });
    const t0 = Date.now();
    let report;
    try {
      report = await runPhase0({
        sampleDir,
        maxFolders,
        extractor,
        onProgress: (f, n) => process.stdout.write(`  · ${f} (${n} 图)\n`),
      });
    } catch (err) {
      console.error(`  模型 ${model} 整体失败: ${err.message}`);
      rows.push({ model, failed: err.message });
      continue;
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(0);
    rows.push({ model, report, seconds });
  }

  console.log('\n\n================ 多模型对比 ================');
  console.log(
    ['模型', 'F1', 'precision', 'recall', '覆盖率', '簇', '待人工', '错误', 'tokens', '耗时'].join('\t')
  );
  for (const row of rows) {
    if (row.failed) {
      console.log(`${row.model}\t整体失败: ${row.failed}`);
      continue;
    }
    const m = row.report.metrics;
    const u = row.report.usage;
    console.log(
      [
        row.model,
        pct(m.f1),
        pct(m.precision),
        pct(m.recall),
        pct(m.coverage),
        row.report.clusters,
        row.report.unassigned,
        row.report.errors,
        u ? u.totalTokens : '-',
        `${row.seconds}s`,
      ].join('\t')
    );
  }
  console.log('\n类型分布(最后一个模型):', JSON.stringify(rows.at(-1)?.report?.typeCounts || {}));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
