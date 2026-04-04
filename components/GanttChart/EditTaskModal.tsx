'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTasks, saveSnapshot, addDependency, updateDependency, removeDependency, setTasks } from '@/store/slices/tasksSlice'
import type { Task, Dependency, TaskLifecycleEvent } from '@/types'
import { authFetch, authFetchHeaders } from '@/lib/client/authFetch'
import { markDirty } from '@/store/slices/tasksSlice'

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

  const [tab, setTab] = useState<'edit' | 'history'>('edit')

  const [name,        setName]        = useState('')
  const [assignee,    setAssignee]    = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [isMilestone, setIsMilestone] = useState(false)
  const [note,        setNote]        = useState('')
  const [durationIn,  setDurationIn]  = useState('')

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
    // Init lag edits from current deps
    const lags: Record<string, number> = {}
    for (const d of deps.filter(dd => dd.to_task_id === taskId)) lags[d.id] = d.lag ?? 0
    setLagEdits(lags)
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
    }
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))

    dispatch(markDirty([task.id]))

    // Save lag changes
    for (const dep of incomingDeps) {
      const newLag = lagEdits[dep.id] ?? dep.lag ?? 0
      if (newLag !== (dep.lag ?? 0)) {
        dispatch(updateDependency({ ...dep, lag: newLag }))
        await authFetch(`/api/dependencies/${projectId}`, {
          method: 'PUT', headers: authFetchHeaders(true),
          body: JSON.stringify({ id: dep.id, lag: newLag }),
        })
      }
    }
    if (incomingDeps.some(dep => (lagEdits[dep.id] ?? dep.lag ?? 0) !== (dep.lag ?? 0))) {
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
        <div className="flex border-b flex-none">
          {(['edit', 'history'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-5 py-2 text-[13px] font-medium border-b-2 transition-colors
                      ${tab === t
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t === 'edit' ? '基本信息' : '生命周期'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* Edit tab */}
          {tab === 'edit' && (
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

              {/* ── 前置任务 ────────────────────────────────────────── */}
              <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">前置任务</label>
                  {incomingDeps.length > 0 ? (
                    <div className="space-y-1.5">
                      {incomingDeps.map(dep => {
                        const fromTask = allTasks.find(t => t.id === dep.from_task_id)
                        return (
                          <div key={dep.id}
                               className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded px-2.5 py-1.5">
                            {/* Task name + code */}
                            <div className="flex-1 min-w-0 flex items-center gap-1.5">
                              <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 py-0.5 flex-none">
                                {fromTask ? (seqMap.get(fromTask.id) ?? '?') : '?'}
                              </span>
                              <span className="text-sm text-gray-700 truncate">
                                {fromTask?.name ?? '未知任务'}
                              </span>
                            </div>
                            {/* Dep type */}
                            <select
                              value={dep.type}
                              onChange={e => handleDepTypeChange(dep.id, Number(e.target.value))}
                              className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white
                                         focus:outline-none focus:border-blue-400 cursor-pointer flex-none w-14">
                              <option value={2}>FS</option>
                              <option value={0}>SS</option>
                              <option value={3}>FF</option>
                              <option value={1}>SF</option>
                            </select>
                            {/* Lag */}
                            <div className="flex items-center gap-0.5 flex-none">
                              <span className="text-[10px] text-gray-400">延迟</span>
                              <input
                                type="number"
                                value={lagEdits[dep.id] ?? dep.lag ?? 0}
                                onChange={e => setLagEdits(prev => ({ ...prev, [dep.id]: Number(e.target.value) || 0 }))}
                                className="w-12 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-center
                                           focus:outline-none focus:border-blue-400"
                              />
                            </div>
                            {/* Remove */}
                            <button
                              onClick={() => handleRemovePredecessor(dep.id)}
                              className="text-gray-400 hover:text-red-500 flex-none text-sm leading-none px-0.5"
                              title="移除前置任务">
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 mb-1">暂无前置任务</div>
                  )}

                  {/* Add predecessor */}
                  {showAddPred ? (
                    <div className="mt-2 border border-blue-200 rounded bg-blue-50/50 p-2">
                      <input
                        autoFocus
                        type="text"
                        value={predSearch}
                        onChange={e => setPredSearch(e.target.value)}
                        placeholder="搜索任务名称或序号…"
                        className="w-full border border-gray-300 rounded px-2.5 py-1 text-sm
                                   focus:outline-none focus:border-blue-400 mb-1.5 bg-white"
                      />
                      <div className="max-h-40 overflow-y-auto space-y-0.5">
                        {candidateTasks.length === 0 ? (
                          <div className="text-xs text-gray-400 text-center py-2">无可用任务</div>
                        ) : (
                          candidateTasks.slice(0, 50).map(ct => (
                            <button
                              key={ct.id}
                              disabled={addingPred}
                              onClick={() => handleAddPredecessor(ct.id)}
                              className="w-full flex items-center gap-2 px-2 py-1 rounded text-left
                                         hover:bg-blue-100 disabled:opacity-50 transition-colors">
                              <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 py-0.5 flex-none">
                                {seqMap.get(ct.id) ?? '—'}
                              </span>
                              <span className="text-sm text-gray-700 truncate">{ct.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                      <button
                        onClick={() => { setShowAddPred(false); setPredSearch('') }}
                        className="mt-1.5 text-xs text-gray-500 hover:text-gray-700">
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowAddPred(true)}
                      className="mt-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
                      ＋ 添加前置任务
                    </button>
                  )}
              </div>

              {/* ── 后续任务 ────────────────────────────────────────── */}
              {!isSummary && (
              <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">后续任务</label>
                  {outgoingDeps.length > 0 ? (
                    <div className="space-y-1.5">
                      {outgoingDeps.map(dep => {
                        const toTask = allTasks.find(t => t.id === dep.to_task_id)
                        return (
                          <div key={dep.id}
                               className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded px-2.5 py-1.5">
                            <div className="flex-1 min-w-0 flex items-center gap-1.5">
                              <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 py-0.5 flex-none">
                                {toTask ? (seqMap.get(toTask.id) ?? '?') : '?'}
                              </span>
                              <span className="text-sm text-gray-700 truncate">
                                {toTask?.name ?? '未知任务'}
                              </span>
                            </div>
                            <span className="text-xs text-gray-400 flex-none">{DEP_TYPE_LABELS[dep.type] ?? 'FS'}</span>
                            <button
                              onClick={() => handleRemoveSuccessor(dep.id)}
                              className="text-gray-400 hover:text-red-500 flex-none text-sm leading-none px-0.5"
                              title="移除后续任务">
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 mb-1">暂无后续任务</div>
                  )}

                  {showAddSucc ? (
                    <div className="mt-2 border border-blue-200 rounded bg-blue-50/50 p-2">
                      <input
                        autoFocus
                        type="text"
                        value={succSearch}
                        onChange={e => setSuccSearch(e.target.value)}
                        placeholder="搜索任务名称或序号…"
                        className="w-full border border-gray-300 rounded px-2.5 py-1 text-sm
                                   focus:outline-none focus:border-blue-400 mb-1.5 bg-white"
                      />
                      <div className="max-h-40 overflow-y-auto space-y-0.5">
                        {succCandidateTasks.length === 0 ? (
                          <div className="text-xs text-gray-400 text-center py-2">无可用任务</div>
                        ) : (
                          succCandidateTasks.slice(0, 50).map(ct => (
                            <button
                              key={ct.id}
                              disabled={addingSucc}
                              onClick={() => handleAddSuccessor(ct.id)}
                              className="w-full flex items-center gap-2 px-2 py-1 rounded text-left
                                         hover:bg-blue-100 disabled:opacity-50 transition-colors">
                              <span className="text-[11px] font-mono text-gray-400 bg-white border border-gray-200 rounded px-1 py-0.5 flex-none">
                                {seqMap.get(ct.id) ?? '—'}
                              </span>
                              <span className="text-sm text-gray-700 truncate">{ct.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                      <button
                        onClick={() => { setShowAddSucc(false); setSuccSearch('') }}
                        className="mt-1.5 text-xs text-gray-500 hover:text-gray-700">
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowAddSucc(true)}
                      className="mt-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
                      ＋ 添加后续任务
                    </button>
                  )}
              </div>
              )}

              {/* ── 调度模式（无前置任务时显示） ─────────────────────── */}
              {!isSummary && incomingDeps.length === 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">调度模式</label>
                  <select
                    value={isManual ? 'manual' : 'empty'}
                    onChange={e => handleToggleManual(e.target.value === 'manual')}
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 cursor-pointer">
                    <option value="empty">自动（空）</option>
                    <option value="manual">手动</option>
                  </select>
                </div>
              )}

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
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">备注</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 resize-none" />
              </div>
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

        {/* Footer (edit tab only) */}
        {tab === 'edit' && (
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
