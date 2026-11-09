'use strict';

// Phase 0 离线验证 runner（见 docs/01 §六）。
// 流程：遍历 385 客户文件夹 → 对每张图抽取字段 → 按护照号归组 →
//        与文件夹真值对比 → 输出分组准确率 / 字段命中 / token 成本。
//
// 运行：先 `npm install`，配置 .env（DASHSCOPE_API_KEY 等），再 `npm run phase0`。
// 真实抽取需 API key；无 key 时本脚本会提示并退出（核心算法已在 tests/ 中独立验证）。
//
// 安全：护照为敏感 PII，仅发往国内合规模型，绝不出境（见 docs/04）。

const fs = require('node:fs');
const path = require('node:path');

const { createGroupingEngine } = require('../src/grouping/grouping-engine');
const { score } = require('../src/scoring/group-scorer');
const { createQwenExtractor } = require('../src/understanding/extractor');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function listCustomerFolders(sampleDir, maxFolders) {
  const entries = fs
    .readdirSync(sampleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  return maxFolders > 0 ? entries.slice(0, maxFolders) : entries;
}

function listImages(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(folderPath, f));
}

// 构建抽取记录 + 真值映射；extractor 可注入（测试/mock）
async function buildRecordsAndTruth({ sampleDir, folders, extractor, onProgress, checkpointPath, seed }) {
  const records = seed?.records ? [...seed.records] : [];
  const truthByRecord = seed?.truth ? new Map(seed.truth) : new Map();
  let errors = seed?.errors || 0;
  // 续跑：跳过检查点里已处理过的文件夹
  const done = new Set(records.map((r) => String(r.id).split(/[\\/]/)[0]));

  for (const folder of folders) {
    if (done.has(folder)) continue;
    // 真值组 = 完整文件夹名（每个文件夹=一个客户，唯一）。
    // 不能用护照尾号(如 EL78)，不同客户会撞号导致真值污染。
    const truthGroupId = folder;
    const images = listImages(path.join(sampleDir, folder));

    for (const imagePath of images) {
      const id = path.relative(sampleDir, imagePath);
      let result;
      try {
        result = await extractor.extractImage(imagePath);
      } catch (err) {
        errors += 1;
        result = { type: 'error', confidence: 0, error: err.message };
      }
      records.push({ id, ...result });
      truthByRecord.set(id, truthGroupId);
    }
    if (onProgress) onProgress(folder, images.length);
    if (checkpointPath) writeCheckpoint(checkpointPath, { records, truthByRecord, extractor, errors });
  }
  return { records, truthByRecord, errors };
}

// 每个文件夹处理完写一次检查点：长跑被中断也保留已完成部分
function writeCheckpoint(checkpointPath, { records, truthByRecord, extractor, errors }) {
  const usage = typeof extractor.getUsage === 'function' ? extractor.getUsage() : null;
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({ records, truth: [...truthByRecord], usage, errors }, null, 2)
  );
}

async function runPhase0({ sampleDir, maxFolders = 0, extractor, onProgress, checkpointPath, seed } = {}) {
  if (!sampleDir || !fs.existsSync(sampleDir)) {
    throw new Error(`样本目录不存在：${sampleDir}（配置 PHASE0_SAMPLE_DIR）`);
  }
  const folders = listCustomerFolders(sampleDir, maxFolders);
  const { records, truthByRecord, errors } = await buildRecordsAndTruth({
    sampleDir,
    folders,
    extractor,
    onProgress,
    checkpointPath,
    seed,
  });

  const { clusters, unassigned } = createGroupingEngine({
    rejectInvalid: true,
    fuzzy: true,
    maxDistance: 2,
    bridgeFlights: true, // 航班图用"航班号+离境日期"精确匹配(date-aware)，唯一时才挂
  }).group(records);
  const metrics = score({ predicted: clusters, truthByRecord });
  const usage = typeof extractor.getUsage === 'function' ? extractor.getUsage() : null;
  const typeCounts = countTypes(records);

  return {
    folders: folders.length,
    records: records.length,
    clusters: clusters.length,
    unassigned: unassigned.length,
    errors: errors || 0,
    metrics,
    usage,
    typeCounts,
    data: { records, truth: [...truthByRecord] },
  };
}

// 估算成本（qwen-vl-max 优惠价：输入 2.4 / 输出 9.6 元每百万 token）
function estimateCostCNY(usage, inputPerM = 2.4, outputPerM = 9.6) {
  if (!usage) return 0;
  return (usage.promptTokens * inputPerM + usage.completionTokens * outputPerM) / 1e6;
}

function countTypes(records) {
  const counts = {};
  for (const r of records) counts[r.type] = (counts[r.type] || 0) + 1;
  return counts;
}

async function main() {
  const sampleDir = process.env.PHASE0_SAMPLE_DIR;
  const maxFolders = Number(process.env.PHASE0_MAX_FOLDERS || 0);

  if (!process.env.DASHSCOPE_API_KEY) {
    console.error('未配置 DASHSCOPE_API_KEY。请复制 .env.example 为 .env 并填写后重试。');
    console.error('（纯算法核心已在 tests/ 中独立验证，可先 `npm test`。）');
    process.exit(1);
  }

  const outputDir = process.env.PHASE0_OUTPUT_DIR || './phase0-output';
  fs.mkdirSync(outputDir, { recursive: true });
  const checkpointPath = path.join(outputDir, 'records.json');

  // 续跑：若已有检查点，作为种子接着跑（跳过已完成文件夹）
  let seed = null;
  if (fs.existsSync(checkpointPath)) {
    const prev = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    seed = { records: prev.records || [], truth: prev.truth || [], errors: prev.errors || 0 };
    console.log(`续跑：已有 ${seed.records.length} 图，跳过已完成文件夹\n`);
  }

  const t0 = Date.now();
  const extractor = createQwenExtractor();
  const report = await runPhase0({
    sampleDir,
    maxFolders,
    extractor,
    checkpointPath,
    seed,
    onProgress: (f, n) => process.stdout.write(`  · ${f} (${n} 图)\n`),
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'records.json'),
    JSON.stringify({ ...report.data, usage: report.usage, errors: report.errors }, null, 2)
  );

  const cost = estimateCostCNY(report.usage);
  console.log('\n===== Phase 0 验证报告 =====');
  console.log(`文件夹: ${report.folders}  图片: ${report.records}  归组簇: ${report.clusters}  待人工: ${report.unassigned}  错误: ${report.errors}`);
  console.log(`分组 precision: ${(report.metrics.precision * 100).toFixed(1)}%`);
  console.log(`分组 recall:    ${(report.metrics.recall * 100).toFixed(1)}%`);
  console.log(`分组 F1:        ${(report.metrics.f1 * 100).toFixed(1)}%`);
  console.log(`覆盖率:         ${(report.metrics.coverage * 100).toFixed(1)}%`);
  console.log(`类型分布:       ${JSON.stringify(report.typeCounts)}`);
  if (report.usage) {
    console.log(`tokens:         ${report.usage.totalTokens} (调用 ${report.usage.calls} 次)  估算成本: ¥${cost.toFixed(3)}`);
  }
  console.log(`耗时:           ${seconds}s   记录已存: ${path.join(outputDir, 'records.json')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runPhase0, buildRecordsAndTruth, listCustomerFolders };
