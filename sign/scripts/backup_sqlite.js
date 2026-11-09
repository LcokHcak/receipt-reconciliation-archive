#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_REL = path.join('passport_review_workbench', 'storage');
const DEFAULT_TARGET_ROOT = path.join(PROJECT_ROOT, 'backups');
const DEFAULT_RETAIN = 7;
const ASSET_DIRS = ['backups', 'batches', 'customer_library', 'monthly-exports'];
const ASSET_FILES = ['customer_library.settings.json'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function nowStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function toPosix(relPath) {
  return relPath.replace(/\\/g, '/');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 迭代遍历(显式栈),不用递归、不用 push(...spread)。
// storage 已达 40 万+ 文件:老写法 `files.push(...await walkFiles(full))` 把整棵子树
// 当函数实参展开,一旦元素数越过 V8 实参上限(~10 万)就抛
// "Maximum call stack size exceeded"(2026-07-05 起夜间备份连崩即此)。
// skipDirs:按目录名跳过指定子目录(供 findSqliteFiles 绕开巨型资源目录)。
async function walkFiles(root, { skipDirs = [] } = {}) {
  const files = [];
  if (!(await pathExists(root))) return files;
  const skip = new Set(skipDirs);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

async function findSqliteFiles(sourceRoot) {
  const storageRoot = path.join(sourceRoot, STORAGE_REL);
  // .sqlite 只在 storage 顶层。跳过 batches/customer_library/monthly-exports 这几个
  // 数十万文件的资源目录——遍历它们既慢又毫无意义(那里没有库),也是当初爆栈的诱因。
  const files = await walkFiles(storageRoot, {
    skipDirs: ['batches', 'customer_library', 'monthly-exports'],
  });
  return files
    .filter((file) => /\.(sqlite|db)$/i.test(file))
    .filter((file) => !/-(wal|shm)$/i.test(file))
    .sort();
}

function openSqlite3(filename, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, mode, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function closeSqlite3(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function backupSqliteFile(src, dst) {
  await ensureDir(path.dirname(dst));
  const db = await openSqlite3(src, sqlite3.OPEN_READONLY);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const backup = db.backup(dst);
      backup.on('error', finish);
      backup.step(-1, (stepError) => {
        if (stepError) {
          backup.finish(() => finish(stepError));
          return;
        }
        backup.finish((finishError) => finish(finishError || null));
      });
    });
  } finally {
    await closeSqlite3(db);
  }
}

async function integrityCheck(sqlitePath) {
  const db = await open({
    filename: sqlitePath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });
  try {
    const row = await db.get('PRAGMA integrity_check');
    const value = row ? row[Object.keys(row)[0]] : '';
    if (value !== 'ok') {
      throw new Error(`integrity_check failed for ${sqlitePath}: ${value}`);
    }
    return value;
  } finally {
    await db.close();
  }
}

async function copyFileWithManifest({ sourceRoot, backupDir, sourcePath, manifestFiles }) {
  const rel = toPosix(path.relative(sourceRoot, sourcePath));
  const backupPath = toPosix(path.join('files', rel));
  const dst = path.join(backupDir, backupPath);
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(sourcePath, dst);
  const stat = await fsp.stat(dst);
  manifestFiles.push({
    path: rel,
    sourcePath: rel,
    backupPath,
    bytes: stat.size,
    sha256: sha256File(dst),
  });
}

async function copyRecoveryAssets({ sourceRoot, backupDir, manifestFiles }) {
  const storageRoot = path.join(sourceRoot, STORAGE_REL);
  for (const dirname of ASSET_DIRS) {
    const dir = path.join(storageRoot, dirname);
    const files = await walkFiles(dir);
    for (const file of files) {
      await copyFileWithManifest({ sourceRoot, backupDir, sourcePath: file, manifestFiles });
    }
  }

  for (const filename of ASSET_FILES) {
    const file = path.join(storageRoot, filename);
    if (await pathExists(file)) {
      await copyFileWithManifest({ sourceRoot, backupDir, sourcePath: file, manifestFiles });
    }
  }
}

async function pruneOldBackups(targetRoot, retain) {
  if (!Number.isFinite(retain) || retain <= 0 || !(await pathExists(targetRoot))) return [];
  const entries = await fsp.readdir(targetRoot, { withFileTypes: true });
  const backupDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removed = [];
  while (backupDirs.length > retain) {
    const victim = backupDirs.shift();
    const full = path.join(targetRoot, victim);
    await fsp.rm(full, { recursive: true, force: true });
    removed.push(full);
  }
  return removed;
}

async function createBackup({
  sourceRoot = PROJECT_ROOT,
  targetRoot = process.env.SIGN_BACKUP_TARGET || DEFAULT_TARGET_ROOT,
  retain = Number(process.env.SIGN_BACKUP_RETAIN || DEFAULT_RETAIN),
  now = () => new Date(),
  includeAssets = true,
} = {}) {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedTarget = path.resolve(targetRoot);
  await ensureDir(resolvedTarget);

  const backupDir = path.join(resolvedTarget, nowStamp(now()));
  await ensureDir(backupDir);

  const manifest = {
    schemaVersion: 2,
    type: 'sign-workbench-backup',
    startedAt: now().toISOString(),
    source: resolvedSource,
    sqlite: [],
    files: [],
  };

  const sqliteFiles = await findSqliteFiles(resolvedSource);
  for (const src of sqliteFiles) {
    const rel = toPosix(path.relative(resolvedSource, src));
    const backupPath = toPosix(path.join('sqlite', rel));
    const dst = path.join(backupDir, backupPath);
    await backupSqliteFile(src, dst);
    const stat = await fsp.stat(dst);
    const integrity = await integrityCheck(dst);
    manifest.sqlite.push({
      path: rel,
      sourcePath: rel,
      backupPath,
      bytes: stat.size,
      sha256: sha256File(dst),
      integrityCheck: integrity,
    });
  }

  if (includeAssets) {
    await copyRecoveryAssets({
      sourceRoot: resolvedSource,
      backupDir,
      manifestFiles: manifest.files,
    });
  }

  manifest.finishedAt = now().toISOString();
  const manifestPath = path.join(backupDir, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const verified = await verifyBackup({ backupDir });
  manifest.verifiedAt = now().toISOString();
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const pruned = await pruneOldBackups(resolvedTarget, Number(retain));
  return {
    backupDir,
    manifest,
    verified,
    pruned,
  };
}

async function verifyBackup({ backupDir } = {}) {
  if (!backupDir) {
    throw new Error('backupDir is required');
  }
  const resolvedBackup = path.resolve(backupDir);
  const manifestPath = path.join(resolvedBackup, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  for (const entry of manifest.sqlite || []) {
    const file = path.join(resolvedBackup, entry.backupPath || path.join('sqlite', entry.path));
    if (!(await pathExists(file))) {
      throw new Error(`missing sqlite backup: ${entry.path}`);
    }
    const actual = sha256File(file);
    if (actual !== entry.sha256) {
      throw new Error(`sha256 mismatch for ${entry.path}`);
    }
    await integrityCheck(file);
  }

  for (const entry of manifest.files || []) {
    const file = path.join(resolvedBackup, entry.backupPath || entry.path);
    if (!(await pathExists(file))) {
      throw new Error(`missing backup file: ${entry.path}`);
    }
    const actual = sha256File(file);
    if (actual !== entry.sha256) {
      throw new Error(`sha256 mismatch for ${entry.path}`);
    }
  }

  return {
    backupDir: resolvedBackup,
    sqliteCount: (manifest.sqlite || []).length,
    fileCount: (manifest.files || []).length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) {
    const backupDir = typeof args.verify === 'string' ? args.verify : args._;
    if (!backupDir) {
      throw new Error('usage: node scripts/backup_sqlite.js --verify <backupDir>');
    }
    const verified = await verifyBackup({ backupDir });
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      lvl: 'info',
      msg: 'backup_verified',
      ...verified,
    }));
    return;
  }

  const result = await createBackup({
    sourceRoot: args.source ? path.resolve(args.source) : PROJECT_ROOT,
    targetRoot: args.target
      ? path.resolve(args.target)
      : process.env.SIGN_BACKUP_TARGET || DEFAULT_TARGET_ROOT,
    retain: Number(args.retain || process.env.SIGN_BACKUP_RETAIN || DEFAULT_RETAIN),
    includeAssets: String(args['include-assets'] ?? 'true') !== 'false',
  });

  for (const removed of result.pruned) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      lvl: 'info',
      msg: 'backup_pruned',
      path: removed,
    }));
  }
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    lvl: 'info',
    msg: 'backup_complete',
    path: result.backupDir,
    sqliteCount: result.manifest.sqlite.length,
    fileCount: result.manifest.files.length,
    verified: true,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      lvl: 'error',
      msg: 'backup_failed',
      err: error?.message || String(error),
    }));
    process.exit(1);
  });
}

module.exports = {
  createBackup,
  findSqliteFiles,
  integrityCheck,
  parseArgs,
  verifyBackup,
};
