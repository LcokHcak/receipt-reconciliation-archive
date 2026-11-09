'use strict';

/**
 * 训练数据回流路由(admin) — 模型优化数据飞轮的服务端入口。
 *
 * 端点:
 *   GET  /api/admin/training/status  - 最近构建列表(summary)+ 当前任务状态
 *   POST /api/admin/training/export  - 构建 6 个飞桨数据集(异步,spawn 编排脚本)
 *   POST /api/admin/training/upload  - 上传指定/最新构建到 AI Studio(JINHAIMIN/1~6)
 *
 * 构建/上传都是只读旁路(读批次+客户库,写 train_exports/),不碰业务数据。
 * 单实例 PM2,任务状态用内存即可;同类任务进行中再触发会被拒绝。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  authenticateToken: createAuthenticateToken,
  requireRole: defaultRequireRole,
} = require('../lib/auth/jwt_middleware');

function resolveTokenMiddleware(auth = {}) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  return null;
}

function createTrainingRoutes({ projectRoot, exportRoot, auth }) {
  const root = projectRoot || path.join(__dirname, '..');
  const trainExportsRoot = exportRoot
    || path.join(root, 'passport_review_workbench', 'storage', 'train_exports');

  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const roleGuard = auth?.requireRole || defaultRequireRole;
  const protect = (tokenMiddleware && roleGuard) ? [tokenMiddleware, roleGuard('admin')] : [];

  // 内存任务状态(export/upload 各一个槽位)
  const jobs = {
    export: { status: 'idle', startedAt: null, finishedAt: null, log: '', result: null },
    upload: { status: 'idle', startedAt: null, finishedAt: null, log: '', result: null },
  };

  function runScript(kind, scriptRel, args) {
    const job = jobs[kind];
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    job.log = '';
    job.result = null;
    const child = spawn(process.execPath, [path.join(root, scriptRel), ...args], {
      cwd: root,
      env: process.env,
    });
    const append = (d) => {
      job.log = (job.log + String(d)).slice(-8000); // 只留尾部,防内存涨
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.finishedAt = new Date().toISOString();
      try {
        // 脚本末尾输出 JSON summary,尽力解析给前端
        const tail = job.log.trim();
        const jsonStart = tail.indexOf('{');
        if (jsonStart >= 0) job.result = JSON.parse(tail.slice(jsonStart));
      } catch { /* 留 log 即可 */ }
    });
    child.on('error', (err) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.log += `\nspawn error: ${err.message}`;
    });
  }

  function listBuilds() {
    if (!fs.existsSync(trainExportsRoot)) return [];
    return fs.readdirSync(trainExportsRoot)
      .filter((d) => d.startsWith('feijiang_'))
      .sort()
      .reverse()
      .slice(0, 10)
      .map((d) => {
        const summaryPath = path.join(trainExportsRoot, d, 'summary.json');
        let summary = null;
        try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { /* 无summary跳过 */ }
        return { dir: d, summary };
      });
  }

  function register(app) {
    app.get('/api/admin/training/status', ...protect, (_req, res) => {
      res.json({
        jobs,
        builds: listBuilds(),
        tokenConfigured: Boolean(process.env.AISTUDIO_TOKEN || process.env.SIGN_AISTUDIO_TOKEN),
      });
    });

    app.post('/api/admin/training/export', ...protect, (_req, res) => {
      if (jobs.export.status === 'running') {
        return res.status(409).json({ error: '导出任务进行中', code: 'EXPORT_RUNNING' });
      }
      runScript('export', 'scripts/build_training_datasets.js', []);
      return res.json({ ok: true, job: jobs.export });
    });

    app.post('/api/admin/training/upload', ...protect, (req, res) => {
      if (jobs.upload.status === 'running') {
        return res.status(409).json({ error: '上传任务进行中', code: 'UPLOAD_RUNNING' });
      }
      if (!process.env.AISTUDIO_TOKEN && !process.env.SIGN_AISTUDIO_TOKEN) {
        return res.status(422).json({ error: 'AISTUDIO_TOKEN 未配置(.env)', code: 'TOKEN_MISSING' });
      }
      const builds = listBuilds();
      const requested = String(req.body?.dir || '').trim();
      // 只允许选已有构建目录名,杜绝路径注入
      const target = requested
        ? builds.find((b) => b.dir === requested)
        : builds[0];
      if (!target) {
        return res.status(422).json({ error: '没有可上传的构建,先执行导出', code: 'NO_BUILD' });
      }
      const args = ['--dir', path.join(trainExportsRoot, target.dir)];
      const only = String(req.body?.only || '').trim();
      if (only && /^[1-6](,[1-6])*$/.test(only)) args.push('--only', only);
      runScript('upload', 'scripts/upload_training_datasets.js', args);
      return res.json({ ok: true, job: jobs.upload, dir: target.dir });
    });
  }

  return { register };
}

module.exports = { createTrainingRoutes };
