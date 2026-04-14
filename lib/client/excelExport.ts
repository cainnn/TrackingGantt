'use client'

import ExcelJS from 'exceljs'
import { saveAs } from 'file-saver'
import type { Task, Dependency, ProjectLine } from '@/types'

const DEP_TYPE_LABELS: Record<number, string> = { 0: 'SS', 1: 'SF', 2: 'FS', 3: 'FF' }
const CTYPE_LABELS: Record<string, string> = {
  none: '无',
  asap: '尽早',
  alap: '尽晚',
  muststarton: '必须于…开始',
  mustfinishon: '必须于…结束',
  startnoearlierthan: '不早于…开始',
  finishnoearlierthan: '不早于…结束',
  startnolaterthan: '不迟于…开始',
  finishnolaterthan: '不迟于…结束',
}

interface FlatTask { task: Task; level: number }

function flattenTasks(tasks: Task[]): FlatTask[] {
  const childrenMap = new Map<string | null, Task[]>()
  tasks.forEach(t => {
    const pid = t.parent_id ?? null
    if (!childrenMap.has(pid)) childrenMap.set(pid, [])
    childrenMap.get(pid)!.push(t)
  })
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
  const lags = incoming.map(d => d.lag ?? 0)
  if (lags.every(l => l === lags[0])) return lags[0]
  return lags.join(',')
}

// ── Column definitions ─────────────────────────────────────────────────
const COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: '任务编码', key: 'task_code', width: 12 },
  { header: '层级',     key: 'level',     width: 6 },
  { header: '父任务编码', key: 'parent_code', width: 12 },
  { header: '任务名称', key: 'name',      width: 30 },
  { header: '责任人',   key: 'assignee',  width: 12 },
  { header: '开始日期', key: 'start_date', width: 13 },
  { header: '结束日期', key: 'end_date',  width: 13 },
  { header: '工期',     key: 'duration',  width: 7 },
  { header: '里程碑',   key: 'milestone', width: 7 },
  { header: '自动排程', key: 'auto_schedule', width: 9 },
  { header: '前置依赖', key: 'predecessors', width: 22 },
  { header: '延迟',     key: 'lag',       width: 7 },
  { header: '完成度',   key: 'percent_done', width: 7 },
  { header: '限制类型', key: 'constraint_type', width: 12 },
  { header: '限制日期', key: 'constraint_date', width: 13 },
  { header: '汇总',     key: 'rollup',    width: 7 },
  { header: '非激活',   key: 'inactive',  width: 7 },
  { header: '项目边界', key: 'project_boundary', width: 10 },
  { header: '状态',     key: 'status',    width: 10 },
  { header: '复杂度',   key: 'complexity', width: 7 },
  { header: '基线结束', key: 'baseline_end_date', width: 13 },
  { header: '备注',     key: 'note',      width: 22 },
]

// ── Header style ───────────────────────────────────────────────────────
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
const HEADER_BORDER: Partial<ExcelJS.Borders> = {
  bottom: { style: 'thin', color: { argb: 'FF2F5496' } },
}

const SUMMARY_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, color: { argb: 'FF1F4E79' } }
const SUMMARY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } }
const LEAF_FONT: Partial<ExcelJS.Font> = { size: 10 }

function styleHeaderRow(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1)
  row.eachCell(cell => {
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.border = HEADER_BORDER
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  row.height = 22
}

// ── Build row data from a FlatTask ─────────────────────────────────────
function buildRowData(
  ft: FlatTask,
  deps: Dependency[],
  codeMap: Map<string, string>,
  parentCodeMap: Map<string, string>,
) {
  const t = ft.task
  return {
    task_code: t.task_code,
    level: ft.level,
    parent_code: parentCodeMap.get(t.id) ?? '',
    name: t.name,
    assignee: t.assignee ?? '',
    start_date: t.start_date?.split('T')[0] ?? '',
    end_date: t.end_date?.split('T')[0] ?? '',
    duration: t.duration ?? 0,
    milestone: t.is_milestone ? '是' : '否',
    auto_schedule: t.auto_schedule !== false ? '是' : '否',
    predecessors: formatPredecessors(t.id, deps, codeMap),
    lag: getPredecessorLag(t.id, deps),
    percent_done: t.percent_done ?? 0,
    constraint_type: t.constraint_type ? (CTYPE_LABELS[t.constraint_type] ?? t.constraint_type) : '',
    constraint_date: t.constraint_date?.split('T')[0] ?? '',
    rollup: t.rollup ? '是' : '否',
    inactive: t.inactive ? '是' : '否',
    project_boundary: t.project_boundary ?? '',
    status: t.status ?? '',
    complexity: t.complexity ?? '',
    baseline_end_date: t.baseline_end_date?.split('T')[0] ?? '',
    note: t.note ?? '',
  }
}

// ── Style a data row (parent=bold+fill, child=indent) ──────────────────
function styleDataRow(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  isSummary: boolean,
  level: number,
) {
  const row = ws.getRow(rowNum)
  const nameCell = row.getCell('name')

  if (isSummary) {
    row.eachCell(cell => {
      cell.font = SUMMARY_FONT
      cell.fill = SUMMARY_FILL
    })
  } else {
    row.eachCell(cell => {
      cell.font = LEAF_FONT
    })
  }

  // Indent task name by level (MS Project style: level 1=0 indent, 2=2 spaces, 3=4 spaces...)
  const indent = Math.max(level - 1, 0)
  if (indent > 0) {
    nameCell.alignment = { indent, vertical: 'middle' }
  }

  // Zebra striping for leaf rows
  if (!isSummary && rowNum % 2 === 0) {
    row.eachCell(cell => {
      if (!cell.fill || (cell.fill as ExcelJS.FillPattern).pattern === 'none') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
      }
    })
  }
}

// ── Populate a worksheet with task rows ────────────────────────────────
function populateSheet(
  ws: ExcelJS.Worksheet,
  flatTasks: FlatTask[],
  summaryIds: Set<string>,
  deps: Dependency[],
  codeMap: Map<string, string>,
  parentCodeMap: Map<string, string>,
) {
  ws.columns = COLUMNS as ExcelJS.Column[]
  styleHeaderRow(ws)

  for (const ft of flatTasks) {
    const data = buildRowData(ft, deps, codeMap, parentCodeMap)
    const row = ws.addRow(data)
    styleDataRow(ws, row.number, summaryIds.has(ft.task.id), ft.level)
  }

  // Freeze header row
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }]
}

// ── Filter flat tasks to keep only a subset + their ancestor hierarchy ─
function filterWithHierarchy(
  allFlat: FlatTask[],
  taskMap: Map<string, Task>,
  predicate: (t: Task) => boolean,
): FlatTask[] {
  // Collect IDs of tasks matching predicate
  const keep = new Set<string>()
  for (const ft of allFlat) {
    if (predicate(ft.task)) keep.add(ft.task.id)
  }
  // Walk up ancestors to keep hierarchy
  const ensureAncestors = (id: string) => {
    const t = taskMap.get(id)
    if (t?.parent_id && !keep.has(t.parent_id)) {
      keep.add(t.parent_id)
      ensureAncestors(t.parent_id)
    }
  }
  for (const id of [...keep]) ensureAncestors(id)

  return allFlat.filter(ft => keep.has(ft.task.id))
}

// ── Main export ────────────────────────────────────────────────────────
export async function exportToExcel(
  tasks: Task[],
  dependencies: Dependency[],
  projectName: string,
  statusDate?: string | null,
  projectLines?: ProjectLine[],
) {
  const activeTasks = tasks.filter(t => !t.is_deleted)
  const allFlat = flattenTasks(activeTasks)

  const codeMap = new Map<string, string>()
  activeTasks.forEach(t => codeMap.set(t.id, t.task_code))
  const parentCodeMap = new Map<string, string>()
  activeTasks.forEach(t => { if (t.parent_id) parentCodeMap.set(t.id, codeMap.get(t.parent_id) ?? '') })

  const summaryIds = new Set<string>()
  activeTasks.forEach(t => { if (t.parent_id) summaryIds.add(t.parent_id) })

  const taskMap = new Map<string, Task>()
  activeTasks.forEach(t => taskMap.set(t.id, t))

  const wb = new ExcelJS.Workbook()
  wb.creator = projectName
  wb.created = new Date()

  // ── Main sheet: all tasks ──────────────────────────────────────────
  const wsMain = wb.addWorksheet('任务')
  populateSheet(wsMain, allFlat, summaryIds, dependencies, codeMap, parentCodeMap)

  // ── Per-assignee sheets ────────────────────────────────────────────
  const assignees = new Set<string>()
  activeTasks.forEach(t => { if (t.assignee?.trim()) assignees.add(t.assignee!.trim()) })

  for (const assignee of assignees) {
    const filtered = filterWithHierarchy(allFlat, taskMap, t => t.assignee?.trim() === assignee)
    if (filtered.length === 0) continue
    // Sheet name max 31 chars, no special chars
    const sheetName = assignee.slice(0, 31).replace(/[\\/*?:\[\]]/g, '_')
    const ws = wb.addWorksheet(sheetName)
    populateSheet(ws, filtered, summaryIds, dependencies, codeMap, parentCodeMap)
  }

  // ── Project settings sheet ─────────────────────────────────────────
  const hasStatusDate = !!statusDate
  const hasProjectLines = projectLines && projectLines.length > 0
  if (hasStatusDate || hasProjectLines) {
    const ws2 = wb.addWorksheet('项目设置')
    ws2.columns = [
      { header: '类型', key: 'type', width: 12 },
      { header: '名称', key: 'name', width: 22 },
      { header: '日期', key: 'date', width: 13 },
      { header: '颜色', key: 'color', width: 12 },
      { header: '可见', key: 'visible', width: 7 },
    ]
    styleHeaderRow(ws2)

    if (hasStatusDate) {
      ws2.addRow({ type: '状态日期', name: '状态日期', date: statusDate!.split('T')[0], color: '', visible: '' })
    }
    if (hasProjectLines) {
      for (const pl of projectLines!) {
        ws2.addRow({
          type: '项目线',
          name: pl.name,
          date: pl.line_date?.split('T')[0] ?? '',
          color: pl.color,
          visible: pl.visible ? '是' : '否',
        })
      }
    }
  }

  // ── Save ───────────────────────────────────────────────────────────
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  saveAs(blob, `${projectName || '甘特图'}_${new Date().toISOString().split('T')[0]}.xlsx`)
}
