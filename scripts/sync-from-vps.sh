#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# sync-from-vps.sh
# 从 VPS 远程 PostgreSQL 拉取数据，覆盖本地数据库
#
# 用法:
#   ./scripts/sync-from-vps.sh <VPS_HOST>
#   # 或通过环境变量:
#   VPS_HOST=1.2.3.4 ./scripts/sync-from-vps.sh
# ============================================================

# ---------- 远程 (VPS) 数据库配置 ----------
VPS_HOST="${1:-${VPS_HOST:-159.75.40.209}}"
VPS_PORT="${VPS_PORT:-5432}"
VPS_DB="${VPS_DB:-gantt_app}"
VPS_USER="${VPS_USER:-postgres}"
VPS_PASSWORD="${VPS_PASSWORD:11111a}"

# ---------- 本地数据库配置 ----------
LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="${LOCAL_PORT:-5432}"
LOCAL_DB="${LOCAL_DB:-gantt_app}"
LOCAL_USER="${LOCAL_USER:-postgres}"
LOCAL_PASSWORD="${LOCAL_PASSWORD:11111a}"

# ---------- 临时文件 ----------
DUMP_FILE="/tmp/gantt_vps_dump_$(date +%Y%m%d_%H%M%S).sql"

# ---------- 检查参数 ----------
if [[ -z "$VPS_HOST" ]]; then
  echo "错误: 请提供 VPS 地址"
  echo "用法: $0 <VPS_HOST>"
  echo "  例: $0 1.2.3.4"
  echo "  或: VPS_HOST=1.2.3.4 $0"
  exit 1
fi

echo "======================================"
echo "  甘特图数据库同步: VPS → 本地"
echo "======================================"
echo "远程: ${VPS_USER}@${VPS_HOST}:${VPS_PORT}/${VPS_DB}"
echo "本地: ${LOCAL_USER}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DB}"
echo ""

# ---------- 确认操作 ----------
read -p "⚠️  此操作将覆盖本地数据库，是否继续? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "已取消。"
  exit 0
fi

# ---------- 步骤 1: 从 VPS 导出数据 ----------
echo ""
echo "[1/3] 从 VPS 导出数据库..."
PGPASSWORD="$VPS_PASSWORD" pg_dump \
  -h "$VPS_HOST" \
  -p "$VPS_PORT" \
  -U "$VPS_USER" \
  -d "$VPS_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  -F p \
  -f "$DUMP_FILE"

dump_size=$(du -h "$DUMP_FILE" | cut -f1)
echo "   导出完成 ($dump_size)"

# ---------- 步骤 2: 确保本地数据库存在 ----------
echo "[2/3] 准备本地数据库..."
PGPASSWORD="$LOCAL_PASSWORD" psql \
  -h "$LOCAL_HOST" \
  -p "$LOCAL_PORT" \
  -U "$LOCAL_USER" \
  -d "postgres" \
  -tc "SELECT 1 FROM pg_database WHERE datname = '$LOCAL_DB'" \
  | grep -q 1 || \
PGPASSWORD="$LOCAL_PASSWORD" createdb \
  -h "$LOCAL_HOST" \
  -p "$LOCAL_PORT" \
  -U "$LOCAL_USER" \
  "$LOCAL_DB"

# ---------- 步骤 3: 导入到本地数据库 ----------
echo "[3/3] 导入到本地数据库..."
PGPASSWORD="$LOCAL_PASSWORD" psql \
  -h "$LOCAL_HOST" \
  -p "$LOCAL_PORT" \
  -U "$LOCAL_USER" \
  -d "$LOCAL_DB" \
  -f "$DUMP_FILE" \
  --quiet \
  -v ON_ERROR_STOP=0

echo ""
echo "======================================"
echo "  同步完成!"
echo "======================================"

# ---------- 显示表统计 ----------
echo ""
echo "本地数据库表记录数:"
PGPASSWORD="$LOCAL_PASSWORD" psql \
  -h "$LOCAL_HOST" \
  -p "$LOCAL_PORT" \
  -U "$LOCAL_USER" \
  -d "$LOCAL_DB" \
  -c "
    SELECT schemaname || '.' || relname AS table_name,
           n_live_tup AS row_count
    FROM pg_stat_user_tables
    ORDER BY relname;
  "

# ---------- 清理临时文件 ----------
rm -f "$DUMP_FILE"
echo "临时文件已清理。"
