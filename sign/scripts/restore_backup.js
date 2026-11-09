#!/usr/bin/env node
/**
 * SQLite + 数据从备份目录恢复。
 *
 * 调用：
 *   node scripts/restore_backup.js --from backups/20260511-031500
 *
 * 工作流：
 *   1. 校验 manifest.json 存在，所有列出文件齐全
 *   2. 在目标路径旁建一个 `.restore-tmp/` 暂存目录
 *   3. 把 SQLite 文件先放进暂存，sha256 与 manifest 对比
 *   4. 备份当前目录的 .sqlite 到 `.before-restore-<stamp>/`，方便回滚
 *   5. 把暂存里的文件 mv 到目标位置（atomic 替换）
 *   6. 图片同样 sync 回 data/
 *
 * 设计取舍：
 *   - 不直接覆盖：先暂存 + sha256 校验再 mv，避免恢复了一个坏文件
 *     却把当前生产文件覆盖掉
 *   - 当前 .sqlite 不删，只 rename，万一恢复出错可以一键还原
 *   - 进程不应该在运行时跑 restore；先 `pm2 stop sign-workbench`
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = parseArgs(process.argv.slice(2));
const FROM = args.from;
const TARGET = path.resolve(args.target || path.join(__dirname, '..'));

if (!FROM) {
  console.error('usage: restore_backup.js --from <backupDir> [--target <projectRoot>]');
  process.exit(2);
}
const SOURCE = path.resolve(FROM);
if (!fs.existsSync(SOURCE)) {
  console.error(`backup directory not found: ${SOURCE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function sha256File(p) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(p));
  return hash.digest('hex');
}

function logJson(level, msg, extra = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), lvl: level, msg, ...extra,
  }));
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function main() {
  const manifestPath = path.join(SOURCE, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest.json not found in ${SOURCE}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  logJson('info', 'restore_start', {
    from: SOURCE,
    target: TARGET,
    sqliteCount: manifest.sqlite.length,
    fileCount: manifest.files.length,
  });

  // ── 1. checksum 校验 ───────────────────────────────────
  const tmpRoot = path.join(TARGET, '.restore-tmp');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  for (const entry of manifest.sqlite) {
    const src = path.join(SOURCE, entry.backupPath || path.join('sqlite', entry.path));
    if (!fs.existsSync(src)) {
      console.error(`missing backup file: ${src}`);
      process.exit(1);
    }
    const dst = path.join(tmpRoot, entry.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const actual = sha256File(dst);
    if (actual !== entry.sha256) {
      console.error(`sha256 mismatch for ${entry.path}: ${actual} vs ${entry.sha256}`);
      process.exit(1);
    }
    logJson('info', 'sqlite_verified', { path: entry.path });
  }

  // ── 2. 备份当前 .sqlite，方便回滚 ───────────────────────
  const stamp = nowStamp();
  const beforeRoot = path.join(TARGET, `.before-restore-${stamp}`);
  fs.mkdirSync(beforeRoot, { recursive: true });
  for (const entry of manifest.sqlite) {
    const current = path.join(TARGET, entry.path);
    if (fs.existsSync(current)) {
      const dst = path.join(beforeRoot, entry.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(current, dst);
    }
  }
  logJson('info', 'pre_restore_snapshot', { path: beforeRoot });

  // ── 3. 替换 .sqlite ────────────────────────────────────
  for (const entry of manifest.sqlite) {
    const tmp = path.join(tmpRoot, entry.path);
    const dst = path.join(TARGET, entry.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(tmp, dst);
    logJson('info', 'sqlite_restored', { path: entry.path });
  }

  // ── 4. 图片 sync ───────────────────────────────────────
  if (fs.existsSync(path.join(SOURCE, 'data'))) {
    copyDir(path.join(SOURCE, 'data'), path.join(TARGET, 'data'));
    logJson('info', 'images_restored', { fileCount: manifest.files.length });
  }

  if (Array.isArray(manifest.files) && manifest.files.length > 0) {
    for (const entry of manifest.files) {
      const src = path.join(SOURCE, entry.backupPath || entry.path);
      if (!fs.existsSync(src)) {
        console.error(`missing backup file: ${src}`);
        process.exit(1);
      }
      if (entry.sha256 && sha256File(src) !== entry.sha256) {
        console.error(`sha256 mismatch for ${entry.path}`);
        process.exit(1);
      }
      const dst = path.join(TARGET, entry.sourcePath || entry.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    logJson('info', 'files_restored', { fileCount: manifest.files.length });
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  logJson('info', 'restore_complete', {
    sqliteCount: manifest.sqlite.length,
    beforeSnapshot: beforeRoot,
  });
}

main();
