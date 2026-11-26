import type { Dependency, Task } from '../types'
import { activeScheduleTasks, scheduleMinute } from './scheduleAnalysis'
import { toDateTimeStr } from './clientTime'

export type TraceMode = 'driving' | 'driven' | 'both' | 'upstream' | 'downstream' | 'connecting'
export const TRACE_MODES: Record<TraceMode, string> = {
  driving: '驱动路径', driven: '后续驱动路径', both: '双向驱动路径',
  upstream: '全部前置链', downstream: '全部后续链', connecting: '两任务连接路径',
}
export const DEPENDENCY_TYPES = ['SS', 'SF', 'FS', 'FF'] as const
export type TraceLinkStatus = 'driving' | 'slack' | 'conflict' | 'inactive' | 'missing' | 'invalid' | 'manual' | 'fixed' | 'summary' | 'cycle'
export interface TraceLink {
  dependency: Dependency
  from?: Task
  to?: Task
  slackMinutes: number | null
  status: TraceLinkStatus
  reason: string
  traversable: boolean
}
export interface DependencyGraph {
  tasks: Map<string, Task>
  numbers: Map<string, number>
  links: TraceLink[]
  incoming: Map<string, TraceLink[]>
  outgoing: Map<string, TraceLink[]>
}
export interface TracePath {
  taskIds: Set<string>
  dependencyIds: Set<string>
  warnings: string[]
  found: boolean
}
export interface TraceHighlight {
  taskIds: Set<string>
  dependencyIds: Set<string>
  focusId: string
  onlyPath: boolean
}

// Same depth-first numbering as the grid, independent of filtering and collapse.
function taskNumbers(tasks: Task[]) {
  const children = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const parent = task.parent_id === task.id ? null : task.parent_id
    const group = children.get(parent) ?? []; group.push(task); children.set(parent, group)
  }
  for (const group of children.values()) group.sort((a, b) => a.order_index - b.order_index)
  const numbers = new Map<string, number>(), pending = [...(children.get(null) ?? [])].reverse()
  while (pending.length) {
    const task = pending.pop()!
    if (numbers.has(task.id)) continue
    numbers.set(task.id, numbers.size + 1)
    for (const child of [...(children.get(task.id) ?? [])].reverse()) pending.push(child)
  }
  return numbers
}

function validMinute(value: string | null | undefined) {
  const normalized = toDateTimeStr(value), minute = scheduleMinute(value)
  return normalized && minute != null && new Date(minute * 60000).toISOString().slice(0, 16) === normalized.slice(0, 16) ? minute : null
}

// Iterative strongly connected components: large chains must not exhaust the call stack.
function components(ids: Iterable<string>, links: TraceLink[]) {
  const outgoing = new Map<string, string[]>(), incoming = new Map<string, string[]>()
  for (const { dependency: d, traversable } of links) if (traversable) {
    const out = outgoing.get(d.from_task_id) ?? []; out.push(d.to_task_id); outgoing.set(d.from_task_id, out)
    const inc = incoming.get(d.to_task_id) ?? []; inc.push(d.from_task_id); incoming.set(d.to_task_id, inc)
  }
  const seen = new Set<string>(), order: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const stack: [string, boolean][] = [[id, false]]
    while (stack.length) {
      const [next, done] = stack.pop()!
      if (done) { order.push(next); continue }
      if (seen.has(next)) continue
      seen.add(next); stack.push([next, true])
      for (const child of outgoing.get(next) ?? []) if (!seen.has(child)) stack.push([child, false])
    }
  }
  const result = new Map<string, number>()
  for (const id of order.reverse()) {
    if (result.has(id)) continue
    const component = result.size, stack = [id]
    while (stack.length) {
      const next = stack.pop()!
      if (result.has(next)) continue
      result.set(next, component)
      for (const parent of incoming.get(next) ?? []) if (!result.has(parent)) stack.push(parent)
    }
  }
  return result
}

/** Direct driving slack = successor event - predecessor event - signed lag.
 * Uses this application's continuous calendar, not MS Project working calendars.
 * Logical links remain queryable even where driving dates cannot be established. */
export function buildDependencyGraph(tasks: Task[], dependencies: Dependency[]): DependencyGraph {
  const live = tasks.filter(t => !t.is_deleted), byId = new Map(live.map(t => [t.id, t]))
  const active = new Set(activeScheduleTasks(tasks).map(t => t.id))
  const summaries = new Set(live.map(t => t.parent_id).filter(Boolean))
  const timing = new Map(live.map(task => [task.id, { start: validMinute(task.start_date), end: validMinute(task.end_date) }]))
  const ancestor = (id: string, task: Task) => {
    const seen = new Set<string>()
    let parent = task.parent_id
    while (parent && !seen.has(parent)) {
      if (parent === id) return true
      seen.add(parent); parent = byId.get(parent)?.parent_id ?? null
    }
    return false
  }
  const constraintConflict = (task: Task) => {
    if (task.auto_schedule === false || summaries.has(task.id)) return false
    const { start, end } = timing.get(task.id)!, date = validMinute(task.constraint_date)
    if (!task.constraint_date || ['asap', 'alap', 'none', null, undefined].includes(task.constraint_type)) return false
    if (date == null) return true
    return task.constraint_type === 'muststarton' ? start !== date : task.constraint_type === 'mustfinishon' ? end !== date
      : task.constraint_type === 'startnoearlierthan' ? start != null && start < date
      : task.constraint_type === 'finishnoearlierthan' ? end != null && end < date
      : task.constraint_type === 'startnolaterthan' ? start != null && start > date
      : task.constraint_type === 'finishnolaterthan' ? end != null && end > date : false
  }
  const links: TraceLink[] = dependencies.map(dependency => {
    const d = dependency, from = byId.get(d.from_task_id), to = byId.get(d.to_task_id)
    const link: TraceLink = { dependency: d, from, to, slackMinutes: null, status: 'invalid', reason: '', traversable: false }
    const state = (status: TraceLinkStatus, reason: string) => Object.assign(link, { status, reason })
    if (!from || !to) return state('missing', '关联任务已删除或不存在')
    if (d.active === false || !active.has(from.id) || !active.has(to.id)) return state('inactive', '关系或任务已停用（含父任务停用）')
    if (ancestor(from.id, to) || ancestor(to.id, from)) return state('invalid', '父子任务间的关系不参与排程')
    link.traversable = true
    const type = d.type ?? 2, lag = d.lag ?? 0
    if (![0, 1, 2, 3].includes(type) || !Number.isFinite(lag)) return state('invalid', '关系类型或间隔无效')
    const source = timing.get(from.id)!, target = timing.get(to.id)!
    if (source.start == null || source.end == null || target.start == null || target.end == null
      || source.end < source.start || target.end < target.start) return state('invalid', '日期缺失或无效')
    link.slackMinutes = (type & 1 ? target.end : target.start) - (type & 2 ? source.end : source.start) - lag
    if (to.auto_schedule === false) return state('manual', '后续为手动任务，日期固定；驱动追踪到此停止')
    if (summaries.has(from.id) || summaries.has(to.id)) return state('summary', '摘要日期由子任务汇总；可查看逻辑链，请选择子任务分析驱动')
    if (constraintConflict(from) || constraintConflict(to)) return state('conflict', '任务日期与限制冲突，请先检查排程')
    if (link.slackMinutes < 0) return state('conflict', '日期不满足依赖及间隔要求，请先检查排程')
    if (['muststarton', 'mustfinishon'].includes(to.constraint_type ?? '') && to.constraint_date) return state('fixed', '后续日期被“必须于”限制固定；驱动追踪到此停止')
    return link.slackMinutes === 0 ? state('driving', '此关系的驱动时差为零') : state('slack', '此关系存在可用时间间隔')
  })
  const groups = components(byId.keys(), links)
  for (const link of links) if (link.traversable && groups.get(link.from!.id) === groups.get(link.to!.id)) {
    link.status = 'cycle'; link.reason = '循环依赖，不能确定驱动路径'
  }
  const incoming = new Map<string, TraceLink[]>(), outgoing = new Map<string, TraceLink[]>()
  for (const link of links) {
    const d = link.dependency, inc = incoming.get(d.to_task_id) ?? [], out = outgoing.get(d.from_task_id) ?? []
    inc.push(link); out.push(link); incoming.set(d.to_task_id, inc); outgoing.set(d.from_task_id, out)
  }
  return { tasks: byId, numbers: taskNumbers(live), links, incoming, outgoing }
}

// Min-heap for cumulative slack traversal, avoiding exponential path enumeration.
class DistanceQueue {
  items: [string, number][] = []
  push(item: [string, number]) {
    const a = this.items; a.push(item); let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][1] <= item[1]) break; a[i] = a[p]; i = p }
    a[i] = item
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop()!
    if (a.length) {
      let i = 0
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1
        if (c + 1 < a.length && a[c + 1][1] < a[c][1]) c++
        if (a[c][1] >= last[1]) break
        a[i] = a[c]; i = c
      }
      a[i] = last
    }
    return first
  }
}

export function traceDependencyPath(graph: DependencyGraph, focusId: string, mode: TraceMode, toleranceMinutes = 0, targetId?: string): TracePath {
  const result: TracePath = { taskIds: new Set(), dependencyIds: new Set(), warnings: [], found: false }
  if (!graph.tasks.has(focusId)) return result
  const warnings = new Set<string>()
  const walk = (start: string, backwards: boolean, driving: boolean) => {
    const distances = new Map([[start, 0]]), queue = new DistanceQueue(), edges = new Set<string>()
    queue.push([start, 0])
    while (queue.items.length) {
      const [id, distance] = queue.pop()
      if (distances.get(id) !== distance) continue
      for (const link of (backwards ? graph.incoming : graph.outgoing).get(id) ?? []) {
        if (driving ? !['driving', 'slack', 'inactive'].includes(link.status) : ['conflict', 'invalid', 'missing', 'cycle'].includes(link.status)) warnings.add(link.reason)
        if (!link.traversable || (driving && !['driving', 'slack'].includes(link.status))) continue
        const next = backwards ? link.dependency.from_task_id : link.dependency.to_task_id
        const cost = distance + (driving ? link.slackMinutes! : 0)
        if (driving && cost > toleranceMinutes) continue
        edges.add(link.dependency.id)
        if (cost < (distances.get(next) ?? Infinity)) { distances.set(next, cost); queue.push([next, cost]) }
      }
    }
    return { distances, edges }
  }
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) {
    result.warnings = ['驱动时差上限必须为非负数']; return result
  }
  if (mode === 'connecting') {
    if (!targetId || !graph.tasks.has(targetId)) { result.warnings = ['请选择连接终点任务']; return result }
    if (targetId === focusId) { result.warnings = ['连接终点不能与当前任务相同']; return result }
    const forward = walk(focusId, false, false), backward = walk(targetId, true, false)
    // Connecting results must not report issues from unrelated dead-end branches.
    warnings.clear()
    if (forward.distances.has(targetId)) {
      for (const id of forward.distances.keys()) if (backward.distances.has(id)) result.taskIds.add(id)
      for (const link of graph.links) if (link.traversable && result.taskIds.has(link.dependency.from_task_id) && result.taskIds.has(link.dependency.to_task_id)) {
        result.dependencyIds.add(link.dependency.id)
        if (['conflict', 'invalid', 'cycle'].includes(link.status)) warnings.add(link.reason)
      }
      result.found = true
    } else warnings.add('当前任务到终点之间没有有效的有向依赖路径')
  } else {
    result.taskIds.add(focusId)
    const directions = mode === 'both' ? [true, false] : [mode === 'driving' || mode === 'upstream']
    for (const backwards of directions) {
      const path = walk(focusId, backwards, !['upstream', 'downstream'].includes(mode))
      path.distances.forEach((_, id) => result.taskIds.add(id))
      path.edges.forEach(id => result.dependencyIds.add(id))
    }
    result.found = result.dependencyIds.size > 0
  }
  result.warnings = [...warnings]
  return result
}
