import type { Dependency, Task } from '@/types'
import { MIN_PER_DAY, addMinutesStr, diffMinutesStr, toDateTimeStr } from './clientTime'

export function durationInputValue(duration: number | null, isMinute: boolean): string {
  if (duration == null) return ''
  return String(isMinute ? duration : Math.round(duration / MIN_PER_DAY))
}

/** Inline schedule inputs use project units; task durations always store minutes. */
export function buildTaskScheduleEdit(
  task: Task,
  deps: Dependency[],
  field: 'duration' | 'start_date' | 'end_date',
  value: string,
  isMinute: boolean,
): Partial<Task> {
  const depType = deps.find(d => d.to_task_id === task.id)?.type ?? -1
  const anchoredToEnd = task.auto_schedule !== false && (depType === 3 || depType === 1)
  const normalizeDate = (date: string | null): string | null =>
    toDateTimeStr(isMinute ? date : date?.slice(0, 10))

  if (field === 'duration') {
    const input = Number(value)
    if (!Number.isFinite(input) || Math.round(input) <= 0) return {}
    const duration = Math.round(input) * (isMinute ? 1 : MIN_PER_DAY)
    if (!Number.isSafeInteger(duration)) return {}
    const anchor = normalizeDate(anchoredToEnd ? task.end_date : task.start_date)
    if (!anchor) return {}
    const date = addMinutesStr(anchor, anchoredToEnd ? -duration : duration)
    if (!date) return {}
    return anchoredToEnd ? { duration, start_date: date } : { duration, end_date: date }
  }

  if (field === 'start_date' && task.auto_schedule !== false && !anchoredToEnd) return {}
  const date = normalizeDate(value)
  if (!date) return {}
  const start = field === 'start_date' ? date : normalizeDate(task.start_date)
  const end = field === 'end_date' ? date : normalizeDate(task.end_date)
  // Day inputs represent calendar dates, independent of local UTC offsets or DST.
  const duration = start && end
    ? (isMinute
        ? diffMinutesStr(start, end)
        : (Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${start.slice(0, 10)}T00:00:00Z`)) / 60_000)
    : task.duration
  return { [field]: date, duration: duration != null && duration > 0 ? duration : task.duration }
}
