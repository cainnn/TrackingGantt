/**
 * 客户端调度引擎：完全在浏览器中运行的依赖级联 + 摘要任务更新。
 *
 * 镜像 lib/scheduling.ts (server) 的逻辑，但作为纯函数操作 Task[]/Dependency[]。
 * 本项目的核心架构约定：所有编辑只改 Redux，"保存版本"时才入库。
 * 所以编辑期间的 cascade、summary 更新都需要在客户端跑。
 */
import type { Task, Dependency } from '@/types'
import { toDateTimeStr, addMinutesStr, diffMinutesStr } from './clientTime'

// 调度内部使用分钟级时间戳；保留旧函数名以减少改动面，但语义改为分钟。
const toTimeStr = toDateTimeStr
const addMinutes = addMinutesStr
const diffMinutes = diffMinutesStr

function timeBasedPercent(task: Task, statusDate: string | null): number {
  const status = toTimeStr(statusDate)
  const start = toTimeStr(task.start_date)
  const end = toTimeStr(task.end_date)
  if (!status || !start || !end) return task.percent_done ?? 0
  if (status >= end) return 100
  if (status <= start) return 0
  const total = new Date(end).getTime() - new Date(start).getTime()
  if (total <= 0) return 100
  const done = new Date(status).getTime() - new Date(start).getTime()
  return Math.round((done / total) * 100)
}

// ── 自动起点锚定 ────────────────────────────────────────────────────────
/**
 * 无前置依赖 + 自动排程 + asap/none 约束 的任务，起点锚定到指定锚点。
 * - mode='floor'（默认，初始加载）：仅当 cur < anchor 时推后到 anchor。
 *   防止把用户已主动安排到更晚日期的任务回拉。
 * - mode='snap'（手动"重排对齐"按钮）：cur ≠ anchor 都强制设到 anchor，
 *   既能 push 也能 pull，达到一次性整体对齐效果。
 */
export function applyAutoStartAnchor(
  allTasks: Task[],
  deps: Dependency[],
  earliestStart: string | null,
  mode: 'floor' | 'snap' = 'floor',
): Task[] {
  if (!earliestStart) return []
  const anchor = toDateTimeStr(earliestStart)
  if (!anchor) return []

  const hasIncoming = new Set<string>()
  for (const d of deps) {
    if (d.active === false) continue
    hasIncoming.add(d.to_task_id)
  }

  const updates: Task[] = []
  for (const t of allTasks) {
    if (t.is_deleted) continue
    if (t.auto_schedule === false) continue
    if (t.is_milestone) continue
    if (hasIncoming.has(t.id)) continue
    // 仅 asap / 未设置约束的任务被锚定
    const ct = t.constraint_type
    if (ct && ct !== 'asap' && ct !== 'alap' && ct !== 'none') continue
    if (!t.start_date || !t.end_date) continue
    const cur = toDateTimeStr(t.start_date)
    if (!cur) continue
    if (mode === 'floor' ? cur >= anchor : cur === anchor) continue
    const dur = diffMinutes(t.start_date, t.end_date)
    const newStart = anchor
    const newEnd = addMinutes(newStart, dur)
    if (!newEnd) continue
    updates.push({
      ...t,
      start_date: newStart,
      end_date: newEnd,
    })
  }
  return updates
}

// ── 循环依赖检测 ─────────────────────────────────────────────────────────
export function wouldCreateCycle(
  fromId: string,
  toId: string,
  deps: Array<{ from_task_id: string; to_task_id: string }>,
): boolean {
  if (fromId === toId) return true
  const visited = new Set<string>()
  const queue = [toId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur === fromId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const d of deps) if (d.from_task_id === cur) queue.push(d.to_task_id)
  }
  return false
}

// ── 依赖级联 + 摘要任务一体化更新 ────────────────────────────────────────
const MAX_CASCADE_ITERATIONS = 500

export interface UpperConstraintViolation {
  taskId: string
  taskName: string
  constraintType: 'startnolaterthan' | 'finishnolaterthan'
  constraintDate: string
  actualDate: string
}

function latestStartForConstraint(
  constraintType: string | null | undefined,
  constraintDate: string | null,
  duration: number,
): string | null {
  if (!constraintDate) return null
  if (constraintType === 'startnolaterthan') return constraintDate
  if (constraintType === 'finishnolaterthan') return addMinutes(constraintDate, -duration)
  return null
}

export function getUpperConstraintViolation(task: Task): UpperConstraintViolation | null {
  const constraintType = task.constraint_type
  const constraintDate = toTimeStr(task.constraint_date)
  if (!constraintDate || (constraintType !== 'startnolaterthan' && constraintType !== 'finishnolaterthan')) {
    return null
  }

  const actualDate = constraintType === 'startnolaterthan'
    ? toTimeStr(task.start_date)
    : toTimeStr(task.end_date)
  if (!actualDate || actualDate <= constraintDate) return null

  return {
    taskId: task.id,
    taskName: task.name,
    constraintType,
    constraintDate,
    actualDate,
  }
}

export function findUpperConstraintViolations(tasks: Task[]): UpperConstraintViolation[] {
  return tasks
    .map(getUpperConstraintViolation)
    .filter((v): v is UpperConstraintViolation => v !== null)
}

interface TaskState {
  start_date: string | null
  end_date: string | null
  duration: number | null
  auto_schedule: boolean
  parent_id: string | null
  inactive: boolean
  constraint_type: string | null
  constraint_date: string | null
  is_milestone: boolean
  original_start_date: string | null
  original_end_date: string | null
}

export function rollupSummaryTasks(allTasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>()
  const childrenByParent = new Map<string, string[]>()

  for (const task of allTasks) {
    if (task.is_deleted) continue
    taskMap.set(task.id, task)
  }

  for (const task of allTasks) {
    if (task.is_deleted || !task.parent_id || task.parent_id === task.id) continue
    if (!childrenByParent.has(task.parent_id)) childrenByParent.set(task.parent_id, [])
    childrenByParent.get(task.parent_id)!.push(task.id)
  }

  const summaryIds = [...childrenByParent.keys()].filter(id => taskMap.has(id))
  const depthOf = (id: string): number => {
    let depth = 0
    let cur = taskMap.get(id)
    const seen = new Set<string>()
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id)
      depth++
      cur = taskMap.get(cur.parent_id)
    }
    return depth
  }
  summaryIds.sort((a, b) => depthOf(b) - depthOf(a))

  const updates: Task[] = []
  for (const parentId of summaryIds) {
    const parent = taskMap.get(parentId)
    if (!parent) continue
    const childIds = childrenByParent.get(parentId) ?? []
    let minStart: string | null = null
    let maxEnd: string | null = null

    for (const childId of childIds) {
      const child = taskMap.get(childId)
      const start = toTimeStr(child?.start_date)
      const end = toTimeStr(child?.end_date)
      if (start && (!minStart || start < minStart)) minStart = start
      if (end && (!maxEnd || end > maxEnd)) maxEnd = end
    }

    if (!minStart || !maxEnd) continue
    const duration = diffMinutes(minStart, maxEnd)
    const changed =
      toTimeStr(parent.start_date) !== minStart ||
      toTimeStr(parent.end_date) !== maxEnd ||
      parent.duration !== duration
    if (!changed) continue

    const next = {
      ...parent,
      start_date: minStart,
      end_date: maxEnd,
      duration,
    }
    taskMap.set(parentId, next)
    updates.push(next)
  }

  return updates
}

/**
 * 全量级联：给定当前 tasks + deps，计算所有需要更新的任务的最终日期。
 * 包括：
 *   - 依赖级联（FS/SS/FF/SF + lag + 硬约束）
 *   - 摘要任务日期（与子任务范围一致）
 *
 * 返回更新后的 Task[]（仅包含发生变化的任务，未变化的不返回）。
 */
export function runFullCascade(
  allTasks: Task[],
  deps: Dependency[],
): Task[] {
  if (allTasks.length === 0) return []

  // ── 构建 task state map ───────────────────────────────────────────────
  const taskMap = new Map<string, TaskState>()
  for (const t of allTasks) {
    if (t.is_deleted) continue
    taskMap.set(t.id, {
      start_date: toTimeStr(t.start_date),
      end_date: toTimeStr(t.end_date),
      duration: t.duration ?? null,
      auto_schedule: t.auto_schedule !== false,
      parent_id: t.parent_id ?? null,
      inactive: !!t.inactive,
      constraint_type: t.constraint_type ?? null,
      constraint_date: toTimeStr(t.constraint_date),
      is_milestone: !!t.is_milestone,
      original_start_date: toTimeStr(t.original_start_date),
      original_end_date: toTimeStr(t.original_end_date),
    })
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

  // ancestorId 是否为 taskId 的祖先
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

  // ── 按后继任务分组依赖 ────────────────────────────────────────────────
  const depsByTo = new Map<string, Dependency[]>()
  const constrainedIds = new Set<string>()
  for (const [id, st] of taskMap) {
    const ct = st.constraint_type
    if (ct && ct !== 'asap' && ct !== 'alap' && ct !== 'none' && st.constraint_date) {
      constrainedIds.add(id)
    }
  }
  for (const dep of deps) {
    if (!taskMap.has(dep.from_task_id) || !taskMap.has(dep.to_task_id)) continue
    if (isAncestor(dep.from_task_id, dep.to_task_id)) continue
    if (isAncestor(dep.to_task_id, dep.from_task_id)) continue
    if (dep.active === false) continue
    if (isInactive(dep.from_task_id) || isInactive(dep.to_task_id)) continue
    if (!depsByTo.has(dep.to_task_id)) depsByTo.set(dep.to_task_id, [])
    depsByTo.get(dep.to_task_id)!.push(dep)
  }
  for (const id of constrainedIds) if (!depsByTo.has(id)) depsByTo.set(id, [])

  // ── 迭代级联 ──────────────────────────────────────────────────────────
  let changed = true
  let iter = 0
  while (changed && iter++ < MAX_CASCADE_ITERATIONS) {
    changed = false
    for (const [toId, toDepList] of depsByTo) {
      const to = taskMap.get(toId)
      if (!to?.start_date || !to?.end_date) continue
      if (to.auto_schedule === false) continue

      const dur = Math.max(0, diffMinutes(to.start_date, to.end_date))

      let maxRequired: string | null = null
      for (const dep of toDepList) {
        const from = taskMap.get(dep.from_task_id)
        if (!from?.start_date || !from?.end_date) continue
        const lag = dep.lag ?? 0
        const depType = dep.type ?? 2
        let rs: string | null = null
        if (depType === 2) rs = addMinutes(from.end_date, lag)
        else if (depType === 0) rs = addMinutes(from.start_date, lag)
        else if (depType === 3) rs = addMinutes(from.end_date, lag - dur)
        else if (depType === 1) rs = addMinutes(from.start_date, lag - dur)
        if (rs && (!maxRequired || rs > maxRequired)) maxRequired = rs
      }

      let newStart: string | null = maxRequired
      const ct = to.constraint_type
      const cd = to.constraint_date
      if (ct && cd && ct !== 'asap' && ct !== 'alap' && ct !== 'none') {
        if (ct === 'muststarton') newStart = cd
        else if (ct === 'mustfinishon') newStart = addMinutes(cd, -dur)
        else if (ct === 'startnoearlierthan') newStart = (maxRequired && maxRequired > cd) ? maxRequired : cd
        else if (ct === 'finishnoearlierthan') {
          const s = addMinutes(cd, -dur)
          newStart = (maxRequired && s && maxRequired > s) ? maxRequired : s
        }
        const latestStart = latestStartForConstraint(ct, cd, dur)
        if (latestStart) {
          if (maxRequired && maxRequired > latestStart) {
            newStart = maxRequired
          } else if (newStart && newStart > latestStart) {
            newStart = latestStart
          } else if (!newStart && to.start_date > latestStart) {
            newStart = latestStart
          }
        }
      }
      if (!newStart) continue
      if (to.start_date === newStart) continue
      const newEnd = addMinutes(newStart, dur)
      if (!newEnd) continue

      taskMap.set(toId, { ...to, start_date: newStart, end_date: newEnd, duration: dur })
      changed = true
    }
  }

  // ── 摘要任务日期更新（先收集所有有子任务的父级，递归向上） ────────────
  const childrenByParent = new Map<string, string[]>()
  for (const [id, st] of taskMap) {
    if (st.parent_id) {
      if (!childrenByParent.has(st.parent_id)) childrenByParent.set(st.parent_id, [])
      childrenByParent.get(st.parent_id)!.push(id)
    }
  }

  // 自底向上更新摘要：先收集所有摘要任务，按层级深度反向排序（叶子优先）
  const summaryIds = [...childrenByParent.keys()].filter(id => taskMap.has(id))
  // 计算每个摘要任务的"深度"：从根往下数
  const depthOf = (id: string): number => {
    let d = 0; let cur = taskMap.get(id)
    const visited = new Set<string>()
    while (cur?.parent_id && !visited.has(cur.parent_id)) {
      visited.add(cur.parent_id)
      d++
      cur = taskMap.get(cur.parent_id)
    }
    return d
  }
  summaryIds.sort((a, b) => depthOf(b) - depthOf(a)) // 深的先（叶子摘要）

  for (const pid of summaryIds) {
    const parent = taskMap.get(pid)
    if (!parent) continue
    const childIds = childrenByParent.get(pid) ?? []
    if (childIds.length === 0) {
      // 没有子任务但保存了 original_*：恢复
      if (parent.original_start_date && parent.original_end_date) {
        const dur = diffMinutes(parent.original_start_date, parent.original_end_date)
        taskMap.set(pid, {
          ...parent,
          start_date: parent.original_start_date,
          end_date: parent.original_end_date,
          duration: dur,
          original_start_date: null,
          original_end_date: null,
        })
      }
      continue
    }
    let minS: string | null = null
    let maxE: string | null = null
    for (const cid of childIds) {
      const c = taskMap.get(cid)
      if (c?.start_date && (!minS || c.start_date < minS)) minS = c.start_date
      if (c?.end_date && (!maxE || c.end_date > maxE)) maxE = c.end_date
    }
    if (!minS || !maxE) continue
    if (parent.start_date === minS && parent.end_date === maxE) continue
    const newDur = diffMinutes(minS, maxE)
    // 首次成为摘要：保存原始日期
    const shouldSaveOrig = !parent.original_start_date && !parent.original_end_date
    taskMap.set(pid, {
      ...parent,
      start_date: minS,
      end_date: maxE,
      duration: newDur,
      original_start_date: shouldSaveOrig ? parent.start_date : parent.original_start_date,
      original_end_date: shouldSaveOrig ? parent.end_date : parent.original_end_date,
    })
  }

  // ── 收集变更：与原始 task 相比，状态有变化的才返回 ────────────────────
  const changedTasks: Task[] = []
  for (const t of allTasks) {
    if (t.is_deleted) continue
    const st = taskMap.get(t.id)
    if (!st) continue
    const oldStart = toTimeStr(t.start_date)
    const oldEnd = toTimeStr(t.end_date)
    const oldDur = t.duration ?? null
    const oldOrigStart = toTimeStr(t.original_start_date)
    const oldOrigEnd = toTimeStr(t.original_end_date)
    if (
      st.start_date === oldStart &&
      st.end_date === oldEnd &&
      st.duration === oldDur &&
      st.original_start_date === oldOrigStart &&
      st.original_end_date === oldOrigEnd
    ) continue
    changedTasks.push({
      ...t,
      start_date: st.start_date,
      end_date: st.end_date,
      duration: st.duration ?? t.duration,
      original_start_date: st.original_start_date,
      original_end_date: st.original_end_date,
    })
  }
  return changedTasks
}

/**
 * 删除任务后坍缩后继链：
 * - 只处理原来依赖被删任务的直接后继任务；
 * - 直接后继若开始时间在状态日期之后，则拉回状态日期并保持原工期；
 * - 状态日期之前/当天已开始的任务不动；
 * - 再基于剩余依赖做全量级联，让更下游任务跟随前移。
 */
export function collapseDeletedTaskSuccessors(
  allTasks: Task[],
  depsBeforeDelete: Dependency[],
  remainingDeps: Dependency[],
  deletedIds: Iterable<string>,
  statusDate?: string | null,
): Task[] {
  const statusStart = toTimeStr(statusDate)
  if (!statusStart) return runFullCascade(allTasks, remainingDeps)

  const deletedSet = new Set(deletedIds)
  const taskById = new Map(allTasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const directSuccessorIds = new Set<string>()

  for (const dep of depsBeforeDelete) {
    if (dep.active === false) continue
    if (deletedSet.has(dep.from_task_id) && !deletedSet.has(dep.to_task_id)) {
      directSuccessorIds.add(dep.to_task_id)
    }
  }

  const anchored = new Map<string, Task>()
  for (const id of directSuccessorIds) {
    const task = taskById.get(id)
    if (!task || task.auto_schedule === false || !task.start_date || !task.end_date) continue
    const start = toTimeStr(task.start_date)
    const end = toTimeStr(task.end_date)
    if (!start || !end || start <= statusStart) continue

    const duration = Math.max(0, diffMinutes(start, end))
    const nextEnd = task.is_milestone ? statusStart : addMinutes(statusStart, duration)
    if (!nextEnd) continue

    const collapsed: Task = {
      ...task,
      start_date: statusStart,
      end_date: nextEnd,
      duration,
    }
    anchored.set(id, {
      ...collapsed,
      percent_done: timeBasedPercent(collapsed, statusStart),
    })
  }

  const baseTasks = anchored.size > 0
    ? allTasks.map(t => anchored.get(t.id) ?? t)
    : allTasks
  const merged = new Map<string, Task>(anchored)

  for (const task of runFullCascade(baseTasks, remainingDeps)) {
    merged.set(task.id, {
      ...task,
      percent_done: timeBasedPercent(task, statusStart),
    })
  }

  return [...merged.values()]
}
