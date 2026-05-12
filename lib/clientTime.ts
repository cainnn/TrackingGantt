/**
 * 分钟级时间原语：所有任务/项目时间统一为 'YYYY-MM-DDTHH:mm:00' 字符串，视为本地时间。
 * 兼容输入：Date、'YYYY-MM-DD'、'YYYY-MM-DD HH:mm[:ss]'、'YYYY-MM-DDTHH:mm:ss'、带 Z 的 UTC ISO。
 */

export const MIN_PER_HOUR = 60
export const MIN_PER_DAY = 1440
export const SNAP_INTERVAL = 15

const pad = (n: number) => String(n).padStart(2, '0')

function fromDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

export function toDateTimeStr(v: string | Date | null | undefined): string | null {
  if (v == null) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : fromDate(v)
  const s = String(v).trim()
  if (!s) return null
  if (/Z$/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : fromDate(d)
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`
  const md = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (md) return `${md[1]}-${md[2]}-${md[3]}T00:00:00`
  return null
}

export function parseLocal(s: string | Date | null | undefined): Date | null {
  if (s == null) return null
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s
  const str = toDateTimeStr(s)
  if (!str) return null
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

export function addMinutesStr(s: string | null | undefined, minutes: number): string | null {
  const d = parseLocal(s)
  if (!d) return null
  d.setMinutes(d.getMinutes() + minutes)
  return fromDate(d)
}

export function diffMinutesStr(a: string | null | undefined, b: string | null | undefined): number {
  const da = parseLocal(a)
  const db = parseLocal(b)
  if (!da || !db) return 0
  return Math.round((db.getTime() - da.getTime()) / 60_000)
}

export function snapMinutes(minutes: number, step: number = SNAP_INTERVAL): number {
  return Math.round(minutes / step) * step
}

export function snapDateTime(s: string | null | undefined, step: number = SNAP_INTERVAL): string | null {
  const d = parseLocal(s)
  if (!d) return null
  const stepMs = step * 60_000
  return fromDate(new Date(Math.round(d.getTime() / stepMs) * stepMs))
}

export function startOfDay(s: string | null | undefined): string | null {
  const d = parseLocal(s)
  if (!d) return null
  d.setHours(0, 0, 0, 0)
  return fromDate(d)
}

export function toDateOnly(s: string | null | undefined): string | null {
  const str = toDateTimeStr(s)
  return str ? str.slice(0, 10) : null
}

export function formatYmdHm(s: string | null | undefined): string {
  const str = toDateTimeStr(s)
  return str ? `${str.slice(0, 10)} ${str.slice(11, 16)}` : ''
}

export function formatHm(s: string | null | undefined): string {
  const str = toDateTimeStr(s)
  return str ? str.slice(11, 16) : ''
}
