import type { Task, Dependency } from '../types'
import { buildTaskScheduleEdit, normalizeScheduleDate, scheduleDurationMinutes } from './clientTaskEdit'
import { runFullCascade } from './clientScheduling'
import { CONSTRAINT_TYPES, CONSTRAINT_NEEDS_DATE } from '../components/GanttChart/constants'
import { parseDateInput } from './clientDateInput'

export interface GridCell { taskId: string; col: string }

export function gridSelectionRect(rowIds: string[], columns: string[], anchor: GridCell, extent: GridCell = anchor) {
  const a = rowIds.indexOf(anchor.taskId), b = rowIds.indexOf(extent.taskId)
  const x = columns.indexOf(anchor.col), y = columns.indexOf(extent.col)
  if (Math.min(a, b, x, y) < 0) return null
  return { top: Math.min(a, b), bottom: Math.max(a, b), left: Math.min(x, y), right: Math.max(x, y) }
}

/** Convert explicit units to the project's input unit without silently rounding. */
function durationFromClipboard(value: string, isMinute: boolean): string | null {
  const match = value.normalize('NFKC').match(/^(\d+(?:\.\d+)?)\s*(天|日|d|days?|小时|h|hours?|分钟|分|m|mins?|minutes?)?$/i)
  if (!match) return null
  const unit = (match[2] ?? '').toLowerCase()
  const factor = /^(天|日|d|days?)$/.test(unit) ? 1440 : /^(小时|h|hours?)$/.test(unit) ? 60 : unit ? 1 : isMinute ? 1 : 1440
  const duration = Number(match[1]) * factor
  const input = duration / (isMinute ? 1 : 1440)
  return Number.isSafeInteger(duration) && Number.isSafeInteger(input) && input > 0 ? String(input) : null
}

/** Excel/Sheets plain-text clipboard, including quoted tabs and newlines. */
export function parseClipboardGrid(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '"' && (quoted || cell === '')) {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (c === '\t' || c === '\n')) {
      row.push(cell); cell = ''
      if (c === '\n') { rows.push(row); row = [] }
    } else cell += c
  }
  if (quoted) throw new Error('粘贴内容的引号不完整')
  if (cell !== '' || row.length || !rows.length) { row.push(cell); rows.push(row) }
  return rows
}

export function serializeClipboardGrid(rows: string[][]): string {
  return rows.map(row => row.map(value => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join('\t')).join('\r\n')
}

export function gridCellEditable(task: Task, col: string, tasks: Task[], deps: Dependency[]): boolean {
  if (['name', 'assignee'].includes(col)) return true
  if (tasks.some(t => !t.is_deleted && t.parent_id === task.id)) return false
  const type = deps.find(d => d.active !== false && d.to_task_id === task.id)?.type ?? -1
  if (col === 'start') return task.auto_schedule === false || type === 1 || type === 3
  if (col === 'end') return task.auto_schedule === false || [-1, 1, 3].includes(type)
  if (col === 'duration') return !task.is_milestone
  if (col === 'ctype') return task.auto_schedule !== false
  if (col === 'cdate') return task.auto_schedule !== false && CONSTRAINT_NEEDS_DATE.has(task.constraint_type ?? '')
  if (col === 'lag') return deps.some(d => d.to_task_id === task.id)
  return ['taskType', 'ddate', 'inactive', 'pred', 'succ'].includes(col)
}

/** Fill only the rows below the visible top row, using canonical source values. */
export function applyGridFillDown(tasks: Task[], deps: Dependency[], rowIds: string[], columns: string[], anchor: GridCell, extent: GridCell | null | undefined, isMinute: boolean) {
  const rect = gridSelectionRect(rowIds, columns, anchor, extent ?? anchor)
  if (!rect || rect.top === rect.bottom) throw new Error('请先选中至少两行单元格，首行为来源，其余行向下填充')
  if ((rect.bottom - rect.top + 1) * (rect.right - rect.left + 1) > 5000) throw new Error('一次最多填充 5000 个单元格，请缩小选区')
  const source = tasks.find(task => task.id === rowIds[rect.top] && !task.is_deleted)
  if (!source) throw new Error('来源任务不存在，请重新选择')
  const values = columns.slice(rect.left, rect.right + 1).map(col => {
    if (col === 'name') return source.name
    if (col === 'assignee') return source.assignee ?? ''
    if (col === 'duration') return source.duration == null ? '' : String(source.duration / (isMinute ? 1 : 1440))
    if (col === 'start' || col === 'end') return (col === 'start' ? source.start_date : source.end_date)?.slice(0, isMinute ? 16 : 10) ?? ''
    if (col === 'cdate' || col === 'ddate') return (col === 'cdate' ? source.constraint_date : source.deadline)?.slice(0, isMinute ? 16 : 10) ?? ''
    if (col === 'taskType') return source.auto_schedule === false ? '手动' : '自动'
    if (col === 'ctype') return source.constraint_type ?? 'asap'
    if (col === 'inactive') return source.inactive ? '是' : '否'
    if (col === 'lag') {
      const dep = deps.find(dep => dep.to_task_id === source.id)
      if (dep) return String((dep.lag ?? 0) / (isMinute ? 1 : 1440))
    }
    throw new Error('选区包含只读或不支持填充的列，请只选择可编辑单元格')
  })
  const start = { taskId: rowIds[rect.top], col: columns[rect.left] }
  const end = { taskId: rowIds[rect.bottom], col: columns[rect.right] }
  const result = applyGridPaste(tasks, deps, rowIds, columns, { ...start, taskId: rowIds[rect.top + 1] }, serializeClipboardGrid([values]), isMinute, end)
  return { ...result, selection: { start, end } }
}

export function applyGridPaste(tasks: Task[], deps: Dependency[], rowIds: string[], columns: string[], anchor: GridCell, text: string, isMinute: boolean, extent?: GridCell | null) {
  let grid = parseClipboardGrid(text)
  const rect = gridSelectionRect(rowIds, columns, anchor, extent ?? anchor)
  if (!rect) throw new Error('请先选中可见的目标单元格')
  const { top: startRow, left: startCol } = rect
  if (rect.bottom > startRow || rect.right > startCol) {
    const height = rect.bottom - startRow + 1, width = rect.right - startCol + 1
    const sourceWidth = grid[0].length
    if (height * width > 5000) throw new Error('一次最多粘贴 5000 个单元格，请缩小选区')
    if (!grid.some(row => row.length !== sourceWidth) && height % grid.length === 0 && width % sourceWidth === 0) {
      const source = grid
      grid = Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => source[row % source.length][col % sourceWidth]))
    }
  }
  if (grid.reduce((n, r) => n + r.length, 0) > 5000) throw new Error('一次最多粘贴 5000 个单元格，请分批粘贴或使用 Excel 导入')
  if (grid.length + startRow > rowIds.length || grid.some(r => r.length + startCol > columns.length)) throw new Error('粘贴范围超出可见任务或列，请调整目标位置')
  const byId = new Map(tasks.map(t => [t.id, { ...t }]))
  const nextDeps = deps.map(d => ({ ...d }))
  const editedIds: string[] = []
  for (let r = 0; r < grid.length; r++) {
    const task = byId.get(rowIds[startRow + r])!
    for (let c = 0; c < grid[r].length; c++) {
      const col = columns[startCol + c], value = grid[r][c].trim()
      const fail = (message: string): never => { throw new Error(`第 ${r + 1} 行、第 ${c + 1} 列：${message}`) }
      if ((col === 'start' || col === 'end') && !tasks.some(candidate => !candidate.is_deleted && candidate.parent_id === task.id)) {
        const field = col === 'start' ? 'start_date' : 'end_date'
        const parsed = parseDateInput(value, isMinute, Number((task[field] ?? '').slice(0, 4)) || new Date().getFullYear(), task[field])
        if (!parsed) fail('日期无效，应为年-月-日，可附带 HH:mm')
        if (normalizeScheduleDate(parsed, isMinute) === normalizeScheduleDate(task[field], isMinute)) continue
        // Explicit pasted dates follow bar movement: pin the user's dates.
        task.auto_schedule = false
      }
      if (!gridCellEditable(task, col, tasks, nextDeps)) fail('目标为只读或自动计算字段')
      if (col === 'name') { if (!value) fail('任务名称不能为空'); task.name = value }
      else if (col === 'assignee') task.assignee = value || null
      else if (['duration', 'start', 'end'].includes(col)) {
        const field = col === 'start' ? 'start_date' : col === 'end' ? 'end_date' : 'duration'
        const parsed = field === 'duration' ? durationFromClipboard(value, isMinute) : parseDateInput(value, isMinute, Number((task[field] ?? '').slice(0, 4)) || new Date().getFullYear(), task[field])
        if (parsed == null) fail(field === 'duration' ? `工期应为正整数${isMinute ? '分钟' : '天'}，也可填写明确单位` : '日期无效，应为年-月-日，可附带 HH:mm')
        const patch = buildTaskScheduleEdit(task, nextDeps, field, parsed!, isMinute)
        if (!Object.keys(patch).length) fail('日期或工期无效，请检查排程方式')
        Object.assign(task, patch)
      } else if (col === 'taskType') {
        if (!['自动', '手动', 'auto', 'manual'].includes(value)) fail('任务类型应为“自动”或“手动”')
        task.auto_schedule = value === '自动' || value === 'auto'
      } else if (col === 'ctype') {
        const type = CONSTRAINT_TYPES.find(t => t.value === value || t.label === value)
        if (!type) fail('未知限制类型')
        task.constraint_type = type!.value
        if (!type!.needsDate) task.constraint_date = null
      } else if (col === 'cdate' || col === 'ddate') {
        const parsed = value ? parseDateInput(value, isMinute) : ''
        const date = parsed ? normalizeScheduleDate(parsed, isMinute) : null
        if (value && !date) fail('日期无效')
        if (col === 'cdate') task.constraint_date = date
        else task.deadline = date
      } else if (col === 'inactive') {
        if (!['是', '否', 'true', 'false', '1', '0', ''].includes(value)) fail('无效标记应为“是”或“否”')
        task.inactive = ['是', 'true', '1'].includes(value)
      } else if (col === 'lag') {
        const n = Number(value)
        if (!Number.isInteger(n)) fail('延迟应为整数')
        nextDeps.find(d => d.to_task_id === task.id)!.lag = n * (isMinute ? 1 : 1440)
      } else fail('此列请使用任务编辑窗口修改')
    }
    const span = scheduleDurationMinutes(task.start_date, task.end_date, isMinute)
    if (span != null && span < (task.is_milestone ? 0 : 1)) throw new Error(`第 ${r + 1} 行：结束时间必须晚于开始时间`)
    if (CONSTRAINT_NEEDS_DATE.has(task.constraint_type ?? '') && !task.constraint_date) throw new Error(`第 ${r + 1} 行：请同时填写限制日期`)
    editedIds.push(task.id)
  }
  const next = tasks.map(t => byId.get(t.id)!)
  for (const task of runFullCascade(next, nextDeps, { isMinute })) byId.set(task.id, task)
  return { tasks: tasks.map(t => byId.get(t.id)!), dependencies: nextDeps, editedIds,
    selection: { start: { taskId: rowIds[startRow], col: columns[startCol] }, end: { taskId: rowIds[startRow + grid.length - 1], col: columns[startCol + Math.max(...grid.map(row => row.length)) - 1] } } }
}
