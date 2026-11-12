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

### 按项目保存布局

在项目工具栏进入「显示设置 → 常用布局」，点击「保存当前布局」。显示列及其顺序、列宽、面板宽度、任务折叠、筛选、排序、搜索、关键路径、日期标记、时间轴缩放和滚动位置都会按当前账号与项目保存到数据库。重新打开项目或使用另一台设备登录后会自动恢复；布局保存独立于计划草稿和版本确认。只读账号也可以保存自己的布局，分享访客需登录后保存。

可用「另存为常用布局」保存最多 20 个命名布局，选择布局后点击「更新此布局」覆盖保存。选择或应用常用布局时，也会将它保存为下次进入项目时恢复的布局；保存失败会提示重试。旧浏览器中的常用布局会在首次保存时一起迁移。多个窗口同时保存时会提示重新加载，避免覆盖另一个窗口刚保存的结果。

已有数据库在启动新版前执行：

```bash
node --env-file=.env.local scripts/migrate-project-view-preferences.cjs
```

新数据库初始化和常规 VPS 部署会自动执行迁移。本地服务启动后运行 `node scripts/test-project-views.cjs` 验证项目与账号隔离、保存恢复、并发冲突及浏览器操作；使用 `LAYOUT_TEST_URL` 指定服务地址，添加 `--api-only` 仅验证接口。

`node scripts/test-filtered-fill-ui.cjs` 在临时项目验证天级/分钟级责任人筛选、跨父级 Ctrl/Command+D、反向拖选、责任人列选区、撤销重做、保存及布局重新进入后的恢复；默认端口 3127，可用 `FILTER_FILL_TEST_URL` 指定地址，结束后清理测试项目。

### 项目开始时间与日期输入

项目开始时间自动取所有未删除任务的最早开始时间，任务提前、延后、删除、恢复、导入或历史恢复后同步更新；没有有效任务日期时为空，项目卡片不再单独编辑该字段。分钟项目保留时分。此同步只更新项目元数据，不会改写任务日期或历史快照；前端草稿、撤销和放弃更改也按当前任务同步预览。

日期输入支持 `20260814`、`260814` 和 `0814`（当前年份的 8 月 14 日），以及带分隔符的日期。Enter、Tab 或离开输入框后确认，无效日期保留在输入框内供修改；六位、四位数字优先按日历日期识别，避免被误当成 Excel 序列号生成跨越数百年的时间轴。

已有数据库运行 `node --env-file=.env.local scripts/migrate-project-start-from-tasks.cjs`；新库初始化和常规部署自动迁移。验证：`node --env-file=.env.local scripts/test-project-start-migration.cjs` 使用独立测试 schema；`node scripts/test-date-input-project-start.cjs http://127.0.0.1:3127` 使用临时项目及普通编辑账号验证真实页面输入、保存和“封网”案例，结束后清理。

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

### Excel 导入导出

天级项目导出的工期列为“工期(天)”，数值按自然天显示（1 天 = 1440 分钟）；分钟级项目单独标注“工期(分钟)”。任务总表与按责任人拆分的工作表使用相同单位。

导入时按表头单位换算，兼容“工期(天)”“工期(分钟)”及中文括号写法；未标注单位的“工期”默认按天读取。旧版导出的“工期(分钟)”仍按分钟导入。

### 右键复制任务

先勾选要复制的任务，或单击右侧任务条选中任务，再右键目标任务，选择“复制选中任务到上方”或“复制选中任务到下方”。按住 Ctrl / Command 单击任务条可增减多选，普通任务、摘要任务和里程碑均支持。副本会按原显示顺序插入，与目标任务处于同一层级；摘要任务连同全部子任务一起复制，副本内部的依赖关系也会保留。副本使用新的任务编码，完成后选中副本，草稿态点击顶部“保存”直接入库，稳定态确认审核后入库。没有选中任务时，这两个菜单项不可用。

### 草稿、逐步撤销与确认保存

“任务操作 → 检查与修复”检查整个项目，预览并修复自动排程、限制为“尽早（越早越好）”、没有前置任务且开始日期晚于今天的任务。开始日期提前到修复当天，工期保持不变；分钟级任务保留原来的时分。已开始和无效任务不调整，摘要日期随子任务汇总，自动后续任务遵循原有依赖与限制；配置过前置任务（包括停用的依赖）的任务不作为直接修复对象。修复与联动合为一步撤销，草稿态点击“保存”入库，稳定态仍须审核并填写原因。状态日期线保持原值。重新打开项目始终展示已保存日期，不再在加载时自动重排任务。

开始日期早于今天的任务保留原排程；切回自动排程、批量设为自动或删除最后一个前置关系时，也不会仅因“尽早”把开始日期推到今天。用户明确调整日期或整体移动仍按实际输入处理。

修复点击验收：`node scripts/test-task-repair-ui.cjs http://127.0.0.1:3117`，使用并清理专用项目，核对预览与取消、撤销重做、不提前写库、草稿保存、稳定态原因和版本、分钟精度及重新进入项目后的日期。

左侧任务列表支持按住**任务名称**或编号旁常显的**六点手柄**上下拖动，插入线与提示框显示放置位置及目标父任务。父任务连同全部子任务移动，多选任务按原顺序成组移动，折叠或筛选隐藏的子任务仍保留。靠近列表上下边缘可自动滚动，左右面板同步；按 Esc 或在列表外松开可取消，不能把任务放入自身子任务内。启用列排序时须先取消排序，再手动拖动。拖动可逐步撤销/重做，双击名称编辑仍保留。

主工具栏常显“全部折叠、全部展开、提升任务层级、降低任务层级”四个图标按钮，悬停可查看名称。未选任务或只读时升降级按钮置灰；折叠/展开只调整显示，升降级沿用草稿、撤销和确认保存流程。

新建、编辑、删除任务也使用纯图标按钮。删除父任务会包含所有层级的子任务（含折叠或筛选隐藏的任务）及相关依赖；已移出该父任务的任务保留。确认框显示总数量，整个删除可一步撤销，点击顶部保存后入库。

任务表格日期按“年-月-日”显示，年份仅两位，如 `26-11-04`；分钟级同时显示 24 小时时分，后台保留四位年份。选中起始单元格后可粘贴 Excel 多行多列，支持 `20260808`、`2026/11/4`、`26-11-04`、中文日期和 Excel 日期序列号；日期框直接输入，不弹日历，支持 Enter/Tab 确认及 Esc 取消。日期粘贴按输入值保留，实际覆盖自动排程日期时会切为手动并提示；未改变日期时保留自动模式。无效日期或越界批次整体拒绝，正确批次可一步撤销，保存前不写库。验收：`node scripts/test-grid-dates-delete-ui.cjs http://127.0.0.1:3117`，使用专用项目；为保护本机剪贴板，测试通过浏览器粘贴事件提供 Excel TSV 数据。

日期、时间及持续时间支持鼠标拖选矩形区域、Shift 点击和 Shift 方向键扩展选区，按当前可见行及列顺序粘贴。只选左上角时按 Excel 数据大小展开；选择多格时可用单个值填满，或重复填充能整除选区的行列数据。数量不匹配时从选区左上角按复制数据的实际大小展开或缩小，并高亮实际粘贴范围；只拒绝越界、无效值及只读目标。工期可写项目默认单位的数字或 `5天`、`90分钟`、`1.5小时` 等明确单位，天级项目要求整天、分钟级要求整分钟。分钟级日期单元格也可仅输入/粘贴 `09:15`，保留每格原日期。Esc 取消选区。

连续选区与粘贴规则参考 [AG Grid 单元格选择](https://www.ag-grid.com/react-data-grid/cell-selection/)及[剪贴板操作](https://www.ag-grid.com/react-data-grid/clipboard/)。Ctrl/Command+C 复制当前单元格或矩形选区，可直接粘贴至 Excel；表格获得焦点时复制的是单元格内容，任务副本仍通过“任务操作”菜单创建。Ctrl/Command+Shift+方向键将选区扩展到当前可见行/列边缘。编辑框内保留原生文本复制操作；复制和改变选区不生成草稿步骤，粘贴仍为可撤销的完整一步。

选中至少两行单元格后按 **Ctrl+D**（Mac 也支持 **Command+D**）向下填充：按当前可见顺序将选区最上面一行各列复制至选区下方各行，反向拖选同样适用，来源行保持原值。责任人列也支持拖选和 Shift 连选；责任人等条件筛选后，仅为展示层级而保留的父级行不参与填充，隐藏任务不会成为填充目标。支持日期、时分、持续时间和其他可编辑列；日期使用完整年份精确复制，自动排程目标日期被实际覆盖时按粘贴规则转为手动并提示。含只读目标或无效值的操作整体拒绝，重复填充相同数据不增加撤销步。填充及其排程联动为一步撤销，显式保存前不写库，不使用系统剪贴板。

任务编辑、拖动、复制、删除、Excel/MPP 导入、状态日期、计划状态和项目线调整都先保留在浏览器内存。草稿态点击顶部“保存”直接写入后端，不打开变更审核；稳定态通过“确认变更 → 确认并保存”入库。进入项目不会自动创建版本，刷新或离开页面会丢弃未保存编辑并提示。

工具栏的“计划状态”分为草稿态和稳定态。已有项目按项目列表当前完成率初始化：完成率 ≥ 50% 为稳定态，低于 50% 为草稿态；完成率沿用状态日期和叶子任务工期加权口径。该初始化只执行一次，后续迁移保留用户选择，新建或复制项目默认草稿态。草稿态点击“保存”直接保存当前计划，不审核、不填原因、不生成历史版本，也不要求先设置状态日期；稳定态沿用主动变更、手动任务和依赖变更的原因必填规则，确认保存后生成版本。切换状态同样可撤销，按切换后的状态执行保存流程后才持久化；进入稳定态并确认时开始保存版本，已有历史版本始终保留。

每次保存前都会读取后台最新计划，按任务 ID 自动比较父任务、同级顺序、其他任务字段、新增/删除及依赖关系。升降级、拖动排序和批量调整不依赖手动标记；当前页面已知任务以本次前端提交为准，其他会话新增、尚未加载到本页的任务会保留。新任务先建立 ID，再与已有任务一起应用最终父子关系；中途失败后重试会重新比对已入库部分。稳定态审核会显示父任务变化及名称，填写原因后随版本保存。

层级真实点击验收：`node scripts/test-task-hierarchy-ui.cjs http://127.0.0.1:3117`。脚本只创建和清理专用测试项目，覆盖名称上下拖动、常显手柄、插入预览、折叠子树和多选整组移动、循环保护与取消、长列表边缘滚动、单选/多选升降级、撤销重做、后台结构变化后的差异同步、新父任务与已有子任务合并保存、中断重试，以及保留子任务后删除旧父任务；保存后重新进入页面核对数据库与可见任务树。

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
- “保存当前布局”按账号与项目保存搜索、筛选、排序、列顺序/宽度、展开状态、缩放和滚动位置到数据库，不包含业务草稿或撤销历史。

交互回归可运行 `npm run test:interactions`，默认访问 `http://127.0.0.1:3117`；用 `INTERACTION_TEST_URL` 指定其它地址。测试拦截所有业务 API，不改真实数据。`npm run test:save` 使用临时测试项目验证实际数据库保存及恢复，结束后清理测试项目。

### 任务生命周期与变更原因

稳定态编辑任务后，在工具栏“确认变更”中填写实际调整原因并提交；草稿态点击“保存”直接入库，无需填写原因。“编辑任务 → 生命周期”展示变更前后值、原因、时间和操作人；被动调整使用确认页显示的关联任务说明。原因随日志独立保存，同一状态日期的版本替换不会覆盖它。稳定态仅修改备注也会进入确认流程。

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

VPS 历史查询备份由两个 systemd 定时任务管理，每天北京时间 03:00 运行：

- `gantt-db-history@day1.timer`：生成当天完整快照，并将昨天最新的完整快照恢复到 `gantt_app_backup_day1`。
- `gantt-db-history@day7.timer`：将 7 个自然日前最新的完整快照恢复到 `gantt_app_backup_day7`。

“昨天”和“7 天前”指完整数据库快照，不是按业务日期过滤行；实际快照时间可在各备份库的 `backup_metadata.snapshot` 表中查询。先在临时库恢复并核对所有公共表的行数，再切换历史库。历史库默认只读；业务库持续在线。缺失指定日期或恢复失败时保留上一次可用历史库并记录失败，不会用其他日期冒充。

在数据库服务器上以 root 执行 `bash scripts/install-db-history-backups.sh` 安装。安装会实际恢复两个历史库，成功后启用两个定时器，并保存、替换旧的每日备份 cron。每日新快照保存在 `/var/backups/gantt-app/history`，保留最近 14 天；既有部署备份保留。运行脚本和配置安装在 `/usr/local/lib/gantt-db-history` 与 `/etc/gantt-db-history.env`，不受应用代码部署影响。

检查状态：`systemctl list-timers 'gantt-db-history@*'`；查看日志：`journalctl -u gantt-db-history@day1.service -u gantt-db-history@day7.service`；手动补跑：`systemctl start gantt-db-history@day1.service gantt-db-history@day7.service`。最近成功的快照信息还会写入 `/var/lib/gantt-db-history/day1.json`、`day7.json`。纯逻辑回归：`python3 scripts/test-db-history-backup.py`。

安装后以 root 运行 `python3 scripts/test-db-history-live.py`，在独立临时库验证新格式恢复、损坏备份失败时保留旧快照、两个历史库的真实日期和所有表行数，结束后清理临时库。

### 删除任务与依赖衔接

工具栏、右键与 AI 删除使用同一套逻辑，作为一次可撤销的草稿操作。删除中间任务时，尽量衔接保留的前置与后续任务：保留两端的开始/完成关系类型，累加间隔分钟数，移除被删任务本身的工期；连续删除和分支链同样处理。已有直接关系原样保留，重复路径不重复建边，不创建自依赖、环路或父子依赖。数据库每对任务只能保存一条关系，多个新路径合并时优先启用路径，并选择当前工期下约束最强的一条。

因本次删除而失去全部有效前置的任务，起点重设到删除当天（北京时间；分钟项目使用删除时刻），工期保留，后续任务与摘要日期联动；显式日期约束仍然生效。仍有有效前置或删除后能衔接前置的任务按依赖继续排程。不会把项目状态日期当作删除日期。接口显式提交 `ids` 数组时仅删除列出的任务，保留的子任务挂到最近的保留祖先；单个 `id` 与界面删除包含整条子树。正式保存提交的日期与依赖按草稿原样入库，接口不会重复生成衔接关系。

回归：`npm run check`；`node scripts/test-task-delete-relations.cjs http://127.0.0.1:3138` 在独立临时项目中验证真实接口、工具栏和右键删除、日期与前置显示、撤销重做、保存重试和重开项目，结束后清理。通过 `DELETE_TEST_USER`、`DELETE_TEST_PASSWORD` 指定测试账号。

## AI 查询与汇总任务属性

AI 助手支持直接用自然语言查询任务自定义属性，如“按任务结束日期统计每月搬迁服务器台数”“后3个月搬迁多少台”“汇总2027年1月至3月的支出金额”或“查询任务 A 的机房属性”。欢迎区提供可点击的示例，优先使用当前项目已有数字/金额属性的名称；无需选择范围控件。

也可以直接问“本月安装多少台服务器”，无需输入精确的属性名称。AI 匹配现有数量属性，按当前自然月筛选，并从任务实际填报的值求和。属性名为“设备台数”等通用名称时，还会同时匹配“安装”和“服务器”，兼容词序变化和父级上下文，排除搬迁、交换机和其他月份；结果说明日期口径与筛选条件，并可展开查看各任务的层级、日期和填报数量。

默认按任务结束日期所在自然月归集，跨月任务整笔计入结束月份。“后3个月/未来三个月”默认从下月1日起的三个完整自然月；可直接说“含本月”“从今天起”或明确起止日期。回答使用文字，写明具体范围、各月数量和合计，可展开统计依据及任务明细。结果来自提问时的当前计划，包含未保存修改时会标明；查询不修改任务、状态日期或版本。

AI 负责理解提问，程序对完整项目精确计算，不受200条任务提示摘要或100条明细展示限制。不同任务上同名、同类型、同单位的属性可汇总，属性ID无需相同；不同单位/类型分别回答，不混加也不要求先选择。默认排除摘要、无效任务和停用属性，可在提问中明确包含。空值与0区分，缺失日期或非数字值会披露；金额保持精确小数。统计计划日期的填报量不会被描述为实际完工量。

父子任务都填写同一属性时，默认仅汇总叶子任务，排除父任务的重复填报。“只汇总父任务”仅统计摘要任务；多级父任务按层级分别给出结果。“父子分别统计”分别列出各层父任务和叶子任务，各层结果不相加。模型重复发起相同查询时只展示一份结果。属性名称可自行定义，属性值单独填写；即使名称为“6”，未填值时也会提示未填报，不能把名称当作数量或据此认定数量为零。

汇总随当前任务的实际填报变化，不设固定验收总数，也不从任务名称补数量。部分任务未填时，只汇总已填值并说明排除数量；选定范围全部未填时说明暂无已填记录，明确填报的 0 仍是有效值。父任务有值、子任务尚未填报时，也不会把子任务的汇总说成 0。

验证：`npm run check`；配置现有 AI 服务后执行 `node scripts/test-ai-attribute-language.cjs` 验证真实自然语言调用；`node scripts/test-ai-attributes-ui.cjs http://127.0.0.1:3117 --stub-ai` 仅用于本地界面与只读行为验证，去掉 `--stub-ai` 则使用真实 AI 服务。界面脚本只创建和清理专用测试项目。

`node scripts/test-ai-hierarchy-ui.cjs http://127.0.0.1:3127` 使用合成多级父子任务和真实 AI 接口，验证父子去重、仅父任务分层、父子分别统计及重复查询去重；所有项目接口均被隔离，不写数据库。用 `AI_HIERARCHY_PROVIDER_URL` 指定已配置 AI 的服务，`AI_HIERARCHY_USER` / `AI_HIERARCHY_PASSWORD` 指定测试登录账号。

## 自定义任务属性

双击任务打开编辑窗口，通过 **通用 → 编辑属性** 或 **自定义属性** 标签填写信息。“管理属性”中自行新增名称、类型和单位，支持文本、数字、金额、日期和单选。**定义和值均属于当前任务**，不设项目通用属性，不预设“支出金额”；其他任务可定义不同属性，也可使用同名但不同类型的属性。

- “完成设置”留在当前编辑窗口；点击任务“保存”后，属性定义和值一起进入前端草稿，可撤销/重做。取消窗口会丢弃本次属性编辑；草稿态点击顶部“保存”直接入库，稳定态通过“确认变更 → 确认并保存”入库。
- 草稿态直接保存，不审核、不填原因、不生成历史版本；稳定态的属性定义和数值变更按任务填写原因，随版本保存，并记入生命周期。
- 金额以精确十进制文本保存，最多 18 位整数、2 位小数，支持负数；数字最多 8 位小数。空值与 0 分别保留，不自动汇总父子任务的金额。
- 属性可改名、停用或重新启用；停用保留数据。已保存的类型固定，单选选项允许追加。旧项目的属性仅在已有填报数据的任务上显示，不自动分配给其他任务。
- 复制任务、复制项目及版本恢复包含任务自己的属性。在历史只读视图中，选中任务后通过“任务操作 → 查看任务属性”查看快照值。载入历史到草稿时，较新属性停用并保留数据；旧快照缺少属性信息时保留已有数据。
- Excel 在任务表及责任人表追加属性列，隐藏配置表保留每个任务的属性归属。请保留这些配置表；金额以文本导出以保留精度。相同定义共用文件列，同名但不同类型的属性分列，导入后恢复各任务原有名称、类型和空属性。
- 普通 Excel 的非内置列也可导入：仅在有值的任务上建立属性。以“金额/费用/成本/预算”结尾的列按金额处理，以“日期”结尾按日期处理，其余按文本处理。长编号按 Excel 显示文本保留，大金额须在源文件中使用文本。
- 合并导入只与同一任务的属性匹配；旧文件没带属性时保留已有数据。导入先进入草稿，确认前不入库。导入 API 支持每个任务的 `custom_fields` / `custom_values`，同一事务校验并保存，同时兼容旧版项目级字段请求。
- Project `.mpp` 使用可见原生自定义字段（成本、数字、日期、文本/单选），并保存逐任务的属性归属、ID、类型、单位、选项及停用状态。在 Project 中修改后，重新导入以实际字段值为准。外部 MPP 原生属性也支持导入。状态日期、项目线和停用依赖保留；工期默认按天显示，分钟项目按分钟显示。
- Project 原生字段限制：文本 30 个、数字 20 个、成本及日期各 10 个，文本最多 255 字符。同定义的任务属性共用字段；超出原生数值精度时转为文本字段，字段不足或文本过长时明确提示改用 Excel，不生成缺失数据的文件。导出后会回读 MPP 校验属性值和归属。

MPP 文件回归使用已有 Aspose 依赖和许可证，不需要安装 Microsoft Project：

```bash
dotnet publish aspose-tasks-cli/AsposeTasksCli.csproj -c Release -o aspose-tasks-cli/publish
dotnet build aspose-tasks-tests/AsposeTasksTests.csproj -c Release
ASPOSE_TASKS_LICENSE=/path/to/Aspose.Total.lic node scripts/test-project-attributes.cjs
```

这会验证实际 MPP 的原生字段、金额精度、外部字段编辑、空值/零值、层级、工期、状态日期、项目线和文件格式边界。浏览器页面与 Microsoft Project 桌面显示仍需单独验收。部署脚本校验 CLI 源码指纹，防止新版页面继续使用旧版 MPP 工具。

任务属性的真实浏览器点击验收（使用独立 Chrome，只创建及清理本轮专用测试项目）：

```bash
node scripts/test-task-attributes-ui.cjs http://127.0.0.1:3117
```

默认显示浏览器，可用 `ATTR_UI_HEADLESS=1` 无窗口执行，登录通过 `ATTR_UI_USER` / `ATTR_UI_PASSWORD` 配置。验收属性入口、新增配置、填写、校验提示清除、撤销/重做、确认前零写入、草稿直接保存无审核、无需状态日期、断网后重试、切回草稿不复用旧原因、草稿不生成版本、稳定态原因、金额空值/零值、重新进入后数据保留及状态日期线；也通过菜单下载 Excel/MPP 并重新导入，验证属性保留及导入撤销。测试服务须配置可运行的 MPP 转换程序及许可证。结果、下载文件和截图输出到系统临时目录。按钮和文本使用浏览器真实鼠标和键盘输入，下拉框使用 Puppeteer 的标准选择接口，不替换接口响应或直接改应用状态。

任务条拖动只响应按住鼠标左键的移动，避免松开后或切换输入设备时把普通移动误认为拖动。上述点击验收也覆盖未按键移动、正常拖动与撤销、连续双击编辑窗口；这些操作均不直接写入后台。

升级已有数据库时执行增量迁移（可重复执行，不修改既有任务值）：

```bash
node --env-file=.env.local scripts/migrate-task-custom-fields.cjs
```

`npm run db:init` 和 VPS 部署的 SQL 迁移流程也包含此迁移。验证命令：

```bash
npm run check
CUSTOM_FIELDS_TEST_URL=http://127.0.0.1:3117 npm run test:attributes
npm run build
```

属性集成测试仅创建带随机前缀的测试项目并清理这些项目，覆盖逐任务定义隔离、金额精度、校验失败回滚、旧客户端兼容、版本恢复、项目复制、真实 MPP 往返、导入事务和只读权限。

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

### 甘特图日常操作

- “新建任务”“编辑任务”保留在工具栏；复制、粘贴、层级调整和批量修改集中在“任务操作”。自定义属性从当前任务的编辑窗口设置和填写。
- “显示设置”集中管理显示列、甘特图标记、任务展开与折叠，以及“常用布局”。保存布局会记住筛选、列宽和时间轴位置，仅保存浏览器显示偏好，兼容此前保存的视图，不修改任务或生成项目版本。
- 前置/后续任务的选择支持直接输入左侧“编号”（如 `12` 或 `#12`），按回车关联；也可按名称搜索和使用方向键选择。列表最多渲染 30 项，大编号直接定位，无需展开全部任务。单元格弹层中，对已关联编号再次回车可取消关系；编辑任务窗口中可选中既有关系并删除。禁止关联自身、摘要任务或形成循环的任务。编号采用当前任务列表的序号，不使用内部任务编码。
- 状态日期线、撤销/重做、草稿和稳定态规则继续生效；草稿态点击“保存”直接入库，稳定态经“确认变更”审核后入库。

真实点击验收脚本也覆盖显示布局、逐任务属性隔离和编号依赖编辑。可在本地使用 `ATTR_UI_TASK_COUNT=200` 创建较大测试项目，核对候选列表上限和记录弹层打开耗时；脚本仍会清理专用测试项目。
