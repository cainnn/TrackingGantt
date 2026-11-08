export interface AttributeDateRange { from: string; to: string }

const iso = (date: Date) => date.toISOString().slice(0, 10)
const monthRange = (year: number, month: number, count = 1): AttributeDateRange => ({
  from: iso(new Date(Date.UTC(year, month, 1))),
  to: iso(new Date(Date.UTC(year, month + count, 0))),
})
function monthCount(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value.includes('十')) { const [tens, units] = value.split('十'); return (digits[tens] || 1) * 10 + (digits[units] || 0) }
  return digits[value] ?? 0
}

/** Calendar boundaries, independent of server time zone and model arithmetic.
 * 后/未来 N 个月 means N complete months starting next month unless the user
 * explicitly says 含本月 or 从今天起. Every answer prints its concrete bounds.
 */
export function resolveAttributeDateRange(text: string, today: string): AttributeDateRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1
  const compact = text.replace(/\s/g, '')
  const future = compact.match(/(?:后|未来|接下来|下)([一二两三四五六七八九十\d]+)个?(?:自然)?月/)
  if (future) {
    const count = monthCount(future[1])
    if (count < 1 || count > 120) return null
    if (/从今天|从今日|自今天/.test(compact)) {
      const end = new Date(Date.UTC(year, month + count, 1))
      const day = Math.min(Number(today.slice(8, 10)), new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate())
      end.setUTCDate(day - 1)
      return { from: today, to: iso(end) }
    }
    return monthRange(year, month + (/含本月|包含本月|从本月/.test(compact) ? 0 : 1), count)
  }
  const exact = compact.match(/(\d{4}-\d{2}-\d{2})(?:至|到|~|—)(\d{4}-\d{2}-\d{2})/)
  if (exact) return { from: exact[1], to: exact[2] }
  const expanded = compact.replace(/今年|本年/g, `${year}年`).replace(/明年/g, `${year + 1}年`).replace(/去年/g, `${year - 1}年`)
  const months = expanded.match(/(?:(\d{4})[年-])?(\d{1,2})月?(?:至|到|~|—)(?:(\d{4})[年-])?(\d{1,2})月?/)
  if (months) {
    const firstYear = Number(months[1] ?? year), firstMonth = Number(months[2]), lastMonth = Number(months[4])
    const lastYear = months[3] ? Number(months[3]) : firstYear + (lastMonth < firstMonth ? 1 : 0)
    if (firstMonth < 1 || firstMonth > 12 || lastMonth < 1 || lastMonth > 12) return null
    return { from: monthRange(firstYear, firstMonth - 1).from, to: monthRange(lastYear, lastMonth - 1).to }
  }
  const specific = compact.match(/(\d{4})年(\d{1,2})月/) ?? compact.match(/(\d{4})-(\d{2})(?![-\d])/)
  if (specific && Number(specific[2]) >= 1 && Number(specific[2]) <= 12) return monthRange(Number(specific[1]), Number(specific[2]) - 1)
  const relativeYear = /明年/.test(compact) ? year + 1 : /去年/.test(compact) ? year - 1 : year
  const yearMonth = compact.match(/(?:今年|明年|去年)(\d{1,2})月/)
  if (yearMonth && Number(yearMonth[1]) >= 1 && Number(yearMonth[1]) <= 12) return monthRange(relativeYear, Number(yearMonth[1]) - 1)
  if (/本月|这个月/.test(compact)) return monthRange(year, month)
  if (/下个?月/.test(compact)) return monthRange(year, month + 1)
  if (/上个?月/.test(compact)) return monthRange(year, month - 1)
  if (/今年|本年|明年|去年/.test(compact)) return monthRange(relativeYear, 0, 12)
  const specificYear = compact.match(/(\d{4})年/)
  if (specificYear) return monthRange(Number(specificYear[1]), 0, 12)
  return null
}
