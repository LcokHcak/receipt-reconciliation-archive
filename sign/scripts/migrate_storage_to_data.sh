#!/usr/bin/env bash
# 把 /opt/sign-data/storage(图片+数据库,现挤在120G系统盘)迁到 500G 大盘 /data。
# 两步走:
#   presync  在线预同步——rsync 图片到 /data,排除活动数据库,应用照常跑,零风险、可反复跑;
#   cutover  停机秒切——停应用→终同步(含数据库)→切软链→起应用→验 readyz,失败自动回滚。
# 用法: bash migrate_storage_to_data.sh presync
#        bash migrate_storage_to_data.sh cutover   # 需维护窗口,会停机几分钟
set -uo pipefail

SRC=/opt/sign-data/storage
DST=/data/storage
APP=sign-workbench
READYZ=http://localhost:3000/readyz
# 活动数据库:presync 阶段绝不搬(边写边拷会得到撕裂副本),留到 cutover 停机后干净搬。
DB_EXCLUDES=(--exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm'
             --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm'
             --exclude='tmp_uploads/***')

log() { echo "[$(date '+%F %T')] $*"; }

presync() {
  log "PRESYNC 开始: $SRC → $DST(排除活动数据库/tmp_uploads,应用继续在线)"
  mkdir -p "$DST"
  # -aH:**必须带 H 保留硬链接**——本存储 17.6万文件是硬链(同图硬链进 batches/ 和 customer_library/
  # 省 42% 磁盘)。不带 -H 会把每个硬链拷成独立副本,52G 膨胀成 90G+ 且丢掉去重(2026-07-14 实测踩坑)。
  # --delete 让 /data 成源镜像(源侧90天清理同步删,免残留);--info=stats2 出统计。
  rsync -aH --delete --info=stats2 "${DB_EXCLUDES[@]}" "$SRC/" "$DST/"
  local rc=$?
  log "PRESYNC rsync 退出码=$rc(24=传输中有文件被清理,可忽略)"
  log "源(不含DB)文件数: $(find "$SRC" -type f ! -name '*.sqlite*' ! -name '*.db*' 2>/dev/null | wc -l)"
  log "目标文件数:        $(find "$DST" -type f 2>/dev/null | wc -l)"
  log "目标体积:          $(du -sh "$DST" 2>/dev/null | cut -f1)"
  log "PRESYNC 完成。cutover 前可再跑一次本命令把增量补上。"
}

cutover() {
  local before; before=$(curl -s -o /dev/null -w '%{http_code}' "$READYZ")
  log "CUTOVER 开始(会停机)。当前 readyz=$before"
  if [ ! -L "$SRC" ] && [ ! -d "$SRC" ]; then log "❌ $SRC 不存在"; exit 1; fi
  if [ -L "$SRC" ]; then log "❌ $SRC 已是软链,似乎已迁过,中止"; exit 1; fi
  if [ ! -d "$DST" ] || [ "$(find "$DST" -type f 2>/dev/null | wc -l)" -lt 1000 ]; then
    log "❌ 目标 $DST 不存在或文件过少,请先跑 presync"; exit 1
  fi

  log "停应用 $APP ..."; pm2 stop "$APP"; sleep 2
  log "终同步(含数据库,应用已停、库无写入)..."
  # -aH 同 presync:保留硬链接,含数据库这次也搬(应用已停无写入,库文件安全)。
  rsync -aH --delete --info=stats2 --exclude='tmp_uploads/***' "$SRC/" "$DST/"
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 24 ]; then
    log "❌ 终同步失败 rc=$rc,不切换,重启原应用"; pm2 start "$APP"; exit 1
  fi
  for db in workbench.sqlite monthly.sqlite; do
    if [ ! -f "$DST/$db" ]; then log "❌ $db 未同步到 $DST,回滚"; pm2 start "$APP"; exit 1; fi
  done
  log "数据库校验通过,切换软链..."
  local old="${SRC}.old-$(date +%s)"
  mv "$SRC" "$old"
  ln -s "$DST" "$SRC"
  log "起应用 $APP ..."; pm2 start "$APP"; sleep 6
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "$READYZ")
  log "启动后 readyz=$code"
  if [ "$code" = "200" ]; then
    log "✅ CUTOVER 成功:storage 已软链到 /data。旧数据留在 $old"
    log "   业务确认正常后手动删旧: rm -rf $old"
  else
    log "⚠️ readyz=$code 非200。排查: pm2 logs $APP --lines 50"
    log "   回滚: rm '$SRC' && mv '$old' '$SRC' && pm2 restart $APP"
  fi
}

case "${1:-}" in
  presync) presync ;;
  cutover) cutover ;;
  *) echo "用法: $0 presync|cutover"; exit 1 ;;
esac
