import type { Task, Dependency } from '../types'
import { runFullCascade } from './clientScheduling'

/** Cascade a bar gesture through its successors, without moving manual tasks.
 * Directly dragged tasks (including children of a dragged summary) retain their
 * explicit edits. All values are local previews until the user confirms them.
 */
export function cascadeDragSuccessors(
  tasks: Task[],
  dependencies: Dependency[],
  directUpdates: Record<string, Task>,
  successorIds: string[],
): Record<string, Task> {
  const updates = { ...directUpdates }
  const byId = new Map(tasks.filter(t => !t.is_deleted).map(task => [task.id, directUpdates[task.id] ?? task]))
  const inactive = (id: string) => {
    const seen = new Set<string>()
    let task = byId.get(id)
    while (task && !seen.has(task.id)) {
      seen.add(task.id)
      if (task.inactive) return true
      task = task.parent_id ? byId.get(task.parent_id) : undefined
    }
    return false
  }
  const outgoing = new Map<string, string[]>()
  for (const dep of dependencies) {
    if (dep.active === false || inactive(dep.from_task_id) || inactive(dep.to_task_id)) continue
    const list = outgoing.get(dep.from_task_id) ?? []
    list.push(dep.to_task_id)
    outgoing.set(dep.from_task_id, list)
  }
  // Parent summaries can have successors absent from the leaf's cached list.
  const affected = new Set([...Object.keys(directUpdates), ...successorIds])
  const queue = [...affected]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const next of [byId.get(id)?.parent_id, ...outgoing.get(id) ?? []]) {
      if (next && byId.has(next) && !affected.has(next)) { affected.add(next); queue.push(next) }
    }
  }
  for (let pass = 0; pass < affected.size; pass++) {
    const current = tasks.map(t => updates[t.id] ?? t)
    // Freeze direct gestures and unrelated tasks only inside the calculation;
    // their stored manual/automatic flags remain unchanged.
    const seeded = current.map(t => affected.has(t.id) && !directUpdates[t.id] && !inactive(t.id) ? t : { ...t, auto_schedule: false })
    const cascaded = runFullCascade(seeded, dependencies).filter(t => affected.has(t.id) && !directUpdates[t.id])
    if (!cascaded.length) break
    const currentById = new Map(current.map(t => [t.id, t]))
    for (const task of cascaded) updates[task.id] = { ...currentById.get(task.id)!,
      start_date: task.start_date, end_date: task.end_date, duration: task.duration,
      original_start_date: task.original_start_date, original_end_date: task.original_end_date }
  }
  return updates
}
