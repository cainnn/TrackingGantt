const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

function formatPartsInTimeZone(now: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const year = parts.find(p => p.type === 'year')?.value
  const month = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value
  const hour = parts.find(p => p.type === 'hour')?.value
  const minute = parts.find(p => p.type === 'minute')?.value
  if (!year || !month || !day || !hour || !minute) {
    throw new Error(`Cannot format date for time zone: ${timeZone}`)
  }
  return { year, month, day, hour, minute }
}

function formatYmdInTimeZone(now: Date, timeZone: string): string {
  const p = formatPartsInTimeZone(now, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

function formatYmdHmInTimeZone(now: Date, timeZone: string): string {
  const p = formatPartsInTimeZone(now, timeZone)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

export function getAppTimeZone(): string {
  return process.env.APP_TIME_ZONE || DEFAULT_TIME_ZONE
}

export function getTodayYmd(now: Date = new Date(), timeZone: string = getAppTimeZone()): string {
  try {
    return formatYmdInTimeZone(now, timeZone)
  } catch {
    return formatYmdInTimeZone(now, DEFAULT_TIME_ZONE)
  }
}

export function getNowYmdHm(now: Date = new Date(), timeZone: string = getAppTimeZone()): string {
  try {
    return formatYmdHmInTimeZone(now, timeZone)
  } catch {
    return formatYmdHmInTimeZone(now, DEFAULT_TIME_ZONE)
  }
}

export function getStatusDateYmd(statusDate: string): string | null {
  const match = statusDate.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/)
  return match ? match[1] : null
}

export function isStatusDateAfterToday(statusDate: string, today: string): boolean {
  const statusYmd = getStatusDateYmd(statusDate)
  return statusYmd != null && statusYmd > today
}

export function getStatusDateYmdHm(statusDate: string): string | null {
  const s = statusDate.trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return null
  return `${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}`
}

export function isStatusDateAfterNow(statusDate: string, nowYmdHm: string): boolean {
  const statusYmdHm = getStatusDateYmdHm(statusDate)
  return statusYmdHm != null && statusYmdHm > nowYmdHm
}
