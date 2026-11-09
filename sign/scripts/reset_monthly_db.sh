#!/usr/bin/env bash
# 月度库快速重置(运维脚本)。
#
# 为什么不用 DELETE/VACUUM:在 1.7GB+ 的 monthly.sqlite 上 DELETE 全表 + VACUUM 会超时/锁死。
# 本脚本改为「把 monthly.sqlite 整文件移到备份目录,让应用启动时按 migration 重建空库」,
# 秒级完成。只动 monthly.sqlite(月度业务数据),**不碰 workbench.sqlite(账号/客户库)**。
#
# 流程:停应用(释放 WAL/fd)→ 移走 monthly.sqlite{,-wal,-shm} 到备份目录 → 启应用(自动建空库)→ 验 readyz。
#
# 用法(在服务器上,或经 ssh):
#   bash scripts/reset_monthly_db.sh
#   STORAGE_DIR=/opt/sign-data/storage PM2_APP=sign-workbench bash scripts/reset_monthly_db.sh
#   bash scripts/reset_monthly_db.sh --no-restart   # 只备份移走,不自动重启(手动控制)
#   bash scripts/reset_monthly_db.sh --yes          # 跳过确认
set -euo pipefail

STORAGE_DIR="${STORAGE_DIR:-/opt/sign-data/storage}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/sign-data/backups}"
PM2_APP="${PM2_APP:-sign-workbench}"
READYZ_URL="${READYZ_URL:-http://localhost:3000/readyz}"
DB_NAME="monthly.sqlite"

NO_RESTART=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

DB_PATH="${STORAGE_DIR}/${DB_NAME}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/preclear-${TS}"

log() { echo "[reset-monthly $(date +%H:%M:%S)] $*"; }
die() { echo "[reset-monthly] 错误: $*" >&2; exit 1; }

[ -d "$STORAGE_DIR" ] || die "storage 目录不存在: $STORAGE_DIR"
if [ ! -f "$DB_PATH" ]; then
  log "未发现 $DB_PATH —— 可能已是空库,无需重置。"
  exit 0
fi

DB_SIZE="$(du -h "$DB_PATH" | cut -f1)"
log "目标库: $DB_PATH ($DB_SIZE)"
log "备份到: $BACKUP_DIR"
log "PM2 应用: $PM2_APP   自动重启: $([ $NO_RESTART -eq 1 ] && echo 否 || echo 是)"
log "注意:只重置月度库,workbench.sqlite(账号/客户库)不受影响。"

if [ $ASSUME_YES -ne 1 ]; then
  read -r -p "确认重置月度库?(输入 yes 继续) " ans
  [ "$ans" = "yes" ] || die "已取消"
fi

# 1. 停应用,释放 WAL / 文件句柄(避免移动后旧进程仍写老 inode)
STOPPED=0
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  log "停止 $PM2_APP ..."
  pm2 stop "$PM2_APP" >/dev/null
  STOPPED=1
else
  log "未检测到 pm2 应用 $PM2_APP —— 跳过停应用(请确保没有进程正在写 $DB_NAME)"
fi

# 2. 移走 monthly.sqlite 及其 -wal/-shm 到备份目录
mkdir -p "$BACKUP_DIR"
moved=0
for suffix in "" "-wal" "-shm"; do
  f="${DB_PATH}${suffix}"
  if [ -f "$f" ]; then
    mv "$f" "$BACKUP_DIR/"
    moved=$((moved+1))
    log "已移动 $(basename "$f")"
  fi
done
[ $moved -gt 0 ] || die "没有可移动的库文件(意外状态)"
log "已备份 $moved 个文件到 $BACKUP_DIR"

# 3. 重启应用 → openMonthlyDatabase 会按 migration 重建空库
if [ $NO_RESTART -eq 1 ]; then
  log "--no-restart:未自动重启。手动 \`pm2 start $PM2_APP\` 后应用会重建空库。"
  exit 0
fi

if [ $STOPPED -eq 1 ]; then
  log "启动 $PM2_APP ..."
  pm2 start "$PM2_APP" >/dev/null || pm2 restart "$PM2_APP" >/dev/null
fi

# 4. 等 readyz
log "等待 readyz ..."
ok=0
for i in $(seq 1 30); do
  if curl -fsS "$READYZ_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ $ok -eq 1 ]; then
  log "✅ 重置完成,readyz=ready。空库已由应用重建。备份保留在 $BACKUP_DIR"
else
  die "readyz 未就绪,请查看 pm2 logs $PM2_APP;备份在 $BACKUP_DIR(可手动恢复)"
fi
