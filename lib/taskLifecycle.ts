import type { PoolClient } from 'pg'
import type { TaskLifecycleEvent } from '../types'
import type { DiffItem } from './versionDiff'

export function normalizeChangeReason(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

export interface LifecycleInput {
  taskId: string; taskCode: string; projectId: string; userId: string
  event_type: string; field_name?: string | null
  old_value?: string | null; new_value?: string | null
  description: string
  reason?: unknown
}

export async function addLifecycleBatch(client: PoolClient, events: LifecycleInput[]) {
  if (!events.length) return
  const values: unknown[] = []
  const rows = events.map((event, i) => {
    values.push(event.taskId, event.taskCode, event.projectId, event.event_type,
      event.field_name ?? null, event.old_value ?? null, event.new_value ?? null,
      event.description, event.userId, normalizeChangeReason(event.reason))
    return `(${Array.from({ length: 10 }, (_, j) => `$${i * 10 + j + 1}`).join(',')})`
  })
  await client.query(
    `INSERT INTO task_lifecycle
       (task_id, task_code, project_id, event_type, field_name, old_value, new_value, description, created_by, reason)
     VALUES ${rows.join(',')}`,
    values,
  )
}

export async function addLifecycle(client: PoolClient, event: LifecycleInput) {
  await addLifecycleBatch(client, [event])
}

export interface LifecycleVersion {
  created_at: string
  created_by: string | null
  task_matches: boolean
  changes: { diffs?: DiffItem[] } | null
}

type StoredEvent = TaskLifecycleEvent & { created_by: string | null }
const FIELD_LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期',
  duration: '工期', assignee: '责任人', is_milestone: '里程碑',
  order_index: '顺序', note: '备注',
}

function comparable(field: string, value: string | null, isMinute: boolean): string {
  if (!value || value === '(空)') return ''
  if (field === 'start_date' || field === 'end_date') {
    return isMinute ? value.replace('T', ' ').slice(0, 16) : value.slice(0, 10)
  }
  if (field === 'duration') return value.replace(/\s|天|分钟/g, '')
  if (field === 'is_milestone') return value === '是' || value === 'true' ? 'true' : 'false'
  return value
}

// 旧日志没有原因列值时，仅使用紧随其后的版本中同一任务、同一操作人、
// 同一字段且前后值一致的原因；重复变更无法唯一对应时保持“未记录”。
export function resolveLifecycleReasons(
  events: StoredEvent[], versions: LifecycleVersion[], isMinute: boolean,
): TaskLifecycleEvent[] {
  const sorted = [...versions].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return events.map(event => {
    const storedReason = normalizeChangeReason(event.reason)
    if (storedReason) return { ...event, reason: storedReason }
    const index = sorted.findIndex(version => version.created_at >= event.created_at)
    const version = sorted[index]
    if (!version?.task_matches || version.created_by !== event.created_by) return { ...event, reason: null }
    const field = event.field_name ?? ''
    if (!FIELD_LABELS[field] || !['updated', 'moved'].includes(event.event_type)) return { ...event, reason: null }
    const matches = (version.changes?.diffs ?? []).filter(diff =>
      diff.task_code === event.task_code && diff.type === 'changed' && normalizeChangeReason(diff.reason)
      && diff.changes?.some(change => change.field === FIELD_LABELS[field]
        && comparable(field, change.old, isMinute) === comparable(field, event.old_value, isMinute)
        && comparable(field, change.new, isMinute) === comparable(field, event.new_value, isMinute)),
    )
    const previousAt = sorted[index - 1]?.created_at
    const duplicates = events.filter(other => other.task_id === event.task_id
      && other.field_name === event.field_name && other.created_by === event.created_by
      && other.created_at <= version.created_at && (!previousAt || other.created_at > previousAt)
      && comparable(field, other.old_value, isMinute) === comparable(field, event.old_value, isMinute)
      && comparable(field, other.new_value, isMinute) === comparable(field, event.new_value, isMinute))
    return {
      ...event,
      reason: matches.length === 1 && duplicates.length === 1 ? normalizeChangeReason(matches[0].reason) : null,
    }
  })
}
