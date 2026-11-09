import { parseLocal, toDateTimeStr } from './clientTime'

export function earliestTaskStart(tasks: ReadonlyArray<{ start_date: string | null; is_deleted?: boolean }>): string | null {
  let first: string | null = null
  for (const task of tasks) {
    if (task.is_deleted) continue
    const value = toDateTimeStr(task.start_date)
    const date = parseLocal(value)
    if (!value || !date || !Number.isFinite(date.getTime()) || toDateTimeStr(date) !== value) continue
    if (first === null || value < first) first = value
  }
  return first
}
