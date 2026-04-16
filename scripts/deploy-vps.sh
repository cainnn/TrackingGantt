#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# 甘特图应用 VPS 部署脚本
#
# 常用命令（在项目根目录运行）：
#   npm run deploy:vps      正常部署（推荐，含备份+迁移+构建）
#   npm run deploy:fast     快速部署（跳过备份和迁移，仅代码更新）
#   npm run deploy:local    本地构建后上传（VPS 内存不足时使用）
#
# 其他用法：
#   bash scripts/deploy-vps.sh                  # 同 deploy:vps
#   VPS_PASS='密码' npm run deploy:vps          # 使用密码（需 expect）
#   bash scripts/deploy-vps.sh 1.2.3.4 root '密码'  # 指定参数
#
# 环境变量（均可选，有默认值）：
#   VPS_HOST      VPS IP/域名      默认 your-vps-ip
#   VPS_USER      SSH 用户          默认 root
#   VPS_PASS      SSH 密码          留空则用公钥
#   VPS_PORT      SSH 端口          默认 22
#   SSH_IDENTITY  指定私钥路径
#   APP_DIR       VPS 上安装目录    默认 /opt/gantt-app
#   NODE_ENV      构建环境          默认 production
#   SKIP_BACKUP   设为 1 跳过备份
#   SKIP_MIGRATE  设为 1 跳过数据库迁移
#   LOCAL_BUILD   设为 1 本地构建后上传（适合 VPS 内存不足）
# ──────────────────────────────────────────────────────────────────────

# --help 参数
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "甘特图应用 VPS 部署脚本"
  echo ""
  echo "常用命令："
  echo "  npm run deploy:vps      正常部署（推荐）"
  echo "  npm run deploy:fast     快速部署（跳过备份和迁移）"
  echo "  npm run deploy:local    本地构建后上传"
  echo ""
  echo "环境变量："
  echo "  VPS_HOST=IP             VPS 地址（默认 your-vps-ip）"
  echo "  VPS_PASS=密码           使用密码登录（默认用 SSH 公钥）"
  echo "  SKIP_BACKUP=1           跳过数据库备份"
  echo "  SKIP_MIGRATE=1          跳过数据库迁移"
  echo "  LOCAL_BUILD=1           本地构建后上传"
  echo ""
  echo "示例："
  echo "  npm run deploy:vps"
  echo "  SKIP_BACKUP=1 npm run deploy:vps"
  echo "  VPS_HOST=1.2.3.4 npm run deploy:vps"
  exit 0
fi

VPS_HOST="${1:-${VPS_HOST:-your-vps-ip}}"
VPS_USER="${2:-${VPS_USER:-root}}"
VPS_PASS="${3:-${VPS_PASS:-}}"
VPS_PORT="${VPS_PORT:-22}"
APP_NAME="gantt-app"
APP_DIR="${APP_DIR:-/opt/gantt-app}"
BACKUP_DIR="/var/backups/gantt-app"
KEEP_DAYS=7
LOCAL_BUILD="${LOCAL_BUILD:-0}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
SKIP_MIGRATE="${SKIP_MIGRATE:-0}"
REMOTE_TARGET="${VPS_USER}@${VPS_HOST}"
ARCHIVE="/tmp/${APP_NAME}-deploy.tar.gz"

[[ -n "${SSH_IDENTITY:-}" ]] && SSH_IDENTITY="${SSH_IDENTITY/#\~/$HOME}"

# ── SSH / SCP 封装 ──────────────────────────────────────────────────
SSH_COMMON_OPTS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
)
[[ -n "${SSH_IDENTITY:-}" ]] && SSH_COMMON_OPTS+=( -i "$SSH_IDENTITY" )

SSH_KEY_OPTS=( "${SSH_COMMON_OPTS[@]}" -p "$VPS_PORT" )
SCP_KEY_OPTS=( "${SSH_COMMON_OPTS[@]}" -P "$VPS_PORT" )

use_password=0
if [[ -n "$VPS_PASS" ]]; then
  use_password=1
elif ! ssh "${SSH_KEY_OPTS[@]}" "$REMOTE_TARGET" 'echo ok' &>/dev/null; then
  echo "====================================================="
  echo " 无法使用公钥登录 ${REMOTE_TARGET}:${VPS_PORT}"
  echo ""
  echo " 方式一（推荐）：配置免密登录后重试"
  echo "   ssh-copy-id -p ${VPS_PORT} ${REMOTE_TARGET}"
  echo ""
  echo " 方式二：使用密码部署"
  echo "   VPS_PASS='你的密码' npm run deploy:vps"
  echo "====================================================="
  exit 1
fi

if [[ "$use_password" -eq 1 ]] && ! command -v expect &>/dev/null; then
  echo "需要 expect 来处理密码登录。安装：brew install expect"
  exit 1
fi

do_ssh() {
  if [[ "$use_password" -eq 1 ]]; then
    expect <<EXPECT_EOF
set timeout -1
spawn ssh -o StrictHostKeyChecking=accept-new -p $VPS_PORT "$REMOTE_TARGET" "$1"
expect {
  -nocase -re "yes/no" { send "yes\r"; exp_continue }
  -nocase -re "assword:" { send -- "$VPS_PASS\r"; exp_continue }
  eof
}
catch wait result
exit [lindex \$result 3]
EXPECT_EOF
  else
    ssh "${SSH_KEY_OPTS[@]}" "$REMOTE_TARGET" "$1"
  fi
}

do_scp() {
  if [[ "$use_password" -eq 1 ]]; then
    expect <<EXPECT_EOF
set timeout 600
spawn scp -o StrictHostKeyChecking=accept-new -P $VPS_PORT "$1" "$2"
expect {
  -nocase -re "yes/no" { send "yes\r"; exp_continue }
  -nocase -re "assword:" { send -- "$VPS_PASS\r"; exp_continue }
  eof
}
catch wait result
exit [lindex \$result 3]
EXPECT_EOF
  else
    scp "${SCP_KEY_OPTS[@]}" "$1" "$2"
  fi
}

step=0
total_steps=4
[[ "$LOCAL_BUILD" -eq 1 ]] && total_steps=5
log() { step=$((step+1)); echo ""; echo "[$step/$total_steps] $1"; echo "----------------------------------------------"; }

# ── 部署前信息 ───────────────────────────────────────────────────
echo ""
echo "============================================="
echo " 甘特图 VPS 部署"
echo " 目标: ${REMOTE_TARGET}:${VPS_PORT} → ${APP_DIR}"
echo " 模式: $(
  [[ "$LOCAL_BUILD" -eq 1 ]] && echo "本地构建" || echo "远程构建"
) | 备份: $(
  [[ "$SKIP_BACKUP" -eq 1 ]] && echo "跳过" || echo "是"
) | 迁移: $(
  [[ "$SKIP_MIGRATE" -eq 1 ]] && echo "跳过" || echo "是"
)"
echo "============================================="

# ── Step: 本地构建（可选） ───────────────────────────────────────
if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  log "本地构建 (LOCAL_BUILD=1)..."
  npm run build
fi

# ── Step: 打包 ───────────────────────────────────────────────────
log "打包项目..."
EXCLUDES=(
  --exclude='node_modules'
  --exclude='.next'
  --exclude='.git'
  --exclude='.env'
  --exclude='.env.*'
  --exclude='.cursor'
  --exclude='*.log'
  --exclude='.DS_Store'
  --exclude='doc-pdf-output'
  --exclude='source-pdf-output'
)

if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  # 本地构建模式：包含 .next 和 node_modules
  EXCLUDES=( --exclude='.git' --exclude='.env' --exclude='.env.*' --exclude='.cursor' --exclude='*.log' --exclude='.DS_Store' )
fi

export COPYFILE_DISABLE=1
tar --no-mac-metadata "${EXCLUDES[@]}" -czf "$ARCHIVE" -C "$(pwd)/.." "$(basename "$(pwd)")" 2>/dev/null \
  || tar "${EXCLUDES[@]}" -czf "$ARCHIVE" -C "$(pwd)/.." "$(basename "$(pwd)")"
archive_size=$(du -h "$ARCHIVE" | cut -f1)
echo "打包完成: $archive_size"

# ── Step: 上传 ───────────────────────────────────────────────────
log "上传到 ${REMOTE_TARGET}:${VPS_PORT}..."
do_scp "$ARCHIVE" "${REMOTE_TARGET}:/tmp/${APP_NAME}-deploy.tar.gz"
echo "上传完成"

# ── Step: 生成远程脚本 ───────────────────────────────────────────
log "生成并上传远程部署脚本..."

REMOTE_SCRIPT="/tmp/${APP_NAME}-redeploy.sh"
TMP_SCRIPT="/tmp/${APP_NAME}-redeploy-local.sh"

cat > "$TMP_SCRIPT" <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="gantt-app"
APP_DIR="__APP_DIR__"
BACKUP_DIR="/var/backups/gantt-app"
KEEP_DAYS=7
SKIP_BACKUP="__SKIP_BACKUP__"
SKIP_MIGRATE="__SKIP_MIGRATE__"
LOCAL_BUILD="__LOCAL_BUILD__"

echo ""
echo "====== VPS 远程部署开始 ======"
echo "安装目录: $APP_DIR"
echo ""

# 备份数据库
if [[ "$SKIP_BACKUP" -ne 1 ]]; then
  echo ">> 备份数据库..."
  mkdir -p "$BACKUP_DIR"
  ts="$(date +%Y%m%d_%H%M%S)"
  backup_file="${BACKUP_DIR}/gantt_app_${ts}.sql.gz"
  if sudo -u postgres pg_dump gantt_app 2>/dev/null | gzip > "$backup_file"; then
    echo "   备份: $backup_file"
    find "$BACKUP_DIR" -type f -name 'gantt_app_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
  else
    echo "   (数据库不存在或备份跳过)"
  fi
fi

# 解压（先清理旧代码，保留 .env 和 node_modules）
echo ">> 清理旧代码并解压部署包..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"
# 保留 .env、node_modules、.next，删除其余代码文件
find "$APP_DIR" -maxdepth 1 -mindepth 1 \
  ! -name '.env' ! -name 'node_modules' ! -name '.next' \
  -exec rm -rf {} +
tar -xzf "/tmp/${APP_NAME}-deploy.tar.gz" -C "$APP_DIR" --strip-components=1
chmod -R a+rX "$APP_DIR" 2>/dev/null || true

# 停止服务
echo ">> 停止现有服务..."
pm2 stop "$APP_NAME" 2>/dev/null || true

# 环境文件
if [[ ! -f .env ]]; then
  echo ">> 生成 .env..."
  cat > .env <<ENVEOF
JWT_SECRET=gantt-vps-secret
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gantt_app
DB_USER=postgres
DB_PASSWORD=\${DB_PASSWORD:-changeme}
NODE_ENV=production
ENVEOF
fi

# 确保数据库存在
echo ">> 检查数据库..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'gantt_app'" | grep -q 1 || \
  sudo -u postgres createdb gantt_app
echo "   数据库 OK"

# 数据库迁移
if [[ "$SKIP_MIGRATE" -ne 1 ]] && [[ -f "$APP_DIR/scripts/init-db.sql" ]]; then
  echo ">> 运行数据库迁移..."
  sudo -u postgres psql -d gantt_app -v ON_ERROR_STOP=1 < "$APP_DIR/scripts/init-db.sql" 2>&1 | tail -3
  # 增量迁移脚本（按文件名排序执行，遇错即停）
  mig_count=0
  for mf in $(ls "$APP_DIR"/scripts/migrate-*.sql 2>/dev/null | sort); do
    [[ -f "$mf" ]] || continue
    echo "   运行迁移: $(basename "$mf")"
    sudo -u postgres psql -d gantt_app -v ON_ERROR_STOP=1 < "$mf" 2>&1 | tail -3
    mig_count=$((mig_count+1))
  done
  # 校验关键 schema：确保 tasks 表包含新增列
  required_cols=(constraint_type constraint_date deadline baseline_end_date project_boundary)
  for col in "${required_cols[@]}"; do
    exists=$(sudo -u postgres psql -d gantt_app -tAc \
      "SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='$col'")
    if [[ "$exists" != "1" ]]; then
      echo "   ✗ tasks.$col 未找到，迁移可能失败" >&2
      exit 1
    fi
  done
  echo "   迁移完成（增量 $mig_count 个，schema 校验通过）"
fi

# 安装依赖 + 构建
if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  echo ">> 跳过构建（使用本地构建产物）"
else
  echo ">> 安装依赖..."
  npm i 2>&1 | tail -3 || true
  echo ">> 构建..."
  npm run build
  echo "   构建完成"
fi

# 启动
echo ">> 启动服务..."
pm2 restart "$APP_NAME" 2>/dev/null || pm2 start npm --name "$APP_NAME" -- start
pm2 save 2>/dev/null || true

echo ""
echo "====== 部署完成 ======"
echo "访问: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '服务器IP'):3000"
echo ""
REMOTE_EOF

# 替换占位符
sed -i.bak "s|__APP_DIR__|${APP_DIR}|g" "$TMP_SCRIPT"
sed -i.bak "s|__SKIP_BACKUP__|${SKIP_BACKUP}|g" "$TMP_SCRIPT"
sed -i.bak "s|__SKIP_MIGRATE__|${SKIP_MIGRATE}|g" "$TMP_SCRIPT"
sed -i.bak "s|__LOCAL_BUILD__|${LOCAL_BUILD}|g" "$TMP_SCRIPT"
rm -f "${TMP_SCRIPT}.bak"
chmod +x "$TMP_SCRIPT"

do_scp "$TMP_SCRIPT" "${REMOTE_TARGET}:${REMOTE_SCRIPT}"

# ── Step: 执行远程部署 ───────────────────────────────────────────
log "执行远程部署..."
do_ssh "bash ${REMOTE_SCRIPT}"

# 清理本地临时文件
rm -f "$ARCHIVE" "$TMP_SCRIPT"

echo ""
echo "============================================="
echo " 部署成功！"
echo " 地址: http://${VPS_HOST}:3000"
echo "============================================="
