/**
 * 共享调度引擎：日期工具、依赖级联、摘要任务更新、循环检测
 *
 * 所有后端 route 共用此模块，避免逻辑分叉。
 */
import type { PoolClient } from 'pg'

// ── 类型 ──────────────────────────────────────────────────────────────────
export type TaskLike = { id: string; [key: string]: unknown }

export type DepRow = {
  dep_id: string
  from_task_id: string
  to_task_id: string
  type: number
  lag: number
}

// ── 日期工具函数（分钟级；保留原函数名以减少改动面） ──────────────────────
// 由 lib/clientTime.ts 提供的原语统一处理 'YYYY-MM-DDTHH:mm:00' 本地时间字符串。
import { toDateTimeStr, addMinutesStr, diffMinutesStr, parseLocal } from './clientTime'

/** 归一化为 ISO datetime 'YYYY-MM-DDTHH:mm:00' */
export function toDateStr(v: string | Date | null | undefined): string | null {
  return toDateTimeStr(v)
}

/** 解析为本地 Date 对象 */
export function parseDateLocal(s: string | null): Date | null {
  return parseLocal(s)
}

/** 加减分钟（callers 仍按"分钟数"传参；duration / lag 现在均为分钟） */
export function addDaysStr(dateStr: string | null, minutes: number): string | null {
  return addMinutesStr(dateStr, minutes)
}

/** 两个 datetime 字符串之间的分钟差 */
export function diffDaysStr(a: string, b: string): number {
  return diffMinutesStr(a, b)
}

export function dayLevelDurationFromDates(
  startDate: string | Date | null | undefined,
  endDate: string | Date | null | undefined,
  isMilestone: boolean = false,
): number | null {
  if (isMilestone) return 0
  const start = toDateStr(startDate)
  const end = toDateStr(endDate)
  if (!start || !end) return null
  return Math.max(0, Math.round(diffMinutesStr(start, end) / 1440) * 1440)
}

// ── 循环依赖检测 ─────────────────────────────────────────────────────────
/**
 * 检测新增依赖 fromId → toId 是否会产生环路。
 * 原理：如果从 toId 沿现有依赖的正向能到达 fromId，说明新增边会形成环。
 */
export function wouldCreateCycle(
  fromId: string,
  toId: string,
  existingDeps: Array<{ from_task_id: string; to_task_id: string }>,
): boolean {
  // 自依赖
  if (fromId === toId) return true
  // BFS: 从 toId 沿正向走，看能否到达 fromId
  const visited = new Set<string>()
  const queue = [toId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur === fromId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const d of existingDeps) {
      if (d.from_task_id === cur) queue.push(d.to_task_id)
    }
  }
  return false
}

// ── 依赖自动级联 ─────────────────────────────────────────────────────────
// 支持 SS(0)/SF(1)/FS(2)/FF(3)，迭代式处理直到所有后继任务满足约束
const MAX_CASCADE_ITERATIONS = 500 // 安全阀，防止异常数据导致无限循环

function latestStartForConstraint(
  constraintType: string | null | undefined,
  constraintDate: string | null,
  duration: number,
): string | null {
  if (!constraintDate) return null
  if (constraintType === 'startnolaterthan') return constraintDate
  if (constraintType === 'finishnolaterthan') return addDaysStr(constraintDate, -duration)
  return null
}

export async function cascadeDependencies(
  client: PoolClient,
  projectId: string,
): Promise<string[]> {
  const cascadedIds: string[] = []

  const projectRes = await client.query(
    'SELECT time_granularity FROM projects WHERE id = $1',
    [projectId],
  )
  const isMinuteProject = projectRes.rows[0]?.time_granularity === 'minute'
  const toScheduleLag = (lag: number | null | undefined): number =>
    isMinuteProject ? (lag ?? 0) : (lag ?? 0) * 1440

  const depsRes = await client.query(
    `SELECT d.id as dep_id, d.from_task_id, d.to_task_id, d.type, d.lag, COALESCE(d.active, true) AS active FROM dependencies d
     JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
     JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
     WHERE d.project_id = $1`,
    [projectId],
  )

  const tasksRes = await client.query(
    `SELECT id, parent_id, start_date, end_date, duration,
            COALESCE(auto_schedule, true) AS auto_schedule,
            COALESCE(inactive, false) AS inactive,
            constraint_type, constraint_date
     FROM tasks WHERE project_id = $1 AND is_deleted = false`,
    [projectId],
  )
  const taskMap = new Map<string, { start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean; parent_id: string | null; inactive: boolean; constraint_type: string | null; constraint_date: string | null }>()
  const constrainedIds = new Set<string>()
  for (const r of tasksRes.rows) {
    const ctype = (r.constraint_type as string | null) ?? null
    const cdate = toDateStr(r.constraint_date as string | null)
    taskMap.set(r.id, {
      start_date: toDateStr(r.start_date),
      end_date: toDateStr(r.end_date),
      duration: r.duration,
      auto_schedule: r.auto_schedule !== false,
      parent_id: r.parent_id,
      inactive: r.inactive === true,
      constraint_type: ctype,
      constraint_date: cdate,
    })
    if (ctype && ctype !== 'asap' && ctype !== 'alap' && ctype !== 'none' && cdate) {
      constrainedIds.add(r.id)
    }
  }

  // 任务是否为"无效"：自身或任一祖先为 inactive
  const isInactive = (id: string): boolean => {
    let cur = taskMap.get(id)
    const visited = new Set<string>()
    while (cur) {
      if (cur.inactive) return true
      if (!cur.parent_id || visited.has(cur.parent_id)) break
      visited.add(cur.parent_id)
      cur = taskMap.get(cur.parent_id)
    }
    return false
  }

  // 判断 ancestorId 是否是 taskId 的祖先（父→祖父→…）
  const isAncestor = (ancestorId: string, taskId: string): boolean => {
    let cur = taskMap.get(taskId)
    const visited = new Set<string>()
    while (cur?.parent_id) {
      if (cur.parent_id === ancestorId) return true
      if (visited.has(cur.parent_id)) break
      visited.add(cur.parent_id)
      cur = taskMap.get(cur.parent_id)
    }
    return false
  }

  // 按后继任务分组依赖，方便聚合多前置任务的约束
  // 跳过父子关系的依赖（摘要任务日期由子任务决定，不应反向约束子任务）
  const depsByTo = new Map<string, DepRow[]>()
  for (const dep of depsRes.rows as (DepRow & { active?: boolean })[]) {
    if (isAncestor(dep.from_task_id, dep.to_task_id)) continue
    if (isAncestor(dep.to_task_id, dep.from_task_id)) continue
    // 跳过 inactive 依赖以及任一端为无效任务的依赖
    if (dep.active === false) continue
    if (isInactive(dep.from_task_id) || isInactive(dep.to_task_id)) continue
    if (!depsByTo.has(dep.to_task_id)) depsByTo.set(dep.to_task_id, [])
    depsByTo.get(dep.to_task_id)!.push(dep)
  }

  // 有硬约束但无前置依赖的任务也需要参与调度（保证 muststarton 等生效）
  for (const id of constrainedIds) {
    if (!depsByTo.has(id)) depsByTo.set(id, [])
  }

  let changed = true
  let iterations = 0
  while (changed && iterations++ < MAX_CASCADE_ITERATIONS) {
    changed = false
    for (const [toId, toDepList] of depsByTo) {
      const to = taskMap.get(toId)
      if (!to?.start_date || !to?.end_date) continue
      // 手动排程的任务不参与依赖级联
      if (to.auto_schedule === false) continue

      const toStart = to.start_date
      const toEnd = to.end_date
      const dur = Math.max(0, diffDaysStr(toStart, toEnd))

      // 聚合所有前置任务的约束，取最严格（最晚）的 requiredStart
      let maxRequired: string | null = null
      for (const dep of toDepList) {
        const from = taskMap.get(dep.from_task_id)
        if (!from?.start_date || !from?.end_date) continue

        const lag = toScheduleLag(dep.lag)
        const depType = dep.type ?? 2
        let rs: string | null = null
        if (depType === 2) {
          rs = addDaysStr(from.end_date, lag)             // FS
        } else if (depType === 0) {
          rs = addDaysStr(from.start_date, lag)            // SS
        } else if (depType === 3) {
          rs = addDaysStr(from.end_date, lag - dur)        // FF
        } else if (depType === 1) {
          rs = addDaysStr(from.start_date, lag - dur)      // SF
        }
        if (rs && (!maxRequired || rs > maxRequired)) maxRequired = rs
      }

      // 应用硬约束：muststarton / mustfinishon / (start|finish)no(earlier|later)than
      let newStart: string | null = maxRequired
      const ctype = to.constraint_type
      const cdate = to.constraint_date
      if (ctype && cdate && ctype !== 'asap' && ctype !== 'alap' && ctype !== 'none') {
        if (ctype === 'muststarton') {
          newStart = cdate
        } else if (ctype === 'mustfinishon') {
          newStart = addDaysStr(cdate, -dur)
        } else if (ctype === 'startnoearlierthan') {
          newStart = (maxRequired && maxRequired > cdate) ? maxRequired : cdate
        } else if (ctype === 'finishnoearlierthan') {
          const s = addDaysStr(cdate, -dur)
          newStart = (maxRequired && s && maxRequired > s) ? maxRequired : s
        }
        const latestStart = latestStartForConstraint(ctype, cdate, dur)
        if (latestStart) {
          if (maxRequired && maxRequired > latestStart) {
            // 依赖与上界约束冲突时，依赖链保持一致；由 UI/审计提示冲突。
            newStart = maxRequired
          } else if (newStart && newStart > latestStart) {
            newStart = latestStart
          } else if (!newStart && toStart > latestStart) {
            newStart = latestStart
          }
        }
      }

      if (!newStart) continue
      if (toStart === newStart) continue

      const newEnd = addDaysStr(newStart, dur)
      if (!newEnd) continue

      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
         WHERE id = $4 AND project_id = $5`,
        [newStart, newEnd, dur, toId, projectId],
      )
      if (!cascadedIds.includes(toId)) cascadedIds.push(toId)
      taskMap.set(toId, {
        start_date: newStart,
        end_date: newEnd,
        duration: dur,
        auto_schedule: to.auto_schedule,
        parent_id: to.parent_id,
        inactive: to.inactive,
        constraint_type: to.constraint_type,
        constraint_date: to.constraint_date,
      })
      changed = true
    }
  }
  return cascadedIds
}

export async function collapseDeletedTaskSuccessors(
  client: PoolClient,
  projectId: string,
  deletedIds: string[],
): Promise<string[]> {
  if (deletedIds.length === 0) return []

  const projectRes = await client.query(
    `SELECT status_date FROM projects WHERE id = $1`,
    [projectId],
  )
  const statusDate = toDateStr(projectRes.rows[0]?.status_date ?? null)
  if (!statusDate) return cascadeDependencies(client, projectId)

  const ph = deletedIds.map((_, i) => `$${i + 2}`).join(',')
  const succRes = await client.query(
    `SELECT DISTINCT t.id, t.start_date, t.end_date, t.duration,
            COALESCE(t.auto_schedule, true) AS auto_schedule,
            COALESCE(t.is_milestone, false) AS is_milestone
       FROM dependencies d
       JOIN tasks t ON t.id = d.to_task_id
      WHERE d.project_id = $1
        AND d.from_task_id IN (${ph})
        AND t.project_id = $1
        AND t.is_deleted = false
        AND t.id NOT IN (${ph})
        AND COALESCE(d.active, true) = true`,
    [projectId, ...deletedIds],
  )

  const changedIds: string[] = []
  for (const row of succRes.rows as Array<{ id: string; start_date: string | null; end_date: string | null; duration: number | null; auto_schedule: boolean; is_milestone: boolean }>) {
    if (row.auto_schedule === false) continue
    const start = toDateStr(row.start_date)
    const end = toDateStr(row.end_date)
    if (!start || !end || start <= statusDate) continue

    const duration = Math.max(0, diffDaysStr(start, end))
    const newEnd = row.is_milestone ? statusDate : addDaysStr(statusDate, duration)
    if (!newEnd) continue

    await client.query(
      `UPDATE tasks
          SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
        WHERE id = $4 AND project_id = $5`,
      [statusDate, newEnd, duration, row.id, projectId],
    )
    changedIds.push(row.id)
  }

  const cascadedIds = await cascadeDependencies(client, projectId)
  const allChangedIds = [...new Set([...changedIds, ...cascadedIds])]
  if (allChangedIds.length > 0) {
    const changedPh = allChangedIds.map((_, i) => `$${i + 3}`).join(',')
    await client.query(
      `UPDATE tasks
          SET percent_done = CASE
                WHEN start_date IS NULL OR end_date IS NULL THEN percent_done
                WHEN $2::timestamp >= end_date THEN 100
                WHEN $2::timestamp <= start_date THEN 0
                WHEN EXTRACT(EPOCH FROM (end_date - start_date)) <= 0 THEN 100
                ELSE ROUND(
                  EXTRACT(EPOCH FROM ($2::timestamp - start_date))
                  / EXTRACT(EPOCH FROM (end_date - start_date))
                  * 100
                )::int
              END,
              updated_at = NOW()
        WHERE project_id = $1 AND id IN (${changedPh})`,
      [projectId, statusDate, ...allChangedIds],
    )
  }
  return allChangedIds
}

// ── 摘要任务日期更新 ──────────────────────────────────────────────────────
/** 更新项目中所有摘要任务的日期范围（与子任务范围一致） */
export async function updateSummaryTasksDates(
  client: PoolClient,
  projectId: string,
): Promise<TaskLike[]> {
  const collected: TaskLike[] = []

  const parentsRes = await client.query(
    `SELECT DISTINCT parent_id
     FROM tasks
     WHERE project_id = $1 AND parent_id IS NOT NULL AND is_deleted = false`,
    [projectId],
  )

  if (parentsRes.rows.length === 0) return collected

  const parentIds = parentsRes.rows.map((r: { parent_id: string }) => r.parent_id)

  for (const parentId of parentIds) {
    await updateSummaryTaskDateRecursive(client, parentId, collected)
  }

  // 去重
  const seen = new Set<string>()
  return collected.filter(u => {
    if (seen.has(u.id)) return false
    seen.add(u.id)
    return true
  })
}

/** 递归更新摘要任务及其所有父级摘要任务的时间 */
export async function updateSummaryTaskDateRecursive(
  client: PoolClient,
  taskId: string,
  collected: TaskLike[] = [],
  _visited?: Set<string>,
): Promise<TaskLike | null> {
  const visited = _visited ?? new Set<string>()
  if (visited.has(taskId)) return null // 防止循环引用导致无限递归
  visited.add(taskId)
  const childrenRes = await client.query(
    `SELECT id, start_date, end_date
     FROM tasks
     WHERE parent_id = $1 AND is_deleted = false
     ORDER BY start_date ASC`,
    [taskId],
  )

  const currentRes = await client.query(
    'SELECT id, name, start_date, end_date, duration, parent_id, original_start_date, original_end_date FROM tasks WHERE id = $1',
    [taskId],
  )

  const current = currentRes.rows[0]
  if (!current) return null

  if (childrenRes.rows.length === 0) {
    // 没有子任务了，如果保存了原始日期，则恢复
    if (current.original_start_date && current.original_end_date) {
      const origStart = toDateStr(current.original_start_date)!
      const origEnd = toDateStr(current.original_end_date)!
      const newDuration = diffDaysStr(origStart, origEnd)

      await client.query(
        `UPDATE tasks
         SET start_date = $1, end_date = $2, duration = $3,
             original_start_date = NULL, original_end_date = NULL, updated_at = NOW()
         WHERE id = $4`,
        [origStart, origEnd, newDuration, taskId],
      )

      const updated: TaskLike = {
        id: current.id,
        name: current.name,
        start_date: origStart,
        end_date: origEnd,
        duration: newDuration,
      }
      collected.push(updated)

      if (current.parent_id) {
        await updateSummaryTaskDateRecursive(client, current.parent_id as string, collected, visited)
      }

      return updated
    }
    return null
  }

  // 排除自引用的子任务
  const validChildren = childrenRes.rows.filter((c: { id: string }) => c.id !== taskId)
  if (validChildren.length === 0 && childrenRes.rows.length > 0) return null

  // 计算时间范围：只基于子任务的日期
  let minStart: string | null = null
  let maxEnd: string | null = null

  for (const child of validChildren) {
    const start = toDateStr(child.start_date)
    const end = toDateStr(child.end_date)

    if (start && (!minStart || start < minStart)) minStart = start
    if (end && (!maxEnd || end > maxEnd)) maxEnd = end
  }

  if (!minStart || !maxEnd) return null

  // 检查是否需要更新
  if (toDateStr(current.start_date) === minStart && toDateStr(current.end_date) === maxEnd) {
    if (current.parent_id) {
      await updateSummaryTaskDateRecursive(client, current.parent_id as string, collected, visited)
    }
    return null
  }

  // 首次成为摘要任务时，保存原始日期
  const shouldSaveOriginal = !current.original_start_date && !current.original_end_date
  const newDuration = diffDaysStr(minStart, maxEnd)

  if (shouldSaveOriginal) {
    await client.query(
      `UPDATE tasks
       SET start_date = $1, end_date = $2, duration = $3,
           original_start_date = $4, original_end_date = $5, updated_at = NOW()
       WHERE id = $6`,
      [minStart, maxEnd, newDuration, toDateStr(current.start_date), toDateStr(current.end_date), taskId],
    )
  } else {
    await client.query(
      `UPDATE tasks
       SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
       WHERE id = $4`,
      [minStart, maxEnd, newDuration, taskId],
    )
  }

  const updated: TaskLike = {
    id: current.id,
    name: current.name,
    start_date: minStart,
    end_date: maxEnd,
    duration: newDuration,
  }
  collected.push(updated)

  if (current.parent_id) {
    await updateSummaryTaskDateRecursive(client, current.parent_id as string, collected, visited)
  }

  return updated
}

// ── 天级项目对齐 ──────────────────────────────────────────────────────────
/**
 * 天级项目（time_granularity != 'minute'）里所有任务的 start_date / end_date
 * 必须落在 00:00；duration 必须是 1440 分钟的整数倍。
 *
 * 触发场景：导入残留分钟、级联从带时分的源任务推算 start、历史数据迁移遗留。
 * 该函数会找出所有不合规的任务并就地 snap：
 *   - start_date → 同一天 00:00（floor）
 *   - duration   → 四舍五入到整天
 *   - end_date   → start_date + duration（按上面已圆整的 duration）
 *
 * 返回被修正的任务 id 列表。
 */
export async function snapTasksToDayLevel(
  client: PoolClient,
  projectId: string,
): Promise<string[]> {
  const granRes = await client.query(
    'SELECT time_granularity FROM projects WHERE id = $1',
    [projectId],
  )
  if (granRes.rows[0]?.time_granularity === 'minute') return []

  const res = await client.query(
    `SELECT id, start_date, end_date, duration, COALESCE(is_milestone, false) AS is_milestone FROM tasks
     WHERE project_id = $1 AND is_deleted = false
       AND start_date IS NOT NULL AND end_date IS NOT NULL
       AND (
         EXTRACT(HOUR   FROM start_date) <> 0
         OR EXTRACT(MINUTE FROM start_date) <> 0
         OR EXTRACT(SECOND FROM start_date) <> 0
         OR EXTRACT(HOUR   FROM end_date) <> 0
         OR EXTRACT(MINUTE FROM end_date) <> 0
         OR EXTRACT(SECOND FROM end_date) <> 0
         OR (duration IS NOT NULL AND duration % 1440 <> 0)
         OR (
           COALESCE(is_milestone, false) = false
           AND duration IS DISTINCT FROM GREATEST(0, ROUND(EXTRACT(EPOCH FROM (end_date - start_date)) / 86400.0)::int * 1440)
         )
       )`,
    [projectId],
  )
  const touched: string[] = []
  for (const r of res.rows) {
    const sStr = toDateStr(r.start_date as string | Date | null)
    const eStr = toDateStr(r.end_date as string | Date | null)
    if (!sStr || !eStr) continue
    const s = parseLocal(sStr)
    if (!s) continue
    const newDur = dayLevelDurationFromDates(sStr, eStr, r.is_milestone === true)
    if (newDur == null) continue
    s.setHours(0, 0, 0, 0)
    const newStartStr = toDateStr(s)
    const newEndStr = addMinutesStr(newStartStr, newDur)
    if (!newStartStr || !newEndStr) continue
    await client.query(
      `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
       WHERE id = $4 AND project_id = $5`,
      [newStartStr, newEndStr, newDur, r.id, projectId],
    )
    touched.push(r.id as string)
  }
  return touched
}
