#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gantt-app}"
DB_NAME="${DB_NAME:-gantt_app}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_PASSWORD="${DB_PASSWORD:-}"

latest="$(ls -1t "$BACKUP_DIR"/"${DB_NAME}"_*.sql.gz 2>/dev/null | awk 'NR==1{print $0}')"
if [[ -z "${latest:-}" ]]; then
  echo "No backup file found in $BACKUP_DIR"
  exit 1
fi

echo "Restoring from: $latest"
if [[ "$(id -u)" == "0" && "$DB_USER" == "postgres" && ("$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1") ]]; then
  gunzip -c "$latest" | sudo -u postgres psql "$DB_NAME"
else
  if [[ -n "$DB_PASSWORD" ]]; then
    gunzip -c "$latest" | PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
  else
    gunzip -c "$latest" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
  fi
fi
echo "Restore completed."
