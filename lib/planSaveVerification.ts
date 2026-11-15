import type { SaveBaseline } from './clientSave'
import type { Task, TaskCustomField } from '../types'
import { toDateTimeStr } from './clientTime'
import { normalizePlanningStatus } from './planningStatus'
import { normalizeDurationMinutes } from './taskNumbers'
import { taskCustomFields, normalizeCustomValue } from './taskCustomFields'

const fieldsValue = (fields: TaskCustomField[]) => fields.map(f => [f.id, f.name, f.type, f.unit ?? '', f.options ?? [], !!f.archived])

// Compare editable values, excluding database timestamps and audit metadata.
// Defaults match task creation; explicit false and null values remain meaningful.
export function comparableTask(task: Task, legacy: TaskCustomField[] = []) {
  const date = (value: string | null | undefined) => toDateTimeStr(value)
  const fields = taskCustomFields(task, legacy)
  const values = Object.fromEntries(Object.entries(task.custom_values ?? {}).map(([id, value]) => {
    const field = fields.find(f => f.id === id)
    try { return [id, field ? normalizeCustomValue(value, field) : value] }
    catch { return [id, value] }
  }).filter(([, value]) => (value ?? '') !== ''))
  return { id: task.id, name: task.name, parent_id: task.parent_id ?? null,
    task_code: task.task_code, assignee: task.assignee ?? null,
    start_date: date(task.start_date), end_date: date(task.end_date),
    duration: normalizeDurationMinutes(task.duration, task.start_date, task.end_date),
    duration_unit: task.duration_unit ?? 'day', percent_done: task.percent_done ?? 0,
    is_milestone: task.is_milestone ?? false, note: task.note ?? null,
    order_index: task.order_index ?? 0, auto_schedule: task.auto_schedule ?? true,
    constraint_type: task.constraint_type ?? 'asap', constraint_date: date(task.constraint_date),
    deadline: date(task.deadline), status: task.status ?? null,
    rollup: task.rollup ?? false, inactive: task.inactive ?? false,
    project_boundary: task.project_boundary ?? 'ask', baseline_end_date: date(task.baseline_end_date),
    custom_fields: fieldsValue(fields), custom_values: values }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const FIELD_LABELS: Record<string, string> = {
  name: '名称', parent_id: '父任务', task_code: '任务编码', assignee: '责任人',
  start_date: '开始日期', end_date: '完成日期', duration: '工期', duration_unit: '工期单位',
  percent_done: '完成度', is_milestone: '里程碑', note: '备注', order_index: '顺序',
  auto_schedule: '排程方式', constraint_type: '日期限制类型', constraint_date: '限制日期',
  deadline: '截止日期', status: '任务状态', rollup: '汇总设置', inactive: '有效状态',
  project_boundary: '项目边界', baseline_end_date: '基准完成日期', custom_fields: '属性配置',
  custom_values: '属性值', from_task_id: '前置任务', to_task_id: '后续任务',
  type: '关系类型', lag: '间隔', active: '启用状态', line_date: '日期', color: '颜色', visible: '显示设置',
}

export function comparablePlan(state: SaveBaseline) {
  const order = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id))
  return {
    tasks: order(state.tasks.filter(t => !t.is_deleted).map(t => comparableTask(t, state.customFields))),
    dependencies: order(state.dependencies.map(d => ({ id: d.id, from_task_id: d.from_task_id, to_task_id: d.to_task_id,
      type: d.type ?? 2, lag: d.lag ?? 0, active: d.active ?? true }))),
    lines: order((state.lines ?? []).map(l => ({ id: l.id, name: l.name, line_date: l.line_date.slice(0, 10), color: l.color, visible: l.visible }))),
    statusDate: toDateTimeStr(state.statusDate), planningStatus: normalizePlanningStatus(state.planningStatus),
    customFields: fieldsValue(state.customFields ?? []),
    planBaseline: state.planBaseline ?? null,
  }
}

/** A prior failed attempt may already have committed. Accept only original,
 * submitted, or previously attempted values; unrelated remote changes conflict. */
export function findPlanSaveConflicts(baseline: SaveBaseline, persisted: SaveBaseline, submitted: SaveBaseline, attempts: SaveBaseline[] = []): string[] {
  const base = comparablePlan(baseline), remote = comparablePlan(persisted), local = comparablePlan(submitted)
  const previous = attempts.map(comparablePlan)
  const issues: string[] = []
  for (const [key, label] of [['tasks', '任务'], ['dependencies', '依赖'], ['lines', '项目线']] as const) {
    const original = new Map(base[key].map(item => [item.id, item]))
    const intended = new Map(local[key].map(item => [item.id, item]))
    const actual = new Map(remote[key].map(item => [item.id, item]))
    for (const id of new Set([...original.keys(), ...actual.keys()])) {
      const before = original.get(id), now = actual.get(id), wanted = intended.get(id)
      const tried = previous.map(state => state[key].find(item => item.id === id)).filter(Boolean)
      const name = key === 'tasks' ? (now ?? before) as { name?: string } : null
      const description = `${label}「${name?.name ?? id}」`
      if (!now) {
        if (wanted) issues.push(`${description}已被其他操作删除`)
      } else if (!before && !wanted && !tried.length) {
        issues.push(`${description}是后台新增内容，请先核对最新计划`)
      } else {
        const allowed = [before, wanted, ...tried].filter(Boolean) as Record<string, unknown>[]
        const record = now as unknown as Record<string, unknown>
        const changed = Object.keys(record).filter(field => !allowed.some(candidate => equal(candidate[field], record[field])))
        if (changed.length) {
          issues.push(`${description}的${changed.map(field => FIELD_LABELS[field] ?? field).join('、')}已在后台修改，与当前提交冲突`)
        }
      }
    }
  }
  for (const [key, label] of [['statusDate', '状态日期'], ['planningStatus', '计划状态'], ['customFields', '任务属性配置'], ['planBaseline', '固定基线']] as const) {
    if (![base[key], local[key], ...previous.map(state => state[key])].some(value => equal(value, remote[key]))) issues.push(`${label}已在后台修改`)
  }
  return issues
}

/** Verify the database readback against the intended plan, including deletes.
 * Extra records are also differences: a concurrent graph change needs review. */
export function findPlanSaveMismatches(expected: SaveBaseline, persisted: SaveBaseline): string[] {
  const wanted = comparablePlan(expected), actual = comparablePlan(persisted)
  const issues: string[] = []
  for (const [key, label] of [['tasks', '任务'], ['dependencies', '依赖'], ['lines', '项目线']] as const) {
    const requested = new Map(wanted[key].map(item => [item.id, item]))
    const saved = new Map(actual[key].map(item => [item.id, item]))
    for (const id of new Set([...requested.keys(), ...saved.keys()])) {
      const before = requested.get(id), after = saved.get(id)
      if (equal(before, after)) continue
      const name = key === 'tasks' ? (before ?? after) as { name?: string } : null
      const fields = before && after ? Object.keys(before).filter(field => !equal((before as Record<string, unknown>)[field], (after as Record<string, unknown>)[field])).map(field => FIELD_LABELS[field] ?? field) : []
      issues.push(`${label}「${name?.name ?? id}」${!after ? '未保存到后台' : !before ? '仍存在于后台或被其他操作新增' : `的${fields.join('、')}与提交不一致`}`)
    }
  }
  for (const [key, label] of [['statusDate', '状态日期'], ['planningStatus', '计划状态'], ['customFields', '任务属性配置'], ['planBaseline', '固定基线']] as const) {
    if (!equal(wanted[key], actual[key])) issues.push(`${label}与后台保存结果不一致`)
  }
  return issues
}
