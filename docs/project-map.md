# 甘特图项目管理系统 — 完整项目地图（含调用链）

```
gantt-app/                          Next.js 16 + React 19 + Redux + PostgreSQL 18
├── 13,046 行 TypeScript            Tailwind CSS · JWT 认证 · OpenAI 集成
```

---

## 一、目录结构

```
├── types/index.ts                  全局类型: User, Project, Task, Dependency, ProjectVersion, ProjectLine
│
├── store/                          Redux Toolkit 状态管理
│   ├── index.ts                    5 slice: auth / project / tasks / versions / projectLines
│   ├── slices/authSlice.ts         token, user, role
│   ├── slices/projectSlice.ts      项目列表 + currentProject
│   ├── slices/tasksSlice.ts        tasks + deps + dirtyIds + undo/redo + clipboard
│   ├── slices/versionsSlice.ts     版本快照列表
│   └── slices/projectLinesSlice.ts 自定义标记线
│
├── lib/                            共享业务逻辑
│   ├── db.ts                       PostgreSQL 连接池
│   ├── auth.ts                     JWT 签发/验证
│   ├── middleware.ts               鉴权 + view 角色写权限拦截
│   ├── result.ts                   Result Pattern (success/failure)
│   ├── scheduling.ts               调度引擎: 依赖级联 + 摘要任务汇总 + 循环检测
│   ├── projectProgress.ts          项目进度百分比
│   ├── versionDiff.ts              版本差异对比
│   ├── ai/tools.ts                 AI 函数调用工具定义
│   └── client/
│       ├── authFetch.ts            带 token 的 fetch 封装
│       ├── excelImport.ts          Excel 导入解析
│       ├── excelExport.ts          Excel 导出
│       └── chartExport.ts          甘特图导出 JPEG/PDF
│
├── app/                            Next.js App Router
│   ├── layout.tsx                  根布局 (Redux Provider)
│   ├── page.tsx                    首页 → 重定向 /dashboard
│   ├── login/page.tsx              登录页
│   ├── register/page.tsx           注册页
│   ├── dashboard/page.tsx          项目仪表盘
│   ├── projects/[id]/page.tsx      甘特图主页面 (组装 Toolbar + Chart + AI)
│   └── api/                        RESTful API
│       ├── auth/{login,register,logout}/route.ts
│       ├── projects/route.ts & [id]/route.ts
│       ├── tasks/[projectId]/route.ts          GET/POST/PUT/DELETE
│       ├── tasks/[projectId]/[taskId]/route.ts 单任务
│       ├── tasks/[projectId]/changelog/route.ts
│       ├── dependencies/[projectId]/route.ts   依赖 CRUD
│       ├── versions/[projectId]/route.ts       版本 CRUD
│       ├── versions/[projectId]/{diff,restore}/route.ts
│       ├── import/[projectId]/route.ts         Excel 导入
│       ├── project-lines/[projectId]/route.ts  标记线
│       └── ai/chat/route.ts                    AI 对话
│
├── components/
│   ├── GanttChart/
│   │   ├── GanttChart.tsx     (3,456行) 核心: 左面板+SVG时间轴+拖动+级联+右键
│   │   ├── GanttToolbar.tsx   (1,210行) 工具栏: 创建/保存/导出/搜索/版本
│   │   ├── EditTaskModal.tsx  (729行)   任务详情编辑弹窗
│   │   ├── VersionPanel.tsx   (612行)   版本管理面板
│   │   ├── AIChatPanel.tsx    (647行)   AI 助手侧栏
│   │   └── ProjectLinesPanel.tsx (192行) 标记线管理
│   ├── ProjectCard.tsx               项目卡片
│   └── auth/{LoginForm,RegisterForm}.tsx
│
├── scripts/
│   ├── init-db.sql             表结构+索引+触发器+预置用户
│   ├── migrate.ts / seed-demo.ts
│   └── db-backup.sh / deploy-vps.sh
│
└── 数据库 (PostgreSQL 18)
    users / projects / tasks / dependencies / task_lifecycle / project_versions / project_lines
```

---

## 二、10 条核心调用链

---

### 1. 任务条拖动

```
用户 mousedown 任务条
  → GanttChart.tsx:938  onBarMouseDown()     检测 move/resize-left/resize-right
  → setDrag({ taskId, origStart, origEnd, mode })

用户 mousemove
  → GanttChart.tsx:1035 onMove()             全局监听
    → 计算 days = round(dx / colW)
    → 叶子任务: 计算 newStart/newEnd
      → GanttChart.tsx:1192 遍历 downstreamCache 迭代级联 (SS/SF/FS/FF)
      → GanttChart.tsx:1251 刷新摘要父任务日期
    → 摘要任务: 平移所有后代 + 级联外部下游
      → GanttChart.tsx:1048 getDescendantIds() 收集后代
      → GanttChart.tsx:1084 迭代级联外部依赖
      → GanttChart.tsx:1121 refreshSummary() 刷新祖先
    → throttledSetPreview(map)               trailing throttle, 16ms

用户 mouseup
  → GanttChart.tsx:1337 onUp()
    → 取 finalPreview = Object.values(previewMap)
    → 叶子: dirtyList = [被拖任务]          (服务端自动级联下游)
    → 摘要: dirtyList = 非摘要后代+外部级联
    → dispatch(saveSnapshot())               → tasksSlice:137 推入 undoStack
    → dispatch(updateTasks(allUpdated))      → tasksSlice:60  乐观更新全部(含级联+摘要)
    → dispatch(markDirty(dirtyList))         → tasksSlice:104 标记脏任务

用户点击保存 (或 Ctrl+S)
  → 见调用链 2
```

---

### 2. 保存改动

```
用户点击保存按钮 / Ctrl+S
  → GanttToolbar.tsx:836 handler(Ctrl+S)     键盘快捷键
  → GanttToolbar.tsx:773 handleSaveChanges()
    → 取消前一个未完成请求 saveAbortRef.current?.abort()
    → 30s 超时 AbortController
    → 过滤 dirtyTasks = tasks.filter(id ∈ dirtyIds)
    → 构建 payload: { id, name, start_date, end_date, duration, ... }
    → authFetch('PUT /api/tasks/{projectId}', { body, signal })

服务端 PUT
  → route.ts:341 PUT()
    → route.ts:374 lockProjectTx()           advisory lock + 10s timeout
    → route.ts:381 批量 SELECT 旧任务        一次 IN(...) 查出全部
    → 逐条处理:
      → 里程碑约束 (duration=0, end=start)
      → 字段校验 (name非空, duration≥0, percent 0-100, start≤end)
      → route.ts:448 UPDATE tasks ... RETURNING *
      → 收集 lifecycle 事件到数组
      → 如 parent_id 变更: updateSummaryTaskDateRecursive()
    → route.ts:565 批量查询父任务名称        一次 IN(...) 查出
    → route.ts:604 addLifecycleBatch()       一次 multi-row INSERT 全部事件
    → scheduling.ts:91 cascadeDependencies() 迭代式依赖级联
      → SELECT 全部依赖 + 任务
      → while(changed) 循环: 按 SS/SF/FS/FF 计算 requiredStart → UPDATE
    → scheduling.ts:207 updateSummaryTasksDates() 摘要任务日期汇总
      → 逐个父任务: SELECT children → 计算 min(start), max(end) → UPDATE
    → 补全 partial 任务对象
    → COMMIT

响应回到前端
  → GanttToolbar.tsx:805
    → dispatch(clearDirty())                 → tasksSlice:109
    → dispatch(updateTasks(response.value))  → tasksSlice:60  服务端确认覆盖
```

---

### 3. 创建任务

```
用户点击「创建任务」
  → GanttToolbar.tsx:338 handleAddTask()
    → 计算默认日期 (项目 start_date + 7天)
    → 计算 order_index = max(同级) + 1
    → authFetch('POST /api/tasks/{projectId}', { name, start_date, end_date, duration, ... })

服务端 POST
  → route.ts:186 POST()
    → lockProjectTx()
    → nextTaskCode()                         SELECT MAX(task_code) + 1
    → normalizeDate() + 项目开始日期限制
    → INSERT INTO tasks ... RETURNING *
    → addLifecycle({ event_type: 'created' })
    → updateSummaryTasksDates()
    → COMMIT

响应
  → GanttToolbar.tsx:363
    → dispatch(saveSnapshot())
    → dispatch(addTasks(response.value))     → tasksSlice:57
    → dispatch(setSelectedIds([newId]))
```

---

### 4. 删除任务

```
用户右键 → 删除 / 选中后点删除
  → GanttToolbar.tsx:369 handleDeleteTasks()
    → confirm('确定删除?')
    → authFetch('DELETE /api/tasks/{projectId}', { ids: selectedIds })

服务端 DELETE
  → route.ts:582 DELETE()
    → lockProjectTx()
    → 递归收集子任务: while(frontier) SELECT children → allIds
    → UPDATE tasks SET is_deleted=true WHERE id IN(allIds)
    → 逐条 addLifecycle({ event_type: 'deleted' })
    → COMMIT

响应
  → GanttToolbar.tsx:379
    → dispatch(saveSnapshot())
    → dispatch(deleteTasks(response.value.deleted))  → tasksSlice:66
```

---

### 5. 添加依赖 (连线拖拽)

```
用户 mousedown 任务条右侧圆点
  → GanttChart.tsx:984 onConnectMouseDown()
    → setConnect({ fromTaskId, fromX, fromY })

用户 mousemove
  → GanttChart.tsx:1293 更新 connect.curX/curY
  → SVG 渲染拖拽线

用户 mouseup 在目标任务上
  → GanttChart.tsx:1407 onUp() connect 分支
    → 验证: 不同任务 + 非摘要 + 不重复
    → dispatch(saveSnapshot())
    → dispatch(addDependency({ id: tempId, type: 2, lag: 0 }))  乐观添加
    → 目标任务 auto_schedule=false 时自动切换为 true
    → authFetch('POST /api/dependencies/{projectId}', { from_task_id, to_task_id })

服务端 POST
  → dependencies/route.ts POST()
    → lockProjectTx()
    → wouldCreateCycle() (scheduling.ts:65)   BFS 环路检测
    → INSERT INTO dependencies
    → 启用目标任务 auto_schedule
    → cascadeDependencies()                   级联下游
    → updateSummaryTasksDates()
    → COMMIT → 返回 { dependency, updatedTasks }

响应
  → GanttChart.tsx:1424
    → dispatch(removeDependency(tempId))      移除临时
    → dispatch(addDependency(real))           添加真实
    → dispatch(updateTasks(updatedTasks))     级联结果
```

---

### 6. 版本快照 (确认变更)

```
用户设置状态日期 → 点击「确认变更」
  → GanttToolbar.tsx:700 handleConfirmChanges()
    → 校验: 状态日期必须晚于上一版本
    → Step 1: 重算所有任务 percent_done (基于状态日期)
      → calcPercent(task, sdDate)
      → PUT /api/tasks 更新 percent_done
    → Step 2: 保存脏任务 (同调用链 2)
    → Step 3: POST /api/versions/{projectId}
      → body: { tasks, dependencies, status_date }

服务端 POST
  → versions/route.ts POST()
    → 获取 version_number = max + 1
    → diffSnapshots() (versionDiff.ts)       与上一版本对比
    → INSERT INTO project_versions (snapshot: JSONB, changes: JSONB)
    → COMMIT

响应
  → GanttToolbar.tsx:747
    → dispatch(setComparison({ tasks, versionName }))  设为对比基线
    → 刷新版本列表
```

---

### 7. Excel 导入

```
用户点击导入图标 → 选择 .xlsx 文件
  → GanttToolbar.tsx:235 handleImport()
    → excelImport.ts parseExcelFile(file)    解析 Sheet → tasks[] + deps[]
    → validateImportData()                   客户端校验
    → 用户选择: 替换 / 合并
    → authFetch('POST /api/import/{projectId}', { tasks, deps, mode, status_date })

服务端 POST
  → import/route.ts POST()
    → lockProjectTx()
    → Replace 模式: UPDATE is_deleted=true (全部旧任务)
    → 逐条 INSERT tasks (自动 task_code)
    → 建立 task_code → id 映射
    → 逐条 INSERT dependencies (通过映射解析 from/to)
    → cascadeDependencies()                  级联
    → updateSummaryTasksDates()              汇总
    → COMMIT
    → 读取最终数据 (tasks + deps)
    → 自动创建版本快照 POST versions
    → diffSnapshots() 计算变更

响应
  → GanttToolbar.tsx:290
    → dispatch(setTasks({ tasks, deps }))    全量替换 Redux
    → dispatch(setComparison(...))           对比基线
    → 刷新版本列表
```

---

### 8. AI 对话

```
用户输入消息 → 点击发送
  → AIChatPanel.tsx:360 sendMessage()
    → 检测意图: isSummaryIntent() → 附加版本差异上下文
    → authFetch('POST /api/ai/chat', { messages, tasks, deps, ... })

服务端 POST
  → ai/chat/route.ts POST()
    → buildSystemPrompt()                    构建系统提示词
    → OpenAI chat.completions.create({ tools: AI_TOOLS })
    → 返回 { content, tool_calls? }

客户端处理 tool_calls
  → AIChatPanel.tsx:60 executeToolCalls()
    → 遍历 tool_calls:
      → create_task  → POST /api/tasks/{projectId}
      → update_task  → PUT  /api/tasks/{projectId}
      → delete_task  → DELETE /api/tasks/{projectId}
      → add_dependency → POST /api/dependencies/{projectId}
    → 每个调用: dispatch(saveSnapshot()) + Redux 更新
    → 收集结果 → 发送 follow-up 给 OpenAI
    → 获取最终回复 → 显示在聊天面板
```

---

### 9. 内联编辑

```
── 任务名编辑 ──
双击任务名
  → GanttChart.tsx:2429 onDoubleClick → setEditId(t.id); setEditName(t.name)
  → useEffect → nameInputRef.current.select()
按 Enter / 失焦
  → GanttChart.tsx:1515 commitName()
    → nameCommittedRef 防重复 (Enter+blur)
    → editNameRef.current 取最新值 (防闭包过期)
    → dispatch(saveSnapshot + updateTasks + markDirty)
按 Escape
  → nameCommittedRef = true → setEditId(null) → blur 不提交

── 单元格编辑 (工期/日期/责任人) ──
双击单元格
  → setCellEdit({ taskId, field, value })
提交
  → GanttChart.tsx:1532 commitCellEdit()
    → duration: 根据依赖类型决定固定 start 还是 end
    → start_date: 仅 FF/SF 允许编辑, 重算 duration
    → end_date: 重算 duration
    → cascadeLocal(updated, tasks, deps)     客户端即时级联
    → dispatch(saveSnapshot + updateTasks(含级联) + markDirty(含级联))
```

---

### 10. 撤销 / 重做

```
Ctrl+Z / 点击撤销
  → GanttToolbar.tsx:833 → dispatch(undo())
  → tasksSlice.ts:142 undo()
    → redoStack.push(当前 tasks + deps)
    → const prev = undoStack.pop()
    → state.tasks = prev.tasks
    → state.dependencies = prev.dependencies

Ctrl+Y / 点击重做
  → GanttToolbar.tsx:834 → dispatch(redo())
  → tasksSlice.ts:149 redo()
    → undoStack.push(当前 tasks + deps)
    → const next = redoStack.pop()
    → state.tasks = next.tasks
    → state.dependencies = next.dependencies

saveSnapshot() 调用点 (每次变更前):
  GanttChart.tsx   — 拖动提交、内联编辑、依赖连线、行排序
  GanttToolbar.tsx — 创建/删除任务、复制粘贴、升降级
  AIChatPanel.tsx  — AI 工具调用
  注意: 纯客户端, 不持久化, 刷新丢失, 最多 50 层
```

---

## 三、架构模式总结

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI 事件                                                            │
│  (拖动/双击/按钮)                                                    │
└──────────┬──────────────────────────────────────────────────────────┘
           ▼
┌──────────────────────┐     ┌──────────────────────────────────────┐
│  客户端级联           │     │  Redux Store                         │
│  cascadeLocal()      │────▶│  saveSnapshot() → 推入 undoStack    │
│  (拖动/编辑即时预览)  │     │  updateTasks()  → 乐观更新          │
│                      │     │  markDirty()    → 标记需保存的 ID    │
└──────────────────────┘     └──────────┬───────────────────────────┘
                                        │ 用户点击保存
                                        ▼
                             ┌──────────────────────────────────────┐
                             │  authFetch PUT /api/tasks            │
                             │  payload = dirtyIds 对应的任务       │
                             │  30s 超时 + 请求去重                 │
                             └──────────┬───────────────────────────┘
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  服务端事务 (BEGIN + advisory lock)                                  │
│                                                                     │
│  1. 批量 SELECT 旧状态          ← 一次查出全部                      │
│  2. 逐条 UPDATE + 校验          ← 里程碑约束、字段校验              │
│  3. cascadeDependencies()       ← 迭代式 SS/SF/FS/FF 级联          │
│  4. updateSummaryTasksDates()   ← 递归更新摘要任务日期              │
│  5. addLifecycleBatch()         ← 一次 INSERT 全部变更记录          │
│  6. COMMIT                                                          │
└──────────┬──────────────────────────────────────────────────────────┘
           ▼
┌──────────────────────┐
│  响应 → Redux        │
│  clearDirty()        │
│  updateTasks(服务端)  │  ← 服务端确认覆盖客户端乐观值
└──────────────────────┘
```

## 四、角色权限矩阵

| 角色 | 查看项目 | 编辑/保存 | AI 对话 | 版本恢复 | 导出 | 快捷键 |
|------|---------|-----------|---------|----------|------|--------|
| admin | 自有项目 | ✓ | ✓ | ✓ | ✓ | ✓ |
| view | 所有项目 | ✗ (按钮隐藏 + API 403) | ✓ | ✗ | ✓ | ✗ (屏蔽) |
