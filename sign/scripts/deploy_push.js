'use strict';
/**
 * 推送式部署（本地构建 → 上传 → 服务器激活）。在本地 sign/ 目录运行。
 *
 * 为什么是推送式而不是服务器 git pull：
 *   服务器到 GitHub 的网络不稳（曾出现连不上），git 流程会卡死部署。
 *   本地构建好、只把「代码 + 构建产物」推上去，服务器不碰 GitHub，最稳。
 *
 * 流程：
 *   1. 本地 vite build 出 dist
 *   2. git archive HEAD 打包「已跟踪代码」（天然不含本地测试数据 / tmp / .env）
 *      另打 overlay 包放 gitignore 掉的 dist + 服务器脚本
 *   3. 上传 source.tar.gz + overlay.tar.gz + server_activate.sh 到服务器 /tmp
 *   4. 服务器跑 server_activate.sh <sha> <source> <overlay>：解压新 release → 复用 node_modules
 *      → 软链 models/storage → 沿用 .env → 原子切 /opt/sign-workbench → pm2 重启
 *      → readyz 验 → 清理旧 release（留 3 个）
 *   5. 本地校验 readyz、清理临时包
 *
 * 配置（不落到被 git 跟踪的文件，避免泄露 IP / 密码）：
 *   tmp/.sshpass      —— SSH 密码（整个 tmp/ 已 gitignore）
 *   tmp/deploy.env    —— DEPLOY_HOST / DEPLOY_USER / DEPLOY_PORT（每行 KEY=VAL）
 *   也可用同名环境变量覆盖；SSHPASS 环境变量优先于 tmp/.sshpass
 *
 * 用法：
 *   node scripts/deploy_push.js              # 部署当前 HEAD
 *   node scripts/deploy_push.js --no-build   # 跳过 vite build（dist 已是最新）
 *   node scripts/deploy_push.js --dry-run    # 只打包，不上传不激活
 *   node scripts/deploy_push.js --allow-dirty # 允许已跟踪文件未提交，并把这些改动放进 overlay
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const argv = process.argv.slice(2);
const NO_BUILD = argv.includes('--no-build');
const SKIP_E2E = argv.includes('--skip-e2e');
const DRY_RUN = argv.includes('--dry-run');
const ALLOW_DIRTY = argv.includes('--allow-dirty');

const PRODUCTION_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'passport_review_workbench.js',
  'workbench_server.js',
  'ecosystem.config.cjs',
  'ecosystem.2c4g.config.cjs',
  '.env.example',
  '.env.2c4g.example',
  '.env.2gb-no-ocr.example',
  'config',
  'jobs',
  'lib',
  'repositories',
  'routes',
  'server',
  'services',
  'passport_review_workbench/templates',
  'paddleocr_standalone/run_document_ocr_batch.py',
  'paddleocr_standalone/run_passport_ocr.py',
  'scripts/backup_sqlite.js',
  'scripts/check-server.sh',
  'scripts/deploy.sh',
  'scripts/manage_users.js',
  // 代理工作台V2 运维脚本(读模型重建/旧回发迁移,灰度与自愈都要用)
  'scripts/migrate_sendback_queue.js',
  'scripts/rebuild_agent_workspace_projection.js',
  'scripts/seed_factory_config.js', // 配置台出厂seed(幂等;2026-07-14 首次部署时漏白名单靠putfile救,别再漏)
  'scripts/python_pool_worker.py',
  'scripts/reset_monthly_db.sh',
  'scripts/restore_backup.js',
  'scripts/rollback.sh',
  'scripts/run_paddlex_model.py',
  'scripts/server_activate.sh',
  'scripts/server_rollback.sh',
  'scripts/setup-server.sh',
]);

const OVERLAY_PATHS = Object.freeze([
  'passport_review_workbench/app/dist',
  'scripts/deploy.sh',
  'scripts/rollback.sh',
  'scripts/server_activate.sh',
  'scripts/server_rollback.sh',
]);

function log(...a) {
  console.log(`[deploy ${new Date().toISOString().slice(11, 19)}]`, ...a);
}
function die(msg) {
  console.error(`[deploy] ERROR: ${msg}`);
  process.exit(1);
}

function loadDeployEnv() {
  const cfg = { DEPLOY_HOST: '', DEPLOY_USER: 'ubuntu', DEPLOY_PORT: '22' };
  const f = path.join(TMP, 'deploy.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) cfg[m[1]] = m[2];
    }
  }
  for (const k of Object.keys(cfg)) if (process.env[k]) cfg[k] = process.env[k];
  if (!cfg.DEPLOY_HOST) die('DEPLOY_HOST 未配置（tmp/deploy.env 或环境变量）');
  return cfg;
}

function loadPass() {
  if (process.env.SSHPASS) return process.env.SSHPASS;
  const f = path.join(TMP, '.sshpass');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  die('SSH 密码缺失：设 SSHPASS 或建 tmp/.sshpass');
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], ...opts })
    .toString()
    .trim();
}

function gitLines(args) {
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function hasTrackedPathAtHead(pathspec) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', pathspec], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return Boolean(out);
}

function productionArchivePaths() {
  return PRODUCTION_PATHS.filter(hasTrackedPathAtHead);
}

function isProductionPath(file) {
  const normalized = String(file || '').replaceAll('\\', '/');
  return PRODUCTION_PATHS.some((pathspec) => {
    if (normalized === pathspec) return true;
    return normalized.startsWith(`${pathspec.replace(/\/$/, '')}/`);
  });
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function gzipFile(src, dst) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dst)
  );
  fs.unlinkSync(src);
}

// ── ssh2 helpers ──────────────────────────────────────────
function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream
        .on('close', (code) => resolve({ code: code || 0, out }))
        .on('data', (d) => {
          out += d;
          process.stdout.write(d);
        })
        .stderr.on('data', (d) => {
          out += d;
          process.stdout.write(d);
        });
    });
  });
}
function sshPut(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(localPath).size;
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const read = fs.createReadStream(localPath);
      const write = sftp.createWriteStream(remotePath, { mode: 0o600 });
      read.on('error', reject);
      write.on('error', reject);
      write.on('close', () => resolve(size));
      read.pipe(write);
    });
  });
}
function connect(cfg, password) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c))
      .on('error', reject)
      .connect({
        host: cfg.DEPLOY_HOST,
        port: Number(cfg.DEPLOY_PORT) || 22,
        username: cfg.DEPLOY_USER,
        password,
        readyTimeout: 25000,
      });
  });
}

async function main() {
  // 0. 前置检查
  const sha = sh('git rev-parse --short HEAD');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  const trackedDirty = sh('git status --porcelain --untracked-files=no');
  if (trackedDirty && !ALLOW_DIRTY) {
    console.error(trackedDirty.split('\n').slice(0, 20).join('\n'));
    die('工作区有已跟踪文件未提交。先提交/暂存，或明确加 --allow-dirty。');
  }
  const deletedFiles = trackedDirty ? gitLines(['diff', '--name-only', '--diff-filter=D', 'HEAD', '--']) : [];
  const deletedProductionFiles = deletedFiles.filter(isProductionPath);
  if (deletedProductionFiles.length) {
    die(
      `--allow-dirty does not support uncommitted production file deletions. Commit first: ${deletedProductionFiles
        .slice(0, 5)
        .join(', ')}${deletedProductionFiles.length > 5 ? '...' : ''}`
    );
  }
  const dirtyFiles = trackedDirty ? gitLines(['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD', '--']) : [];
  const deployableDirtyFiles = dirtyFiles.filter(isProductionPath);
  const skippedDirtyFiles = dirtyFiles.filter((file) => !isProductionPath(file));
  if (trackedDirty) {
    log(`--allow-dirty 已启用：source.tar.gz 打包 HEAD，${deployableDirtyFiles.length} 个生产文件会进 overlay 覆盖`);
    if (skippedDirtyFiles.length) {
      log(`跳过 ${skippedDirtyFiles.length} 个非生产脏文件: ${skippedDirtyFiles.slice(0, 5).join(', ')}${skippedDirtyFiles.length > 5 ? '...' : ''}`);
    }
  }
  const untrackedCount = sh('git status --porcelain --untracked-files=all')
    .split('\n')
    .filter((line) => line.startsWith('?? ')).length;
  if (untrackedCount) {
    log(`检测到 ${untrackedCount} 个未跟踪文件；除 overlay 白名单外，不会进入 source.tar.gz`);
  }
  log(`部署目标: ${branch}@${sha}`);

  fs.mkdirSync(TMP, { recursive: true });
  const sourceGzPath = path.join(TMP, `_deploy-${sha}-source.tar.gz`);
  const overlayTarPath = path.join(TMP, `_deploy-${sha}-overlay.tar`);
  const overlayGzPath = `${overlayTarPath}.gz`;
  const legacyTarPath = path.join(TMP, `_deploy-${sha}.tar`);
  const legacyGzPath = `${legacyTarPath}.gz`;
  for (const p of [sourceGzPath, overlayTarPath, overlayGzPath, legacyTarPath, legacyGzPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 1. 构建前端
  if (NO_BUILD) {
    log('跳过 vite build (--no-build)');
  } else {
    log('vite build 前端...');
    execSync('npm --prefix frontend run build', { cwd: ROOT, stdio: 'inherit' });
  }

  // E2E 部署门禁(#4,2026-07-14):本地起真服务跑关键流,红了不许上线。
  // 紧急旁路 --skip-e2e(事后必须补跑门禁并记录原因)。
  if (SKIP_E2E) {
    log('⚠⚠ 已跳过 E2E 门禁(--skip-e2e)——紧急通道,上线后必须补跑 node scripts/e2e_gate.js');
  } else {
    log('E2E 门禁:node scripts/e2e_gate.js(约1-2分钟;失败即中止部署)');
    execSync('node scripts/e2e_gate.js', { stdio: 'inherit', cwd: ROOT });
    log('E2E 门禁通过 ✅');
  }
  const distDir = path.join(ROOT, 'passport_review_workbench', 'app', 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) die('构建产物缺失: passport_review_workbench/app/dist/index.html');

  // 2. 打包：已跟踪代码 + overlay
  // 不用 tar -r 追加到 git archive：Windows bsdtar 遇到 git archive
  // 里的 UTF-8 中文路径时会出现内容异常。拆成 source + overlay 两包更稳。
  const sourcePaths = productionArchivePaths();
  if (!sourcePaths.length) die('生产白名单没有匹配到任何已跟踪文件');
  log(`git archive 生产白名单(${sourcePaths.length} 项) → source.tar.gz`);
  execFileSync('git', ['archive', '--format=tar.gz', '-o', sourceGzPath, 'HEAD', '--', ...sourcePaths], { cwd: ROOT });
  log('构建产物 dist + 部署脚本 → overlay.tar.gz');
  // -f 用相对 ROOT 的路径:绝对路径含盘符(D:\)会被 GNU tar 误判为远程主机
  // ("Cannot connect to D:")。相对路径对 GNU tar 和 bsdtar 都安全。
  const overlayTarRel = path.relative(ROOT, overlayTarPath);
  const overlayPaths = uniquePaths([...OVERLAY_PATHS, ...deployableDirtyFiles]);
  execFileSync('tar', [
    '-cf',
    overlayTarRel,
    ...overlayPaths,
  ], { cwd: ROOT });
  await gzipFile(overlayTarPath, overlayGzPath);
  const sourceMb = (fs.statSync(sourceGzPath).size / 1048576).toFixed(1);
  const overlayMb = (fs.statSync(overlayGzPath).size / 1048576).toFixed(1);
  log(`打包完成: ${path.basename(sourceGzPath)} (${sourceMb} MB), ${path.basename(overlayGzPath)} (${overlayMb} MB)`);

  if (DRY_RUN) {
    log(`--dry-run：到此为止，未上传。包在 ${sourceGzPath} 和 ${overlayGzPath}`);
    return;
  }

  // 3. 上传 + 激活
  const cfg = loadDeployEnv();
  const password = loadPass();
  log(`连接 ${cfg.DEPLOY_USER}@${cfg.DEPLOY_HOST}:${cfg.DEPLOY_PORT}`);
  const conn = await connect(cfg, password);
  try {
    const remoteSource = `/tmp/sign-deploy-${sha}-source.tar.gz`;
    const remoteOverlay = `/tmp/sign-deploy-${sha}-overlay.tar.gz`;
    const remoteScript = `/tmp/server_activate.sh`;
    log('上传源码包...');
    const sourceBytes = await sshPut(conn, sourceGzPath, remoteSource);
    log(`源码包上传完成 ${(sourceBytes / 1048576).toFixed(1)} MB`);
    log('上传 overlay 包...');
    const overlayBytes = await sshPut(conn, overlayGzPath, remoteOverlay);
    log(`overlay 上传完成 ${(overlayBytes / 1048576).toFixed(1)} MB`);
    log('上传激活脚本...');
    await sshPut(conn, path.join(ROOT, 'scripts', 'server_activate.sh'), remoteScript);

    log('服务器激活...');
    const { code } = await sshExec(conn, `bash ${remoteScript} ${sha} ${remoteSource} ${remoteOverlay}`);
    if (code !== 0) die(`激活失败 (exit ${code})，可在服务器跑 scripts/server_rollback.sh 回滚`);
    log(`✅ 部署成功: ${branch}@${sha}`);
  } finally {
    conn.end();
    for (const p of [sourceGzPath, overlayGzPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
}

main().catch((e) => die(e.stack || e.message));
