import type { PlanBaseline, Task } from '../types'
import { toDateTimeStr } from './clientTime'
import { scheduleMinute } from './scheduleAnalysis'

export function makePlanBaseline(version: { id: string; name: string; created_at: string; snapshot: { tasks: Task[] } }, id: string, reason: string): PlanBaseline {
  return {
    id, sourceVersionId: version.id, sourceVersionName: version.name,
    // Version timestamps are database wall-clock strings. Do not reinterpret
    // them in the browser's zone (which may differ from the API server's zone).
    sourceCreatedAt: String(version.created_at).replace(' ', 'T'), reason: reason.trim(),
    tasks: version.snapshot.tasks.filter(t => !t.is_deleted).map(t => ({
      id: t.id, name: t.name, start_date: toDateTimeStr(t.start_date), end_date: toDateTimeStr(t.end_date),
      duration: t.duration == null ? null : Number(t.duration), is_milestone: !!t.is_milestone,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function baselinesEqual(a?: PlanBaseline | null, b?: PlanBaseline | null) {
  const normalize = (v?: PlanBaseline | null) => v ? {
    id: v.id, sourceVersionId: v.sourceVersionId, sourceVersionName: v.sourceVersionName,
    sourceCreatedAt: v.sourceCreatedAt, reason: v.reason,
    tasks: [...v.tasks].sort((x, y) => x.id.localeCompare(y.id)).map(t => [t.id, t.name, toDateTimeStr(t.start_date), toDateTimeStr(t.end_date), t.duration, t.is_milestone]),
  } : null
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

export function baselineVariance(task: Task, baseline?: PlanBaseline | null) {
  const original = baseline?.tasks.find(t => t.id === task.id)
  if (!original) return null
  const delta = (a: string | null, b: string | null) => {
    const x = scheduleMinute(a), y = scheduleMinute(b)
    return x == null || y == null ? null : x - y
  }
  return { start: delta(task.start_date, original.start_date), finish: delta(task.end_date, original.end_date),
    duration: task.duration == null || original.duration == null ? null : task.duration - original.duration }
}
