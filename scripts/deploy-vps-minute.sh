#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# 甘特图应用 VPS 部署脚本（分钟级开发分支）
#
# 与 deploy-vps.sh 的区别：
#   • 分支：feature/minute-timeline（而非 main）
#   • 应用：gantt-app-minute（独立 PM2 进程）
#   • 目录：/opt/gantt-app-minute
#   • 数据库：gantt_app_minute（独立 DB，不污染线上）
#   • 端口：3001
#
# 常用命令（在项目根目录运行）：
#   npm run deploy:vps:minute       正常部署
#   npm run deploy:fast:minute      快速部署（跳过备份和迁移）
#   npm run deploy:local:minute     本地构建后上传
#
# 环境变量（均可选，有默认值）：
#   VPS_HOST      VPS IP/域名      默认 159.75.40.209
#   VPS_USER      SSH 用户          默认 root
#   VPS_PASS      SSH 密码          留空则用公钥
#   VPS_PORT      SSH 端口          默认 22
#   SSH_IDENTITY  指定私钥路径
#   APP_DIR       VPS 上安装目录    默认 /opt/gantt-app-minute
#   APP_PORT      应用端口          默认 3001
#   NODE_ENV      构建环境          默认 production
#   SKIP_BACKUP   设为 1 跳过备份
#   SKIP_MIGRATE  设为 1 跳过数据库迁移
#   LOCAL_BUILD   设为 1 本地构建后上传
#
# 安全开关：
#   ALLOW_NON_MINUTE=1   允许非 feature/minute-timeline 分支部署
#   ALLOW_DIRTY=1        允许带未提交改动部署
# ──────────────────────────────────────────────────────────────────────

# --help 参数
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "甘特图应用 VPS 部署脚本（分钟级分支）"
  echo ""
  echo "常用命令："
  echo "  npm run deploy:vps:minute      正常部署（推荐）"
  echo "  npm run deploy:fast:minute     快速部署（跳过备份和迁移）"
  echo "  npm run deploy:local:minute    本地构建后上传"
  echo ""
  echo "目标："
  echo "  分支:   feature/minute-timeline"
  echo "  应用:   gantt-app-minute"
  echo "  目录:   /opt/gantt-app-minute"
  echo "  数据库: gantt_app_minute"
  echo "  端口:   3001"
  echo ""
  echo "安全开关："
  echo "  ALLOW_NON_MINUTE=1     允许非 feature/minute-timeline 分支部署"
  echo "  ALLOW_DIRTY=1          允许带未提交改动部署"
  exit 0
fi

# 分支与工作区校验：仅允许从 feature/minute-timeline 部署
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "$CURRENT_BRANCH" != "feature/minute-timeline" ]] && [[ "${ALLOW_NON_MINUTE:-0}" != "1" ]]; then
  echo "❌ 当前分支是 '$CURRENT_BRANCH'，只允许从 feature/minute-timeline 部署"
  echo "   切到分支：git checkout feature/minute-timeline"
  echo "   或强制部署：ALLOW_NON_MINUTE=1 npm run deploy:vps:minute"
  exit 1
fi
if [[ -n "$(git status --porcelain 2>/dev/null)" ]] && [[ "${ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "❌ 工作区有未提交的改动，先 commit 或 stash 再部署"
  git status --short
  echo "   或强制部署：ALLOW_DIRTY=1 npm run deploy:vps:minute"
  exit 1
fi

VPS_HOST="${1:-${VPS_HOST:-159.75.40.209}}"
VPS_USER="${2:-${VPS_USER:-root}}"
VPS_PASS="${3:-${VPS_PASS:-}}"
VPS_PORT="${VPS_PORT:-22}"
APP_NAME="gantt-app-minute"
APP_DIR="${APP_DIR:-/opt/gantt-app-minute}"
APP_PORT="${APP_PORT:-3001}"
DB_NAME="gantt_app_minute"
BACKUP_DIR="/var/backups/gantt-app-minute"
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
  echo "   VPS_PASS='你的密码' npm run deploy:vps:minute"
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
echo " 甘特图 VPS 部署（分钟级分支）"
echo " 目标:   ${REMOTE_TARGET}:${VPS_PORT} → ${APP_DIR}"
echo " 应用:   ${APP_NAME} @ :${APP_PORT}"
echo " 数据库: ${DB_NAME}"
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

APP_NAME="gantt-app-minute"
APP_DIR="__APP_DIR__"
APP_PORT="__APP_PORT__"
DB_NAME="__DB_NAME__"
BACKUP_DIR="/var/backups/gantt-app-minute"
KEEP_DAYS=7
SKIP_BACKUP="__SKIP_BACKUP__"
SKIP_MIGRATE="__SKIP_MIGRATE__"
LOCAL_BUILD="__LOCAL_BUILD__"

echo ""
echo "====== VPS 远程部署开始（分钟级）======"
echo "安装目录: $APP_DIR"
echo "数据库:   $DB_NAME"
echo "端口:     $APP_PORT"
echo ""

# 备份数据库
if [[ "$SKIP_BACKUP" -ne 1 ]]; then
  echo ">> 备份数据库..."
  mkdir -p "$BACKUP_DIR"
  ts="$(date +%Y%m%d_%H%M%S)"
  backup_file="${BACKUP_DIR}/${DB_NAME}_${ts}.sql.gz"
  if sudo -u postgres pg_dump "$DB_NAME" 2>/dev/null | gzip > "$backup_file"; then
    echo "   备份: $backup_file"
    find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +"$KEEP_DAYS" -delete
  else
    echo "   (数据库不存在或备份跳过)"
  fi
fi

# 解压（先清理旧代码，保留 .env 和 node_modules）
echo ">> 清理旧代码并解压部署包..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"
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
JWT_SECRET=gantt-vps-secret-minute
DB_HOST=localhost
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=postgres
DB_PASSWORD=\${DB_PASSWORD:-changeme}
NODE_ENV=production
PORT=${APP_PORT}
ENVEOF
fi

# 确保数据库存在
echo ">> 检查数据库..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb "$DB_NAME"
echo "   数据库 OK ($DB_NAME)"

# 数据库迁移
if [[ "$SKIP_MIGRATE" -ne 1 ]] && [[ -f "$APP_DIR/scripts/init-db.sql" ]]; then
  echo ">> 运行数据库迁移..."
  sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$APP_DIR/scripts/init-db.sql" 2>&1 | tail -3
  mig_count=0
  for mf in $(ls "$APP_DIR"/scripts/migrate-*.sql 2>/dev/null | sort); do
    [[ -f "$mf" ]] || continue
    echo "   运行迁移: $(basename "$mf")"
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$mf" 2>&1 | tail -3
    mig_count=$((mig_count+1))
  done
  required_cols=(constraint_type constraint_date deadline baseline_end_date project_boundary)
  for col in "${required_cols[@]}"; do
    exists=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
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

# 启动（指定端口）
echo ">> 启动服务 @ :${APP_PORT}..."
pm2 delete "$APP_NAME" 2>/dev/null || true
PORT="$APP_PORT" pm2 start npm --name "$APP_NAME" -- start
pm2 save 2>/dev/null || true

echo ""
echo "====== 部署完成 ======"
echo "访问: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '服务器IP'):${APP_PORT}"
echo ""
REMOTE_EOF

# 替换占位符
sed -i.bak "s|__APP_DIR__|${APP_DIR}|g" "$TMP_SCRIPT"
sed -i.bak "s|__APP_PORT__|${APP_PORT}|g" "$TMP_SCRIPT"
sed -i.bak "s|__DB_NAME__|${DB_NAME}|g" "$TMP_SCRIPT"
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
echo " 部署成功！（分钟级分支）"
echo " 地址: http://${VPS_HOST}:${APP_PORT}"
echo "============================================="
