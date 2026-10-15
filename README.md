This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started (Local Dev)

### Prerequisites

- Node.js (建议 20+)
- PostgreSQL 18（本项目默认连接：`localhost:5432`，数据库：`gantt_app`，用户：`postgres`，密码：`11111a`）

### 1) Install deps

```bash
npm i
```

### 2) Create database + init tables

先创建数据库（若已存在可跳过）：

```bash
createdb -h localhost -p 5432 -U postgres gantt_app
```

然后初始化表结构和示例数据：

```bash
npm run db:init
```

默认会写入以下测试账号：

- 超级管理员：`administrator` / `admin123`
- 默认管理员：`admin` / `admin123`
- 预置管理员：`adminqu`、`adminnn`、`admingl`、`adminlz`、`adminyl`、`adminbs`、`adminhc`、`admingg`、`adminqz`、`adminwz`、`adminbh`、`admincz`、`adminlb`、`adminhz`、`adminfcg`
- 预置管理员密码：均为 `用户名 + 123`，例如 `adminqu123`
- 只读用户：`view` / `view123`

### 3) Run dev server

Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

### 任务生命周期与变更原因

编辑任务后，在工具栏“确认变更”中填写实际调整原因并提交。“编辑任务 → 生命周期”展示变更前后值、原因、时间和操作人；被动调整使用确认页显示的关联任务说明。原因随日志独立保存，同一状态日期的版本替换不会覆盖它。仅修改备注也会进入确认流程。

每条记录仅展示发生变化的字段；任务名称只在改名时展示，天级项目的日期不重复显示 `00:00`。依赖关系变更也可在确认页填写原因。

旧日志优先从对应版本中匹配同一任务、操作人和字段前后值的原因；无法唯一匹配的记录显示“未记录”。

已有数据库在启动新版前执行 `scripts/migrate-task-lifecycle-reason.sql`（使用现有数据库连接配置）；新数据库初始化和常规 VPS 部署会自动执行这项幂等迁移。

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Deploy to VPS (Fast Path)

When your database has active lock contention, running full `db:init` on each deploy may block for a long time.

Use the fast deploy script instead:

```bash
bash scripts/deploy-vps.sh <vps-host> [vps-user] <password>
```

Example:

```bash
bash scripts/deploy-vps.sh 159.75.40.209 root 11111a
```

What it does:

- uploads current code (excluding `node_modules/.next/.git`)
- creates a DB backup at `/var/backups/gantt-app` before replacing code
- preserves existing `.env` on VPS
- creates required version tables (`project_versions`, `change_logs`) with DB timeout guards
- runs `npm i && npm run build`
- restarts PM2 app (`gantt-app`)

### Backup / Restore

Backup (manual):

```bash
bash scripts/db-backup.sh
```

Restore latest backup:

```bash
bash scripts/db-restore-latest.sh
```

On VPS, `deploy-vps.sh` already performs automatic backup before each deploy.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
