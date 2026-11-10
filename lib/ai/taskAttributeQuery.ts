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
  task_keywords?: string[]
  assignee?: string
  value_equals?: string
  include_summary?: boolean
  task_scope?: 'leaf' | 'summary' | 'all' | 'separate'
  summary_level?: number
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
  details: { taskId: string; taskCode: string; taskName: string; taskPath?: string; date: string | null; value: string }[]
  detailsTruncated: boolean
  skipped: { empty: number; invalid: number; missingDate: number; summary: number; inactive: number; archived: number; leaf?: number }
  warnings: string[]
}
export type AttributeQueryResult = AttributeQueryReport | { ok: false; error: string; candidates?: AttributeCatalogEntry[]; kind?: 'ambiguous'; query?: AttributeQuery }
const nameKey = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()
const unitKey = (value: string) => value.normalize('NFKC').trim()
const QUANTITY_ACTIONS = ['安装', '搬迁', '采购', '拆除']
const QUANTITY_OBJECTS = ['服务器', '交换机', '路由器', '机柜']
const TASK_KEYWORD_ALIASES: Record<string, string[]> = {
  安装: ['安装', '上架', '部署'], 搬迁: ['搬迁', '迁移'], 采购: ['采购', '购买', '购置'], 拆除: ['拆除', '下架', '下电'],
}
const containsTaskKeyword = (text: string, word: string): boolean => (TASK_KEYWORD_ALIASES[word] ?? [word]).some(value => text.includes(nameKey(value)))

function quantityTaskKeywords(text: string): string[] {
  const actions = QUANTITY_ACTIONS.filter(word => containsTaskKeyword(nameKey(text), word))
  const objects = QUANTITY_OBJECTS.filter(word => text.includes(word))
  return [...(actions.length === 1 ? actions : []), ...(objects.length === 1 ? objects : [])]
}

function isCombinedKeyword(value: string, keywords: string[]): boolean {
  let rest = nameKey(value).replace(/[\s、,，的]/g, '')
  if (!rest) return false
  for (const word of keywords) rest = rest.split(nameKey(word)).join('')
  return rest === ''
}

function requestedTaskScope(text: string): AttributeQuery['task_scope'] | undefined {
  if (/(?:父任务|摘要任务|父子)/.test(text) && /(?:子任务|叶子任务|父子)/.test(text) && /分别|分开|各自|单列|对照/.test(text)) return 'separate'
  if (/(?:只|仅)(?:统计|汇总|查询|查看|看|列出|计算)?(?:父任务|摘要任务)/.test(text) || /不(?:计入|统计|汇总|包含|计|含|算)(?:子任务|叶子任务)/.test(text)) return 'summary'
  if (/(?:只|仅)(?:统计|汇总|查询|查看|看|列出|计算)?(?:子任务|叶子任务|最底层任务)/.test(text) || /不(?:计入|统计|汇总|包含|计|含|算)(?:父任务|摘要任务)/.test(text)) return 'leaf'
  if (/父子/.test(text) && /不要重复|避免重复|不重复|不要.*相加/.test(text)) return 'leaf'
  return undefined
}

function taskLevels(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.filter(task => !task.is_deleted).map(task => [task.id, task]))
  const levels = new Map<string, number>()
  for (const task of byId.values()) {
    const path: string[] = [], seen = new Set<string>()
    let current: Task | undefined = task
    while (current && !levels.has(current.id) && !seen.has(current.id)) {
      path.push(current.id); seen.add(current.id); current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    let level = current ? (levels.get(current.id) ?? -1) : -1
    for (const id of path.reverse()) levels.set(id, ++level)
  }
  return levels
}

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
  const query = /统计|汇总|合计|总计|总共|多少|几\s*台|求和|查询|查看|列出|提供|给我|按月|每月|各月|逐月|分月|按年|每年|(?:后|未来|接下来|下)[一二两三四五六七八九十\d]+个?月|sum|total|aggregate|count|monthly|how many|list/i.test(text)
  const metric = /自定义|属性|金额|台数|数量|费用|支出|成本|产量|几\s*台|多少\s*台/.test(text)
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
  const stringKeys = ['attribute_name', 'operation', 'group_by', 'date_field', 'date_attribute', 'from_date', 'to_date', 'attribute_type', 'unit', 'task_name', 'assignee', 'value_equals', 'task_scope']
  if (stringKeys.some(key => raw[key] != null && (typeof raw[key] !== 'string' || (raw[key] as string).length > 4000))) return { ok: false, error: '属性名称、日期与筛选条件须为文本。' }
  if (raw.task_keywords != null && (!Array.isArray(raw.task_keywords) || raw.task_keywords.length > 20
    || !raw.task_keywords.every(word => typeof word === 'string' && word.trim().length > 0 && word.length <= 100))) return { ok: false, error: '任务筛选关键词须为不超过20项的文本列表。' }
  if (['include_summary', 'include_inactive', 'include_archived'].some(key => raw[key] != null && typeof raw[key] !== 'boolean')) return { ok: false, error: '任务范围参数无效。' }
  if (raw.summary_level != null && (!Number.isSafeInteger(raw.summary_level) || Number(raw.summary_level) < 0)) return { ok: false, error: '父任务层级无效。' }
  const query: AttributeQuery = {
    ...(raw as unknown as AttributeQuery), attribute_name: String(raw.attribute_name ?? '').trim(),
    operation: (raw.operation ?? 'sum') as AttributeQuery['operation'],
    group_by: (raw.group_by ?? (raw.operation === 'list' ? 'none' : 'month')) as AttributeQuery['group_by'],
    date_field: (raw.date_field ?? 'end_date') as AttributeQuery['date_field'],
  }
  if (query.task_keywords) query.task_keywords = [...new Set(query.task_keywords.map(word => word.trim()))].sort()
  const chosenRange = context?.today ? resolveAttributeDateRange(context.text, context.today) : null
  const requestedScope = context ? requestedTaskScope(context.text) : undefined
  if (requestedScope && requestedScope !== 'separate') query.task_scope = requestedScope
  query.task_scope ??= context?.previousQuery?.task_scope ?? (query.include_summary ? 'all' : 'leaf')
  if (!['leaf', 'summary', 'all'].includes(query.task_scope)) return { ok: false, error: '请分别查询父任务和子任务，不能把不同层级的数量直接相加。' }
  if (chosenRange) { query.from_date = chosenRange.from; query.to_date = chosenRange.to }
  else if (context && /全部计划|全计划|不限日期|不限时间|不限制时间/.test(context.text)) { delete query.from_date; delete query.to_date }
  if (context) {
    const previous = context.previousQuery
    if (/(?:多少|几)\s*台/.test(context.text) && !/多少个任务|几个任务/.test(context.text)) query.operation = 'sum'
    const inferred = query.operation !== 'list' ? quantityTaskKeywords(context.text) : []
    if (inferred.length) {
      // Generic metrics such as 设备台数 still need the action/object requested
      // by the user. Do not rely on the model remembering both filters.
      query.task_keywords = [...new Set([...(query.task_keywords ?? []).flatMap(word => isCombinedKeyword(word, inferred) ? inferred : [word]), ...inferred])].sort()
      if (query.task_name && isCombinedKeyword(query.task_name, inferred) && !/任务名称|任务名|任务[“「"]/.test(context.text)) delete query.task_name
      if (query.task_scope === 'all' && !/父任务|摘要任务|父子/.test(context.text) && previous?.task_scope !== 'all') query.task_scope = 'leaf'
    }
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
  const taskPath = (task: Task): string => {
    const names: string[] = [], seen = new Set<string>()
    let current: Task | undefined = task
    while (current && !seen.has(current.id)) {
      names.push(current.name); seen.add(current.id); current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return names.reverse().join(' / ')
  }
  const matchesKeywords = (task: Task): boolean => {
    if (!query.task_keywords?.length) return true
    const own = nameKey(`${task.name} ${attribute.name}`)
    let inherited: string | undefined
    return query.task_keywords.every(word => {
      if (containsTaskKeyword(own, word)) return true
      // A leaf explicitly describing a switch or relocation must not inherit
      // an unrelated server/installation label from a broad summary.
      const alternatives = QUANTITY_OBJECTS.includes(word) ? QUANTITY_OBJECTS : QUANTITY_ACTIONS.includes(word) ? QUANTITY_ACTIONS : []
      if (alternatives.some(value => containsTaskKeyword(own, value))) return false
      inherited ??= nameKey(`${taskPath(task)} ${attribute.name}`)
      return containsTaskKeyword(inherited, word)
    })
  }
  const levels = taskLevels(live)
  const summaryLevels = live.filter(task => summaries.has(task.id)).map(task => levels.get(task.id) ?? 0)
  const summaryLevel = query.summary_level ?? (summaryLevels.length ? Math.min(...summaryLevels) : 0)
  const scopeLabel = query.task_scope === 'summary' ? `仅第${summaryLevel + 1}层父任务（摘要任务）` : query.task_scope === 'all' ? '包含父任务和子任务' : '仅叶子任务'
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
    scope: `${scopeLabel}；${query.include_inactive ? '包含无效任务' : '排除无效任务'}；${query.include_archived ? '包含停用属性' : '排除停用属性'}`,
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
    if (!matchesKeywords(task)) continue
    if (query.task_scope === 'leaf' && summaries.has(task.id)) { report.skipped.summary++; continue }
    if (query.task_scope === 'summary' && !summaries.has(task.id)) { report.skipped.leaf = (report.skipped.leaf ?? 0) + 1; continue }
    if (query.task_scope === 'summary' && levels.get(task.id) !== summaryLevel) { report.skipped.summary++; continue }
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
    if (report.details.length < 100) report.details.push({ taskId: task.id, taskCode: task.task_code, taskName: task.name,
      ...(query.task_keywords?.length ? { taskPath: taskPath(task) } : {}), date: day, value })
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
  if (query.task_scope === 'all') report.warnings.push('已包含父任务和子任务，父任务若为子任务合计会重复统计；建议父子分别统计。')
  if (query.task_scope === 'leaf' && report.skipped.summary) report.warnings.push(`已排除${report.skipped.summary}个父任务的填报，避免父子重复累计。`)
  return report
}

/** Answer ambiguous units separately, without making users choose or adding
 * incomparable values together. Model-guessed filters are removed first. */
export function queryTaskAttributeReports(tasks: Task[], input: unknown, legacy: TaskCustomField[] = [], context?: AttributeQueryContext): AttributeQueryResult[] {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const separate = raw && (requestedTaskScope(context?.text ?? '') === 'separate' || raw.task_scope === 'separate')
  const inputs = separate ? ['summary', 'leaf'].map(task_scope => ({ ...raw, task_scope })) : [input]
  const levels = taskLevels(tasks), parents = new Set(tasks.filter(task => !task.is_deleted).map(task => task.parent_id))
  const parentLevels = [...new Set(tasks.filter(task => !task.is_deleted && parents.has(task.id)).map(task => levels.get(task.id) ?? 0))].sort((a, b) => a - b)
  return inputs.flatMap(value => {
    const result = queryTaskAttributes(tasks, value, legacy, context)
    const resolved = result.ok || result.kind !== 'ambiguous' || !result.query ? [result] : (result.candidates ?? []).map(attribute => {
      const report = queryTaskAttributes(tasks, { ...result.query, attribute_type: attribute.type, unit: attribute.unit }, legacy)
      if (report.ok) report.warnings.push(`同名属性按类型和单位分别统计；本项为${CUSTOM_FIELD_TYPES[attribute.type]}${attribute.unit ? `、${attribute.unit}` : '、未设置单位'}。`)
      return report
    })
    return resolved.flatMap(report => {
      if (!report.ok || report.query.task_scope !== 'summary' || report.query.summary_level != null || parentLevels.length < 2) return [report]
      return parentLevels.map(summary_level => {
        const levelReport = queryTaskAttributes(tasks, { ...report.query, summary_level }, legacy)
        if (levelReport.ok) levelReport.warnings.push(...report.warnings, '父任务按层级分别统计，各层级及子任务之间不相加。')
        return levelReport
      })
    })
  })
}

export function deduplicateAttributeReports(reports: AttributeQueryResult[]): AttributeQueryResult[] {
  const seen = new Set<string>()
  return reports.filter(report => {
    const query = report.ok ? { ...report.query } : null
    if (query) delete query.include_summary
    const key = report.ok ? JSON.stringify([report.attribute.name, report.attribute.type, report.attribute.unit, Object.entries(query!).sort(([a], [b]) => a.localeCompare(b))]) : JSON.stringify(report)
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

export function attributeQueryMessage(result: AttributeQueryResult, unsaved = false): string {
  if (!result.ok) return `${result.error}${result.candidates?.length ? '\n可选属性：' + result.candidates.map(field => `${field.name}（${CUSTOM_FIELD_TYPES[field.type]}${field.unit ? '，' + field.unit : '，未设置单位'}）`).join('、') : ''}`
  const { query, attribute, skipped } = result
  const unit = query.operation === 'count' ? '个任务' : attribute.unit
  const range = query.from_date || query.to_date ? `${query.from_date ?? '不限起始日期'}至${query.to_date ?? '不限截止日期'}` : '全部计划'
  const lines = [`按${result.dateBasis}统计「${attribute.name}」${attribute.unit ? `（${attribute.unit}）` : ''}，范围为${range}。`, `${result.scope}。`]
  if (query.task_keywords?.length) lines.push(`筛选：${query.task_keywords.map(word => `「${word}」`).join('、')}同时匹配任务层级或属性名称；数量取实际填报的属性值。`)
  if (query.task_name) lines.push(`任务名称包含「${query.task_name}」。`)
  if (result.matchedTasks === 0 && query.operation !== 'count') {
    lines.push(attribute.filled === 0
      ? '该属性已配置，但尚未填写属性值，无法汇总；属性名称中的数字不会当作填报数量。'
      : '所选范围没有符合条件的已填记录，暂时无法汇总；不能据此认定数量为零。')
    if (skipped.empty + skipped.invalid + skipped.missingDate > 0) lines.push(`未纳入：未填属性${skipped.empty}项、无效值${skipped.invalid}项、缺少有效日期${skipped.missingDate}项；未填值不当作0。`)
    lines.push(...result.warnings)
    lines.push(`以上为提问时的当前计划数据${unsaved ? '，包含尚未保存的修改' : ''}。`)
    return lines.join('\n')
  }
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
  if (skipped.empty + skipped.invalid + skipped.missingDate > 0) lines.push(`未纳入：未填属性${skipped.empty}项、无效值${skipped.invalid}项、缺少有效日期${skipped.missingDate}项；未填值不当作0。`)
  lines.push(...result.warnings)
  lines.push(`以上为提问时的当前计划数据${unsaved ? '，包含尚未保存的修改' : ''}。`)
  return lines.join('\n')
}
