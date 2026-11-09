#!/usr/bin/env bash
# 服务器端激活脚本 —— 由 scripts/deploy_push.js 上传到 /tmp 后调用。
#
# 用法（服务器上）：
#   bash /tmp/server_activate.sh <sha> [source-tarball] [overlay-tarball]
#
# 干净架构约定（重构后已落地）：
#   /opt/sign-workbench                 -> 软链，指向当前生效 release
#   /opt/sign-workbench.release-<sha>   每版一个不可变目录
#   /opt/sign-data/{storage,models}     ★独立数据/模型，绝不进 release，换版本一动不动
#   release/.env                        从上一版沿用（保住 JWT_SECRET / admin 等配置）
#   release/model                       -> /opt/sign-data/models（软链）
#   release/passport_review_workbench/storage -> /opt/sign-data/storage（软链）
#
# 设计取舍：
#   - node_modules 从当前 release 复制复用（136M），仅当 package-lock 变了才 npm ci
#   - pm2 ecosystem 用 cwd:__dirname，所以切版本必须 pm2 delete + start 重锚到新 release
#   - readyz 不过 = 失败退出（非 0），deploy_push.js 据此提示回滚
#   - 旧 release 自动只留最近 3 个

set -euo pipefail

SHA="${1:?用法: server_activate.sh <sha> [source-tarball] [overlay-tarball]}"
TARBALL="${2:-/tmp/sign-deploy-${SHA}-source.tar.gz}"
OVERLAY="${3:-/tmp/sign-deploy-${SHA}-overlay.tar.gz}"

BASE=/opt/sign-workbench
NEW="${BASE}.release-${SHA}"
DATA=/opt/sign-data
ENV_SOURCE="${SIGN_DEPLOY_ENV_SOURCE:-$DATA/.env}"
ECOSYSTEM=ecosystem.config.cjs   # 4核8G:默认配置(堆3G/重启4G);2核4G 旧机用 ecosystem.2c4g.config.cjs
KEEP=3                                # 保留最近 N 个 release
APP=sign-workbench
READYZ=http://127.0.0.1:3000/readyz

log() { echo "[activate $(date +'%H:%M:%S')] $*"; }

[ -f "$TARBALL" ] || { log "ERROR: 找不到部署包 $TARBALL"; exit 1; }
[ -f "$OVERLAY" ] || { log "ERROR: 找不到 overlay 包 $OVERLAY"; exit 1; }
[ -d "$DATA/storage" ] || { log "ERROR: 独立数据目录缺失 $DATA/storage"; exit 1; }
[ -d "$DATA/models" ]  || { log "ERROR: 独立模型目录缺失 $DATA/models"; exit 1; }

CUR=$(readlink -f "$BASE" 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" = "$NEW" ]; then
  NEW="${BASE}.release-${SHA}-redeploy-$(date +%Y%m%d%H%M%S)"
fi
log "当前 release: ${CUR:-<无>}"
log "新 release  : $NEW"

# ── 1. 解压新 release ───────────────────────────────────
sudo rm -rf "$NEW"
sudo mkdir -p "$NEW"
sudo chown "$(id -un):$(id -gn)" "$NEW"
log "解压代码 → $NEW"
tar -xzf "$TARBALL" -C "$NEW"
log "解压 overlay(dist/server scripts) → $NEW"
tar -xzf "$OVERLAY" -C "$NEW"

# ── 2. node_modules：复用当前版，lock 变了才重装 ────────
if [ -n "$CUR" ] && [ -d "$CUR/node_modules" ]; then
  log "复制 node_modules（复用当前版）"
  cp -a "$CUR/node_modules" "$NEW/node_modules"
  if ! cmp -s "$CUR/package-lock.json" "$NEW/package-lock.json" 2>/dev/null; then
    log "package-lock 有变 → npm ci --omit=dev"
    ( cd "$NEW" && npm ci --omit=dev )
  else
    log "package-lock 未变 → 跳过 npm ci"
  fi
else
  log "无可复用 node_modules → npm ci --omit=dev"
  ( cd "$NEW" && npm ci --omit=dev )
fi

# ── 3. 数据 / 模型 / 配置接线（独立目录） ───────────────
rm -rf "$NEW/model"
ln -sfn "$DATA/models" "$NEW/model"
rm -rf "$NEW/passport_review_workbench/storage"
ln -sfn "$DATA/storage" "$NEW/passport_review_workbench/storage"
if [ -n "$CUR" ] && [ -f "$CUR/.env" ]; then
  cp -a "$CUR/.env" "$NEW/.env"
  log ".env 已从当前版沿用"
elif [ -f "$ENV_SOURCE" ]; then
  cp -a "$ENV_SOURCE" "$NEW/.env"
  log ".env 已从 $ENV_SOURCE 复制"
else
  log "ERROR: 缺少 .env。首次部署前请先创建 $ENV_SOURCE（可从 .env.2c4g.example 改）"
  exit 1
fi
mkdir -p "$NEW/logs"

# ── 4. 原子切换软链 ─────────────────────────────────────
sudo ln -sfn "$NEW" "$BASE"
log "软链切换: $BASE -> $NEW"

# ── 5. pm2 重锚到新 release ─────────────────────────────
cd "$BASE"
pm2 delete "$APP" >/dev/null 2>&1 || true
pm2 start "$ECOSYSTEM" --env production
pm2 save >/dev/null 2>&1 || true

# ── 6. readyz 探测 ──────────────────────────────────────
log "等待 readyz..."
ok=0
for i in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$READYZ" || true)
  if [ "$code" = "200" ]; then ok=1; log "readyz=200 (用时 ${i}s)"; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  log "ERROR: readyz 未在 180s 内返回 200。回滚: scripts/server_rollback.sh"
  exit 1
fi
curl -s --max-time 5 "$READYZ" | head -c 400; echo

# ── 7. 清理旧 release（留最近 KEEP 个） ─────────────────
log "清理旧 release（保留最近 $KEEP 个）"
CURRESOLVED=$(readlink -f "$BASE")
ls -dt /opt/sign-workbench.release-* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
  [ "$(readlink -f "$d")" = "$CURRESOLVED" ] && continue   # 永不删当前
  sudo rm -rf "$d" && log "已删 $d"
done

rm -f "$TARBALL" "$OVERLAY"
log "✅ 激活完成: release-$SHA"
