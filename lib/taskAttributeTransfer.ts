import type { TaskCustomField, TaskCustomValues } from '../types'
import { CustomFieldError, normalizeCustomFields, normalizeCustomValues, normalizeCustomValue, taskCustomFields } from './taskCustomFields'
import { uuid } from './uuid'

export const TASK_FIELDS_SHEET = '_任务属性归属'
export interface TaskFieldBinding {
  fields: TaskCustomField[]
  columns: Record<string, string>
  names: Record<string, string>
}
type WithAttributes = { custom_fields?: TaskCustomField[] | null; custom_values?: TaskCustomValues }

/** Files use columns, while the application owns definitions on each task.
 * Equivalent columns share a slot; bindings retain each task's original IDs,
 * names and even empty attributes. Values always come from editable file cells. */
export function prepareTaskAttributeTransfer<T extends WithAttributes>(tasks: T[], legacy: TaskCustomField[] = []) {
  const fields: TaskCustomField[] = []
  const byDefinition = new Map<string, TaskCustomField>()
  const ids = new Set<string>(), names = new Set<string>()
  const transferred = tasks.map(task => {
    const own = normalizeCustomFields(taskCustomFields(task, legacy))
    const values = normalizeCustomValues(task.custom_values ?? {}, own)
    const binding: TaskFieldBinding = { fields: own, columns: {}, names: {} }
    const wireValues: TaskCustomValues = {}
    for (const field of own) {
      const key = JSON.stringify([field.name, field.type, field.unit ?? '', field.options ?? [], !!field.archived])
      let wire = byDefinition.get(key)
      if (!wire) {
        let name = field.name, suffix = 2
        while (names.has(name.toLocaleLowerCase())) name = `${field.name.slice(0, 50)} ${suffix++}`
        wire = { ...field, id: ids.has(field.id) ? uuid() : field.id, name }
        ids.add(wire.id); names.add(name.toLocaleLowerCase()); fields.push(wire); byDefinition.set(key, wire)
      }
      binding.columns[field.id] = wire.id
      binding.names[field.id] = wire.name
      wireValues[wire.id] = values[field.id] ?? ''
    }
    return { ...task, custom_values: wireValues, custom_field_binding: binding }
  })
  return { fields, tasks: transferred }
}

export function restoreTaskAttributes(values: TaskCustomValues, wireFields: TaskCustomField[], binding?: TaskFieldBinding | null, legacyFile = false) {
  const fields: TaskCustomField[] = [], ownValues: TaskCustomValues = {}, used = new Set<string>()
  const wireById = new Map(wireFields.map(f => [f.id, f]))
  if (binding) {
    if (!binding.columns || typeof binding.columns !== 'object' || !binding.names || typeof binding.names !== 'object') throw new CustomFieldError('任务属性归属信息无效，请保留导出文件的配置工作表')
    for (const original of normalizeCustomFields(binding.fields)) {
      const wireId = binding.columns[original.id]
      const wire = wireById.get(wireId)
      if (!wire || wire.type !== original.type) throw new CustomFieldError(`任务属性「${original.name}」的文件列缺失或类型不符`)
      const field = { ...original, ...(wire.name !== binding.names[original.id] ? { name: wire.name } : {}),
        ...(original.type === 'select' ? { options: [...new Set([...(original.options ?? []), ...(wire.options ?? [])])] } : {}) }
      fields.push(field); used.add(wireId)
      ownValues[field.id] = normalizeCustomValue(values[wireId] ?? '', field)
    }
  }
  // An attribute added in Excel/Project belongs only to rows where it is filled.
  // Old exports had a global schema: preserve their explicit empty values too.
  for (const wire of wireFields) {
    if (used.has(wire.id) || (!legacyFile && !values[wire.id])) continue
    let name = wire.name, suffix = 2
    while (fields.some(f => !f.archived && f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${wire.name.slice(0, 50)} ${suffix++}`
    const field = { ...wire, id: fields.some(f => f.id === wire.id) ? uuid() : wire.id, name }
    fields.push(field); ownValues[field.id] = normalizeCustomValue(values[wire.id] ?? '', field)
  }
  return { custom_fields: normalizeCustomFields(fields), custom_values: ownValues }
}
