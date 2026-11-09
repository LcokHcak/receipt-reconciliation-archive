#!/bin/bash
# 月度数据库备份脚本
# 用法：./backup_monthly.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups/monthly}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y%m%d-%H%M%S)
DB_PATH="$PROJECT_ROOT/passport_review_workbench/storage/monthly.sqlite"
EXPORT_DIR="$PROJECT_ROOT/passport_review_workbench/storage/monthly-exports"

echo "[$(date)] Starting backup..."

# 备份 SQLite（使用 .backup 命令，比 cp 更安全）
if [ -f "$DB_PATH" ]; then
  echo "Backing up monthly.sqlite..."
  sqlite3 "$DB_PATH" ".backup $BACKUP_DIR/monthly-$DATE.sqlite"
  gzip "$BACKUP_DIR/monthly-$DATE.sqlite"
  echo "Database backup: $BACKUP_DIR/monthly-$DATE.sqlite.gz"
else
  echo "Warning: Database not found at $DB_PATH"
fi

# 备份导出文件
if [ -d "$EXPORT_DIR" ]; then
  echo "Backing up exports..."
  tar -czf "$BACKUP_DIR/exports-$DATE.tar.gz" -C "$(dirname "$EXPORT_DIR")" "$(basename "$EXPORT_DIR")"
  echo "Exports backup: $BACKUP_DIR/exports-$DATE.tar.gz"
else
  echo "Warning: Exports directory not found at $EXPORT_DIR"
fi

# 清理旧备份
echo "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "*.gz" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "[$(date)] Backup completed: $DATE"
echo "Backup location: $BACKUP_DIR"
