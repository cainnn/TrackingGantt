#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gantt-app}"
DB_NAME="${DB_NAME:-gantt_app}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_PASSWORD="${DB_PASSWORD:-}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

ts="$(date +%Y%m%d_%H%M%S)"
file="${BACKUP_DIR}/${DB_NAME}_${ts}.sql.gz"

if [[ "$(id -u)" == "0" && "$DB_USER" == "postgres" && ("$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1") ]]; then
  sudo -u postgres pg_dump "$DB_NAME" | gzip > "$file"
else
  if [[ -n "$DB_PASSWORD" ]]; then
    PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$file"
  else
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$file"
  fi
fi

find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +"$KEEP_DAYS" -delete

echo "Backup created: $file"
