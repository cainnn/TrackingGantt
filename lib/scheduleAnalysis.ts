import type { Task, Dependency } from '../types'
import { toDateTimeStr } from './clientTime'

// Schedule values are wall-clock minutes, not UTC instants. Calendar-day plans
// must not gain/lose an hour when the browser's local zone crosses DST.
export function scheduleMinute(value: string | null | undefined): number | null {
  const s = toDateTimeStr(value)
  if (!s) return null
  const [y, m, d, h, min] = s.split(/[-T:]/).map(Number)
  const n = Date.UTC(y, m - 1, d, h, min) / 60000
  return Number.isFinite(n) ? n : null
}

export function activeScheduleTasks(tasks: Task[]) {
  const byId = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const inactive = (task: Task) => {
    const visited = new Set<string>()
    let current: Task | undefined = task
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      if (current.inactive) return true
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return false
  }
  return [...byId.values()].filter(t => !inactive(t))
}

export interface TaskTiming {
  totalSlack: number | null
  critical: boolean
  reason?: string
}
export interface ScheduleAnalysis {
  tasks: Map<string, TaskTiming>
  criticalDependencies: Set<string>
  warnings: string[]
}

/** Available delay from the currently displayed plan to the project finish or
 * an earlier hard limit. Manual tasks are fixed anchors, never re-scheduled.
 * This is read-only analysis; it never changes dates or task modes. */
export function analyzeSchedule(tasks: Task[], dependencies: Dependency[], projectFinish?: string | null): ScheduleAnalysis {
  const result: ScheduleAnalysis = { tasks: new Map(), criticalDependencies: new Set(), warnings: [] }
  const active = activeScheduleTasks(tasks)
  const activeIds = new Set(active.map(t => t.id))
  const summaryIds = new Set(active.map(t => t.parent_id).filter(Boolean))
  const nodes = new Map<string, { task: Task; start: number; duration: number; latest: number }>()
  for (const task of active) {
    if (summaryIds.has(task.id)) continue
    const start = scheduleMinute(task.start_date), end = scheduleMinute(task.end_date)
    if (start == null || end == null || end < start) {
      result.tasks.set(task.id, { totalSlack: null, critical: false, reason: '日期缺失或无效' })
      continue
    }
    nodes.set(task.id, { task, start, duration: end - start, latest: Infinity })
  }
  if (!nodes.size) return result
  const finish = scheduleMinute(projectFinish) ?? [...nodes.values()].reduce((max, n) => Math.max(max, n.start + n.duration), -Infinity)
  const edges: { dep: Dependency; from: string; to: string; weight: number }[] = []
  const unavailable = new Set<string>()
  const children = (id: string): string[] => {
    const seen = new Set<string>(), pending = [id], leaves: string[] = []
    for (let i = 0; i < pending.length; i++) {
      const current = pending[i]
      if (seen.has(current)) continue
      seen.add(current)
      for (const child of active.filter(t => t.parent_id === current)) {
        if (summaryIds.has(child.id)) pending.push(child.id)
        else leaves.push(child.id)
      }
    }
    return leaves
  }
  for (const dep of dependencies) {
    if (dep.active === false || !activeIds.has(dep.from_task_id) || !activeIds.has(dep.to_task_id)) continue
    const from = nodes.get(dep.from_task_id), to = nodes.get(dep.to_task_id)
    if (to?.task.auto_schedule === false) continue
    if (summaryIds.has(dep.from_task_id) && children(dep.from_task_id).includes(dep.to_task_id)
      || summaryIds.has(dep.to_task_id) && children(dep.to_task_id).includes(dep.from_task_id)) continue
    const type = dep.type ?? 2
    // A summary's finish is the maximum of its leaf finishes: FS/FF bounds
    // therefore apply to every active leaf, including nested summaries.
    if (!from && to && summaryIds.has(dep.from_task_id) && (type & 2)) {
      for (const id of children(dep.from_task_id)) {
        const child = nodes.get(id)
        if (!child) { unavailable.add(to.task.id); continue }
        edges.push({ dep, from: id, to: to.task.id, weight: child.duration - (type & 1 ? to.duration : 0) + (dep.lag ?? 0) })
      }
      continue
    }
    // Summary dates are min/max aggregates, not fixed-duration activities.
    // Do not manufacture a zero-float answer for an unsupported aggregate link.
    if (!from || !to) {
      const ids = [dep.from_task_id, dep.to_task_id].flatMap(id => summaryIds.has(id) ? children(id) : [id])
      ids.forEach(id => unavailable.add(id))
      continue
    }
    const weight = (type & 2 ? from.duration : 0) - (type & 1 ? to.duration : 0) + (dep.lag ?? 0)
    edges.push({ dep, from: from.task.id, to: to.task.id, weight })
  }
  // Uncertain aggregate endpoints invalidate their connected component only.
  for (let changed = true; changed;) {
    changed = false
    for (const e of edges) if (unavailable.has(e.from) || unavailable.has(e.to)) {
      for (const id of [e.from, e.to]) if (!unavailable.has(id)) { unavailable.add(id); changed = true }
    }
  }
  if (unavailable.size) result.warnings.push('涉及摘要依赖或无效日期的任务链暂不计算总时差；其余任务正常分析。')
  const inconsistent = new Set<string>()
  for (const [id, node] of nodes) {
    if (node.task.auto_schedule === false) continue
    const date = scheduleMinute(node.task.constraint_date), type = node.task.constraint_type
    if (date != null && ((['muststarton', 'startnoearlierthan'].includes(type ?? '') && node.start < date)
      || (['mustfinishon', 'finishnoearlierthan'].includes(type ?? '') && node.start + node.duration < date))) inconsistent.add(id)
  }
  for (const e of edges) if (nodes.get(e.to)!.start < nodes.get(e.from)!.start + e.weight) { inconsistent.add(e.from); inconsistent.add(e.to) }
  for (let changed = true; changed;) {
    changed = false
    for (const e of edges) if (inconsistent.has(e.from) || inconsistent.has(e.to)) for (const id of [e.from, e.to]) {
      if (!inconsistent.has(id)) { inconsistent.add(id); changed = true }
    }
  }
  if (inconsistent.size) result.warnings.push('部分任务日期早于前置或限制要求，相关任务链需先修正冲突，再计算总时差。')
  const outgoing = new Map<string, typeof edges>()
  const degree = new Map([...nodes.keys()].map(id => [id, 0]))
  for (const e of edges) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e])
    degree.set(e.to, degree.get(e.to)! + 1)
  }
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id)
  const order: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; order.push(id)
    for (const e of outgoing.get(id) ?? []) {
      degree.set(e.to, degree.get(e.to)! - 1)
      if (degree.get(e.to) === 0) queue.push(e.to)
    }
  }
  const cyclic = new Set([...degree].filter(([, n]) => n > 0).map(([id]) => id))
  // Upstream timing cannot be trusted if it feeds a cyclic component.
  for (let i = order.length - 1; i >= 0; i--) if ((outgoing.get(order[i]) ?? []).some(e => cyclic.has(e.to))) cyclic.add(order[i])
  if (cyclic.size) result.warnings.push('存在循环依赖，相关任务链不显示关键路径或总时差。')
  for (const node of nodes.values()) {
    node.latest = node.task.auto_schedule === false ? node.start : finish - node.duration
    if (node.task.auto_schedule === false) continue
    const date = scheduleMinute(node.task.constraint_date)
    const type = node.task.constraint_type
    if (date != null && ['muststarton', 'startnolaterthan'].includes(type ?? '')) node.latest = Math.min(node.latest, date)
    if (date != null && ['mustfinishon', 'finishnolaterthan'].includes(type ?? '')) node.latest = Math.min(node.latest, date - node.duration)
    const deadline = scheduleMinute(node.task.deadline)
    if (deadline != null) node.latest = Math.min(node.latest, deadline - node.duration)
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = nodes.get(order[i])!
    if (node.task.auto_schedule === false) continue
    for (const e of outgoing.get(order[i]) ?? []) node.latest = Math.min(node.latest, nodes.get(e.to)!.latest - e.weight)
  }
  for (const [id, node] of nodes) {
    const reason = cyclic.has(id) ? '循环依赖' : unavailable.has(id) ? '摘要依赖或无效日期' : node.task.auto_schedule === false ? '手动任务日期固定' : inconsistent.has(id) ? '请先修正排程冲突' : undefined
    const slack = reason ? null : Math.round(node.latest - node.start)
    result.tasks.set(id, { totalSlack: slack, critical: slack != null && slack <= 0, reason })
  }
  for (const e of edges) {
    const from = nodes.get(e.from)!, to = nodes.get(e.to)!
    if (result.tasks.get(e.from)?.critical && result.tasks.get(e.to)?.critical && Math.abs(to.start - from.start - e.weight) < 1) result.criticalDependencies.add(e.dep.id)
  }
  return result
}
