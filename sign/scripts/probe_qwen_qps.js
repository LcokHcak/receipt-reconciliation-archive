'use strict';

/**
 * probe_qwen_qps — DashScope 并发承受力实测(提速①前置,2026-07-06)。
 *
 * 背景:识别总并发 ≈ 同时处理的批次数(WORKBENCH_MAX_ACTIVE_BATCHES,默认2;
 * qwen 调用在单批内串行)。把闸调到 4-6 前,先实测账户在该并发下是否限流(429)。
 *
 * 方法:按档位(默认 2,4,6,8)用 runPool 维持"档位数"个在飞请求,每档发 档位×3 个,
 * 统计 429/错误/延迟。测试图是本地生成的 512px 小图 → 单次调用几百 token,
 * 全程 ~60 次调用成本可忽略;小图返回快,**延迟数字不代表真实图片(真实约18s/张),
 * 只看有没有 429**。探测不重试(withRetry 会把 429 藏起来),裸看限流。
 *
 * 用法(服务器上,需 .env 里的 DASHSCOPE_API_KEY/QWEN_BASE_URL):
 *   node --env-file=.env scripts/probe_qwen_qps.js
 *   node --env-file=.env scripts/probe_qwen_qps.js --levels 2,4,6 --per-level 2
 *
 * ⚠️ 只读探测,不写任何业务数据;但会消耗 API 配额(极少)。
 * 结论只是建议值——真正改 .env + pm2 restart 属生产变更,须用户批准后另行执行。
 */

const sharp = require('sharp');

const { analyzeImage } = require('../lib/qwen_ocr/qwen_client');
const { runPool } = require('../lib/qwen_ocr/concurrency_pool');

const apiKey = process.env.DASHSCOPE_API_KEY;
const baseUrl = process.env.QWEN_BASE_URL;
const model = process.env.QWEN_OCR_MODEL || 'qwen-vl-max';

function parseArgs(argv) {
  const args = { levels: [2, 4, 6, 8], perLevel: 3, pauseMs: 3000 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--levels') {
      args.levels = String(argv[++i] || '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
    } else if (a === '--per-level') args.perLevel = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--pause-ms') args.pauseMs = Number(argv[++i]) || 0;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function makeProbeImageBase64() {
  // 512px 灰底 + 一块白矩形:内容无关紧要(通常返回 documents:[]),只为走完真实调用链
  const buf = await sharp({
    create: { width: 512, height: 384, channels: 3, background: { r: 220, g: 220, b: 220 } },
  })
    .composite([{
      input: { create: { width: 200, height: 260, channels: 3, background: { r: 255, g: 255, b: 255 } } },
      left: 150,
      top: 60,
    }])
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function probeLevel(level, perLevel, imageBase64Url) {
  const total = level * perLevel;
  const results = await runPool(
    Array.from({ length: total }, (_, i) => i),
    level,
    async () => {
      const started = Date.now();
      try {
        await analyzeImage({ imageBase64Url, apiKey, baseUrl, model, timeoutMs: 60000 });
        return { ok: true, ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - started,
          status: error?.status ?? null,
          retryAfterMs: error?.retryAfterMs ?? null,
          message: String(error?.message || error).slice(0, 120),
        };
      }
    }
  );

  const okTimes = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const rate429 = results.filter((r) => !r.ok && r.status === 429);
  const otherErr = results.filter((r) => !r.ok && r.status !== 429);
  return { level, total, ok: okTimes.length, rate429, otherErr, okTimes };
}

async function main() {
  if (!apiKey || !baseUrl) {
    console.error('缺少 DASHSCOPE_API_KEY / QWEN_BASE_URL,请用 node --env-file=.env 运行');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  const imageBase64Url = await makeProbeImageBase64();

  console.log(`模型: ${model}  档位: ${args.levels.join('/')}  每档请求数: 档位×${args.perLevel}`);
  console.log('注意: 小图延迟不代表真实图片(真实约18s/张),只看 429。\n');

  const summaries = [];
  for (const level of args.levels) {
    process.stdout.write(`并发 ${level} … `);
    const s = await probeLevel(level, args.perLevel, imageBase64Url);
    summaries.push(s);
    const p50 = percentile(s.okTimes, 50);
    const p95 = percentile(s.okTimes, 95);
    console.log(`成功 ${s.ok}/${s.total}  429×${s.rate429.length}  其他错误×${s.otherErr.length}  p50=${p50}ms p95=${p95}ms`);
    for (const e of s.otherErr.slice(0, 2)) console.log(`    其他错误示例: HTTP ${e.status} ${e.message}`);
    if (s.rate429.length) {
      const ra = s.rate429.find((e) => e.retryAfterMs != null)?.retryAfterMs;
      console.log(`    429 出现${ra != null ? `,Retry-After=${ra}ms` : ''} → 该档已触限`);
    }
    if (level !== args.levels[args.levels.length - 1]) await sleep(args.pauseMs);
  }

  // 建议:无 429 的最高档,封顶 6(再高审核吞吐也跟不上,且给账户留余量)
  const clean = summaries.filter((s) => s.rate429.length === 0 && s.otherErr.length === 0);
  const best = clean.length ? Math.min(6, Math.max(...clean.map((s) => s.level))) : 0;
  console.log('\n════ 结论 ════');
  if (!best) {
    console.log('所有档位都有限流/错误 → 保持 WORKBENCH_MAX_ACTIVE_BATCHES=2,先查账户状态(DashScope 控制台)。');
  } else {
    console.log(`建议 WORKBENCH_MAX_ACTIVE_BATCHES=${best}(实测到并发 ${Math.max(...clean.map((s) => s.level))} 无 429)。`);
    console.log('落地(生产变更,需批准):服务器 .env 加 WORKBENCH_MAX_ACTIVE_BATCHES=' + best + ' 后 pm2 restart sign-workbench --update-env');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
