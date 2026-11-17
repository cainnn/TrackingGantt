import type { SaveBaseline } from './clientSave'
import { comparablePlan, FIELD_LABELS } from './planSaveVerification'

export type SaveChoice = 'local' | 'remote'
export interface SaveDifference {
  key: string
  title: string
  fields: string[]
  before: Record<string, unknown> | undefined
  local: Record<string, unknown> | undefined
  remote: Record<string, unknown> | undefined
  conflict: boolean
  suggested?: SaveChoice
  taskNames?: Record<string, string>
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
type RecordValue = { id: string; [key: string]: unknown }

/** Three-way review, never a write. Related schedule/hierarchy fields stay together;
 * unrelated remote changes are retained, while competing edits need an explicit choice. */
export function reconcilePlanSave(
  baseline: SaveBaseline, persisted: SaveBaseline, submitted: SaveBaseline,
  attempts: SaveBaseline[] = [], choices: Record<string, SaveChoice> = {},
) {
  const base = comparablePlan(baseline), remote = comparablePlan(persisted), local = comparablePlan(submitted)
  const previous = attempts.map(comparablePlan)
  const differences: SaveDifference[] = []
  const taskNames = Object.fromEntries([...baseline.tasks, ...persisted.tasks, ...submitted.tasks].map(t => [t.id, t.name]))
  const choose = (row: SaveDifference) => {
    differences.push({ ...row, taskNames })
    return choices[row.key] ?? row.suggested ?? 'local'
  }
  const merge = (key: 'tasks' | 'dependencies' | 'lines', label: string) => {
    const originals = new Map(base[key].map(t => [t.id, t as RecordValue]))
    const actual = new Map(remote[key].map(t => [t.id, t as RecordValue]))
    const intended = new Map(local[key].map(t => [t.id, t as RecordValue]))
    const rawLocal = new Map((submitted[key] ?? []).map(t => [t.id, t as unknown as RecordValue]))
    const rawRemote = new Map((persisted[key] ?? []).map(t => [t.id, t as unknown as RecordValue]))
    const merged: RecordValue[] = []
    for (const id of new Set([...intended.keys(), ...actual.keys(), ...originals.keys()])) {
      const before = originals.get(id), now = actual.get(id), wanted = intended.get(id)
      const tried = previous.map(p => p[key].find(t => t.id === id) as RecordValue | undefined).filter((t): t is RecordValue => !!t)
      const record = wanted ?? now ?? before
      const title = key === 'dependencies' ? `依赖「${taskNames[String(record?.from_task_id)] ?? '已删除任务'} → ${taskNames[String(record?.to_task_id)] ?? '已删除任务'}」`
        : `${label}「${record?.name ?? id}」`
      if (equal(now, wanted)) { if (wanted) merged.push(rawLocal.get(id)!); continue }
      if (!wanted || !now) {
        // Local additions/deletions with no competing remote edit need no review.
        if (equal(before, now) || now && tried.some(t => equal(t, now))) {
          if (wanted) merged.push(rawLocal.get(id)!)
          continue
        }
        const conflict = !!before && !equal(before, wanted)
        const choice = choose({ key: `${key}:${id}:record`, title, fields: ['record'], before, local: wanted, remote: now,
          conflict, suggested: conflict ? undefined : 'remote' })
        const selected = choice === 'local' ? rawLocal.get(id) : rawRemote.get(id)
        if (selected) merged.push(selected)
        continue
      }
      const grouped = key === 'tasks' ? [
        ['start_date', 'end_date', 'duration', 'duration_unit', 'auto_schedule', 'is_milestone', 'constraint_type', 'constraint_date'],
        ['parent_id', 'order_index'], ['custom_fields', 'custom_values'],
      ] : key === 'dependencies' ? [['from_task_id', 'to_task_id', 'type', 'lag', 'active']] : []
      const groups = [...grouped, ...Object.keys(now).filter(f => f !== 'id' && !grouped.some(g => g.includes(f))).map(f => [f])]
      const result = { ...rawLocal.get(id)! }
      for (const fields of groups) {
        const same = (a: RecordValue | undefined, b: RecordValue | undefined) => !!a && !!b && fields.every(f => equal(a[f], b[f]))
        if (same(now, wanted) || same(now, before) || tried.some(t => same(t, now))) continue
        const conflict = !same(wanted, before)
        const choice = choose({ key: `${key}:${id}:${fields[0]}`, title, fields,
          before, local: wanted, remote: now, conflict, suggested: conflict ? undefined : 'remote' })
        if (choice === 'remote') for (const field of fields) result[field] = rawRemote.get(id)![field]
      }
      merged.push(result)
    }
    return merged
  }
  const plan: SaveBaseline = { ...submitted,
    tasks: merge('tasks', '任务') as unknown as SaveBaseline['tasks'],
    dependencies: merge('dependencies', '依赖') as unknown as SaveBaseline['dependencies'],
    lines: merge('lines', '项目线') as unknown as SaveBaseline['lines'],
  }
  for (const [key, title] of [['statusDate', '状态日期'], ['planningStatus', '计划状态'], ['customFields', '项目属性配置'], ['planBaseline', '固定基线']] as const) {
    if (equal(remote[key], local[key]) || equal(remote[key], base[key]) || previous.some(p => equal(p[key], remote[key]))) continue
    const conflict = !equal(local[key], base[key])
    const choice = choose({ key, title, fields: [key], before: { [key]: base[key] }, local: { [key]: local[key] }, remote: { [key]: remote[key] },
      conflict, suggested: conflict ? undefined : 'remote' })
    if (choice === 'remote') Object.assign(plan, { [key]: persisted[key] })
  }
  return { plan, differences, unresolved: differences.filter(d => d.conflict && !choices[d.key]) }
}

export function describeSaveDifference(row: SaveDifference, side: 'before' | SaveChoice) {
  const value = row[side]
  if (!value) return '不存在（删除）'
  const fields = row.fields[0] === 'record' ? ['name', 'start_date', 'end_date', 'from_task_id', 'to_task_id'] : row.fields
  const constraints: Record<string, string> = { none: '无', asap: '尽早', alap: '尽晚', muststarton: '必须于指定日期开始', mustfinishon: '必须于指定日期完成', startnoearlierthan: '不早于指定日期开始', finishnoearlierthan: '不早于指定日期完成', startnolaterthan: '不迟于指定日期开始', finishnolaterthan: '不迟于指定日期完成' }
  const format = (field: string, v: unknown): string => {
    if (v == null || v === '') return '未设置'
    if (['parent_id', 'from_task_id', 'to_task_id'].includes(field)) return row.taskNames?.[String(v)] ?? '已删除任务'
    if (field === 'duration') return value.duration_unit === 'day' ? `${Number(v) / 1440} 天` : `${v} 分钟`
    if (field === 'duration_unit') return v === 'day' ? '天' : v === 'minute' ? '分钟' : String(v)
    if (field === 'auto_schedule') return v ? '自动' : '手动'
    if (field === 'constraint_type') return constraints[String(v)] ?? String(v)
    if (field === 'planningStatus') return v === 'stable' ? '稳定态' : '草稿态'
    if (field === 'type') return ['开始到开始（SS）', '开始到完成（SF）', '完成到开始（FS）', '完成到完成（FF）'][Number(v)] ?? String(v)
    if (field === 'lag') return `${v} 分钟`
    if (typeof v === 'boolean') return v ? '是' : '否'
    return typeof v === 'object' ? JSON.stringify(v) : String(v).replace('T00:00:00', '').replace('T', ' ')
  }
  return fields.filter(f => f in value).map(f => `${FIELD_LABELS[f] ?? ({ statusDate: '状态日期', planningStatus: '计划状态', customFields: '属性配置', planBaseline: '固定基线' } as Record<string, string>)[f] ?? f}：${format(f, value[f])}`).join('\n') || '保留记录'

}

/** Keep invalid merged hierarchy visible in review rather than silently orphaning tasks. */
export function reconciliationHierarchyIssues(plan: SaveBaseline): string[] {
  const tasks = new Map(plan.tasks.filter(t => !t.is_deleted).map(t => [t.id, t]))
  const issues: string[] = []
  for (const task of tasks.values()) {
    if (task.parent_id && !tasks.has(task.parent_id)) issues.push(`「${task.name}」的父任务已被删除，请核对父任务的保留选择。`)
    const seen = new Set([task.id]); let parent = task.parent_id
    while (parent && tasks.has(parent)) {
      if (seen.has(parent)) { issues.push(`「${task.name}」的父子关系形成循环，请核对层级选择。`); break }
      seen.add(parent); parent = tasks.get(parent)!.parent_id
    }
  }
  return [...new Set(issues)]
}
