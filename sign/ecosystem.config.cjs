/**
 * PM2 ecosystem — production process manager config.
 *
 * 启动方式：
 *   pm2 start ecosystem.config.cjs --env production
 *
 * 关键参数说明：
 *   - exec_mode: 'fork'  — 单实例。我们的 Node 进程持有 SQLite 句柄
 *                          和 Python 进程池的引用，cluster 模式会让多
 *                          个 Node 实例同时打开 DB，破坏 advisory lock
 *                          的语义；保持 fork。
 *   - instances: 1
 *   - max_memory_restart: '2500M' — 100k 行 merge 阶段实测 RSS 峰值
 *                          ~2.2GB（见 capacity_drill_100k.js 报告）；
 *                          2.5GB 留 300MB 余量
 *   - kill_timeout: 32000 — 比 graceful_shutdown 的 totalTimeoutMs(30s)
 *                          多 2 秒；保证 PM2 不会在我们排空之前 SIGKILL
 *   - listen_timeout: 10000 — `pm2 reload` 时给 readyz 10s 启动窗口
 *   - autorestart: true   — 进程崩了立刻拉起
 *   - max_restarts: 10    — 1 分钟内 10 次以上的快崩当死循环，停止
 *   - min_uptime: '60s'
 *
 *   日志:
 *     - 我们的 logger 已经写 stdout / stderr 为 jsonl
 *     - PM2 会按 out_file / error_file 切走，rotate 用 pm2-logrotate 模块
 *     - 安装：pm2 install pm2-logrotate
 *             pm2 set pm2-logrotate:max_size 100M
 *             pm2 set pm2-logrotate:retain 14
 */

// 日志目录:默认写到数据根 /opt/sign-data/logs(部署换 release 也不丢;旧做法写 release 内 ./logs 会随旧 release 被删)。
// 本地/其他环境可用 SIGN_LOG_DIR 覆盖。
const LOG_DIR = process.env.SIGN_LOG_DIR || '/opt/sign-data/logs';

module.exports = {
  apps: [
    {
      name: 'sign-workbench',
      script: 'passport_review_workbench.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '4000M',
      kill_timeout: 32000,
      listen_timeout: 30000,
      max_restarts: 10,
      min_uptime: '60s',
      // --env-file 让 Node 自己读 .env（22+ 原生支持），避免依赖 shell 导出
      // 否则 PM2 启动时拿不到 JWT_SECRET，进程直接报错退出。
      node_args: '--env-file=./.env --max-old-space-size=3072',
      env: {
        NODE_ENV: 'production',
        // G11e: 固定服务端时区为韩国时间 (Asia/Seoul, UTC+9)。
        // - new Date().toISOString() 仍是 UTC (ISO 标准格式)
        // - 但 toLocaleString / toString / xlsx 时间列走 local time = KST
        // - 跨日审核 (韩国 23:30 = UTC 14:30) 不再落到错误 daily 桶
        // - 操作 audit_log 的 created_at 仍 UTC,UI 展示由前端转 KST
        TZ: 'Asia/Seoul',
      },
      env_production: {
        NODE_ENV: 'production',
        TZ: 'Asia/Seoul',
      },
      // PM2 splits stdout/stderr; logger.error 已经写 stderr，所以 PM2
      // 默认两个文件都会有结构化 JSON。
      out_file: `${LOG_DIR}/workbench-out.log`,
      error_file: `${LOG_DIR}/workbench-err.log`,
      time: false, // 不要 PM2 自己加时间戳前缀，我们的 logger 已经带 ts
      merge_logs: true,
    },
  ],
};
