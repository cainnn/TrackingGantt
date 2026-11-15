import type { Task, Dependency } from '../types'
import { addMinutesStr, toDateTimeStr } from './clientTime'

/** Validate the submitted schedule without moving tasks or changing manual mode. */
export function findPlanScheduleConflicts(tasks: Task[], dependencies: Dependency[]): string[] {
  const byId = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const summaries = new Set([...byId.values()].map(t => t.parent_id).filter(Boolean))
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
  const ancestor = (parent: string, child: string) => {
    const seen = new Set<string>()
    let task = byId.get(child)
    while (task?.parent_id && !seen.has(task.id)) {
      seen.add(task.id)
      if (task.parent_id === parent) return true
      task = byId.get(task.parent_id)
    }
    return false
  }
  const issues: string[] = []
  for (const dep of dependencies) {
    if (dep.active === false || inactive(dep.from_task_id) || inactive(dep.to_task_id)) continue
    const from = byId.get(dep.from_task_id), to = byId.get(dep.to_task_id)
    if (!from || !to) { issues.push('存在指向已删除或不存在任务的依赖'); continue }
    if (to.auto_schedule === false || summaries.has(to.id) || ancestor(from.id, to.id) || ancestor(to.id, from.id)) continue
    const type = dep.type ?? 2
    const source = toDateTimeStr(type & 2 ? from.end_date : from.start_date)
    const actual = toDateTimeStr(type & 1 ? to.end_date : to.start_date)
    const required = addMinutesStr(source, dep.lag ?? 0)
    if (actual && required && actual < required) issues.push(`「${to.name}」的${type & 1 ? '完成' : '开始'}日期不满足前置「${from.name}」及间隔要求`)
  }
  for (const task of byId.values()) {
    if (task.auto_schedule === false || inactive(task.id) || summaries.has(task.id)) continue
    const start = toDateTimeStr(task.start_date), end = toDateTimeStr(task.end_date), date = toDateTimeStr(task.constraint_date)
    if (start && end && start > end) issues.push(`「${task.name}」的开始日期晚于完成日期`)
    if (!date) continue
    const type = task.constraint_type
    const conflict = type === 'muststarton' ? start && start !== date
      : type === 'mustfinishon' ? end && end !== date
      : type === 'startnoearlierthan' ? start && start < date
      : type === 'finishnoearlierthan' ? end && end < date
      : type === 'startnolaterthan' ? start && start > date
      : type === 'finishnolaterthan' ? end && end > date : false
    if (conflict) issues.push(`「${task.name}」的计划日期与日期限制冲突`)
  }
  return [...new Set(issues)]
}
