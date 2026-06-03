const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

function formatYmdInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const year = parts.find(p => p.type === 'year')?.value
  const month = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value
  if (!year || !month || !day) {
    throw new Error(`Cannot format date for time zone: ${timeZone}`)
  }
  return `${year}-${month}-${day}`
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

export function getStatusDateYmd(statusDate: string): string | null {
  const match = statusDate.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/)
  return match ? match[1] : null
}

export function isStatusDateAfterToday(statusDate: string, today: string): boolean {
  const statusYmd = getStatusDateYmd(statusDate)
  return statusYmd != null && statusYmd > today
}
