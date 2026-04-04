# 甘特图管理系统 — 维护文档

## 1. 系统架构

### 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Next.js (App Router) | 16.1.6 |
| UI 框架 | React + React DOM | 19.2.3 |
| 状态管理 | Redux Toolkit + React-Redux | 2.11.2 / 9.2.0 |
| 样式 | Tailwind CSS | 4.x |
| 后端 | Next.js API Routes (Node.js) | — |
| 数据库 | PostgreSQL | 18 |
| AI 集成 | OpenAI SDK (兼容 GLM 等) | 6.33.0 |
| 认证 | JWT (httpOnly Cookie) | jsonwebtoken 9.x |
| 导出 | jsPDF / xlsx / SVG | — |

### 架构概览

```
浏览器
  ├── React 19 SPA (App Router)
  │    ├── Redux Store (tasks, projects, versions, projectLines, auth)
  │    └── 甘特图渲染 (自研 SVG Canvas)
  │
  ├── Next.js API Routes (/api/*)
  │    ├── JWT 鉴权中间件
  │    ├── Result Pattern 统一响应
  │    └── pg 连接池 → PostgreSQL
  │
  └── OpenAI / GLM API (AI 助手)
```

### 认证流程

1. 用户登录 → `POST /api/auth/login` → 验证 bcrypt 密码
2. 签发 JWT → 写入 `httpOnly` Cookie (`token`)
3. 后续请求 → `getAuthUser(req)` 从 Cookie 解析 JWT
4. 角色：`admin`（读写自己的项目）、`view`（只读查看所有项目）

---

## 2. 数据库设计

### 连接配置

- 用户名: `postgres`，密码: 见 `.env` 配置
- 连接池: `lib/db.ts`，使用 `pg.Pool`
- DATE 类型自定义解析器（返回 `YYYY-MM-DD` 字符串，避免时区偏移）

### 表结构

#### users — 用户表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | gen_random_uuid() |
| username | VARCHAR(50) | 唯一 |
| email | VARCHAR(255) | 唯一 |
| password_hash | VARCHAR(255) | bcrypt |
| role | VARCHAR(20) | 默认 `admin` |
| created_at / updated_at | TIMESTAMP | 自动更新 |

#### login_logs — 登录日志
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| user_id | UUID (FK → users) | |
| ip | VARCHAR(45) | |
| user_agent | TEXT | |
| created_at | TIMESTAMP | |

#### projects — 项目表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| user_id | UUID (FK → users) | 所属用户 |
| name | VARCHAR(255) | 项目名称 |
| start_date | DATE | 项目开始日期 |
| end_date | DATE | 项目结束日期 |
| status_date | DATE | 状态日期（进度截止线） |
| created_at / updated_at | TIMESTAMP | |

#### tasks — 任务表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| project_id | UUID (FK → projects) | |
| parent_id | UUID (FK → tasks, 自引用) | 父任务（支持多级嵌套） |
| task_code | VARCHAR(50) | 任务编码（如 1, 1.1, 1.1.1） |
| name | VARCHAR(255) | 任务名称 |
| assignee | VARCHAR(100) | 责任人 |
| start_date / end_date | DATE | 计划起止日期 |
| original_start_date / original_end_date | DATE | 基线日期（用于对比） |
| duration | INTEGER | 工期（日历天） |
| duration_unit | VARCHAR(20) | 默认 `day` |
| percent_done | INTEGER | 完成百分比 0-100 |
| is_milestone | BOOLEAN | 是否里程碑 |
| auto_schedule | BOOLEAN | 是否自动排程 |
| note | TEXT | 备注 |
| order_index | INTEGER | 排序索引 |
| is_deleted | BOOLEAN | 软删除标记 |
| deleted_at | TIMESTAMP | 删除时间 |
| created_at / updated_at | TIMESTAMP | |

#### dependencies — 依赖关系表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| project_id | UUID (FK → projects) | |
| from_task_id | UUID (FK → tasks) | 前置任务 |
| to_task_id | UUID (FK → tasks) | 后续任务 |
| type | INTEGER | 0=SS, 1=SF, 2=FS(默认), 3=FF |
| lag | INTEGER | 延迟天数 |
| UNIQUE(from_task_id, to_task_id) | | |

#### task_lifecycle — 任务生命周期（变更日志）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| task_id | UUID (FK → tasks) | |
| task_code | VARCHAR(50) | 冗余存储便于查询 |
| project_id | UUID (FK → projects) | |
| event_type | VARCHAR(50) | created / updated / deleted / moved |
| field_name | VARCHAR(100) | 变更字段名 |
| old_value / new_value | TEXT | 变更前后值 |
| description | TEXT | 变更描述 |
| created_by | UUID (FK → users) | |
| created_at | TIMESTAMP | |

#### project_versions — 版本快照表（双轨制）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| project_id | UUID (FK → projects) | |
| version_number | INTEGER | 递增版本号 |
| name | VARCHAR(100) | 版本名称 |
| description | TEXT | |
| snapshot | JSONB | 完整任务 + 依赖快照 |
| changes | JSONB | 与上一版本的差异 |
| status_date | DATE | 该版本对应的状态日期 |
| created_by | UUID (FK → users) | |
| UNIQUE(project_id, version_number) | | |

#### project_lines — 项目标记线
| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (PK) | |
| project_id | UUID (FK → projects) | |
| name | VARCHAR(255) | 线名称 |
| line_date | DATE | 日期位置 |
| color | VARCHAR(20) | 默认 #f59e0b |
| visible | BOOLEAN | 是否显示 |

### 索引

- `tasks`: project_id, parent_id, is_deleted
- `dependencies`: project_id, from_task_id, to_task_id
- `task_lifecycle`: task_id, project_id
- `project_versions`: project_id
- `project_lines`: project_id
- `login_logs`: user_id, created_at

### 触发器

所有主表均有 `update_updated_at_column()` 触发器，自动更新 `updated_at` 字段。

---

## 3. 源文件组织

```
gantt-app/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # 根布局
│   ├── page.tsx                  # 首页/仪表盘
│   ├── globals.css               # 全局样式 (Tailwind)
│   ├── dashboard/                # 仪表盘页面
│   ├── login/                    # 登录页
│   ├── register/                 # 注册页
│   ├── projects/                 # 项目详情页 ([id])
│   └── api/                      # API 路由
│       ├── ai/chat/route.ts              # AI 对话
│       ├── auth/login/route.ts           # 登录
│       ├── auth/logout/route.ts          # 登出
│       ├── auth/register/route.ts        # 注册
│       ├── projects/route.ts             # 项目列表 CRUD
│       ├── projects/[id]/route.ts        # 单项目 CRUD
│       ├── tasks/[projectId]/route.ts    # 任务列表 CRUD + 批量操作
│       ├── tasks/[projectId]/[taskId]/route.ts    # 单任务操作
│       ├── tasks/[projectId]/changelog/route.ts   # 任务变更日志
│       ├── tasks/direct-fix/[projectId]/route.ts  # 直接修复任务
│       ├── tasks/enable-auto-schedule/[projectId]/route.ts # 启用自动排程
│       ├── tasks/fix-project/[projectId]/route.ts # 修复项目数据
│       ├── tasks/reset-date/[projectId]/route.ts  # 重置日期
│       ├── dependencies/[projectId]/route.ts      # 依赖关系 CRUD
│       ├── versions/[projectId]/route.ts          # 版本列表 + 创建
│       ├── versions/[projectId]/diff/route.ts     # 版本差异
│       ├── versions/[projectId]/restore/route.ts  # 版本还原
│       ├── import/[projectId]/route.ts            # Excel 导入
│       └── project-lines/[projectId]/route.ts     # 项目标记线
│
├── components/                   # React 组件
│   ├── ProjectCard.tsx           # 项目卡片（仪表盘）
│   ├── auth/                     # 认证相关组件
│   └── GanttChart/               # 甘特图核心组件
│       ├── GanttChart.tsx        # 主图表（SVG 渲染、拖拽、基线对比）
│       ├── GanttToolbar.tsx      # 工具栏（缩放、导出、状态日期、筛选）
│       ├── EditTaskModal.tsx     # 任务编辑弹窗
│       ├── AIChatPanel.tsx       # AI 助手面板
│       ├── VersionPanel.tsx      # 版本管理面板
│       └── ProjectLinesPanel.tsx # 项目标记线管理
│
├── store/                        # Redux Store
│   ├── store.ts                  # Store 配置
│   ├── hooks.ts                  # useAppDispatch / useAppSelector
│   └── slices/
│       ├── authSlice.ts          # 认证状态
│       ├── projectSlice.ts       # 项目列表
│       ├── tasksSlice.ts         # 任务 + 依赖 + 差异筛选
│       ├── versionsSlice.ts      # 版本管理
│       └── projectLinesSlice.ts  # 项目标记线
│
├── lib/                          # 工具库
│   ├── db.ts                     # PostgreSQL 连接池
│   ├── auth.ts                   # JWT 签发/验证
│   ├── middleware.ts             # API 鉴权中间件
│   ├── result.ts                 # Result Pattern (success/failure)
│   ├── scheduling.ts             # 自动排程算法
│   ├── projectProgress.ts       # 项目进度计算
│   ├── versionDiff.ts           # 版本快照差异比较
│   ├── ai/tools.ts              # AI 工具定义 + 系统提示词
│   └── client/                   # 前端工具（仅浏览器端）
│       ├── authFetch.ts          # 带认证的 fetch 封装
│       ├── chartExport.ts        # 图表导出（SVG → JPEG/PDF）
│       ├── excelExport.ts        # Excel 导出
│       ├── excelImport.ts        # Excel 导入解析
│       └── taskWriteQueue.ts     # 任务写入队列（防抖合并）
│
├── types/                        # TypeScript 类型定义
│   └── index.ts                  # Task, Dependency, Project 等
│
├── scripts/                      # 运维脚本
│   ├── init-db.js / init-db.sql  # 数据库初始化
│   ├── deploy-vps.sh             # VPS 部署
│   ├── sync-db-to-vps.sh         # 数据库同步到 VPS
│   ├── generate-source-pdf.js    # 源码导出 PDF
│   └── generate-doc-pdf.js       # 文档导出 PDF
│
├── public/lib/                   # 前端静态库（如 Bryntum 等）
└── docs/                         # 文档目录
```

---

## 4. 关键设计模式

### Result Pattern

所有 API 统一返回格式：

```typescript
// 成功
{ ok: true, value: <data> }

// 失败
{ ok: false, error: <message>, code: <http_status> }
```

工具函数：`lib/result.ts` 中的 `success(data)` / `failure(msg, code)`。

### 任务写入队列

`lib/client/taskWriteQueue.ts` — 前端修改任务时不立即发请求，而是放入队列，50ms 内的多次修改合并为一次 API 调用，减少网络请求。

### 版本管理双轨制

- **工作状态**：tasks 表实时修改，task_lifecycle 记录每次变更
- **冻结快照**：确认变更时，将当前 tasks + dependencies 序列化为 JSONB 存入 project_versions.snapshot
- **差异计算**：`lib/versionDiff.ts` 的 `diffSnapshots()` 比较两个快照，输出增删改

### 进度计算

基于状态日期的时间比例法（非用户输入的 percent_done）：
- 任务结束日期 ≤ 状态日期 → 100%
- 任务开始日期 ≥ 状态日期 → 0%
- 其他 → (状态日期 - 开始日期) / (结束日期 - 开始日期)
- 按工期加权汇总

### AI 助手

- 后端：OpenAI Chat Completions API，支持 7 个函数工具（create/update/delete task、add/remove dependency、get_task_changes、get_version_diffs）
- 前端：`AIChatPanel.tsx` 检测用户意图，对"总结进展"类请求主动预取变更数据注入上下文
- 支持通过 `OPENAI_BASE_URL` 切换到 GLM 等兼容 API

---

## 5. 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://postgres:<密码>@localhost:5432/gantt` |
| `JWT_SECRET` | JWT 签名密钥 | 随机字符串 |
| `OPENAI_API_KEY` | OpenAI / GLM API 密钥 | `sk-xxx` |
| `OPENAI_BASE_URL` | API 地址（可选，用于 GLM 等） | `https://open.bigmodel.cn/api/paas/v4` |
| `OPENAI_MODEL` | 模型名称（可选） | `gpt-4o` / `glm-4` |

---

## 6. 维护常用命令

### 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 启动生产服务器
npm run start
```

### 数据库

```bash
# 初始化数据库（创建表、索引、触发器、默认用户）
npm run db:init

# 连接数据库
psql -U postgres -d gantt

# 查看任务数量
psql -U postgres -d gantt -c "SELECT COUNT(*) FROM tasks WHERE is_deleted = false;"

# 查看项目列表
psql -U postgres -d gantt -c "SELECT id, name, status_date FROM projects;"

# 查看版本快照
psql -U postgres -d gantt -c "SELECT id, version_number, name, status_date, created_at FROM project_versions WHERE project_id = '<project_id>' ORDER BY version_number;"

# 查看近期变更日志
psql -U postgres -d gantt -c "SELECT event_type, task_code, field_name, old_value, new_value, created_at FROM task_lifecycle WHERE project_id = '<project_id>' ORDER BY created_at DESC LIMIT 20;"

# 清理软删除任务（谨慎操作）
psql -U postgres -d gantt -c "DELETE FROM tasks WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '30 days';"
```

### 部署

```bash
# 标准部署（备份 + 迁移 + 构建）
npm run deploy:vps

# 快速部署（跳过备份和迁移，仅代码更新）
npm run deploy:fast

# 本地构建后上传（VPS 内存不足时）
npm run deploy:local

# 同步本地数据库到 VPS
npm run sync:db

# 仅同步数据（不含表结构）
npm run sync:db:data
```

### 导出工具

```bash
# 导出源码为 PDF
npm run source-pdf

# 导出文档为 PDF
npm run doc-pdf
```

### 部署环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VPS_HOST` | VPS IP/域名 | （见部署配置） |
| `VPS_USER` | SSH 用户 | root |
| `VPS_PASS` | SSH 密码（留空用公钥） | — |
| `VPS_PORT` | SSH 端口 | 22 |
| `APP_DIR` | 安装目录 | /opt/gantt-app |
| `SKIP_BACKUP` | 跳过备份 | — |
| `SKIP_MIGRATE` | 跳过迁移 | — |
| `LOCAL_BUILD` | 本地构建 | — |

---

## 7. 默认账户

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | admin |

> 首次部署后请立即修改默认密码。
