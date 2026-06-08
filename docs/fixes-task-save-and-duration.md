# 新增任务保存失败与工期异常修复记录

日期：2026-06-05

## 背景

本次处理了两个用户侧问题：

1. 在“CDN利旧设备搬迁”项目中新增任务，保存时弹窗提示：`保存失败：新增任务失败 (500)`。
2. 在“CDN七期集成项目”中，“4A入网申请”任务开始/结束日期跨度明显不为 0，但页面工期显示为 `0天`。

## 问题一：新增任务保存失败

### 现象

用户在“CDN利旧设备搬迁”项目中新增任务并保存版本时，前端弹窗显示：

```text
保存失败：新增任务失败 (500)
```

### 排查过程

查看 VPS 上的 PM2 日志后，服务端真实错误为：

```text
POST /api/tasks error: duplicate key value violates unique constraint "idx_tasks_task_code"
```

数据库索引定义为：

```sql
CREATE UNIQUE INDEX idx_tasks_task_code
ON public.tasks (project_id, task_code)
WHERE task_code IS NOT NULL;
```

这表示同一个项目内 `task_code` 必须唯一。

### 根因

前端新增任务时会在本地生成 `task_code`。在某些情况下，新增任务提交保存时可能出现：

- 新增任务的 `task_code` 与数据库已有任务冲突；
- 同一次保存中多个新增任务带了相同 `task_code`；
- 服务端 `POST /api/tasks/[projectId]` 信任客户端传入的 `task_code`，没有做冲突兜底。

因此插入数据库时触发唯一索引冲突，接口返回 500。

### 修复内容

修复点一：客户端保存前重新整理新增任务编码。

文件：

- `lib/clientSave.ts`

处理方式：

- 基于 baseline 已有任务收集已使用的 `task_code`；
- 对本批新增任务重新分配唯一编码；
- 避免新增任务与已有任务或同批新增任务重复。

修复点二：服务端新增接口增加兜底。

文件：

- `app/api/tasks/[projectId]/route.ts`

处理方式：

- 如果客户端传入的 `task_code` 已在当前项目内存在，则忽略该编码；
- 在事务锁内调用 `nextTaskCode()` 自动分配下一个可用编号；
- 避免因编码冲突返回 500。

### 验证

新增测试：

- `tests/clientSave.test.ts`

覆盖场景：

- 新增任务编码与已有任务冲突；
- 同批新增任务编码互相冲突；
- 保存 diff 会自动重排为唯一编码。

验证命令：

```bash
npm run check
npm run build
```

结果：

- `npm run check` 通过；
- `npm run build` 通过；
- 修复已部署到 VPS；
- `http://159.75.40.209:3000/login` 返回 `200 OK`。

## 问题二：任务工期显示为 0 天

### 现象

用户反馈“CDN七期集成项目”里“4A入网申请”任务工期显示为 `0天`。

排查数据库后发现：

```text
task_code: 14
name: 4A入网申请
start_date: 2026-04-21 00:00:00
end_date:   2026-05-26 00:00:00
duration:   0
```

说明任务日期跨度为 35 天，但 `duration` 字段保存为 0。

补充说明：

- 当前活动任务中，“4A入网申请”实际是 `task_code=14`；
- `task_code=13` 是已软删除任务“应用系统部署”。

### 根因

系统内部统一用分钟存储工期：

```text
1 天 = 1440 分钟
```

天级项目里，`duration` 应该与 `end_date - start_date` 保持一致。但历史数据中存在：

- 非里程碑任务；
- `start_date` 与 `end_date` 不相等；
- `duration = 0`。

原有 `snapTasksToDayLevel()` 只修复：

- start/end 带非 00:00 时间；
- duration 不是 1440 的整数倍。

它没有修复“duration 是 1440 的整数倍但和日期跨度不一致”的情况，因此 `duration=0` 没被自动修正。

### 修复内容

修复点一：新增天级工期计算函数。

文件：

- `lib/scheduling.ts`

新增逻辑：

```text
dayLevelDurationFromDates(start, end, isMilestone)
```

规则：

- 里程碑任务工期固定为 0；
- 普通任务工期按 `end_date - start_date` 计算；
- 结果按天级项目换算为分钟。

修复点二：增强 `snapTasksToDayLevel()`。

文件：

- `lib/scheduling.ts`

处理方式：

- 检查天级项目中普通任务的 `duration` 是否等于日期跨度；
- 如果不一致，以 `start_date` / `end_date` 为准重算 `duration`；
- 例如 `2026-04-21` 到 `2026-05-26` 修正为 `35 * 1440 = 50400`。

修复点三：增强任务 GET 接口的自动修复触发条件。

文件：

- `app/api/tasks/[projectId]/route.ts`

处理方式：

- 读取任务时，如果发现天级项目中 `duration` 与日期跨度不一致，也触发自动修复流程；
- 避免历史脏数据继续直接展示给前端。

### 数据修复结果

已通过本地任务 API 触发修复。

修复后数据库确认：

```text
task_code: 14
name: 4A入网申请
start_date: 2026-04-21 00:00:00
end_date:   2026-05-26 00:00:00
duration:   50400
duration_days: 35.00
```

### 验证

新增测试：

- `tests/scheduling.test.ts`

覆盖场景：

- `2026-04-21` 到 `2026-05-26` 应计算为 `35 * 1440` 分钟；
- 里程碑任务仍保持 `duration=0`。

验证命令：

```bash
npm run check
npm run build
```

结果：

- `npm run check` 通过；
- `npm run build` 通过；
- 本地刷新项目后，“4A入网申请”工期应显示为 `35天`。

## 涉及文件

代码文件：

- `app/api/tasks/[projectId]/route.ts`
- `lib/clientSave.ts`
- `lib/scheduling.ts`

测试文件：

- `tests/clientSave.test.ts`
- `tests/scheduling.test.ts`

## 后续建议

已增加维护脚本：

```bash
DB_PASSWORD=11111a npm run db:health
```

脚本文件：

- `scripts/data-health-check.js`

该脚本只读扫描数据库，不会自动修复数据；发现异常时会返回非零退出码，便于接入 cron 或 CI。

当前扫描项：

- 普通任务 `duration=0` 但 `start_date <> end_date`；
- 天级项目 `duration` 不是 `end_date - start_date`；
- 同项目内重复 `task_code`；
- 软删除任务与活动任务编码混用导致的前端展示歧义。
