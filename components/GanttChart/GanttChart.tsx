'use client'

import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setSelectedIds, setTasks, updateTasks, addTasks, deleteTasks,
  addDependency, removeDependency, updateDependency, saveSnapshot,
  copyTasks,
} from '@/store/slices/tasksSlice'
import type { Task, Dependency } from '@/types'
import EditTaskModal from './EditTaskModal'
import { markDirty } from '@/store/slices/tasksSlice'
import { authFetch } from '@/lib/client/authFetch'

// ─── Layout constants ──────────────────────────────────────────────────────
const ROW_H    = 40
const DEF_COLW = 28
const HDR_H1   = 30
const HDR_H2   = 22
const HDR_H    = HDR_H1 + HDR_H2
const BAR_H    = 20
const BAR_TOP  = (ROW_H - BAR_H) / 2

// ─── Left-panel columns ────────────────────────────────────────────────────
const COL_NUM    =  52
const COL_CHECK  =  32
const COL_NAME   = 160
const COL_ASSIGN =  72
const COL_PCT    =  48
const COL_DUR    =  48
const COL_START  =  80
const COL_END    =  80
const COL_PRED   =  56
const COL_SUCC   =  56
const COL_DTYPE  =  56
const MIN_NAME_W   = 60

// Optional column keys (编号 and 任务名称 are always shown)
export type OptionalCol = 'assignee' | 'pct' | 'duration' | 'start' | 'end' | 'pred' | 'succ' | 'dtype'
export const OPTIONAL_COL_META: { key: OptionalCol; label: string; width: number }[] = [
  { key: 'assignee', label: '责任人', width: COL_ASSIGN },
  { key: 'pct',      label: '完成',   width: COL_PCT },
  { key: 'duration', label: '工期',   width: COL_DUR },
  { key: 'start',    label: '开始时间', width: COL_START },
  { key: 'end',      label: '完成时间', width: COL_END },
  { key: 'pred',     label: '前置',   width: COL_PRED },
  { key: 'succ',     label: '后续',   width: COL_SUCC },
  { key: 'dtype',    label: '类型',   width: COL_DTYPE },
]
export const DEFAULT_VISIBLE_COLS: OptionalCol[] = ['assignee', 'pct', 'start', 'duration', 'pred', 'dtype']
const INIT_LEFT_W = COL_NUM + COL_CHECK + COL_NAME + DEFAULT_VISIBLE_COLS.reduce((s, k) => s + (OPTIONAL_COL_META.find(c => c.key === k)?.width ?? 0), 0)

// ─── Date helpers ──────────────────────────────────────────────────────────
const sod      = (d: Date) => { const r=new Date(d); r.setHours(0,0,0,0); return r }
const addDays  = (d: Date, n: number) => { const r=new Date(d); r.setDate(r.getDate()+n); return r }
const diffDays = (a: Date, b: Date) => Math.round((sod(b).getTime()-sod(a).getTime())/86_400_000)
const fmtDate  = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const fmtWeek  = (d: Date) => d.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })

function timeBasedPercent(task: Task, statusDate: Date | null): number {
  if (!statusDate || !task.start_date || !task.end_date) return task.percent_done ?? 0
  const start = sod(new Date(task.start_date))
  const end   = sod(new Date(task.end_date))
  const sd    = sod(statusDate)
  if (sd >= end)   return 100
  if (sd <= start) return 0
  const total = end.getTime()  - start.getTime()
  if (total <= 0)  return 100  // start === end 时视为已完成，防止除零
  const done  = sd.getTime()   - start.getTime()
  return Math.round((done / total) * 100)
}

// ─── Flat tree row ─────────────────────────────────────────────────────────
interface FlatRow { task: Task; level: number; hasChildren: boolean; expanded: boolean }

// ─── Dependency cascade helper ─────────────────────────────────────────────
function getDownstreamIds(taskId: string, deps: Dependency[]): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  function walk(id: string) {
    deps.filter(d => d.from_task_id === id).forEach(d => {
      if (!visited.has(d.to_task_id)) {
        visited.add(d.to_task_id)
        result.push(d.to_task_id)
        walk(d.to_task_id)
      }
    })
  }
  walk(taskId)
  return result
}

/** 递归收集某任务的所有后代 ID（子、孙…） */
function getDescendantIds(taskId: string, tasks: Task[]): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  function walk(pid: string) {
    tasks.forEach(t => {
      if (t.parent_id === pid && !visited.has(t.id)) {
        visited.add(t.id)
        result.push(t.id)
        walk(t.id)
      }
    })
  }
  walk(taskId)
  return result
}

// ─── Drag / connect state ──────────────────────────────────────────────────
type DragMode = 'move' | 'resize-left' | 'resize-right'
interface DragState {
  taskId: string; mode: DragMode
  startMouseX: number; origStart: Date; origEnd: Date
  dragging: boolean
}
interface ConnectState {
  fromTaskId: string; fromX: number; fromY: number; curX: number; curY: number
}

// ─── Props ─────────────────────────────────────────────────────────────────
interface Props {
  projectId: string
  statusDate?: string | null
  colW?: number
  searchQuery?: string
  expandAllSignal?: number
  collapseAllSignal?: number
  focusSignal?: number
  showCriticalPath?: boolean
  visibleCols?: OptionalCol[]
  readOnly?: boolean
  showComparison?: boolean
}

export default function GanttChart({
  projectId, statusDate,
  colW: colWProp,
  searchQuery = '',
  expandAllSignal = 0,
  collapseAllSignal = 0,
  focusSignal = 0,
  showCriticalPath = false,
  visibleCols = DEFAULT_VISIBLE_COLS,
  readOnly = false,
  showComparison = true,
}: Props) {
  const dispatch    = useAppDispatch()
  const tasks       = useAppSelector(s => s.tasks.tasks)
  const deps        = useAppSelector(s => s.tasks.dependencies)
  const selectedIds = useAppSelector(s => s.tasks.selectedIds)
  const clipboard   = useAppSelector(s => s.tasks.clipboard)
  const comparison  = useAppSelector(s => s.tasks.comparison)
  const diffFilter  = useAppSelector(s => s.tasks.diffFilter)
  const currentProject = useAppSelector(s => s.project.currentProject)
  const projectLines   = useAppSelector(s => s.projectLines.lines)

  const colW = colWProp ?? DEF_COLW
  const prevColWRef = useRef(colW)

  // ── Expand/collapse ────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState<Record<string,boolean>>({})
  useEffect(() => {
    if (!tasks.length) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = true })
    setExpanded(m)
  }, [tasks.length])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Expand / Collapse all signals ──────────────────────────────────────
  useEffect(() => {
    if (!expandAllSignal) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = true })
    setExpanded(m)
  }, [expandAllSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!collapseAllSignal) return
    const m: Record<string,boolean> = {}
    tasks.forEach(t => { m[t.id] = false })
    setExpanded(m)
  }, [collapseAllSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Name editing ───────────────────────────────────────────────────────
  const [editId, setEditId]     = useState<string|null>(null)
  const [editName, setEditName] = useState('')
  const nameInputRef            = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editId) nameInputRef.current?.select() }, [editId])

  // ── Drag state ─────────────────────────────────────────────────────────
  const [drag, setDrag]           = useState<DragState|null>(null)
  const [previewMap, setPreviewMap] = useState<Record<string,Task>>({})

  // ── 版本对比映射（按 ID 查找对比版本中的任务） ─────────────────────────
  const comparisonMap = useMemo(() => {
    if (!comparison?.tasks?.length) return new Map<string, Task>()
    return new Map(comparison.tasks.map(t => [t.id, t]))
  }, [comparison])

  // 摘要任务集合（有子任务的任务不可直接拖动，日期由子任务决定）
  const summarySet = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => { if (t.parent_id) s.add(t.parent_id) })
    return s
  }, [tasks])

  // 缓存下游任务ID列表，避免重复计算
  const downstreamCache = useMemo(() => {
    const cache = new Map<string, string[]>()
    tasks.forEach(t => {
      cache.set(t.id, getDownstreamIds(t.id, deps))
    })
    return cache
  }, [tasks, deps])

  // ── Dependency connect ─────────────────────────────────────────────────
  const [connect, setConnect]     = useState<ConnectState|null>(null)
  const [hoveredBar, setHoveredBar] = useState<string|null>(null)
  const [selectedDep, setSelectedDep] = useState<string|null>(null)

  // ── Row reorder drag ────────────────────────────────────────────────────
  const [rowDrag, setRowDrag] = useState<{ taskId: string; startY: number; dragging: boolean }|null>(null)
  const [dropIdx, setDropIdx] = useState<number|null>(null)

  // ── Context menu ────────────────────────────────────────────────────────
  interface CtxMenu { x: number; y: number; taskId: string; submenu: 'add' | 'delete-dep' | 'add-dep' | null; subX?: number; subY?: number }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu|null>(null)

  // ── Cell editing ────────────────────────────────────────────────────────
  interface CellEdit { taskId: string; field: 'assignee' | 'duration' | 'start_date' | 'end_date'; value: string }
  const [cellEdit, setCellEdit] = useState<CellEdit | null>(null)

  // ── Panel resize / collapse ─────────────────────────────────────────────
  const [panelW, setPanelW]           = useState(INIT_LEFT_W)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [splitterDrag, setSplitterDrag] = useState<{ startX: number; startW: number } | null>(null)
  const prevPanelW = useRef(INIT_LEFT_W)

  // ── Name column resize (independent of panel splitter) ──────────────────
  const [nameW, setNameW] = useState(COL_NAME)
  const [nameDrag, setNameDrag] = useState<{ startX: number; startW: number } | null>(null)

  // ── Predecessor popup ────────────────────────────────────────────────────
  const [predPopup, setPredPopup] = useState<{ taskId: string; x: number; y: number } | null>(null)
  const [predFilter, setPredFilter] = useState('')

  // ── Post-create edit modal ───────────────────────────────────────────────
  const [editModalTaskId, setEditModalTaskId] = useState<string | null>(null)

  // ── Column visibility (from props) ──────────────────────────────────────
  // Dynamic panel width based on visible columns
  const FIXED_COLS_W = useMemo(() =>
    COL_NUM + COL_CHECK + OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).reduce((s, c) => s + c.width, 0),
    [visibleCols])
  const LEFT_W_DYN = useMemo(() => FIXED_COLS_W + COL_NAME, [FIXED_COLS_W])

  // Auto-adjust panel width when visible columns change
  useEffect(() => {
    setPanelW(LEFT_W_DYN)
  }, [LEFT_W_DYN])

  // ── Column sort & filter ────────────────────────────────────────────────
  type SortDir = 'asc' | 'desc' | null
  type SortCol = 'assignee' | 'duration' | null
  type DropdownCol = 'assignee' | 'duration' | 'dtype' | null
  const [sortCol, setSortCol] = useState<SortCol>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [filterAssignee, setFilterAssignee] = useState<string | null>(null)
  const [filterDtype, setFilterDtype] = useState<string | null>(null)
  const [colDropdown, setColDropdown] = useState<DropdownCol>(null)
  const colDropdownRef = useRef<HTMLDivElement>(null)

  const toggleSort = useCallback((col: SortCol) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc')
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null) }
      else setSortDir('asc')
    } else {
      setSortCol(col); setSortDir('asc')
    }
  }, [sortCol, sortDir])

  // 所有不重复的责任人列表
  const assigneeList = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => { if (t.assignee) s.add(t.assignee) })
    return [...s].sort()
  }, [tasks])

  // 关闭列下拉菜单
  useEffect(() => {
    if (!colDropdown) return
    const close = (e: MouseEvent) => {
      if (colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) setColDropdown(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [colDropdown])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [ctxMenu])

  useEffect(() => {
    if (!predPopup) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPredPopup(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [predPopup])

  const svgRef         = useRef<SVGSVGElement>(null)
  const leftRef        = useRef<HTMLDivElement>(null)
  const rightRef       = useRef<HTMLDivElement>(null)
  const rightHeaderRef = useRef<HTMLDivElement>(null)
  const scrollHLock    = useRef(false)

  const syncTimelineScrollLeft = useCallback((sl: number) => {
    scrollHLock.current = true
    if (rightRef.current) rightRef.current.scrollLeft = sl
    if (rightHeaderRef.current) rightHeaderRef.current.scrollLeft = sl
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  // ── Zoom: keep viewport center stable ─────────────────────────────────
  // 用 ref 缓存任务日期范围（天数偏移），避免声明顺序问题
  const taskRangeRef = useRef<{ minDay: number; maxDay: number; totalDays: number }>({ minDay: 0, maxDay: 60, totalDays: 60 })

  // ── Sync scroll: vertical sync between left and right panels ──
  const scrollVLock = useRef(false)

  const onLeftBodyScroll = useCallback(() => {
    if (scrollVLock.current) return
    if (!leftRef.current || !rightRef.current) return
    scrollVLock.current = true
    rightRef.current.scrollTop = leftRef.current.scrollTop
    requestAnimationFrame(() => { scrollVLock.current = false })
  }, [])

  const onRightBodyScroll = useCallback(() => {
    if (!rightRef.current || !leftRef.current) return
    if (!scrollVLock.current) {
      scrollVLock.current = true
      leftRef.current.scrollTop = rightRef.current.scrollTop
      requestAnimationFrame(() => { scrollVLock.current = false })
    }
    if (scrollHLock.current) return
    scrollHLock.current = true
    if (rightHeaderRef.current)
      rightHeaderRef.current.scrollLeft = rightRef.current.scrollLeft
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  const onRightHeaderScroll = useCallback(() => {
    if (!rightHeaderRef.current || !rightRef.current) return
    if (scrollHLock.current) return
    scrollHLock.current = true
    rightRef.current.scrollLeft = rightHeaderRef.current.scrollLeft
    requestAnimationFrame(() => { scrollHLock.current = false })
  }, [])

  // ── Flat row list ───────────────────────────────────────────────────────
  const flatRows = useMemo((): FlatRow[] => {
    const kids: Record<string,Task[]> = {}
    tasks.forEach(t => {
      // 防止自引用
      if (t.parent_id === t.id) { if (!kids['__root__']) kids['__root__']=[]; kids['__root__'].push(t); return }
      const k = t.parent_id ?? '__root__'
      if (!kids[k]) kids[k]=[]
      kids[k].push(t)
    })
    const rows: FlatRow[] = []
    const visited = new Set<string>()
    function walk(pid: string|null, lvl: number) {
      const key = pid ?? '__root__'
      ;(kids[key]??[]).sort((a,b)=>a.order_index-b.order_index).forEach(t => {
        if (visited.has(t.id)) return // 防止循环引用
        visited.add(t.id)
        const has = !!(kids[t.id]?.length)
        rows.push({ task:t, level:lvl, hasChildren:has, expanded:expanded[t.id]??true })
        if (has && (expanded[t.id]??true)) walk(t.id, lvl+1)
      })
    }
    walk(null,0)
    return rows
  }, [tasks, expanded])

  // ── WBS numbering + sequential index ─────────────────────────────────────
  const { wbsMap, seqMap } = useMemo(() => {
    const wbs = new Map<string, string>()
    const seq = new Map<string, number>()
    const kids: Record<string, Task[]> = {}
    tasks.forEach(t => {
      const k = (t.parent_id && t.parent_id !== t.id) ? t.parent_id : '__root__'
      if (!kids[k]) kids[k] = []
      kids[k].push(t)
    })
    let counter = 0
    const visited = new Set<string>()
    function walk(pid: string | null, prefix: string) {
      const key = pid ?? '__root__'
      const sorted = (kids[key] ?? []).slice().sort((a, b) => a.order_index - b.order_index)
      sorted.forEach((t, i) => {
        if (visited.has(t.id)) return
        visited.add(t.id)
        const w = prefix ? `${prefix}.${i + 1}` : String(i + 1)
        wbs.set(t.id, w)
        seq.set(t.id, ++counter)
        walk(t.id, w)
      })
    }
    walk(null, '')
    return { wbsMap: wbs, seqMap: seq }
  }, [tasks])

  // ── Date range ──────────────────────────────────────────────────────────
  const { origin, totalDays } = useMemo(() => {
    if (!tasks.length) {
      const o=sod(new Date()); o.setDate(o.getDate()-o.getDay())
      return { origin:o, totalDays:60 }
    }
    let mn=new Date(9999,0,1), mx=new Date(2000,0,1)
    tasks.forEach(t=>{
      if (t.start_date){const d=new Date(t.start_date); if(d<mn)mn=d}
      if (t.end_date)  {const d=new Date(t.end_date);   if(d>mx)mx=d}
    })
    const o=sod(mn); o.setDate(o.getDate()-o.getDay()-60)
    return { origin:o, totalDays:diffDays(o, addDays(sod(mx),21)) }
  }, [tasks])

  const dateToX = useCallback((d:Date)=>diffDays(origin,d)*colW, [origin, colW])

  // ── 更新任务日期范围缓存 + 缩放居中 ────────────────────────────────────
  useEffect(() => {
    let mn = Infinity, mx = -Infinity
    tasks.forEach(t => {
      if (t.start_date) { const d = diffDays(origin, sod(new Date(t.start_date))); if (d < mn) mn = d }
      if (t.end_date)   { const d = diffDays(origin, sod(new Date(t.end_date)));   if (d > mx) mx = d }
    })
    taskRangeRef.current = { minDay: mn === Infinity ? 0 : mn, maxDay: mx === -Infinity ? totalDays : mx, totalDays }
  }, [tasks, origin, totalDays])

  useEffect(() => {
    const prev = prevColWRef.current
    if (prev === colW) return
    prevColWRef.current = colW
    const el = rightRef.current
    if (!el) return
    const viewW = el.clientWidth
    // 缩放时保持状态日期（或今天）居中
    const target = statusDate ? sod(new Date(statusDate)) : sod(new Date())
    const targetX = diffDays(origin, target) * colW
    syncTimelineScrollLeft(Math.max(0, targetX - viewW / 2))
  }, [colW, syncTimelineScrollLeft, statusDate, origin])

  // ── Initial scroll: center on status date or today ─────────────────────
  const scrolledForProject = useRef<string>('')
  useEffect(() => {
    if (scrolledForProject.current === projectId || !tasks.length) return
    // statusDate === undefined means project data hasn't loaded yet; wait for it
    if (statusDate === undefined) return
    scrolledForProject.current = projectId
    const target = statusDate ? sod(new Date(statusDate)) : sod(new Date())
    const x = dateToX(target)
    requestAnimationFrame(() => {
      const vw = rightRef.current?.clientWidth ?? 600
      syncTimelineScrollLeft(Math.max(0, x - vw / 3))
    })
  }, [tasks.length, statusDate, dateToX, syncTimelineScrollLeft, projectId])

  // ── Display rows: apply previewMap + search filter ──────────────────────
  const displayRows = useMemo((): FlatRow[] => {
    const withPreview = Object.keys(previewMap).length
      ? flatRows.map(r => previewMap[r.task.id] ? { ...r, task: previewMap[r.task.id] } : r)
      : flatRows
    let rows = withPreview

    // 安全地向上遍历祖先链并加入 matched，防止循环引用
    const addAncestors = (t: Task, matched: Set<string>) => {
      const seen = new Set<string>()
      let cur: Task | undefined = t
      while (cur?.parent_id) {
        if (matched.has(cur.parent_id) || seen.has(cur.parent_id)) break
        seen.add(cur.parent_id)
        matched.add(cur.parent_id)
        cur = tasks.find(x => x.id === cur!.parent_id)
      }
    }

    // 搜索过滤
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matched = new Set<string>()
      tasks.forEach(t => {
        if (t.name.toLowerCase().includes(q)) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 责任人筛选
    if (filterAssignee !== null) {
      const matched = new Set<string>()
      tasks.forEach(t => {
        if ((t.assignee ?? '') === filterAssignee) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 类型筛选
    if (filterDtype !== null) {
      const matched = new Set<string>()
      tasks.forEach(t => {
        const incoming = deps.filter(d => d.to_task_id === t.id)
        const dtype = incoming.length > 0 ? String(incoming[0].type) : (t.auto_schedule === false ? 'manual' : 'empty')
        if (dtype === filterDtype) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 差异筛选：只显示版本对比中变更的任务
    if (diffFilter?.taskCodes?.length) {
      const codes = new Set(diffFilter.taskCodes)
      const matched = new Set<string>()
      tasks.forEach(t => {
        if (codes.has(t.task_code)) {
          matched.add(t.id)
          addAncestors(t, matched)
        }
      })
      rows = rows.filter(r => matched.has(r.task.id))
    }

    // 排序（保持树形结构：仅对同层级兄弟排序）
    if (sortCol && sortDir) {
      const getSortVal = (t: Task): number | string => {
        if (sortCol === 'duration') return t.duration ?? 0
        if (sortCol === 'assignee') return t.assignee ?? ''
        return 0
      }
      const cmp = (a: Task, b: Task): number => {
        const va = getSortVal(a), vb = getSortVal(b)
        const r = typeof va === 'number' && typeof vb === 'number'
          ? va - vb : String(va).localeCompare(String(vb))
        return sortDir === 'desc' ? -r : r
      }
      // 按层级分组排序后重建
      const sortedRows: FlatRow[] = []
      let i = 0
      while (i < rows.length) {
        const lvl = rows[i].level
        // 收集同父级的连续兄弟
        const siblings: FlatRow[][] = []
        while (i < rows.length && rows[i].level >= lvl) {
          if (rows[i].level === lvl) {
            const group: FlatRow[] = [rows[i]]
            const j = i + 1
            // 收集此兄弟下的所有子行
            let k = j
            while (k < rows.length && rows[k].level > lvl) k++
            for (let m = j; m < k; m++) group.push(rows[m])
            siblings.push(group)
            i = k
          } else {
            i++
          }
        }
        // 按排序字段对兄弟块排序
        siblings.sort((a, b) => cmp(a[0].task, b[0].task))
        siblings.forEach(g => sortedRows.push(...g))
      }
      return sortedRows
    }

    return rows
  }, [flatRows, previewMap, searchQuery, tasks, deps, filterAssignee, filterDtype, diffFilter, sortCol, sortDir])

  // ── Row index map (based on displayed rows for arrow positioning) ────────
  const rowIdx = useMemo(() => {
    const m: Record<string,number>={}
    displayRows.forEach((r,i)=>{ m[r.task.id]=i })
    return m
  }, [displayRows])

  // ── 序号 map for predecessor display（覆盖所有任务） ────
  const flatRowIdx = useMemo(() => {
    const m: Record<string, string> = {}
    for (const [id, num] of seqMap) {
      m[id] = String(num)
    }
    return m
  }, [seqMap])

  // ── Project start date（用于"空"类型任务的自动对齐）──────────────────────
  const projectStartDate = useMemo(() => {
    if (currentProject?.start_date) return currentProject.start_date.split('T')[0]
    // Fallback: earliest task start date
    const starts = tasks.filter(t => t.start_date).map(t => sod(new Date(t.start_date!)))
    if (starts.length === 0) return fmtDate(sod(new Date()))
    return fmtDate(new Date(Math.min(...starts.map(x => x.getTime()))))
  }, [currentProject?.start_date, tasks])

  const defaultStart = useMemo(() => {
    let d = new Date(projectStartDate)
    if (statusDate) {
      const sd = sod(new Date(statusDate))
      if (sd > d) d = sd
    }
    return fmtDate(d)
  }, [projectStartDate, statusDate])

  // ── 关键路径计算（正推 + 反推，浮动=0 的任务即为关键路径） ─────────────────
  const criticalSet = useMemo((): Set<string> => {
    if (!showCriticalPath) return new Set()

    // 只考虑叶子任务（非摘要）且有完整日期
    const leafTasks = tasks.filter(t =>
      t.start_date && t.end_date && t.duration != null && !summarySet.has(t.id)
    )
    if (leafTasks.length === 0) return new Set()

    // 构建任务信息映射
    const info = new Map<string, { dur: number; es: number; ef: number; ls: number; lf: number }>()
    for (const t of leafTasks) {
      info.set(t.id, { dur: t.duration ?? 0, es: 0, ef: 0, ls: 0, lf: 0 })
    }

    // 前置依赖和后继依赖索引
    const preds = new Map<string, Array<{ fromId: string; type: number; lag: number }>>()
    const succs = new Map<string, Array<{ toId: string; type: number; lag: number }>>()
    for (const d of deps) {
      if (!info.has(d.from_task_id) || !info.has(d.to_task_id)) continue
      if (!preds.has(d.to_task_id)) preds.set(d.to_task_id, [])
      preds.get(d.to_task_id)!.push({ fromId: d.from_task_id, type: d.type ?? 2, lag: d.lag ?? 0 })
      if (!succs.has(d.from_task_id)) succs.set(d.from_task_id, [])
      succs.get(d.from_task_id)!.push({ toId: d.to_task_id, type: d.type ?? 2, lag: d.lag ?? 0 })
    }

    // 拓扑排序（基于依赖关系）
    const inDegree = new Map<string, number>()
    for (const id of info.keys()) inDegree.set(id, 0)
    for (const [toId, predList] of preds) {
      inDegree.set(toId, predList.length)
    }
    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }
    const topoOrder: string[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      topoOrder.push(cur)
      for (const s of (succs.get(cur) ?? [])) {
        const nd = (inDegree.get(s.toId) ?? 1) - 1
        inDegree.set(s.toId, nd)
        if (nd === 0) queue.push(s.toId)
      }
    }

    // 正推（Forward Pass）：计算 ES, EF
    for (const id of topoOrder) {
      const t = info.get(id)!
      let es = 0
      for (const p of (preds.get(id) ?? [])) {
        const pi = info.get(p.fromId)!
        let required = 0
        if (p.type === 2)      required = pi.ef + p.lag        // FS
        else if (p.type === 0) required = pi.es + p.lag        // SS
        else if (p.type === 3) required = pi.ef + p.lag - t.dur // FF
        else if (p.type === 1) required = pi.es + p.lag - t.dur // SF
        if (required > es) es = required
      }
      t.es = es
      t.ef = es + t.dur
    }

    // 项目最晚结束时间
    let projectEnd = 0
    for (const t of info.values()) {
      if (t.ef > projectEnd) projectEnd = t.ef
    }

    // 反推（Backward Pass）：计算 LS, LF
    // 无后继任务：LF = projectEnd（项目最晚结束时间）
    // 有后继任务：LF 由后继约束决定，初始化为 Infinity 以便后续取最小值
    const tasksWithSuccessors = new Set<string>()
    for (const [id] of succs) {
      if ((succs.get(id) ?? []).length > 0) tasksWithSuccessors.add(id)
    }
    for (const [id, t] of info) {
      if (tasksWithSuccessors.has(id)) {
        t.lf = Infinity
        t.ls = Infinity
      } else {
        t.lf = projectEnd
        t.ls = projectEnd - t.dur
      }
    }
    for (let i = topoOrder.length - 1; i >= 0; i--) {
      const id = topoOrder[i]
      const t = info.get(id)!
      for (const s of (succs.get(id) ?? [])) {
        const si = info.get(s.toId)!
        let constraint = projectEnd
        if (s.type === 2)      constraint = si.ls - s.lag        // FS: LF_pred <= LS_succ - lag
        else if (s.type === 0) constraint = si.ls - s.lag + t.dur // SS: LS_pred <= LS_succ - lag
        else if (s.type === 3) constraint = si.lf - s.lag        // FF: LF_pred <= LF_succ - lag
        else if (s.type === 1) constraint = si.lf - s.lag + t.dur // SF: LS_pred <= LF_succ - lag
        if (constraint < t.lf) {
          t.lf = constraint
          t.ls = t.lf - t.dur
        }
      }
    }

    // 浮动 = LS - ES，浮动为 0 的任务在关键路径上
    const result = new Set<string>()
    for (const [id, t] of info) {
      const totalFloat = t.ls - t.es
      if (Math.abs(totalFloat) < 0.001) result.add(id)
    }
    return result
  }, [showCriticalPath, tasks, deps, summarySet])

  // ── 摘要任务进度（所有后代叶子任务按工期加权的完成度） ──────────────
  const statusDateObj = useMemo(() => statusDate ? sod(new Date(statusDate)) : null, [statusDate])
  const summaryProgressMap = useMemo(() => {
    const map = new Map<string, number>()
    if (summarySet.size === 0) return map
    // 收集每个摘要任务的所有后代叶子（防止循环引用）
    function getLeafDescendants(parentId: string, visited?: Set<string>): Task[] {
      const seen = visited ?? new Set<string>()
      if (seen.has(parentId)) return []
      seen.add(parentId)
      const leaves: Task[] = []
      const children = tasks.filter(t => t.parent_id === parentId && !t.is_deleted)
      for (const c of children) {
        if (summarySet.has(c.id)) {
          leaves.push(...getLeafDescendants(c.id, seen))
        } else {
          leaves.push(c)
        }
      }
      return leaves
    }
    for (const sid of summarySet) {
      const leaves = getLeafDescendants(sid)
      if (leaves.length === 0) { map.set(sid, 0); continue }
      let totalDur = 0, weightedSum = 0
      for (const t of leaves) {
        const dur = t.duration ?? 1
        totalDur += dur
        weightedSum += dur * timeBasedPercent(t, statusDateObj)
      }
      map.set(sid, totalDur > 0 ? Math.round(weightedSum / totalDur) : 0)
    }
    return map
  }, [tasks, summarySet, statusDateObj])


  // ── SVG mouse position helper ───────────────────────────────────────────
  const getSvgX = useCallback((clientX:number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    return rect ? clientX - rect.left : 0
  }, [])

  // ── Focus on selected task ──────────────────────────────────────────────
  useEffect(() => {
    if (!focusSignal || selectedIds.length === 0) return
    const taskId = selectedIds[0]
    const rowI = rowIdx[taskId]
    if (rowI !== undefined && leftRef.current)
      leftRef.current.scrollTop = Math.max(0, rowI * ROW_H - 80)
    const task = tasks.find(t => t.id === taskId)
    if (task?.start_date && rightRef.current) {
      const x = dateToX(new Date(task.start_date))
      syncTimelineScrollLeft(Math.max(0, x - 200))
    }
  }, [focusSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bar drag: mousedown ─────────────────────────────────────────────────
  const onBarMouseDown = useCallback((e: React.MouseEvent, task: Task) => {
    if (readOnly) return
    if (!task.start_date || !task.end_date) return
    e.stopPropagation(); e.preventDefault()
    setSelectedDep(null)

    const isSummary = summarySet.has(task.id)

    // 摘要任务只允许整体平移（move），不允许 resize
    let mode: DragMode = 'move'
    if (!isSummary) {
      // 根据鼠标位置判断操作类型（扩大边缘热区到15px）
      const taskX = dateToX(new Date(task.start_date))
      const taskW = dateToX(new Date(task.end_date)) - taskX
      const mouseX = getSvgX(e.clientX)
      const EDGE_SIZE = 15

      if (mouseX < taskX + EDGE_SIZE) {
        mode = 'resize-left'
      } else if (mouseX > taskX + taskW - EDGE_SIZE) {
        mode = 'resize-right'
      }

      // auto_schedule 任务根据依赖类型限制拖动方向
      if (task.auto_schedule !== false) {
        const incoming = deps.filter(d => d.to_task_id === task.id)
        const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1
        if (depType === 3 || depType === 1) {
          if (mode !== 'resize-left') return
        } else {
          if (mode !== 'resize-right') return
        }
      }
    }

    setDrag({
      taskId: task.id, mode,
      startMouseX: getSvgX(e.clientX),
      origStart: new Date(task.start_date),
      origEnd:   new Date(task.end_date),
      dragging: false,
    })
    setPreviewMap({ [task.id]: { ...task } })
  }, [getSvgX, dateToX, summarySet, deps, readOnly])

  // ── Connect handle: mousedown ───────────────────────────────────────────
  const onConnectMouseDown = useCallback((e: React.MouseEvent, task: Task, rowI: number) => {
    if (readOnly) return
    if (!task.end_date) return
    // 父级任务不允许依赖
    if (summarySet.has(task.id)) return
    e.stopPropagation(); e.preventDefault()
    const x = dateToX(new Date(task.end_date))
    const y = rowI * ROW_H + ROW_H / 2
    setConnect({ fromTaskId: task.id, fromX:x, fromY:y, curX:x, curY:y })
  }, [dateToX, summarySet, readOnly])

  // ── Row drag handle: mousedown ──────────────────────────────────────────
  const onRowDragStart = useCallback((e: React.MouseEvent, taskId: string) => {
    if (readOnly) return
    // 不阻止默认行为和冒泡，让 click 事件能正常触发（选中行）
    // 只记录拖动起点，超过阈值后才真正进入拖动模式
    setRowDrag({ taskId, startY: e.clientY, dragging: false })
  }, [readOnly])

  // ── Escape 取消拖拽 ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (drag || connect)) {
        setDrag(null)
        setPreviewMap({})
        setConnect(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drag, connect])

  // ── 节流函数：限制setState频率，提高性能 ───────────────────────────────
  const throttleTimer = useRef<NodeJS.Timeout | null>(null)
  const throttledSetPreview = useCallback((map: Record<string, Task>) => {
    if (throttleTimer.current) return
    setPreviewMap(map)
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null
    }, 16) // 60fps
  }, [])

  // ── Global mousemove ────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const svgX = getSvgX(e.clientX)

      if (drag) {
        const dx = svgX - drag.startMouseX

        // 只有鼠标移动超过4像素才开始真正拖动
        if (!drag.dragging && Math.abs(dx) > 4) {
          setDrag(prev => prev ? { ...prev, dragging: true } : null)
        }

        // 只有在真正拖动时才更新日期
        if (drag.dragging) {
          const days = Math.round(dx / colW)
          const orig = tasks.find(t => t.id === drag.taskId)
          if (!orig) return

          const isSummaryDrag = summarySet.has(drag.taskId)

          // ── 摘要任务拖动：整体平移所有后代 ──
          if (isSummaryDrag) {
            const descendantIds = getDescendantIds(drag.taskId, tasks)
            const descendantSet = new Set(descendantIds)
            const effectiveDays = days

            const map: Record<string, Task> = {}
            const localStart = new Map<string, Date>()
            const localEnd   = new Map<string, Date>()

            // 初始化所有任务的原始日期
            tasks.forEach(t => {
              if (t.start_date) localStart.set(t.id, sod(new Date(t.start_date)))
              if (t.end_date)   localEnd.set(t.id, sod(new Date(t.end_date)))
            })

            // 平移所有后代
            for (const did of descendantIds) {
              const dt = tasks.find(t => t.id === did)
              if (!dt?.start_date || !dt?.end_date) continue
              const s = addDays(sod(new Date(dt.start_date)), effectiveDays)
              const e = addDays(sod(new Date(dt.end_date)), effectiveDays)
              localStart.set(did, s)
              localEnd.set(did, e)
              map[did] = { ...dt, start_date: fmtDate(s), end_date: fmtDate(e), duration: diffDays(s, e) }
            }

            // 级联子树外部的下游依赖
            // 收集子树中所有任务的下游（排除子树内部的）
            const externalDownstream = new Set<string>()
            for (const did of descendantIds) {
              const ds = downstreamCache.get(did) || []
              for (const d of ds) {
                if (!descendantSet.has(d)) externalDownstream.add(d)
              }
            }
            const extIds = [...externalDownstream]
            let changed = true, iter = 0
            while (changed && iter++ < extIds.length + 1) {
              changed = false
              for (const toId of extIds) {
                const t = tasks.find(x => x.id === toId)
                if (!t || !t.start_date || !t.end_date) continue
                const incoming = deps.filter(d => d.to_task_id === toId)
                if (incoming.length === 0 && t.auto_schedule === false) continue
                let maxRS: Date | null = null
                for (const dep of incoming) {
                  const pS = localStart.get(dep.from_task_id)
                  const pE = localEnd.get(dep.from_task_id)
                  if (!pS || !pE) continue
                  const lag = dep.lag ?? 0
                  const dt2 = dep.type ?? 2
                  let rs: Date
                  if (dt2 === 2)      rs = addDays(pE, lag)
                  else if (dt2 === 0) rs = addDays(pS, lag)
                  else if (dt2 === 3) { const dur = diffDays(localStart.get(toId)!, localEnd.get(toId)!); rs = addDays(pE, lag - dur) }
                  else                { const dur = diffDays(localStart.get(toId)!, localEnd.get(toId)!); rs = addDays(pS, lag - dur) }
                  if (!maxRS || rs > maxRS) maxRS = rs
                }
                if (!maxRS) continue
                const curS = localStart.get(toId)!
                if (curS.getTime() === maxRS.getTime()) continue
                const shift = diffDays(curS, maxRS)
                const s = addDays(curS, shift)
                let eNew = addDays(localEnd.get(toId)!, shift)
                if (t.is_milestone) eNew = s
                if (eNew < s) eNew = s
                localStart.set(toId, s)
                localEnd.set(toId, eNew)
                map[toId] = { ...t, start_date: fmtDate(s), end_date: fmtDate(eNew), duration: diffDays(s, eNew) }
                changed = true
              }
            }

            // 更新摘要任务日期（包括被拖的摘要任务本身及其祖先）
            const refreshSummary = (pid: string | null) => {
              const seen = new Set<string>()
              let curPid = pid
              while (curPid && !seen.has(curPid)) {
                seen.add(curPid)
                const children = tasks.filter(c => c.parent_id === curPid)
                if (children.length === 0) break
                let minS: string | null = null, maxE: string | null = null
                for (const c of children) {
                  const ct = map[c.id] ?? c
                  const s = ct.start_date?.split('T')[0] ?? null
                  const e2 = ct.end_date?.split('T')[0] ?? null
                  if (s && (!minS || s < minS)) minS = s
                  if (e2 && (!maxE || e2 > maxE)) maxE = e2
                }
                if (minS && maxE) {
                  const p = tasks.find(x => x.id === curPid)
                  if (p) map[curPid] = { ...p, start_date: minS, end_date: maxE, duration: diffDays(sod(new Date(minS)), sod(new Date(maxE))) }
                }
                curPid = tasks.find(x => x.id === curPid)?.parent_id ?? null
              }
            }
            // 从被拖摘要任务开始往上刷新
            refreshSummary(drag.taskId)
            // 从外部级联影响到的任务的父级也刷新
            for (const id of Object.keys(map)) {
              const tk = tasks.find(x => x.id === id)
              if (tk?.parent_id && !descendantSet.has(tk.parent_id) && tk.parent_id !== drag.taskId) {
                refreshSummary(tk.parent_id)
              }
            }

            throttledSetPreview(map)
          } else {
          // ── 普通叶子任务拖动（原有逻辑） ──
          let newStart = drag.origStart, newEnd = drag.origEnd
          let cascadeDays = days

          if (drag.mode === 'move') {
            newStart = addDays(drag.origStart, days)
            newEnd   = addDays(drag.origEnd,   days)
            cascadeDays = diffDays(drag.origStart, newStart)
          } else if (drag.mode === 'resize-right') {
            newEnd = addDays(drag.origEnd, days)
            if (newEnd <= newStart) newEnd = addDays(newStart, 1)
            cascadeDays = diffDays(drag.origEnd, newEnd)
          } else if (drag.mode === 'resize-left') {
            newStart = addDays(drag.origStart, days)
            if (newStart >= newEnd) newStart = addDays(newEnd, -1)
            cascadeDays = 0
          }

          const map: Record<string, Task> = {
            [orig.id]: {
              ...orig,
              start_date: fmtDate(newStart),
              end_date:   fmtDate(newEnd),
              duration:   diffDays(newStart, newEnd),
            },
          }

          // ── 级联更新：迭代式处理所有依赖类型(SS/SF/FS/FF)和传递链 ──
          const localStart = new Map<string, Date>()
          const localEnd   = new Map<string, Date>()
          localStart.set(drag.taskId, newStart)
          localEnd.set(drag.taskId, newEnd)
          tasks.forEach(t => {
            if (t.start_date && !localStart.has(t.id)) localStart.set(t.id, sod(new Date(t.start_date)))
            if (t.end_date && !localEnd.has(t.id))     localEnd.set(t.id, sod(new Date(t.end_date)))
          })

          const downstreamIds = downstreamCache.get(drag.taskId) || []
          let changed = true, iter = 0
          while (changed && iter++ < downstreamIds.length + 1) {
            changed = false
            for (const toId of downstreamIds) {
              const t = tasks.find(x => x.id === toId)
              if (!t || !t.start_date || !t.end_date) continue

              const incoming = deps.filter(d => d.to_task_id === toId)
              if (incoming.length === 0 && t.auto_schedule === false) continue
              let maxRequiredStart: Date | null = null

              for (const dep of incoming) {
                const predStart = localStart.get(dep.from_task_id)
                const predEnd   = localEnd.get(dep.from_task_id)
                if (!predStart || !predEnd) continue
                const lag = dep.lag ?? 0
                const depType = dep.type ?? 2

                let requiredStart: Date
                if (depType === 2) {
                  requiredStart = addDays(predEnd, lag)
                } else if (depType === 0) {
                  requiredStart = addDays(predStart, lag)
                } else if (depType === 3) {
                  const curS = localStart.get(toId)!
                  const curE = localEnd.get(toId)!
                  const dur = diffDays(curS, curE)
                  requiredStart = addDays(predEnd, lag - dur)
                } else {
                  const curS = localStart.get(toId)!
                  const curE = localEnd.get(toId)!
                  const dur = diffDays(curS, curE)
                  requiredStart = addDays(predStart, lag - dur)
                }

                if (!maxRequiredStart || requiredStart > maxRequiredStart) {
                  maxRequiredStart = requiredStart
                }
              }

              if (!maxRequiredStart) continue

              const curStart = localStart.get(toId)!
              if (curStart.getTime() === maxRequiredStart.getTime()) continue
              {
                const shift = diffDays(curStart, maxRequiredStart)
                const s = addDays(curStart, shift)
                let e = addDays(localEnd.get(toId)!, shift)
                if (t.is_milestone) e = s
                if (e < s) e = s
                localStart.set(toId, s)
                localEnd.set(toId, e)
                map[toId] = { ...t, start_date: fmtDate(s), end_date: fmtDate(e), duration: diffDays(s, e) }
                changed = true
              }
            }
          }

          // ── 更新摘要任务（父任务）日期范围 ──
          const affectedParents = new Set<string>()
          for (const id of Object.keys(map)) {
            const tk = tasks.find(x => x.id === id)
            if (tk?.parent_id) affectedParents.add(tk.parent_id)
          }
          for (const pid of affectedParents) {
            let curPid: string | null = pid
            const seen = new Set<string>()
            while (curPid && !seen.has(curPid)) {
              seen.add(curPid)
              const children = tasks.filter(c => c.parent_id === curPid)
              if (children.length === 0) break
              let minS: string | null = null
              let maxE: string | null = null
              for (const c of children) {
                const ct = map[c.id] ?? c
                const s = ct.start_date?.split('T')[0] ?? null
                const e2 = ct.end_date?.split('T')[0] ?? null
                if (s && (!minS || s < minS)) minS = s
                if (e2 && (!maxE || e2 > maxE)) maxE = e2
              }
              if (minS && maxE) {
                const parent = tasks.find(x => x.id === curPid)
                if (parent) {
                  map[curPid] = {
                    ...parent,
                    start_date: minS,
                    end_date: maxE,
                    duration: diffDays(sod(new Date(minS)), sod(new Date(maxE))),
                  }
                }
              }
              curPid = tasks.find(x => x.id === curPid)?.parent_id ?? null
            }
          }

          throttledSetPreview(map)
          } // end else (非摘要任务)
        }
      }

      if (connect) {
        const rect = svgRef.current?.getBoundingClientRect()
        const y = rect ? e.clientY - rect.top : connect.curY
        setConnect(prev => prev ? { ...prev, curX:svgX, curY:y } : null)
      }

      if (rowDrag) {
        if (!rowDrag.dragging && Math.abs(e.clientY - rowDrag.startY) > 4)
          setRowDrag(prev => prev ? { ...prev, dragging: true } : null)
        if (rowDrag.dragging) {
          const rect = leftRef.current?.getBoundingClientRect()
          if (rect) {
            const rel = e.clientY - rect.top + (leftRef.current?.scrollTop ?? 0)
            setDropIdx(Math.min(Math.max(0, Math.round(rel / ROW_H)), flatRows.length))
          }
        }
      }

      if (splitterDrag) {
        const newW = Math.max(COL_NUM + COL_CHECK + nameW, Math.min(900, splitterDrag.startW + e.clientX - splitterDrag.startX))
        setPanelW(newW)
        if (panelCollapsed) setPanelCollapsed(false)
      }

      if (nameDrag) {
        const delta = e.clientX - nameDrag.startX
        const maxNameW = (panelCollapsed ? 0 : panelW) - COL_NUM - COL_CHECK - 6
        setNameW(Math.max(MIN_NAME_W, Math.min(maxNameW, nameDrag.startW + delta)))
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [drag, connect, rowDrag, flatRows.length, tasks, deps, getSvgX, colW, splitterDrag, panelCollapsed, throttledSetPreview, downstreamCache, nameDrag])

  // ── Global mouseup ──────────────────────────────────────────────────────
  useEffect(() => {
    const onUp = async (e: MouseEvent) => {
      if (drag) {
        // 清理节流定时器
        if (throttleTimer.current) {
          clearTimeout(throttleTimer.current)
          throttleTimer.current = null
        }

        let updatedList = drag.dragging ? Object.values(previewMap) : []
        setDrag(null)
        setPreviewMap({})

        const isSummaryDrag = summarySet.has(drag.taskId)

        // 保留完整列表用于乐观UI更新（包含摘要任务）
        const allUpdated = [...updatedList]

        if (updatedList.length > 0 && isSummaryDrag) {
          // ── 摘要任务拖动提交：只提交非摘要后代 + 外部级联任务（服务端自动重算摘要日期）
          updatedList = updatedList.filter(t => !summarySet.has(t.id))
        } else if (updatedList.length > 0 && !isSummaryDrag) {
          // ── 普通叶子任务拖动提交（原有逻辑）
          const draggedTask = tasks.find(t => t.id === drag.taskId)
          if (draggedTask && draggedTask.auto_schedule !== false) {
            const dragged = updatedList.find(t => t.id === drag.taskId)
            const incoming = deps.filter(d => d.to_task_id === drag.taskId)
            const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1

            if (depType === 3 || depType === 1) {
              const fixedEnd = draggedTask.end_date!
              const newStart = dragged?.start_date ?? draggedTask.start_date
              const newDur = newStart ? diffDays(new Date(newStart), new Date(fixedEnd)) : (draggedTask.duration ?? 0)
              updatedList = [{
                ...draggedTask,
                start_date: newStart,
                end_date: fixedEnd,
                duration: Math.max(newDur, 1),
              }]
            } else {
              const hasIncoming = incoming.length > 0
              const fixedStart = hasIncoming ? draggedTask.start_date! : (dragged?.start_date ?? draggedTask.start_date!)
              const newEnd = dragged?.end_date ?? draggedTask.end_date
              const newDur = newEnd ? diffDays(new Date(fixedStart), new Date(newEnd)) : (draggedTask.duration ?? 0)
              updatedList = [{
                ...draggedTask,
                start_date: fixedStart,
                end_date: newEnd,
                duration: Math.max(newDur, 1),
              }]
            }
          }
        }

        if (updatedList.length > 0) {
          dispatch(saveSnapshot())
          // 乐观更新UI：包含摘要任务（保持界面一致），但只标记非摘要任务为脏（服务端自动重算摘要日期）
          const optimistic = isSummaryDrag ? allUpdated : updatedList
          dispatch(updateTasks(optimistic))
          dispatch(markDirty(updatedList.map(t => t.id)))
        }
      }

      if (connect) {
        const svgX = getSvgX(e.clientX)
        const rect = svgRef.current?.getBoundingClientRect()
        const svgY = rect ? e.clientY - rect.top : 0
        const rowI = Math.floor(svgY / ROW_H)
        const toRow = flatRows[rowI]

        if (toRow && toRow.task.id !== connect.fromTaskId) {
          const toTask = toRow.task
          // 父级任务不允许依赖
          if (toTask.start_date && !summarySet.has(toTask.id) && !summarySet.has(connect.fromTaskId)) {
            const tx = dateToX(new Date(toTask.start_date))
            const twRaw = toTask.end_date ? dateToX(new Date(toTask.end_date))-tx : colW
            const tw = Math.max(twRaw, BAR_H)  // 里程碑最小命中区域 = 钻石大小
            const hitX = toTask.is_milestone ? tx - BAR_H/2 : tx  // 钻石中心偏移
            if (svgX >= hitX && svgX <= hitX+tw) {
              const dup = deps.some(d => d.from_task_id===connect.fromTaskId && d.to_task_id===toTask.id)
              if (!dup) {
                dispatch(saveSnapshot())
                const tempId = `temp-${Date.now()}-${connect.fromTaskId}-${toTask.id}`
                dispatch(addDependency({ id: tempId, project_id: projectId, from_task_id: connect.fromTaskId, to_task_id: toTask.id, type: 2, lag: 0 }))
                // 添加依赖时，后继任务自动切换为自动排程
                if (toTask.auto_schedule === false) {
                  dispatch(updateTasks([{ ...toTask, auto_schedule: true }]))
                  dispatch(markDirty([toTask.id]))
                }
                const res = await authFetch(`/api/dependencies/${projectId}`, {
                  method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({ from_task_id:connect.fromTaskId, to_task_id:toTask.id }),
                })
                const text = await res.text()
                let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
                try { data = text ? JSON.parse(text) : {} } catch { dispatch(removeDependency(tempId)); data = {} }
                if (data.ok && data.value) {
                  const v = data.value as { dependency?: Dependency; updatedTasks?: Task[] }
                  dispatch(removeDependency(tempId))
                  if (v.dependency) dispatch(addDependency(v.dependency))
                  if (Array.isArray(v.updatedTasks) && v.updatedTasks.length > 0)
                    dispatch(updateTasks(v.updatedTasks))
                } else {
                  dispatch(removeDependency(tempId))
                }
              }
            }
          }
        }
        setConnect(null)
      }

      if (rowDrag) {
        if (rowDrag.dragging && dropIdx !== null) {
          const dIdx = flatRows.findIndex(r => r.task.id === rowDrag.taskId)
          if (dIdx !== -1 && dropIdx !== dIdx && dropIdx !== dIdx + 1) {
            const dTask = flatRows[dIdx].task
            const without = flatRows.filter((_, i) => i !== dIdx)
            const adj = dropIdx > dIdx ? dropIdx - 1 : dropIdx

            const newPid: string | null = adj < without.length
              ? without[adj].task.parent_id
              : without.length > 0 ? without[without.length - 1].task.parent_id : null

            const insertAt = without.slice(0, adj).filter(r => r.task.parent_id === newPid).length

            const siblings = tasks
              .filter(t => t.parent_id === newPid && t.id !== dTask.id)
              .sort((a, b) => a.order_index - b.order_index)

            const newGroup = [
              ...siblings.slice(0, insertAt),
              { ...dTask, parent_id: newPid },
              ...siblings.slice(insertAt),
            ]

            const updates: Array<{ id: string; parent_id: string | null; order_index: number }> = []
            newGroup.forEach((t, i) => {
              const orig = tasks.find(o => o.id === t.id)!
              if (orig.parent_id !== t.parent_id || orig.order_index !== i)
                updates.push({ id: t.id, parent_id: t.parent_id, order_index: i })
            })

            if (dTask.parent_id !== newPid) {
              tasks
                .filter(t => t.parent_id === dTask.parent_id && t.id !== dTask.id)
                .sort((a, b) => a.order_index - b.order_index)
                .forEach((t, i) => {
                  if (t.order_index !== i)
                    updates.push({ id: t.id, parent_id: t.parent_id, order_index: i })
                })
            }

            if (updates.length > 0) {
              dispatch(saveSnapshot())
              dispatch(updateTasks(updates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))))
              dispatch(markDirty(updates.map(u => u.id)))
            }
          }
        }
        setRowDrag(null); setDropIdx(null)
      }

      if (splitterDrag) setSplitterDrag(null)
      if (nameDrag) setNameDrag(null)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [drag, connect, rowDrag, dropIdx, previewMap, flatRows, tasks, deps, dispatch, projectId, dateToX, getSvgX, colW, splitterDrag, nameDrag])

  // ── Commit name edit ────────────────────────────────────────────────────
  const commitName = useCallback(async () => {
    if (!editId || !editName.trim()) { setEditId(null); return }
    const orig = tasks.find(t=>t.id===editId)
    if (!orig) { setEditId(null); return }
    const updated = { ...orig, name: editName.trim() }
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))
    dispatch(markDirty([editId]))
    setEditId(null)
  }, [editId, editName, tasks, dispatch, projectId])

  // ── Commit inline cell edit ─────────────────────────────────────────────
  const commitCellEdit = useCallback(async () => {
    if (!cellEdit) return
    const orig = tasks.find(t => t.id === cellEdit.taskId)
    if (!orig) { setCellEdit(null); return }

    let patch: Record<string, unknown> = {}
    if (cellEdit.field === 'assignee') {
      patch = { assignee: cellEdit.value.trim() || null }
    } else if (cellEdit.field === 'duration') {
      const dur = parseFloat(cellEdit.value)
      if (!isNaN(dur) && dur > 0) {
        const incoming = deps.filter(d => d.to_task_id === orig.id)
        const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1
        if (orig.auto_schedule !== false && (depType === 3 || depType === 1) && orig.end_date) {
          // FF/SF: 结束日期固定，工期改变时调整开始日期
          const newStart = fmtDate(addDays(new Date(orig.end_date), -Math.round(dur)))
          patch = { duration: Math.round(dur), start_date: newStart }
        } else if (orig.start_date) {
          // FS/SS/空/手动: 开始日期固定，工期改变时调整结束日期
          const newEnd = fmtDate(addDays(new Date(orig.start_date), Math.round(dur)))
          patch = { duration: Math.round(dur), end_date: newEnd }
        }
      }
    } else if (cellEdit.field === 'start_date') {
      if (orig.auto_schedule !== false) {
        // FF/SF: 允许编辑开始日期；FS/SS/空: 不允许
        const incoming = deps.filter(d => d.to_task_id === orig.id)
        const depType = incoming.length > 0 ? (incoming[0].type ?? 2) : -1
        if (depType !== 3 && depType !== 1) { setCellEdit(null); return }
      }
      if (cellEdit.value) {
        const clampedStart = cellEdit.value
        const newDur = orig.end_date
          ? diffDays(new Date(clampedStart), new Date(orig.end_date))
          : orig.duration
        patch = { start_date: clampedStart, duration: (newDur != null && newDur > 0) ? newDur : orig.duration }
      }
    } else if (cellEdit.field === 'end_date') {
      if (cellEdit.value) {
        const newDur = orig.start_date
          ? diffDays(new Date(orig.start_date), new Date(cellEdit.value))
          : orig.duration
        patch = { end_date: cellEdit.value, duration: (newDur != null && newDur > 0) ? newDur : orig.duration }
      }
    }

    if (Object.keys(patch).length === 0) { setCellEdit(null); return }
    const updated = { ...orig, ...patch } as typeof orig
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))
    dispatch(markDirty([orig.id]))
    setCellEdit(null)
  }, [cellEdit, tasks, dispatch])

  // ── 自动排程开关 ────────────────────────────────────────────────────────
  const handleAutoScheduleChange = useCallback(async (taskId: string, autoSchedule: boolean) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    dispatch(updateTasks([{ ...t, auto_schedule: autoSchedule }]))
    dispatch(markDirty([taskId]))
  }, [tasks, dispatch])

  // ── Change dependency type ──────────────────────────────────────────────
  const handleDepTypeChange = useCallback(async (depId: string, newType: number) => {
    dispatch(updateDependency({ id: depId, type: newType }))
    const res = await authFetch(`/api/dependencies/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId, type: newType }),
    })
    if (res.ok) {
      const r = await authFetch(`/api/tasks/${projectId}?t=${Date.now()}`, { cache: 'no-store' })
      const t = await r.text()
      try { const d = t ? JSON.parse(t) : {}; if (d.ok && d.value) dispatch(setTasks(d.value)) } catch { /* ignore */ }
    }
  }, [dispatch, projectId])

  // ── 切换任务调度模式：空/手动/依赖类型 ─────────────────────────────────
  const handleScheduleModeChange = useCallback(async (taskId: string, value: string) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return

    if (value === 'empty') {
      // 空：删除所有入依赖，auto_schedule=true，开始日期设为项目最早任务开始日期
      const incoming = deps.filter(d => d.to_task_id === taskId)
      dispatch(saveSnapshot())
      for (const dep of incoming) {
        dispatch(removeDependency(dep.id))
        await authFetch(`/api/dependencies/${projectId}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: dep.id }),
        })
      }
      const dur = t.duration ?? 0
      // "空"类型始终使用项目开始日期（子任务的父级是摘要任务，日期由子任务决定，不能反向引用）
      const emptyStart = projectStartDate
      const newEnd = fmtDate(addDays(new Date(emptyStart), dur))
      dispatch(updateTasks([{ ...t, auto_schedule: true, start_date: emptyStart, end_date: newEnd, duration: dur }]))
      dispatch(markDirty([taskId]))
    } else if (value === 'manual') {
      // 手动：删除所有入依赖，auto_schedule=false
      const incoming = deps.filter(d => d.to_task_id === taskId)
      dispatch(saveSnapshot())
      for (const dep of incoming) {
        dispatch(removeDependency(dep.id))
        authFetch(`/api/dependencies/${projectId}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: dep.id }),
        })
      }
      dispatch(updateTasks([{ ...t, auto_schedule: false }]))
      dispatch(markDirty([taskId]))
    }
  }, [tasks, deps, dispatch, projectId, projectStartDate])

  // ── Toggle predecessor via popup（乐观更新，参考 Bryntum 示例）────────────────
  const togglePredecessor = useCallback(async (fromTaskId: string, toTaskId: string) => {
    const existing = deps.find(d => d.from_task_id === fromTaskId && d.to_task_id === toTaskId)
    if (existing) {
      dispatch(saveSnapshot())
      dispatch(removeDependency(existing.id))
      setPredPopup(null)
      try {
        const res = await authFetch(`/api/dependencies/${projectId}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: existing.id }),
        })
        if (!res.ok) {
          dispatch(addDependency(existing))
          throw new Error('删除依赖失败')
        }
      } catch (err) {
        console.error('togglePredecessor DELETE:', err)
      }
      return
    }

    // 添加：乐观更新，先更新 UI 再同步后端（与 Bryntum 示例一致）
    dispatch(saveSnapshot())
    const tempId = `temp-${Date.now()}-${fromTaskId}-${toTaskId}`
    const tempDep: Dependency = {
      id: tempId,
      project_id: projectId,
      from_task_id: fromTaskId,
      to_task_id: toTaskId,
      type: 2,
      lag: 0,
    }
    dispatch(addDependency(tempDep))
    // 添加依赖时，后继任务自动切换为自动排程
    const toTask_ = tasks.find(x => x.id === toTaskId)
    if (toTask_ && toTask_.auto_schedule === false) {
      dispatch(updateTasks([{ ...toTask_, auto_schedule: true }]))
      dispatch(markDirty([toTaskId]))
    }
    setPredPopup(null)

    try {
      const res = await authFetch(`/api/dependencies/${projectId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_task_id: fromTaskId, to_task_id: toTaskId }),
      })
      const text = await res.text()
      let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] }; error?: string }
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        dispatch(removeDependency(tempId))
        throw new Error(res.ok ? '响应格式错误' : `请求失败 (${res.status})`)
      }
      if (data.ok && data.value) {
        const v = data.value as { dependency?: Dependency; updatedTasks?: Task[] }
        dispatch(removeDependency(tempId))
        if (v.dependency) dispatch(addDependency(v.dependency))
        if (Array.isArray(v.updatedTasks) && v.updatedTasks.length > 0)
          dispatch(updateTasks(v.updatedTasks))
      } else {
        dispatch(removeDependency(tempId))
        throw new Error(data.error ?? '添加依赖失败')
      }
    } catch (err) {
      console.error('togglePredecessor POST:', err)
    }
  }, [deps, dispatch, projectId])

  // ── Delete selected dependency ──────────────────────────────────────────
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDep && document.activeElement?.tagName !== 'INPUT') {
        dispatch(saveSnapshot())
        dispatch(removeDependency(selectedDep))
        await authFetch(`/api/dependencies/${projectId}`, {
          method:'DELETE', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id: selectedDep }),
        })
        setSelectedDep(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDep, dispatch, projectId])

  // ── Context menu: add task helper ───────────────────────────────────────
  const addTask = useCallback(async (
    name: string,
    parent_id: string | null,
    order_index: number,
    extra: { is_milestone?: boolean; start_date?: string | null; end_date?: string | null; auto_schedule?: boolean } = {}
  ): Promise<Task | null> => {
    // Default start: later of earliest task start and status date
    const startDate = extra.start_date !== undefined ? extra.start_date : defaultStart
    // Default end: start + 1 day (milestones: same as start)
    const endDate = extra.end_date !== undefined
      ? extra.end_date
      : startDate
        ? fmtDate(addDays(new Date(startDate), extra.is_milestone ? 0 : 1))
        : null
    const duration = extra.is_milestone ? 0 : 1

    const siblings = tasks.filter(t => t.parent_id === parent_id && t.order_index >= order_index)
    if (siblings.length > 0) {
      const shifted = siblings.map(t => ({ ...t, order_index: t.order_index + 1 }))
      dispatch(updateTasks(shifted))
      dispatch(markDirty(shifted.map(t => t.id)))
    }
    const res = await authFetch(`/api/tasks/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, parent_id, order_index,
        is_milestone: extra.is_milestone ?? false,
        start_date: startDate,
        end_date: endDate,
        duration,
        ...(extra.auto_schedule !== undefined ? { auto_schedule: extra.auto_schedule } : {}),
      }),
    })
    const data = await res.json()
    if (data.ok && data.value?.length > 0) {
      dispatch(addTasks(data.value))
      return data.value[0] as Task
    }
    return null
  }, [tasks, dispatch, projectId, defaultStart])

  // ── Context menu: action handlers ────────────────────────────────────────
  const handleCtxDeleteTask = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    dispatch(saveSnapshot())
    dispatch(deleteTasks([taskId]))
    await authFetch(`/api/tasks/${projectId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [taskId] }),
    })
  }, [dispatch, projectId])

  const handleCtxAddAbove = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    await addTask('New Task', t.parent_id, t.order_index, { start_date: startDate, end_date: endDate, auto_schedule: false })
  }, [tasks, addTask, dispatch, defaultStart])

  const handleCtxAddBelow = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    await addTask('New Task', t.parent_id, t.order_index + 1, { start_date: startDate, end_date: endDate, auto_schedule: false })
  }, [tasks, addTask, dispatch, defaultStart])

  const handleCtxAddMilestone = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const nt = await addTask('New Milestone', t.parent_id, t.order_index + 1, { is_milestone: true })
    if (nt) setEditModalTaskId(nt.id)
  }, [tasks, addTask, dispatch])

  const handleCtxAddSubtask = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    const childCount = tasks.filter(x => x.parent_id === taskId).length
    dispatch(saveSnapshot())
    const startDate = t.start_date ? (t.start_date.includes('T') ? t.start_date.split('T')[0] : t.start_date) : defaultStart
    const endDate = startDate ? fmtDate(addDays(new Date(startDate + 'T00:00:00'), 1)) : null
    await addTask('New Sub-task', taskId, childCount, { start_date: startDate, end_date: endDate, auto_schedule: false })
    setExpanded(prev => ({ ...prev, [taskId]: true }))
  }, [tasks, addTask, dispatch, defaultStart])

  const handleCtxAddSuccessor = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const newTask = await addTask('New Task', t.parent_id, t.order_index + 1)
    if (!newTask) return
    const res = await authFetch(`/api/dependencies/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_task_id: taskId, to_task_id: newTask.id }),
    })
    const text = await res.text()
    let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* ignore */ }
    if (data.ok && data.value) {
      const v = data.value
      if (v.dependency) dispatch(addDependency(v.dependency))
      const tasksToUpdate = v.updatedTasks ?? (v.updatedTask ? [v.updatedTask] : [])
      if (tasksToUpdate.length > 0) dispatch(updateTasks(tasksToUpdate))
    }
    setEditModalTaskId(newTask.id)
  }, [tasks, addTask, dispatch, projectId])

  const handleCtxAddPredecessor = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const newTask = await addTask('New Task', t.parent_id, t.order_index)
    if (!newTask) return
    const res = await authFetch(`/api/dependencies/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_task_id: newTask.id, to_task_id: taskId }),
    })
    const text = await res.text()
    let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* ignore */ }
    if (data.ok && data.value) {
      const v = data.value
      if (v.dependency) dispatch(addDependency(v.dependency))
      const tasksToUpdate = v.updatedTasks ?? (v.updatedTask ? [v.updatedTask] : [])
      if (tasksToUpdate.length > 0) dispatch(updateTasks(tasksToUpdate))
    }
    setEditModalTaskId(newTask.id)
  }, [tasks, addTask, dispatch, projectId])

  const handleCtxDeleteDep = useCallback(async (depId: string) => {
    setCtxMenu(null)
    dispatch(removeDependency(depId))
    await authFetch(`/api/dependencies/${projectId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId }),
    })
  }, [dispatch, projectId])

  const handleCtxEdit = useCallback((taskId: string) => {
    setCtxMenu(null)
    setEditModalTaskId(taskId)
  }, [])

  const handleCtxCopy = useCallback((taskId: string) => {
    setCtxMenu(null)
    dispatch(copyTasks([taskId]))
  }, [dispatch])

  const handleCtxCut = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    dispatch(saveSnapshot())
    dispatch(copyTasks([taskId]))
    dispatch(deleteTasks([taskId]))
    await authFetch(`/api/tasks/${projectId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [taskId] }),
    })
  }, [dispatch, projectId])

  const handleCtxPaste = useCallback(async () => {
    setCtxMenu(null)
    if (!clipboard.length) return
    dispatch(saveSnapshot())
    const pastedTasks = clipboard.map(t => ({
      ...t, name: `${t.name} (副本)`, id: undefined, created_at: undefined, updated_at: undefined,
    }))
    const res = await authFetch(`/api/tasks/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pastedTasks),
    })
    const data = await res.json()
    if (data.ok) dispatch(addTasks(data.value))
  }, [dispatch, projectId, clipboard])

  const handleCtxConvertMilestone = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const toMilestone = !t.is_milestone
    const patch: Partial<Task> = { is_milestone: toMilestone }
    if (toMilestone) {
      // 转为里程碑：工期=0, end_date=start_date, 完成度=100%
      patch.duration = 0
      patch.percent_done = 100
      if (t.start_date) patch.end_date = t.start_date
    } else {
      // 转为普通任务：工期=1, end_date=start+1, 完成度保留
      patch.duration = 1
      if (t.start_date) patch.end_date = fmtDate(addDays(new Date(t.start_date), 1))
    }
    const updated = { ...t, ...patch }
    dispatch(updateTasks([updated]))
    dispatch(markDirty([taskId]))
  }, [dispatch, tasks])

  const handleCtxIndent = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const anchor = tasks
      .filter(t => t.parent_id === task.parent_id && t.order_index < task.order_index)
      .sort((a, b) => b.order_index - a.order_index)[0]
    if (!anchor) return
    dispatch(saveSnapshot())

    // 降级时删除被降级任务与新父任务之间的依赖关系
    // 降级时取消 anchor（新父任务）上的所有依赖（父级任务不允许有依赖）
    const depsToRemove = deps.filter(d =>
      d.from_task_id === anchor.id || d.to_task_id === anchor.id
    )
    for (const dep of depsToRemove) {
      dispatch(removeDependency(dep.id))
      await authFetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dep.id }),
      })
    }

    const existingChildren = tasks.filter(t => t.parent_id === anchor.id)
    const newOrder = existingChildren.length > 0 ? Math.max(...existingChildren.map(t => t.order_index)) + 1 : 0
    const movedTask = { ...task, parent_id: anchor.id, order_index: newOrder }
    dispatch(updateTasks([movedTask]))
    // 乐观更新 anchor（新父任务）的日期范围
    const allKids = [...existingChildren, movedTask]
    const starts = allKids.map(k => k.start_date).filter(Boolean) as string[]
    const ends = allKids.map(k => k.end_date).filter(Boolean) as string[]
    if (starts.length > 0 && ends.length > 0) {
      const minS = starts.sort()[0], maxE = ends.sort().reverse()[0]
      const dur = Math.round((new Date(maxE).getTime() - new Date(minS).getTime()) / 86400000)
      dispatch(updateTasks([{ ...anchor, start_date: minS, end_date: maxE, duration: dur }]))
    }
    dispatch(markDirty([taskId]))
  }, [dispatch, tasks, deps])

  const handleCtxOutdent = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task || !task.parent_id) return
    const parent = tasks.find(t => t.id === task.parent_id)!
    dispatch(saveSnapshot())

    // 升级时删除被升级任务与旧父任务之间的依赖关系
    const depsToRemove = deps.filter(d =>
      (d.from_task_id === taskId && d.to_task_id === parent.id) ||
      (d.from_task_id === parent.id && d.to_task_id === taskId)
    )
    for (const dep of depsToRemove) {
      dispatch(removeDependency(dep.id))
      await authFetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dep.id }),
      })
    }

    const siblingsAfterParent = tasks
      .filter(t => t.parent_id === parent.parent_id && t.order_index > parent.order_index)
    siblingsAfterParent.forEach(s => {
      dispatch(updateTasks([{ ...s, order_index: s.order_index + 1 }]))
    })
    const updated = { ...task, parent_id: parent.parent_id, order_index: parent.order_index + 1 }
    dispatch(updateTasks([updated]))
    // 乐观更新：旧父任务日期收缩
    const remainKids = tasks.filter(t => t.parent_id === parent.id && t.id !== taskId)
    if (remainKids.length > 0) {
      const starts = remainKids.map(k => k.start_date).filter(Boolean) as string[]
      const ends = remainKids.map(k => k.end_date).filter(Boolean) as string[]
      if (starts.length > 0 && ends.length > 0) {
        const minS = starts.sort()[0], maxE = ends.sort().reverse()[0]
        const dur = Math.round((new Date(maxE).getTime() - new Date(minS).getTime()) / 86400000)
        dispatch(updateTasks([{ ...parent, start_date: minS, end_date: maxE, duration: dur }]))
      }
    }
    const payload = [
      { id: taskId, parent_id: parent.parent_id, order_index: parent.order_index + 1 },
      ...siblingsAfterParent.map(s => ({ id: s.id, parent_id: s.parent_id, order_index: s.order_index + 1 })),
    ]
    dispatch(updateTasks(payload.map(p => ({ ...tasks.find(t => t.id === p.id)!, ...p }))))
    dispatch(markDirty(payload.map(p => p.id)))
  }, [dispatch, projectId, tasks, deps])

  const handleCtxAddDep = useCallback(async (fromId: string, toId: string) => {
    setCtxMenu(null)
    const already = deps.find(d => d.from_task_id === fromId && d.to_task_id === toId)
    if (already) return
    dispatch(saveSnapshot())
    const tempId = `temp-${Date.now()}-${fromId}-${toId}`
    dispatch(addDependency({ id: tempId, project_id: projectId, from_task_id: fromId, to_task_id: toId, type: 2, lag: 0 }))
    // 添加依赖时，后继任务自动切换为自动排程
    const toTask__ = tasks.find(x => x.id === toId)
    if (toTask__ && toTask__.auto_schedule === false) {
      dispatch(updateTasks([{ ...toTask__, auto_schedule: true }]))
      dispatch(markDirty([toId]))
    }
    const res = await authFetch(`/api/dependencies/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_task_id: fromId, to_task_id: toId }),
    })
    const text = await res.text()
    let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
    try { data = text ? JSON.parse(text) : {} } catch { dispatch(removeDependency(tempId)); return }
    if (data.ok && data.value) {
      const v = data.value as { dependency?: Dependency; updatedTasks?: Task[] }
      dispatch(removeDependency(tempId))
      if (v.dependency) dispatch(addDependency(v.dependency))
      if (Array.isArray(v.updatedTasks) && v.updatedTasks.length > 0)
        dispatch(updateTasks(v.updatedTasks))
    } else {
      dispatch(removeDependency(tempId))
    }
  }, [dispatch, projectId, deps])

  const handleCtxRemoveAllDeps = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const taskDeps = deps.filter(d => d.from_task_id === taskId || d.to_task_id === taskId)
    dispatch(saveSnapshot())
    for (const d of taskDeps) {
      dispatch(removeDependency(d.id))
      await authFetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
    }
  }, [dispatch, projectId, deps])

  const handleEnableAutoSchedule = useCallback(async () => {
    setCtxMenu(null)
    if (!confirm('将为所有有依赖关系的任务启用自动排程，确认？')) return
    try {
      const response = await authFetch(`/api/tasks/enable-auto-schedule/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      if (data.ok) {
        alert(`已启用 ${data.value?.updated ?? 0} 个任务的自动排程`)
        const taskRes = await authFetch(`/api/tasks/${projectId}`)
        const taskData = await taskRes.json()
        if (taskData.ok) dispatch(setTasks(taskData.value))
      } else {
        alert('启用失败：' + (data.error || '未知错误'))
      }
    } catch (err) {
      console.error('启用自动排程失败:', err)
      alert('启用失败，请检查网络连接')
    }
  }, [projectId, dispatch])

  const handleFixProjectDates = useCallback(async () => {
    setCtxMenu(null)
    if (!confirm('将根据依赖关系重新计算所有任务日期，确认？')) return
    try {
      const response = await authFetch(`/api/tasks/fix-project/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      if (data.ok) {
        alert(data.value?.message ?? '修复完成')
        const taskRes = await authFetch(`/api/tasks/${projectId}`)
        const taskData = await taskRes.json()
        if (taskData.ok) dispatch(setTasks(taskData.value))
      } else {
        alert('修复失败：' + (data.error || '未知错误'))
      }
    } catch (err) {
      console.error('修复项目失败:', err)
      alert('修复失败，请检查网络连接')
    }
  }, [projectId, dispatch])

  const toggle = useCallback((id: string) => {
    setExpanded(prev=>({ ...prev, [id]:!(prev[id]??true) }))
  }, [])

  const rightW = rightRef.current?.clientWidth ?? 1200
  const totalW = Math.max(totalDays * colW, rightW + 100)
  const totalH = displayRows.length * ROW_H

  // ── Dynamic panel sizing ─────────────────────────────────────────────────
  const effectivePanelW = panelCollapsed ? 0 : panelW
  const nameColW = nameW  // 任务名称列宽固定，不随面板缩小而压缩

  // Right columns: only include visible optional columns
  const RIGHT_COL_BASES = useMemo(() =>
    OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).map(c => c.width),
    [visibleCols])
  const RIGHT_COLS_TOTAL = RIGHT_COL_BASES.reduce((a, b) => a + b, 0)
  const rightColWidths = useMemo(() => {
    const available = Math.max(0, effectivePanelW - COL_NUM - COL_CHECK - nameColW)
    const widths = [...RIGHT_COL_BASES]
    let deficit = RIGHT_COLS_TOTAL - available
    // Shrink from the last column first
    for (let i = widths.length - 1; i >= 0 && deficit > 0; i--) {
      const take = Math.min(deficit, widths[i])
      widths[i] -= take
      deficit -= take
    }
    return widths
  }, [effectivePanelW, nameColW, RIGHT_COL_BASES, RIGHT_COLS_TOTAL])
  // Map visible column keys to their computed widths
  const visibleColWidths = useMemo(() => {
    const map: Record<OptionalCol, number> = { assignee: 0, pct: 0, duration: 0, start: 0, end: 0, pred: 0, succ: 0, dtype: 0 }
    const visibleKeys = OPTIONAL_COL_META.filter(c => visibleCols.includes(c.key)).map(c => c.key)
    visibleKeys.forEach((k, i) => { map[k] = rightColWidths[i] ?? 0 })
    return map
  }, [visibleCols, rightColWidths])
  const colAssignW = visibleColWidths.assignee
  const colPctW    = visibleColWidths.pct
  const colDurW    = visibleColWidths.duration
  const colStartW  = visibleColWidths.start
  const colEndW    = visibleColWidths.end
  const colPredW   = visibleColWidths.pred
  const colSuccW   = visibleColWidths.succ
  const colDtypeW  = visibleColWidths.dtype

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden select-none"
         style={{ fontFamily:'system-ui,sans-serif', fontSize:13,
                  cursor: (splitterDrag || nameDrag) ? 'col-resize' : undefined }}>

      {/* ── Left panel ───────────────────────────────────────────────── */}
      <div className="flex-none flex flex-col bg-white"
           style={{ width: effectivePanelW, overflow: 'hidden', transition: splitterDrag ? undefined : 'width 0.15s ease' }}>
        {/* Column headers */}
        <div className="flex-none flex items-end border-b border-gray-300 bg-gray-50
                        font-semibold text-gray-500 text-[11px]"
             style={{ height: HDR_H, minWidth: effectivePanelW }}>
          {/* 任务编号 header */}
          <div style={{ width: COL_NUM }}
               className="h-full flex items-end pb-1 justify-center border-r border-gray-200 flex-none text-gray-400">
            编号
          </div>
          {/* Checkbox header */}
          <div style={{ width: COL_CHECK }}
               className="h-full flex items-center justify-center border-r border-gray-200 flex-none">
            <input type="checkbox"
                   className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                   checked={displayRows.length > 0 && displayRows.every(r => selectedIds.includes(r.task.id))}
                   onChange={e => dispatch(setSelectedIds(e.target.checked ? displayRows.map(r => r.task.id) : []))} />
          </div>
          <div style={{ width: nameColW, paddingLeft: 4, minWidth: MIN_NAME_W, position: 'relative' }}
               className="h-full flex items-end pb-1 border-r border-gray-200 flex-none">
            任务名称
            {/* Name column resize handle — wider grab zone with hover highlight */}
            <div
              className="group/resize"
              style={{ position: 'absolute', right: -3, top: 0, width: 7, height: '100%', cursor: 'col-resize', zIndex: 2 }}
              onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setNameDrag({ startX: e.clientX, startW: nameW }) }}
            >
              <div className="absolute left-1/2 top-1/4 -translate-x-1/2 w-[2px] h-1/2 rounded bg-transparent group-hover/resize:bg-blue-400 transition-colors" />
            </div>
          </div>
          {colAssignW > 0 && (
            <div style={{ width: colAssignW, position: 'relative' }}
                 className="h-full flex items-end pb-1 px-1 border-r border-gray-200 flex-none overflow-visible cursor-pointer select-none"
                 onClick={e => { e.stopPropagation(); setColDropdown(colDropdown === 'assignee' ? null : 'assignee') }}>
              {colAssignW >= 24 && <>
                <span className="text-[11px] truncate">责任人</span>
                {sortCol === 'assignee' && <span className="text-[9px] ml-0.5 text-blue-500">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                {filterAssignee !== null && <span className="text-[9px] ml-0.5 text-orange-500">●</span>}
              </>}
              {colDropdown === 'assignee' && (
                <div ref={colDropdownRef}
                     className="absolute top-full left-0 z-50 bg-white border border-gray-300 rounded shadow-lg py-1 min-w-[120px]"
                     onClick={e => e.stopPropagation()}>
                  <div className="px-2 py-1 text-[11px] text-gray-500 border-b border-gray-100">排序</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${sortCol === 'assignee' && sortDir === 'asc' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setSortCol('assignee'); setSortDir('asc'); setColDropdown(null) }}>升序 A→Z</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${sortCol === 'assignee' && sortDir === 'desc' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setSortCol('assignee'); setSortDir('desc'); setColDropdown(null) }}>降序 Z→A</div>
                  {sortCol === 'assignee' && (
                    <div className="px-2 py-1 text-[11px] cursor-pointer hover:bg-gray-100 text-gray-500"
                         onClick={() => { setSortCol(null); setSortDir(null); setColDropdown(null) }}>清除排序</div>
                  )}
                  <div className="px-2 py-1 text-[11px] text-gray-500 border-t border-b border-gray-100 mt-1">筛选</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterAssignee === null ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterAssignee(null); setColDropdown(null) }}>全部</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterAssignee === '' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterAssignee(''); setColDropdown(null) }}>（空）</div>
                  {assigneeList.map(a => (
                    <div key={a} className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 truncate ${filterAssignee === a ? 'text-blue-600 font-semibold' : ''}`}
                         onClick={() => { setFilterAssignee(a); setColDropdown(null) }}>{a}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {colPctW > 0 && (
            <div style={{ width: colPctW }}
                 className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none overflow-hidden">
              {colPctW >= 24 && '完成'}
            </div>
          )}
          {colDurW > 0 && (
            <div style={{ width: colDurW, position: 'relative' }}
                 className="h-full flex items-end pb-1 px-1 border-r border-gray-200 flex-none overflow-visible cursor-pointer select-none"
                 onClick={e => { e.stopPropagation(); setColDropdown(colDropdown === 'duration' ? null : 'duration') }}>
              {colDurW >= 24 && <>
                <span className="text-[11px] truncate">工期</span>
                {sortCol === 'duration' && <span className="text-[9px] ml-0.5 text-blue-500">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </>}
              {colDropdown === 'duration' && (
                <div ref={colDropdownRef}
                     className="absolute top-full left-0 z-50 bg-white border border-gray-300 rounded shadow-lg py-1 min-w-[100px]"
                     onClick={e => e.stopPropagation()}>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${sortCol === 'duration' && sortDir === 'asc' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setSortCol('duration'); setSortDir('asc'); setColDropdown(null) }}>升序 小→大</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${sortCol === 'duration' && sortDir === 'desc' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setSortCol('duration'); setSortDir('desc'); setColDropdown(null) }}>降序 大→小</div>
                  {sortCol === 'duration' && (
                    <div className="px-2 py-1 text-[11px] cursor-pointer hover:bg-gray-100 text-gray-500"
                         onClick={() => { setSortCol(null); setSortDir(null); setColDropdown(null) }}>清除排序</div>
                  )}
                </div>
              )}
            </div>
          )}
          {colStartW > 0 && (
            <div style={{ width: colStartW }}
                 className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none overflow-hidden">
              {colStartW >= 24 && '开始'}
            </div>
          )}
          {colEndW > 0 && (
            <div style={{ width: colEndW }}
                 className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none overflow-hidden">
              {colEndW >= 24 && '完成时间'}
            </div>
          )}
          {colPredW > 0 && (
            <div style={{ width: colPredW }}
                 className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none overflow-hidden">
              {colPredW >= 24 && '前置'}
            </div>
          )}
          {colSuccW > 0 && (
            <div style={{ width: colSuccW }}
                 className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none overflow-hidden">
              {colSuccW >= 24 && '后续'}
            </div>
          )}
          {colDtypeW > 0 && (
            <div style={{ width: colDtypeW, position: 'relative' }}
                 className="h-full flex items-end pb-1 px-1 flex-none overflow-visible cursor-pointer select-none"
                 onClick={e => { e.stopPropagation(); setColDropdown(colDropdown === 'dtype' ? null : 'dtype') }}>
              {colDtypeW >= 24 && <>
                <span className="text-[11px] truncate">类型</span>
                {filterDtype !== null && <span className="text-[9px] ml-0.5 text-orange-500">●</span>}
              </>}
              {colDropdown === 'dtype' && (
                <div ref={colDropdownRef}
                     className="absolute top-full right-0 z-50 bg-white border border-gray-300 rounded shadow-lg py-1 min-w-[90px]"
                     onClick={e => e.stopPropagation()}>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === null ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype(null); setColDropdown(null) }}>全部</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === 'empty' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('empty'); setColDropdown(null) }}>空</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === 'manual' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('manual'); setColDropdown(null) }}>手动</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === '2' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('2'); setColDropdown(null) }}>FS</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === '0' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('0'); setColDropdown(null) }}>SS</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === '3' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('3'); setColDropdown(null) }}>FF</div>
                  <div className={`px-2 py-1 text-[11px] cursor-pointer hover:bg-blue-50 ${filterDtype === '1' ? 'text-blue-600 font-semibold' : ''}`}
                       onClick={() => { setFilterDtype('1'); setColDropdown(null) }}>SF</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Rows */}
        <div ref={leftRef} className="overflow-y-scroll flex-1 scrollbar-hide"
             onScroll={onLeftBodyScroll}
             style={{ cursor: rowDrag?.dragging ? 'grabbing' : undefined }}>
          {displayRows.map((row, i) => {
            const t = row.task
            const sel = selectedIds.includes(t.id)
            const isEditing = editId === t.id
            const isDraggingThis = rowDrag?.dragging && rowDrag.taskId === t.id
            const incomingDeps = deps.filter(d => d.to_task_id === t.id)
            const predNums = incomingDeps
              .map(d => flatRowIdx[d.from_task_id])
              .filter(Boolean)
              .join(',')
            const outgoingDeps = deps.filter(d => d.from_task_id === t.id)
            const succNums = outgoingDeps
              .map(d => flatRowIdx[d.to_task_id])
              .filter(Boolean)
              .join(',')
            const fmtCell = (s: string | null) =>
              s ? s.split('T')[0].slice(5) : ''  // MM-DD
            return (
              <React.Fragment key={t.id}>
                {rowDrag?.dragging && dropIdx === i && (
                  <div style={{ height: 2, background: '#3b82f6', flexShrink: 0 }} />
                )}
                <div
                  className={`flex border-b border-gray-100 cursor-pointer
                    ${sel ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  style={{ height: ROW_H, opacity: isDraggingThis ? 0.35 : 1 }}
                  onClick={e => {
                    if (rowDrag?.dragging) return
                    if (isEditing || cellEdit?.taskId === t.id) return
                    const newSel = (e.ctrlKey || e.metaKey)
                      ? sel ? selectedIds.filter(x => x !== t.id) : [...selectedIds, t.id]
                      : sel && selectedIds.length === 1 ? [] : [t.id]
                    dispatch(setSelectedIds(newSel))
                    // Center right panel on clicked task
                    if (!e.ctrlKey && !e.metaKey && t.start_date && t.end_date && rightRef.current) {
                      const x1 = dateToX(new Date(t.start_date))
                      const x2 = dateToX(new Date(t.end_date))
                      const barCenter = (x1 + x2) / 2
                      syncTimelineScrollLeft(Math.max(0, barCenter - rightRef.current.clientWidth / 2))
                    }
                  }}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation()
                    if (!readOnly) setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null })
                  }}
                >
                  {/* ── WBS number cell with drag handle ── */}
                  <div style={{ width: COL_NUM }}
                       className="flex items-center border-r border-gray-100 h-full flex-none flex-shrink-0 relative group/wbs">
                    {/* Drag handle */}
                    <div
                      className="flex items-center justify-center w-4 h-full cursor-grab active:cursor-grabbing opacity-0 group-hover/wbs:opacity-100 transition-opacity flex-none"
                      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onRowDragStart(e, t.id) }}
                      title="拖动排序"
                    >
                      <svg viewBox="0 0 6 10" width="6" height="10" fill="#9ca3af">
                        <circle cx="1.5" cy="1.5" r="1" /><circle cx="4.5" cy="1.5" r="1" />
                        <circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" />
                        <circle cx="1.5" cy="8.5" r="1" /><circle cx="4.5" cy="8.5" r="1" />
                      </svg>
                    </div>
                    <span className="text-[10px] font-mono text-gray-400 truncate flex-1 text-center">
                      {seqMap.get(t.id) ?? (i + 1)}
                    </span>
                  </div>

                  {/* ── Checkbox cell ─────────────────────────────── */}
                  <div style={{ width: COL_CHECK }}
                       className="flex items-center justify-center border-r border-gray-100 h-full flex-none flex-shrink-0">
                    <input type="checkbox"
                           className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                           checked={sel}
                           onChange={e => {
                             e.stopPropagation()
                             dispatch(setSelectedIds(e.target.checked
                               ? [...selectedIds, t.id]
                               : selectedIds.filter(x => x !== t.id)
                             ))
                           }}
                           onClick={e => e.stopPropagation()} />
                  </div>

                  {/* ── Name cell ─────────────────────────────────── */}
                  <div style={{ width: nameColW, minWidth: MIN_NAME_W, paddingLeft: 4 + row.level * 16 }}
                       className="flex items-center border-r border-gray-100 h-full flex-none overflow-hidden"
                       onDoubleClick={() => { if (!readOnly) { setEditId(t.id); setEditName(t.name) } }}>
                    {row.hasChildren
                      ? <button onClick={e => { e.stopPropagation(); toggle(t.id) }}
                                className="w-5 h-5 flex-none flex items-center justify-center rounded
                                           bg-blue-50 hover:bg-blue-200 text-blue-600 hover:text-blue-800
                                           text-sm font-bold transition-colors">
                          {row.expanded ? '▾' : '▸'}
                        </button>
                      : <span className="w-5 h-5 flex-none flex items-center justify-center text-gray-300">·</span>
                    }
                    {isEditing
                      ? <input ref={nameInputRef}
                               className="flex-1 border border-blue-400 rounded px-1 text-[12px] outline-none min-w-0"
                               value={editName}
                               onChange={e => setEditName(e.target.value)}
                               onBlur={commitName}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitName()
                                 if (e.key === 'Escape') setEditId(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className={`truncate text-[12px] flex-1 min-w-0 ${row.hasChildren
                          ? 'font-bold text-gray-800' : 'text-gray-700'}`}>
                          {t.name}
                        </span>
                    }
                  </div>

                  {/* ── Assignee cell ─────────────────────────────── */}
                  {colAssignW > 0 && (
                  <div style={{ width: colAssignW }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         setCellEdit({ taskId: t.id, field: 'assignee', value: t.assignee ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'assignee'
                      ? <input autoFocus
                               className="w-full border border-blue-400 rounded px-1 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="truncate text-[11px] text-gray-600 w-full">
                          {t.assignee ?? ''}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── Percent done cell (read-only, based on status date) ── */}
                  {colPctW > 0 && (
                  <div style={{ width: colPctW }}
                       className="flex items-center justify-end border-r border-gray-100 h-full flex-none px-1 overflow-hidden">
                    <span className="text-[11px] text-gray-600">
                      {t.is_milestone ? 100 : row.hasChildren ? (summaryProgressMap.get(t.id) ?? 0) : timeBasedPercent(t, statusDateObj)}%
                    </span>
                  </div>
                  )}

                  {/* ── Duration cell ─────────────────────────────── */}
                  {colDurW > 0 && (
                  <div style={{ width: colDurW }}
                       className="flex items-center justify-end border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         setCellEdit({ taskId: t.id, field: 'duration', value: t.duration != null ? String(t.duration) : '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'duration'
                      ? <input autoFocus type="number" min={1}
                               className="w-full border border-blue-400 rounded px-1 text-[11px] outline-none text-right"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {t.duration != null ? t.duration : ''}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── Start date cell ───────────────────────────── */}
                  {colStartW > 0 && (
                  <div style={{ width: colStartW }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         if (t.auto_schedule !== false) {
                           // FF/SF: 结束日期锁定，允许编辑开始日期；FS/SS/空: 开始日期锁定
                           const inc = deps.filter(d => d.to_task_id === t.id)
                           const dt = inc.length > 0 ? (inc[0].type ?? 2) : -1
                           if (dt !== 3 && dt !== 1) return
                         }
                         setCellEdit({ taskId: t.id, field: 'start_date', value: t.start_date?.split('T')[0] ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'start_date'
                      ? <input autoFocus type="date"
                               className="w-full border border-blue-400 rounded px-0.5 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {fmtCell(t.start_date)}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── End date cell ────────────────────────────── */}
                  {colEndW > 0 && (
                  <div style={{ width: colEndW }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
                         if (readOnly) return
                         if (t.auto_schedule !== false) {
                           const inc = deps.filter(d => d.to_task_id === t.id)
                           const dt = inc.length > 0 ? (inc[0].type ?? 2) : -1
                           // FS/SS: 结束日期由工期推导，不可编辑；FF/SF: 结束日期可编辑
                           if (dt !== 3 && dt !== 1 && dt !== -1) return
                         }
                         setCellEdit({ taskId: t.id, field: 'end_date', value: t.end_date?.split('T')[0] ?? '' })
                       }}>
                    {cellEdit?.taskId === t.id && cellEdit.field === 'end_date'
                      ? <input autoFocus type="date"
                               className="w-full border border-blue-400 rounded px-0.5 text-[11px] outline-none"
                               value={cellEdit.value}
                               onChange={e => setCellEdit(p => p ? { ...p, value: e.target.value } : null)}
                               onBlur={commitCellEdit}
                               onKeyDown={e => {
                                 if (e.key === 'Enter') commitCellEdit()
                                 if (e.key === 'Escape') setCellEdit(null)
                               }}
                               onClick={e => e.stopPropagation()} />
                      : <span className="text-[11px] text-gray-600">
                          {fmtCell(t.end_date)}
                        </span>
                    }
                  </div>
                  )}

                  {/* ── Predecessors cell (clickable popup) ───────── */}
                  {colPredW > 0 && (
                  <div style={{ width: colPredW }}
                       className={`flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden relative group ${row.hasChildren ? '' : 'cursor-pointer'}`}
                       onClick={e => {
                         e.stopPropagation()
                         if (row.hasChildren) return // 摘要任务不能有依赖
                         const rect = e.currentTarget.getBoundingClientRect()
                         setPredFilter('')
                         const popupH = 320
                         const spaceBelow = window.innerHeight - rect.bottom
                         const yPos = spaceBelow < popupH ? rect.top - popupH : rect.bottom
                         setPredPopup(p =>
                           p?.taskId === t.id ? null
                           : { taskId: t.id, x: rect.left, y: yPos }
                         )
                       }}>
                    <span className="text-[11px] text-gray-600 truncate flex-1">{row.hasChildren ? '—' : predNums}</span>
                    {!row.hasChildren && <span className="text-[9px] text-gray-400 flex-none group-hover:text-gray-600">▾</span>}
                  </div>
                  )}

                  {/* ── Successors cell (read-only display) ────── */}
                  {colSuccW > 0 && (
                  <div style={{ width: colSuccW }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden">
                    <span className="text-[11px] text-gray-600 truncate flex-1">{row.hasChildren ? '—' : succNums}</span>
                  </div>
                  )}

                  {/* ── Dep type / schedule mode cell ────────────── */}
                  {colDtypeW > 0 && (
                  <div style={{ width: colDtypeW }}
                       className="flex items-center h-full flex-none px-1 overflow-hidden">
                    {row.hasChildren ? (
                      <span className="text-[11px] text-gray-300 w-full text-center">—</span>
                    ) : (
                      <select
                        className="text-[11px] border border-gray-200 rounded px-0.5 bg-white
                                   text-gray-700 focus:outline-none focus:border-blue-400 cursor-pointer w-full"
                        value={incomingDeps.length > 0 ? String(incomingDeps[0].type) : (t.auto_schedule === false ? 'manual' : 'empty')}
                        onClick={e => e.stopPropagation()}
                        onChange={e => {
                          const v = e.target.value
                          if (v === 'empty' || v === 'manual') {
                            handleScheduleModeChange(t.id, v)
                          } else if (incomingDeps.length > 0) {
                            handleDepTypeChange(incomingDeps[0].id, Number(v))
                          }
                        }}>
                        <option value="empty">空</option>
                        <option value="manual">手动</option>
                        {incomingDeps.length > 0 && <>
                          <option value={2}>FS</option>
                          <option value={0}>SS</option>
                          <option value={3}>FF</option>
                          <option value={1}>SF</option>
                        </>}
                      </select>
                    )}
                  </div>
                  )}
                </div>
              </React.Fragment>
            )
          })}
          {rowDrag?.dragging && dropIdx === flatRows.length && (
            <div style={{ height: 2, background: '#3b82f6' }} />
          )}
        </div>
      </div>

      {/* ── Splitter ─────────────────────────────────────────────────── */}
      <div
        className="flex-none relative flex flex-col items-center justify-center select-none"
        style={{
          width: 8,
          background: splitterDrag ? '#dbeafe' : '#f3f4f6',
          borderLeft:  '1px solid #d1d5db',
          borderRight: '1px solid #d1d5db',
          cursor: 'col-resize',
          zIndex: 10,
        }}
        onMouseDown={e => {
          e.preventDefault()
          setSplitterDrag({ startX: e.clientX, startW: panelCollapsed ? 0 : panelW })
        }}
      >
        <button
          title={panelCollapsed ? '展开面板' : '折叠面板'}
          style={{
            width: 16, height: 36, background: '#e5e7eb',
            border: '1px solid #d1d5db', borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 11, color: '#6b7280',
          }}
          onClick={e => {
            e.stopPropagation()
            if (panelCollapsed) {
              setPanelCollapsed(false)
              setPanelW(prevPanelW.current)
            } else {
              prevPanelW.current = panelW
              setPanelCollapsed(true)
            }
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {panelCollapsed ? '›' : '‹'}
        </button>
      </div>

      {/* ── Right timeline（上：日期头冻结；上下同步横向滚动，仅下方纵向滚动）──── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-white">
        <div
          ref={rightHeaderRef}
          onScroll={onRightHeaderScroll}
          className="flex-none overflow-x-auto overflow-y-hidden shrink-0 border-b border-gray-300 bg-gray-50 scrollbar-hide"
          style={{ height: HDR_H, minHeight: HDR_H, flexShrink: 0 }}
        >
          <svg
            width={Math.max(totalW, 800)}
            height={HDR_H}
            style={{ display: 'block', fontFamily: 'system-ui, sans-serif' }}
            overflow="visible"
          >
            <rect x={0} y={0} width={Math.max(totalW, 800)} height={HDR_H} fill="#f9fafb" />
            <line x1={0} y1={HDR_H} x2={Math.max(totalW, 800)} y2={HDR_H} stroke="#d1d5db" />
            {(() => {
              const months: { label: string; startD: number; endD: number }[] = []
              let mStart = 0
              let mLabel = ''
              for (let d = 0; d <= totalDays; d++) {
                const date  = addDays(origin, d)
                const label = `${date.getFullYear()}年${date.getMonth()+1}月`
                if (d === 0) { mStart = 0; mLabel = label }
                else if (label !== mLabel || d === totalDays) {
                  months.push({ label: mLabel, startD: mStart, endD: d })
                  mStart = d; mLabel = label
                }
              }
              return months.map((m, i) => {
                const x = m.startD * colW
                const w = (m.endD - m.startD) * colW
                return (
                  <g key={`hm${i}`}>
                    <line x1={x} y1={0} x2={x} y2={HDR_H1} stroke="#d1d5db" />
                    <text x={x + w/2} y={HDR_H1-8} fontSize={11} textAnchor="middle"
                          fill="#374151" fontWeight="600">
                      {m.label}
                    </text>
                  </g>
                )
              })
            })()}
            {colW < 7
              ? /* ── 月视图：只显示月份，第二行留空 ─────────────── */
                null
              : colW < 14
              ? /* ── 周视图：每7天显示一个日期 ─────────────────── */
                (() => {
                  const nodes: React.ReactNode[] = []
                  for (let d = 0; d < totalDays; d += 7) {
                    const date = addDays(origin, d)
                    const x = d * colW
                    const w7 = Math.min(7, totalDays - d) * colW
                    nodes.push(
                      <g key={`hw${d}`}>
                        <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H} stroke="#d1d5db" />
                        <text x={x + w7 / 2} y={HDR_H - 6} fontSize={10} textAnchor="middle"
                              fill="#374151" fontWeight={600}>
                          {`${date.getMonth()+1}/${date.getDate()}`}
                        </text>
                      </g>
                    )
                  }
                  return nodes
                })()
              : /* ── 日视图：每天一个日期 ──────────────────────── */
                Array.from({ length: totalDays }, (_,d) => {
                  const date = addDays(origin,d)
                  const dow  = date.getDay()
                  const wknd = dow===0||dow===6
                  const x    = d*colW
                  return (
                    <g key={`hd${d}`}>
                      {wknd && (
                        <rect x={x} y={HDR_H1} width={colW} height={HDR_H - HDR_H1} fill="#f3f4f6" opacity={0.45} />
                      )}
                      <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H} stroke="#e5e7eb" />
                      <text x={x+colW/2} y={HDR_H - 6} fontSize={11} textAnchor="middle"
                            fill={wknd ? '#9ca3af' : '#374151'} fontWeight={600}>
                        {date.getDate()}
                      </text>
                    </g>
                  )
                })
            }
          </svg>
        </div>
        <div
          ref={rightRef}
          onScroll={onRightBodyScroll}
          className="flex-1 overflow-auto min-h-0"
          style={{ cursor: drag ? 'ew-resize' : connect ? 'crosshair' : 'default' }}
        >
          <svg ref={svgRef}
               width={Math.max(totalW,800)} height={totalH+8}
               style={{ display:'block' }}
               onClick={() => setSelectedDep(null)}>
          <defs>
            <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#9ca3af" />
            </marker>
            <marker id="dep-arrow-sel" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#ef4444" />
            </marker>
            <marker id="connect-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#3b82f6" />
            </marker>
          </defs>

          {colW < 7
            ? /* 月视图：只画月分隔线 */
              (() => {
                const nodes: React.ReactNode[] = []
                let d = 0
                while (d < totalDays) {
                  const date = addDays(origin, d)
                  const x = d * colW
                  // 跳到下月1号
                  const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1)
                  const daysToNext = diffDays(date, nextMonth)
                  nodes.push(
                    <line key={`bm${d}`} x1={x} y1={0} x2={x} y2={totalH} stroke="#d1d5db" />
                  )
                  d += daysToNext || 1
                }
                return nodes
              })()
            : colW < 14
            ? /* 周视图：每7天画分隔线 */
              (() => {
                const nodes: React.ReactNode[] = []
                for (let d = 0; d < totalDays; d += 7) {
                  const x = d * colW
                  nodes.push(
                    <line key={`bw${d}`} x1={x} y1={0} x2={x} y2={totalH} stroke="#e5e7eb" />
                  )
                }
                return nodes
              })()
            : /* 日视图：每天画线 + 周末底色 */
              Array.from({ length: totalDays }, (_,d) => {
                const date = addDays(origin,d)
                const dow  = date.getDay()
                const wknd = dow===0||dow===6
                const x    = d*colW
                return (
                  <g key={`bd${d}`}>
                    {wknd && <rect x={x} y={0} width={colW} height={totalH} fill="#f3f4f6" opacity={0.5}/>}
                    <line x1={x} y1={0} x2={x} y2={totalH} stroke="#e5e7eb" />
                  </g>
                )
              })
          }

          {/* Row lines */}
          {displayRows.map((_,i)=>(
            <line key={`rl${i}`} x1={0} y1={(i+1)*ROW_H}
                  x2={totalW} y2={(i+1)*ROW_H} stroke="#e5e7eb" />
          ))}

          {/* Row highlights */}
          {displayRows.map((row,i)=>
            selectedIds.includes(row.task.id)
              ? <rect key={`sh${i}`} x={0} y={i*ROW_H} width={totalW} height={ROW_H}
                      fill="#dbeafe" opacity={0.35} />
              : null
          )}

          {/* Comparison baseline bars (版本对比 / 差异基线) */}
          {(showComparison || diffFilter) && comparisonMap.size > 0 && displayRows.map((row, i) => {
            const t = row.task
            const ct = comparisonMap.get(t.id)
            if (!ct?.start_date || !ct?.end_date) return null
            if (!t.start_date || !t.end_date) return null

            const cx = dateToX(new Date(ct.start_date))
            const cw = Math.max(colW * 0.4, dateToX(new Date(ct.end_date)) - cx)
            // 基线条位于当前任务条正下方
            const ch = diffFilter ? 10 : 7
            const cy = i * ROW_H + BAR_TOP + BAR_H + 1

            // 偏差：当前结束 vs 对比版本结束
            const endDelta = diffDays(new Date(ct.end_date), new Date(t.end_date))
            const startDelta = diffDays(new Date(ct.start_date), new Date(t.start_date))
            // 颜色：延后=红，提前=绿，准时=灰
            const barColor = endDelta > 0 ? '#ef4444' : endDelta < 0 ? '#22c55e' : '#9ca3af'
            const barOpacity = endDelta === 0 ? 0.4 : 0.6

            if (t.is_milestone) {
              const r = 5, mx = cx, my = cy + ch / 2
              return (
                <g key={`cmp-${t.id}`}>
                  <polygon
                    points={`${mx},${my-r} ${mx+r},${my} ${mx},${my+r} ${mx-r},${my}`}
                    fill={barColor} opacity={barOpacity} stroke={barColor} strokeWidth={1}
                  />
                  {endDelta !== 0 && (
                    <text x={mx + r + 6} y={my + 3} fontSize={9} fill={barColor} fontWeight="600" style={{ pointerEvents: 'none' }}>
                      {endDelta > 0 ? '+' : ''}{endDelta}d
                    </text>
                  )}
                </g>
              )
            }

            // 差异模式下用虚线边框突出基线条
            const rightEdge = Math.max(dateToX(new Date(t.end_date)), cx + cw) + 4
            return (
              <g key={`cmp-${t.id}`}>
                <rect x={cx} y={cy} width={cw} height={ch} fill={barColor} opacity={barOpacity} rx={2}
                  stroke={diffFilter ? barColor : 'none'} strokeWidth={diffFilter ? 0.8 : 0}
                  strokeDasharray={diffFilter ? '3,2' : 'none'} />
                {(startDelta !== 0 || endDelta !== 0) && (
                  <text
                    x={rightEdge}
                    y={cy + ch / 2 + 3}
                    fontSize={9}
                    fill={barColor}
                    fontWeight="600"
                    style={{ pointerEvents: 'none' }}
                  >
                    {startDelta !== 0 && `开始${startDelta > 0 ? '+' : ''}${startDelta}d`}
                    {startDelta !== 0 && endDelta !== 0 && '  '}
                    {endDelta !== 0 && `结束${endDelta > 0 ? '+' : ''}${endDelta}d`}
                  </text>
                )}
              </g>
            )
          })}

          {/* Task bars */}
          {displayRows.map((row,i) => {
            const t = row.task
            if (!t.start_date || !t.end_date) return null
            const x  = dateToX(new Date(t.start_date))
            const w  = Math.max(colW*0.4, dateToX(new Date(t.end_date))-x)
            const y  = i*ROW_H + BAR_TOP
            const isDragging = !!previewMap[t.id]

            if (t.is_milestone) {
              const r=BAR_H/2, cx=x, cy=y+r
              const hovered = hoveredBar === t.id
              return (
                <g key={t.id}
                   style={{ cursor:'pointer', opacity: isDragging?0.7:1 }}
                   onMouseEnter={()=>setHoveredBar(t.id)}
                   onMouseLeave={()=>setHoveredBar(null)}
                   onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                   onMouseDown={e=>{
                     if (e.button!==0) return
                     e.stopPropagation()
                     setDrag({
                       taskId:t.id, mode:'move',
                       startMouseX: getSvgX(e.clientX),
                       origStart: new Date(t.start_date!),
                       origEnd: new Date(t.end_date!),
                       dragging: false,
                     })
                     setPreviewMap({ [t.id]: { ...t } })
                   }}>
                  <text x={cx-r-4} y={cy+4} fontSize={11} textAnchor="end" fill="#6b7280" style={{ pointerEvents:'none' }}>{t.name}</text>
                  <polygon points={`${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}`}
                           fill="#fbbf24" stroke="#f59e0b" strokeWidth={1} />
                  {/* Connect circle for creating dependencies */}
                  {hovered && (
                    <circle cx={cx+r+6} cy={cy} r={6}
                            fill="#3b82f6" stroke="white" strokeWidth={1.5}
                            style={{ cursor:'crosshair' }}
                            onMouseDown={e=>{ e.stopPropagation(); onConnectMouseDown(e,t,i) }} />
                  )}
                </g>
              )
            }

            if (row.hasChildren) {
              const capH=6, capW=10
              const sPct = summaryProgressMap.get(t.id) ?? 0
              const sDoneW = w * Math.max(0, Math.min(1, sPct / 100))
              return (
                <g key={t.id}
                   onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                   onMouseDown={e=>{ if(e.button!==0)return; onBarMouseDown(e,t) }}
                   style={{ cursor:'grab', opacity: isDragging?0.7:1 }}>
                  <text x={x-4} y={y+BAR_H/2+4} fontSize={11} textAnchor="end" fill="#6b7280" fontWeight="600" style={{ pointerEvents:'none' }}>{t.name}</text>
                  <rect x={x} y={y} width={w} height={BAR_H} fill="#93c5fd" rx={3} opacity={0.9}/>
                  {sDoneW > 0.5 && (
                    <rect x={x} y={y} width={sDoneW} height={BAR_H} fill="#3b82f6" rx={3} opacity={0.9}/>
                  )}
                  <polygon points={`${x},${y+BAR_H} ${x+capW},${y+BAR_H} ${x},${y+BAR_H+capH}`} fill="#60a5fa"/>
                  <polygon points={`${x+w},${y+BAR_H} ${x+w-capW},${y+BAR_H} ${x+w},${y+BAR_H+capH}`} fill="#60a5fa"/>
                  <text x={x+w+4} y={y+BAR_H/2+4} fontSize={10} fill="#3b82f6" fontWeight="600" style={{ pointerEvents:'none' }}>{sPct}%</text>
                </g>
              )
            }

            const pct   = Math.max(0, Math.min(1, timeBasedPercent(t, statusDateObj) / 100))
            const doneW = w * pct
            const hovered = hoveredBar === t.id
            const isCritical = criticalSet.has(t.id)
            // 关键路径：红色调；普通：绿色调
            const barBg   = isCritical ? '#fca5a5' : '#86efac'
            const barDone = isCritical ? '#f87171' : '#4ade80'
            const barText = isCritical ? '#7f1d1d' : '#14532d'

            return (
              <g key={t.id} style={{ opacity: isDragging?0.65:1 }}
                 onMouseEnter={()=>setHoveredBar(t.id)}
                 onMouseLeave={()=>setHoveredBar(null)}
                 onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                 onMouseMove={(e) => {
                   // 动态更新光标样式
                   const mouseX = getSvgX(e.clientX)
                   const EDGE_SIZE = 15
                   let cursor = 'grab'
                   if (mouseX < x + EDGE_SIZE) cursor = 'ew-resize'
                   else if (mouseX > x + w - EDGE_SIZE) cursor = 'ew-resize'
                   e.currentTarget.style.cursor = cursor
                 }}>
                {/* 任务名称（条左侧） */}
                <text x={x-4} y={y+BAR_H/2+4} fontSize={11} textAnchor="end" fill="#6b7280" style={{ pointerEvents:'none' }}>{t.name}</text>
                {/* 任务条背景（整个区域，无交互） */}
                <rect x={x} y={y} width={w} height={BAR_H} fill={barBg} rx={3}
                      style={{ pointerEvents:'none' }} />
                {doneW>0.5 && (
                  <rect x={x} y={y} width={doneW} height={BAR_H} fill={barDone} rx={3}
                        style={{ pointerEvents:'none' }} />
                )}
                {w>40 && pct>0 && (
                  <text x={x+w/2} y={y+BAR_H/2+4} fontSize={9} textAnchor="middle"
                        fill={barText} fontWeight="600" style={{ pointerEvents:'none' }}>
                    {Math.round(pct*100)}%
                  </text>
                )}
                {/* 边缘高亮提示：hover时显示左右边缘的resize区域 */}
                {hovered && w > 30 && (
                  <>
                    {/* 左边缘提示 */}
                    <rect x={x} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3}
                          style={{ pointerEvents:'none' }} />
                    {/* 右边缘提示 */}
                    <rect x={x+w-15} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3}
                          style={{ pointerEvents:'none' }} />
                  </>
                )}
                {/* 单一交互层：根据鼠标位置自动判断操作类型 */}
                <rect x={x} y={y} width={w} height={BAR_H} fill="transparent"
                      onMouseDown={e=>onBarMouseDown(e,t)}
                      style={{ cursor:'grab' }} />
                {hovered && (
                  <circle cx={x+w+6} cy={y+BAR_H/2} r={6}
                          fill="#3b82f6" stroke="white" strokeWidth={1.5}
                          style={{ cursor:'crosshair' }}
                          onMouseDown={e=>{ e.stopPropagation(); onConnectMouseDown(e,t,i) }} />
                )}
              </g>
            )
          })}

          {/* Dependency arrows — 根据类型选择锚点: SS(0)=start→start, SF(1)=start→end, FS(2)=end→start, FF(3)=end→end */}
          {deps.map(dep => {
            let fi = rowIdx[dep.from_task_id]
            let ti = rowIdx[dep.to_task_id]
            // 如果任务不在可见行中（被折叠），找其最近可见祖先（防止循环引用）
            if (fi === undefined) {
              const seen = new Set<string>()
              let pid = tasks.find(t => t.id === dep.from_task_id)?.parent_id ?? null
              while (pid && !seen.has(pid)) {
                seen.add(pid)
                if (rowIdx[pid] !== undefined) { fi = rowIdx[pid]; break }
                pid = tasks.find(t => t.id === pid)?.parent_id ?? null
              }
            }
            if (ti === undefined) {
              const seen = new Set<string>()
              let pid = tasks.find(t => t.id === dep.to_task_id)?.parent_id ?? null
              while (pid && !seen.has(pid)) {
                seen.add(pid)
                if (rowIdx[pid] !== undefined) { ti = rowIdx[pid]; break }
                pid = tasks.find(t => t.id === pid)?.parent_id ?? null
              }
            }
            if (fi===undefined||ti===undefined) return null
            const ft = displayRows[fi].task
            const tt = displayRows[ti].task
            if (!ft.start_date||!ft.end_date||!tt.start_date||!tt.end_date) return null

            // 根据依赖类型选择起终点 X 坐标
            // 里程碑或日期异常时，确保 end >= start
            const fromStart = dateToX(new Date(ft.start_date))
            const fromEndRaw = dateToX(new Date(ft.end_date))
            const fromEnd   = Math.max(fromStart, fromEndRaw)
            const toStart   = dateToX(new Date(tt.start_date))
            const toEndRaw  = dateToX(new Date(tt.end_date))
            const toEnd     = Math.max(toStart, toEndRaw)

            let x1: number, x2: number
            const depType = Number(dep.type ?? 2)  // 确保数值类型，默认 FS
            if (depType === 0)      { x1 = fromStart; x2 = toStart }  // SS
            else if (depType === 1) { x1 = fromStart; x2 = toEnd   }  // SF
            else if (depType === 3) { x1 = fromEnd;   x2 = toEnd   }  // FF
            else                    { x1 = fromEnd;   x2 = toStart }  // FS (default)

            const y1   = fi*ROW_H + ROW_H/2
            const y2   = ti*ROW_H + ROW_H/2
            const bend = 10
            const isSel = selectedDep === dep.id

            // 起点从左侧出发时向左弯，从右侧出发时向右弯
            const exitRight = depType === 2 || depType === 3  // FS/FF 从 end 出发 → 向右
            const enterLeft = depType === 0 || depType === 2  // SS/FS 到 start → 从左进入
            const dx1 = exitRight ? bend : -bend
            const dx2 = enterLeft ? -bend : bend

            let d: string
            if ((exitRight && x2 > x1+bend*2) || (!exitRight && x2 > x1)) {
              // 目标在右侧 — 简单路径
              d = `M${x1},${y1} H${x1+dx1} V${y2} H${x2}`
            } else {
              // 目标在左侧 — 绕行路径
              const midY = Math.min(y1,y2)-8
              d = `M${x1},${y1} H${x1+dx1} V${midY} H${x2+dx2} V${y2} H${x2}`
            }

            return (
              <g key={dep.id}>
                <path d={d} stroke="transparent" strokeWidth={10} fill="none"
                      style={{ cursor:'pointer' }}
                      onClick={e=>{ e.stopPropagation(); setSelectedDep(isSel?null:dep.id) }} />
                <path d={d}
                      stroke={isSel ? '#ef4444' : (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? '#ef4444' : '#9ca3af'}
                      strokeWidth={isSel ? 2 : (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? 2 : 1.5}
                      fill="none" markerEnd={`url(#dep-arrow${isSel || (criticalSet.has(dep.from_task_id) && criticalSet.has(dep.to_task_id)) ? '-sel' : ''})`}
                      style={{ pointerEvents:'none' }} />
                {isSel && (() => {
                  const mx = (x1+x2)/2, my = (y1+y2)/2
                  return (
                    <g style={{ cursor:'pointer' }}
                       onClick={async e=>{
                         e.stopPropagation()
                         dispatch(saveSnapshot())
                         dispatch(removeDependency(dep.id))
                         await authFetch(`/api/dependencies/${projectId}`, {
                           method:'DELETE', headers:{'Content-Type':'application/json'},
                           body: JSON.stringify({ id:dep.id }),
                         })
                         setSelectedDep(null)
                       }}>
                      <circle cx={mx} cy={my} r={9} fill="#ef4444" />
                      <text x={mx} y={my+4} textAnchor="middle" fontSize={12}
                            fill="white" fontWeight="bold" style={{ pointerEvents:'none' }}>
                        ×
                      </text>
                    </g>
                  )
                })()}
              </g>
            )
          })}

          {/* Live connect line */}
          {connect && (
            <path d={`M${connect.fromX},${connect.fromY} L${connect.curX},${connect.curY}`}
                  stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3" fill="none"
                  markerEnd="url(#connect-arrow)" style={{ pointerEvents:'none' }} />
          )}

          {/* Status date */}
          {statusDate && (() => {
            const sx = dateToX(new Date(statusDate))
            return (
              <g>
                <line x1={sx} y1={0} x2={sx} y2={totalH}
                      stroke="#ef4444" strokeWidth={2} strokeDasharray="5 3" />
                <text x={sx+3} y={12} fontSize={10} fill="#ef4444">状态日期</text>
              </g>
            )
          })()}

          {/* Project lines */}
          {projectLines.filter(pl => pl.visible).map(pl => {
            const dateStr = (pl.line_date ?? '').split('T')[0]
            if (!dateStr) return null
            const px = dateToX(new Date(dateStr + 'T00:00:00'))
            return (
              <g key={pl.id}>
                <line x1={px} y1={0} x2={px} y2={totalH}
                      stroke={pl.color} strokeWidth={2} strokeDasharray="4 4" />
                <text x={px+3} y={24} fontSize={10} fill={pl.color}>{pl.name}</text>
              </g>
            )
          })}
        </svg>
        </div>
      </div>

      {/* ── Context menu ─────────────────────────────────────────────── */}
      {ctxMenu && (() => {
        const task     = tasks.find(t => t.id === ctxMenu.taskId)
        if (!task) return null
        const taskDeps = deps.filter(d => d.from_task_id === ctxMenu.taskId || d.to_task_id === ctxMenu.taskId)
        const hasDeps  = taskDeps.length > 0
        const prevSibling = tasks
          .filter(t => t.parent_id === task.parent_id && t.order_index < task.order_index)
          .sort((a, b) => b.order_index - a.order_index)[0]
        const canIndent  = !!prevSibling
        const canOutdent = !!task.parent_id
        const isSummary = summarySet.has(ctxMenu.taskId)
        const depCandidates = tasks.filter(t => t.id !== ctxMenu.taskId && !summarySet.has(t.id))

        // Smart positioning: clamp to viewport
        const menuH = 520
        const menuW = 240
        const pad = 8
        const top = ctxMenu.y + menuH > window.innerHeight - pad
          ? Math.max(pad, window.innerHeight - menuH - pad)
          : ctxMenu.y
        const left = ctxMenu.x + menuW > window.innerWidth - pad
          ? Math.max(pad, ctxMenu.x - menuW)
          : ctxMenu.x

        const Sep = () => <div className="my-1 border-t border-gray-100" />

        const Row = ({ icon, label, onClick, disabled = false, danger = false, sub = false }: {
          icon: React.ReactNode; label: string; onClick?: () => void
          disabled?: boolean; danger?: boolean; sub?: boolean
        }) => (
          <button
            disabled={disabled}
            onClick={!disabled ? onClick : undefined}
            onMouseEnter={() => !sub && setCtxMenu(p => p ? { ...p, submenu: null } : null)}
            className={`w-full flex items-center gap-3 px-4 py-[7px] text-[13px] whitespace-nowrap transition-colors
              ${disabled
                ? 'text-gray-300 cursor-default'
                : danger
                  ? 'text-gray-700 hover:bg-red-50 hover:text-red-600 cursor-pointer'
                  : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer'}`}>
            <span className="w-4 flex-none flex items-center justify-center opacity-70">{icon}</span>
            <span className="flex-1 text-left">{label}</span>
          </button>
        )

        const SubRow = ({ icon, label, sub }: { icon: React.ReactNode; label: string; sub: 'add' | 'add-dep' | 'delete-dep' }) => (
          <div className="relative"
               onMouseEnter={(e) => {
                 const rect = e.currentTarget.getBoundingClientRect()
                 const subMenuW = 200
                 const x = rect.right + subMenuW > window.innerWidth ? rect.left - subMenuW : rect.right
                 setCtxMenu(p => p ? { ...p, submenu: sub, subX: x, subY: rect.top } : null)
               }}>
            <button className="w-full flex items-center gap-3 px-4 py-[7px] text-[13px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer whitespace-nowrap transition-colors">
              <span className="w-4 flex-none flex items-center justify-center opacity-70">{icon}</span>
              <span className="flex-1 text-left">{label}</span>
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-gray-400">
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )

        // Icons
        const IcoEdit    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 2l3 3-8 8H3v-3L11 2z"/></svg>
        const IcoCopy    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8" strokeLinecap="round"/></svg>
        const IcoCut     = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="4" cy="12" r="2"/><circle cx="4" cy="4" r="2"/><path d="M6 11L14 3M6 5l8 8" strokeLinecap="round"/></svg>
        const IcoPaste   = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 3h6v2H5V3z"/><rect x="3" y="4" width="10" height="10" rx="1"/></svg>
        const IcoAdd     = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10" strokeLinecap="round"/></svg>
        const IcoDiamond = <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 2l4 6-4 6-4-6z"/></svg>
        const IcoIndent  = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 4h12M2 8h8M2 12h12M10 6l3 2-3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        const IcoOutdent = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 4h12M6 8h8M2 12h12M6 6L3 8l3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        const IcoTrash   = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 5h10M6 5V3h4v2M7 8v4M9 8v4" strokeLinecap="round"/><path d="M4 5l1 9h6l1-9H4z"/></svg>
        const IcoLink    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 10l-1 1a3 3 0 004.24 0l3-3a3 3 0 00-4.24-4.24L7 5" strokeLinecap="round"/><path d="M10 6l1-1a3 3 0 00-4.24 0L4 8a3 3 0 004.24 4.24L9 11" strokeLinecap="round"/></svg>
        const IcoUnlink  = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 10l-1 1a3 3 0 004.24 0l3-3a3 3 0 00-4.24-4.24L7 5M3 3l10 10" strokeLinecap="round"/></svg>
        const IcoAuto    = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 2L3 7h3v6h4V7h3L8 2z"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/></svg>

        return (
          <div
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-2xl py-1.5 text-[13px] select-none overflow-y-auto"
            style={{ left, top, minWidth: 220, maxHeight: `calc(100vh - ${pad * 2}px)` }}
            onClick={e => e.stopPropagation()}
          >
            {/* Group 1: Edit / Copy / Cut / Paste */}
            <Row icon={IcoEdit}  label="编辑"  onClick={() => handleCtxEdit(ctxMenu.taskId)} />
            <Row icon={IcoCopy}  label="复制"  onClick={() => handleCtxCopy(ctxMenu.taskId)} />
            <Row icon={IcoCut}   label="剪切"  onClick={() => handleCtxCut(ctxMenu.taskId)} />
            <Row icon={IcoPaste} label="粘贴"  onClick={handleCtxPaste} disabled={clipboard.length === 0} />

            <Sep />

            {/* Group 2: Add submenu */}
            <SubRow icon={IcoAdd} label="新增..." sub="add" />

            <Sep />

            {/* Group 3: Convert to milestone */}
            <Row icon={IcoDiamond}
                 label={task.is_milestone ? '转换为普通任务' : '转换为里程碑'}
                 onClick={() => handleCtxConvertMilestone(ctxMenu.taskId)} />

            <Sep />

            {/* Group 4: Indent / Outdent */}
            <Row icon={IcoIndent}  label="降级 (Indent)"  onClick={() => handleCtxIndent(ctxMenu.taskId)}  disabled={!canIndent} />
            <Row icon={IcoOutdent} label="升级 (Outdent)" onClick={() => handleCtxOutdent(ctxMenu.taskId)} disabled={!canOutdent} />

            <Sep />

            {/* Group 5: Delete */}
            <Row icon={IcoTrash} label="删除任务" onClick={() => handleCtxDeleteTask(ctxMenu.taskId)} danger />

            <Sep />

            {/* Group 6: Dependencies — 父级任务不允许依赖 */}
            {isSummary
              ? <Row icon={IcoLink} label="添加依赖关系" disabled />
              : <SubRow icon={IcoLink} label="添加依赖关系" sub="add-dep" />}
            {isSummary
              ? <Row icon={IcoUnlink} label="删除依赖关系" disabled />
              : hasDeps
                ? <SubRow icon={IcoUnlink} label="删除依赖关系" sub="delete-dep" />
                : <Row    icon={IcoUnlink} label="删除依赖关系" disabled />}

            <Sep />

            {/* Group 7: Auto Schedule */}
            <Row icon={IcoAuto} label="批量启用自动排程" onClick={handleEnableAutoSchedule} />
            <Row icon={IcoAuto} label="修复任务日期" onClick={handleFixProjectDates} />
          </div>
        )
      })()}

      {/* ── Context submenu (portal) ─────────────────────────────────── */}
      {ctxMenu?.submenu && ctxMenu.subX != null && ctxMenu.subY != null && ReactDOM.createPortal(
        <div className="fixed bg-white border border-gray-200 rounded-lg shadow-2xl py-1 text-[13px] overflow-y-auto z-[60]"
             style={{ minWidth: 180, maxHeight: 320, left: ctxMenu.subX, top: ctxMenu.subY }}
             onClick={e => e.stopPropagation()}>
          {ctxMenu.submenu === 'add' && ([
            ['上方插入任务',  () => handleCtxAddAbove(ctxMenu.taskId)],
            ['下方插入任务',  () => handleCtxAddBelow(ctxMenu.taskId)],
            ['添加里程碑',   () => handleCtxAddMilestone(ctxMenu.taskId)],
            ['添加子任务',   () => handleCtxAddSubtask(ctxMenu.taskId)],
            ['添加后续任务', () => handleCtxAddSuccessor(ctxMenu.taskId)],
            ['添加前置任务', () => handleCtxAddPredecessor(ctxMenu.taskId)],
          ] as [string, () => void][]).map(([lbl, fn]) => (
            <button key={lbl} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap" onClick={fn}>{lbl}</button>
          ))}
          {ctxMenu.submenu === 'add-dep' && tasks.filter(t => t.id !== ctxMenu.taskId && !summarySet.has(t.id)).map(t => (
            <button key={t.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap truncate max-w-[220px]"
                    onClick={() => handleCtxAddDep(ctxMenu.taskId, t.id)}>
              {t.name}
            </button>
          ))}
          {ctxMenu.submenu === 'delete-dep' && deps.filter(d => d.from_task_id === ctxMenu.taskId || d.to_task_id === ctxMenu.taskId).map(dep => {
            const from = tasks.find(t => t.id === dep.from_task_id)
            const to   = tasks.find(t => t.id === dep.to_task_id)
            return (
              <button key={dep.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-red-50 hover:text-red-600 whitespace-nowrap truncate max-w-[220px]"
                      onClick={() => handleCtxDeleteDep(dep.id)}>
                {from?.name ?? '?'} → {to?.name ?? '?'}
              </button>
            )
          })}
        </div>,
        document.body
      )}

      {/* ── Predecessor popup ────────────────────────────────────────── */}
      {predPopup && !summarySet.has(predPopup.taskId) && (() => {
        const currentSeq = seqMap.get(predPopup.taskId) ?? 0
        const candidateTasks = tasks
          .filter(t => t.id !== predPopup.taskId && !t.is_deleted && !summarySet.has(t.id))
          .sort((a, b) => {
            const sa = seqMap.get(a.id) ?? 99999
            const sb = seqMap.get(b.id) ?? 99999
            // 按与当前任务序号距离排序，近的优先
            return Math.abs(sa - currentSeq) - Math.abs(sb - currentSeq)
          })
        const filterLower = predFilter.toLowerCase()
        const filtered = filterLower
          ? candidateTasks.filter(t =>
              t.name.toLowerCase().includes(filterLower)
              || (flatRowIdx[t.id] ?? '').includes(filterLower)
            )
          : candidateTasks
        return (
          <>
            <div
              className="fixed inset-0 z-[49]"
              onClick={() => setPredPopup(null)}
              aria-hidden
            />
            <div
              className="fixed z-[50] bg-white border border-gray-200 rounded-lg shadow-2xl"
              style={{ left: predPopup.x, top: predPopup.y, width: 300, maxHeight: 320 }}
              onClick={e => e.stopPropagation()}
            >
            {/* Filter input */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
              <span className="text-gray-400 text-xs">▼</span>
              <input
                autoFocus
                placeholder="搜索任务..."
                value={predFilter}
                onChange={e => setPredFilter(e.target.value)}
                className="flex-1 text-[12px] outline-none text-gray-700 placeholder-gray-400"
              />
            </div>
            {/* Task list */}
            <div className="overflow-y-auto" style={{ maxHeight: 260 }}>
              {filtered.map(task => {
                const isPred = deps.some(d => d.from_task_id === task.id && d.to_task_id === predPopup.taskId)
                const rowNum = flatRowIdx[task.id]
                return (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 cursor-pointer"
                    onClick={() => togglePredecessor(task.id, predPopup.taskId)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePredecessor(task.id, predPopup.taskId) } }}
                  >
                    <span className="flex-none w-3.5 h-3.5 rounded border flex items-center justify-center"
                          style={{ background: isPred ? '#3b82f6' : 'transparent', borderColor: isPred ? '#3b82f6' : '#9ca3af' }}>
                      {isPred && <span className="text-white text-[10px]">✓</span>}
                    </span>
                    <span className="text-[11px] text-gray-400 flex-none w-6 text-right">{rowNum}</span>
                    <span className="text-[12px] text-gray-700 truncate">{task.name}</span>
                  </div>
                )
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-gray-400 text-center">无匹配任务</div>
              )}
            </div>
          </div>
          </>
        )
      })()}
      {/* ── Post-create edit modal ───────────────────────────────────── */}
      {editModalTaskId && (
        <EditTaskModal
          taskId={editModalTaskId}
          projectId={projectId}
          onClose={() => setEditModalTaskId(null)}
        />
      )}
    </div>
  )
}
