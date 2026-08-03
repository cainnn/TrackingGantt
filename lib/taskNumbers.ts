/**
 * Database task durations are stored as integer minutes. Older/stale clients
 * can still submit a fractional day value, so prefer the task date range when
 * repairing it instead of rounding the day value to only a few minutes.
 */
export function normalizeDurationMinutes(
  duration: unknown,
  startDate?: string | Date | null,
  endDate?: string | Date | null,
): number | null {
  if (duration == null) return null
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    throw new Error('工期必须是有限数字')
  }
  if (Number.isInteger(duration)) return duration

  if (startDate && endDate) {
    const start = new Date(startDate)
    const end = new Date(endDate)
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
    }
  }

  return Math.round(duration)
}
