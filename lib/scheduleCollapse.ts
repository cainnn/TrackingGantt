import type { Task, Dependency } from '../types'
import { addMinutesStr, diffMinutesStr, toDateTimeStr } from './clientTime'
import { runFullCascade, snapTaskUpdatesToDayLevel } from './clientScheduling'
import { getNowYmdHm, getTodayYmd } from './statusDatePolicy'

/** Shared tightening planner for removed links and explicitly confirmed save alignment. */
export function planScheduleCollapse(
  tasks: Task[], dependencies: Dependency[],
  reason: { removedDependencies: Dependency[] } | { alignUnlinked: true },
  options: { isMinute?: boolean; anchorDate?: string } = {},
) {
  const byId = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const summaries = new Set([...byId.values()].map(t => t.parent_id).filter(Boolean))
  const ancestors = (id: string) => {
    const result = new Set<string>()
    let parent = byId.get(id)?.parent_id
    while (parent && !result.has(parent)) {
      result.add(parent)
      parent = byId.get(parent)?.parent_id
    }
    return result
  }
  const ancestry = new Map([...byId.keys()].map(id => [id, ancestors(id)]))
  const inactive = (id: string) => !byId.has(id) || byId.get(id)?.inactive
    || [...(ancestry.get(id) ?? [])].some(parent => byId.get(parent)?.inactive)
  const effective = (d: Dependency) => d.active !== false && !inactive(d.from_task_id) && !inactive(d.to_task_id)
    && !ancestry.get(d.from_task_id)?.has(d.to_task_id) && !ancestry.get(d.to_task_id)?.has(d.from_task_id)
  const activeDeps = dependencies.filter(effective)
  const hasIncoming = new Set(activeDeps.map(d => d.to_task_id))
  const anchor = toDateTimeStr(options.anchorDate ?? (options.isMinute ? `${getNowYmdHm()}:00` : `${getTodayYmd()}T00:00:00`))
  if (!anchor) throw new Error('无效的排程对齐日期')
  const lostIncoming = new Set('removedDependencies' in reason
    ? reason.removedDependencies.filter(effective).map(d => d.to_task_id)
    : [...byId.values()].filter(t => !hasIncoming.has(t.id) && !summaries.has(t.id) && !inactive(t.id) && t.auto_schedule !== false
      && (!t.constraint_type || ['asap', 'none'].includes(t.constraint_type))
      && t.start_date && t.end_date && toDateTimeStr(t.start_date)! > anchor && diffMinutesStr(t.start_date, t.end_date) >= 0).map(t => t.id))
  const successors = new Map<string, string[]>()
  for (const d of activeDeps) successors.set(d.from_task_id, [...(successors.get(d.from_task_id) ?? []), d.to_task_id])
  const affected = new Set<string>()
  const queue = [...lostIncoming]
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    const task = byId.get(id)
    // A manual activity does not move, so its downstream branch need not be recalculated.
    if (!task || affected.has(id) || inactive(id) || task.auto_schedule === false) continue
    affected.add(id)
    if (task.parent_id) queue.push(task.parent_id)
    queue.push(...(successors.get(id) ?? []))
  }
  let finalTasks = tasks.map(task => {
    if (!affected.has(task.id) || !lostIncoming.has(task.id) || hasIncoming.has(task.id) || summaries.has(task.id)
      || !task.start_date || !task.end_date || toDateTimeStr(task.start_date)! <= anchor) return task
    // Unlinked future work can start at the anchor; never postpone an existing start.
    const duration = task.is_milestone ? 0 : Math.max(0, diffMinutesStr(task.start_date, task.end_date))
    return { ...task, start_date: anchor, end_date: addMinutesStr(anchor, duration), duration }
  })
  // Summary rollups happen after dependencies. Feed their new dates back into successors,
  // including chains spanning several summaries, until the affected schedule stabilizes.
  for (let pass = 0; pass < affected.size; pass++) {
    const cascade = runFullCascade(finalTasks.map(t => affected.has(t.id) ? t : { ...t, auto_schedule: false }), dependencies, options)
      .filter(t => affected.has(t.id))
    const updates = new Map((options.isMinute ? cascade : snapTaskUpdatesToDayLevel(cascade)).map(t => [t.id, t]))
    if (!updates.size) break
    finalTasks = finalTasks.map(t => updates.get(t.id) ?? t)
  }
  const fields = ['start_date', 'end_date', 'duration', 'original_start_date', 'original_end_date'] as const
  finalTasks = finalTasks.map((task, index) => fields.every(field => (task[field] ?? null) === (tasks[index][field] ?? null)) ? tasks[index] : task)
  const updatedTasks = finalTasks.filter((t, index) => t !== tasks[index])
  return { tasks: finalTasks, updatedTasks, anchor,
    directTaskIds: updatedTasks.filter(t => lostIncoming.has(t.id) && !hasIncoming.has(t.id) && !summaries.has(t.id)).map(t => t.id) }
}
