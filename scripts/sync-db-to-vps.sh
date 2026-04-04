#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# 本地数据库 → VPS 数据库同步脚本
#
# 用法：
#   bash scripts/sync-db-to-vps.sh              # 全量同步
#   bash scripts/sync-db-to-vps.sh --data-only  # 仅数据（不含表结构）
#   npm run sync:db                              # 通过 npm 运行
#
# 环境变量（均可选）：
#   VPS_HOST       默认 your-vps-ip
#   VPS_USER       默认 root
#   VPS_PORT       默认 22
#   LOCAL_DB       本地数据库名   默认 gantt_app
#   LOCAL_USER     本地数据库用户 默认 postgres
#   LOCAL_PASS     本地数据库密码 默认 changeme
#   REMOTE_DB      VPS数据库名    默认 gantt_app
#   REMOTE_DBUSER  VPS数据库用户  默认 postgres
# ──────────────────────────────────────────────────────────────────────

VPS_HOST="${VPS_HOST:-your-vps-ip}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
LOCAL_DB="${LOCAL_DB:-gantt_app}"
LOCAL_USER="${LOCAL_USER:-postgres}"
LOCAL_PASS="${LOCAL_PASS:-changeme}"
REMOTE_DB="${REMOTE_DB:-gantt_app}"
REMOTE_DBUSER="${REMOTE_DBUSER:-postgres}"

DATA_ONLY=0
[[ "${1:-}" == "--data-only" ]] && DATA_ONLY=1

REMOTE="${VPS_USER}@${VPS_HOST}"
DUMP_FILE="/tmp/gantt_sync_$(date +%Y%m%d_%H%M%S).sql"
REMOTE_DUMP="/tmp/gantt_sync_import.sql"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p "$VPS_PORT")

echo "========================================"
echo " 本地 → VPS 数据库同步"
echo "========================================"
echo " 本地: ${LOCAL_USER}@localhost/${LOCAL_DB}"
echo " 远程: ${REMOTE_DBUSER}@${VPS_HOST}/${REMOTE_DB}"
echo ""

# ── 1. 导出本地数据库 ──────────────────────────────────────────────
echo "[1/4] 导出本地数据库..."

PG_DUMP_OPTS=(
  -U "$LOCAL_USER"
  -d "$LOCAL_DB"
  --no-owner
  --no-privileges
  --no-comments
  --if-exists
)

if [[ "$DATA_ONLY" -eq 1 ]]; then
  PG_DUMP_OPTS+=(--data-only --disable-triggers)
  echo "  模式: 仅数据 (--data-only)"
else
  PG_DUMP_OPTS+=(--clean)
  echo "  模式: 全量 (结构+数据)"
fi

PGPASSWORD="$LOCAL_PASS" pg_dump "${PG_DUMP_OPTS[@]}" > "$DUMP_FILE"

dump_size=$(du -h "$DUMP_FILE" | cut -f1)
echo "  导出完成: $DUMP_FILE ($dump_size)"

# ── 2. VPS 自动备份 ───────────────────────────────────────────────
echo "[2/4] VPS 端备份现有数据库..."
ssh "${SSH_OPTS[@]}" "$REMOTE" bash <<'BACKUP_EOF'
set -e
ts=$(date +%Y%m%d_%H%M%S)
backup_dir="/var/backups/gantt-app"
mkdir -p "$backup_dir"
if sudo -u postgres psql -lqt | grep -qw gantt_app; then
  sudo -u postgres pg_dump gantt_app | gzip > "${backup_dir}/pre_sync_${ts}.sql.gz"
  echo "  备份完成: ${backup_dir}/pre_sync_${ts}.sql.gz"
  # 保留最近 10 个备份
  ls -t "${backup_dir}"/pre_sync_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm
else
  echo "  远程数据库不存在，跳过备份"
fi
BACKUP_EOF

# ── 3. 上传 dump 文件 ────────────────────────────────────────────
echo "[3/4] 上传到 VPS..."
scp -o StrictHostKeyChecking=accept-new -P "$VPS_PORT" "$DUMP_FILE" "${REMOTE}:${REMOTE_DUMP}"
echo "  上传完成"

# ── 4. VPS 端导入 ────────────────────────────────────────────────
echo "[4/4] VPS 端导入数据..."
ssh "${SSH_OPTS[@]}" "$REMOTE" bash <<IMPORT_EOF
set -e

# 确保数据库存在
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${REMOTE_DB}'" | grep -q 1 || \
  sudo -u postgres createdb "${REMOTE_DB}"

# 导入
sudo -u postgres psql -d "${REMOTE_DB}" -v ON_ERROR_STOP=0 < "${REMOTE_DUMP}" 2>&1 | \
  grep -v "^SET\|^$\|NOTICE\|already exists\|does not exist" | tail -5 || true

echo "  导入完成"

# 清理
rm -f "${REMOTE_DUMP}"
IMPORT_EOF

# 清理本地临时文件
rm -f "$DUMP_FILE"

echo ""
echo "========================================"
echo " 同步完成！"
echo " VPS: http://${VPS_HOST}:3000"
echo "========================================"
