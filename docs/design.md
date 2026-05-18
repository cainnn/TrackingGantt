# 甘特图管理系统 — 详细设计文档

> 版本：2.0 · 日期：2026-05-19 · 代码规模：~17,700 行 TypeScript/TSX

---

## 0. 文档定位

本文件描述系统的 **静态设计**：模块边界、数据模型、API 契约、状态机、调度算法、安全模型与部署形态。
**动态调用链**与**模块依赖图**见同目录 [`call-graph.md`](./call-graph.md)。

---

## 1. 系统概览

### 1.1 项目背景

面向中小型项目管理场景的 Web 端甘特图工具，支持任务层级、依赖关系（SS/SF/FS/FF）、版本快照、AI 助手、Excel/MPP 互导以及 Aspose 兼容。
两种时间精度：**天级** 与 **分钟级**（创建时固定，不可切换）。

### 1.2 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 前端框架 | Next.js 16 (App Router) + React 19 | 单页 + SSR 混合 |
| UI | Tailwind CSS 4 + 自研 SVG 甘特图 | 不依赖 dhtmlx/bryntum 等第三方甘特库 |
| 状态 | Redux Toolkit 2.x + React-Redux 9.x | 5 个 slice |
| 后端 | Next.js Route Handlers (Node runtime) | RESTful JSON |
| 数据库 | PostgreSQL 18 | pgcrypto + JSONB |
| 鉴权 | JWT (HS256) + bcryptjs | 7 天有效期，Cookie + Bearer 双通道 |
| AI | OpenAI SDK (函数调用) | tools 协议 |
| 导入导出 | xlsx / exceljs / Aspose.Tasks (.NET CLI) | MPP 走 C# 子进程桥接 |

### 1.3 运行时拓扑

```
浏览器 ──HTTPS──▶ Next.js Node 进程 ──pg pool──▶ PostgreSQL 18
                       │
                       ├──▶ OpenAI API（AI 对话）
                       └──▶ child_process: dotnet aspose-tasks-cli（MPP 读写）
```

部署：单 VPS · pm2 + 反向代理；脚本位于 `scripts/deploy-vps.sh`。

---

## 2. 总体架构

### 2.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ 表示层  app/* (页面) · components/* (React 组件)            │
├────────────────────────────────────────────────────────────┤
│ 状态层  store/slices/* (Redux Toolkit)                      │
├────────────────────────────────────────────────────────────┤
│ 业务层  app/api/*/route.ts (Route Handlers)                 │
│         lib/scheduling.ts · lib/versionDiff.ts · lib/ai     │
├────────────────────────────────────────────────────────────┤
│ 持久层  lib/db.ts (pg Pool) → PostgreSQL                    │
└────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计原则

1. **服务端为唯一真相源**：客户端的乐观更新仅用于即时反馈，最终以服务端 `RETURNING *` 覆盖。
2. **每事务一把项目锁**：所有写路径都用 `pg_advisory_xact_lock(hashtext(projectId))`，配合 `lock_timeout=10s`，避免并发竞争。
3. **共享调度引擎**：`lib/scheduling.ts` 被 tasks/dependencies/import 等多条写路径复用，避免逻辑分叉。
4. **Result Pattern 统一错误模型**：`{ ok: true, value } | { ok: false, error, code }`，端到端不抛业务异常。
5. **Calendar days by design**：工期 / lag 使用自然日（分钟级项目则是自然分钟），不扣除工作日；进度按状态日期推导，不直接接受用户输入百分比。

---

## 3. 数据模型

### 3.1 实体关系图

```
users ──┐                              ┌── task_lifecycle
        │ 1:N                          │
        ▼                              │ 1:N
     projects ── 1:N ── tasks ─────────┘
        │                │
        │ 1:N            │ M:N (via dependencies)
        ▼                ▼
   project_versions   dependencies
   project_lines
   task_change_log
   login_logs
```

### 3.2 表结构（核心字段）

#### users
- `id UUID PK`、`username UNIQUE`、`email UNIQUE`、`password_hash`
- `role VARCHAR(20)` ∈ `administrator | admin | view`
- 预置三个账号：`administrator/admin123`（管用户）、`admin/...`、`view/view123`（只读）

#### projects
- `id UUID PK`、`user_id FK→users`、`name`
- `start_date / end_date / status_date DATE`
- `time_granularity VARCHAR(10)` ∈ `day | minute`（创建时固定）

#### tasks
- 主键：`id UUID`；归属：`project_id`、`parent_id`（自引用，CASCADE）
- 日期：`start_date / end_date DATE`、`duration INTEGER`、`duration_unit`（分钟级时单位为分钟）
- 调度：`auto_schedule BOOL`、`constraint_type` ∈ `asap | alap | muststarton | mustfinishon | startnoearlierthan | finishnoearlierthan | none`、`constraint_date`
- 状态：`percent_done`、`status` ∈ `notstarted | started | completed | late`、`deadline`、`baseline_end_date`
- 软删除：`is_deleted`、`deleted_at`
- 摘要恢复：`original_start_date / original_end_date`（首次成为摘要任务时保存）
- 其他：`is_milestone`、`rollup`、`inactive`、`project_boundary`、`order_index`、`task_code`、`assignee`、`note`

#### dependencies
- `from_task_id`、`to_task_id`（CASCADE）
- `type INTEGER`：`0=SS, 1=SF, 2=FS, 3=FF`
- `lag INTEGER`（自然日 / 分钟）、`active BOOL`
- `UNIQUE(from_task_id, to_task_id)` 防止重复连线

#### project_versions
- `version_number`（项目内自增）、`snapshot JSONB`（完整任务+依赖快照）
- `changes JSONB`（与上一版本的 diff 列表，由 `versionDiff.ts` 生成）
- `status_date`、`is_autosave`

#### task_lifecycle
- 任务级审计：`event_type` ∈ `created | updated | deleted | moved`
- `field_name`、`old_value`、`new_value`、`description`、`created_by`

#### task_change_log
- 「状态日期之前」的回溯修改审计（区别于 lifecycle，只在历史区改动时写）

#### project_lines
- 自定义垂直标记线：日期 + 颜色 + 可见性

### 3.3 索引

- `idx_tasks_project_id` / `idx_tasks_parent_id` / `idx_tasks_is_deleted`
- `idx_dependencies_project_id` / `idx_dependencies_from_task` / `idx_dependencies_to_task`
- `idx_task_lifecycle_*`、`idx_tcl_*`、`idx_project_versions_project_id`、`idx_login_logs_*`

### 3.4 触发器

- `update_updated_at_column()`：通用 BEFORE UPDATE 触发器，刷新 `updated_at`，挂在 users / projects / tasks / dependencies / project_lines 上。

### 3.5 类型映射约定

- pg 默认会把 DATE 解析成 `Date` 对象，经 `JSON.stringify → toISOString()` 会出现 UTC 偏移导致**日期错一天**。
- 项目在 `lib/db.ts` 中显式覆盖：`types.setTypeParser(1082, val => val)`，让 DATE 始终以 `YYYY-MM-DD` 字符串原样返回。
- 分钟级精度使用 `'YYYY-MM-DDTHH:mm:00'` 字符串，由 `lib/clientTime.ts` 提供原语（`toDateTimeStr` / `parseLocal` / `addMinutesStr` / `diffMinutesStr`）。

---

## 4. 模块设计

### 4.1 lib/

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `db.ts` | 38 | pg Pool 单例，覆盖 DATE 类型解析；可调超时通过环境变量 |
| `auth.ts` | 24 | `signToken / verifyToken`，JWT HS256，7 天 |
| `middleware.ts` | 33 | `getAuthUser`（Cookie/Bearer 双通道）；`requireWrite`（view 拦截 403）；`requireAdministrator` |
| `result.ts` | 19 | `success(v)` / `failure(msg, code)` 工厂 |
| `scheduling.ts` | 393 | 调度引擎：依赖级联 `cascadeDependencies()`、摘要任务汇总 `updateSummaryTasksDates()`、循环检测 `wouldCreateCycle()`、日期工具 |
| `clientScheduling.ts` | 322 | 浏览器侧轻量版调度（拖动时的即时预览） |
| `clientTime.ts` | 103 | 分钟级时间字符串原语 |
| `clientSave.ts` | 126 | 客户端保存编排（合并 dirtyIds、AbortController、错误降级） |
| `projectProgress.ts` | 34 | 项目级进度百分比（基于 status_date 推导） |
| `versionDiff.ts` | 89 | 两版本快照的字段级 diff，输出 `VersionChanges` |
| `asposeTasksRunner.ts` | 163 | 通过 `child_process` 调用 dotnet aspose-tasks-cli 解析/构建 .mpp |
| `uuid.ts` | 21 | UUID v4 简版 |
| `ai/tools.ts` | 371 | OpenAI 函数调用工具 schema（create_task / update_task / delete_task / add_dependency / ...） |
| `client/authFetch.ts` | 31 | 带 token 的 fetch 封装，401 自动跳登录 |
| `client/excelImport.ts` | 378 | xlsx 解析 → 任务/依赖列表 + 客户端校验 |
| `client/excelExport.ts` | 391 | 任务/依赖列表 → xlsx |
| `client/chartExport.ts` | 519 | 甘特图导出为 JPEG / PDF（puppeteer 渲染） |

### 4.2 store/slices/

| Slice | 关键状态 | 设计要点 |
| --- | --- | --- |
| `authSlice` | `token`、`user` | 持久化到 localStorage |
| `projectSlice` | `projects[]`、`currentProject` | 项目列表 + 当前项目 |
| `tasksSlice` | `tasks[]`、`dependencies[]`、`dirtyIds[]`、`selectedIds[]`、`comparison`、`viewSnapshot`、`diffFilter`、`clipboard*` | 乐观更新 + 脏标记；**不**做 undo/redo（已被剔除，撤销在 GanttChart 内部管理） |
| `versionsSlice` | `versions[]` | 项目版本列表 |
| `projectLinesSlice` | `lines[]` | 自定义标记线 |

> 设计取舍：`tasksSlice` 之前包含 `undoStack/redoStack/saveSnapshot`，但因 Redux 序列化大量任务的开销过高，已下沉到 `components/GanttChart/GanttChart.tsx` 内部使用 ref + 单页内存数组管理；最多 50 层，刷新丢失。

### 4.3 components/

```
components/
├── GanttChart/
│   ├── GanttChart.tsx        4607 行  主视图：左面板表格 + SVG 时间轴 + 拖动/级联/右键
│   ├── GanttToolbar.tsx      2284 行  顶部工具栏：CRUD / 保存 / 导入 / 导出 / 版本 / 搜索 / 快捷键
│   ├── EditTaskModal.tsx      933 行  任务详情弹窗（依赖编辑、约束、责任人、备注）
│   ├── VersionPanel.tsx       653 行  版本列表 / 对比 / 恢复
│   ├── AIChatPanel.tsx        726 行  AI 助手侧栏 + tool_calls 派发
│   ├── ProjectLinesPanel.tsx  192 行  自定义标记线管理
│   ├── RetroLogPanel.tsx       93 行  回溯变更日志面板
│   └── constants.ts            15 行  共享常量（条高、行高）
├── ProjectCard.tsx            193 行  仪表盘项目卡片
├── UserManagement.tsx         255 行  administrator 角色专用用户管理面板
├── YmdDateInput.tsx           173 行  日期输入控件（容错 `2026/5/19`、`20260519` 等格式）
└── auth/{LoginForm,RegisterForm}.tsx
```

### 4.4 app/

```
app/
├── layout.tsx                 根布局：注入 Redux Provider + sonner toast
├── page.tsx                   ↑ 重定向 /dashboard
├── login / register           表单页（公开）
├── dashboard/page.tsx         项目列表 + 项目卡片
├── projects/[id]/page.tsx     甘特图主页：拉取项目/任务/依赖，组装 Toolbar + Chart + AI
└── api/                       所有 REST 端点（见 §5）
```

---

## 5. API 设计

### 5.1 鉴权约定

- 写操作：`POST/PUT/DELETE` 一律先调用 `requireWrite(auth)`，view 角色直接 403。
- 项目归属校验：每个 `[projectId]` 路由先 `verifyProjectOwnership(projectId, userId)`，跨用户访问返回 404。
- 响应格式：恒为 `{ ok: boolean, value?: T, error?: string, code?: number }`。

### 5.2 端点清单

#### Auth — `app/api/auth/`
| Method · Path | 行为 |
| --- | --- |
| `POST /login` | bcrypt 校验 → 签 JWT → set-cookie `token`，写 `login_logs` |
| `POST /register` | 注册（默认 role=`admin`） |
| `POST /logout` | 清 cookie |

#### Users — `app/api/users/`
| Method · Path | 行为 |
| --- | --- |
| `GET /` | 列表（`administrator` 可见全部） |
| `POST /` | 创建用户（仅 `administrator`） |
| `PUT /` | 改密 / 改角色（仅 `administrator`） |
| `DELETE /` | 删除用户（仅 `administrator`） |

#### Projects — `app/api/projects/`
| Method · Path | 行为 |
| --- | --- |
| `GET /` | 当前用户项目列表（view 用户可看全部） |
| `POST /` | 创建项目，可选 `time_granularity` |
| `GET /[id]` | 项目详情；返回时若 `status_date` 已设置则跳过 auto-anchor |
| `PUT /[id]` | 改名、改起止/状态日期 |
| `DELETE /[id]` | 级联删除（CASCADE） |

#### Tasks — `app/api/tasks/[projectId]/`
| Method · Path | 行为 |
| --- | --- |
| `GET /` | 全部任务 + 依赖；含一致性自检（使用 Map + 单遍 min-max，去 O(n²)） |
| `POST /` | 单任务创建（事务 + advisory lock + nextTaskCode + addLifecycle + updateSummaryTasksDates） |
| `PUT /` | 批量更新（最常用写路径，见 §6 调度引擎） |
| `DELETE /` | 软删（递归收集子任务） |
| `GET/PUT/DELETE /[taskId]` | 单任务操作 |
| `GET /changelog` | 历史变更（task_change_log） |
| `GET /retrolog` | 回溯日志（粒度更细的 task_lifecycle 查询） |
| `POST /fix-project` | 修复模式：重算所有摘要任务 + 级联 |
| `POST /direct-fix` | 单任务直接修复（绕过部分校验） |
| `POST /reset-date` | 把 baseline_end_date 重置为当前 end_date |
| `POST /enable-auto-schedule` | 批量打开 auto_schedule |

#### Dependencies — `app/api/dependencies/[projectId]/`
| Method · Path | 行为 |
| --- | --- |
| `GET /` | 列表 |
| `POST /` | 新建（先 `wouldCreateCycle` 检测） |
| `PUT /` | 改 type / lag / active |
| `DELETE /` | 删除 |
> 写操作均触发 `cascadeDependencies + updateSummaryTasksDates`。

#### Versions — `app/api/versions/[projectId]/`
| Method · Path | 行为 |
| --- | --- |
| `GET /` | 版本列表 |
| `POST /` | 创建版本（snapshot + diff） |
| `DELETE /` | 删除版本 |
| `GET /diff` | 任意两版本 diff |

#### Import & MPP
| Path | 行为 |
| --- | --- |
| `POST /api/import/[projectId]` | Excel 导入：replace / merge |
| `POST /api/mpp/parse` | 上传 .mpp → 任务/依赖 JSON（走 aspose-tasks-cli） |
| `POST /api/mpp/build` | 任务/依赖 JSON → 下载 .mpp |

#### AI
| Path | 行为 |
| --- | --- |
| `POST /api/ai/chat` | 透传 OpenAI `chat.completions.create`，注入系统提示词 + `AI_TOOLS` schema |

#### Project Lines
| Path | 行为 |
| --- | --- |
| `GET/POST/PUT/DELETE /api/project-lines/[projectId]` | 标记线 CRUD |

---

## 6. 调度引擎（lib/scheduling.ts）

### 6.1 接口

```ts
cascadeDependencies(client, projectId): Promise<string[]>     // 返回被级联更新的 taskIds
updateSummaryTasksDates(client, projectId): Promise<TaskLike[]>
updateSummaryTaskDateRecursive(client, taskId, collected?, _visited?)
wouldCreateCycle(fromId, toId, existingDeps): boolean
```

### 6.2 cascadeDependencies — 迭代式依赖级联

```
1. SELECT 全部 active 依赖 + 任务（含 auto_schedule / inactive / 约束）
2. 过滤掉：
   · 父子关系依赖（摘要日期由子任务汇总，不应反向）
   · active=false 的依赖
   · inactive 任务（任意祖先）
3. 按 to_task_id 分组
4. while (changed && iter < 500):
     for each 后继任务 to:
       if auto_schedule == false: continue
       聚合所有前置任务 → 取 max(requiredStart):
         FS(2): from.end + lag
         SS(0): from.start + lag
         FF(3): from.end + lag - dur
         SF(1): from.start + lag - dur
       应用硬约束：muststarton / mustfinishon / startnoearlierthan / finishnoearlierthan
       如果 newStart != toStart → UPDATE start_date/end_date/duration
5. 返回被改动的 taskIds
```

防御点：`MAX_CASCADE_ITERATIONS = 500`，遇异常数据兜底退出。

### 6.3 updateSummaryTasksDates — 摘要任务汇总

```
DISTINCT parent_id → 逐一递归 updateSummaryTaskDateRecursive:
  · 取所有 is_deleted=false 的子任务
  · minStart = min(child.start)，maxEnd = max(child.end)
  · 首次成为摘要任务时：保存 original_start_date / original_end_date
  · 子任务清空后：从 original_* 恢复（叶子化）
  · 递归向上更新祖先
```

### 6.4 wouldCreateCycle — BFS 环路检测

从 `toId` 沿正向走，能否到达 `fromId`；自依赖直接返回 true。

### 6.5 客户端镜像 — clientScheduling.ts

为拖动 / 内联编辑提供即时预览，算法与服务端一致，但只更新内存状态。最终保存仍以服务端结果为准。

---

## 7. 状态管理细节

### 7.1 dirty 机制

- 用户每次乐观更新前 dispatch `markDirty([taskIds])`。
- `GanttToolbar.handleSaveChanges()` 取 `tasks.filter(t => dirtyIds.includes(t.id))` 组 payload。
- 服务端返回后 `clearDirty()`，同时用 `updateTasks(response.value)` 覆盖。
- 30s 超时由 `AbortController` 控制；`saveAbortRef.current?.abort()` 取消上一个未完成请求，避免并发保存。

### 7.2 撤销 / 重做（GanttChart 内部）

不在 Redux 中，避免每次序列化大量任务。
- 内部 `useRef<{tasks, deps}[]>` 保存最多 50 层快照。
- `Ctrl+Z / Ctrl+Y` 由 GanttToolbar 监听后通过自定义事件通知 GanttChart。

### 7.3 comparison / viewSnapshot / diffFilter

| 字段 | 用途 |
| --- | --- |
| `comparison` | 顶部「基线对比」横线，由「确认变更」时设置 |
| `viewSnapshot` | 浏览历史版本时的只读视图（`isViewOnly=true`，禁用编辑） |
| `diffFilter` | 按版本变更列表过滤行（只显示 changed/added/removed 的 task_code） |

---

## 8. 关键业务流（指向调用链）

下列流程的逐步调用栈见 [`call-graph.md`](./call-graph.md)。

1. 任务条拖动（leaf / summary）
2. 保存改动（PUT /api/tasks）
3. 创建任务（POST）
4. 删除任务（软删 + 递归）
5. 添加依赖（连线拖拽 + 环路检测 + 级联）
6. 版本快照（重算 percent_done → 保存 → 创建版本 → 设对比基线）
7. Excel 导入（replace / merge + 自动建版本）
8. AI 对话（OpenAI tool_calls → REST → Redux 更新）
9. 内联编辑（双击单元格 + 客户端级联预览）
10. 撤销 / 重做（GanttChart 内部 ref 栈）
11. MPP 导入/导出（child_process → aspose-tasks-cli）

---

## 9. 安全设计

| 攻击面 | 缓解 |
| --- | --- |
| SQL 注入 | 全量参数化查询（pg `$1, $2`），无字符串拼接 |
| 鉴权 | JWT HS256 + bcryptjs (cost 10) + httpOnly cookie |
| CSRF | API 仅接受 JSON；Cookie 携带 token 时配合 Bearer 优先级；管理端口仅同源访问 |
| 越权 | 每次 `[projectId]` 路由先验项目归属；view 角色 `requireWrite` 拦截 |
| 长事务 | `statement_timeout=15s` / `lock_timeout=5s` / `idle_in_transaction_session_timeout=15s` |
| 并发写 | `pg_advisory_xact_lock(hashtext(projectId))` 串行化项目内事务 |
| AI 注入 | OpenAI tool_calls 经客户端二次校验（参数白名单）才回执行 REST |
| 敏感日志 | password_hash 永不返回；JWT secret 走环境变量 |

---

## 10. 性能要点

- `app/api/tasks/[projectId] GET` 中的一致性自检：用 Map + 单遍 min-max 取代嵌套循环，从 O(n²) 降到 O(n)（commit `cc061fe`）。
- `app/api/tasks/[projectId] PUT`：
  - 一次 `SELECT ... WHERE id IN (...)` 拉全旧值，避免逐条查询
  - lifecycle 事件聚合后一次多行 INSERT
  - 父任务名一次 IN(...) 查出
- 拖动时的客户端预览用 `throttledSetPreview`（trailing throttle, 16ms）。
- `next.config.ts` 启用 `compress: true`，天级项目工期/lag 只显示天（commit `84a527d`）。
- 项目加载：有 `status_date` 时跳过 auto-anchor（commit `ec31328`）。

---

## 11. 部署与运维

| 脚本 | 用途 |
| --- | --- |
| `scripts/init-db.js` / `init-db.sql` | 初始化 schema + 触发器 + 预置用户 |
| `scripts/migrate.ts` | 增量迁移驱动 |
| `scripts/migrate-*.sql` | 增量迁移文件（autosave / deadline / minute / version / role …） |
| `scripts/db-backup.sh` / `db-restore-latest.sh` | 备份恢复 |
| `scripts/deploy-vps.sh` / `deploy-vps-minute.sh` | VPS 全量/分钟级部署 |
| `scripts/sync-from-vps.sh` | 从 VPS 拉回本地（开发同步） |

部署变量：
- `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD`
- `DB_POOL_MAX / DB_*_TIMEOUT_MS`
- `JWT_SECRET`（生产必须覆盖）
- `OPENAI_API_KEY`

`package.json` 提供：`dev / build / start / deploy:vps / deploy:fast / deploy:local`，以及分钟级镜像端口 `dev:minute`（3001）。

---

## 12. 已知约束与设计取舍

| 项 | 选择 | 备注 |
| --- | --- | --- |
| 工期单位 | 自然日 / 自然分钟 | 不扣工作日；产品决定 |
| 进度计算 | 基于 status_date 推导 | 用户不直接输入 `percent_done`；详见 `feedback_time_based_percent.md` |
| 项目精度 | 创建时固定 | 防止 day↔minute 反复换算误差 |
| MPP 接入 | C# CLI + child_process | 不使用 Python/Java 绑定；详见 `feedback_aspose_csharp_bridge.md` |
| 变更落地 | 工具直接执行，不打开对话框 | 详见 `feedback_no_dialog_output.md` |
| 撤销 | 内存栈，不持久化 | 刷新丢失，最多 50 层 |
| 依赖去重 | DB 唯一约束 + 客户端预检 | `UNIQUE(from_task_id, to_task_id)` |

---

## 13. 文件索引

- 数据库 schema：[`scripts/init-db.sql`](../scripts/init-db.sql)
- 调度引擎：[`lib/scheduling.ts`](../lib/scheduling.ts)
- 类型契约：[`types/index.ts`](../types/index.ts)
- 路由组装：[`app/projects/[id]/page.tsx`](../app/projects/%5Bid%5D/page.tsx)
- 核心视图：[`components/GanttChart/GanttChart.tsx`](../components/GanttChart/GanttChart.tsx)
- 调用链与依赖图：[`call-graph.md`](./call-graph.md)
- 用户手册 / 功能规格：[`软件文档-甘特图管理系统.md`](./软件文档-甘特图管理系统.md)
- 运维说明：[`maintenance.md`](./maintenance.md)
