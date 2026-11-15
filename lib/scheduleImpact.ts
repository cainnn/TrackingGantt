import type { Task, Dependency } from '../types'
import type { DraftSnapshot } from '../store/draftHistory'
import { buildSaveDiff } from './clientSave'
import { toDateTimeStr } from './clientTime'
import { activeScheduleTasks, scheduleMinute } from './scheduleAnalysis'
import { baselinesEqual } from './planBaseline'
import { customFieldsEqual, customValuesEqual } from './taskCustomFields'

export type ImpactCategory = 'direct' | 'cascade' | 'summary' | 'manual' | 'other'
export interface TaskImpact {
  id: string
  name: string
  kind: 'added' | 'deleted' | 'changed'
  category: ImpactCategory
  before?: Task
  after?: Task
  fields: string[]
  startDelta: number | null
  finishDelta: number | null
  durationDelta: number | null
  reason: string
  relatedIds: string[]
}
export interface DependencyImpact { id: string; before?: Dependency; after?: Dependency; fromName: string; toName: string }
export interface ScheduleImpact { tasks: TaskImpact[]; dependencies: DependencyImpact[]; projectChanges: string[] }
export const dependencyTypeName = (type: number) => ({ 0: 'SS', 1: 'SF', 2: 'FS', 3: 'FF' }[type] ?? 'FS')
const dates = new Set(['start_date', 'end_date', 'constraint_date', 'deadline', 'baseline_end_date'])
const fieldNames: Partial<Record<keyof Task, string>> = {
  name: '名称', assignee: '责任人', start_date: '开始', end_date: '完成', duration: '工期',
  parent_id: '层级', order_index: '顺序', auto_schedule: '排程模式', constraint_type: '限制类型', constraint_date: '限制日期',
  deadline: '截止日期', inactive: '停用状态', is_milestone: '里程碑', note: '备注', rollup: '汇总显示',
  project_boundary: '项目边界', percent_done: '完成度', duration_unit: '工期单位', task_code: '编号', status: '状态', baseline_end_date: '上期完成日期',
}
function changedFields(before: Task, after: Task) {
  const fields = (Object.keys(fieldNames) as (keyof Task)[]).filter(key => dates.has(key)
    ? toDateTimeStr(before[key] as string | null) !== toDateTimeStr(after[key] as string | null)
    : (before[key] ?? null) !== (after[key] ?? null)).map(key => fieldNames[key]!)
  if (!customFieldsEqual(before.custom_fields, after.custom_fields) || !customValuesEqual(before.custom_values, after.custom_values)) fields.push('自定义属性')
  return fields
}
function dateDelta(before?: string | null, after?: string | null) {
  const a = scheduleMinute(before), b = scheduleMinute(after)
  return a == null || b == null ? null : b - a
}
function sameDates(a?: Task, b?: Task) {
  return a && b && toDateTimeStr(a.start_date) === toDateTimeStr(b.start_date) && toDateTimeStr(a.end_date) === toDateTimeStr(b.end_date)
}

/** Read-only explanation of actual draft results, never a second scheduler.
 * Direct edits come from the user event; a graph path alone is insufficient to
 * claim a particular predecessor caused a date. Only tight bounds name drivers. */
export function buildScheduleImpact(before: DraftSnapshot, after: DraftSnapshot, options: { label: string; directTaskIds?: string[]; cumulative?: boolean }): ScheduleImpact {
  const old = new Map(before.tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const now = new Map(after.tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const all = new Map([...old, ...now])
  const diff = buildSaveDiff(before.tasks, before.dependencies, after.tasks, after.dependencies)
  const oldDeps = new Map(before.dependencies.map(d => [d.id, d])), newDeps = new Map(after.dependencies.map(d => [d.id, d]))
  // Save requests omit links implicitly removed with deleted tasks. Preview must
  // still show those links (including unchanged manual successors).
  const removedDepIds = [...oldDeps.keys()].filter(id => !newDeps.has(id))
  const dependencies = [...diff.depsToAdd, ...diff.depsToUpdate].map(d => d.id).concat(removedDepIds).map(id => {
    const a = oldDeps.get(id), b = newDeps.get(id), dep = b ?? a!
    return { id, before: a, after: b, fromName: all.get(dep.from_task_id)?.name ?? '已移除任务', toName: all.get(dep.to_task_id)?.name ?? '已移除任务' }
  })
  const deleted = new Set(diff.tasksToDelete), added = new Set(diff.tasksToAdd.map(t => t.id))
  const depTargets = new Set(dependencies.flatMap(d => [d.before?.to_task_id, d.after?.to_task_id].filter((id): id is string => !!id && now.has(id))))
  const ids = new Set([...diff.tasksToUpdate.map(t => t.id), ...added, ...deleted, ...depTargets])
  const direct = new Set([...(options.directTaskIds ?? []).filter(id => ids.has(id)), ...added, ...deleted])
  // Link changes caused by deletion/reconnection belong to its cascade.
  if (!deleted.size) depTargets.forEach(id => direct.add(id))
  const active = new Set(activeScheduleTasks(after.tasks).map(t => t.id))
  const summaries = new Set([...now.values()].map(t => t.parent_id).filter((id): id is string => !!id))
  const outgoing = new Map<string, Set<string>>(), incoming = new Map<string, Dependency[]>(), removedIncoming = new Map<string, Dependency[]>()
  const previouslyActive = new Set(activeScheduleTasks(before.tasks).map(t => t.id))
  for (const dep of before.dependencies) {
    if (dep.active === false || !deleted.has(dep.from_task_id) || !previouslyActive.has(dep.from_task_id)) continue
    const list = removedIncoming.get(dep.to_task_id) ?? []; list.push(dep); removedIncoming.set(dep.to_task_id, list)
  }
  const addEdge = (from: string, to: string) => {
    const children = outgoing.get(from) ?? new Set<string>(); children.add(to); outgoing.set(from, children)
  }
  for (const dep of [...before.dependencies, ...after.dependencies]) {
    if (dep.active === false || !active.has(dep.from_task_id) && !previouslyActive.has(dep.from_task_id)) continue
    const target = now.get(dep.to_task_id)
    if (target && active.has(target.id) && (target.auto_schedule !== false || summaries.has(target.id) || !sameDates(old.get(target.id), target))) addEdge(dep.from_task_id, target.id)
  }
  for (const task of all.values()) if (task.parent_id && now.has(task.parent_id)) addEdge(task.id, task.parent_id)
  for (const dep of after.dependencies) {
    if (dep.active === false || !active.has(dep.from_task_id) || !active.has(dep.to_task_id)) continue
    const list = incoming.get(dep.to_task_id) ?? []; list.push(dep); incoming.set(dep.to_task_id, list)
  }
  const reachable = new Set(direct), queue = [...direct]
  for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i]) ?? []) if (!reachable.has(id)) { reachable.add(id); queue.push(id) }
  const tasks: TaskImpact[] = []
  for (const id of ids) {
    const a = old.get(id), b = now.get(id), task = b ?? a
    if (!task) continue
    const kind = !a ? 'added' : !b ? 'deleted' : 'changed'
    const fields = a && b ? changedFields(a, b) : [kind === 'added' ? '新增任务' : '删除任务']
    if (depTargets.has(id)) fields.push('前置依赖')
    const startDelta = dateDelta(a?.start_date, b?.start_date), finishDelta = dateDelta(a?.end_date, b?.end_date)
    const durationDelta = a?.duration == null || b?.duration == null ? null : b.duration - a.duration
    const datesChanged = !!a && !!b && !sameDates(a, b)
    const category: ImpactCategory = b?.auto_schedule === false && !datesChanged && depTargets.has(id) && kind === 'changed' ? 'manual'
      : direct.has(id) ? 'direct'
      : summaries.has(id) && datesChanged && reachable.has(id) ? 'summary'
      : b?.auto_schedule !== false && datesChanged && active.has(id) && reachable.has(id) ? 'cascade' : 'other'
    const drivers = (incoming.get(id) ?? []).filter(dep => {
      if (!b || b.auto_schedule === false || summaries.has(id)) return false
      const source = now.get(dep.from_task_id)
      const from = scheduleMinute((dep.type & 2) ? source?.end_date : source?.start_date)
      const to = scheduleMinute((dep.type & 1) ? b.end_date : b.start_date)
      return from != null && to != null && Math.abs(to - from - (dep.lag ?? 0)) < 1
    })
    const driverNames = drivers.slice(0, 3).map(dep => `「${now.get(dep.from_task_id)!.name}」（${dependencyTypeName(dep.type)}）`).join('、')
    const removedPredecessors = removedIncoming.get(id) ?? []
    let reason: string
    if (kind === 'deleted') reason = '本次操作删除了此任务；保存前可整步撤销。'
    else if (kind === 'added') reason = '本次操作新增或复制了此任务。'
    else if (category === 'manual') reason = '前置关系发生变化；此任务为手动排程，起止日期保持不变。'
    else if (category === 'summary') reason = '子任务发生变化，摘要任务的起止日期随之汇总更新。'
    else if (category === 'direct') reason = options.cumulative ? '累计期间直接操作过此任务；此处显示相对上次保存的净变化。' : `直接操作：${options.label}。`
    else if (b?.auto_schedule === false && datesChanged && removedPredecessors.length && !incoming.has(id)) reason = '删除最后一个有效前置后，按现有删除规则重设日期；此任务仍为手动排程。'
    else if (category === 'cascade' && removedPredecessors.length) reason = `删除前置${removedPredecessors.slice(0, 3).map(d => `「${old.get(d.from_task_id)?.name}」`).join('、')}后重新排程。`
    else if (category === 'cascade' && drivers.some(d => !sameDates(old.get(d.from_task_id), now.get(d.from_task_id)))) reason = `随前置${driverNames}调整。`
    else if (category === 'cascade' && depTargets.has(id)) reason = '入依赖发生变化后自动重新排程。'
    else if (category === 'cascade') reason = '本次操作触发相关任务链重新排程；未确定单一前置来源。'
    else reason = '随本次操作发生变化；未确定是直接编辑还是自动调整。'
    if (driverNames && (datesChanged || depTargets.has(id)) && !reason.startsWith('随前置')) reason += `当前由${driverNames}${drivers.length > 3 ? '等任务' : ''}约束。`
    if (category === 'direct' && b?.auto_schedule === false && datesChanged) reason += '日期由直接操作改变，当前为手动排程。'
    tasks.push({ id, name: task.name, kind, category, before: a, after: b, fields, startDelta, finishDelta, durationDelta, reason, relatedIds: drivers.map(d => d.from_task_id) })
  }
  const order = new Map([...old.keys(), ...now.keys()].map((id, index) => [id, index]))
  tasks.sort((a, b) => (a.category === 'direct' ? 0 : 1) - (b.category === 'direct' ? 0 : 1) || order.get(a.id)! - order.get(b.id)!)
  const projectChanges: string[] = []
  if (toDateTimeStr(before.statusDate) !== toDateTimeStr(after.statusDate)) projectChanges.push('状态日期')
  if ((before.planningStatus ?? 'draft') !== (after.planningStatus ?? 'draft')) projectChanges.push('计划状态')
  if (!baselinesEqual(before.planBaseline, after.planBaseline)) projectChanges.push('固定基线')
  if (!customFieldsEqual(before.customFields, after.customFields)) projectChanges.push('项目自定义字段')
  if (JSON.stringify(before.lines) !== JSON.stringify(after.lines)) projectChanges.push('项目标记线')
  return { tasks, dependencies, projectChanges }
}
