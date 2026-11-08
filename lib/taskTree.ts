import type { Task } from '../types'

/** Include hidden/collapsed descendants once; moved-out tasks are not descendants. */
export function taskBranchIds(tasks: Task[], selectedIds: string[]): Set<string> {
  const live = new Set(tasks.filter(task => !task.is_deleted).map(task => task.id))
  const children = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.is_deleted || !task.parent_id) continue
    const ids = children.get(task.parent_id) ?? []
    ids.push(task.id); children.set(task.parent_id, ids)
  }
  const result = new Set(selectedIds.filter(id => live.has(id)))
  const queue = [...result]
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) ?? []) {
    if (!result.has(id)) { result.add(id); queue.push(id) }
  }
  return result
}
