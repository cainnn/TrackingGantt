import type { TaskCustomField } from '../../types'
import { normalizeCustomFields } from '../taskCustomFields'
import { uuid } from '../uuid'

// Columns owned by the built-in task/import schema must never become attributes.
const TASK_COLUMNS = new Set([
  '任务编码', '层级', '父任务编码', '任务名称', '责任人', '开始日期', '结束日期',
  '工期', '工期(天)', '工期（天）', '工期(分钟)', '工期（分钟）', '工期单位',
  '里程碑', '自动排程', '完成度', '前置依赖', '延迟', '限制类型', '限制日期',
  '汇总', '非激活', '项目边界', '状态', '截止日期', '基线结束', '备注',
])
export interface ExcelCustomColumn { header: string; field: TaskCustomField }

export function excelCustomColumns(headers: string[], metadata: Array<{ '列名': string; '配置': string }>, existing: TaskCustomField[] = []): ExcelCustomColumn[] {
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('Excel 列名重复，请为每列使用不同名称')
  const definitions = metadata.length ? normalizeCustomFields(metadata.map(row => JSON.parse(row['配置']))) : []
  const columns = metadata.map((row, i) => ({ header: row['列名'], field: definitions[i] }))
  if (new Set(columns.map(c => c.header)).size !== columns.length) throw new Error('Excel 属性列名重复，请重新导出')
  if (columns.some(c => !headers.includes(c.header))) throw new Error('Excel 缺少属性列，请保留导出文件中的属性列后重试')
  for (const header of headers) {
    if (!header.trim() || TASK_COLUMNS.has(header) || columns.some(c => c.header === header)) continue
    const label = header.replace(/^属性[:：]\s*/, '').trim()
    const match = label.match(/^(.*?)[（(]([^（）()]+)[）)]$/)
    const possibleName = (match?.[1] ?? label).trim()
    const unit = match?.[2]?.trim()
    const old = existing.find(f => !f.archived && (f.name === label || f.name === possibleName))
    let field: TaskCustomField
    if (old) field = old
    else {
      const type = /(?:金额|费用|成本|预算)$/.test(possibleName) ? 'money' : /日期$/.test(label) ? 'date' : 'text'
      const name = type === 'money' ? possibleName : label
      field = { id: uuid(), name, type, ...(unit && type === 'money' ? { unit } : {}) }
    }
    columns.push({ header, field })
  }
  normalizeCustomFields(columns.map(c => c.field))
  return columns
}
