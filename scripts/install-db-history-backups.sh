#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { echo 'Run this installer as root on the PostgreSQL server.' >&2; exit 1; }
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
for tool in python3 psql pg_dump pg_restore runuser systemctl crontab; do
  command -v "$tool" >/dev/null
done
# Validate configuration before writing any files or touching existing schedules.
python3 - "$root_dir" <<'PY'
import os, sys
sys.path.insert(0, sys.argv[1] + '/scripts')
from importlib.machinery import SourceFileLoader
module = SourceFileLoader('history', sys.argv[1] + '/scripts/db-history-backup.py').load_module()
module.identifier(os.environ.get('DB_NAME', 'gantt_app'))
PY
install -d -m 700 /usr/local/lib/gantt-db-history /var/lib/gantt-db-history
install -m 700 "$root_dir/scripts/db-history-backup.py" /usr/local/lib/gantt-db-history/db-history-backup.py
if [[ ! -f /etc/gantt-db-history.env ]]; then
  install -m 600 /dev/null /etc/gantt-db-history.env
  cat > /etc/gantt-db-history.env <<EOF
DB_NAME=${DB_NAME:-gantt_app}
DB_PORT=5432
APP_TIME_ZONE=Asia/Shanghai
BACKUP_DIR=/var/backups/gantt-app
STATE_DIR=/var/lib/gantt-db-history
EOF
fi
install -m 644 "$root_dir/deploy/gantt-db-history@.service" /etc/systemd/system/gantt-db-history@.service
install -m 644 "$root_dir/deploy/gantt-db-history@.timer" /etc/systemd/system/gantt-db-history@.timer
systemd-analyze verify /etc/systemd/system/gantt-db-history@.service /etc/systemd/system/gantt-db-history@.timer
systemctl daemon-reload
# Validate both dates by actually restoring before retiring the old daily cron.
systemctl start gantt-db-history@day1.service
systemctl start gantt-db-history@day7.service
systemctl enable --now gantt-db-history@day1.timer gantt-db-history@day7.timer

python3 - <<'PY'
import datetime, os, pathlib, subprocess
result = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
if result.returncode not in (0, 1):
    raise RuntimeError(result.stderr)
lines = result.stdout.splitlines(keepends=True)
old = '0 3 * * * BACKUP_DIR=/var/backups/gantt-app DB_NAME=gantt_app DB_USER=postgres DB_HOST=localhost DB_PORT=5432 KEEP_DAYS=7 /opt/gantt-app/scripts/db-backup.sh >> /var/log/gantt-db-backup.log 2>&1'
filtered = [line for line in lines if line.strip() != old]
if filtered != lines:
    path = pathlib.Path('/var/lib/gantt-db-history') / ('crontab-before-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    path.write_text(result.stdout)
    path.chmod(0o600)
    subprocess.run(['crontab', '-'], input=''.join(filtered), text=True, check=True)
    print('Replaced the previous 03:00 backup cron; saved original at', path)
PY
systemctl list-timers 'gantt-db-history@*' --all --no-pager
echo 'Queryable snapshot metadata: /var/lib/gantt-db-history/{day1,day7}.json'
