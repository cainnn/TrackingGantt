import type { Task } from '@/types'

function sod(d: Date): Date { const r = new Date(d); r.setHours(0, 0, 0, 0); return r }

/** 计算单个任务基于状态日期的完成比例（0~1 精确小数，不取整） */
function timeBasedRatio(task: Task, sd: Date | null): number {
  if (!sd || !task.start_date || !task.end_date) return (task.percent_done ?? 0) / 100
  const start = sod(new Date(task.start_date))
  const end   = sod(new Date(task.end_date))
  const s     = sod(sd)
  if (s >= end)   return 1
  if (s <= start) return 0
  return (s.getTime() - start.getTime()) / (end.getTime() - start.getTime())
}

/** 计算单个任务基于状态日期的完成百分比 (0-100 整数) */
export function computeTimeBasedPercent(task: Task, statusDate?: string | null): number {
  const sd = statusDate ? sod(new Date(statusDate)) : null
  return Math.round(timeBasedRatio(task, sd) * 100)
}

/** SUM(工期×完成比例) / SUM(工期)，仅统计叶子任务，与后端 SQL 保持一致 */
export function computeProjectProgressPercent(tasks: Task[], statusDate?: string | null): number {
  if (tasks.length === 0) return 0
  const sd = statusDate ? sod(new Date(statusDate)) : null
  const parentIds = new Set<string>()
  for (const t of tasks) { if (t.parent_id) parentIds.add(t.parent_id) }
  let totalWorkDays = 0
  let completedWorkDays = 0
  for (const t of tasks) {
    if (parentIds.has(t.id)) continue
    if (!t.start_date || !t.end_date || t.duration == null) continue
    totalWorkDays += t.duration
    completedWorkDays += t.duration * timeBasedRatio(t, sd)
  }
  return totalWorkDays > 0 ? Math.round((completedWorkDays / totalWorkDays) * 100) : 0
}
