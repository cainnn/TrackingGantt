export type TaskDateField = 'start' | 'end' | 'either'
export type TaskDateFilter = { kind: 'week' } | {
  kind: 'custom'
  field: TaskDateField
  from: string
  to: string
}
export interface TaskDateRange {
  field: TaskDateField
  from: string
  to: string
}

export const TASK_DATE_FIELD_LABELS: Record<TaskDateField, string> = {
  start: '开始日期', end: '结束日期', either: '开始或结束日期',
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// undefined denotes an invalid preference; null also supports layouts saved before this filter existed.
export function normalizeTaskDateFilter(value: unknown): TaskDateFilter | null | undefined {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const filter = value as Record<string, unknown>
  if (filter.kind === 'week') return { kind: 'week' }
  if (filter.kind !== 'custom' || !['start', 'end', 'either'].includes(filter.field as string)
    || !isCalendarDate(filter.from) || !isCalendarDate(filter.to) || filter.from > filter.to) return undefined
  return { kind: 'custom', field: filter.field as TaskDateField, from: filter.from, to: filter.to }
}

export function resolveTaskDateFilter(filter: TaskDateFilter | null, today: string): TaskDateRange | null {
  if (!filter) return null
  if (filter.kind === 'custom') return { field: filter.field, from: filter.from, to: filter.to }
  // Calendar arithmetic avoids daylight-saving offsets. Today is supplied by the app's date policy.
  const end = new Date(`${today}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return { field: 'end', from: today, to: end.toISOString().slice(0, 10) }
}

export function taskMatchesDateRange(task: { start_date?: string | null; end_date?: string | null }, range: TaskDateRange): boolean {
  const within = (value: string | null | undefined) => {
    // Task dates are stored as wall-clock strings; do not shift them through the browser's timezone.
    const day = value?.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/)?.[1]
    return isCalendarDate(day) && day >= range.from && day <= range.to
  }
  return (range.field !== 'end' && within(task.start_date)) || (range.field !== 'start' && within(task.end_date))
}
