import type { Task, Dependency } from '../types'
import { addMinutesStr } from './clientTime'
import { runFullCascade } from './clientScheduling'

export function selectedTreeIds(tasks: Task[], selectedIds: string[]): Set<string> {
  const ids = new Set(selectedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const t of tasks) if (!t.is_deleted && t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) {
      ids.add(t.id); changed = true
    }
  }
  return ids
}
export interface BulkEdit {
  assignee?: string | null
  autoSchedule?: boolean
  shiftMinutes?: number
}
export function buildBulkEdit(tasks: Task[], deps: Dependency[], ids: string[], edit: BulkEdit, isMinute: boolean, anchor: string): Task[] {
  const selected = selectedTreeIds(tasks, ids)
  const summaries = new Set(tasks.filter(t => !t.is_deleted).map(t => t.parent_id))
  const shift = edit.shiftMinutes ?? 0
  if (!Number.isFinite(shift) || !Number.isInteger(shift) || (!isMinute && shift % 1440)) throw new Error('请输入有效的整数工期')
  const updates = new Map<string, Task>()
  for (const t of tasks) {
    if (!selected.has(t.id) || t.is_deleted) continue
    const updated = { ...t }
    if ('assignee' in edit) updated.assignee = edit.assignee ?? null
    if (!summaries.has(t.id)) {
      if (edit.autoSchedule !== undefined) updated.auto_schedule = edit.autoSchedule
      if (shift && t.start_date && t.end_date) {
        updated.start_date = addMinutesStr(t.start_date, shift)
        updated.end_date = addMinutesStr(t.end_date, shift)
        // Manual movement must survive the next automatic scheduling pass.
        updated.auto_schedule = false
      } else if (edit.autoSchedule && t.start_date && t.end_date
          && !deps.some(d => d.to_task_id === t.id && d.active !== false)
          && (!t.constraint_type || ['asap', 'none'].includes(t.constraint_type))) {
        const parentStart = tasks.find(p => p.id === t.parent_id)?.start_date
        updated.start_date = parentStart && parentStart > anchor ? parentStart : anchor
        updated.end_date = addMinutesStr(updated.start_date, t.duration ?? 0)
      }
    }
    if (JSON.stringify(updated) !== JSON.stringify(t)) updates.set(t.id, updated)
  }
  const next = tasks.map(t => updates.get(t.id) ?? t)
  for (const t of runFullCascade(next, deps, { isMinute })) updates.set(t.id, t)
  return [...updates.values()]
}
