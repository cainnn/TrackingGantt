import type { TaskLifecycleEvent } from '../types'

const LABELS: Record<string, string> = {
  name: '任务名称', start_date: '开始日期', end_date: '结束日期', duration: '工期',
  assignee: '责任人', percent_done: '完成度', is_milestone: '里程碑', note: '备注',
  order_index: '排序', constraint_type: '限制类型', constraint_date: '限制日期', deadline: '截止日期',
}

export function describeLifecycleChange(event: TaskLifecycleEvent, isMinute: boolean): string {
  const field = event.field_name ?? ''
  const label = LABELS[field]
  if (label && (event.event_type === 'updated' || event.event_type === 'moved')) {
    const format = (value: string | null) => {
      if (value == null || value === '') return '(空)'
      if (['start_date', 'end_date', 'constraint_date', 'deadline'].includes(field)) {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/)
        if (match) return isMinute ? `${match[1]} ${match[2] ?? '00:00'}` : match[1]
      }
      return value
    }
    return `${label}：${format(event.old_value)} → ${format(event.new_value)}`
  }
  if (event.event_type === 'created') return '创建任务'
  if (event.event_type === 'deleted') return '删除任务'
  // 父级移动等旧记录仍保留操作说明，仅去掉当前任务的重复名称和编号。
  return event.description.replace(/^任务「[\s\S]*?」[（(][^）)]*[）)]\s*/, '')
}
