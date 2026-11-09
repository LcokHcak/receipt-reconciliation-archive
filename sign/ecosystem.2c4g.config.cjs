/**
 * PM2 ecosystem — **2c4g 小机器版本**。
 *
 * 与默认 ecosystem.config.cjs 的差别：
 *   - max_memory_restart: 1500M  —— 4GB 物理内存里要给 Python 留位置
 *   - --max-old-space-size: 1536 —— Node V8 堆上限 1.5GB
 *   - 全套配置假定：
 *       a) 系统已加 4GB swap（脚本会装）
 *       b) PYTHON_PROCESS_POOL_MAX=1（.env 控制）
 *       c) 单台机内总进程：Node 1 + Python 1 + caddy/系统 = 物理 ~3GB + swap
 *
 * 启动：
 *   pm2 start ecosystem.2c4g.config.cjs --env production
 *
 * 与默认配置共存：服务器选哪个就 `pm2 start <文件>`，不会冲突。
 *
 * **内存说明（已做分批优化）**：
 *   bill_match / merge 已改为「边算边分批落库」（每 5000 行 flush），
 *   insert 累积数组不再随行数线性增长，峰值大幅下降。
 *   但 merge 阶段仍需在内存里持有若干 Map（billByDaily / billById），
 *   其大小随账单/台账行数增长。10w 行乐天全量时这些 Map 仍可能逼近 1.5GB 堆。
 *   小机器建议跑 < 5w 行；业务月度稳定到 10w 行（如乐天全量），
 *   仍建议升级到 8c32g 的标准 ecosystem.config.cjs（3GB 堆，余量充足）。
 */

module.exports = {
  apps: [
    {
      name: 'sign-workbench',
      script: 'passport_review_workbench.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1500M',
      kill_timeout: 32000,
      listen_timeout: 30000,                // 模型加载慢，给 30s 启动窗口
      max_restarts: 10,
      min_uptime: '60s',
      // --env-file 让 Node 22+ 原生加载 .env；PM2 不会自己读 .env
      node_args: '--env-file=./.env --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Seoul', // G11e: 同 ecosystem.config.cjs,固定 KST
      },
      env_production: {
        NODE_ENV: 'production',
        TZ: 'Asia/Seoul',
      },
      out_file: './logs/workbench-out.log',
      error_file: './logs/workbench-err.log',
      time: false,
      merge_logs: true,
    },
  ],
};
