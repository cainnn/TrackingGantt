'use client'

import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setSelectedIds, setTasks, updateTasks, addTasks, deleteTasks,
  addDependency, removeDependency, updateDependency, saveSnapshot,
  copyTasks,
} from '@/store/slices/tasksSlice'
import type { Task, Dependency } from '@/types'
import EditTaskModal from './EditTaskModal'

// ─── Layout constants ──────────────────────────────────────────────────────
const ROW_H    = 40
const DEF_COLW = 28
const HDR_H1   = 30
const HDR_H2   = 22
const HDR_H    = HDR_H1 + HDR_H2
const BAR_H    = 20
const BAR_TOP  = (ROW_H - BAR_H) / 2
const DAY_LETTERS = ['S','M','T','W','T','F','S']

// ─── Left-panel columns ────────────────────────────────────────────────────
const COL_NUM    =  52
const COL_CHECK  =  32
const COL_NAME   = 160
const COL_ASSIGN =  72
const COL_DUR    =  48
const COL_START  =  80
const COL_PRED   =  56
const COL_LAG    =  48
const COL_DTYPE  =  56
const COL_AUTO   =  56
const LEFT_W       = COL_NUM + COL_CHECK + COL_NAME + COL_ASSIGN + COL_DUR + COL_START + COL_PRED + COL_LAG + COL_DTYPE + COL_AUTO
const FIXED_COLS_W = COL_NUM + COL_CHECK + COL_ASSIGN + COL_DUR + COL_START + COL_PRED + COL_LAG + COL_DTYPE + COL_AUTO
const MIN_NAME_W   = 60

// ─── Date helpers ──────────────────────────────────────────────────────────
const sod      = (d: Date) => { const r=new Date(d); r.setHours(0,0,0,0); return r }
const addDays  = (d: Date, n: number) => { const r=new Date(d); r.setDate(r.getDate()+n); return r }
const diffDays = (a: Date, b: Date) => Math.round((sod(b).getTime()-sod(a).getTime())/86_400_000)
const fmtDate  = (d: Date) => d.toISOString().split('T')[0]
const fmtWeek  = (d: Date) => d.toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })

function timeBasedPercent(task: Task, statusDate: Date | null): number {
  if (!statusDate || !task.start_date || !task.end_date) return task.percent_done ?? 0
  const start = sod(new Date(task.start_date))
  const end   = sod(new Date(task.end_date))
  const sd    = sod(statusDate)
  if (sd >= end)   return 100
  if (sd <= start) return 0
  const total = end.getTime()  - start.getTime()
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
}

export default function GanttChart({
  projectId, statusDate,
  colW: colWProp,
  searchQuery = '',
  expandAllSignal = 0,
  collapseAllSignal = 0,
  focusSignal = 0,
}: Props) {
  const dispatch    = useAppDispatch()
  const tasks       = useAppSelector(s => s.tasks.tasks)
  const deps        = useAppSelector(s => s.tasks.dependencies)
  const selectedIds = useAppSelector(s => s.tasks.selectedIds)
  const clipboard   = useAppSelector(s => s.tasks.clipboard)

  const colW = colWProp ?? DEF_COLW

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
  interface CtxMenu { x: number; y: number; taskId: string; submenu: 'add' | 'delete-dep' | 'add-dep' | null }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu|null>(null)

  // ── Cell editing ────────────────────────────────────────────────────────
  interface CellEdit { taskId: string; field: 'assignee' | 'duration' | 'start_date' | 'end_date'; value: string }
  const [cellEdit, setCellEdit] = useState<CellEdit | null>(null)

  // ── Panel resize / collapse ─────────────────────────────────────────────
  const [panelW, setPanelW]           = useState(LEFT_W)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [splitterDrag, setSplitterDrag] = useState<{ startX: number; startW: number } | null>(null)
  const prevPanelW = useRef(LEFT_W)

  // ── Predecessor popup ────────────────────────────────────────────────────
  const [predPopup, setPredPopup] = useState<{ taskId: string; x: number; y: number } | null>(null)
  const [predFilter, setPredFilter] = useState('')

  // ── Post-create edit modal ───────────────────────────────────────────────
  const [editModalTaskId, setEditModalTaskId] = useState<string | null>(null)

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

  const svgRef   = useRef<SVGSVGElement>(null)
  const leftRef  = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // ── Sync vertical scroll ────────────────────────────────────────────────
  const onRightScroll = useCallback(() => {
    if (leftRef.current && rightRef.current)
      leftRef.current.scrollTop = rightRef.current.scrollTop
  }, [])

  // ── Flat row list ───────────────────────────────────────────────────────
  const flatRows = useMemo((): FlatRow[] => {
    const kids: Record<string,Task[]> = {}
    tasks.forEach(t => {
      const k = t.parent_id ?? '__root__'
      if (!kids[k]) kids[k]=[]
      kids[k].push(t)
    })
    const rows: FlatRow[] = []
    function walk(pid: string|null, lvl: number) {
      const key = pid ?? '__root__'
      ;(kids[key]??[]).sort((a,b)=>a.order_index-b.order_index).forEach(t => {
        const has = !!(kids[t.id]?.length)
        rows.push({ task:t, level:lvl, hasChildren:has, expanded:expanded[t.id]??true })
        if (has && (expanded[t.id]??true)) walk(t.id, lvl+1)
      })
    }
    walk(null,0)
    return rows
  }, [tasks, expanded])

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
    const o=sod(mn); o.setDate(o.getDate()-o.getDay()-7)
    return { origin:o, totalDays:diffDays(o, addDays(sod(mx),21)) }
  }, [tasks])

  const dateToX = useCallback((d:Date)=>diffDays(origin,d)*colW, [origin, colW])

  // ── Display rows: apply previewMap + search filter ──────────────────────
  const displayRows = useMemo((): FlatRow[] => {
    const withPreview = Object.keys(previewMap).length
      ? flatRows.map(r => previewMap[r.task.id] ? { ...r, task: previewMap[r.task.id] } : r)
      : flatRows
    if (!searchQuery) return withPreview
    const q = searchQuery.toLowerCase()
    const matched = new Set<string>()
    tasks.forEach(t => {
      if (t.name.toLowerCase().includes(q)) {
        matched.add(t.id)
        let cur: Task | undefined = t
        while (cur?.parent_id) {
          if (matched.has(cur.parent_id)) break
          matched.add(cur.parent_id)
          cur = tasks.find(x => x.id === cur!.parent_id)
        }
      }
    })
    return withPreview.filter(r => matched.has(r.task.id))
  }, [flatRows, previewMap, searchQuery, tasks])

  // ── Row index map (based on displayed rows for arrow positioning) ────────
  const rowIdx = useMemo(() => {
    const m: Record<string,number>={}
    displayRows.forEach((r,i)=>{ m[r.task.id]=i })
    return m
  }, [displayRows])

  // ── 1-based row numbers for predecessor display ──────────────────────────
  const flatRowIdx = useMemo(() => {
    const m: Record<string, number> = {}
    displayRows.forEach((r, i) => { m[r.task.id] = i + 1 })
    return m
  }, [displayRows])

  // ── Default start for new tasks ──────────────────────────────────────────
  // Later of: earliest task start date vs status date
  const defaultStart = useMemo(() => {
    const starts = tasks.filter(t => t.start_date).map(t => sod(new Date(t.start_date!)))
    let d = starts.length > 0
      ? new Date(Math.min(...starts.map(x => x.getTime())))
      : sod(new Date())
    if (statusDate) {
      const sd = sod(new Date(statusDate))
      if (sd > d) d = sd
    }
    return fmtDate(d)
  }, [tasks, statusDate])

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
      rightRef.current.scrollLeft = Math.max(0, x - 200)
    }
  }, [focusSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bar drag: mousedown ─────────────────────────────────────────────────
  const onBarMouseDown = useCallback((e: React.MouseEvent, task: Task) => {
    if (!task.start_date || !task.end_date) return
    e.stopPropagation(); e.preventDefault()
    setSelectedDep(null)

    // 根据鼠标位置判断操作类型（扩大边缘热区到15px）
    const taskX = dateToX(new Date(task.start_date))
    const taskW = dateToX(new Date(task.end_date)) - taskX
    const mouseX = getSvgX(e.clientX)
    const EDGE_SIZE = 15  // 边缘检测范围（像素），扩大以便更容易拖动

    let mode: DragMode = 'move'
    if (mouseX < taskX + EDGE_SIZE) {
      mode = 'resize-left'
    } else if (mouseX > taskX + taskW - EDGE_SIZE) {
      mode = 'resize-right'
    }

    setDrag({
      taskId: task.id, mode,
      startMouseX: getSvgX(e.clientX),
      origStart: new Date(task.start_date),
      origEnd:   new Date(task.end_date),
      dragging: false,
    })
    setPreviewMap({ [task.id]: { ...task } })
  }, [getSvgX, dateToX])

  // ── Connect handle: mousedown ───────────────────────────────────────────
  const onConnectMouseDown = useCallback((e: React.MouseEvent, task: Task, rowI: number) => {
    if (!task.end_date) return
    e.stopPropagation(); e.preventDefault()
    const x = dateToX(new Date(task.end_date))
    const y = HDR_H + rowI * ROW_H + ROW_H / 2
    setConnect({ fromTaskId: task.id, fromX:x, fromY:y, curX:x, curY:y })
  }, [dateToX])

  // ── Row drag handle: mousedown ──────────────────────────────────────────
  const onRowDragStart = useCallback((e: React.MouseEvent, taskId: string) => {
    e.preventDefault(); e.stopPropagation()
    setRowDrag({ taskId, startY: e.clientY, dragging: false })
  }, [])

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
          let newStart = drag.origStart, newEnd = drag.origEnd
          let cascadeDays = days

          if (drag.mode === 'move') {
            newStart = addDays(drag.origStart, days)
            newEnd   = addDays(drag.origEnd,   days)
            cascadeDays = days
          } else if (drag.mode === 'resize-right') {
            newEnd = addDays(drag.origEnd, days)
            if (newEnd <= newStart) newEnd = addDays(newStart, 1)
            cascadeDays = diffDays(drag.origEnd, newEnd)
          } else if (drag.mode === 'resize-left') {
            newStart = addDays(drag.origStart, days)
            if (newStart >= newEnd) newStart = addDays(newEnd, -1)
            cascadeDays = 0
          }

          const orig = tasks.find(t => t.id === drag.taskId)
          if (!orig) return

          const map: Record<string, Task> = {
            [orig.id]: {
              ...orig,
              start_date: fmtDate(newStart),
              end_date:   fmtDate(newEnd),
              duration:   diffDays(newStart, newEnd),
            },
          }

          // 级联更新：当任务的结束日期变化时，检查并调整后继任务（使用缓存优化性能）
          if (drag.mode === 'move' || drag.mode === 'resize-right' || drag.mode === 'resize-left') {
            // 根据拖拽模式确定前置任务的新结束日期
            let newEndDate: Date
            if (drag.mode === 'resize-left') {
              // resize-left 只改变开始日期，结束日期不变
              newEndDate = drag.origEnd
            } else {
              // move 和 resize-right 都会改变结束日期
              newEndDate = newEnd
            }

            // 检查所有后继任务是否需要调整
            const downstreamIds = downstreamCache.get(drag.taskId) || []
            downstreamIds.forEach(id => {
              const t = tasks.find(t => t.id === id)
              if (!t || !t.start_date || !t.end_date) return
              // 检查是否有FS依赖
              const dep = deps.find(d => d.from_task_id === drag.taskId && d.to_task_id === id && d.type === 2)
              if (!dep) return

              // 检查任务的自动排程标志
              if (t.auto_schedule === false) return

              // 计算新的最小允许开始时间 = 前置任务新结束日期 + 1天 + lag
              const newMinStart = addDays(newEndDate, 1 + (dep.lag ?? 0))
              const currentStart = fmtDate(new Date(t.start_date))

              // 如果任务开启了自动排程，无论当前位置在哪里，都应该调整到最小允许时间
              if (currentStart !== fmtDate(newMinStart)) {
                const shift = diffDays(new Date(t.start_date), newMinStart)
                const s = addDays(new Date(t.start_date), shift)
                const en = addDays(new Date(t.end_date), shift)
                map[id] = { ...t, start_date: fmtDate(s), end_date: fmtDate(en), duration: diffDays(s, en) }
              }
            })
          }

          throttledSetPreview(map)
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
        const newW = Math.max(MIN_NAME_W + FIXED_COLS_W, Math.min(900, splitterDrag.startW + e.clientX - splitterDrag.startX))
        setPanelW(newW)
        if (panelCollapsed) setPanelCollapsed(false)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [drag, connect, rowDrag, flatRows.length, tasks, deps, getSvgX, colW, splitterDrag, panelCollapsed, throttledSetPreview, downstreamCache])

  // ── Global mouseup ──────────────────────────────────────────────────────
  useEffect(() => {
    const onUp = async (e: MouseEvent) => {
      if (drag) {
        // 清理节流定时器
        if (throttleTimer.current) {
          clearTimeout(throttleTimer.current)
          throttleTimer.current = null
        }

        const updatedList = drag.dragging ? Object.values(previewMap) : []
        setDrag(null)
        setPreviewMap({})
        if (updatedList.length > 0) {
          dispatch(saveSnapshot())
          // 先乐观更新UI（包含所有级联任务）
          dispatch(updateTasks(updatedList))
          // 发送所有变更到后端（后端会再次计算级联并返回）
          const res = await fetch(`/api/tasks/${projectId}`, {
            method:'PUT', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(updatedList.map(t => ({
              id: t.id, start_date: t.start_date, end_date: t.end_date, duration: t.duration,
            }))),
          })
          const text = await res.text()
          try {
            const d = text ? JSON.parse(text) : {}
            if (d.ok && Array.isArray(d.value) && d.value.length > 0) {
              // 用后端返回的最终结果更新UI（可能包含额外的级联任务）
              dispatch(updateTasks(d.value))
            }
          } catch { /* ignore */ }
        }
      }

      if (connect) {
        const svgX = getSvgX(e.clientX)
        const rect = svgRef.current?.getBoundingClientRect()
        const svgY = rect ? e.clientY - rect.top : 0
        const rowI = Math.floor((svgY - HDR_H) / ROW_H)
        const toRow = flatRows[rowI]

        if (toRow && toRow.task.id !== connect.fromTaskId) {
          const toTask = toRow.task
          if (toTask.start_date) {
            const tx = dateToX(new Date(toTask.start_date))
            const tw = toTask.end_date ? dateToX(new Date(toTask.end_date))-tx : colW
            if (svgX >= tx && svgX <= tx+tw) {
              const dup = deps.some(d => d.from_task_id===connect.fromTaskId && d.to_task_id===toTask.id)
              if (!dup) {
                const tempId = `temp-${Date.now()}-${connect.fromTaskId}-${toTask.id}`
                dispatch(addDependency({ id: tempId, project_id: projectId, from_task_id: connect.fromTaskId, to_task_id: toTask.id, type: 2, lag: 0 }))
                const res = await fetch(`/api/dependencies/${projectId}`, {
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
              await fetch(`/api/tasks/${projectId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
              })
            }
          }
        }
        setRowDrag(null); setDropIdx(null)
      }

      if (splitterDrag) setSplitterDrag(null)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [drag, connect, rowDrag, dropIdx, previewMap, flatRows, tasks, deps, dispatch, projectId, dateToX, getSvgX, colW, splitterDrag])

  // ── Commit name edit ────────────────────────────────────────────────────
  const commitName = useCallback(async () => {
    if (!editId || !editName.trim()) { setEditId(null); return }
    const orig = tasks.find(t=>t.id===editId)
    if (!orig) { setEditId(null); return }
    const updated = { ...orig, name: editName.trim() }
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))
    await fetch(`/api/tasks/${projectId}`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify([{ id:editId, name:editName.trim() }]),
    })
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
      if (!isNaN(dur) && dur > 0 && orig.start_date) {
        const newEnd = fmtDate(addDays(new Date(orig.start_date), Math.round(dur)))
        patch = { duration: Math.round(dur), end_date: newEnd }
      }
    } else if (cellEdit.field === 'start_date') {
      if (cellEdit.value) {
        const newDur = orig.end_date
          ? diffDays(new Date(cellEdit.value), new Date(orig.end_date))
          : orig.duration
        patch = { start_date: cellEdit.value, duration: (newDur != null && newDur > 0) ? newDur : orig.duration }
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
    const putRes = await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: orig.id, ...patch }]),
    })
    const txt = await putRes.text()
    try {
      const d = txt ? JSON.parse(txt) : {}
      if (d.ok && Array.isArray(d.value) && d.value.length > 0)
        dispatch(updateTasks(d.value))
    } catch { /* ignore */ }
    setCellEdit(null)
  }, [cellEdit, tasks, dispatch, projectId])

  // ── 自动排程开关 ────────────────────────────────────────────────────────
  const handleAutoScheduleChange = useCallback(async (taskId: string, autoSchedule: boolean) => {
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    dispatch(updateTasks([{ ...t, auto_schedule: autoSchedule }]))
    const putRes = await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: taskId, auto_schedule: autoSchedule }]),
    })
    const text = await putRes.text()
    try {
      const d = text ? JSON.parse(text) : {}
      if (d.ok && Array.isArray(d.value) && d.value.length > 0)
        dispatch(updateTasks(d.value))
    } catch { /* ignore */ }
  }, [tasks, dispatch, projectId])

  // ── Change dependency type ──────────────────────────────────────────────
  const handleDepTypeChange = useCallback(async (depId: string, newType: number) => {
    dispatch(updateDependency({ id: depId, type: newType }))
    const res = await fetch(`/api/dependencies/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId, type: newType }),
    })
    if (res.ok && newType === 2) {
      const r = await fetch(`/api/tasks/${projectId}?t=${Date.now()}`, { cache: 'no-store' })
      const t = await r.text()
      try { const d = t ? JSON.parse(t) : {}; if (d.ok && d.value) dispatch(setTasks(d.value)) } catch { /* ignore */ }
    }
  }, [dispatch, projectId])

  // ── Toggle predecessor via popup（乐观更新，参考 Bryntum 示例）────────────────
  const togglePredecessor = useCallback(async (fromTaskId: string, toTaskId: string) => {
    const existing = deps.find(d => d.from_task_id === fromTaskId && d.to_task_id === toTaskId)
    if (existing) {
      dispatch(removeDependency(existing.id))
      setPredPopup(null)
      try {
        const res = await fetch(`/api/dependencies/${projectId}`, {
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
    setPredPopup(null)

    try {
      const res = await fetch(`/api/dependencies/${projectId}`, {
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
        dispatch(removeDependency(selectedDep))
        await fetch(`/api/dependencies/${projectId}`, {
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
    extra: { is_milestone?: boolean; start_date?: string | null; end_date?: string | null } = {}
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
      await fetch(`/api/tasks/${projectId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shifted.map(t => ({ id: t.id, parent_id: t.parent_id, order_index: t.order_index }))),
      })
    }
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, parent_id, order_index,
        is_milestone: extra.is_milestone ?? false,
        start_date: startDate,
        end_date: endDate,
        duration,
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
    await fetch(`/api/tasks/${projectId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [taskId] }),
    })
  }, [dispatch, projectId])

  const handleCtxAddAbove = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const nt = await addTask('New Task', t.parent_id, t.order_index)
    if (nt) setEditModalTaskId(nt.id)
  }, [tasks, addTask, dispatch])

  const handleCtxAddBelow = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const nt = await addTask('New Task', t.parent_id, t.order_index + 1)
    if (nt) setEditModalTaskId(nt.id)
  }, [tasks, addTask, dispatch])

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
    const childCount = tasks.filter(t => t.parent_id === taskId).length
    dispatch(saveSnapshot())
    const nt = await addTask('New Sub-task', taskId, childCount)
    setExpanded(prev => ({ ...prev, [taskId]: true }))
    if (nt) setEditModalTaskId(nt.id)
  }, [tasks, addTask, dispatch])

  const handleCtxAddSuccessor = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const t = tasks.find(x => x.id === taskId)
    if (!t) return
    dispatch(saveSnapshot())
    const newTask = await addTask('New Task', t.parent_id, t.order_index + 1)
    if (!newTask) return
    const res = await fetch(`/api/dependencies/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_task_id: taskId, to_task_id: newTask.id }),
    })
    const text = await res.text()
    let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* ignore */ }
    if (data.ok && data.value) {
      const v = data.value
      dispatch(addDependency(v.dependency ?? v))
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
    const res = await fetch(`/api/dependencies/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_task_id: newTask.id, to_task_id: taskId }),
    })
    const text = await res.text()
    let data: { ok?: boolean; value?: { dependency?: Dependency; updatedTask?: Task; updatedTasks?: Task[] } } = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* ignore */ }
    if (data.ok && data.value) {
      const v = data.value
      dispatch(addDependency(v.dependency ?? v))
      const tasksToUpdate = v.updatedTasks ?? (v.updatedTask ? [v.updatedTask] : [])
      if (tasksToUpdate.length > 0) dispatch(updateTasks(tasksToUpdate))
    }
    setEditModalTaskId(newTask.id)
  }, [tasks, addTask, dispatch, projectId])

  const handleCtxDeleteDep = useCallback(async (depId: string) => {
    setCtxMenu(null)
    dispatch(removeDependency(depId))
    await fetch(`/api/dependencies/${projectId}`, {
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
    await fetch(`/api/tasks/${projectId}`, {
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
    const res = await fetch(`/api/tasks/${projectId}`, {
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
    const updated = { ...t, is_milestone: !t.is_milestone, duration: t.is_milestone ? 1 : 0 }
    dispatch(updateTasks([updated]))
    await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: taskId, is_milestone: updated.is_milestone, duration: updated.duration }]),
    })
  }, [dispatch, projectId, tasks])

  const handleCtxIndent = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const anchor = tasks
      .filter(t => t.parent_id === task.parent_id && t.order_index < task.order_index)
      .sort((a, b) => b.order_index - a.order_index)[0]
    if (!anchor) return
    dispatch(saveSnapshot())
    const existingChildren = tasks.filter(t => t.parent_id === anchor.id)
    const newOrder = existingChildren.length > 0 ? Math.max(...existingChildren.map(t => t.order_index)) + 1 : 0
    const updated = { ...task, parent_id: anchor.id, order_index: newOrder }
    dispatch(updateTasks([updated]))
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: taskId, parent_id: anchor.id, order_index: newOrder }]),
    })
    const data = await res.json()
    if (data.success && data.data?.length > 0) {
      dispatch(updateTasks(data.data))
    }
  }, [dispatch, projectId, tasks])

  const handleCtxOutdent = useCallback(async (taskId: string) => {
    setCtxMenu(null)
    const task = tasks.find(t => t.id === taskId)
    if (!task || !task.parent_id) return
    const parent = tasks.find(t => t.id === task.parent_id)!
    dispatch(saveSnapshot())
    const siblingsAfterParent = tasks
      .filter(t => t.parent_id === parent.parent_id && t.order_index > parent.order_index)
    siblingsAfterParent.forEach(s => {
      dispatch(updateTasks([{ ...s, order_index: s.order_index + 1 }]))
    })
    const updated = { ...task, parent_id: parent.parent_id, order_index: parent.order_index + 1 }
    dispatch(updateTasks([updated]))
    const payload = [
      { id: taskId, parent_id: parent.parent_id, order_index: parent.order_index + 1 },
      ...siblingsAfterParent.map(s => ({ id: s.id, parent_id: s.parent_id, order_index: s.order_index + 1 })),
    ]
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.success && data.data?.length > 0) {
      dispatch(updateTasks(data.data))
    }
  }, [dispatch, projectId, tasks])

  const handleCtxAddDep = useCallback(async (fromId: string, toId: string) => {
    setCtxMenu(null)
    const already = deps.find(d => d.from_task_id === fromId && d.to_task_id === toId)
    if (already) return
    const tempId = `temp-${Date.now()}-${fromId}-${toId}`
    dispatch(addDependency({ id: tempId, project_id: projectId, from_task_id: fromId, to_task_id: toId, type: 2, lag: 0 }))
    const res = await fetch(`/api/dependencies/${projectId}`, {
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
      await fetch(`/api/dependencies/${projectId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
    }
  }, [dispatch, projectId, deps])

  const handleEnableAutoSchedule = useCallback(async () => {
    setCtxMenu(null)
    try {
      const response = await fetch(`/api/tasks/enable-auto-schedule/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      if (data.ok) {
        alert(`已成功启用 ${data.data.updated} 个任务的自动排程功能`)
        // 重新加载任务数据
        const taskRes = await fetch(`/api/tasks/${projectId}`)
        const taskData = await taskRes.json()
        if (taskData.ok) {
          dispatch(setTasks(taskData.data.tasks))
        }
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
    try {
      const response = await fetch(`/api/tasks/fix-project/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      if (data.ok) {
        alert(data.data.message)
        // 重新加载任务数据
        const taskRes = await fetch(`/api/tasks/${projectId}`)
        const taskData = await taskRes.json()
        if (taskData.ok) {
          dispatch(setTasks(taskData.data.tasks))
        }
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

  const totalW = totalDays * colW
  const totalH = displayRows.length * ROW_H
  const statusDateObj = statusDate ? sod(new Date(statusDate)) : null

  // ── Project progress calculation ─────────────────────────────────────────────
  const projectProgress = useMemo(() => {
    if (tasks.length === 0) return 0

    // 基于任务的实际完成百分比（percent_done）计算项目整体进度
    // 进度 = SUM(任务工期 * 完成百分比) / SUM(任务工期)
    let totalWorkDays = 0      // 所有任务的总工日数
    let completedWorkDays = 0  // 已完成的工日数（基于percent_done）

    tasks.forEach(t => {
      if (!t.start_date || !t.end_date || !t.duration) return

      const percent = t.percent_done ?? 0

      // 计算该任务的总工日
      totalWorkDays += t.duration

      // 计算该任务的已完成工日（工期 * 完成百分比）
      completedWorkDays += t.duration * (percent / 100)
    })

    return totalWorkDays > 0 ? Math.round((completedWorkDays / totalWorkDays) * 100) : 0
  }, [tasks])

  // ── Dynamic panel sizing ─────────────────────────────────────────────────
  const effectivePanelW = panelCollapsed ? 0 : panelW
  const nameColW = Math.max(MIN_NAME_W, effectivePanelW - FIXED_COLS_W)

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden select-none"
         style={{ fontFamily:'system-ui,sans-serif', fontSize:13,
                  cursor: splitterDrag ? 'col-resize' : undefined }}>

      {/* ── Left panel ───────────────────────────────────────────────── */}
      <div className="flex-none flex flex-col bg-white"
           style={{ width: effectivePanelW, overflow: 'hidden', transition: splitterDrag ? undefined : 'width 0.15s ease' }}>
        {/* Project Progress Bar */}
        <div className="flex-none px-3 py-2 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-gray-600">项目整体进度</span>
            <span className="text-sm font-bold text-blue-600">{projectProgress}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${projectProgress}%` }}
            />
          </div>
        </div>

        {/* Column headers */}
        <div className="flex-none flex items-end border-b border-gray-300 bg-gray-50
                        font-semibold text-gray-500 text-[11px]"
             style={{ height: HDR_H, minWidth: effectivePanelW }}>
          {/* Row number header */}
          <div style={{ width: COL_NUM }}
               className="h-full flex items-end pb-1 justify-center border-r border-gray-200 flex-none text-gray-400">
            #
          </div>
          {/* Checkbox header */}
          <div style={{ width: COL_CHECK }}
               className="h-full flex items-center justify-center border-r border-gray-200 flex-none">
            <input type="checkbox"
                   className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                   checked={displayRows.length > 0 && displayRows.every(r => selectedIds.includes(r.task.id))}
                   onChange={e => dispatch(setSelectedIds(e.target.checked ? displayRows.map(r => r.task.id) : []))} />
          </div>
          <div style={{ width: nameColW, paddingLeft: 4, minWidth: MIN_NAME_W }}
               className="h-full flex items-end pb-1 border-r border-gray-200 flex-none">
            任务名称
          </div>
          <div style={{ width: COL_ASSIGN }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            责任人
          </div>
          <div style={{ width: COL_DUR }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            工期
          </div>
          <div style={{ width: COL_START }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            开始
          </div>
          <div style={{ width: COL_PRED }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            前置
          </div>
          <div style={{ width: COL_LAG }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            延迟
          </div>
          <div style={{ width: COL_DTYPE }}
               className="h-full flex items-end pb-1 px-2 border-r border-gray-200 flex-none">
            类型
          </div>
          <div style={{ width: COL_AUTO }}
               className="h-full flex items-end pb-1 px-2 flex-none"
               title="自动排程：开启时根据前置依赖自动调整开始时间">
            自动
          </div>
        </div>

        {/* Rows */}
        <div ref={leftRef} className="overflow-hidden flex-1"
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
                      rightRef.current.scrollLeft = Math.max(0, barCenter - rightRef.current.clientWidth / 2)
                    }
                  }}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation()
                    setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null })
                  }}
                >
                  {/* ── Task code cell (with drag handle on hover) ── */}
                  <div style={{ width: COL_NUM }}
                       className="group flex items-center justify-center border-r border-gray-100 h-full flex-none flex-shrink-0 relative px-1">
                    <span className="absolute left-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600"
                          style={{ fontSize: 13, cursor: 'grab', lineHeight: 1 }}
                          onMouseDown={e => onRowDragStart(e, t.id)}
                          onClick={e => e.stopPropagation()}>
                      ⠿
                    </span>
                    <span className="text-[10px] font-mono text-gray-400 group-hover:opacity-0 truncate">
                      {t.task_code ?? String(i + 1)}
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
                       onDoubleClick={() => { setEditId(t.id); setEditName(t.name) }}>
                    {row.hasChildren
                      ? <button onClick={e => { e.stopPropagation(); toggle(t.id) }}
                                className="w-5 h-5 flex-none flex items-center justify-center
                                           text-gray-500 hover:text-gray-800 text-xs">
                          {row.expanded ? '▾' : '▸'}
                        </button>
                      : <span className="w-5 h-5 flex-none flex items-center justify-center text-gray-400">•</span>
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
                  <div style={{ width: COL_ASSIGN }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
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

                  {/* ── Duration cell ─────────────────────────────── */}
                  <div style={{ width: COL_DUR }}
                       className="flex items-center justify-end border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
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

                  {/* ── Start date cell ───────────────────────────── */}
                  <div style={{ width: COL_START }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       onDoubleClick={e => {
                         e.stopPropagation()
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

                  {/* ── Predecessors cell (clickable popup) ───────── */}
                  <div style={{ width: COL_PRED }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden cursor-pointer relative group"
                       onClick={e => {
                         e.stopPropagation()
                         const rect = e.currentTarget.getBoundingClientRect()
                         setPredFilter('')
                         setPredPopup(p =>
                           p?.taskId === t.id ? null
                           : { taskId: t.id, x: rect.left, y: rect.bottom }
                         )
                       }}>
                    <span className="text-[11px] text-gray-600 truncate flex-1">{predNums}</span>
                    <span className="text-[9px] text-gray-400 flex-none group-hover:text-gray-600">▾</span>
                  </div>

                  {/* ── Lag cell ───────────────────────────────────── */}
                  <div style={{ width: COL_LAG }}
                       className="flex items-center border-r border-gray-100 h-full flex-none px-1 overflow-hidden"
                       title="前置依赖的延迟时间（天）">
                    <span className="text-[11px] text-gray-600 truncate w-full text-center">
                      {incomingDeps.length > 0
                        ? incomingDeps.map(d => d.lag || 0).join(', ')
                        : '-'}
                    </span>
                  </div>

                  {/* ── Dep type cell ─────────────────────────────── */}
                  <div style={{ width: COL_DTYPE }}
                       className="flex items-center h-full flex-none px-1 overflow-hidden border-r border-gray-100">
                    {incomingDeps.length > 0 && (
                      <select
                        className="text-[11px] border border-gray-200 rounded px-0.5 bg-white
                                   text-gray-700 focus:outline-none focus:border-blue-400 cursor-pointer w-full"
                        value={incomingDeps[0].type}
                        onClick={e => e.stopPropagation()}
                        onChange={e => handleDepTypeChange(incomingDeps[0].id, Number(e.target.value))}>
                        <option value={2}>FS</option>
                        <option value={0}>SS</option>
                        <option value={3}>FF</option>
                        <option value={1}>SF</option>
                      </select>
                    )}
                  </div>

                  {/* ── 自动排程 cell ─────────────────────────────── */}
                  <div style={{ width: COL_AUTO }}
                       className="flex items-center justify-center h-full flex-none px-1 overflow-hidden"
                       onClick={e => { e.stopPropagation(); e.preventDefault(); handleAutoScheduleChange(t.id, !(t.auto_schedule !== false)) }}
                       onMouseDown={e => e.stopPropagation()}>
                    <span className="flex items-center gap-1 cursor-pointer px-1.5 py-0.5 rounded hover:bg-gray-100 text-[10px]">
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${t.auto_schedule !== false ? 'bg-green-500 border-green-500' : 'border-gray-300 bg-white'}`}>
                        {t.auto_schedule !== false && <span className="text-white text-[10px]">✓</span>}
                      </span>
                      <span className="text-gray-600">{t.auto_schedule !== false ? '自动' : '手动'}</span>
                    </span>
                  </div>
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

      {/* ── Right timeline ────────────────────────────────────────────── */}
      <div ref={rightRef} onScroll={onRightScroll}
           className="flex-1 overflow-auto bg-white"
           style={{ cursor: drag ? 'ew-resize' : connect ? 'crosshair' : 'default' }}>
        <svg ref={svgRef}
             width={Math.max(totalW,800)} height={HDR_H+totalH+8}
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

          {/* Header */}
          <rect x={0} y={0} width={totalW} height={HDR_H} fill="#f9fafb" />
          <line x1={0} y1={HDR_H} x2={totalW} y2={HDR_H} stroke="#d1d5db" />

          {/* Month labels (top row) */}
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
                <g key={`m${i}`}>
                  <line x1={x} y1={0} x2={x} y2={HDR_H1} stroke="#d1d5db" />
                  <text x={x + w/2} y={HDR_H1-8} fontSize={11} textAnchor="middle"
                        fill="#374151" fontWeight="600">
                    {m.label}
                  </text>
                </g>
              )
            })
          })()}

          {/* Day columns (bottom row — day numbers) */}
          {Array.from({ length: totalDays }, (_,d) => {
            const date = addDays(origin,d)
            const dow  = date.getDay()
            const wknd = dow===0||dow===6
            const x    = d*colW
            return (
              <g key={`d${d}`}>
                {wknd && <rect x={x} y={HDR_H} width={colW} height={totalH} fill="#f3f4f6" opacity={0.5}/>}
                <line x1={x} y1={HDR_H1} x2={x} y2={HDR_H+totalH} stroke="#e5e7eb" />
                <text x={x+colW/2} y={HDR_H-5} fontSize={10} textAnchor="middle"
                      fill={wknd?'#9ca3af':'#6b7280'}>
                  {date.getDate()}
                </text>
              </g>
            )
          })}

          {/* Row lines */}
          {displayRows.map((_,i)=>(
            <line key={`rl${i}`} x1={0} y1={HDR_H+(i+1)*ROW_H}
                  x2={totalW} y2={HDR_H+(i+1)*ROW_H} stroke="#e5e7eb" />
          ))}

          {/* Row highlights */}
          {displayRows.map((row,i)=>
            selectedIds.includes(row.task.id)
              ? <rect key={`sh${i}`} x={0} y={HDR_H+i*ROW_H} width={totalW} height={ROW_H}
                      fill="#dbeafe" opacity={0.35} />
              : null
          )}

          {/* Task bars */}
          {displayRows.map((row,i) => {
            const t = row.task
            if (!t.start_date || !t.end_date) return null
            const x  = dateToX(new Date(t.start_date))
            const w  = Math.max(colW*0.4, dateToX(new Date(t.end_date))-x)
            const y  = HDR_H + i*ROW_H + BAR_TOP
            const isDragging = !!previewMap[t.id]

            if (t.is_milestone) {
              const r=BAR_H/2, cx=x, cy=y+r
              return <polygon key={t.id} points={`${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}`}
                              fill="#fbbf24" stroke="#f59e0b" strokeWidth={1} />
            }

            if (row.hasChildren) {
              const capH=6, capW=10
              return (
                <g key={t.id}
                   onMouseDown={e=>onBarMouseDown(e,t)}
                   onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: t.id, submenu: null }) }}
                   style={{ cursor:'grab', opacity: isDragging?0.7:1 }}>
                  <rect x={x} y={y} width={w} height={BAR_H} fill="#93c5fd" rx={3} opacity={0.9}/>
                  <polygon points={`${x},${y+BAR_H} ${x+capW},${y+BAR_H} ${x},${y+BAR_H+capH}`} fill="#60a5fa"/>
                  <polygon points={`${x+w},${y+BAR_H} ${x+w-capW},${y+BAR_H} ${x+w},${y+BAR_H+capH}`} fill="#60a5fa"/>
                </g>
              )
            }

            const pct   = Math.max(0, Math.min(1, timeBasedPercent(t, statusDateObj) / 100))
            const doneW = w * pct
            const hovered = hoveredBar === t.id

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
                {/* 任务条背景（整个区域，无交互） */}
                <rect x={x} y={y} width={w} height={BAR_H} fill="#86efac" rx={3}
                      style={{ pointerEvents:'none' }} />
                {doneW>0.5 && (
                  <rect x={x} y={y} width={doneW} height={BAR_H} fill="#4ade80" rx={3}
                        style={{ pointerEvents:'none' }} />
                )}
                {w>40 && pct>0 && (
                  <text x={x+w/2} y={y+BAR_H/2+4} fontSize={9} textAnchor="middle"
                        fill="#14532d" fontWeight="600" style={{ pointerEvents:'none' }}>
                    {Math.round(pct*100)}%
                  </text>
                )}
                {/* 边缘高亮提示：hover时显示左右边缘的resize区域 */}
                {hovered && w > 30 && (
                  <>
                    {/* 左边缘提示 */}
                    <rect x={x} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3"
                          style={{ pointerEvents:'none' }} />
                    {/* 右边缘提示 */}
                    <rect x={x+w-15} y={y} width={15} height={BAR_H} fill="rgba(0,0,0,0.1)" rx={3"
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

          {/* Dependency arrows */}
          {deps.map(dep => {
            const fi = rowIdx[dep.from_task_id]
            const ti = rowIdx[dep.to_task_id]
            if (fi===undefined||ti===undefined) return null
            const ft = displayRows[fi].task
            const tt = displayRows[ti].task
            if (!ft.end_date||!tt.start_date) return null

            const x1   = dateToX(new Date(ft.end_date))
            const y1   = HDR_H + fi*ROW_H + ROW_H/2
            const x2   = dateToX(new Date(tt.start_date))
            const y2   = HDR_H + ti*ROW_H + ROW_H/2
            const bend = 10
            const isSel = selectedDep === dep.id

            const d = x2 > x1+bend*2
              ? `M${x1},${y1} H${x1+bend} V${y2} H${x2}`
              : `M${x1},${y1} H${x1+bend} V${Math.min(y1,y2)-8} H${x2-bend} V${y2} H${x2}`

            return (
              <g key={dep.id}>
                <path d={d} stroke="transparent" strokeWidth={10} fill="none"
                      style={{ cursor:'pointer' }}
                      onClick={e=>{ e.stopPropagation(); setSelectedDep(isSel?null:dep.id) }} />
                <path d={d} stroke={isSel?'#ef4444':'#9ca3af'} strokeWidth={isSel?2:1.5}
                      fill="none" markerEnd={`url(#dep-arrow${isSel?'-sel':''})`}
                      style={{ pointerEvents:'none' }} />
                {isSel && (() => {
                  const mx = (x1+x2)/2, my = (y1+y2)/2
                  return (
                    <g style={{ cursor:'pointer' }}
                       onClick={async e=>{
                         e.stopPropagation()
                         dispatch(removeDependency(dep.id))
                         await fetch(`/api/dependencies/${projectId}`, {
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
                <line x1={sx} y1={HDR_H} x2={sx} y2={HDR_H+totalH}
                      stroke="#ef4444" strokeWidth={2} strokeDasharray="5 3" />
                <text x={sx+3} y={HDR_H+12} fontSize={10} fill="#ef4444">状态日期</text>
              </g>
            )
          })()}
        </svg>
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
        const depCandidates = tasks.filter(t => t.id !== ctxMenu.taskId)

        // Smart vertical positioning
        const menuH = 380
        const top = ctxMenu.y + menuH > window.innerHeight ? ctxMenu.y - menuH : ctxMenu.y

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

        const SubRow = ({ icon, label, onClick, sub }: { icon: React.ReactNode; label: string; onClick: () => void; sub: 'add' | 'add-dep' | 'delete-dep' }) => (
          <div className="relative"
               onMouseEnter={() => setCtxMenu(p => p ? { ...p, submenu: sub } : null)}>
            <button className="w-full flex items-center gap-3 px-4 py-[7px] text-[13px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer whitespace-nowrap transition-colors">
              <span className="w-4 flex-none flex items-center justify-center opacity-70">{icon}</span>
              <span className="flex-1 text-left">{label}</span>
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-gray-400">
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {ctxMenu.submenu === sub && (
              <div className="absolute left-full top-0 bg-white border border-gray-200 rounded-lg shadow-2xl py-1 text-[13px]"
                   style={{ minWidth: 180 }}
                   onClick={e => e.stopPropagation()}>
                {sub === 'add' && ([
                  ['上方插入任务',  () => handleCtxAddAbove(ctxMenu.taskId)],
                  ['下方插入任务',  () => handleCtxAddBelow(ctxMenu.taskId)],
                  ['添加里程碑',   () => handleCtxAddMilestone(ctxMenu.taskId)],
                  ['添加子任务',   () => handleCtxAddSubtask(ctxMenu.taskId)],
                  ['添加后续任务', () => handleCtxAddSuccessor(ctxMenu.taskId)],
                  ['添加前置任务', () => handleCtxAddPredecessor(ctxMenu.taskId)],
                ] as [string, () => void][]).map(([lbl, fn]) => (
                  <button key={lbl} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap" onClick={fn}>{lbl}</button>
                ))}
                {sub === 'add-dep' && depCandidates.map(t => (
                  <button key={t.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-blue-50 hover:text-blue-700 whitespace-nowrap truncate max-w-[220px]"
                          onClick={() => handleCtxAddDep(ctxMenu.taskId, t.id)}>
                    {t.name}
                  </button>
                ))}
                {sub === 'delete-dep' && taskDeps.map(dep => {
                  const from = tasks.find(t => t.id === dep.from_task_id)
                  const to   = tasks.find(t => t.id === dep.to_task_id)
                  return (
                    <button key={dep.id} className="w-full text-left px-4 py-[7px] text-gray-700 hover:bg-red-50 hover:text-red-600 whitespace-nowrap truncate max-w-[220px]"
                            onClick={() => handleCtxDeleteDep(dep.id)}>
                      {from?.name ?? '?'} → {to?.name ?? '?'}
                    </button>
                  )
                })}
              </div>
            )}
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
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-2xl py-1.5 text-[13px] select-none"
            style={{ left: ctxMenu.x, top, minWidth: 220 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Group 1: Edit / Copy / Cut / Paste */}
            <Row icon={IcoEdit}  label="编辑"  onClick={() => handleCtxEdit(ctxMenu.taskId)} />
            <Row icon={IcoCopy}  label="复制"  onClick={() => handleCtxCopy(ctxMenu.taskId)} />
            <Row icon={IcoCut}   label="剪切"  onClick={() => handleCtxCut(ctxMenu.taskId)} />
            <Row icon={IcoPaste} label="粘贴"  onClick={handleCtxPaste} disabled={clipboard.length === 0} />

            <Sep />

            {/* Group 2: Add submenu */}
            <SubRow icon={IcoAdd} label="新增..." sub="add" onClick={() => {}} />

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

            {/* Group 6: Dependencies */}
            <SubRow icon={IcoLink}   label="添加依赖关系" sub="add-dep"    onClick={() => {}} />
            {hasDeps
              ? <SubRow icon={IcoUnlink} label="删除依赖关系" sub="delete-dep" onClick={() => {}} />
              : <Row    icon={IcoUnlink} label="删除依赖关系" disabled />}

            <Sep />

            {/* Group 7: Auto Schedule */}
            <Row icon={IcoAuto} label="批量启用自动排程" onClick={handleEnableAutoSchedule} />
            <Row icon={IcoAuto} label="修复任务日期" onClick={handleFixProjectDates} />
          </div>
        )
      })()}

      {/* ── Predecessor popup ────────────────────────────────────────── */}
      {predPopup && (() => {
        const candidateTasks = displayRows
          .filter(r => r.task.id !== predPopup.taskId)
          .map(r => r.task)
        const filterLower = predFilter.toLowerCase()
        const filtered = filterLower
          ? candidateTasks.filter(t => t.name.toLowerCase().includes(filterLower))
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
