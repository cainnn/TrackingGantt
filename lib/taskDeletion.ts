import type { Task, Dependency } from '../types'
import { taskBranchIds } from './taskTree'
import { addMinutesStr, diffMinutesStr, toDateTimeStr } from './clientTime'
import { runFullCascade, wouldCreateCycle } from './clientScheduling'
import { getNowYmdHm, getTodayYmd } from './statusDatePolicy'
import { uuid } from './uuid'

export interface DeletionOptions {
  includeDescendants?: boolean
  isMinute?: boolean
  deletionDate?: string
  operationId?: string
}

export function deletionAnchor(isMinute = false): string {
  return isMinute ? `${getNowYmdHm()}:00` : `${getTodayYmd()}T00:00:00`
}

/** Remove activities as zero-duration nodes, retaining the outer dependency events and summed lags. */
export function planTaskDeletion(tasks: Task[], dependencies: Dependency[], requestedIds: Iterable<string>, options: DeletionOptions = {}) {
  const byId = new Map(tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const requested = [...requestedIds].filter(id => byId.has(id))
  const deletedIds = options.includeDescendants === false ? new Set(requested) : taskBranchIds(tasks, requested)
  const originalTasks = tasks.filter(t => !t.is_deleted && !deletedIds.has(t.id))
  const remainingTasks = originalTasks.map(task => {
    let parent = task.parent_id
    const seen = new Set<string>([task.id])
    while (parent && deletedIds.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      parent = byId.get(parent)?.parent_id ?? null
    }
    if (parent && seen.has(parent)) parent = null
    return parent === task.parent_id ? task : { ...task, parent_id: parent }
  })
  const remainingById = new Map(remainingTasks.map(t => [t.id, t]))
  const summaries = new Set(remainingTasks.map(t => t.parent_id).filter(Boolean))
  const inactive = (id: string, map = byId) => {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const task = map.get(id)
      if (!task) return false
      if (task.inactive) return true
      if (!task.parent_id) return false
      id = task.parent_id
    }
    return false
  }
  const ancestor = (parent: string, child: string, map = remainingById) => {
    const seen = new Set<string>()
    while (!seen.has(child)) {
      seen.add(child)
      const next = map.get(child)?.parent_id
      if (!next) return false
      if (next === parent) return true
      child = next
    }
    return false
  }
  const originalDeps = dependencies.filter(d => byId.has(d.from_task_id) && byId.has(d.to_task_id))
  const retainedDeps = originalDeps.filter(d => !deletedIds.has(d.from_task_id) && !deletedIds.has(d.to_task_id))
  type Edge = Pick<Dependency, 'from_task_id' | 'to_task_id' | 'type' | 'lag' | 'active'>
  const edgeKey = (d: Edge) => `${d.from_task_id}/${d.to_task_id}/${d.type}/${d.active !== false}`
  const graph = new Map<string, Edge>(originalDeps.map(d => [edgeKey(d), d]))
  for (const id of [...deletedIds].sort()) {
    const incoming = [...graph.values()].filter(d => d.to_task_id === id && d.from_task_id !== id)
    const outgoing = [...graph.values()].filter(d => d.from_task_id === id && d.to_task_id !== id)
    for (const [key, edge] of graph) if (edge.from_task_id === id || edge.to_task_id === id) graph.delete(key)
    for (const before of incoming) for (const after of outgoing) {
      if (before.from_task_id === after.to_task_id) continue
      const lag = (before.lag ?? 0) + (after.lag ?? 0)
      if (!Number.isSafeInteger(lag) || lag < -2147483648 || lag > 2147483647) throw new Error('删除后的依赖间隔超出可保存范围')
      const edge: Edge = {
        from_task_id: before.from_task_id, to_task_id: after.to_task_id,
        type: (before.type & 2) | (after.type & 1), lag,
        active: before.active !== false && after.active !== false && !inactive(id),
      }
      const previous = graph.get(edgeKey(edge))
      if (!previous || edge.lag > previous.lag) graph.set(edgeKey(edge), edge)
    }
  }
  // The database permits one relation per endpoint pair. Existing direct relations take priority.
  const pairs = new Set(retainedDeps.map(d => `${d.from_task_id}/${d.to_task_id}`))
  const candidates = new Map<string, Edge>()
  const strength = (edge: Edge) => {
    const duration = (id: string) => {
      const t = remainingById.get(id)
      return t?.start_date && t.end_date ? Math.max(0, diffMinutesStr(t.start_date, t.end_date)) : t?.duration ?? 0
    }
    return (edge.type & 2 ? duration(edge.from_task_id) : 0) + edge.lag - (edge.type & 1 ? duration(edge.to_task_id) : 0)
  }
  for (const edge of graph.values()) {
    const key = `${edge.from_task_id}/${edge.to_task_id}`
    if (pairs.has(key) || !remainingById.has(edge.from_task_id) || !remainingById.has(edge.to_task_id)) continue
    if (summaries.has(edge.from_task_id) || summaries.has(edge.to_task_id)
      || ancestor(edge.from_task_id, edge.to_task_id) || ancestor(edge.to_task_id, edge.from_task_id)) continue
    const previous = candidates.get(key)
    if (!previous || (edge.active !== false && previous.active === false)
      || (edge.active !== false) === (previous.active !== false) && strength(edge) > strength(previous)) candidates.set(key, edge)
  }
  let sequence = 0
  const operationId = options.operationId ?? uuid()
  const newDependencies: Dependency[] = []
  for (const [key, edge] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    if (wouldCreateCycle(edge.from_task_id, edge.to_task_id, [...retainedDeps, ...newDependencies])) continue
    const source = remainingById.get(edge.from_task_id)!
    newDependencies.push({ ...edge, project_id: source.project_id,
      id: `${operationId.slice(0, 24)}${(++sequence).toString(16).padStart(12, '0')}` })
    pairs.add(key)
  }
  const finalDeps = [...retainedDeps, ...newDependencies]
  const effective = (d: Dependency, map: Map<string, Task>) => d.active !== false
    && !inactive(d.from_task_id, map) && !inactive(d.to_task_id, map)
    && !ancestor(d.from_task_id, d.to_task_id, map) && !ancestor(d.to_task_id, d.from_task_id, map)
  const lostIncoming = new Set(originalDeps.filter(d => deletedIds.has(d.from_task_id) && !deletedIds.has(d.to_task_id)
    && effective(d, byId)).map(d => d.to_task_id))
  const hasIncoming = new Set(finalDeps.filter(d => effective(d, remainingById)).map(d => d.to_task_id))
  const anchor = toDateTimeStr(options.deletionDate ?? deletionAnchor(options.isMinute))
  if (!anchor) throw new Error('无效的删除日期')
  const affected = new Set<string>(lostIncoming)
  for (const task of remainingTasks) if (task.parent_id !== byId.get(task.id)?.parent_id) affected.add(task.id)
  for (const id of deletedIds) {
    let parent = byId.get(id)?.parent_id
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      if (!deletedIds.has(parent)) affected.add(parent)
      parent = byId.get(parent)?.parent_id
    }
  }
  const queue = [...affected]
  while (queue.length) {
    const id = queue.shift()!
    const next = [remainingById.get(id)?.parent_id, ...finalDeps.filter(d => d.from_task_id === id && effective(d, remainingById)).map(d => d.to_task_id)]
    for (const target of next) if (target && !affected.has(target)) { affected.add(target); queue.push(target) }
  }
  const anchored = remainingTasks.map(task => {
    if (!lostIncoming.has(task.id) || hasIncoming.has(task.id) || summaries.has(task.id) || inactive(task.id, remainingById)) return task
    const duration = task.is_milestone ? 0 : task.start_date && task.end_date
      ? Math.max(0, diffMinutesStr(task.start_date, task.end_date)) : Math.max(0, task.duration ?? 0)
    return { ...task, start_date: anchor, end_date: addMinutesStr(anchor, duration), duration }
  })
  // Freeze unrelated leaves while recomputing the affected successors and summaries.
  const cascade = runFullCascade(anchored.map(t => affected.has(t.id) ? t : { ...t, auto_schedule: false }), finalDeps, options)
  const updates = new Map(cascade.filter(t => affected.has(t.id)).map(t => [t.id, t]))
  const finalTasks = anchored.map(t => updates.get(t.id) ?? t)
  return { tasks: finalTasks, dependencies: finalDeps, deletedIds, newDependencies,
    updatedTasks: finalTasks.filter(t => t !== byId.get(t.id)) }
}
