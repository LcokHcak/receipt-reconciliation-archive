#!/usr/bin/env bash
# 服务器端回滚 —— 把 /opt/sign-workbench 软链切回上一个（或指定）release，pm2 重启。
#
# 用法（服务器上）：
#   bash scripts/server_rollback.sh                      # 回到上一个 release
#   bash scripts/server_rollback.sh release-<sha>        # 回到指定 release（名或绝对路径）
#
# 数据不动：storage / models 是独立目录，回滚只换代码软链，不碰数据。
# 若新版本改过 DB schema 且写入了不兼容数据，需另外用 scripts/restore_backup.js 还原备份。

set -euo pipefail

BASE=/opt/sign-workbench
ECOSYSTEM=ecosystem.config.cjs   # 4核8G 默认配置(2核4G 旧机用 ecosystem.2c4g.config.cjs)
APP=sign-workbench
READYZ=http://127.0.0.1:3000/readyz

log() { echo "[rollback $(date +'%H:%M:%S')] $*"; }

CUR=$(readlink -f "$BASE" 2>/dev/null || true)
log "当前: ${CUR:-<无>}"

TARGET="${1:-}"
if [ -n "$TARGET" ]; then
  case "$TARGET" in
    /*) : ;;                                        # 绝对路径
    *)  TARGET="/opt/sign-workbench.${TARGET#sign-workbench.}";;  # 容许传 release-xxx
  esac
else
  # 没指定 → 选「最近的、且不是当前」的 release
  TARGET=$(ls -dt /opt/sign-workbench.release-* 2>/dev/null | while read -r d; do
    [ "$(readlink -f "$d")" != "$CUR" ] && { echo "$d"; break; }
  done)
fi

[ -n "$TARGET" ] && [ -d "$TARGET" ] || { log "ERROR: 找不到回滚目标: ${1:-<上一版>}"; exit 2; }
log "回滚到: $TARGET"

# 确保目标 release 不会回到旧版内置 storage/model。
# 回滚只切代码，数据和模型必须继续指向独立目录。
rm -rf "$TARGET/model"
ln -sfn /opt/sign-data/models "$TARGET/model"
rm -rf "$TARGET/passport_review_workbench/storage"
mkdir -p "$TARGET/passport_review_workbench"
ln -sfn /opt/sign-data/storage "$TARGET/passport_review_workbench/storage"

sudo ln -sfn "$TARGET" "$BASE"
cd "$BASE"
pm2 delete "$APP" >/dev/null 2>&1 || true
pm2 start "$ECOSYSTEM" --env production
pm2 save >/dev/null 2>&1 || true

log "等待 readyz..."
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$READYZ" || true)
  if [ "$code" = "200" ]; then log "readyz=200，回滚完成 → $TARGET"; exit 0; fi
  sleep 1
done
log "ERROR: 回滚后 readyz 未返回 200"
exit 1
