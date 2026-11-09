'use strict';

/**
 * upload_training_datasets.js - 把构建好的训练数据集上传到 AI Studio 数据集仓库
 *
 * 用 AI Studio CLI(平台「CLI上传(推荐)」方式):
 *   aistudio upload <repoId> <本地目录> <远端目录>/ --repo-type dataset --token <TOKEN>
 *
 * repo 映射(用户在平台建的 6 个数据集):
 *   1_mix_det → JINHAIMIN/1   2_cls → JINHAIMIN/2   3_passport_det → JINHAIMIN/3
 *   4_passport_rec → JINHAIMIN/4   5_receipt_det → JINHAIMIN/5   6_receipt_rec → JINHAIMIN/6
 *
 * Token 从 env AISTUDIO_TOKEN 读(放 .env,不要写进代码/提交)。
 * 远端目录用本次构建的 stamp,同一数据集多次上传按批次目录累积,不覆盖历史。
 *
 * 用法:
 *   node scripts/upload_training_datasets.js --dir <build输出根目录> [--only 1,2,4] [--repo-prefix JINHAIMIN]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DATASET_REPO = Object.freeze({
  '1_mix_det': '1',
  '2_cls': '2',
  '3_passport_det': '3',
  '4_passport_rec': '4',
  '5_receipt_det': '5',
  '6_receipt_rec': '6',
});

function parseArgs(argv) {
  const args = { dir: '', only: '', repoPrefix: 'JINHAIMIN' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--dir') args.dir = next();
    else if (a === '--only') args.only = next();
    else if (a === '--repo-prefix') args.repoPrefix = next();
  }
  return args;
}

function resolveAistudioCli() {
  if (process.env.AISTUDIO_CLI && fs.existsSync(process.env.AISTUDIO_CLI)) return process.env.AISTUDIO_CLI;
  // Windows 上 pip 装的 aistudio.exe 常不在 PATH,探测常见 Python Scripts 位置
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || '';
    const candidates = [
      path.join(home, 'AppData/Local/Programs/Python/Python310/Scripts/aistudio.exe'),
      path.join(home, 'AppData/Local/Programs/Python/Python311/Scripts/aistudio.exe'),
      path.join(home, 'AppData/Local/Programs/Python/Python312/Scripts/aistudio.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'aistudio'; // 交给 PATH(Linux 服务器 pip 装在 ~/.local/bin 通常在 PATH)
}

function runAistudio(cliArgs) {
  // 参数全部数组传递,无注入面。PYTHONIOENCODING=utf-8:SDK 打印 ✅ emoji 在
  // Windows GBK 控制台会 UnicodeEncodeError(上传已成功但进程崩),强制 utf-8 规避。
  const res = spawnSync(resolveAistudioCli(), cliArgs, {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return {
    ok: !res.error && res.status === 0,
    code: res.status,
    out: `${res.stdout || ''}${res.stderr || ''}`.trim(),
    error: res.error ? res.error.message : null,
  };
}

async function uploadAll(args) {
  const token = process.env.AISTUDIO_TOKEN || process.env.SIGN_AISTUDIO_TOKEN || '';
  if (!token) {
    throw new Error('AISTUDIO_TOKEN 未配置(放 .env:AISTUDIO_TOKEN=你的AccessToken,在 AI Studio 控制台-令牌 获取)');
  }
  if (!args.dir || !fs.existsSync(args.dir)) {
    throw new Error(`--dir 构建目录不存在: ${args.dir}`);
  }
  const stamp = path.basename(args.dir).replace(/^feijiang_/, '') || 'batch';
  const onlySet = args.only
    ? new Set(String(args.only).split(',').map((s) => s.trim()))
    : null;

  const results = [];
  for (const [dsName, repoNum] of Object.entries(DATASET_REPO)) {
    if (onlySet && !onlySet.has(repoNum) && !onlySet.has(dsName)) continue;
    const localDir = path.join(args.dir, dsName);
    if (!fs.existsSync(localDir)) {
      results.push({ dataset: dsName, repo: `${args.repoPrefix}/${repoNum}`, skipped: 'local dir missing' });
      continue;
    }
    // 空数据集(没产出样本)跳过,别往平台传空壳
    const hasContent = fs.readdirSync(localDir).length > 0;
    if (!hasContent) {
      results.push({ dataset: dsName, repo: `${args.repoPrefix}/${repoNum}`, skipped: 'empty' });
      continue;
    }
    const repoId = `${args.repoPrefix}/${repoNum}`;
    const remoteDir = `data/${stamp}/`;
    const r = runAistudio([
      'upload', repoId, localDir, remoteDir,
      '--repo-type', 'dataset', '--token', token,
    ]);
    results.push({
      dataset: dsName, repo: repoId, remote: remoteDir,
      ok: r.ok, code: r.code,
      // 输出截断防日志爆炸;token 不会出现在输出里
      detail: r.out.slice(-500), error: r.error,
    });
    if (!r.ok) break; // 一个失败就停,避免半上传状态难排查
  }
  return { dir: args.dir, stamp, results };
}

module.exports = { uploadAll, DATASET_REPO };

if (require.main === module) {
  uploadAll(parseArgs(process.argv))
    .then((s) => {
      console.log(JSON.stringify(s, null, 2));
      if (s.results.some((r) => r.ok === false)) process.exit(1);
    })
    .catch((err) => {
      console.error('upload_training_datasets failed:', err.message);
      process.exit(1);
    });
}
