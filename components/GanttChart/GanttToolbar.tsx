'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  copyTasks, addTasks, deleteTasks, updateTasks,
  setSelectedIds, setTasks, saveSnapshot, undo, redo,
} from '@/store/slices/tasksSlice'
import { setStatusDate } from '@/store/slices/projectSlice'
import type { Task } from '@/types'
import EditTaskModal from './EditTaskModal'

// ── Flat tree order ───────────────────────────────────────────────────────
function getFlatOrder(tasks: Task[]): Task[] {
  const kids: Record<string, Task[]> = {}
  tasks.forEach(t => {
    const k = t.parent_id ?? '__root__'
    if (!kids[k]) kids[k] = []
    kids[k].push(t)
  })
  const result: Task[] = []
  function walk(pid: string | null) {
    ;(kids[pid ?? '__root__'] ?? [])
      .sort((a, b) => a.order_index - b.order_index)
      .forEach(t => { result.push(t); walk(t.id) })
  }
  walk(null)
  return result
}

function calcPercent(task: Task, statusDate: Date): number {
  if (!task.start_date || !task.end_date) return task.percent_done
  const start = new Date(task.start_date)
  const end   = new Date(task.end_date)
  if (statusDate <= start) return 0
  if (statusDate >= end)   return 100
  return Math.round((statusDate.getTime() - start.getTime()) / (end.getTime() - start.getTime()) * 100)
}

// ── Icon components ───────────────────────────────────────────────────────
const Ic = ({ children, title, onClick, disabled, active, variant = 'default' }: {
  children: React.ReactNode
  title?: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  variant?: 'default' | 'green' | 'blue'
}) => {
  const base = 'inline-flex items-center justify-center rounded border text-[13px] font-medium transition-colors select-none'
  const size = 'w-8 h-8'
  const colors = {
    default: disabled ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-white'
           : active   ? 'border-blue-400 bg-blue-50 text-blue-600'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400 cursor-pointer bg-white',
    green:   'border-green-400 text-green-600 hover:bg-green-50 cursor-pointer bg-white',
    blue:    disabled ? 'border-blue-200 text-blue-300 cursor-not-allowed bg-white'
                     : 'border-blue-400 text-blue-600 hover:bg-blue-50 cursor-pointer bg-white',
  }
  return (
    <button className={`${base} ${size} ${colors[variant]}`}
            title={title} onClick={!disabled ? onClick : undefined} disabled={disabled}>
      {children}
    </button>
  )
}

// ── Labeled icon button (for CREATE / EDIT) ───────────────────────────────
const LabelIc = ({ icon, label, onClick, disabled, variant = 'default' }: {
  icon: React.ReactNode; label: string
  onClick?: () => void; disabled?: boolean
  variant?: 'green' | 'blue' | 'default'
}) => {
  const base = 'inline-flex items-center gap-1.5 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors select-none'
  const colors = {
    green:   'border-green-400 text-green-600 hover:bg-green-50 bg-white',
    blue:    disabled ? 'border-blue-200 text-blue-300 cursor-not-allowed bg-white'
                      : 'border-blue-400 text-blue-600 hover:bg-blue-50 bg-white cursor-pointer',
    default: disabled ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-white'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50 bg-white cursor-pointer',
  }
  return (
    <button className={`${base} ${colors[variant]}`}
            onClick={!disabled ? onClick : undefined} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

// ── SVG icons ─────────────────────────────────────────────────────────────
const IcoPlus    = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10"/></svg>
const IcoPencil  = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 2l3 3-8 8H3v-3L11 2z"/></svg>
const IcoUndo    = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7V3l-2 2 2 2z" fill="currentColor"/><path d="M3 5a7 7 0 1 1 0 6" strokeLinecap="round"/></svg>
const IcoRedo    = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M13 7V3l2 2-2 2z" fill="currentColor"/><path d="M13 5a7 7 0 1 0 0 6" strokeLinecap="round"/></svg>
const IcoExpand  = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5l4 4 4-4M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoCollapse= () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11l4-4 4 4M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoZoomIn  = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3M6.5 5v3" strokeLinecap="round"/></svg>
const IcoZoomOut = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5M5 6.5h3" strokeLinecap="round"/></svg>
const IcoFocus   = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M1 5V2h3M12 2h3v3M1 11v3h3M12 14h3v-3M6 8h4M8 6v4" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoPrev    = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoNext    = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoSearch  = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3.5 3.5" strokeLinecap="round"/></svg>
const IcoRefresh = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 8a6 6 0 0 0-10-4.5M2 8a6 6 0 0 1 10 4.5" strokeLinecap="round"/><path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round"/></svg>

// ── Props ─────────────────────────────────────────────────────────────────
interface GanttToolbarProps {
  projectId: string
  colW: number
  onZoomIn: () => void
  onZoomOut: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onFocusTask: () => void
  searchQuery: string
  onSearchChange: (q: string) => void
  onShowVersions: () => void
}

export default function GanttToolbar({
  projectId,
  colW, onZoomIn, onZoomOut,
  onExpandAll, onCollapseAll,
  onFocusTask,
  searchQuery, onSearchChange,
  onShowVersions,
}: GanttToolbarProps) {
  const dispatch = useAppDispatch()
  const { selectedIds, clipboard, tasks, dependencies, undoStack, redoStack } = useAppSelector(s => s.tasks)
  const currentProject = useAppSelector(s => s.project.currentProject)

  const canUndo = undoStack.length > 0
  const canRedo = redoStack.length > 0
  const hasSelection = selectedIds.length > 0

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saved,  setSaved]    = useState(false)

  // ── Save version：将当前 Redux 中的 tasks 和 dependencies 一并发送，确保版本内容正确持久化
  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    const res = await fetch(`/api/versions/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks, dependencies }),
    })
    const data = await res.json()
    setSaving(false)
    if (data.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      alert(data.error ?? '保存失败，请重试')
    }
  }, [projectId, saving, tasks, dependencies])

  // ── Navigate prev/next task ───────────────────────────────────────────
  const flatOrder = getFlatOrder(tasks)
  const selectedIdx = hasSelection
    ? flatOrder.findIndex(t => t.id === selectedIds[0])
    : -1

  const handlePrev = useCallback(() => {
    if (selectedIdx <= 0) return
    dispatch(setSelectedIds([flatOrder[selectedIdx - 1].id]))
  }, [dispatch, flatOrder, selectedIdx])

  const handleNext = useCallback(() => {
    if (selectedIdx < 0 || selectedIdx >= flatOrder.length - 1) return
    dispatch(setSelectedIds([flatOrder[selectedIdx + 1].id]))
  }, [dispatch, flatOrder, selectedIdx])

  // ── Create task ───────────────────────────────────────────────────────
  const handleAddTask = useCallback(async () => {
    // defaultStart: later of earliest task start and status date
    const sod = (d: Date) => { const r = new Date(d); r.setHours(0, 0, 0, 0); return r }
    const starts = tasks.filter(t => t.start_date).map(t => sod(new Date(t.start_date!)))
    let startD = starts.length > 0
      ? new Date(Math.min(...starts.map(d => d.getTime())))
      : sod(new Date())
    if (currentProject?.status_date) {
      const sd = sod(new Date(currentProject.status_date))
      if (sd > startD) startD = sd
    }
    const startStr = startD.toISOString().split('T')[0]
    const endD = new Date(startD); endD.setDate(endD.getDate() + 1)
    const endStr = endD.toISOString().split('T')[0]

    const rootTasks = tasks.filter(t => t.parent_id === null)
    const nextIndex = rootTasks.length > 0
      ? Math.max(...rootTasks.map(t => t.order_index)) + 1 : 0
    dispatch(saveSnapshot())
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_id: null, name: 'New Task',
        start_date: startStr, end_date: endStr,
        duration: 1, duration_unit: 'day',
        percent_done: 0, is_milestone: false, note: null, order_index: nextIndex,
      }),
    })
    const data = await res.json()
    if (data.ok && data.value?.length > 0) {
      dispatch(addTasks(data.value))
      dispatch(setSelectedIds([data.value[0].id]))
      setEditModalOpen(true)
    }
  }, [dispatch, projectId, tasks, currentProject])

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDeleteTasks = useCallback(async () => {
    if (!hasSelection) return
    if (!confirm(`确定删除 ${selectedIds.length} 个任务？`)) return
    dispatch(saveSnapshot())
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds }),
    })
    const data = await res.json()
    if (data.ok) dispatch(deleteTasks(data.value.deleted))
  }, [dispatch, projectId, selectedIds, hasSelection])

  // ── Promote ───────────────────────────────────────────────────────────
  const handlePromote = useCallback(async () => {
    if (!hasSelection) return
    const selectedSet = new Set(selectedIds)
    const toPromote = tasks.filter(t =>
      selectedSet.has(t.id) && t.parent_id !== null && !selectedSet.has(t.parent_id ?? '')
    )
    if (toPromote.length === 0) return
    const groups = new Map<string, Task[]>()
    toPromote.forEach(t => {
      if (!groups.has(t.parent_id!)) groups.set(t.parent_id!, [])
      groups.get(t.parent_id!)!.push(t)
    })
    const allUpdates: Array<{ id: string; parent_id: string | null; order_index: number }> = []
    const alreadyShifted = new Set<string>()
    for (const [parentId, group] of groups) {
      const parent = tasks.find(t => t.id === parentId)!
      const grandparentId = parent.parent_id
      const sortedGroup = [...group].sort((a, b) => a.order_index - b.order_index)
      tasks.filter(t =>
        t.parent_id === grandparentId && t.order_index > parent.order_index &&
        !selectedSet.has(t.id) && !alreadyShifted.has(t.id)
      ).forEach(t => {
        alreadyShifted.add(t.id)
        allUpdates.push({ id: t.id, parent_id: t.parent_id, order_index: t.order_index + sortedGroup.length })
      })
      sortedGroup.forEach((task, i) => {
        allUpdates.push({ id: task.id, parent_id: grandparentId, order_index: parent.order_index + 1 + i })
      })
    }
    dispatch(saveSnapshot())
    dispatch(updateTasks(allUpdates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))))
    await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(allUpdates),
    })
  }, [dispatch, projectId, tasks, selectedIds, hasSelection])

  // ── Demote ────────────────────────────────────────────────────────────
  const handleDemote = useCallback(async () => {
    if (!hasSelection) return
    const selectedSet = new Set(selectedIds)
    const flatOrder = getFlatOrder(tasks)
    const toDemote = flatOrder.filter(t => selectedSet.has(t.id) && !selectedSet.has(t.parent_id ?? ''))
    if (toDemote.length === 0) return
    const firstTask = toDemote[0]
    const anchor = tasks
      .filter(t => t.parent_id === firstTask.parent_id && t.order_index < firstTask.order_index && !selectedSet.has(t.id))
      .sort((a, b) => b.order_index - a.order_index)[0]
    if (!anchor) return
    const existingChildren = tasks.filter(t => t.parent_id === anchor.id)
    const startOrder = existingChildren.length > 0
      ? Math.max(...existingChildren.map(t => t.order_index)) + 1 : 0
    const updates = toDemote.map((task, i) => ({ id: task.id, parent_id: anchor.id, order_index: startOrder + i }))
    dispatch(saveSnapshot())
    dispatch(updateTasks(updates.map(u => ({ ...tasks.find(t => t.id === u.id)!, ...u }))))
    await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  }, [dispatch, projectId, tasks, selectedIds, hasSelection])

  // ── Copy / Paste ──────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (!hasSelection) return
    dispatch(copyTasks(selectedIds))
  }, [dispatch, selectedIds, hasSelection])

  const handlePaste = useCallback(async () => {
    if (clipboard.length === 0) return
    dispatch(saveSnapshot())
    const pastedTasks = clipboard.map(t => ({
      ...t, name: `${t.name} (copy)`, id: undefined, created_at: undefined, updated_at: undefined,
    }))
    const res = await fetch(`/api/tasks/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pastedTasks),
    })
    const data = await res.json()
    if (data.ok) dispatch(addTasks(data.value))
  }, [dispatch, projectId, clipboard])

  // ── Status date ───────────────────────────────────────────────────────
  const handleStatusDateChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const statusDate = e.target.value || null
    dispatch(setStatusDate({ projectId, statusDate }))
    if (statusDate && tasks.length > 0) {
      const sd = new Date(statusDate)
      const updated = tasks.filter(t => t.start_date && t.end_date).map(t => ({ ...t, percent_done: calcPercent(t, sd) }))
      dispatch(updateTasks(updated))
      await fetch(`/api/tasks/${projectId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated.map(t => ({ id: t.id, percent_done: t.percent_done }))),
      })
    }
    await fetch(`/api/projects/${projectId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_date: statusDate }),
    })
  }, [dispatch, projectId, tasks])

  // ── 刷新：重新拉取任务与依赖，应用 FS 级联后的日期
  const handleRefresh = useCallback(async () => {
    const r = await fetch(`/api/tasks/${projectId}?t=${Date.now()}`, { cache: 'no-store' })
    const t = await r.text()
    try {
      const d = t ? JSON.parse(t) : {}
      if (d.ok && d.value) dispatch(setTasks(d.value))
    } catch { /* ignore */ }
  }, [dispatch, projectId])

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); dispatch(undo()) }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); dispatch(redo()) }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') handleCopy()
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') handlePaste()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch, handleCopy, handlePaste])

  const sep = <div className="w-px h-6 bg-gray-200 mx-1" />

  return (
    <>
      <div className="flex items-center gap-1.5 px-3 py-2 bg-white border-b border-gray-200 flex-wrap">

        {/* Group 1: Create + Edit + Refresh */}
        <LabelIc icon={<IcoPlus />}   label="创建任务" variant="green" onClick={handleAddTask} />
        <LabelIc icon={<IcoRefresh />} label="刷新" variant="default" onClick={handleRefresh} />
        <LabelIc icon={<IcoPencil />} label="EDIT"   variant="blue"
                 disabled={selectedIds.length !== 1}
                 onClick={() => selectedIds.length === 1 && setEditModalOpen(true)} />

        {sep}

        {/* Group 2: Undo / Redo */}
        <Ic title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={() => dispatch(undo())}><IcoUndo /></Ic>
        <Ic title="重做 (Ctrl+Y)" disabled={!canRedo} onClick={() => dispatch(redo())}><IcoRedo /></Ic>

        {sep}

        {/* Group 3: Expand / Collapse all */}
        <Ic title="全部展开" onClick={onExpandAll}><IcoExpand /></Ic>
        <Ic title="全部折叠" onClick={onCollapseAll}><IcoCollapse /></Ic>

        {sep}

        {/* Group 4: Zoom + Focus + Indent/Outdent */}
        <Ic title={`放大 (当前: ${colW}px)`} disabled={colW >= 56} onClick={onZoomIn}><IcoZoomIn /></Ic>
        <Ic title={`缩小 (当前: ${colW}px)`} disabled={colW <= 14} onClick={onZoomOut}><IcoZoomOut /></Ic>
        <Ic title="聚焦到选中任务" disabled={!hasSelection} onClick={onFocusTask}><IcoFocus /></Ic>
        <Ic title="升级 (Outdent)" disabled={!hasSelection} onClick={handlePromote}><IcoPrev /></Ic>
        <Ic title="降级 (Indent)"  disabled={!hasSelection} onClick={handleDemote}><IcoNext /></Ic>

        {sep}

        {/* Search */}
        <div className="flex items-center gap-1 border border-gray-300 rounded px-2 h-8 bg-white">
          <IcoSearch />
          <input
            type="text"
            placeholder="搜索任务..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="w-36 text-[13px] outline-none placeholder:text-gray-400"
          />
          {searchQuery && (
            <button onClick={() => onSearchChange('')} className="text-gray-400 hover:text-gray-600 text-sm">×</button>
          )}
        </div>

        {sep}

        {/* Secondary: Copy / Paste / Delete */}
        <Ic title="复制 (Ctrl+C)" disabled={!hasSelection} onClick={handleCopy}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8" strokeLinecap="round"/>
          </svg>
        </Ic>
        <Ic title="粘贴 (Ctrl+V)" disabled={clipboard.length === 0} onClick={handlePaste}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 3h6v2H5V3z"/><rect x="3" y="4" width="10" height="10" rx="1"/>
          </svg>
        </Ic>
        <Ic title="删除选中任务" disabled={!hasSelection} onClick={handleDeleteTasks}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 5h10M6 5V3h4v2M7 8v4M9 8v4" strokeLinecap="round"/>
            <path d="M4 5l1 9h6l1-9H4z"/>
          </svg>
        </Ic>

        {sep}

        {/* Status date */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">状态日期</span>
          <input
            type="date"
            value={currentProject?.status_date?.split('T')[0] ?? ''}
            onChange={handleStatusDateChange}
            className="border border-gray-300 rounded px-2 h-8 text-[13px] focus:outline-none focus:border-blue-400"
          />
        </div>

        {sep}

        {/* Save version */}
        <button
          disabled={saving}
          onClick={handleSave}
          className={`inline-flex items-center gap-1.5 px-2.5 h-8 rounded border text-[13px] font-medium transition-colors
            ${saved
              ? 'border-green-500 text-green-600 bg-green-50'
              : 'border-green-400 text-green-600 hover:bg-green-50 bg-white cursor-pointer'}
            disabled:opacity-50 disabled:cursor-not-allowed`}>
          {saved ? (
            <>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3 8l4 4 6-6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              已保存
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 12V4l3-2h6l3 2v8a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>
                <path d="M5 14V9h6v5M10 2v4H5V2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {saving ? '保存中...' : '保存版本'}
            </>
          )}
        </button>

        {/* Version history */}
        <button
          onClick={onShowVersions}
          title="版本历史"
          className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border text-[13px] font-medium
                     border-gray-300 text-gray-600 hover:bg-gray-50 bg-white cursor-pointer">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="8" cy="8" r="6"/>
            <path d="M8 5v3.5l2 1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          历史
        </button>
      </div>

      {/* Edit Task Modal */}
      {editModalOpen && selectedIds.length === 1 && (
        <EditTaskModal
          taskId={selectedIds[0]}
          projectId={projectId}
          onClose={() => setEditModalOpen(false)}
        />
      )}
    </>
  )
}
