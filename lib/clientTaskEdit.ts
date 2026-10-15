import type { Dependency, Task } from '@/types'
import { MIN_PER_DAY, MIN_PER_HOUR, SNAP_INTERVAL, addMinutesStr, diffMinutesStr, toDateTimeStr } from './clientTime'

export function normalizeScheduleDate(date: string | null | undefined, isMinute: boolean): string | null {
  return toDateTimeStr(isMinute ? date : date?.slice(0, 10))
}

export function scheduleDurationMinutes(startDate: string | null, endDate: string | null, isMinute: boolean): number | null {
  const start = normalizeScheduleDate(startDate, isMinute)
  const end = normalizeScheduleDate(endDate, isMinute)
  if (!start || !end) return null
  // Day inputs represent calendar dates, independent of UTC offsets or DST.
  return isMinute ? diffMinutesStr(start, end)
    : (Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${start.slice(0, 10)}T00:00:00Z`)) / 60_000
}

export function defaultTaskSchedule(startDate: string | null, isMinute: boolean, isMilestone = false): Pick<Task, 'start_date' | 'end_date' | 'duration'> {
  const start = normalizeScheduleDate(startDate, isMinute)
  const duration = isMilestone ? 0 : isMinute ? MIN_PER_HOUR : MIN_PER_DAY
  return { start_date: start, end_date: addMinutesStr(start, duration), duration }
}

/** Clamp the resized edge and duration together so the stored span stays consistent. */
export function resizeTaskSchedule(task: Task, edge: 'start' | 'end', value: string, isMinute: boolean): Task {
  let start = normalizeScheduleDate(edge === 'start' ? value : task.start_date, isMinute)
  let end = normalizeScheduleDate(edge === 'end' ? value : task.end_date, isMinute)
  const span = scheduleDurationMinutes(start, end, isMinute)
  if (span == null) return task
  const minimum = task.is_milestone ? 0 : isMinute ? SNAP_INTERVAL : MIN_PER_DAY
  const duration = task.is_milestone ? 0 : Math.max(minimum, span)
  if (duration !== span) {
    if (edge === 'start') start = addMinutesStr(end, -duration)
    else end = addMinutesStr(start, duration)
  }
  return { ...task, start_date: start, end_date: end, duration }
}

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
  const normalizeDate = (date: string | null) => normalizeScheduleDate(date, isMinute)

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
  const duration = scheduleDurationMinutes(start, end, isMinute) ?? task.duration
  return { [field]: date, duration: duration != null && duration > 0 ? duration : task.duration }
}
