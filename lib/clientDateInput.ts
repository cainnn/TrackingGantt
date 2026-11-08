/** Unambiguous year-first dates from typed input and Excel plain-text cells. */
export function parseDateInput(input: string, includeTime = false, referenceYear = new Date().getFullYear()): string | null {
  const text = input.normalize('NFKC').trim().replace(/^'/, '')
  if (!text) return null
  const match = text.match(/^(\d{4}|\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/)
    ?? text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (match) {
    const [, y, m, d, h = '0', min = '0', sec = '0'] = match
    let year = +y
    if (y.length === 2) {
      year += Math.floor(referenceYear / 100) * 100
      if (year - referenceYear > 50) year -= 100
      else if (referenceYear - year >= 50) year += 100
    }
    const date = new Date(0); date.setUTCFullYear(year, +m - 1, +d); date.setUTCHours(0, 0, 0, 0)
    if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d || +h > 23 || +min > 59 || +sec > 59) return null
    const day = `${String(year).padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    return includeTime ? `${day}T${h.padStart(2, '0')}:${min.padStart(2, '0')}` : day
  }
  // Excel's 1900 date system: serial 60 is the fictitious 1900-02-29.
  if (/^\d{1,7}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text), whole = Math.floor(serial)
    if (serial < 1 || serial >= 2958466 || whole === 60) return null
    const base = Date.UTC(1899, 11, whole < 60 ? 31 : 30)
    const minutes = includeTime ? Math.round(serial * 1440) : whole * 1440
    const date = new Date(base + minutes * 60000)
    if (date.getUTCFullYear() > 9999) return null
    return date.toISOString().slice(0, includeTime ? 16 : 10)
  }
  return null
}

export function formatDateDisplay(value: string | null | undefined, includeTime = false): string {
  if (!value) return ''
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value.replace('T', ' ')
  return value.slice(2, 10) + (includeTime ? ` ${value.slice(11, 16) || '00:00'}` : '')
}
