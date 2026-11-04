import type { Task, Dependency } from '../types'
import { addMinutesStr, diffMinutesStr, toDateTimeStr } from './clientTime'

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
  const byId = new Map(tasks.map(task => [task.id, directUpdates[task.id] ?? task]))
  const incoming = new Map<string, Dependency[]>()
  for (const dep of dependencies) {
    if (dep.active === false) continue
    const list = incoming.get(dep.to_task_id) ?? []
    list.push(dep)
    incoming.set(dep.to_task_id, list)
  }

  let changed = true
  let iteration = 0
  while (changed && iteration++ < successorIds.length + 1) {
    changed = false
    for (const id of successorIds) {
      const task = byId.get(id)
      if (!task || task.auto_schedule === false || directUpdates[id]) continue
      const start = toDateTimeStr(task.start_date)
      const end = toDateTimeStr(task.end_date)
      if (!start || !end) continue
      const duration = diffMinutesStr(start, end)
      let requiredStart: string | null = null
      for (const dep of incoming.get(id) ?? []) {
        const from = byId.get(dep.from_task_id)
        if (!from?.start_date || !from?.end_date) continue
        const type = dep.type ?? 2
        const anchor = type === 2 || type === 3 ? from.end_date : from.start_date
        const lag = (dep.lag ?? 0) - (type === 3 || type === 1 ? duration : 0)
        const candidate = addMinutesStr(anchor, lag)
        if (candidate && (!requiredStart || candidate > requiredStart)) requiredStart = candidate
      }
      if (!requiredStart || start === requiredStart) continue
      const nextDuration = task.is_milestone ? 0 : Math.max(0, duration)
      const nextEnd = addMinutesStr(requiredStart, nextDuration)
      if (!nextEnd) continue
      const updated = { ...task, start_date: requiredStart, end_date: nextEnd, duration: nextDuration }
      byId.set(id, updated)
      updates[id] = updated
      changed = true
    }
  }
  return updates
}
