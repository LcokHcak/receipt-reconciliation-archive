'use strict';

/**
 * compress_stock_images — 存量图片回填压缩(提速②,2026-07-06)。
 *
 * 背景:入库压缩(lib/heic_normalize)2026-07-04 才上线,之前上传的原图和切图产物
 * 还是手机原片体积(3-6MB/4000px+),硬链接进批次后审核台切一张图要拖几 MB,加载慢。
 * 本脚本把存量 images 目录里的大 jpg 原地重编码成与入库压缩同参(长边2400/q82)。
 *
 * 硬链接安全:批次图与客户库图共享 inode(customer_batch_bridge.linkOrCopyImage)。
 * 替换用「写临时文件 → rename 换名」= 新 inode,只换当前这个目录项;另一个名字
 * (客户库/批次的另一侧)保持旧内容不受影响 → 想两侧都小就两个根都跑(默认就是)。
 * ⚠️ 绝不能以"打开原文件覆写"的方式压缩——那会穿透硬链接改掉两侧。
 *
 * 安全阀:
 *   - 默认 dry-run,只报告不动文件;加 --apply 才真压。
 *   - 原文件先 rename 进备份目录(保留原 inode/字节),manifest.jsonl 记账。
 *   - 压完不小于原文件 → 保留原文件。
 *   - 只处理 images 目录下的 .jpg/.jpeg;png/其他跳过(改扩展名会断 task/sidecar 路径引用)。
 *   - 串行 + 每张间歇,低峰跑不冲服务器。
 *   - --rollback <备份目录> 按 manifest 整批还原。
 *
 * 用法(服务器上):
 *   node scripts/compress_stock_images.js                    # dry-run,扫默认两根
 *   node scripts/compress_stock_images.js --apply            # 真压
 *   node scripts/compress_stock_images.js --apply --limit 50 # 先小批验证
 *   node scripts/compress_stock_images.js --rollback <dir>   # 回滚
 */

const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');

const {
  COMPRESS_JPEG_QUALITY,
  COMPRESS_MAX_SIDE,
  COMPRESS_MIN_BYTES,
} = require('../lib/heic_normalize');

const projectRoot = path.resolve(__dirname, '..');
const storageRoot = path.join(projectRoot, 'passport_review_workbench', 'storage');

function parseArgs(argv) {
  const args = {
    apply: false,
    rollback: '',
    limit: 0,
    minBytes: COMPRESS_MIN_BYTES,
    maxSide: COMPRESS_MAX_SIDE,
    quality: COMPRESS_JPEG_QUALITY,
    sleepMs: 50,
    roots: [],
    backupDir: '',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--rollback') args.rollback = String(argv[++i] || '');
    else if (a === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (a === '--min-bytes') args.minBytes = Number(argv[++i]) || args.minBytes;
    else if (a === '--max-side') args.maxSide = Number(argv[++i]) || args.maxSide;
    else if (a === '--quality') args.quality = Number(argv[++i]) || args.quality;
    else if (a === '--sleep-ms') args.sleepMs = Number(argv[++i]) || 0;
    else if (a === '--root') args.roots.push(String(argv[++i] || ''));
    else if (a === '--backup-dir') args.backupDir = String(argv[++i] || '');
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

// 客户库活动根:与 customer_library_repository.getActiveRoot 同口径(settings.activeRoot 优先)
function resolveLibraryRoot() {
  const settingsPath = path.join(storageRoot, 'customer_library.settings.json');
  const defaultRoot = path.join(storageRoot, 'customer_library');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return path.resolve(settings.activeRoot || defaultRoot);
  } catch {
    return defaultRoot;
  }
}

function defaultRoots() {
  return [path.join(storageRoot, 'batches'), resolveLibraryRoot()];
}

// 递归收集 root 下所有 images 目录里的 jpg(跳过备份目录本身)
function collectJpegs(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (/backup/i.test(entry.name) || entry.name === 'tmp_uploads') continue;
      collectJpegs(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.cmp~')) {
      // 上次被打断留下的临时文件:必为垃圾,顺手清掉(防在客户库目录里被误当真图)
      try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
    } else if (
      entry.isFile()
      && /\.jpe?g$/i.test(entry.name)
      && path.basename(path.dirname(full)) === 'images'
    ) {
      out.push(full);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
}

async function compressOne(file, args, backupPath, manifestPath) {
  const before = fs.statSync(file).size;
  if (before <= args.minBytes) return { status: 'small' };

  const tmp = `${file}.cmp~`;
  try {
    // rotate() 把 EXIF 方向烘进像素(老切片可能带方向标记,压缩后不能横躺)
    await sharp(file)
      .rotate()
      .resize({ width: args.maxSide, height: args.maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: args.quality, mozjpeg: true })
      .toFile(tmp);
    const after = fs.statSync(tmp).size;
    if (after >= before) {
      fs.rmSync(tmp, { force: true });
      return { status: 'kept', before, after };
    }
    if (!args.apply) {
      fs.rmSync(tmp, { force: true });
      return { status: 'would_compress', before, after };
    }
    // ⚠️ 先记 manifest 再换名(审查意见):若在两次 rename 之间被杀,备份已落而账没记
    // 就永远回滚不到。先记账 → 崩溃后回滚要么"备份缺失跳过"(文件还是原件),
    // 要么按账还原,没有孤儿备份。
    fs.appendFileSync(manifestPath, `${JSON.stringify({
      file, backup: backupPath, before, after, ts: new Date().toISOString(),
    })}\n`);
    // 原文件 rename 进备份(保留原 inode;硬链接另一侧名字不受影响),tmp 换正名
    moveFile(file, backupPath);
    fs.renameSync(tmp, file);
    return { status: 'compressed', before, after };
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { status: 'error', error: String(error?.message || error) };
  }
}

async function runCompress(args) {
  const roots = (args.roots.length ? args.roots : defaultRoots())
    .map((r) => path.resolve(r))
    .filter((r) => fs.existsSync(r));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const backupRoot = path.resolve(args.backupDir || path.join(storageRoot, 'backups', `compress_${stamp}`));
  const manifestPath = path.join(backupRoot, 'manifest.jsonl');
  if (args.apply) fs.mkdirSync(backupRoot, { recursive: true });

  console.log(`模式: ${args.apply ? 'APPLY(真压)' : 'DRY-RUN(只报告)'}  参数: 长边${args.maxSide}/q${args.quality}/阈值${(args.minBytes / 1024 / 1024).toFixed(1)}MB`);
  console.log(`扫描根:\n${roots.map((r) => `  - ${r}`).join('\n')}`);
  if (args.apply) console.log(`备份目录: ${backupRoot}`);

  // 备份路径按"相对各自扫描根"镜像(根可能在项目外,如 /data 新盘)
  const files = roots.flatMap((root, rootIndex) => collectJpegs(root).map((file) => ({
    file,
    backupPath: path.join(backupRoot, `root${rootIndex}`, path.relative(root, file)),
  })));
  console.log(`共找到 images 目录下 jpg ${files.length} 张`);

  const stats = { small: 0, kept: 0, compressed: 0, would_compress: 0, error: 0, savedBytes: 0 };
  let processed = 0;
  for (const { file, backupPath } of files) {
    const r = await compressOne(file, args, backupPath, manifestPath);
    stats[r.status] = (stats[r.status] || 0) + 1;
    if (r.status === 'compressed' || r.status === 'would_compress') {
      stats.savedBytes += (r.before - r.after);
      processed += 1;
      if (processed <= 10 || processed % 100 === 0) {
        console.log(`  [${r.status}] ${(r.before / 1048576).toFixed(1)}MB → ${(r.after / 1048576).toFixed(2)}MB  ${file}`);
      }
      if (args.limit && processed >= args.limit) {
        console.log(`达到 --limit ${args.limit},停止`);
        break;
      }
      if (args.sleepMs) await sleep(args.sleepMs);
    } else if (r.status === 'error') {
      console.warn(`  [error] ${file}: ${r.error}`);
    }
  }

  console.log('\n汇总:');
  console.log(`  阈值内跳过: ${stats.small}  压不小保留: ${stats.kept}  失败: ${stats.error}`);
  console.log(`  ${args.apply ? '已压缩' : '将压缩'}: ${args.apply ? stats.compressed : stats.would_compress} 张, 省 ${(stats.savedBytes / 1048576).toFixed(0)} MB`);
  if (!args.apply) console.log('\ndry-run 完成。确认无误后加 --apply 执行(建议先 --apply --limit 50 小批验证)。');
  else console.log(`\n回滚: node scripts/compress_stock_images.js --rollback "${backupRoot}"`);
}

function runRollback(backupRoot) {
  const manifestPath = path.join(path.resolve(backupRoot), 'manifest.jsonl');
  if (!fs.existsSync(manifestPath)) {
    console.error(`找不到 manifest: ${manifestPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  let restored = 0;
  let missing = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!fs.existsSync(entry.backup)) { missing += 1; continue; }
      moveFile(entry.backup, entry.file);
      restored += 1;
    } catch (error) {
      console.warn(`  还原失败: ${String(error?.message || error)}`);
    }
  }
  console.log(`回滚完成: 还原 ${restored} 张, 备份缺失 ${missing} 张`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.rollback) {
    runRollback(args.rollback);
    return;
  }
  await runCompress(args);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
