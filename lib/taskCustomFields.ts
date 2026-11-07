import type { TaskCustomField, TaskCustomFieldType, TaskCustomValues } from '../types'

export const CUSTOM_FIELD_TYPES: Record<TaskCustomFieldType, string> = {
  text: '文本', number: '数字', money: '金额', date: '日期', select: '单选',
}
export class CustomFieldError extends Error {}
const fail = (message: string): never => { throw new CustomFieldError(message) }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)

export function normalizeCustomFields(input: unknown, previous: TaskCustomField[] = []): TaskCustomField[] {
  if (!Array.isArray(input) || input.length > 100) return fail('任务属性必须是列表，最多 100 个（含停用属性）')
  const ids = new Set<string>(), names = new Set<string>()
  const result = input.map((raw): TaskCustomField => {
    if (!isRecord(raw) || !validId(raw.id)) return fail('任务属性 ID 无效')
    if (ids.has(raw.id)) return fail('任务属性 ID 不能重复')
    ids.add(raw.id)
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name || name.length > 60) return fail('属性名称须为 1 至 60 个字符')
    if (typeof raw.type !== 'string' || !Object.hasOwn(CUSTOM_FIELD_TYPES, raw.type)) return fail(`「${name}」的属性类型无效`)
    const type = raw.type as TaskCustomFieldType
    const old = previous.find(f => f.id === raw.id)
    if (old && old.type !== type) return fail(`「${name}」已创建，不能更改类型；请新增属性`)
    const archived = raw.archived === true
    if (!archived && names.has(name.toLocaleLowerCase())) return fail(`属性名称「${name}」重复`)
    if (!archived) names.add(name.toLocaleLowerCase())
    const unit = typeof raw.unit === 'string' ? raw.unit.trim() : ''
    if (unit.length > 12) return fail(`「${name}」的单位不能超过 12 个字符`)
    let options: string[] | undefined
    if (type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 100) return fail(`「${name}」须设置 1 至 100 个选项`)
      options = raw.options.map(o => typeof o === 'string' ? o.trim() : '')
      if (options.some(o => !o || o.length > 100) || new Set(options).size !== options.length) return fail(`「${name}」的选项不能为空或重复，且不能超过 100 个字符`)
      if (old?.options?.some(o => !options!.includes(o))) return fail(`「${name}」已有选项需保留，可追加新选项`)
    }
    return { id: raw.id, name, type, ...(unit && (type === 'money' || type === 'number') ? { unit } : {}), ...(options ? { options } : {}), ...(archived ? { archived: true } : {}) }
  })
  // A stale client must not erase definitions added by another editor.
  for (const old of previous) if (!ids.has(old.id)) result.push(old)
  if (result.length > 100) return fail('任务属性最多 100 个（含停用属性）')
  const activeNames = result.filter(f => !f.archived).map(f => f.name.toLocaleLowerCase())
  if (new Set(activeNames).size !== activeNames.length) return fail('属性名称不能重复')
  return result
}

export function normalizeCustomValue(value: unknown, field: TaskCustomField): string {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' && typeof value !== 'number') return fail(`「${field.name}」的值格式无效`)
  const text = String(value)
  if (text.length > 4000) return fail(`「${field.name}」不能超过 4000 个字符`)
  if (field.type === 'text') return text
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (field.type === 'select') {
    if (!field.options?.includes(trimmed)) return fail(`请选择「${field.name}」中的有效选项`)
    return trimmed
  }
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || !Number.isFinite(Date.parse(trimmed)) || new Date(trimmed).toISOString().slice(0, 10) !== trimmed) return fail(`「${field.name}」须为有效日期`)
    return trimmed
  }
  const match = trimmed.match(/^(-?)(\d{1,18})(?:\.(\d{1,8}))?$/)
  if (!match || (field.type === 'money' && (match[3]?.length ?? 0) > 2)) return fail(`「${field.name}」须为数字，最多 18 位整数${field.type === 'money' ? '、2 位小数' : '、8 位小数'}`)
  const integer = match[2].replace(/^0+(?=\d)/, '')
  const fraction = field.type === 'money' ? (match[3] ?? '').padEnd(2, '0') : (match[3] ?? '').replace(/0+$/, '')
  const negative = match[1] && /[1-9]/.test(integer + fraction) ? '-' : ''
  return `${negative}${integer}${fraction ? `.${fraction}` : ''}`
}

/** Omitted keys are preserved; an explicit empty string clears a value. */
export function normalizeCustomValues(input: unknown, fields: TaskCustomField[], previous: TaskCustomValues = {}): TaskCustomValues {
  if (!isRecord(input) || Object.keys(input).length > 100) return fail('任务属性值须为键值对象，最多 100 项')
  const result = { ...previous }
  for (const [id, value] of Object.entries(input)) {
    const field = fields.find(f => f.id === id)
    if (!field) {
      if ((value ?? '') === (previous[id] ?? '')) continue
      return fail('任务含未定义的属性，请先配置属性')
    }
    // Archiving hides editing controls but is not deletion. Copies, imports and
    // version rollback may still carry valid values for an archived definition.
    result[id] = normalizeCustomValue(value, field)
  }
  return result
}

export function customValuesEqual(a: TaskCustomValues = {}, b: TaskCustomValues = {}): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(id => (a[id] ?? '') === (b[id] ?? ''))
}
export function customFieldsEqual(a: TaskCustomField[] = [], b: TaskCustomField[] = []): boolean {
  const canonical = (fields: TaskCustomField[]) => fields.map(f => [f.id, f.name, f.type, f.unit ?? '', f.options ?? [], !!f.archived])
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
export function formatCustomValue(value: string | undefined, field?: TaskCustomField): string {
  return value ? `${value}${field?.unit ? ` ${field.unit}` : ''}` : ''
}

export const CUSTOM_FIELDS_SHEET = '_任务属性配置'
export function customFieldExportColumns(fields: TaskCustomField[]) {
  const used = new Set<string>()
  return fields.map(field => {
    const base = `属性：${field.name}${field.unit ? `（${field.unit}）` : ''}${field.archived ? '（已停用）' : ''}`
    let header = base, suffix = 2
    while (used.has(header)) header = `${base} ${suffix++}`
    used.add(header)
    return { field, header, key: `custom:${field.id}`, width: 22 }
  })
}

export function mergeImportedCustomFields(existing: TaskCustomField[], imported: TaskCustomField[]) {
  const fields = [...existing]
  const idMap = new Map<string, string>()
  for (const field of imported) {
    const match = fields.find(f => f.id === field.id) ?? fields.find(f => !f.archived && f.name.toLocaleLowerCase() === field.name.toLocaleLowerCase())
    if (match) {
      if (match.type !== field.type) return fail(`导入属性「${field.name}」与项目中的属性类型不同，请先调整属性名称`)
      idMap.set(field.id, match.id)
      if (field.type === 'select') fields[fields.indexOf(match)] = { ...match, options: [...new Set([...(match.options ?? []), ...(field.options ?? [])])] }
    } else { fields.push(field); idMap.set(field.id, field.id) }
  }
  return { fields: normalizeCustomFields(fields, existing), idMap }
}
