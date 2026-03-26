# 甘特图管理系统 - VPS 部署指南

本文档提供详细的 Ubuntu VPS 部署步骤，使用 Docker 和 Docker Compose 进行容器化部署。

## 📋 目录

- [系统要求](#系统要求)
- [快速部署（推荐）](#快速部署推荐)
- [手动部署](#手动部署)
- [配置说明](#配置说明)
- [管理命令](#管理命令)
- [故障排查](#故障排查)
- [安全建议](#安全建议)

## 系统要求

- **操作系统**: Ubuntu 20.04+ / Debian 10+
- **内存**: 最低 2GB RAM（推荐 4GB）
- **磁盘**: 最低 20GB 可用空间
- **权限**: root 或 sudo 权限

## 快速部署（推荐）

### 一键自动部署

```bash
# 连接到 VPS
ssh root@your-vps-ip

# 运行自动部署脚本
curl -fsSL https://raw.githubusercontent.com/cainnn/TrackingGantt/main/deploy.sh | bash
```

自动部署脚本会完成以下操作：
- ✅ 系统更新
- ✅ 安装 Docker 和 Docker Compose
- ✅ 安装 Nginx
- ✅ 克隆项目代码
- ✅ 配置环境变量
- ✅ 启动 Docker 容器
- ✅ 配置 Nginx 反向代理
- ✅ 配置防火墙
- ✅ 配置 SSL 证书（可选）

## 手动部署

### 步骤 1: 准备系统环境

```bash
# 更新系统包
apt update && apt upgrade -y

# 安装基础工具
apt install -y curl git vim ufw

# 设置时区（可选）
timedatectl set-timezone Asia/Shanghai
```

### 步骤 2: 安装 Docker

```bash
# 下载并安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# 启动 Docker 服务
systemctl start docker
systemctl enable docker

# 验证安装
docker --version
# 输出: Docker version 27.x.x
```

### 步骤 3: 安装 Docker Compose

```bash
# 安装 Docker Compose
apt install -y docker-compose

# 验证安装
docker-compose --version
# 输出: Docker Compose version v2.x.x
```

### 步骤 4: 克隆项目代码

```bash
# 创建项目目录
mkdir -p /var/www
cd /var/www

# 克隆 GitHub 仓库
git clone https://github.com/cainnn/TrackingGantt.git gantt-app

# 进入项目目录
cd gantt-app

# 查看项目结构
ls -la
```

### 步骤 5: 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑环境变量文件
vim .env
```

**环境变量配置说明：**

```env
# ================================
# 数据库配置
# ================================
# Docker 环境下使用服务名称作为主机名
DB_HOST=postgres
DB_PORT=5432
DB_NAME=gantt_app
DB_USER=postgres

# ⚠️ 生产环境必须修改默认密码
DB_PASSWORD=your-strong-password-here

# ================================
# 应用配置
# ================================
APP_PORT=3000
NODE_ENV=production

# ================================
# JWT 密钥配置
# ================================
# ⚠️ 必须修改为强密钥！可以使用以下命令生成：
# openssl rand -base64 32
JWT_SECRET=your-super-secret-jwt-key-change-this
```

**生成安全的 JWT 密钥：**
```bash
openssl rand -base64 32
```

### 步骤 6: 启动应用容器

```bash
# 构建并启动所有服务
docker-compose up -d --build

# 查看容器状态
docker-compose ps

# 查看应用日志（可选）
docker-compose logs -f app
```

**预期输出：**
```
NAME                IMAGE                      STATUS
gantt-postgres      postgres:18-alpine         Up (healthy)
gantt-app           gantt-app-app              Up
```

### 步骤 7: 初始化数据库

```bash
# 等待 PostgreSQL 完全启动
sleep 10

# 运行数据库初始化脚本
docker-compose exec app node scripts/init-db.js
```

### 步骤 8: 创建管理员用户

**方式一：使用脚本创建**
```bash
# 设置执行权限
chmod +x scripts/docker-create-admin.sh

# 运行创建脚本
./scripts/docker-create-admin.sh
```

按提示输入：
- 用户名（例如：admin）
- 密码（建议使用强密码）
- 邮箱

**方式二：手动在容器中创建**
```bash
docker-compose exec app node scripts/create-admin-user.js
```

### 步骤 9: 配置防火墙

```bash
# 安装 UFW（如果未安装）
apt install -y ufw

# 配置防火墙规则
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS

# 启用防火墙
ufw --force enable

# 查看防火墙状态
ufw status
```

### 步骤 10: 验证部署

```bash
# 检查容器状态
docker-compose ps

# 测试应用响应
curl http://localhost:3000

# 查看应用日志
docker-compose logs app --tail=50
```

现在可以通过 `http://your-vps-ip:3000` 访问应用。

---

## 配置 Nginx 反向代理（推荐）

### 使用自动脚本配置

```bash
# 进入项目目录
cd /var/www/gantt-app

# 运行 Nginx 配置脚本
chmod +x scripts/setup-nginx.sh
./scripts/setup-nginx.sh
```

按提示输入：
- 域名（例如：gantt.example.com）或服务器 IP
- 是否配置 SSL 证书
- 邮箱地址（用于 SSL 证书提醒）

### 手动配置 Nginx

```bash
# 安装 Nginx
apt install -y nginx

# 复制配置文件
cp nginx.conf /etc/nginx/sites-available/gantt-app

# 编辑配置文件
vim /etc/nginx/sites-available/gantt-app
```

修改 `server_name` 为你的域名或 IP：
```nginx
server {
    listen 80;
    server_name your-domain.com;  # 修改为你的域名或 IP
    ...
}
```

```bash
# 启用配置
ln -s /etc/nginx/sites-available/gantt-app /etc/nginx/sites-enabled/

# 删除默认配置
rm -f /etc/nginx/sites-enabled/default

# 测试配置
nginx -t

# 重启 Nginx
systemctl restart nginx
```

### 配置 SSL 证书（HTTPS）

```bash
# 安装 Certbot
apt install -y certbot python3-certbot-nginx

# 获取并配置 SSL 证书
certbot --nginx -d your-domain.com -d www.your-domain.com
```

按提示输入：
- 邮箱地址
- 同意服务条款
- 是否共享邮箱信息

SSL 证书会自动配置，并设置自动续期。

---

## 管理命令

### Docker Compose 常用命令

```bash
# 查看容器状态
docker-compose ps

# 查看所有容器日志
docker-compose logs

# 查看应用日志
docker-compose logs -f app

# 查看数据库日志
docker-compose logs -f postgres

# 重启应用
docker-compose restart app

# 重启数据库
docker-compose restart postgres

# 停止所有服务
docker-compose down

# 启动所有服务
docker-compose up -d

# 重新构建并启动
docker-compose up -d --build
```

### 代码更新

```bash
# 进入项目目录
cd /var/www/gantt-app

# 拉取最新代码
git pull origin main

# 重新构建并启动
docker-compose up -d --build

# 查看更新后的日志
docker-compose logs -f app
```

### 数据库管理

```bash
# 进入 PostgreSQL 容器
docker-compose exec postgres psql -U postgres -d gantt_app

# 在数据库内可以执行 SQL 命令
\dt                          # 查看所有表
SELECT * FROM users;         # 查看用户
SELECT * FROM projects;      # 查看项目
\q                           # 退出
```

### 备份数据库

```bash
# 备份数据库到文件
docker-compose exec postgres pg_dump -U postgres gantt_app > backup_$(date +%Y%m%d_%H%M%S).sql

# 恢复数据库
docker-compose exec -T postgres psql -U postgres gantt_app < backup_20240326_120000.sql
```

### 容器管理

```bash
# 进入应用容器
docker-compose exec app sh

# 查看容器资源使用
docker stats

# 清理未使用的镜像和容器
docker system prune -a
```

---

## 故障排查

### 问题 1: 容器无法启动

**症状：**
```bash
docker-compose ps
# 显示 Exit 或 Restarting 状态
```

**解决方法：**
```bash
# 查看详细日志
docker-compose logs app

# 检查端口占用
netstat -tulpn | grep :3000
netstat -tulpn | grep :5432

# 检查磁盘空间
df -h

# 重新构建
docker-compose down
docker-compose up -d --build
```

### 问题 2: 数据库连接失败

**症状：**
应用日志显示 "connection refused" 或 "ECONNREFUSED"

**解决方法：**
```bash
# 检查环境变量配置
cat .env | grep DB_

# 确认数据库容器运行
docker-compose ps postgres

# 测试数据库连接
docker-compose exec postgres pg_isready -U postgres

# 重启数据库容器
docker-compose restart postgres

# 等待数据库完全启动
sleep 10
docker-compose restart app
```

### 问题 3: Nginx 502 Bad Gateway

**症状：**
浏览器显示 "502 Bad Gateway"

**解决方法：**
```bash
# 检查应用容器是否运行
docker-compose ps app

# 检查应用日志
docker-compose logs app

# 检查 Nginx 配置
nginx -t

# 查看 Nginx 错误日志
tail -f /var/log/nginx/gantt-app-error.log

# 重启服务
systemctl restart nginx
docker-compose restart app
```

### 问题 4: 内存不足

**症状：**
容器频繁重启，日志显示 "Killed"

**解决方法：**
```bash
# 检查内存使用
free -h

# 添加 Swap 空间
dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 重启 Docker
systemctl restart docker
docker-compose up -d
```

### 问题 5: 无法访问应用

**检查清单：**
```bash
# 1. 检查容器状态
docker-compose ps

# 2. 检查防火墙
ufw status

# 3. 检查端口监听
netstat -tulpn | grep :3000

# 4. 测试本地访问
curl http://localhost:3000

# 5. 检查 Nginx 配置（如果使用）
nginx -t
systemctl status nginx
```

---

## 安全建议

### 1. 修改默认密码

```bash
# 编辑环境变量
vim /var/www/gantt-app/.env

# 修改以下配置：
# - DB_PASSWORD（数据库密码）
# - JWT_SECRET（JWT 密钥）
```

### 2. 配置防火墙

```bash
# 只开放必要端口
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw enable
```

### 3. 启用 HTTPS

```bash
# 使用 Let's Encrypt 免费 SSL 证书
certbot --nginx -d your-domain.com
```

### 4. 限制 SSH 访问

```bash
# 编辑 SSH 配置
vim /etc/ssh/sshd_config

# 修改以下配置：
# PermitRootLogin no
# PasswordAuthentication no
# PubkeyAuthentication yes

# 重启 SSH
systemctl restart sshd
```

### 5. 定期备份数据

```bash
# 创建备份脚本
cat > /root/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/root/backups"
mkdir -p $BACKUP_DIR
docker-compose exec postgres pg_dump -U postgres gantt_app > $BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).sql
# 只保留最近 7 天的备份
find $BACKUP_DIR -name "backup_*.sql" -mtime +7 -delete
EOF

chmod +x /root/backup.sh

# 添加到 crontab（每天凌晨 2 点备份）
echo "0 2 * * * /root/backup.sh" | crontab -
```

### 6. 设置自动更新

```bash
# 安装 unattended-upgrades
apt install -y unattended-upgrades

# 配置自动更新
dpkg-reconfigure -plow unattended-upgrades
```

### 7. 监控日志

```bash
# 定期查看日志
docker-compose logs --tail=100 app

# 设置日志轮转
cat > /etc/logrotate.d/gantt-app << 'EOF'
/var/www/gantt-app/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data www-data
    sharedscripts
}
EOF
```

---

## 性能优化

### 1. 限制容器资源使用

编辑 `docker-compose.yml`，添加资源限制：

```yaml
services:
  app:
    ...
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M

  postgres:
    ...
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
```

### 2. 启用 Nginx 缓存

在 Nginx 配置中添加缓存设置：

```nginx
# 在 http 块中添加
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=gantt_cache:10m max_size=1g inactive=60m;

# 在 location 块中使用
location / {
    proxy_cache gantt_cache;
    proxy_cache_valid 200 10m;
    ...
}
```

### 3. 优化 PostgreSQL

编辑 `docker-compose.yml`，添加 PostgreSQL 优化配置：

```yaml
postgres:
  ...
  command: >
    postgres
    -c shared_buffers=256MB
    -c max_connections=100
    -c work_mem=4MB
```

---

## 附录

### A. 完整的环境变量示例

```env
# 数据库配置
DB_HOST=postgres
DB_PORT=5432
DB_NAME=gantt_app
DB_USER=postgres
DB_PASSWORD=Str0ngP@ssw0rd!

# 应用配置
APP_PORT=3000
NODE_ENV=production

# JWT 配置
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

### B. Docker Compose 常用操作

```bash
# 完全重新部署
docker-compose down -v
docker-compose up -d --build

# 查看容器资源使用
docker stats gantt-app-app gantt-postgres

# 进入容器调试
docker-compose exec app sh
docker-compose exec postgres sh

# 导出镜像
docker save gantt-app-app | gzip > gantt-app.tar.gz

# 导入镜像
docker load < gantt-app.tar.gz
```

### C. 端口说明

| 端口 | 用途 | 说明 |
|------|------|------|
| 22 | SSH | 服务器远程管理 |
| 80 | HTTP | Web 访问 |
| 443 | HTTPS | 安全 Web 访问 |
| 3000 | Next.js | 应用端口（内部使用） |
| 5432 | PostgreSQL | 数据库端口（内部使用） |

---

## 获取帮助

如有问题，请访问：
- GitHub Issues: https://github.com/cainnn/TrackingGantt/issues
- 项目文档: https://github.com/cainnn/TrackingGantt

---

**文档版本**: 1.0
**最后更新**: 2026-03-26
**维护者**: cainnn
