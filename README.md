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

默认会写入一个测试账号：

- 用户名：`admin`
- 邮箱：`admin@example.com`
- 密码：`admin123`

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
