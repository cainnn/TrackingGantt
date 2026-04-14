'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTasks, saveSnapshot, addDependency, updateDependency, removeDependency, setTasks } from '@/store/slices/tasksSlice'
import type { Task, Dependency, TaskLifecycleEvent } from '@/types'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { markDirty } from '@/store/slices/tasksSlice'
import { CONSTRAINT_TYPES, CONSTRAINT_NEEDS_DATE } from './constants'

interface Props {
  taskId: string
  projectId: string
  onClose: () => void
}

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  created: { icon: '＋', color: 'text-green-600 bg-green-50' },
  updated: { icon: '✎',  color: 'text-blue-600 bg-blue-50'  },
  moved:   { icon: '⇅',  color: 'text-amber-600 bg-amber-50'},
  deleted: { icon: '－', color: 'text-red-500 bg-red-50'    },
}

const DEP_TYPE_LABELS: Record<number, string> = { 2: 'FS', 0: 'SS', 3: 'FF', 1: 'SF' }
const DEP_TYPE_CN: { value: number; label: string }[] = [
  { value: 0, label: '开始到开始' },
  { value: 1, label: '开始到结束' },
  { value: 2, label: '结束到开始' },
  { value: 3, label: '结束到结束' },
]

export default function EditTaskModal({ taskId, projectId, onClose }: Props) {
  const dispatch = useAppDispatch()
  const allTasks = useAppSelector(s => s.tasks.tasks)
  const task = allTasks.find(t => t.id === taskId)
  const deps = useAppSelector(s => s.tasks.dependencies)
  const incomingDeps = deps.filter(d => d.to_task_id === taskId)
  const outgoingDeps = deps.filter(d => d.from_task_id === taskId)
  const isSummary = allTasks.some(t => t.parent_id === taskId)
  const summaryIds = new Set(allTasks.filter(t => !t.is_deleted).map(t => t.parent_id).filter(Boolean) as string[])
  const currentProject = useAppSelector(s => s.project.currentProject)

  type TabKey = 'general' | 'pred' | 'succ' | 'constraint' | 'note' | 'history'
  const [tab, setTab] = useState<TabKey>('general')

  const [name,        setName]        = useState('')
  const [assignee,    setAssignee]    = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [isMilestone, setIsMilestone] = useState(false)
  const [note,        setNote]        = useState('')
  const [durationIn,  setDurationIn]  = useState('')
  const [constraintType, setConstraintType] = useState<string>('asap')
  const [constraintDate, setConstraintDate] = useState<string>('')
  const [manualSchedule, setManualSchedule] = useState(false)
  const [rollup, setRollup] = useState(false)
  const [inactive, setInactive] = useState(false)
  const [projectBoundary, setProjectBoundary] = useState<string>('ask')

  // Per-dep lag edits (dep.id → lag value)
  const [lagEdits, setLagEdits] = useState<Record<string, number>>({})

  const [lifecycle, setLifecycle] = useState<TaskLifecycleEvent[]>([])
  const [lcLoading, setLcLoading] = useState(false)

  // Adding predecessor UI
  const [showAddPred, setShowAddPred] = useState(false)
  const [predSearch,  setPredSearch]  = useState('')
  const [addingPred,  setAddingPred]  = useState(false)

  // Adding successor UI
  const [showAddSucc, setShowAddSucc] = useState(false)
  const [succSearch,  setSuccSearch]  = useState('')
  const [addingSucc,  setAddingSucc]  = useState(false)

  // Table selection & pending-row state (advance-style)
  const [selectedPredId, setSelectedPredId] = useState<string | null>(null)
  const [selectedSuccId, setSelectedSuccId] = useState<string | null>(null)
  const [pendingPredRow, setPendingPredRow] = useState(false)
  const [pendingSuccRow, setPendingSuccRow] = useState(false)
  const [activeEdits, setActiveEdits] = useState<Record<string, boolean>>({})

  // Sequential number map (same logic as GanttChart)
  const seqMap = useMemo(() => {
    const map = new Map<string, number>()
    const kids: Record<string, Task[]> = {}
    allTasks.forEach(t => {
      const k = t.parent_id ?? '__root__'
      if (!kids[k]) kids[k] = []
      kids[k].push(t)
    })
    let counter = 0
    function walk(pid: string | null) {
      const key = pid ?? '__root__'
      const sorted = (kids[key] ?? []).slice().sort((a, b) => a.order_index - b.order_index)
      sorted.forEach(t => {
        map.set(t.id, ++counter)
        walk(t.id)
      })
    }
    walk(null)
    return map
  }, [allTasks])

  // Determine current schedule mode from deps
  const hasDepMode = incomingDeps.length > 0
  const isManual = task?.auto_schedule === false && !hasDepMode

  // 仅在 taskId 变化时初始化表单
  const prevTaskId = useRef(taskId)
  useEffect(() => {
    if (!task) return
    if (prevTaskId.current === taskId && name !== '') return
    prevTaskId.current = taskId
    setName(task.name)
    setAssignee(task.assignee ?? '')
    setStartDate(task.start_date?.split('T')[0] ?? '')
    setEndDate(task.end_date?.split('T')[0] ?? '')
    setIsMilestone(task.is_milestone)
    setNote(task.note ?? '')
    setDurationIn(task.duration != null ? String(task.duration) : '')
    setConstraintType(task.constraint_type ?? 'asap')
    setConstraintDate(task.constraint_date?.split('T')[0] ?? '')
    setManualSchedule(task.auto_schedule === false)
    setRollup(task.rollup ?? false)
    setInactive(task.inactive ?? false)
    setProjectBoundary(task.project_boundary ?? 'ask')
    // Init lag edits from current deps
    const lags: Record<string, number> = {}
    const acts: Record<string, boolean> = {}
    for (const d of deps.filter(dd => dd.to_task_id === taskId || dd.from_task_id === taskId)) {
      lags[d.id] = d.lag ?? 0
      acts[d.id] = d.active ?? true
    }
    setLagEdits(lags)
    setActiveEdits(acts)
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  const fmtDateStr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

  // ── Refresh tasks from server ────────────────────────────────────────
  const refreshTasks = useCallback(async () => {
    const r = await authFetch(`/api/tasks/${projectId}?t=${Date.now()}`, { cache: 'no-store' })
    const t = await r.text()
    try {
      const d = t ? JSON.parse(t) : {}
      if (d.ok && d.value) {
        dispatch(setTasks(d.value))
        const updated = (d.value.tasks as Task[])?.find(x => x.id === taskId)
        if (updated) {
          setStartDate(updated.start_date?.split('T')[0] ?? '')
          setEndDate(updated.end_date?.split('T')[0] ?? '')
          setDurationIn(updated.duration != null ? String(updated.duration) : '')
        }
      }
    } catch { /* ignore */ }
  }, [dispatch, projectId, taskId])

  // ── Add predecessor ──────────────────────────────────────────────────
  const handleAddPredecessor = useCallback(async (fromTaskId: string) => {
    if (addingPred) return
    setAddingPred(true)
    try {
      dispatch(saveSnapshot())
      const res = await authFetch(`/api/dependencies/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_task_id: fromTaskId, to_task_id: taskId, type: 2, lag: 0 }),
      })
      const data = await res.json()
      if (data.ok && data.value?.dependency) {
        dispatch(addDependency(data.value.dependency))
        if (data.value.updatedTasks) dispatch(updateTasks(data.value.updatedTasks))
        // Init lag for new dep
        setLagEdits(prev => ({ ...prev, [data.value.dependency.id]: 0 }))
      } else {
        alert(data.message || '添加前置任务失败')
      }
      await refreshTasks()
    } finally {
      setAddingPred(false)
      setShowAddPred(false)
      setPredSearch('')
    }
  }, [addingPred, dispatch, projectId, taskId, refreshTasks])

  // ── Remove predecessor ───────────────────────────────────────────────
  const handleRemovePredecessor = useCallback(async (depId: string) => {
    dispatch(saveSnapshot())
    dispatch(removeDependency(depId))
    await authFetch(`/api/dependencies/${projectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId }),
    })
    setLagEdits(prev => { const n = { ...prev }; delete n[depId]; return n })
    await refreshTasks()
  }, [dispatch, projectId, refreshTasks])

  // ── Add successor ─────────────────────────────────────────────────
  const handleAddSuccessor = useCallback(async (toTaskId: string) => {
    if (addingSucc) return
    setAddingSucc(true)
    try {
      dispatch(saveSnapshot())
      const res = await authFetch(`/api/dependencies/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_task_id: taskId, to_task_id: toTaskId, type: 2, lag: 0 }),
      })
      const data = await res.json()
      if (data.ok && data.value?.dependency) {
        dispatch(addDependency(data.value.dependency))
        if (data.value.updatedTasks) dispatch(updateTasks(data.value.updatedTasks))
      } else {
        alert(data.message || '添加后续任务失败')
      }
      await refreshTasks()
    } finally {
      setAddingSucc(false)
      setShowAddSucc(false)
      setSuccSearch('')
    }
  }, [addingSucc, dispatch, projectId, taskId, refreshTasks])

  // ── Remove successor ────────────────────────────────────────────────
  const handleRemoveSuccessor = useCallback(async (depId: string) => {
    dispatch(saveSnapshot())
    dispatch(removeDependency(depId))
    await authFetch(`/api/dependencies/${projectId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId }),
    })
    await refreshTasks()
  }, [dispatch, projectId, refreshTasks])

  // ── Change dep type ──────────────────────────────────────────────────
  const handleDepTypeChange = useCallback(async (depId: string, newType: number) => {
    dispatch(updateDependency({ id: depId, type: newType }))
    await authFetch(`/api/dependencies/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: depId, type: newType }),
    })
    await refreshTasks()
  }, [dispatch, projectId, refreshTasks])

  // ── Toggle manual mode ───────────────────────────────────────────────
  const handleToggleManual = useCallback(async (manual: boolean) => {
    if (!task) return
    dispatch(saveSnapshot())
    if (manual) {
      dispatch(updateTasks([{ ...task, auto_schedule: false }]))
      dispatch(markDirty([task.id]))
    } else {
      // Switch back to auto (空)
      const projectStart = currentProject?.start_date
        ? currentProject.start_date.split('T')[0]
        : fmtDateStr(new Date())
      const earliest = projectStart
      const dur = task.duration ?? 0
      const addD = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate()+n); return r }
      const newEnd = fmtDateStr(addD(new Date(earliest + 'T00:00:00'), dur))
      dispatch(updateTasks([{ ...task, auto_schedule: true, start_date: earliest, end_date: newEnd, duration: dur }]))
      dispatch(markDirty([task.id]))
      setStartDate(earliest)
      setEndDate(newEnd)
    }
  }, [task, allTasks, currentProject, dispatch, projectId])

  const loadLifecycle = useCallback(() => {
    if (tab !== 'history') return
    setLcLoading(true)
    authFetch(`/api/tasks/${projectId}/${taskId}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setLifecycle(d.value.lifecycle) })
      .finally(() => setLcLoading(false))
  }, [tab, projectId, taskId])

  useEffect(() => { loadLifecycle() }, [loadLifecycle])

  if (!task) return null

  const durNum = durationIn !== '' ? Number(durationIn) : null
  const duration = durNum != null && !isNaN(durNum) ? durNum : task.duration

  // Determine date editability based on dep types
  const hasFS_SS = incomingDeps.some(d => d.type === 2 || d.type === 0)
  const hasFF_SF = incomingDeps.some(d => d.type === 3 || d.type === 1)
  const startReadonly = hasDepMode ? hasFS_SS : !isManual
  const endReadonly   = hasDepMode ? hasFF_SF : false

  const projStart = currentProject?.start_date?.split('T')[0] ?? ''

  const handleDurationChange = (val: string) => {
    setDurationIn(val)
    const n = Number(val)
    if (!isNaN(n) && n >= 0) {
      if (endReadonly && endDate) {
        const d = new Date(endDate + 'T00:00:00')
        d.setDate(d.getDate() - n)
        let s = fmtDateStr(d)
        if (projStart && s < projStart) s = projStart
        setStartDate(s)
      } else if (startDate) {
        const d = new Date(startDate + 'T00:00:00')
        d.setDate(d.getDate() + n)
        setEndDate(fmtDateStr(d))
      }
    }
  }

  const handleSave = async () => {
    const clampedStart = (startDate && projStart && startDate < projStart) ? projStart : startDate
    const updated = {
      ...task,
      name: name.trim() || task.name,
      assignee: assignee.trim() || null,
      start_date: clampedStart || null,
      end_date: isMilestone ? (clampedStart || null) : (endDate || null),
      duration: isMilestone ? 0 : duration,
      percent_done: isMilestone ? 100 : task.percent_done,
      is_milestone: isMilestone,
      note: note || null,
      constraint_type: constraintType || null,
      constraint_date: CONSTRAINT_NEEDS_DATE.has(constraintType) ? (constraintDate || null) : null,
      auto_schedule: !manualSchedule,
      rollup,
      inactive,
      project_boundary: projectBoundary,
    }
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))

    dispatch(markDirty([task.id]))

    // Save lag/active changes (both incoming and outgoing)
    const allEditableDeps = [...incomingDeps, ...outgoingDeps]
    let anyDepChanged = false
    for (const dep of allEditableDeps) {
      const newLag = lagEdits[dep.id] ?? dep.lag ?? 0
      const newActive = activeEdits[dep.id] ?? dep.active ?? true
      const lagChanged = newLag !== (dep.lag ?? 0)
      const actChanged = newActive !== (dep.active ?? true)
      if (lagChanged || actChanged) {
        anyDepChanged = true
        dispatch(updateDependency({ ...dep, lag: newLag, active: newActive }))
        await authFetch(`/api/dependencies/${projectId}`, {
          method: 'PUT', headers: authFetchHeaders(true),
          body: JSON.stringify({
            id: dep.id,
            ...(lagChanged ? { lag: newLag } : {}),
            ...(actChanged ? { active: newActive } : {}),
          }),
        })
      }
    }
    if (anyDepChanged) {
      await refreshTasks()
    }
    onClose()
  }

  // ── Candidate tasks for predecessor selection ────────────────────────
  const existingFromIds = new Set(incomingDeps.map(d => d.from_task_id))
  const currentSeq = seqMap.get(taskId) ?? 0
  const candidateTasks = allTasks.filter(t => {
    if (t.id === taskId) return false          // not self
    if (t.is_deleted) return false
    if (summaryIds.has(t.id)) return false     // 摘要任务不能作为前置
    if (existingFromIds.has(t.id)) return false // not already a predecessor
    if (predSearch) {
      const q = predSearch.toLowerCase()
      return (t.name.toLowerCase().includes(q) || String(seqMap.get(t.id) ?? '').includes(q))
    }
    return true
  }).sort((a, b) => {
    const sa = seqMap.get(a.id) ?? 99999
    const sb = seqMap.get(b.id) ?? 99999
    return Math.abs(sa - currentSeq) - Math.abs(sb - currentSeq)
  })

  // ── Candidate tasks for successor selection ─────────────────────────
  const existingToIds = new Set(outgoingDeps.map(d => d.to_task_id))
  const succCandidateTasks = allTasks.filter(t => {
    if (t.id === taskId) return false
    if (t.is_deleted) return false
    if (summaryIds.has(t.id)) return false     // 摘要任务不能作为后续
    if (existingToIds.has(t.id)) return false
    if (succSearch) {
      const q = succSearch.toLowerCase()
      return (t.name.toLowerCase().includes(q) || String(seqMap.get(t.id) ?? '').includes(q))
    }
    return true
  }).sort((a, b) => {
    const sa = seqMap.get(a.id) ?? 99999
    const sb = seqMap.get(b.id) ?? 99999
    return Math.abs(sa - currentSeq) - Math.abs(sb - currentSeq)
  })

  const fmtDate = (s: string) => {
    const d = new Date(s)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
         onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[540px] max-h-[90vh] flex flex-col"
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b flex-none">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-800">编辑任务</h2>
            {seqMap.get(taskId) && (
              <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
                #{seqMap.get(taskId)}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b flex-none overflow-x-auto">
          {([
            ['general',    '通用'],
            ['pred',       '前导'],
            ['succ',       '后续'],
            ['constraint', '限制'],
            ['note',       '注释'],
            ['history',    '生命周期'],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
                    className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap
                      ${tab === k
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* General tab */}
          {tab === 'general' && (
            <div className="px-5 py-4 space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">任务名称</label>
                <input value={name} onChange={e => setName(e.target.value)} autoFocus
                       className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">责任人</label>
                <input value={assignee} onChange={e => setAssignee(e.target.value)}
                       placeholder="负责人姓名"
                       className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            </div>
          )}

          {/* Predecessors tab (advance-style table) */}
          {tab === 'pred' && (
            <div className="px-5 py-4 flex flex-col h-full">
              <div className="border border-gray-200 rounded overflow-hidden">
                <div className="grid grid-cols-[1fr_160px_80px_60px] bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
                  <div className="px-3 py-2">名称</div>
                  <div className="px-3 py-2">类型</div>
                  <div className="px-3 py-2">延迟</div>
                  <div className="px-3 py-2 text-center">激活</div>
                </div>
                {incomingDeps.length === 0 && !pendingPredRow && (
                  <div className="px-3 py-6 text-xs text-gray-400 text-center">暂无前置任务</div>
                )}
                {incomingDeps.map(dep => {
                  const fromTask = allTasks.find(t => t.id === dep.from_task_id)
                  const isSel = selectedPredId === dep.id
                  return (
                    <div key={dep.id}
                         onClick={() => setSelectedPredId(dep.id)}
                         className={`grid grid-cols-[1fr_160px_80px_60px] items-center border-b border-gray-100 text-sm cursor-pointer
                                     ${isSel ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                      <div className="px-3 py-1.5 flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 flex-none">
                          {fromTask ? (seqMap.get(fromTask.id) ?? '?') : '?'}
                        </span>
                        <span className="truncate text-gray-700">{fromTask?.name ?? '未知任务'}</span>
                      </div>
                      <div className="px-2 py-1">
                        <select
                          value={dep.type}
                          onChange={e => handleDepTypeChange(dep.id, Number(e.target.value))}
                          className="w-full border border-gray-300 rounded px-2 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-400 cursor-pointer">
                          {DEP_TYPE_CN.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="px-2 py-1 flex items-center gap-1">
                        <input type="number"
                          value={lagEdits[dep.id] ?? dep.lag ?? 0}
                          onChange={e => setLagEdits(prev => ({ ...prev, [dep.id]: Number(e.target.value) || 0 }))}
                          className="w-12 border border-gray-300 rounded px-1 py-0.5 text-xs text-center focus:outline-none focus:border-blue-400" />
                        <span className="text-[11px] text-gray-400">天</span>
                      </div>
                      <div className="px-2 py-1 flex justify-center">
                        <input type="checkbox"
                          checked={activeEdits[dep.id] ?? true}
                          onChange={e => setActiveEdits(prev => ({ ...prev, [dep.id]: e.target.checked }))}
                          className="w-4 h-4 accent-blue-500" />
                      </div>
                    </div>
                  )
                })}
                {pendingPredRow && (
                  <div className="grid grid-cols-[1fr_160px_80px_60px] items-center border-b border-gray-100 text-sm bg-blue-50/40">
                    <div className="px-2 py-1">
                      <select
                        autoFocus
                        defaultValue=""
                        onChange={e => {
                          const id = e.target.value
                          if (id) {
                            handleAddPredecessor(id)
                            setPendingPredRow(false)
                          }
                        }}
                        className="w-full border border-gray-300 rounded px-2 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-400">
                        <option value="">— 选择任务 —</option>
                        {candidateTasks.map(ct => (
                          <option key={ct.id} value={ct.id}>
                            #{seqMap.get(ct.id) ?? '—'}  {ct.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="px-3 py-1 text-xs text-gray-400">结束到开始</div>
                    <div className="px-3 py-1 text-xs text-gray-400">0 天</div>
                    <div className="px-2 py-1 flex justify-center">
                      <input type="checkbox" checked disabled className="w-4 h-4 accent-blue-500 opacity-60" />
                    </div>
                  </div>
                )}
              </div>
              {/* Toolbar */}
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={() => { setPendingPredRow(true); setSelectedPredId(null) }}
                  disabled={pendingPredRow || addingPred}
                  className="text-blue-600 hover:text-blue-800 disabled:opacity-40 text-lg leading-none"
                  title="添加前置任务">＋</button>
                <button
                  onClick={() => {
                    if (pendingPredRow) { setPendingPredRow(false); return }
                    if (selectedPredId) { handleRemovePredecessor(selectedPredId); setSelectedPredId(null) }
                  }}
                  disabled={!selectedPredId && !pendingPredRow}
                  className="text-red-500 hover:text-red-600 disabled:opacity-40"
                  title="删除选中">🗑</button>
              </div>
            </div>
          )}

          {/* Successors tab (advance-style table) */}
          {tab === 'succ' && (
            <div className="px-5 py-4 flex flex-col h-full">
              {isSummary ? (
                <div className="text-xs text-gray-400">摘要任务不能作为前置</div>
              ) : (
              <>
              <div className="border border-gray-200 rounded overflow-hidden">
                <div className="grid grid-cols-[1fr_160px_80px_60px] bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
                  <div className="px-3 py-2">名称</div>
                  <div className="px-3 py-2">类型</div>
                  <div className="px-3 py-2">延迟</div>
                  <div className="px-3 py-2 text-center">激活</div>
                </div>
                {outgoingDeps.length === 0 && !pendingSuccRow && (
                  <div className="px-3 py-6 text-xs text-gray-400 text-center">暂无后续任务</div>
                )}
                {outgoingDeps.map(dep => {
                  const toTask = allTasks.find(t => t.id === dep.to_task_id)
                  const isSel = selectedSuccId === dep.id
                  return (
                    <div key={dep.id}
                         onClick={() => setSelectedSuccId(dep.id)}
                         className={`grid grid-cols-[1fr_160px_80px_60px] items-center border-b border-gray-100 text-sm cursor-pointer
                                     ${isSel ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                      <div className="px-3 py-1.5 flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 flex-none">
                          {toTask ? (seqMap.get(toTask.id) ?? '?') : '?'}
                        </span>
                        <span className="truncate text-gray-700">{toTask?.name ?? '未知任务'}</span>
                      </div>
                      <div className="px-2 py-1">
                        <select
                          value={dep.type}
                          onChange={e => handleDepTypeChange(dep.id, Number(e.target.value))}
                          className="w-full border border-gray-300 rounded px-2 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-400 cursor-pointer">
                          {DEP_TYPE_CN.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="px-2 py-1 flex items-center gap-1">
                        <input type="number"
                          value={lagEdits[dep.id] ?? dep.lag ?? 0}
                          onChange={e => setLagEdits(prev => ({ ...prev, [dep.id]: Number(e.target.value) || 0 }))}
                          className="w-12 border border-gray-300 rounded px-1 py-0.5 text-xs text-center focus:outline-none focus:border-blue-400" />
                        <span className="text-[11px] text-gray-400">天</span>
                      </div>
                      <div className="px-2 py-1 flex justify-center">
                        <input type="checkbox"
                          checked={activeEdits[dep.id] ?? true}
                          onChange={e => setActiveEdits(prev => ({ ...prev, [dep.id]: e.target.checked }))}
                          className="w-4 h-4 accent-blue-500" />
                      </div>
                    </div>
                  )
                })}
                {pendingSuccRow && (
                  <div className="grid grid-cols-[1fr_160px_80px_60px] items-center border-b border-gray-100 text-sm bg-blue-50/40">
                    <div className="px-2 py-1">
                      <select
                        autoFocus
                        defaultValue=""
                        onChange={e => {
                          const id = e.target.value
                          if (id) {
                            handleAddSuccessor(id)
                            setPendingSuccRow(false)
                          }
                        }}
                        className="w-full border border-gray-300 rounded px-2 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-400">
                        <option value="">— 选择任务 —</option>
                        {succCandidateTasks.map(ct => (
                          <option key={ct.id} value={ct.id}>
                            #{seqMap.get(ct.id) ?? '—'}  {ct.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="px-3 py-1 text-xs text-gray-400">结束到开始</div>
                    <div className="px-3 py-1 text-xs text-gray-400">0 天</div>
                    <div className="px-2 py-1 flex justify-center">
                      <input type="checkbox" checked disabled className="w-4 h-4 accent-blue-500 opacity-60" />
                    </div>
                  </div>
                )}
              </div>
              {/* Toolbar */}
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={() => { setPendingSuccRow(true); setSelectedSuccId(null) }}
                  disabled={pendingSuccRow || addingSucc}
                  className="text-blue-600 hover:text-blue-800 disabled:opacity-40 text-lg leading-none"
                  title="添加后续任务">＋</button>
                <button
                  onClick={() => {
                    if (pendingSuccRow) { setPendingSuccRow(false); return }
                    if (selectedSuccId) { handleRemoveSuccessor(selectedSuccId); setSelectedSuccId(null) }
                  }}
                  disabled={!selectedSuccId && !pendingSuccRow}
                  className="text-red-500 hover:text-red-600 disabled:opacity-40"
                  title="删除选中">🗑</button>
              </div>
              </>
              )}
            </div>
          )}

          {/* General tab (continued — schedule + dates + duration) */}
          {tab === 'general' && (
            <div className="px-5 py-4 space-y-3.5">
              {isSummary && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">任务类型</label>
                  <div className="border border-gray-200 bg-gray-50 rounded px-3 py-1.5 text-sm text-gray-400">
                    摘要任务（日期由子任务决定）
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">开始日期</label>
                  {startReadonly ? (
                    <div className="border border-gray-200 bg-gray-50 rounded px-3 py-1.5 text-sm text-gray-400">
                      {startDate || '—'}
                    </div>
                  ) : (
                    <input type="date" value={startDate} min={projStart || undefined}
                           onChange={e => {
                             const v = e.target.value
                             setStartDate(projStart && v < projStart ? projStart : v)
                           }}
                           className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                  )}
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">结束日期</label>
                  {endReadonly ? (
                    <div className="border border-gray-200 bg-gray-50 rounded px-3 py-1.5 text-sm text-gray-400">
                      {endDate || '—'}
                    </div>
                  ) : (
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                           className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">工期（天）</label>
                <input type="number" min={0} value={durationIn}
                       onChange={e => handleDurationChange(e.target.value)}
                       placeholder="天数"
                       className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="edit-milestone" checked={isMilestone}
                       onChange={e => {
                         const checked = e.target.checked
                         setIsMilestone(checked)
                         if (checked) {
                           // 转为里程碑：工期=0, end_date=start_date
                           setDurationIn('0')
                           if (startDate) setEndDate(startDate)
                         } else {
                           // 转为普通任务：工期=1
                           setDurationIn('1')
                           if (startDate) {
                             const d = new Date(startDate)
                             d.setDate(d.getDate() + 1)
                             setEndDate(d.toISOString().split('T')[0])
                           }
                         }
                       }}
                       className="w-4 h-4 accent-blue-500" />
                <label htmlFor="edit-milestone" className="text-sm text-gray-700 cursor-pointer">里程碑</label>
              </div>
            </div>
          )}

          {/* Constraint tab (advance-style two-column layout) */}
          {tab === 'constraint' && (() => {
            const Toggle = ({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(!checked)}
                className={`relative inline-flex h-5 w-9 flex-none rounded-full transition-colors focus:outline-none
                  ${checked ? 'bg-blue-500' : 'bg-gray-300'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transform transition-transform
                  ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            )
            const dateActive = CONSTRAINT_NEEDS_DATE.has(constraintType)
            return (
              <div className="px-5 py-5 grid grid-cols-[auto_1fr_auto_auto] gap-x-4 gap-y-4 items-center">
                <label className="text-sm text-gray-600">限制类型</label>
                <div className="relative">
                  <select
                    value={constraintType}
                    onChange={e => setConstraintType(e.target.value)}
                    disabled={manualSchedule}
                    title={manualSchedule ? '手动排程开启时，限制类型不生效' : ''}
                    className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 cursor-pointer appearance-none pr-8
                      ${manualSchedule ? 'bg-gray-50 text-gray-400' : 'bg-white'}`}>
                    {CONSTRAINT_TYPES.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  {!manualSchedule && constraintType !== 'asap' && (
                    <button
                      onClick={() => setConstraintType('asap')}
                      className="absolute right-7 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm"
                      title="清除">×</button>
                  )}
                </div>
                <label className="text-sm text-gray-600 pl-4">手动排程</label>
                <Toggle checked={manualSchedule} onChange={setManualSchedule} />

                <label className="text-sm text-gray-600">限制日期</label>
                <input type="date"
                  value={constraintDate}
                  disabled={!dateActive || manualSchedule}
                  onChange={e => setConstraintDate(e.target.value)}
                  className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400
                    ${(!dateActive || manualSchedule) ? 'bg-gray-50 text-gray-400' : 'bg-white'}`} />
                <label className="text-sm text-gray-600 pl-4">打包</label>
                <Toggle checked={rollup} onChange={setRollup} />

                <label className="text-sm text-gray-600">项目边界</label>
                <select
                  value={projectBoundary}
                  onChange={e => setProjectBoundary(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400 cursor-pointer">
                  <option value="ask">询问用户</option>
                  <option value="honor">遵守边界</option>
                  <option value="ignore">忽略边界</option>
                </select>
                <label className="text-sm text-gray-600 pl-4">无效</label>
                <Toggle checked={inactive} onChange={setInactive} />
              </div>
            )
          })()}

          {/* Note tab */}
          {tab === 'note' && (
            <div className="px-5 py-4">
              <label className="block text-xs font-medium text-gray-500 mb-1">备注</label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={10}
                        className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 resize-none" />
            </div>
          )}

          {/* Lifecycle tab */}
          {tab === 'history' && (
            <div className="px-5 py-4">
              {lcLoading ? (
                <div className="flex items-center justify-center h-32 text-gray-400 text-sm">加载中...</div>
              ) : lifecycle.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-gray-400 text-sm">暂无记录</div>
              ) : (
                <ol className="relative border-l-2 border-gray-100 ml-2 space-y-4">
                  {lifecycle.map(ev => {
                    const { icon, color } = EVENT_ICONS[ev.event_type] ?? { icon: '·', color: 'text-gray-400 bg-gray-100' }
                    return (
                      <li key={ev.id} className="ml-5">
                        <span className={`absolute -left-[11px] flex items-center justify-center
                          w-5 h-5 rounded-full text-[10px] font-bold ${color}`}>
                          {icon}
                        </span>
                        <div className="bg-gray-50 rounded-md px-3 py-2 border border-gray-100">
                          <p className="text-[13px] text-gray-700 leading-snug">{ev.description}</p>
                          <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-400">
                            <span>{fmtDate(ev.created_at)}</span>
                            {ev.created_by_name && <span>by {ev.created_by_name}</span>}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          )}
        </div>

        {/* Footer (hidden on history tab) */}
        {tab !== 'history' && (
          <div className="flex justify-end gap-2 px-5 py-3 border-t bg-gray-50 rounded-b-lg flex-none">
            <button onClick={onClose}
                    className="px-4 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-100">
              取消
            </button>
            <button onClick={handleSave}
                    className="px-4 py-1.5 text-sm text-white bg-blue-600 rounded hover:bg-blue-700">
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
