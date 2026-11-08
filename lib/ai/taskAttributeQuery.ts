import type { Task, TaskCustomField, TaskCustomFieldType } from '../../types'
import { taskCustomFields, CUSTOM_FIELD_TYPES } from '../taskCustomFields'
import { resolveAttributeDateRange } from './attributeDateRange'

export interface AttributeQueryContext { text: string; previousQuery?: AttributeQuery; today?: string }

export interface AttributeCatalogEntry {
  name: string
  type: TaskCustomFieldType
  unit: string
  tasks: number
  filled: number
}
export interface AttributeQuery {
  attribute_name: string
  operation?: 'sum' | 'count' | 'list'
  group_by?: 'month' | 'year' | 'assignee' | 'none'
  date_field?: 'end_date' | 'start_date' | 'custom_date'
  date_attribute?: string
  from_date?: string
  to_date?: string
  attribute_type?: TaskCustomFieldType
  unit?: string
  task_name?: string
  assignee?: string
  value_equals?: string
  include_summary?: boolean
  include_inactive?: boolean
  include_archived?: boolean
}
export interface AttributeQueryReport {
  ok: true
  query: AttributeQuery
  attribute: AttributeCatalogEntry
  dateBasis: string
  scope: string
  total: string | null
  matchedTasks: number
  groups: { key: string; value: string; tasks: number }[]
  details: { taskId: string; taskCode: string; taskName: string; date: string | null; value: string }[]
  detailsTruncated: boolean
  skipped: { empty: number; invalid: number; missingDate: number; summary: number; inactive: number; archived: number }
  warnings: string[]
}
export type AttributeQueryResult = AttributeQueryReport | { ok: false; error: string; candidates?: AttributeCatalogEntry[]; kind?: 'ambiguous'; query?: AttributeQuery }
const nameKey = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()
const unitKey = (value: string) => value.normalize('NFKC').trim()

/** Task-owned definitions have different IDs even when they describe one metric. */
export function buildTaskAttributeCatalog(tasks: Task[], legacy: TaskCustomField[] = []): AttributeCatalogEntry[] {
  const entries = new Map<string, AttributeCatalogEntry>()
  for (const task of tasks) {
    if (task.is_deleted) continue
    for (const field of taskCustomFields(task, legacy)) {
      const key = JSON.stringify([nameKey(field.name), field.type, unitKey(field.unit ?? '')])
      const entry = entries.get(key) ?? { name: field.name, type: field.type, unit: field.unit ?? '', tasks: 0, filled: 0 }
      entry.tasks++
      if (String(task.custom_values?.[field.id] ?? '').trim()) entry.filled++
      entries.set(key, entry)
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.unit.localeCompare(b.unit))
}

/** Prevent property queries such as 本月支出 from being redirected into a progress report. */
export function isTaskAttributeQueryIntent(text: string, catalog: AttributeCatalogEntry[], followUp = false): boolean {
  if (/创建|新建|删除|改为|修改|设置为|移到|推迟|提前|create|delete|update/i.test(text)) return false
  const query = /统计|汇总|合计|总计|总共|多少|几台|求和|查询|查看|列出|提供|给我|按月|每月|各月|逐月|分月|按年|每年|(?:后|未来|接下来|下)[一二两三四五六七八九十\d]+个?月|sum|total|aggregate|count|monthly|how many|list/i.test(text)
  const metric = /自定义|属性|金额|台数|数量|费用|支出|成本|产量|几台|多少台/.test(text)
    || catalog.some(field => nameKey(text).includes(nameKey(field.name)))
  return query && metric || followUp && !/进展|周报|月报|工期|风险/.test(text)
    && /按|只看|明细|合计|总共|多少|属性|单位|本月|上月|下月|今年|明年|去年|(?:后|未来|接下来|下)[一二两三四五六七八九十\d]+个?月|\d+月/.test(text)
}

const SCALE = BigInt(100000000)
function decimal(value: string): bigint | null {
  const match = value.trim().match(/^(-?)(\d{1,18})(?:\.(\d{1,8}))?$/)
  if (!match) return null
  const amount = BigInt(match[2]) * SCALE + BigInt((match[3] ?? '').padEnd(8, '0'))
  return match[1] ? -amount : amount
}
function decimalText(value: bigint, money: boolean): string {
  const absolute = value < BigInt(0) ? -value : value
  const fraction = String(absolute % SCALE).padStart(8, '0').replace(/0+$/, '').padEnd(money ? 2 : 0, '0')
  return `${value < BigInt(0) ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`
}
function dateOnly(value: string | null | undefined): string | null {
  const day = value?.slice(0, 10)
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const parsed = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null
}
function sameField(field: TaskCustomField, metric: AttributeCatalogEntry) {
  return nameKey(field.name) === nameKey(metric.name) && field.type === metric.type && unitKey(field.unit ?? '') === unitKey(metric.unit)
}

export function queryTaskAttributes(tasks: Task[], input: unknown, legacy: TaskCustomField[] = [], context?: AttributeQueryContext): AttributeQueryResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '属性查询参数无效，请重新描述要查询的属性。' }
  const raw = Object.fromEntries(Object.entries(input).filter(([, value]) => value != null))
  const stringKeys = ['attribute_name', 'operation', 'group_by', 'date_field', 'date_attribute', 'from_date', 'to_date', 'attribute_type', 'unit', 'task_name', 'assignee', 'value_equals']
  if (stringKeys.some(key => raw[key] != null && (typeof raw[key] !== 'string' || (raw[key] as string).length > 4000))) return { ok: false, error: '属性名称、日期与筛选条件须为文本。' }
  if (['include_summary', 'include_inactive', 'include_archived'].some(key => raw[key] != null && typeof raw[key] !== 'boolean')) return { ok: false, error: '任务范围参数无效。' }
  const query: AttributeQuery = {
    ...(raw as unknown as AttributeQuery), attribute_name: String(raw.attribute_name ?? '').trim(),
    operation: (raw.operation ?? 'sum') as AttributeQuery['operation'],
    group_by: (raw.group_by ?? (raw.operation === 'list' ? 'none' : 'month')) as AttributeQuery['group_by'],
    date_field: (raw.date_field ?? 'end_date') as AttributeQuery['date_field'],
  }
  const chosenRange = context?.today ? resolveAttributeDateRange(context.text, context.today) : null
  if (chosenRange) { query.from_date = chosenRange.from; query.to_date = chosenRange.to }
  else if (context && /全部计划|全计划|不限日期|不限时间|不限制时间/.test(context.text)) { delete query.from_date; delete query.to_date }
  if (context) {
    const previous = context.previousQuery
    if (query.date_field === 'start_date' && !/开始日期|开始时间|开工日期/.test(context.text) && previous?.date_field !== 'start_date') query.date_field = 'end_date'
    if (query.date_field === 'custom_date' && !context.text.includes(query.date_attribute ?? '\u0000')
      && !(previous?.date_field === 'custom_date' && previous.date_attribute === query.date_attribute)) query.date_field = 'end_date'
    if (query.operation !== 'list' && /每月|按月|各月|逐月|(?:后|未来|接下来|下)[一二两三四五六七八九十\d]+个?月/.test(context.text)
      && !/只要总|只看总|总数即可|不用按月|不按月|不分月|合计即可|总计即可|按责任人|按负责人|按年|每年/.test(context.text)) query.group_by = 'month'
  }
  if (!['sum', 'count', 'list'].includes(query.operation!) || !['month', 'year', 'assignee', 'none'].includes(query.group_by!)
    || !['end_date', 'start_date', 'custom_date'].includes(query.date_field!)) return { ok: false, error: '不支持该统计方式，请使用求和、任务计数或明细查询。' }
  if ((query.from_date && dateOnly(query.from_date) !== query.from_date) || (query.to_date && dateOnly(query.to_date) !== query.to_date)
    || (query.from_date && query.to_date && query.from_date > query.to_date)) return { ok: false, error: '请提供有效的日期范围，开始日期不能晚于结束日期。' }
  const catalog = buildTaskAttributeCatalog(tasks, legacy)
  let candidates = catalog.filter(field => nameKey(field.name) === nameKey(query.attribute_name))
  if (candidates.length > 1 && context) {
    // The model may guess a unit even though the user never chose one. Enforce
    // disambiguation in code instead of trusting the prompt to prevent it.
    let remainingText = nameKey(context.text).split(nameKey(query.attribute_name)).join('')
    const mentionedUnits = new Set<string>()
    for (const unit of [...new Set(candidates.map(field => field.unit).filter(Boolean))].sort((a, b) => b.length - a.length)) {
      if (remainingText.includes(nameKey(unit))) { mentionedUnits.add(unitKey(unit)); remainingText = remainingText.split(nameKey(unit)).join('') }
    }
    if (/未设置单位|无单位/.test(remainingText)) mentionedUnits.add('')
    const previous = context.previousQuery && nameKey(context.previousQuery.attribute_name) === nameKey(query.attribute_name) ? context.previousQuery : undefined
    if (query.unit !== undefined && !(mentionedUnits.size === 1 && mentionedUnits.has(unitKey(query.unit)))
      && !(mentionedUnits.size === 0 && previous?.unit === query.unit)) delete query.unit
    const typeHints: Record<TaskCustomFieldType, RegExp> = {
      number: /数字类型|数字属性|数值类型|number/, money: /金额类型|金额属性|money/,
      text: /文本|text/, date: /日期类型|日期属性|date type/, select: /单选|select/,
    }
    if (query.attribute_type && !typeHints[query.attribute_type]?.test(remainingText) && previous?.attribute_type !== query.attribute_type) delete query.attribute_type
  }
  if (query.attribute_type) candidates = candidates.filter(field => field.type === query.attribute_type)
  if (query.unit !== undefined) candidates = candidates.filter(field => unitKey(field.unit) === unitKey(query.unit!))
  if (candidates.length !== 1) return {
    ok: false,
    error: candidates.length > 1 ? `「${query.attribute_name}」存在不同类型或单位，请指定要统计的类型和单位，不能直接相加。`
      : `未找到「${query.attribute_name || '指定属性'}」，请使用项目中实际配置的属性名称。`,
    candidates: candidates.length ? candidates : catalog.filter(field => !query.attribute_name || nameKey(field.name).includes(nameKey(query.attribute_name))).slice(0, 30),
    ...(candidates.length > 1 ? { kind: 'ambiguous' as const, query } : {}),
  }
  const attribute = candidates[0]
  if (query.operation === 'sum' && !['number', 'money', 'text'].includes(attribute.type)) return { ok: false, error: `「${attribute.name}」是${CUSTOM_FIELD_TYPES[attribute.type]}属性，不能求和；可以查询明细或统计任务数量。` }
  const dateBasis = query.date_field === 'custom_date' ? `自定义日期「${query.date_attribute ?? ''}」` : query.date_field === 'start_date' ? '任务开始日期' : '任务结束日期'
  if (query.date_field === 'custom_date' && !catalog.some(field => nameKey(field.name) === nameKey(query.date_attribute ?? '') && field.type === 'date')) {
    return { ok: false, error: '请指定项目中已配置的日期类型属性，不能把计划日期当成实际发生日期。', candidates: catalog.filter(field => field.type === 'date') }
  }
  const live = tasks.filter(task => !task.is_deleted)
  const summaries = new Set(live.map(task => task.parent_id))
  const byId = new Map(live.map(task => [task.id, task]))
  const isInactive = (task: Task) => {
    const seen = new Set<string>()
    let current: Task | undefined = task
    while (current && !seen.has(current.id)) {
      if (current.inactive) return true
      seen.add(current.id); current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return false
  }
  const report: AttributeQueryReport = {
    ok: true, query, attribute, dateBasis,
    scope: `${query.include_summary ? '包含摘要任务' : '仅叶子任务'}；${query.include_inactive ? '包含无效任务' : '排除无效任务'}；${query.include_archived ? '包含停用属性' : '排除停用属性'}`,
    total: null, matchedTasks: 0, groups: [], details: [], detailsTruncated: false,
    skipped: { empty: 0, invalid: 0, missingDate: 0, summary: 0, inactive: 0, archived: 0 }, warnings: [],
  }
  const groups = new Map<string, { amount: bigint; tasks: number }>()
  let sum = BigInt(0)
  const needsDate = ['month', 'year'].includes(query.group_by!) || !!query.from_date || !!query.to_date
  for (const task of live) {
    if (query.task_name && !nameKey(task.name).includes(nameKey(query.task_name))) continue
    if (query.assignee && !nameKey(task.assignee ?? '').includes(nameKey(query.assignee))) continue
    const fields = taskCustomFields(task, legacy)
    const matching = fields.filter(field => sameField(field, attribute))
    if (!matching.length) continue
    if (!query.include_summary && summaries.has(task.id)) { report.skipped.summary++; continue }
    if (!query.include_inactive && isInactive(task)) { report.skipped.inactive++; continue }
    const usable = matching.filter(field => query.include_archived || !field.archived)
    if (!usable.length) { report.skipped.archived++; continue }
    // Two active same-name definitions on a corrupt/legacy task are ambiguous.
    if (usable.length !== 1) { report.skipped.invalid++; continue }
    const value = String(task.custom_values?.[usable[0].id] ?? '').trim()
    if (!value) { report.skipped.empty++; continue }
    if (query.value_equals !== undefined && value !== query.value_equals.trim()) continue
    const amount = query.operation === 'sum' ? decimal(value) : BigInt(0)
    if (amount == null) { report.skipped.invalid++; continue }
    const dateField = query.date_field === 'custom_date' ? fields.find(field => field.type === 'date' && nameKey(field.name) === nameKey(query.date_attribute!) && (query.include_archived || !field.archived)) : null
    const day = dateOnly(query.date_field === 'custom_date' ? task.custom_values?.[dateField?.id ?? ''] : task[query.date_field! as 'start_date' | 'end_date'])
    if (needsDate && !day) { report.skipped.missingDate++; continue }
    if ((query.from_date && day! < query.from_date) || (query.to_date && day! > query.to_date)) continue
    const key = query.group_by === 'month' ? day!.slice(0, 7) : query.group_by === 'year' ? day!.slice(0, 4)
      : query.group_by === 'assignee' ? task.assignee?.trim() || '未分配' : '合计'
    const group = groups.get(key) ?? { amount: BigInt(0), tasks: 0 }
    group.amount += amount; group.tasks++; groups.set(key, group)
    sum += amount; report.matchedTasks++
    // Totals always use all tasks; only the inspectable detail list is bounded.
    if (report.details.length < 100) report.details.push({ taskId: task.id, taskCode: task.task_code, taskName: task.name, date: day, value })
  }
  if (query.operation !== 'list' && ['month', 'year'].includes(query.group_by!)) {
    const sorted = [...groups.keys()].sort()
    const first = query.from_date?.slice(0, query.group_by === 'month' ? 7 : 4) ?? sorted[0]
    const last = query.to_date?.slice(0, query.group_by === 'month' ? 7 : 4) ?? sorted.at(-1)
    if (first && last) {
      const index = (value: string) => query.group_by === 'month' ? Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1 : Number(value)
      const begin = index(first), end = index(last)
      if (end - begin <= 600) for (let n = begin; n <= end; n++) {
        const key = query.group_by === 'month' ? `${String(Math.floor(n / 12)).padStart(4, '0')}-${String(n % 12 + 1).padStart(2, '0')}` : String(n).padStart(4, '0')
        if (!groups.has(key)) groups.set(key, { amount: BigInt(0), tasks: 0 })
      }
      else report.warnings.push('统计区间较长，仅列出有记录的月份或年份。')
    }
  }
  report.groups = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({ key,
    value: query.operation === 'sum' ? decimalText(group.amount, attribute.type === 'money') : String(group.tasks), tasks: group.tasks }))
  report.total = query.operation === 'sum' ? decimalText(sum, attribute.type === 'money') : query.operation === 'count' ? String(report.matchedTasks) : null
  report.detailsTruncated = report.matchedTasks > report.details.length
  if (query.operation === 'sum' && attribute.type === 'text') report.warnings.push('该属性为文本类型，仅将纯数字值纳入求和。')
  if (query.include_summary) report.warnings.push('已包含摘要任务，请确认其填报值不是子任务合计，避免重复统计。')
  return report
}

/** Answer ambiguous units separately, without making users choose or adding
 * incomparable values together. Model-guessed filters are removed first. */
export function queryTaskAttributeReports(tasks: Task[], input: unknown, legacy: TaskCustomField[] = [], context?: AttributeQueryContext): AttributeQueryResult[] {
  const result = queryTaskAttributes(tasks, input, legacy, context)
  if (result.ok || result.kind !== 'ambiguous' || !result.query) return [result]
  return (result.candidates ?? []).map(attribute => {
    const report = queryTaskAttributes(tasks, { ...result.query, attribute_type: attribute.type, unit: attribute.unit }, legacy)
    if (report.ok) report.warnings.push(`同名属性按类型和单位分别统计；本项为${CUSTOM_FIELD_TYPES[attribute.type]}${attribute.unit ? `、${attribute.unit}` : '、未设置单位'}。`)
    return report
  })
}

export function attributeQueryMessage(result: AttributeQueryResult, unsaved = false): string {
  if (!result.ok) return `${result.error}${result.candidates?.length ? '\n可选属性：' + result.candidates.map(field => `${field.name}（${CUSTOM_FIELD_TYPES[field.type]}${field.unit ? '，' + field.unit : '，未设置单位'}）`).join('、') : ''}`
  const { query, attribute, skipped } = result
  const unit = query.operation === 'count' ? '个任务' : attribute.unit
  const range = query.from_date || query.to_date ? `${query.from_date ?? '不限起始日期'}至${query.to_date ?? '不限截止日期'}` : '全部计划'
  const lines = [`按${result.dateBasis}统计「${attribute.name}」${attribute.unit ? `（${attribute.unit}）` : ''}，范围为${range}。`]
  if (query.operation === 'list') {
    lines.push(...result.details.slice(0, 20).map(row => `${row.taskName}：${row.value}${unit}${row.date ? `（${row.date}）` : ''}。`))
    lines.push(`共匹配${result.matchedTasks}个任务${result.matchedTasks > 20 ? '，文字列出前20项，可展开明细查看更多' : ''}。`)
  } else {
    if (query.group_by !== 'none') lines.push(...result.groups.map(group => {
      const key = /^\d{4}-\d{2}$/.test(group.key) ? `${group.key.slice(0, 4)}年${Number(group.key.slice(5))}月` : /^\d{4}$/.test(group.key) ? `${group.key}年` : group.key
      return `${key}：${group.value}${unit}${group.tasks === 0 ? '（无已填记录）' : ''}。`
    }))
    lines.push(`合计${result.total}${unit}，纳入${result.matchedTasks}个任务。`)
  }
  if (result.matchedTasks === 0) lines.push('范围内没有可统计的已填记录，不能据此认定实际发生量为零。')
  if (skipped.empty + skipped.invalid + skipped.missingDate > 0) lines.push(`未纳入：未填属性${skipped.empty}项、无效值${skipped.invalid}项、缺少有效日期${skipped.missingDate}项；未填值不当作0。`)
  lines.push(`${result.scope}。`)
  lines.push(...result.warnings)
  lines.push(`以上为提问时的当前计划数据${unsaved ? '，包含尚未保存的修改' : ''}。`)
  return lines.join('\n')
}
