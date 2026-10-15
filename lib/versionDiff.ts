export interface SnapshotTask {
  id: string
  task_code: string
  name: string
  start_date: string | null
  end_date: string | null
  duration: number | null
  assignee: string | null
  percent_done: number
  is_milestone: boolean
  auto_schedule?: boolean | null
  note?: string | null
  parent_id: string | null
  order_index?: number | null
}

export interface DiffItem {
  task_code: string
  task_name: string
  type: 'added' | 'removed' | 'changed'
  changes?: { field: string; old: string; new: string }[]
  reason?: string
}

export interface DiffOptions {
  isMinute?: boolean
}

const FIELD_LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期',
  duration: '工期', assignee: '责任人',
  is_milestone: '里程碑', auto_schedule: '任务类型', parent_id: '父任务', order_index: '顺序',
  note: '备注',
}

function normalizeDateTime(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = String(val)
  // 分钟级：归一化为 'YYYY-MM-DD HH:mm'（避免同日不同时间被误判为无变更）
  if (s.includes('T') || s.includes(' ')) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
             `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
    if (m) return `${m[1]} ${m[2]}`
    return s.split(/[T ]/)[0]
  }
  return s
}

function normalizeDayDate(val: unknown): string {
  const normalized = normalizeDateTime(val)
  return normalized ? normalized.slice(0, 10) : ''
}

function normalizeDayDuration(val: unknown): string {
  if (val === null || val === undefined || val === '') return ''
  const n = Number(val)
  if (!Number.isFinite(n)) return String(val)
  const days = Math.abs(n) >= 1440 ? Math.round(n / 1440) : Math.round(n)
  return String(days)
}

function normalizeField(field: string, val: unknown, opts: DiffOptions): { compare: string; display: string } {
  if (field === 'note') {
    const text = val == null ? '' : String(val)
    return { compare: text, display: text }
  }
  if (field === 'auto_schedule') {
    const isAuto = val !== false
    const label = isAuto ? '自动' : '手动'
    return { compare: label, display: label }
  }

  if (!opts.isMinute) {
    if (field === 'start_date' || field === 'end_date') {
      const day = normalizeDayDate(val)
      return { compare: day, display: day }
    }
    if (field === 'duration') {
      const days = normalizeDayDuration(val)
      return { compare: days, display: days ? `${days}天` : '' }
    }
  }

  const normalized = normalizeDateTime(val)
  return { compare: normalized, display: normalized }
}

export function diffSnapshots(oldTasks: SnapshotTask[], newTasks: SnapshotTask[], opts: DiffOptions = {}): DiffItem[] {
  const oldMap = new Map(oldTasks.map(t => [t.task_code, t]))
  const newMap = new Map(newTasks.map(t => [t.task_code, t]))
  const result: DiffItem[] = []

  for (const [code, t] of newMap) {
    if (!oldMap.has(code)) {
      result.push({ task_code: code, task_name: t.name, type: 'added' })
    }
  }

  for (const [code, t] of oldMap) {
    if (!newMap.has(code)) {
      result.push({ task_code: code, task_name: t.name, type: 'removed' })
    }
  }

  const compareFields = ['name', 'start_date', 'end_date', 'duration', 'assignee', 'is_milestone', 'auto_schedule', 'order_index', 'note']
  for (const [code, newT] of newMap) {
    const oldT = oldMap.get(code)
    if (!oldT) continue

    const changes: { field: string; old: string; new: string }[] = []
    for (const f of compareFields) {
      const ov = normalizeField(f, (oldT as unknown as Record<string, unknown>)[f], opts)
      const nv = normalizeField(f, (newT as unknown as Record<string, unknown>)[f], opts)
      if (ov.compare !== nv.compare) {
        changes.push({
          field: FIELD_LABELS[f] ?? f,
          old: ov.display || '(空)',
          new: nv.display || '(空)',
        })
      }
    }
    if (changes.length > 0) {
      result.push({ task_code: code, task_name: newT.name, type: 'changed', changes })
    }
  }

  const order = { added: 0, changed: 1, removed: 2 }
  result.sort((a, b) => order[a.type] - order[b.type] || a.task_code.localeCompare(b.task_code, undefined, { numeric: true }))
  return result
}
