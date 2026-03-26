'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTasks, saveSnapshot } from '@/store/slices/tasksSlice'
import type { TaskLifecycleEvent } from '@/types'

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

export default function EditTaskModal({ taskId, projectId, onClose }: Props) {
  const dispatch = useAppDispatch()
  const task = useAppSelector(s => s.tasks.tasks.find(t => t.id === taskId))

  const [tab, setTab] = useState<'edit' | 'history'>('edit')

  const [name,        setName]        = useState('')
  const [assignee,    setAssignee]    = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [percentDone, setPercentDone] = useState(0)
  const [isMilestone, setIsMilestone] = useState(false)
  const [note,        setNote]        = useState('')

  const [lifecycle, setLifecycle] = useState<TaskLifecycleEvent[]>([])
  const [lcLoading, setLcLoading] = useState(false)

  useEffect(() => {
    if (!task) return
    setName(task.name)
    setAssignee(task.assignee ?? '')
    setStartDate(task.start_date?.split('T')[0] ?? '')
    setEndDate(task.end_date?.split('T')[0] ?? '')
    setPercentDone(task.percent_done)
    setIsMilestone(task.is_milestone)
    setNote(task.note ?? '')
  }, [task])

  const loadLifecycle = useCallback(() => {
    if (tab !== 'history') return
    setLcLoading(true)
    fetch(`/api/tasks/${projectId}/${taskId}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setLifecycle(d.value.lifecycle) })
      .finally(() => setLcLoading(false))
  }, [tab, projectId, taskId])

  useEffect(() => { loadLifecycle() }, [loadLifecycle])

  if (!task) return null

  const duration = startDate && endDate
    ? Math.max(0, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000))
    : task.duration

  const handleSave = async () => {
    const updated = {
      ...task,
      name: name.trim() || task.name,
      assignee: assignee.trim() || null,
      start_date: startDate || null,
      end_date: endDate || null,
      duration,
      percent_done: percentDone,
      is_milestone: isMilestone,
      note: note || null,
    }
    dispatch(saveSnapshot())
    dispatch(updateTasks([updated]))
    const putRes = await fetch(`/api/tasks/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        id: task.id,
        name: updated.name, assignee: updated.assignee,
        start_date: updated.start_date, end_date: updated.end_date,
        duration: updated.duration, percent_done: updated.percent_done,
        is_milestone: updated.is_milestone, note: updated.note,
      }]),
    })
    const text = await putRes.text()
    try {
      const d = text ? JSON.parse(text) : {}
      if (d.ok && Array.isArray(d.value) && d.value.length > 0)
        dispatch(updateTasks(d.value))
    } catch { /* ignore */ }
    onClose()
  }

  const fmtDate = (s: string) => {
    const d = new Date(s)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
         onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[500px] max-h-[90vh] flex flex-col"
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b flex-none">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-800">编辑任务</h2>
            {task.task_code && (
              <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
                {task.task_code}
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
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">开始日期</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                         className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">结束日期</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                         className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">工期（天）</label>
                  <div className="border border-gray-200 bg-gray-50 rounded px-3 py-1.5 text-sm text-gray-500">
                    {duration ?? '—'}
                  </div>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">完成度 (%)</label>
                  <input type="number" min={0} max={100} value={percentDone}
                         onChange={e => setPercentDone(Math.min(100, Math.max(0, Number(e.target.value))))}
                         className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="edit-milestone" checked={isMilestone}
                       onChange={e => setIsMilestone(e.target.checked)}
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
