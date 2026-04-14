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

const FIELD_LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期',
  duration: '工期', assignee: '责任人',
  is_milestone: '里程碑', parent_id: '父任务', order_index: '顺序',
}

function normalize(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = String(val)
  // ISO 日期带时区偏移时，需正确转换为本地日期（如 "2025-12-21T16:00:00.000Z" → "2025-12-22"）
  if (s.includes('T')) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    return s.split('T')[0]
  }
  return s
}

export function diffSnapshots(oldTasks: SnapshotTask[], newTasks: SnapshotTask[]): DiffItem[] {
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

  const compareFields = ['name', 'start_date', 'end_date', 'duration', 'assignee', 'is_milestone', 'order_index']
  for (const [code, newT] of newMap) {
    const oldT = oldMap.get(code)
    if (!oldT) continue

    const changes: { field: string; old: string; new: string }[] = []
    for (const f of compareFields) {
      const ov = normalize((oldT as unknown as Record<string, unknown>)[f])
      const nv = normalize((newT as unknown as Record<string, unknown>)[f])
      if (ov !== nv) {
        changes.push({
          field: FIELD_LABELS[f] ?? f,
          old: ov || '(空)',
          new: nv || '(空)',
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
