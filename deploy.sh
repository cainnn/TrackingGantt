#!/bin/bash

# 甘特图应用部署脚本
# 用于在 Ubuntu VPS 上部署应用

set -e

echo "================================"
echo "甘特图应用部署脚本"
echo "================================"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# 检查是否为 root 用户
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_error "请使用 root 用户或 sudo 运行此脚本"
        exit 1
    fi
}

# 更新系统
update_system() {
    echo ""
    print_warning "更新系统包..."
    apt update && apt upgrade -y
    print_success "系统更新完成"
}

# 安装 Docker
install_docker() {
    echo ""
    if command -v docker &> /dev/null; then
        print_success "Docker 已安装"
        docker --version
    else
        print_warning "安装 Docker..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        sh get-docker.sh
        systemctl start docker
        systemctl enable docker
        rm get-docker.sh
        print_success "Docker 安装完成"
    fi

    # 安装 Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        print_warning "安装 Docker Compose..."
        apt install -y docker-compose
        print_success "Docker Compose 安装完成"
    fi
}

# 安装 Nginx
install_nginx() {
    echo ""
    if command -v nginx &> /dev/null; then
        print_success "Nginx 已安装"
    else
        print_warning "安装 Nginx..."
        apt install -y nginx
        systemctl start nginx
        systemctl enable nginx
        print_success "Nginx 安装完成"
    fi
}

# 克隆或更新代码
setup_code() {
    echo ""
    print_warning "设置应用代码..."

    # 询问 GitHub 仓库 URL
    read -p "请输入 GitHub 仓库 URL (例如: https://github.com/cainnn/TrackingGantt.git): " REPO_URL

    if [ -z "$REPO_URL" ]; then
        print_error "仓库 URL 不能为空"
        exit 1
    fi

    # 创建应用目录
    APP_DIR="/var/www/gantt-app"
    mkdir -p /var/www

    if [ -d "$APP_DIR" ]; then
        print_warning "目录已存在，更新代码..."
        cd "$APP_DIR"
        git pull origin main
    else
        print_warning "克隆仓库..."
        git clone "$REPO_URL" "$APP_DIR"
        cd "$APP_DIR"
    fi

    print_success "代码设置完成"
}

# 配置环境变量
setup_env() {
    echo ""
    print_warning "配置环境变量..."

    cd /var/www/gantt-app

    if [ ! -f .env ]; then
        print_warning "创建 .env 文件..."
        cp .env.example .env

        # 生成随机 JWT 密钥
        JWT_SECRET=$(openssl rand -base64 32)
        sed -i "s/your-super-secret-jwt-key-change-this-in-production/$JWT_SECRET/" .env

        print_warning "请修改 .env 文件中的数据库密码（当前为默认密码）"
        read -p "是否现在编辑 .env 文件？(y/n): " EDIT_ENV
        if [ "$EDIT_ENV" = "y" ]; then
            vim .env
        fi
    else
        print_success ".env 文件已存在"
    fi
}

# 启动 Docker 容器
start_containers() {
    echo ""
    print_warning "启动 Docker 容器..."
    cd /var/www/gantt-app

    # 停止旧容器
    docker-compose down 2>/dev/null || true

    # 构建并启动
    docker-compose up -d --build

    # 等待容器启动
    sleep 5

    # 显示容器状态
    docker-compose ps
    print_success "容器启动完成"
}

# 配置防火墙
setup_firewall() {
    echo ""
    print_warning "配置防火墙..."

    if command -v ufw &> /dev/null; then
        ufw allow 22/tcp
        ufw allow 80/tcp
        ufw allow 443/tcp
        ufw --force enable
        print_success "防火墙配置完成"
    else
        print_warning "UFW 未安装，跳过防火墙配置"
    fi
}

# 配置 Nginx 反向代理
setup_nginx() {
    echo ""
    print_warning "配置 Nginx..."

    # 询问域名
    read -p "请输入域名 (例如: example.com，留空则使用 IP): " DOMAIN

    if [ -z "$DOMAIN" ]; then
        DOMAIN="_"
    fi

    # 创建 Nginx 配置
    cat > /etc/nginx/sites-available/gantt-app <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

    # 启用配置
    ln -sf /etc/nginx/sites-available/gantt-app /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    # 测试配置
    nginx -t
    systemctl restart nginx
    print_success "Nginx 配置完成"
}

# 配置 SSL（可选）
setup_ssl() {
    echo ""
    read -p "是否配置 SSL 证书？(需要域名) (y/n): " SETUP_SSL

    if [ "$SETUP_SSL" = "y" ]; then
        if ! command -v certbot &> /dev/null; then
            print_warning "安装 Certbot..."
            apt install -y certbot python3-certbot-nginx
        fi

        read -p "请输入域名: " SSL_DOMAIN
        read -p "请输入邮箱 (用于证书提醒): " EMAIL

        certbot --nginx -d "$SSL_DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
        print_success "SSL 证书配置完成"
    fi
}

# 显示部署信息
show_info() {
    echo ""
    echo "================================"
    print_success "部署完成！"
    echo "================================"
    echo ""
    echo "应用信息:"
    echo "  - 目录: /var/www/gantt-app"
    echo "  - 访问: http://your-server-ip"
    echo ""
    echo "常用命令:"
    echo "  - 查看日志: cd /var/www/gantt-app && docker-compose logs -f"
    echo "  - 重启应用: cd /var/www/gantt-app && docker-compose restart"
    echo "  - 停止应用: cd /var/www/gantt-app && docker-compose down"
    echo "  - 更新代码: cd /var/www/gantt-app && git pull && docker-compose up -d --build"
    echo ""
    print_warning "默认管理员账户需要手动创建"
    print_warning "请修改数据库密码和 JWT_SECRET"
    echo ""
}

# 主函数
main() {
    check_root
    update_system
    install_docker
    install_nginx
    setup_code
    setup_env
    setup_firewall
    start_containers
    setup_nginx
    setup_ssl
    show_info
}

# 运行主函数
main
