#!/usr/bin/env bash
# 回滚脚本 — 出事时 30 秒内跑这个
#
# 用法：
#   ./scripts/rollback.sh                    # 回到 .deploy-previous-sha 记的版本
#   ./scripts/rollback.sh <sha-or-tag>       # 回到任意版本
#   ./scripts/rollback.sh <sha-or-tag> --restore-backup <backup-dir>
#                                            # 同时还原数据库备份
#
# 默认行为：
#   - 切回上一个上线时记下的 sha
#   - npm ci 重装依赖（package.json 可能也变了）
#   - pm2 reload，等 /readyz 返回 200
#
# 注意：
#   - 默认 *不* 还原数据库，因为多数 bug 是代码问题不是数据问题
#   - 当数据库 schema 已经升级、新版本写入了不兼容数据时，才需要 --restore-backup

set -euo pipefail

echo "[rollback] 此脚本已停用：当前服务器采用 release 软链回滚。"
echo "[rollback] 请在服务器当前 release 中运行: bash scripts/server_rollback.sh [release-<sha>]"
exit 2

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

APP_NAME="sign-workbench"
READYZ_URL="${READYZ_URL:-http://127.0.0.1:${PORT:-3000}/readyz}"
READYZ_TIMEOUT_SEC=30

log() {
  echo "[rollback $(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# ── 解析参数 ────────────────────────────────────────────
TARGET=""
RESTORE_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restore-backup)
      shift
      RESTORE_FROM="$1"
      shift
      ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"; fi
      shift
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  if [ -f .deploy-previous-sha ]; then
    TARGET=$(cat .deploy-previous-sha)
    log "no target given; using last-known-good from .deploy-previous-sha: $TARGET"
  else
    log "ERROR: no target and no .deploy-previous-sha"
    exit 2
  fi
fi

log "rolling back to: $TARGET"

# ── 切版本 ──────────────────────────────────────────────
git fetch --tags origin
git checkout "$TARGET"
log "checked out: $(git rev-parse HEAD)"

# ── 依赖 ───────────────────────────────────────────────
log "npm ci"
npm ci --omit=dev || npm ci

# ── 可选：还原 DB ───────────────────────────────────────
if [ -n "$RESTORE_FROM" ]; then
  log "stopping app before restoring db: $RESTORE_FROM"
  pm2 stop "$APP_NAME" || true
  node scripts/restore_backup.js --from "$RESTORE_FROM"
  log "db restored, restarting"
fi

# ── PM2 ─────────────────────────────────────────────────
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$APP_NAME"
else
  pm2 start ecosystem.config.cjs --env production
fi
pm2 save

# ── /readyz 探测 ────────────────────────────────────────
log "waiting for /readyz"
deadline=$(( $(date +%s) + READYZ_TIMEOUT_SEC ))
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS -o /dev/null "$READYZ_URL"; then
    log "readyz OK, rollback complete to $TARGET"
    exit 0
  fi
  sleep 1
done

log "ERROR: /readyz did not respond within ${READYZ_TIMEOUT_SEC}s after rollback"
exit 1
