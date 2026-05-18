/**
 * 客户端保存：对比 baseline 与当前 Redux 状态，生成需要发送给服务端的批量操作。
 *
 * 用于 "保存版本" 流程：先将所有本地编辑落库，然后创建版本快照。
 */
import type { Task, Dependency } from '@/types'
import { toDateTimeStr } from './clientTime'

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

  for (const [id, cur] of curTaskMap) {
    const old = baseTaskMap.get(id)
    if (!old) {
      tasksToAdd.push(cur)
    } else if (!taskFieldsEqual(old, cur)) {
      tasksToUpdate.push(cur)
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
    tasksToAdd, tasksToUpdate, tasksToDelete,
    depsToAdd, depsToUpdate, depsToDelete: filteredDepDelete,
  }
}

export function hasAnyDiff(d: SaveDiff): boolean {
  return d.tasksToAdd.length + d.tasksToUpdate.length + d.tasksToDelete.length
       + d.depsToAdd.length + d.depsToUpdate.length + d.depsToDelete.length > 0
}
