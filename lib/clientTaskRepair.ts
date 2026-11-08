import type { Dependency, Task } from '../types'
import { addMinutesStr, toDateTimeStr } from './clientTime'
import { scheduleDurationMinutes } from './clientTaskEdit'
import { runFullCascade } from './clientScheduling'

/** A preview only: callers commit the complete result as one local draft step. */
export function buildTaskRepair(tasks: Task[], dependencies: Dependency[], repairDate: string, isMinute = false) {
  const day = toDateTimeStr(repairDate)?.slice(0, 10)
  const repairedIds: string[] = []
  const updates = new Map<string, Task>()
  if (!day) return { repairedIds, updates: [] as Task[] }
  const live = tasks.filter(task => !task.is_deleted)
  const byId = new Map(live.map(task => [task.id, task]))
  const summaries = new Set(live.map(task => task.parent_id))
  // Even a disabled predecessor is still a configured predecessor. Do not
  // silently treat it as absent when applying this specific repair rule.
  const hasPredecessor = new Set(dependencies.map(dep => dep.to_task_id))
  const inactive = (task: Task): boolean => {
    let current: Task | undefined = task
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (current.inactive) return true
      seen.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return false
  }
  for (const task of live) {
    if (task.auto_schedule === false || (task.constraint_type || 'asap') !== 'asap'
      || hasPredecessor.has(task.id) || summaries.has(task.id) || inactive(task)) continue
    const start = toDateTimeStr(task.start_date)
    const span = scheduleDurationMinutes(task.start_date, task.end_date, isMinute)
    if (!start || start.slice(0, 10) <= day || span == null || span < 0) continue
    const duration = task.is_milestone ? 0 : span
    // Repair the calendar date; minute projects retain their original time.
    const newStart = `${day}${isMinute ? start.slice(10) : 'T00:00:00'}`
    const newEnd = addMinutesStr(newStart, duration)
    if (!newEnd) continue
    repairedIds.push(task.id)
    updates.set(task.id, { ...task, start_date: newStart, end_date: newEnd, duration })
  }
  if (!repairedIds.length) return { repairedIds, updates: [] as Task[] }

  // Restrict scheduling to the repaired branches and automatic successors.
  // Unrelated user edits must not be reset by a full-project scheduling pass.
  const outgoing = new Map<string, string[]>()
  for (const dep of dependencies) {
    if (dep.active === false) continue
    const targets = outgoing.get(dep.from_task_id) ?? []
    targets.push(dep.to_task_id)
    outgoing.set(dep.from_task_id, targets)
  }
  const affected = new Set(repairedIds)
  const queue = [...repairedIds]
  const add = (id: string) => { if (!affected.has(id)) { affected.add(id); queue.push(id) } }
  for (let index = 0; index < queue.length; index++) {
    const task = byId.get(queue[index])!
    if (task.parent_id && byId.has(task.parent_id)) add(task.parent_id)
    for (const id of outgoing.get(task.id) ?? []) {
      const successor = byId.get(id)
      if (successor && successor.auto_schedule !== false && !inactive(successor)) add(id)
    }
  }
  // A summary may itself be a predecessor. Repeat after rollup so its
  // successors see the final child dates, using the existing constraint rules.
  for (let pass = 0; pass <= affected.size; pass++) {
    const next = live.map(task => {
      const current = updates.get(task.id) ?? task
      return affected.has(task.id) ? current : { ...current, auto_schedule: false }
    })
    const cascaded = runFullCascade(next, dependencies, { isMinute }).filter(task => affected.has(task.id))
    if (!cascaded.length) break
    for (const task of cascaded) updates.set(task.id, task)
  }
  return { repairedIds, updates: [...updates.values()] }
}
