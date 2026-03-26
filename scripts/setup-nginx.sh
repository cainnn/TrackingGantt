#!/bin/bash

# Nginx 配置脚本
# 用于在 Ubuntu VPS 上自动配置 Nginx

set -e

echo "================================"
echo "Nginx 配置脚本"
echo "================================"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

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
if [ "$EUID" -ne 0 ]; then
    print_error "请使用 root 用户或 sudo 运行此脚本"
    exit 1
fi

# 询问域名或 IP
echo ""
read -p "请输入域名或服务器 IP: " DOMAIN

if [ -z "$DOMAIN" ]; then
    print_error "域名或 IP 不能为空"
    exit 1
fi

# 安装 Nginx
if ! command -v nginx &> /dev/null; then
    print_warning "安装 Nginx..."
    apt update
    apt install -y nginx
    systemctl start nginx
    systemctl enable nginx
    print_success "Nginx 安装完成"
else
    print_success "Nginx 已安装"
fi

# 创建 Nginx 配置文件
NGINX_CONF="/etc/nginx/sites-available/gantt-app"
print_warning "创建 Nginx 配置文件..."

cat > "$NGINX_CONF" <<EOF
upstream gantt_backend {
    server localhost:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name $DOMAIN;

    # 日志文件
    access_log /var/log/nginx/gantt-app-access.log;
    error_log /var/log/nginx/gantt-app-error.log;

    location / {
        proxy_pass http://gantt_backend;
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

    # Bryntum 库静态文件（长期缓存）
    location /lib/gantt/ {
        proxy_pass http://gantt_backend/lib/gantt/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Next.js 静态文件
    location /_next/static/ {
        proxy_pass http://gantt_backend/_next/static/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # 健康检查端点
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
EOF

# 启用配置
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 测试配置
print_warning "测试 Nginx 配置..."
if nginx -t; then
    print_success "Nginx 配置测试通过"
else
    print_error "Nginx 配置测试失败"
    exit 1
fi

# 重启 Nginx
systemctl restart nginx
print_success "Nginx 已重启"

# 询问是否配置 SSL
echo ""
read -p "是否配置 SSL 证书 (HTTPS)？(需要有效域名) (y/n): " SETUP_SSL

if [ "$SETUP_SSL" = "y" ]; then
    # 安装 Certbot
    if ! command -v certbot &> /dev/null; then
        print_warning "安装 Certbot..."
        apt install -y certbot python3-certbot-nginx
    fi

    # 询问邮箱
    read -p "请输入邮箱 (用于证书提醒): " EMAIL

    if [ -z "$EMAIL" ]; then
        print_error "邮箱不能为空"
        exit 1
    fi

    # 获取证书
    print_warning "获取 SSL 证书..."
    certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive

    # 更新配置以启用 HTTPS 重定向
    cat > "$NGINX_CONF" <<EOF
upstream gantt_backend {
    server localhost:3000;
    keepalive 64;
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

# HTTPS 服务器
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL 证书
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/$DOMAIN/chain.pem;

    # SSL 配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # 安全头
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # 日志文件
    access_log /var/log/nginx/gantt-app-access.log;
    error_log /var/log/nginx/gantt-app-error.log;

    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/json application/javascript;

    location / {
        proxy_pass http://gantt_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /lib/gantt/ {
        proxy_pass http://gantt_backend/lib/gantt/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /_next/static/ {
        proxy_pass http://gantt_backend/_next/static/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
EOF

    # 重新加载 Nginx
    nginx -t && systemctl reload nginx
    print_success "SSL 证书配置完成"
fi

# 配置防火墙
if command -v ufw &> /dev/null; then
    print_warning "配置防火墙..."
    ufw allow 80/tcp
    ufw allow 443/tcp
    print_success "防火墙规则已添加"
fi

echo ""
echo "================================"
print_success "Nginx 配置完成！"
echo "================================"
echo ""
echo "访问地址:"
if [ "$SETUP_SSL" = "y" ]; then
    echo "  HTTPS: https://$DOMAIN"
fi
echo "  HTTP: http://$DOMAIN"
echo ""
echo "配置文件: $NGINX_CONF"
echo "日志文件: /var/log/nginx/gantt-app-*.log"
echo ""
echo "常用命令:"
echo "  - 测试配置: nginx -t"
echo "  - 重启服务: systemctl restart nginx"
echo "  - 查看日志: tail -f /var/log/nginx/gantt-app-access.log"
echo "  - 更新证书: certbot renew"
echo ""
