'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useAppDispatch } from '@/store/hooks'
import { setTasks, saveSnapshot } from '@/store/slices/tasksSlice'
import type { ProjectVersion, ChangeLog } from '@/types'

interface Props {
  projectId: string
  onClose: () => void
}

const CHANGE_ICONS: Record<string, string> = {
  task_add:     '＋',
  task_delete:  '－',
  task_update:  '✎',
  task_reorder: '⇅',
  dep_add:      '→',
  dep_delete:   '✕',
}
const CHANGE_COLORS: Record<string, string> = {
  task_add:     'text-green-600 bg-green-50',
  task_delete:  'text-red-500 bg-red-50',
  task_update:  'text-blue-600 bg-blue-50',
  task_reorder: 'text-amber-600 bg-amber-50',
  dep_add:      'text-purple-600 bg-purple-50',
  dep_delete:   'text-orange-500 bg-orange-50',
}

function ChangeItem({ c }: { c: ChangeLog }) {
  const icon  = CHANGE_ICONS[c.change_type]  ?? '·'
  const color = CHANGE_COLORS[c.change_type] ?? 'text-gray-500 bg-gray-100'
  return (
    <div className="flex items-start gap-2 py-1">
      <span className={`flex-none text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded ${color}`}>
        {icon}
      </span>
      <span className="text-[12px] text-gray-600 leading-5">{c.description}</span>
    </div>
  )
}

export default function VersionPanel({ projectId, onClose }: Props) {
  const dispatch = useAppDispatch()
  const [versions,   setVersions]   = useState<ProjectVersion[]>([])
  const [loading,    setLoading]    = useState(true)
  const [restoring,  setRestoring]  = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/versions/${projectId}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setVersions(d.value) })
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => { load() }, [load])

  const handleRestore = useCallback(async (v: ProjectVersion) => {
    if (!confirm(`确定恢复到版本 v${v.version_number}？当前未保存的改动将丢失。`)) return
    setRestoring(v.id)
    dispatch(saveSnapshot())
    const res  = await fetch(`/api/versions/${projectId}/${v.id}`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      dispatch(setTasks(data.value))
      onClose()
    } else {
      alert('恢复失败，请重试')
    }
    setRestoring(null)
  }, [dispatch, projectId, onClose])

  const fmtDate = (s: string) => {
    const d = new Date(s)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />

      <div className="relative w-96 h-full bg-white shadow-xl flex flex-col"
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-none">
          <h2 className="font-semibold text-gray-800 text-[15px]">版本历史</h2>
          <button onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 text-xl leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100">
            ×
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">加载中...</div>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 text-sm gap-2">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round"/>
              </svg>
              暂无保存版本
            </div>
          ) : (
            <ul>
              {versions.map((v, idx) => {
                const isOpen = expandedId === v.id
                return (
                  <li key={v.id} className="border-b border-gray-100">
                    {/* Version header row */}
                    <div
                      className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors
                        ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => setExpandedId(isOpen ? null : v.id)}>

                      {/* Timeline dot */}
                      <div className="flex flex-col items-center flex-none mt-1">
                        <div className={`w-2.5 h-2.5 rounded-full border-2
                          ${idx === 0 ? 'border-blue-500 bg-blue-500' : 'border-gray-300 bg-white'}`} />
                        {idx < versions.length - 1 && (
                          <div className="w-px flex-1 min-h-[20px] bg-gray-200 mt-1" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded
                              ${idx === 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                              v{v.version_number}
                            </span>
                            {idx === 0 && (
                              <span className="text-[10px] text-blue-600 bg-blue-50 border border-blue-200 rounded px-1">当前</span>
                            )}
                          </div>
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"
                               className={`flex-none text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>

                        <div className="mt-0.5 text-[12px] text-gray-500">{fmtDate(v.created_at)}</div>

                        <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-400">
                          <span>{v.task_count} 个任务</span>
                          {v.created_by_name && <span>by {v.created_by_name}</span>}
                          {v.changes.length > 0 && (
                            <span className="text-blue-500">{v.changes.length} 项变更</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Expanded: change log + restore button */}
                    {isOpen && (
                      <div className="px-4 pb-3">
                        {v.changes.length === 0 ? (
                          <p className="text-[12px] text-gray-400 pl-5 py-1">暂无变更记录（初始版本）</p>
                        ) : (
                          <div className="pl-5 border-l-2 border-blue-100 ml-1 mb-2">
                            {v.changes.map(c => <ChangeItem key={c.id} c={c} />)}
                          </div>
                        )}
                        <button
                          disabled={!!restoring || idx === 0}
                          onClick={() => handleRestore(v)}
                          className="mt-1 w-full py-1.5 rounded text-[12px] font-medium border transition-colors
                            disabled:opacity-40 disabled:cursor-not-allowed
                            enabled:bg-blue-600 enabled:text-white enabled:border-blue-600 enabled:hover:bg-blue-700
                            bg-blue-600 text-white border-blue-600 hover:bg-blue-700">
                          {restoring === v.id ? '恢复中...' : idx === 0 ? '当前版本' : '恢复到此版本'}
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 text-center flex-none">
          共 {versions.length} 个版本
        </div>
      </div>
    </div>
  )
}
