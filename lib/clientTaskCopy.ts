import type { Dependency, Task } from '../types'
import { uuid } from './uuid'
import { wouldCreateCycle } from './clientScheduling'

export interface CopyDependencyWarning { dependency: Dependency; reason: string }

/** 将选中任务（含摘要的全部后代）复制为目标任务的同级任务。 */
export function buildTaskCopies(
  tasks: Task[],
  dependencies: Dependency[],
  selectedIds: string[],
  targetId: string | null,
  position: 'before' | 'after',
  source?: { tasks: Task[]; dependencies: Dependency[] },
  options: { externalDependencies?: 'predecessors' | 'all' | 'none' } = {},
): { tasksToAdd: Task[]; tasksToUpdate: Task[]; dependenciesToAdd: Dependency[]; skippedDependencies?: CopyDependencyWarning[] } {
  const empty = { tasksToAdd: [], tasksToUpdate: [], dependenciesToAdd: [] }
  const target = targetId ? tasks.find(t => t.id === targetId && !t.is_deleted)
    : { id: '', parent_id: null, project_id: source?.tasks[0]?.project_id ?? tasks[0]?.project_id }
  if (!target) return empty

  const activeTasks = (source?.tasks ?? tasks).filter(t => !t.is_deleted && t.project_id === target.project_id)
  const taskMap = new Map(activeTasks.map(t => [t.id, t]))
  const children = new Map<string | null, Task[]>()
  for (const t of activeTasks) {
    const parentId = t.parent_id ?? null
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId)!.push(t)
  }
  children.forEach(list => list.sort((a, b) => a.order_index - b.order_index))

  const copyIds = new Set<string>()
  const include = (id: string) => {
    if (copyIds.has(id) || !taskMap.has(id)) return
    copyIds.add(id)
    for (const child of children.get(id) ?? []) include(child.id)
  }
  selectedIds.forEach(include)
  if (copyIds.size === 0) return empty

  // 使用任务树的显示顺序，不受勾选顺序或数据库返回顺序影响。
  const sourceTasks: Task[] = []
  const visited = new Set<string>()
  const visit = (t: Task) => {
    if (visited.has(t.id)) return
    visited.add(t.id)
    if (copyIds.has(t.id)) sourceTasks.push(t)
    for (const child of children.get(t.id) ?? []) visit(child)
  }
  for (const root of children.get(null) ?? []) visit(root)
  for (const t of activeTasks) visit(t)

  const roots = sourceTasks.filter(t => !t.parent_id || !copyIds.has(t.parent_id))
  const siblings = tasks.filter(t => !t.is_deleted && (t.parent_id ?? null) === (target.parent_id ?? null))
    .sort((a, b) => a.order_index - b.order_index)
  const insertIndex = targetId ? siblings.findIndex(t => t.id === targetId) + (position === 'after' ? 1 : 0) : siblings.length
  const idMap = new Map(sourceTasks.map(t => [t.id, uuid()]))
  const siblingIds = siblings.map(t => t.id)
  siblingIds.splice(insertIndex, 0, ...roots.map(t => idMap.get(t.id)!))
  const orderMap = new Map(siblingIds.map((id, order) => [id, order]))
  const tasksToUpdate = siblings
    .filter(t => t.order_index !== orderMap.get(t.id))
    .map(t => ({ ...t, order_index: orderMap.get(t.id)! }))

  // 连续编码从项目现有最大值之后分配，包括已删除任务，避免保存时冲突。
  const maxCode = tasks.reduce((max, t) => {
    const code = parseInt(t.task_code, 10)
    return Number.isFinite(code) ? Math.max(max, code) : max
  }, 0)
  const now = new Date().toISOString()
  const tasksToAdd = sourceTasks.map((t, i): Task => {
    const id = idMap.get(t.id)!
    const copiedParentId = t.parent_id ? idMap.get(t.parent_id) : undefined
    return {
      ...t,
      id,
      task_code: String(maxCode + i + 1),
      name: `${t.name} (副本)`,
      parent_id: copiedParentId ?? target.parent_id,
      order_index: copiedParentId ? t.order_index : orderMap.get(id)!,
      baseline_end_date: null,
      is_deleted: false,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }
  })
  const nextTasks = [...tasks.filter(t => !t.is_deleted), ...tasksToAdd]
  const nextById = new Map(nextTasks.map(t => [t.id, t]))
  const summaries = new Set(nextTasks.map(t => t.parent_id).filter(Boolean))
  const ancestor = (parentId: string, childId: string) => {
    const seen = new Set<string>()
    let node = nextById.get(childId)
    while (node?.parent_id && !seen.has(node.id)) {
      seen.add(node.id)
      if (node.parent_id === parentId) return true
      node = nextById.get(node.parent_id)
    }
    return false
  }
  const policy = options.externalDependencies ?? 'predecessors'
  const dependenciesToAdd: Dependency[] = []
  const skippedDependencies: CopyDependencyWarning[] = []
  const pairs = new Set(dependencies.map(d => `${d.from_task_id}/${d.to_task_id}`))
  for (const dep of source?.dependencies ?? dependencies) {
    const copyFrom = idMap.has(dep.from_task_id), copyTo = idMap.has(dep.to_task_id)
    if (!(copyFrom && copyTo) && !(copyTo && policy !== 'none') && !(copyFrom && policy === 'all')) continue
    const from = idMap.get(dep.from_task_id) ?? dep.from_task_id
    const to = idMap.get(dep.to_task_id) ?? dep.to_task_id
    const pair = `${from}/${to}`
    let reason: string | null = null
    if (!nextById.has(from) || !nextById.has(to)) reason = '原前置或后续任务已不存在'
    else if (nextById.get(from)!.project_id !== target.project_id || nextById.get(to)!.project_id !== target.project_id) reason = '依赖两端不属于当前项目'
    else if (from === to) reason = '不能创建自依赖'
    else if (ancestor(from, to) || ancestor(to, from)) reason = '依赖两端变为父子任务'
    else if (summaries.has(from) || summaries.has(to)) reason = '依赖端点是摘要任务，不能新增连线'
    else if (pairs.has(pair)) continue
    else if (wouldCreateCycle(from, to, [...dependencies, ...dependenciesToAdd])) reason = '保留该连线会形成循环依赖'
    if (reason) { skippedDependencies.push({ dependency: dep, reason }); continue }
    dependenciesToAdd.push({ ...dep, id: uuid(), project_id: target.project_id, from_task_id: from, to_task_id: to })
    pairs.add(pair)
  }

  return { tasksToAdd, tasksToUpdate, dependenciesToAdd, ...(skippedDependencies.length ? { skippedDependencies } : {}) }
}
