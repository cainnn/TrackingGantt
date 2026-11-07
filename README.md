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

- root 超级管理员：`root` / `root123`（首次迁移设置，重复迁移不会重置密码）
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

### 用户与项目关联

已有数据库在启动新版前运行 `npm run db:access`，自动读取 `.env.local` 中的数据库配置。
新数据库的 `npm run db:init` 和常规 VPS 部署会自动执行相同迁移。

以 `root` 登录后，进入「用户与项目」，可新建普通或只读用户、修改密码，并在「项目关联」中管理访问权限：

- 将项目拖到用户卡片上，或将用户拖到项目上，添加关联。
- 选中用户后，在「已关联」与「未关联」两栏之间拖动项目，添加或移除关联；也可使用关联、移除按钮。
- 普通用户默认只能访问自己创建的项目；root 可增加或撤销关联，包括撤销创建人的访问权限。
- 同一项目可关联多个用户。普通用户可编辑关联项目，只读用户只能查看关联项目；超级管理员始终可管理全部项目。
- 关联保存后，后续 API 请求立即使用新权限，无需重新登录。已签发的临时分享链接仍按原有有效期与项目范围工作。
- 新建或修改密码时只要求密码非空，允许使用少于 6 位的密码。
- 用户名登录不区分大小写，用户名也不能以不同大小写重复创建。
- 删除仍有创建项目的用户会被阻止，以免级联删除其项目；移除关联不删除项目或更改创建人记录。

迁移仅首次为已有项目补齐创建人关联，重复运行不会恢复 root 已撤销的关联。

运行中的本地服务可执行 `npm run test:access -- --ui`，验证真实数据库与接口权限、重复迁移及浏览器拖动操作。测试创建独立的临时用户和项目，并在结束后清理；可通过 `ACCESS_TEST_URL`、`ACCESS_TEST_ROOT` 和 `ACCESS_TEST_PASSWORD` 指定测试服务和管理员登录信息。

保存流程回归：启动本地服务后执行 `SAVE_TEST_URL=http://localhost:3000 npm run test:save`，验证首个任务及全部删除、重复创建与审计记录、保存断网重试、快照异常恢复、保存期间的新编辑和项目状态日期。测试会清理本轮临时项目；可用 `SAVE_TEST_ROOT`、`SAVE_TEST_PASSWORD` 指定管理员，或加 `-- --api-only` 仅验证接口。

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

### Excel 导入导出

天级项目导出的工期列为“工期(天)”，数值按自然天显示（1 天 = 1440 分钟）；分钟级项目单独标注“工期(分钟)”。任务总表与按责任人拆分的工作表使用相同单位。

导入时按表头单位换算，兼容“工期(天)”“工期(分钟)”及中文括号写法；未标注单位的“工期”默认按天读取。旧版导出的“工期(分钟)”仍按分钟导入。

### 右键复制任务

先勾选要复制的任务，或单击右侧任务条选中任务，再右键目标任务，选择“复制选中任务到上方”或“复制选中任务到下方”。按住 Ctrl / Command 单击任务条可增减多选，普通任务、摘要任务和里程碑均支持。副本会按原显示顺序插入，与目标任务处于同一层级；摘要任务连同全部子任务一起复制，副本内部的依赖关系也会保留。副本使用新的任务编码，完成后选中副本，确认并保存后入库。没有选中任务时，这两个菜单项不可用。

### 草稿、逐步撤销与确认保存

任务编辑、拖动、复制、删除、Excel/MPP 导入、状态日期、计划状态和项目线调整都先保留在浏览器内存。只有“确认变更 → 确认并保存”才写入后端。进入项目不会自动创建版本，刷新或离开页面会丢弃未保存编辑并提示。

工具栏的“计划状态”分为草稿态和稳定态。已有项目按项目列表当前完成率初始化：完成率 ≥ 50% 为稳定态，低于 50% 为草稿态；完成率沿用状态日期和叶子任务工期加权口径。该初始化只执行一次，后续迁移保留用户选择，新建或复制项目默认草稿态。草稿态保存当前计划，原因选填，不生成历史版本，也不要求先设置状态日期；稳定态沿用主动变更、手动任务和依赖变更的原因必填规则，确认保存后生成版本。切换状态同样可撤销，确认后才持久化；进入稳定态并确认时开始保存版本，已有历史版本始终保留。

计划状态迁移回归测试使用本地 PostgreSQL 的临时表：`node --env-file=.env.local scripts/test-planning-migration.cjs`。覆盖首次迁移、旧版“全部稳定态”的修正、50% 边界、摘要/已删任务、分钟级任务，以及重复部署不覆盖用户选择。

- “撤销 / 重做”按一次完整操作处理，包含子任务、依赖和排程联动，最多保留 100 步。快捷键为 Ctrl/Command+Z、Ctrl/Command+Shift+Z 或 Ctrl+Y；输入框内仍使用文本自己的撤销。
- “放弃全部更改”回到最近一次成功保存的状态。保存失败可能已部分提交，此时先核对后端，再重试或放弃；普通撤销不能跨过未知保存结果或已确认的版本边界。
- 确认保存以用户提交的任务内容和排程为准。任务读取不再自动写库；完整任务批次不会被后台旧依赖重排。保存先新增/更新保留的任务，再按客户端明确的 ID 列表删除，避免旧父级连带删除已移出的子任务。
- 已打开的旧页面也可直接重试：重新提交的软删除任务及必要的本项目父级会恢复；自引用、丢失或循环父级只修正关联，保留任务内容并写入任务历史，新版页面会提示修正结果。跨项目任务 ID 仍禁止写入；普通单项 API 保留严格父级校验。不要为了重试而刷新有未确认修改的页面。
- 提交保护 API 回归：启动本地服务后执行 `node scripts/test-submitted-plan.cjs`（默认端口 3117，可用 `SAVE_TEST_URL` 指定）。覆盖 320 条修改、异常父级、软删除恢复、旧页面重试、读取不写库和失败批次回滚。
- 保存期间继续编辑会作为下一份草稿保留；保存成功后的撤销只作用于这些尚未确认的编辑。
- 历史版本查看为只读；“恢复预览 → 确认更改并恢复”是独立的后端操作，按原有规则删除后续版本。版本改名和删除也有单独确认。新版本包含项目线，旧版本没有项目线快照时保留现有项目线。

### 状态日期线与甘特图操作

状态日期线保留拖动预览及进度、任务状态和延期联动。松开后进入待确认编辑，可逐步撤销；确认后写入项目，稳定态同时保存版本。只读与历史查看时拖动仅预览。聚焦状态日期线后，左右键按一天或 15 分钟调整，Shift+左右键按七天或一小时调整；Esc 取消预览。工具栏可随时“回到状态日期”。

- 左侧行、勾选框和右侧任务条统一选择；Shift 连选，Ctrl/Command 增减多选。工具栏显示选中数量。工具栏复制/粘贴与右键定向复制使用同一套摘要子树和依赖复制逻辑。
- 双击任务条打开编辑窗口，悬停查看日期、责任人、工期、进度和排程信息。拖动提示日期与影响范围，Esc 可取消；普通任务平移后切换为手动排程，提示会明确说明。
- 任务右键操作只显示一个菜单；点击“新增”或“删除依赖关系”在原菜单内切换选项，点击“返回任务操作”回到主菜单。
- 拖动前置任务时，只有自动排程的后继按依赖联动，手动后继保留当前日期。手动任务仍可直接拖动，或随选中的任务、所属摘要一起平移；保存后的撤销仅影响后续草稿。
- “显示全部 / 适配所选”调整时间轴范围，缩放保持当前观察位置。选中多个任务后拖动其中一个可整体平移，也可通过“批量修改”统一修改责任人、排程模式和移动量。
- 单元格按 Enter/F2 编辑，Tab 提交并移至下一个可编辑单元格，Enter 提交后向下移动，Esc 取消当前输入。选中目标单元格可粘贴 Excel 的多行多列文本，按当前可见行列顺序应用；无效或只读字段会拒绝整批操作。依赖端点使用任务编辑窗口调整。
- “保存视图”保存搜索、筛选、排序、列顺序/宽度、展开状态、缩放和滚动位置。只保存显示偏好到浏览器，不包含业务草稿或撤销历史。

交互回归可运行 `npm run test:interactions`，默认访问 `http://127.0.0.1:3117`；用 `INTERACTION_TEST_URL` 指定其它地址。测试拦截所有业务 API，不改真实数据。`npm run test:save` 使用临时测试项目验证实际数据库保存及恢复，结束后清理测试项目。

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

### Static assets behind Nginx

`npm run build` and `npm run build:turbo` now generate `.gz` copies of the
JavaScript and CSS files in `.next/static`. This also runs for local-build VPS
deployments. The original files are retained; no application data is modified.

For Nginx deployments, render `deploy/nginx-static.conf.template` with the
actual application directory and include the result in the application's
`server {}` block. For example, on the VPS:

```bash
export APP_DIR=/opt/gantt-app
envsubst '${APP_DIR}' < deploy/nginx-static.conf.template > /etc/nginx/snippets/gantt-static.conf
```

Add `include /etc/nginx/snippets/gantt-static.conf;` to the existing application
server block, replacing any existing `/_next/static/` location. Back up the site
configuration first, run `nginx -t`, then use `systemctl reload nginx` to apply it
without stopping the application. Nginx must support `http_gzip_static_module`.

This serves precompressed files with a complete `Content-Length` response. It
avoids streaming compression on the static-resource path, where truncated
responses were causing `ChunkLoadError` in the browser. Verify a full gzip
download and its decompressed checksum, not just an HTTP 200 response, after
changing this configuration. See the [Nginx gzip_static documentation](https://nginx.org/en/docs/http/ngx_http_gzip_static_module.html).

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
