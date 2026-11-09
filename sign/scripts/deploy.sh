#!/usr/bin/env bash
# 上线部署脚本 — 在服务器上执行
#
# 用法：
#   ./scripts/deploy.sh                  # 部署当前 main 分支
#   ./scripts/deploy.sh v1.0.0-internal  # 部署具体 tag
#
# 工作流：
#   1. fetch + checkout 目标版本（默认 main）
#   2. 备份当前数据库（调用 backup_sqlite.js）
#   3. npm ci（不用 npm install，保证 lockfile 一致）
#   4. 跑测试套确认没爆
#   5. pm2 reload（零停机滚动重启；如果第一次部署则 pm2 start）
#   6. 等 /readyz 返回 200，证明启动成功；超过 30s 就失败
#
# 设计取舍：
#   - 用 set -euo pipefail 让任何中间步骤失败立刻退出
#   - 备份在跑测试 *之前*，万一测试套发现 schema migration 失败也已有备份
#   - 不接受 force flag — 测试不过就是不能上
#   - 输出每步都打时间戳，方便事后追

set -euo pipefail

echo "[deploy] 此脚本已停用：当前服务器采用本地推送 release 流程。"
echo "[deploy] 请在本地运行: node scripts/deploy_push.js"
exit 2

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

TARGET="${1:-origin/main}"
APP_NAME="sign-workbench"
READYZ_URL="${READYZ_URL:-http://127.0.0.1:${PORT:-3000}/readyz}"
READYZ_TIMEOUT_SEC=30

log() {
  echo "[deploy $(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "deploy start: target=$TARGET"
log "project root: $PROJECT_ROOT"

# ── 1. 版本切换 ─────────────────────────────────────────
git fetch --tags origin
CURRENT_SHA=$(git rev-parse HEAD)
log "current sha: $CURRENT_SHA"

# 写一份回滚信息，rollback.sh 会读它
echo "$CURRENT_SHA" > .deploy-previous-sha

git checkout "$TARGET"
NEW_SHA=$(git rev-parse HEAD)
log "checked out: $NEW_SHA"

# ── 2. 备份 ─────────────────────────────────────────────
log "backup_sqlite start"
node scripts/backup_sqlite.js --target "${SIGN_BACKUP_TARGET:-./backups}"
log "backup_sqlite done"

# ── 3. 依赖 ─────────────────────────────────────────────
log "npm ci start"
npm ci --omit=dev || npm ci
log "npm ci done"

# ── 4. 测试 ─────────────────────────────────────────────
# 跑全量测试套 — 内部工具，没有 staging，本地通过 = 上线 OK
log "running test suite"
npm test
log "tests green"

# ── 5. PM2 ──────────────────────────────────────────────
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "pm2 reload $APP_NAME (zero-downtime)"
  pm2 reload "$APP_NAME"
else
  log "pm2 start $APP_NAME (first run)"
  pm2 start ecosystem.config.cjs --env production
fi
pm2 save

# ── 6. /readyz 探测 ─────────────────────────────────────
log "waiting for /readyz at $READYZ_URL"
deadline=$(( $(date +%s) + READYZ_TIMEOUT_SEC ))
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS -o /dev/null "$READYZ_URL"; then
    log "readyz OK, deploy complete (new sha: $NEW_SHA)"
    exit 0
  fi
  sleep 1
done

log "ERROR: /readyz did not respond within ${READYZ_TIMEOUT_SEC}s"
log "consider rolling back: ./scripts/rollback.sh"
exit 1
