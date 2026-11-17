import type { Task, Dependency } from '../types'
import { addMinutesStr, toDateTimeStr } from './clientTime'
import { activeScheduleTasks } from './scheduleAnalysis'
import { buildTaskRepair } from './clientTaskRepair'

export interface ScheduleIssue {
  id: string
  kind: 'dependency' | 'constraint' | 'dates' | 'missing' | 'cycle' | 'deadline' | 'unlinked-start' | 'dependency-schedule'
  severity: 'error' | 'warning'
  taskId: string
  relatedTaskId?: string
  dependencyId?: string
  message: string
  detail: string
}

/** The panel and save gate share exactly the same blocking rules. */
export function getPlanScheduleIssues(tasks: Task[], dependencies: Dependency[], options: { isMinute?: boolean; anchorDate?: string } = {}): ScheduleIssue[] {
  const all = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const byId = new Map(activeScheduleTasks(tasks).map(t => [t.id, t]))
  const summaries = new Set([...all.values()].map(t => t.parent_id).filter(Boolean))
  const ancestor = (parent: string, child: string) => {
    const seen = new Set<string>(); let task = byId.get(child)
    while (task?.parent_id && !seen.has(task.id)) {
      seen.add(task.id)
      if (task.parent_id === parent) return true
      task = byId.get(task.parent_id)
    }
    return false
  }
  const issues: ScheduleIssue[] = []
  const edges: Dependency[] = []
  for (const dep of dependencies) {
    if (dep.active === false) continue
    const from = byId.get(dep.from_task_id), to = byId.get(dep.to_task_id)
    if ((!from && all.has(dep.from_task_id)) || (!to && all.has(dep.to_task_id))) continue
    if (!from || !to) {
      issues.push({ id: `missing:${dep.id}`, kind: 'missing', severity: 'error', taskId: to?.id ?? from?.id ?? '', dependencyId: dep.id,
        message: '存在指向已删除或不存在任务的依赖', detail: '请在仍存在任务的前置或后续设置中删除无效关系。' })
      continue
    }
    if (ancestor(from.id, to.id) || ancestor(to.id, from.id)) continue
    edges.push(dep)
    if (to.auto_schedule === false || summaries.has(to.id)) continue
    const type = dep.type ?? 2
    const source = toDateTimeStr(type & 2 ? from.end_date : from.start_date)
    const actual = toDateTimeStr(type & 1 ? to.end_date : to.start_date)
    const required = addMinutesStr(source, dep.lag ?? 0)
    if (actual && required && actual < required) issues.push({ id: `dependency:${dep.id}`, kind: 'dependency', severity: 'error', taskId: to.id, relatedTaskId: from.id, dependencyId: dep.id,
      message: `「${to.name}」的${type & 1 ? '完成' : '开始'}日期不满足前置「${from.name}」及间隔要求`,
      detail: `${['SS', 'SF', 'FS', 'FF'][type]}，间隔 ${dep.lag ?? 0} 分钟；要求不早于 ${required.replace('T', ' ')}，当前为 ${actual.replace('T', ' ')}。请核对依赖和日期限制。` })
  }
  for (const task of byId.values()) {
    if (summaries.has(task.id)) continue
    const start = toDateTimeStr(task.start_date), end = toDateTimeStr(task.end_date), date = toDateTimeStr(task.constraint_date)
    if (task.auto_schedule !== false) {
      if (start && end && start > end) issues.push({ id: `dates:${task.id}`, kind: 'dates', severity: 'error', taskId: task.id,
        message: `「${task.name}」的开始日期晚于完成日期`, detail: '请编辑任务的日期或工期。' })
      const type = task.constraint_type
      const conflict = date && (type === 'muststarton' ? start && start !== date
        : type === 'mustfinishon' ? end && end !== date
        : type === 'startnoearlierthan' ? start && start < date
        : type === 'finishnoearlierthan' ? end && end < date
        : type === 'startnolaterthan' ? start && start > date
        : type === 'finishnolaterthan' ? end && end > date : false)
      if (conflict) issues.push({ id: `constraint:${task.id}`, kind: 'constraint', severity: 'error', taskId: task.id,
        message: `「${task.name}」的计划日期与日期限制冲突`, detail: `限制日期 ${date?.replace('T', ' ')}；当前开始 ${start?.replace('T', ' ')}，完成 ${end?.replace('T', ' ')}。请编辑任务核对限制。` })
    }
    const deadline = toDateTimeStr(task.deadline)
    if (deadline && end && end > deadline) issues.push({ id: `deadline:${task.id}`, kind: 'deadline', severity: 'warning', taskId: task.id,
      message: `「${task.name}」超过截止日期`, detail: `计划完成 ${end.replace('T', ' ')}，截止 ${deadline.replace('T', ' ')}。此项仅提醒，不阻止保存。` })
  }
  const degree = new Map([...byId.keys()].map(id => [id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const dep of edges) { degree.set(dep.to_task_id, degree.get(dep.to_task_id)! + 1); outgoing.set(dep.from_task_id, [...(outgoing.get(dep.from_task_id) ?? []), dep.to_task_id]) }
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id)
  for (let i = 0; i < queue.length; i++) for (const to of outgoing.get(queue[i]) ?? []) { degree.set(to, degree.get(to)! - 1); if (!degree.get(to)) queue.push(to) }
  for (const [id, n] of degree) if (n) issues.push({ id: `cycle:${id}`, kind: 'cycle', severity: 'error', taskId: id,
    message: `「${byId.get(id)!.name}」存在循环依赖或受循环阻塞`, detail: '请检查前置链并移除循环关系。' })
  // Saved dates are not proof of a valid ASAP schedule. Inspect the whole plan,
  // using the same proposal as save and repair, regardless of draft changes.
  const alignment = buildTaskRepair(tasks, dependencies, options.anchorDate, options.isMinute)
  const format = (value: string | null) => toDateTimeStr(value)?.slice(0, options.isMinute ? 16 : 10).replace('T', ' ') ?? '—'
  for (const id of alignment.unlinkedTaskIds) {
    const task = byId.get(id)!
    issues.push({ id: `unlinked-start:${id}`, kind: 'unlinked-start', severity: 'warning', taskId: id,
      message: `「${task.name}」未按尽早开始规则排程`,
      detail: `任务为自动排程，限制为“${task.constraint_type === 'asap' ? '尽早' : '无'}”，没有有效前置任务；当前开始 ${format(task.start_date)}，应提前至 ${format(alignment.anchor)}。可预览修复；如需保留未来日期，请设置手动排程或日期限制。` })
  }
  for (const id of alignment.dependencyTaskIds) {
    if (issues.some(issue => issue.kind === 'dependency' && issue.taskId === id)) continue
    const task = byId.get(id)!, repaired = alignment.updates.find(task => task.id === id)!
    issues.push({ id: `dependency-schedule:${id}`, kind: 'dependency-schedule', severity: 'warning', taskId: id,
      message: `「${task.name}」未按前置依赖尽早排程`,
      detail: `当前开始 ${format(task.start_date)}，按前置关系及间隔应为 ${format(repaired.start_date)}。有有效前置时优先按依赖排程，即使日期早于今天，也不改到今天。` })
  }
  return issues
}

export function findPlanScheduleConflicts(tasks: Task[], dependencies: Dependency[]): string[] {
  return [...new Set(getPlanScheduleIssues(tasks, dependencies).filter(issue => issue.severity === 'error').map(issue => issue.message))]
}
