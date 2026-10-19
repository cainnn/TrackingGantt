/**
 * 客户端保存：对比 baseline 与当前 Redux 状态，生成需要发送给服务端的批量操作。
 *
 * 用于 "保存版本" 流程：先将所有本地编辑落库，然后创建版本快照。
 */
import type { Task, Dependency } from '@/types'
import { toDateTimeStr } from './clientTime'
import { normalizeDurationMinutes } from './taskNumbers'

const TASK_FIELDS = [
  'name', 'parent_id', 'assignee', 'start_date', 'end_date',
  'duration', 'duration_unit', 'percent_done', 'is_milestone', 'note',
  'order_index', 'auto_schedule', 'constraint_type', 'constraint_date',
  'status', 'rollup', 'inactive', 'project_boundary', 'baseline_end_date',
  'deadline', 'task_code',
] as const

const DEP_FIELDS = ['type', 'lag', 'active'] as const

function taskFieldsEqual(a: Task, b: Task): boolean {
  for (const f of TASK_FIELDS) {
    let av = a[f] as unknown
    let bv = b[f] as unknown
    if (f === 'start_date' || f === 'end_date' || f === 'constraint_date'
        || f === 'baseline_end_date' || f === 'deadline') {
      av = toDateTimeStr(av as string | Date | null | undefined)
      bv = toDateTimeStr(bv as string | Date | null | undefined)
    }
    if ((av ?? null) !== (bv ?? null)) return false
  }
  return true
}

function depFieldsEqual(a: Dependency, b: Dependency): boolean {
  for (const f of DEP_FIELDS) {
    const av = a[f] as unknown
    const bv = b[f] as unknown
    // active 默认 true
    if (f === 'active') {
      if ((av ?? true) !== (bv ?? true)) return false
    } else if ((av ?? null) !== (bv ?? null)) return false
  }
  if (a.from_task_id !== b.from_task_id) return false
  if (a.to_task_id !== b.to_task_id) return false
  return true
}

export interface SaveDiff {
  tasksToAdd: Task[]
  tasksToUpdate: Task[]
  tasksToDelete: string[]
  depsToAdd: Dependency[]
  depsToUpdate: Dependency[]
  depsToDelete: string[]
}

export interface SaveBaseline {
  tasks: Task[]
  dependencies: Dependency[]
  statusDate: string | null
}

/** Use persisted results for records involved in a failed attempt. Other
 * sessions' newly created records must not become deletions in our retry. */
export function recoverSaveRecords<T extends { id: string }>(
  baseline: T[], persisted: T[], attemptedIds: Iterable<string>,
): T[] {
  const knownIds = new Set([...baseline.map(item => item.id), ...attemptedIds])
  return persisted.filter(item => knownIds.has(item.id))
}

function hasChangedFields<T extends { id: string }>(submitted: T, current: T): boolean {
  const keys = new Set([...Object.keys(submitted), ...Object.keys(current)])
  for (const key of keys) {
    if (!Object.is((submitted as Record<string, unknown>)[key], (current as Record<string, unknown>)[key])) return true
  }
  return false
}

/**
 * Reconcile an authoritative server result with edits made locally after the
 * save request was sent. Server values win for untouched fields; newer local
 * edits, additions, and deletions remain in the working copy.
 */
export function mergeSavedRecords<T extends { id: string }>(
  saved: T[],
  submitted: T[],
  current: T[],
): T[] {
  const savedById = new Map(saved.map(item => [item.id, item]))
  const submittedById = new Map(submitted.map(item => [item.id, item]))
  const currentById = new Map(current.map(item => [item.id, item]))
  const ids = new Set([...savedById.keys(), ...submittedById.keys(), ...currentById.keys()])
  const merged: T[] = []

  for (const id of ids) {
    const serverItem = savedById.get(id)
    const submittedItem = submittedById.get(id)
    const currentItem = currentById.get(id)

    if (!serverItem) {
      // Keep local additions and edits made while the request was in flight.
      if (currentItem && (!submittedItem || hasChangedFields(submittedItem, currentItem))) merged.push(currentItem)
      continue
    }
    if (!currentItem) {
      // A missing item is a newer local deletion if it existed when submitted.
      if (!submittedItem) merged.push(serverItem)
      continue
    }
    if (!submittedItem) {
      merged.push(currentItem)
      continue
    }

    const item: Record<string, unknown> = { ...serverItem }
    for (const key of new Set([...Object.keys(submittedItem), ...Object.keys(currentItem)])) {
      if (!Object.is(
        (submittedItem as Record<string, unknown>)[key],
        (currentItem as Record<string, unknown>)[key],
      )) item[key] = (currentItem as Record<string, unknown>)[key]
    }
    merged.push(item as T)
  }

  return merged
}

function numericTaskCode(v: string | null | undefined): number | null {
  if (!v || !/^\d+$/.test(v)) return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

function normalizeAddedTaskCodes(baselineTasks: Task[], tasksToAdd: Task[]): Task[] {
  if (tasksToAdd.length === 0) return tasksToAdd

  const used = new Set<string>()
  let maxCode = 0
  for (const t of baselineTasks) {
    if (!t.task_code) continue
    used.add(t.task_code)
    const n = numericTaskCode(t.task_code)
    if (n != null && n > maxCode) maxCode = n
  }

  let nextCode = maxCode + 1
  return tasksToAdd.map(t => {
    let code = t.task_code?.trim() || ''
    if (!code || used.has(code)) {
      while (used.has(String(nextCode))) nextCode++
      code = String(nextCode++)
    }
    used.add(code)
    return code === t.task_code ? t : { ...t, task_code: code }
  })
}

export function buildSaveDiff(
  baselineTasks: Task[],
  baselineDeps: Dependency[],
  currentTasks: Task[],
  currentDeps: Dependency[],
): SaveDiff {
  const baseTaskMap = new Map<string, Task>()
  for (const t of baselineTasks) baseTaskMap.set(t.id, t)
  const curTaskMap = new Map<string, Task>()
  for (const t of currentTasks) if (!t.is_deleted) curTaskMap.set(t.id, t)

  const tasksToAdd: Task[] = []
  const tasksToUpdate: Task[] = []
  const tasksToDelete: string[] = []

  const normalizeTaskDuration = (task: Task): Task => {
    const duration = normalizeDurationMinutes(task.duration, task.start_date, task.end_date)
    return duration === task.duration ? task : { ...task, duration }
  }

  for (const [id, cur] of curTaskMap) {
    const old = baseTaskMap.get(id)
    if (!old) {
      tasksToAdd.push(normalizeTaskDuration(cur))
    } else if (!taskFieldsEqual(old, cur)) {
      tasksToUpdate.push(normalizeTaskDuration(cur))
    }
  }
  for (const id of baseTaskMap.keys()) {
    if (!curTaskMap.has(id)) tasksToDelete.push(id)
  }

  // 也支持显式 is_deleted 标记（兜底，正常情况下应直接从 currentTasks 移除）
  for (const t of currentTasks) {
    if (t.is_deleted && baseTaskMap.has(t.id) && !tasksToDelete.includes(t.id)) {
      tasksToDelete.push(t.id)
    }
  }

  const baseDepMap = new Map<string, Dependency>()
  for (const d of baselineDeps) baseDepMap.set(d.id, d)
  const curDepMap = new Map<string, Dependency>()
  for (const d of currentDeps) curDepMap.set(d.id, d)

  const depsToAdd: Dependency[] = []
  const depsToUpdate: Dependency[] = []
  const depsToDelete: string[] = []

  for (const [id, cur] of curDepMap) {
    const old = baseDepMap.get(id)
    if (!old) depsToAdd.push(cur)
    else if (!depFieldsEqual(old, cur)) depsToUpdate.push(cur)
  }
  for (const id of baseDepMap.keys()) {
    if (!curDepMap.has(id)) depsToDelete.push(id)
  }

  // 删除任务时，关联依赖也会被服务端级联删除——但本地 baseline 中这些依赖也应被剔除，
  // 否则 buildSaveDiff 会试图重复 DELETE。这里通过过滤掉已被 task delete 覆盖的依赖来避免。
  const deletedTaskSet = new Set(tasksToDelete)
  const filteredDepDelete = depsToDelete.filter(depId => {
    const d = baseDepMap.get(depId)
    if (!d) return false
    return !deletedTaskSet.has(d.from_task_id) && !deletedTaskSet.has(d.to_task_id)
  })

  return {
    tasksToAdd: normalizeAddedTaskCodes(baselineTasks, tasksToAdd), tasksToUpdate, tasksToDelete,
    depsToAdd, depsToUpdate, depsToDelete: filteredDepDelete,
  }
}

export function hasAnyDiff(d: SaveDiff): boolean {
  return d.tasksToAdd.length + d.tasksToUpdate.length + d.tasksToDelete.length
       + d.depsToAdd.length + d.depsToUpdate.length + d.depsToDelete.length > 0
}
