import type { Task } from '../types'

/** Select entire branches in tree order, including collapsed/filtered children. */
export function taskMoveSelection(tasks: Task[], selectedIds: string[]) {
  const live = tasks.filter(t => !t.is_deleted)
  const byId = new Map(live.map(t => [t.id, t]))
  const children = new Map<string | null, Task[]>()
  for (const task of live) {
    const parent = task.parent_id ?? null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(task)
  }
  children.forEach(list => list.sort((a, b) => a.order_index - b.order_index))
  const included = new Set<string>()
  const include = (id: string) => {
    if (!byId.has(id) || included.has(id)) return
    included.add(id)
    for (const child of children.get(id) ?? []) include(child.id)
  }
  selectedIds.forEach(include)
  const ordered: Task[] = [], visited = new Set<string>()
  const visit = (task: Task) => {
    if (visited.has(task.id)) return
    visited.add(task.id)
    if (included.has(task.id)) ordered.push(task)
    for (const child of children.get(task.id) ?? []) visit(child)
  }
  for (const task of children.get(null) ?? []) visit(task)
  for (const task of live) visit(task)
  return {
    roots: ordered.filter(t => !t.parent_id || !included.has(t.parent_id)),
    ids: ordered.map(t => t.id),
  }
}

/** Move selected branches next to a real task, never by a filtered row index. */
export function buildTaskRowMove(tasks: Task[], selectedIds: string[], targetId: string, position: 'before' | 'after') {
  const target = tasks.find(t => t.id === targetId && !t.is_deleted)
  const live = tasks.filter(t => !t.is_deleted && t.project_id === target?.project_id)
  const selection = taskMoveSelection(live, selectedIds)
  const result = { updates: [] as Task[], movedIds: selection.ids, rootIds: selection.roots.map(t => t.id),
    parentId: target?.parent_id ?? null, invalidReason: '' }
  if (!target || !selection.roots.length) return { ...result, invalidReason: '没有可移动的任务' }
  if (selection.ids.includes(target.id) || (target.parent_id && selection.ids.includes(target.parent_id))) {
    return { ...result, invalidReason: '不能移到自身或子任务内' }
  }
  const rootIds = new Set(result.rootIds)
  const parentId = target.parent_id ?? null
  const siblings = live.filter(t => (t.parent_id ?? null) === parentId && !rootIds.has(t.id))
    .sort((a, b) => a.order_index - b.order_index)
  const at = siblings.findIndex(t => t.id === target.id) + (position === 'after' ? 1 : 0)
  siblings.splice(at, 0, ...selection.roots)
  const affectedParents = new Set([parentId, ...selection.roots.map(t => t.parent_id ?? null)])
  for (const parent of affectedParents) {
    const group = parent === parentId ? siblings : live.filter(t => (t.parent_id ?? null) === parent && !rootIds.has(t.id))
      .sort((a, b) => a.order_index - b.order_index)
    group.forEach((task, order) => {
      if ((task.parent_id ?? null) !== parent || task.order_index !== order) result.updates.push({ ...task, parent_id: parent, order_index: order })
    })
  }
  return result
}
