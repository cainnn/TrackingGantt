# 甘特图管理系统

基于 Next.js 16、React 19、Redux 和 Bryntum 的企业级甘特图项目管理系统。

## 技术栈

- **前端框架**: Next.js 16 + React 19
- **状态管理**: Redux Toolkit
- **样式**: Tailwind CSS 4
- **甘特图库**: Bryntum Gantt 7.2.2
- **数据库**: PostgreSQL 18
- **认证**: JWT + bcrypt
- **容器化**: Docker + Docker Compose

## 功能特性

- 📊 可视化甘特图项目管理
- 👥 用户注册与登录
- 📁 多项目管理
- ✅ 任务创建、编辑、删除
- 🔗 任务依赖关系管理
- 📈 任务进度跟踪
- 💾 版本快照与恢复
- 🔐 安全的身份验证

## 快速开始

### 本地开发

1. **克隆项目**
```bash
git clone https://github.com/cainnn/TrackingGantt.git
cd TrackingGantt/gantt-app
```

2. **安装依赖**
```bash
npm install
```

3. **配置数据库**
```bash
# 确保 PostgreSQL 18 已安装并运行
# 创建数据库
createdb gantt_app

# 运行初始化脚本
node scripts/init-db.js
```

4. **配置环境变量**
```bash
cp .env.example .env
# 编辑 .env 文件，配置数据库连接信息
```

5. **启动开发服务器**
```bash
npm run dev
```

访问 http://localhost:3000

## 生产部署

### 方式一：自动部署脚本（推荐）

1. **连接到 Ubuntu VPS**
```bash
ssh root@your-vps-ip
```

2. **运行部署脚本**
```bash
curl -fsSL https://raw.githubusercontent.com/cainnn/TrackingGantt/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
./deploy.sh
```

脚本会自动：
- 安装 Docker 和 Docker Compose
- 克隆项目代码
- 配置环境变量
- 启动应用容器
- 配置 Nginx 反向代理
- 配置 SSL 证书（可选）

### 方式二：手动 Docker 部署

1. **安装 Docker**
```bash
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose
```

2. **克隆项目**
```bash
cd /var/www
git clone https://github.com/cainnn/TrackingGantt.git gantt-app
cd gantt-app
```

3. **配置环境变量**
```bash
cp .env.example .env
vim .env  # 修改数据库密码和 JWT 密钥
```

4. **启动容器**
```bash
docker-compose up -d --build
```

5. **创建管理员用户**
```bash
chmod +x scripts/docker-create-admin.sh
./scripts/docker-create-admin.sh
```

### 方式三：PM2 部署

1. **安装 Node.js 和 PostgreSQL**
```bash
# 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs postgresql-18

# 配置数据库
sudo -u postgres createdb gantt_app
```

2. **安装依赖并构建**
```bash
cd /var/www/gantt-app
npm ci
npm run build
```

3. **使用 PM2 启动**
```bash
npm install -g pm2
pm2 start npm --name "gantt-app" -- start
pm2 save
pm2 startup
```

## Nginx 配置

使用自动脚本配置 Nginx：
```bash
chmod +x scripts/setup-nginx.sh
./scripts/setup-nginx.sh
```

或手动配置：
```bash
cp nginx.conf /etc/nginx/sites-available/gantt-app
ln -s /etc/nginx/sites-available/gantt-app /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

## 环境变量说明

```env
# 数据库配置
DB_HOST=localhost          # 数据库主机（Docker 环境使用 postgres）
DB_PORT=5432              # 数据库端口
DB_NAME=gantt_app         # 数据库名称
DB_USER=postgres          # 数据库用户
DB_PASSWORD=11111a        # 数据库密码（生产环境请修改）

# 应用配置
APP_PORT=3000             # 应用端口
NODE_ENV=production       # 运行环境

# JWT 密钥（生产环境请使用强密钥）
JWT_SECRET=your-super-secret-jwt-key
```

## Docker 管理命令

```bash
# 查看运行状态
docker-compose ps

# 查看日志
docker-compose logs -f app

# 重启应用
docker-compose restart app

# 停止所有服务
docker-compose down

# 更新代码
git pull origin main
docker-compose up -d --build

# 进入容器
docker-compose exec app sh
docker-compose exec postgres psql -U postgres -d gantt_app
```

## 数据库管理

```bash
# 进入 PostgreSQL 容器
docker-compose exec postgres psql -U postgres -d gantt_app

# 常用 SQL 命令
\dt                          # 查看所有表
SELECT * FROM users;         # 查看用户
SELECT * FROM projects;      # 查看项目
SELECT * FROM tasks;         # 查看任务
```

## 项目结构

```
gantt-app/
├── app/                    # Next.js App Router
│   ├── api/               # API 路由
│   ├── dashboard/         # 仪表板页面
│   ├── login/             # 登录页面
│   ├── projects/          # 项目页面
│   └── register/          # 注册页面
├── components/            # React 组件
│   ├── GanttChart/       # 甘特图组件
│   └── auth/             # 认证组件
├── lib/                   # 工具库
│   ├── auth.ts           # 认证逻辑
│   ├── db.ts             # 数据库连接
│   └── middleware.ts     # 中间件
├── store/                 # Redux Store
│   └── slices/           # Redux Slices
├── scripts/               # 工具脚本
├── public/                # 静态资源
│   └── lib/gantt/        # Bryntum 库文件
├── Dockerfile            # Docker 配置
├── docker-compose.yml    # Docker Compose 配置
└── deploy.sh            # 自动部署脚本
```

## 安全建议

1. **修改默认密码**：更改数据库密码和 JWT_SECRET
2. **配置 HTTPS**：使用 Let's Encrypt 证书
3. **限制访问**：配置防火墙规则
4. **定期更新**：保持系统和依赖更新
5. **备份数据**：定期备份数据库

## 故障排查

### 应用无法启动
```bash
# 查看日志
docker-compose logs app

# 检查数据库连接
docker-compose logs postgres
```

### 数据库连接失败
```bash
# 检查环境变量
cat .env

# 测试数据库连接
docker-compose exec postgres psql -U postgres -d gantt_app
```

### Nginx 配置错误
```bash
# 测试配置
nginx -t

# 查看错误日志
tail -f /var/log/nginx/gantt-app-error.log
```

## 许可证

MIT License

## 支持

如有问题，请提交 Issue 或 Pull Request。
