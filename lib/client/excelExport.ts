'use client'

import * as XLSX from 'xlsx'
import type { Task, Dependency, ProjectLine } from '@/types'

const DEP_TYPE_LABELS: Record<number, string> = { 0: 'SS', 1: 'SF', 2: 'FS', 3: 'FF' }

interface FlatTask { task: Task; level: number }

function flattenTasks(tasks: Task[]): FlatTask[] {
  const childrenMap = new Map<string | null, Task[]>()
  tasks.forEach(t => {
    const pid = t.parent_id ?? null
    if (!childrenMap.has(pid)) childrenMap.set(pid, [])
    childrenMap.get(pid)!.push(t)
  })
  // sort children by order_index
  childrenMap.forEach(arr => arr.sort((a, b) => a.order_index - b.order_index))

  const result: FlatTask[] = []
  function walk(parentId: string | null, level: number) {
    const children = childrenMap.get(parentId) ?? []
    for (const t of children) {
      result.push({ task: t, level })
      walk(t.id, level + 1)
    }
  }
  walk(null, 1)
  return result
}

function formatPredecessors(taskId: string, deps: Dependency[], codeMap: Map<string, string>): string {
  const incoming = deps.filter(d => d.to_task_id === taskId)
  if (incoming.length === 0) return ''
  return incoming.map(d => {
    const code = codeMap.get(d.from_task_id) ?? d.from_task_id.slice(0, 8)
    const typeLabel = DEP_TYPE_LABELS[d.type] ?? 'FS'
    const lagStr = d.lag > 0 ? `+${d.lag}d` : d.lag < 0 ? `${d.lag}d` : ''
    return `${code}${typeLabel}${lagStr}`
  }).join(',')
}

function getPredecessorLag(taskId: string, deps: Dependency[]): number | string {
  const incoming = deps.filter(d => d.to_task_id === taskId)
  if (incoming.length === 0) return ''
  // If all deps have same lag, show single value; otherwise show comma-separated
  const lags = incoming.map(d => d.lag ?? 0)
  if (lags.every(l => l === lags[0])) return lags[0]
  return lags.join(',')
}

export function exportToExcel(
  tasks: Task[],
  dependencies: Dependency[],
  projectName: string,
  statusDate?: string | null,
  projectLines?: ProjectLine[],
) {
  const flatTasks = flattenTasks(tasks.filter(t => !t.is_deleted))
  const codeMap = new Map<string, string>()
  tasks.forEach(t => codeMap.set(t.id, t.task_code))
  const parentCodeMap = new Map<string, string>()
  tasks.forEach(t => { if (t.parent_id) parentCodeMap.set(t.id, codeMap.get(t.parent_id) ?? '') })

  const rows = flatTasks.map(({ task: t, level }) => ({
    '任务编码': t.task_code,
    '层级': level,
    '父任务编码': parentCodeMap.get(t.id) ?? '',
    '任务名称': t.name,
    '责任人': t.assignee ?? '',
    '开始日期': t.start_date?.split('T')[0] ?? '',
    '结束日期': t.end_date?.split('T')[0] ?? '',
    '工期': t.duration ?? 0,
    '里程碑': t.is_milestone ? '是' : '否',
    '自动排程': t.auto_schedule !== false ? '是' : '否',
    '前置依赖': formatPredecessors(t.id, dependencies, codeMap),
    '延迟': getPredecessorLag(t.id, dependencies),
    '备注': t.note ?? '',
  }))

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)

  // Set column widths
  ws['!cols'] = [
    { wch: 10 }, // 任务编码
    { wch: 5 },  // 层级
    { wch: 10 }, // 父任务编码
    { wch: 25 }, // 任务名称
    { wch: 10 }, // 责任人
    { wch: 12 }, // 开始日期
    { wch: 12 }, // 结束日期
    { wch: 6 },  // 工期
    { wch: 6 },  // 里程碑
    { wch: 8 },  // 自动排程
    { wch: 20 }, // 前置依赖
    { wch: 6 },  // 延迟
    { wch: 20 }, // 备注
  ]

  XLSX.utils.book_append_sheet(wb, ws, '任务')

  // Incremental: project settings sheet (status_date + project_lines)
  const hasStatusDate = !!statusDate
  const hasProjectLines = projectLines && projectLines.length > 0
  if (hasStatusDate || hasProjectLines) {
    const settingsRows: Record<string, string>[] = []
    if (hasStatusDate) {
      settingsRows.push({ '类型': '状态日期', '名称': '状态日期', '日期': statusDate!.split('T')[0], '颜色': '', '可见': '' })
    }
    if (hasProjectLines) {
      for (const pl of projectLines!) {
        settingsRows.push({
          '类型': '项目线',
          '名称': pl.name,
          '日期': pl.line_date?.split('T')[0] ?? '',
          '颜色': pl.color,
          '可见': pl.visible ? '是' : '否',
        })
      }
    }
    const ws2 = XLSX.utils.json_to_sheet(settingsRows)
    ws2['!cols'] = [{ wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 6 }]
    XLSX.utils.book_append_sheet(wb, ws2, '项目设置')
  }

  XLSX.writeFile(wb, `${projectName || '甘特图'}_${new Date().toISOString().split('T')[0]}.xlsx`)
}
