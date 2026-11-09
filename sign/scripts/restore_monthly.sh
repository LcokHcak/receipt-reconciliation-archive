#!/bin/bash
# 恢复月度数据库
# 用法：./restore_monthly.sh <backup-file>

set -e

if [ $# -eq 0 ]; then
  echo "Usage: $0 <backup-file>"
  echo "Example: $0 backups/monthly/monthly-20260511-020000.sqlite.gz"
  exit 1
fi

BACKUP_FILE=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB_PATH="$PROJECT_ROOT/passport_review_workbench/storage/monthly.sqlite"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "[$(date)] Starting restore from: $BACKUP_FILE"

# 停服务（如果在运行）
echo "Stopping service..."
pm2 stop sign-workbench 2>/dev/null || echo "Service not running"

# 备份当前数据库
if [ -f "$DB_PATH" ]; then
  echo "Backing up current database..."
  mv "$DB_PATH" "$DB_PATH.before-restore-$(date +%Y%m%d-%H%M%S)"
fi

# 恢复
echo "Restoring database..."
gunzip -c "$BACKUP_FILE" > "$DB_PATH"

# 启服务
echo "Starting service..."
pm2 start sign-workbench 2>/dev/null || echo "Service not configured in PM2"

echo "[$(date)] Restore completed"
echo "Database restored to: $DB_PATH"
echo "Old database backed up with .before-restore suffix"
